import { describe, expect, it, vi } from 'vitest';
import { keysetActiveMemoryPages } from '../../test-support/active-memory-pages.js';
import { activeMemoryPages, collectActiveMemories } from './active-memory-scan.js';
import type { PurrMemory } from './types.js';

function memory(index: number): PurrMemory {
  return {
    id: `m-${String(index).padStart(3, '0')}`,
    text: `memory ${index}`,
    type: 'semantic',
    importance: 0.5,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.5,
    sourceRef: `channel:${index}`,
    // Pairs share a timestamp so the id tie-break decides page boundaries.
    extractedAt: 1_000 + Math.floor(index / 2),
    lastAccessed: 1_000,
    accessCount: 0,
    tags: [],
    sensitivity: 'low',
    consentFlags: {},
  };
}

const corpus = Array.from({ length: 123 }, (_, index) => memory(index));
const newestFirstIds = [...corpus]
  .sort((left, right) => right.extractedAt - left.extractedAt || (left.id < right.id ? 1 : -1))
  .map(entry => entry.id);

describe('active memory keyset scan', () => {
  it('visits every active memory exactly once, one store page at a time', async () => {
    const listActiveMemories = vi.fn(keysetActiveMemoryPages(() => corpus));
    const seen: string[] = [];
    for await (const page of activeMemoryPages({ listActiveMemories })) {
      expect(page.length).toBeLessThanOrEqual(50);
      seen.push(...page.map(entry => entry.id));
    }
    expect(seen).toEqual(newestFirstIds);
    // Three full-or-partial pages plus the terminating empty page; the store's
    // own default page size is used (no limit is requested).
    expect(listActiveMemories).toHaveBeenCalledTimes(4);
    expect(listActiveMemories.mock.calls.every(([options]) => options?.limit === undefined)).toBe(true);
  });

  it('advances on the raw page even when a filter keeps nothing from it', async () => {
    const newestPage = new Set(newestFirstIds.slice(0, 50));
    const kept = await collectActiveMemories(
      { listActiveMemories: keysetActiveMemoryPages(() => corpus) },
      entry => !newestPage.has(entry.id),
    );
    expect(kept.map(entry => entry.id)).toEqual(newestFirstIds.slice(50));
  });

  it('fails instead of looping on a store that ignores the cursor', async () => {
    const stuck = { listActiveMemories: async () => corpus.slice(0, 50) };
    await expect(collectActiveMemories(stuck, () => true))
      .rejects.toThrow('listActiveMemories did not advance past the keyset cursor');
  });
});
