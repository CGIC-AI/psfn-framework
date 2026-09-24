// Whole-corpus scans that hold one store page at a time (psfn-framework-dnaqt).
// A caller that genuinely must visit every active memory (a forensic lineage
// sweep, a census, a co-mention search) walks the store's own newest-first
// keyset pages instead of asking for the corpus in one list. The page size is
// the store's `listActiveMemories` default, so no new bound is introduced here,
// and the same walk works through the subject-authorized proxy, whose list
// selector clamps an unbounded request to one page.
import type { MemoryStorePort } from './memory-store-port.js';
import type { MemoryListPosition } from './list-position.js';
import type { PurrMemory } from './types.js';

type ActiveMemoryPageSource = Pick<MemoryStorePort, 'listActiveMemories'>;

/**
 * Yield every active memory page, newest first (extractedAt DESC, id DESC).
 * The cursor is taken from the raw page, so a caller filtering pages can never
 * end the walk early on a page it filtered to nothing.
 */
export async function* activeMemoryPages(store: ActiveMemoryPageSource): AsyncGenerator<readonly PurrMemory[]> {
  let before: MemoryListPosition | undefined;
  for (;;) {
    const page = await store.listActiveMemories(before ? { before } : {});
    const last = page.at(-1);
    if (!last) return;
    if (before && last.id === before.memoryId && last.extractedAt === before.extractedAt) {
      // A store that ignores the cursor would otherwise loop forever.
      throw new Error('listActiveMemories did not advance past the keyset cursor');
    }
    yield page;
    before = { extractedAt: last.extractedAt, memoryId: last.id };
  }
}

/** Collect the active memories matching `keep`, holding one unfiltered page at a time. */
export async function collectActiveMemories(
  store: ActiveMemoryPageSource,
  keep: (memory: PurrMemory) => boolean,
): Promise<PurrMemory[]> {
  const kept: PurrMemory[] = [];
  for await (const page of activeMemoryPages(store)) {
    for (const memory of page) {
      if (keep(memory)) kept.push(memory);
    }
  }
  return kept;
}
