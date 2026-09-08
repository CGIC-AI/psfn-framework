import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  link,
  lstat,
  open,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

/**
 * Journal mutation namespace safety (psfn-framework-b695g).
 *
 * The parent directory is pinned by descriptor and dev/ino, and every path the
 * mutation touches is resolved through `/proc/self/fd/<parent>`, so a commit can
 * never escape the bound directory inode or follow a symlink out of the journal
 * root. Publication is a single coordinator operation — callers cannot sequence
 * their own check-then-rename — and the create path publishes with `link(2)`,
 * which fails atomically rather than replacing anything that appears in the
 * check-to-commit window.
 *
 * Residual, precisely: replacing an existing note must use `rename(2)`, the only
 * atomic crash-safe replace Node exposes, and `rename(2)` is unconditional.
 * Node 22 has no `renameat2(RENAME_NOREPLACE|RENAME_EXCHANGE)` and no
 * `openat2(RESOLVE_BENEATH)`, so a same-UID process that plants a different
 * inode at the bound name between the final identity check and that one syscall
 * has its directory entry replaced; the link-count check afterwards detects this
 * and fails the operation explicitly, but cannot prevent or undo it. The same
 * applies to a parent directory moved out of the journal root inside that
 * window: the descriptor-relative commit lands in the (still pinned) directory
 * inode and only then reports failure. Both need a kernel compare-and-swap
 * primitive; closing them requires a reviewed native binding or an OS/service
 * boundary that forbids same-UID namespace mutation during journal commits.
 */
const mutationTails = new Map<string, Promise<void>>();

interface FilesystemIdentity {
  dev: bigint;
  ino: bigint;
}

interface JournalMutationIdentity {
  canonicalRoot: string;
  canonicalParent: string;
  canonicalPath: string;
  parentIdentity: FilesystemIdentity;
  targetIdentity: FilesystemIdentity | null;
}

export interface JournalMutationTarget {
  readonly stablePath: string;
  readonly existingHandle: FileHandle | null;
  readonly existed: boolean;
  /**
   * Publish a staged temporary file as the bound target as one coordinator
   * operation (psfn-framework-b695g). Callers never sequence their own
   * check-then-rename, so no caller-visible window exists between the final
   * identity check and the namespace operation that commits it.
   */
  commit(temporaryPath: string, temporaryIdentity: FilesystemIdentity): Promise<void>;
  assertParentAttached(): Promise<void>;
}

export interface JournalMutationTestHooks {
  afterValidation?: () => Promise<void> | void;
  /** Fires before the coordinator's final identity re-check. */
  beforeCommit?: () => Promise<void> | void;
  /**
   * Fires inside commit() after the final identity re-check has passed and
   * immediately before the link/rename that publishes the file: the exact
   * window psfn-framework-b695g is about.
   */
  beforeFinalCommit?: () => Promise<void> | void;
}


/**
 * Serializes journal mutations by their canonical note path across every
 * JournalOps instance in this process. Unrelated note paths retain full
 * concurrency.
 */
export async function withJournalMutationLock<T>(
  root: string,
  absolutePath: string,
  operation: (target: JournalMutationTarget) => Promise<T>,
  testHooks: JournalMutationTestHooks = {},
): Promise<T> {
  const identity = await resolveMutationIdentity(root, absolutePath);
  const key = identity.canonicalPath;
  const previous = mutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  const tail = previous.then(() => current);
  mutationTails.set(key, tail);

  await previous;
  try {
    const revalidated = await resolveMutationIdentity(root, absolutePath);
    if (
      revalidated.canonicalRoot !== identity.canonicalRoot
      || revalidated.canonicalParent !== identity.canonicalParent
      || revalidated.canonicalPath !== identity.canonicalPath
    ) {
      throw new Error('Journal mutation path changed while waiting for its lock');
    }
    await testHooks.afterValidation?.();
    const boundTarget = await bindMutationTarget(revalidated, testHooks);
    try {
      const result = await operation(boundTarget);
      await boundTarget.assertParentAttached();
      return result;
    } finally {
      await boundTarget.existingHandle?.close();
      await boundTarget.parentHandle.close();
    }
  } finally {
    release();
    if (mutationTails.get(key) === tail) {
      mutationTails.delete(key);
    }
  }
}

async function resolveMutationIdentity(
  root: string,
  absolutePath: string,
): Promise<JournalMutationIdentity> {
  const canonicalRoot = await realpath(resolve(root));
  const canonicalParent = await realpath(dirname(resolve(absolutePath)));
  const canonicalPath = resolve(canonicalParent, basename(absolutePath));
  if (!isContainedPath(canonicalPath, canonicalRoot)) {
    throw new Error('Journal mutation path must stay inside the journal root');
  }
  const parentStats = await lstat(canonicalParent, { bigint: true });
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error('Journal mutation parent must be a real directory');
  }
  const targetIdentity = await readTargetIdentity(canonicalPath);
  return {
    canonicalRoot,
    canonicalParent,
    canonicalPath,
    parentIdentity: filesystemIdentity(parentStats),
    targetIdentity,
  };
}

async function bindMutationTarget(
  identity: JournalMutationIdentity,
  testHooks: JournalMutationTestHooks,
): Promise<JournalMutationTarget & { parentHandle: FileHandle }> {
  let parentHandle: FileHandle;
  try {
    parentHandle = await open(
      identity.canonicalParent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new Error('Journal mutation parent changed after validation', { cause: error });
  }
  let existingHandle: FileHandle | null = null;
  try {
    const parentStats = await parentHandle.stat({ bigint: true });
    const stableParentPath = `/proc/self/fd/${String(parentHandle.fd)}`;
    let openedParentPath: string;
    try {
      openedParentPath = await realpath(stableParentPath);
    } catch (error) {
      throw new Error(
        'Journal mutation requires stable descriptor-relative filesystem paths',
        { cause: error },
      );
    }
    if (
      !sameFilesystemIdentity(filesystemIdentity(parentStats), identity.parentIdentity)
      || openedParentPath !== identity.canonicalParent
    ) {
      throw new Error('Journal mutation parent changed after validation');
    }

    const stablePath = join(stableParentPath, basename(identity.canonicalPath));
    if (identity.targetIdentity) {
      try {
        existingHandle = await open(
          stablePath,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        throw new Error('Journal mutation target changed after validation', { cause: error });
      }
      const targetStats = await existingHandle.stat({ bigint: true });
      if (
        !targetStats.isFile()
        || !sameFilesystemIdentity(filesystemIdentity(targetStats), identity.targetIdentity)
      ) {
        throw new Error('Journal mutation target changed after validation');
      }
    } else if (await readTargetIdentity(stablePath)) {
      throw new Error('Journal mutation target appeared after validation');
    }

    let beforeCommit = testHooks.beforeCommit;
    let beforeFinalCommit = testHooks.beforeFinalCommit;
    const boundExistingHandle = existingHandle;
    const assertNamespaceUnchanged = async (): Promise<void> => {
      const hook = beforeCommit;
      beforeCommit = undefined;
      await hook?.();
      await assertParentAttached(identity, parentHandle);
      let currentTarget: FilesystemIdentity | null;
      try {
        currentTarget = await readTargetIdentity(stablePath);
      } catch (error) {
        throw new Error('Journal mutation target changed before commit', { cause: error });
      }
      if (!sameOptionalFilesystemIdentity(currentTarget, identity.targetIdentity)) {
        throw new Error('Journal mutation target changed before commit');
      }
    };
    const target: JournalMutationTarget & { parentHandle: FileHandle } = {
      stablePath,
      existingHandle,
      existed: identity.targetIdentity !== null,
      parentHandle,
      async commit(temporaryPath, temporaryIdentity): Promise<void> {
        await assertNamespaceUnchanged();
        const linksBefore = boundExistingHandle
          ? (await boundExistingHandle.stat({ bigint: true })).nlink
          : null;
        const finalHook = beforeFinalCommit;
        beforeFinalCommit = undefined;
        await finalHook?.();

        if (identity.targetIdentity === null) {
          // Creating: link(2) never replaces an existing name, so anything that
          // appears at the target inside the check-to-commit window makes the
          // commit fail atomically instead of overwriting it. This closes the
          // window completely for the create path.
          try {
            await link(temporaryPath, stablePath);
          } catch (error) {
            throw new Error('Journal mutation target appeared before commit', { cause: error });
          }
          try {
            await assertCommittedIdentity(stablePath, temporaryIdentity);
            await assertParentAttached(identity, parentHandle);
            // link(2) is atomic but not durable: the new directory entry can
            // still be unflushed when the machine dies, so a crash here would
            // revert a commit this call already reported as successful. Sync
            // the pinned parent descriptor before returning, and fail the
            // commit — rolling the entry back — if durability cannot be
            // proven. Mirrors writeFileDurableAtomicSync in shared/utils/fs.
            await parentHandle.sync();
          } catch (error) {
            await rollBackCreatedTarget(stablePath, temporaryIdentity, parentHandle);
            throw error;
          }
          return;
        }

        // Replacing: rename(2) is the only atomic, crash-safe replace Node
        // offers, and it is unconditional. The checks below detect — but cannot
        // prevent — a target replaced inside the remaining window; see the
        // module comment for the precise residual.
        await rename(temporaryPath, stablePath);
        await assertCommittedIdentity(stablePath, temporaryIdentity);
        await assertParentAttached(identity, parentHandle);
        // Same durability requirement as the create path: rename(2) publishes
        // atomically, but only fsync of the parent directory makes the
        // replacement survive a crash.
        await parentHandle.sync();
        if (linksBefore !== null) {
          const linksAfter = (await boundExistingHandle!.stat({ bigint: true })).nlink;
          if (linksAfter !== linksBefore - 1n) {
            throw new Error(
              'Journal mutation replaced a target other than the bound note; '
              + 'the note namespace was mutated concurrently during the commit',
            );
          }
        }
      },
      async assertParentAttached(): Promise<void> {
        await assertParentAttached(identity, parentHandle);
      },
    };
    return target;
  } catch (error) {
    await existingHandle?.close();
    await parentHandle.close();
    throw error;
  }
}

/** The published entry must be exactly the staged temporary file's inode. */
async function assertCommittedIdentity(
  stablePath: string,
  temporaryIdentity: FilesystemIdentity,
): Promise<void> {
  const committed = await readTargetIdentity(stablePath);
  if (!committed || !sameFilesystemIdentity(committed, temporaryIdentity)) {
    throw new Error('Journal mutation did not publish the staged note');
  }
}

/**
 * Undo a created entry only while it is still provably ours: if something else
 * already occupies the name, removing it would be the very destruction this
 * path exists to prevent.
 */
async function rollBackCreatedTarget(
  stablePath: string,
  temporaryIdentity: FilesystemIdentity,
  parentHandle: FileHandle,
): Promise<void> {
  let current: FilesystemIdentity | null;
  try {
    current = await readTargetIdentity(stablePath);
  } catch {
    return;
  }
  if (!current || !sameFilesystemIdentity(current, temporaryIdentity)) return;
  try {
    await unlink(stablePath);
    // Make the removal as durable as the publication would have been, so a
    // crash cannot resurrect an entry this path just withdrew.
    await parentHandle.sync();
  } catch {
    // Best effort: the caller is already failing closed with the original cause.
  }
}

async function assertParentAttached(
  identity: JournalMutationIdentity,
  parentHandle: FileHandle,
): Promise<void> {
  const parentStats = await lstat(identity.canonicalParent, { bigint: true });
  const handleStats = await parentHandle.stat({ bigint: true });
  if (
    parentStats.isSymbolicLink()
    || !parentStats.isDirectory()
    || !sameFilesystemIdentity(filesystemIdentity(parentStats), identity.parentIdentity)
    || !sameFilesystemIdentity(filesystemIdentity(handleStats), identity.parentIdentity)
    || await realpath(`/proc/self/fd/${String(parentHandle.fd)}`) !== identity.canonicalParent
  ) {
    throw new Error('Journal mutation parent changed before commit');
  }
}

async function readTargetIdentity(path: string): Promise<FilesystemIdentity | null> {
  try {
    const targetStats = await lstat(path, { bigint: true });
    if (targetStats.isSymbolicLink()) {
      throw new Error('Journal mutation target must not be a symbolic link');
    }
    if (!targetStats.isFile()) {
      throw new Error('Journal mutation target must be a regular file');
    }
    return filesystemIdentity(targetStats);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function filesystemIdentity(
  stats: { dev: bigint; ino: bigint },
): FilesystemIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameFilesystemIdentity(
  left: FilesystemIdentity,
  right: FilesystemIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameOptionalFilesystemIdentity(
  left: FilesystemIdentity | null,
  right: FilesystemIdentity | null,
): boolean {
  return left === null || right === null
    ? left === right
    : sameFilesystemIdentity(left, right);
}

function isContainedPath(candidate: string, root: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot.length > 0
    && !pathFromRoot.startsWith('..')
    && !isAbsolute(pathFromRoot);
}
