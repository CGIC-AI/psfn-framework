import { describe, expect, it } from 'vitest';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { SessionEntry } from '../types.js';
import { createSessionTailReadStore } from './session-tail-read-store.js';

const CHANNEL = 'fixture:tail-channel';

function makeEntry(id: number, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id,
    channelId: CHANNEL,
    role: id % 2 === 0 ? 'assistant' : 'user',
    content: `journal copy ${id}`,
    timestamp: 1_000 + id,
    ...overrides,
  };
}

function makeStubStore(entries: SessionEntry[]): SessionStore {
  return {
    getRecent: (channelId: string, limit: number) => {
      const matching = entries.filter(entry => entry.channelId === channelId);
      return matching.slice(-Math.max(0, Math.floor(limit)));
    },
    getEntriesInRange: (channelId: string, startId: number, endId: number) => (
      entries.filter(entry => (
        entry.channelId === channelId && entry.id >= startId && entry.id <= endId
      ))
    ),
    getCompactionSummaries: () => [],
  } as never;
}

describe('createSessionTailReadStore (psfn-framework-hgw3.5)', () => {
  it('serves a window that fits the tail from the tail alone', () => {
    const journal = [makeEntry(1), makeEntry(2), makeEntry(3)];
    const tail = [makeEntry(2, { content: 'tail copy 2' }), makeEntry(3, { content: 'tail copy 3' })];
    const wrapped = createSessionTailReadStore(makeStubStore(journal), CHANNEL, tail);

    const recent = wrapped.getRecent(CHANNEL, 2);
    expect(recent.map(entry => entry.content)).toEqual(['tail copy 2', 'tail copy 3']);
  });

  it('merges wider windows by entry id with the tail copy winning, no duplicates, ascending order', () => {
    const journal = [makeEntry(1), makeEntry(2), makeEntry(3), makeEntry(4)];
    // Tail is bounded to the newest two; entry 4 exists only in the tail
    // (journal cache stale) and entry 3 overlaps with a differing copy.
    const tail = [makeEntry(3, { content: 'tail copy 3' }), makeEntry(4, { content: 'tail copy 4' })];
    const stale = makeStubStore(journal.slice(0, 3));
    const wrapped = createSessionTailReadStore(stale, CHANNEL, tail);

    const recent = wrapped.getRecent(CHANNEL, 4);
    expect(recent.map(entry => entry.id)).toEqual([1, 2, 3, 4]);
    expect(recent.map(entry => entry.content)).toEqual([
      'journal copy 1',
      'journal copy 2',
      'tail copy 3',
      'tail copy 4',
    ]);
  });

  it('caps the merged window at the requested limit', () => {
    const journal = [makeEntry(1), makeEntry(2), makeEntry(3)];
    const tail = [makeEntry(4)];
    const wrapped = createSessionTailReadStore(makeStubStore(journal), CHANNEL, tail);

    const recent = wrapped.getRecent(CHANNEL, 3);
    expect(recent.map(entry => entry.id)).toEqual([2, 3, 4]);
  });

  it('merges getEntriesInRange with tail entries restricted to the range', () => {
    const journal = [makeEntry(1), makeEntry(2), makeEntry(3)];
    const tail = [makeEntry(3, { content: 'tail copy 3' }), makeEntry(4), makeEntry(5)];
    const wrapped = createSessionTailReadStore(makeStubStore(journal), CHANNEL, tail);

    const range = wrapped.getEntriesInRange(CHANNEL, 2, 4);
    expect(range.map(entry => entry.id)).toEqual([2, 3, 4]);
    expect(range[1].content).toBe('tail copy 3');
  });

  it('passes other channels straight through', () => {
    const otherChannel = 'fixture:other-channel';
    const journal = [
      makeEntry(1, { channelId: otherChannel, content: 'other journal 1' }),
      makeEntry(2, { channelId: otherChannel, content: 'other journal 2' }),
    ];
    const tail = [makeEntry(9, { content: 'tail only' })];
    const wrapped = createSessionTailReadStore(makeStubStore(journal), CHANNEL, tail);

    expect(wrapped.getRecent(otherChannel, 5).map(entry => entry.content))
      .toEqual(['other journal 1', 'other journal 2']);
    expect(wrapped.getEntriesInRange(otherChannel, 1, 9)).toHaveLength(2);
  });

  it('returns empty for non-positive limits', () => {
    const wrapped = createSessionTailReadStore(makeStubStore([makeEntry(1)]), CHANNEL, [makeEntry(1)]);
    expect(wrapped.getRecent(CHANNEL, 0)).toEqual([]);
  });
});
