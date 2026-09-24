import type { ActiveMemoryListOptions } from '../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../faculties/memory/types.js';

/**
 * A `listActiveMemories` double that honors the store's keyset contract
 * (extractedAt DESC, id DESC; `before` exclusive; default page of 50), so a
 * keyset scan over a hand-built corpus terminates and sees every memory.
 * `source` is re-read on every call, so tests may mutate the corpus.
 */
export function keysetActiveMemoryPages(
  source: () => readonly PurrMemory[],
): (options?: ActiveMemoryListOptions) => Promise<PurrMemory[]> {
  return async (options = {}) => {
    const before = options.before;
    const limit = options.limit ?? 50;
    return source()
      .filter(memory => !memory.deletedAt && !memory.supersededBy)
      .filter(memory => before === undefined
        || memory.extractedAt < before.extractedAt
        || (memory.extractedAt === before.extractedAt && memory.id < before.memoryId))
      .sort((left, right) => right.extractedAt - left.extractedAt || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0))
      .slice(options.offset ?? 0, (options.offset ?? 0) + limit);
  };
}

/** A `getRecentlyAccessedMemories` double: lastAccessed DESC over active memories. */
export function recentlyAccessedMemories(
  source: () => readonly PurrMemory[],
): (limit: number) => Promise<PurrMemory[]> {
  return async limit => source()
    .filter(memory => !memory.deletedAt && !memory.supersededBy)
    .sort((left, right) => right.lastAccessed - left.lastAccessed)
    .slice(0, limit);
}
