import { describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import { selectExtractionRecentEntries } from './recovered-entries.js';
import { RECOVERY_CONTEXT_MESSAGE_LIMIT } from './types.js';

function entry(id: number, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id,
    channelId: 'api:test',
    role: id % 2 === 0 ? 'assistant' : 'user',
    content: `line ${id}`,
    timestamp: id,
    ...overrides,
  };
}

function entries(count: number): SessionEntry[] {
  return Array.from({ length: count }, (_, index) => entry(index + 1));
}

const internalLaneMetadata = JSON.stringify({
  sessionLane: { schemaVersion: 1, kind: 'internal' },
});

describe('selectExtractionRecentEntries', () => {
  it('uses the recovered range without fetching live history when one was handed in', () => {
    const fetchLiveHistory = vi.fn(() => entries(3));
    const recovered = entries(2);
    const selected = selectExtractionRecentEntries({
      recoveredEntries: recovered,
      fetchLiveHistory,
      groupRecoveredRange: false,
    });
    expect(selected).toEqual(recovered);
    expect(fetchLiveHistory).not.toHaveBeenCalled();
  });

  it('treats an empty recovered range as authoritative instead of falling back to live history', () => {
    const fetchLiveHistory = vi.fn(() => entries(3));
    const selected = selectExtractionRecentEntries({
      recoveredEntries: [],
      fetchLiveHistory,
      groupRecoveredRange: false,
    });
    expect(selected).toEqual([]);
    expect(fetchLiveHistory).not.toHaveBeenCalled();
  });

  it('falls back to live history only when no recovered range was provided', () => {
    const live = entries(4);
    const fetchLiveHistory = vi.fn(() => live);
    const selected = selectExtractionRecentEntries({
      recoveredEntries: undefined,
      fetchLiveHistory,
      groupRecoveredRange: false,
    });
    expect(selected).toEqual(live);
    expect(fetchLiveHistory).toHaveBeenCalledTimes(1);
  });

  it('filters non-conversational internal-lane and completion-handoff entries', () => {
    const conversational = [entry(1), entry(4)];
    const selected = selectExtractionRecentEntries({
      recoveredEntries: [
        conversational[0],
        entry(2, { metadata: internalLaneMetadata }),
        entry(3, { metadata: JSON.stringify({ type: 'completion_handoff' }) }),
        conversational[1],
      ],
      fetchLiveHistory: () => [],
      groupRecoveredRange: false,
    });
    expect(selected).toEqual(conversational);
  });

  it('caps a direct run at the RECOVERY_CONTEXT_MESSAGE_LIMIT tail', () => {
    const recovered = entries(RECOVERY_CONTEXT_MESSAGE_LIMIT + 7);
    const selected = selectExtractionRecentEntries({
      recoveredEntries: recovered,
      fetchLiveHistory: () => [],
      groupRecoveredRange: false,
    });
    expect(selected).toHaveLength(RECOVERY_CONTEXT_MESSAGE_LIMIT);
    expect(selected[0]?.id).toBe(8);
    expect(selected.at(-1)?.id).toBe(RECOVERY_CONTEXT_MESSAGE_LIMIT + 7);
  });

  it('applies the tail cap after filtering non-conversational entries', () => {
    // 1 internal entry ahead of the window must not consume cap budget.
    const recovered = [
      entry(0, { metadata: internalLaneMetadata }),
      ...entries(RECOVERY_CONTEXT_MESSAGE_LIMIT + 1),
    ];
    const selected = selectExtractionRecentEntries({
      recoveredEntries: recovered,
      fetchLiveHistory: () => [],
      groupRecoveredRange: false,
    });
    expect(selected).toHaveLength(RECOVERY_CONTEXT_MESSAGE_LIMIT);
    expect(selected[0]?.id).toBe(2);
  });

  it('exempts a group recovered range from the legacy recovery ceiling', () => {
    const recovered = entries(RECOVERY_CONTEXT_MESSAGE_LIMIT * 3);
    const selected = selectExtractionRecentEntries({
      recoveredEntries: recovered,
      fetchLiveHistory: () => [],
      groupRecoveredRange: true,
    });
    expect(selected).toHaveLength(RECOVERY_CONTEXT_MESSAGE_LIMIT * 3);
    expect(selected[0]?.id).toBe(1);
  });

  it('still filters non-conversational entries on the exempt group path', () => {
    const recovered = [
      entry(1),
      entry(2, { metadata: internalLaneMetadata }),
      entry(3),
    ];
    const selected = selectExtractionRecentEntries({
      recoveredEntries: recovered,
      fetchLiveHistory: () => [],
      groupRecoveredRange: true,
    });
    expect(selected.map(e => e.id)).toEqual([1, 3]);
  });
});
