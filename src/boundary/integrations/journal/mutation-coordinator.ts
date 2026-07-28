import { resolve } from 'node:path';

const mutationTails = new Map<string, Promise<void>>();

/**
 * Serializes journal mutations by their resolved note path across every
 * JournalOps instance in this process. Unrelated note paths retain full
 * concurrency.
 */
export async function withJournalMutationLock<T>(
  absolutePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = resolve(absolutePath);
  const previous = mutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  const tail = previous.then(() => current);
  mutationTails.set(key, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutationTails.get(key) === tail) {
      mutationTails.delete(key);
    }
  }
}
