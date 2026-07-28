import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  lstat,
  open,
  realpath,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

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
  assertNamespaceUnchanged(): Promise<void>;
  assertParentAttached(): Promise<void>;
}

export interface JournalMutationTestHooks {
  afterValidation?: () => Promise<void> | void;
  beforeCommit?: () => Promise<void> | void;
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
    const target: JournalMutationTarget & { parentHandle: FileHandle } = {
      stablePath,
      existingHandle,
      existed: identity.targetIdentity !== null,
      parentHandle,
      async assertNamespaceUnchanged(): Promise<void> {
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
