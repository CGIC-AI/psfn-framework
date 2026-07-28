import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

const mutationTails = new Map<string, Promise<void>>();

interface JournalMutationIdentity {
  canonicalRoot: string;
  canonicalParent: string;
  canonicalPath: string;
}

/**
 * Serializes journal mutations by their canonical note path across every
 * JournalOps instance in this process. Unrelated note paths retain full
 * concurrency.
 */
export async function withJournalMutationLock<T>(
  root: string,
  absolutePath: string,
  operation: (canonicalPath: string) => Promise<T>,
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
    return await operation(identity.canonicalPath);
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
  try {
    const targetStats = await lstat(canonicalPath);
    if (targetStats.isSymbolicLink()) {
      throw new Error('Journal mutation target must not be a symbolic link');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { canonicalRoot, canonicalParent, canonicalPath };
}

function isContainedPath(candidate: string, root: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot.length > 0
    && !pathFromRoot.startsWith('..')
    && !isAbsolute(pathFromRoot);
}
