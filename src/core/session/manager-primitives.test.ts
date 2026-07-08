import { describe, expect, it } from 'vitest';
import {
  buildRecentSessionSummaryFallbackText,
  buildSessionSummarySourceBlock,
} from './manager-primitives.js';
import {
  buildToolObservationMetadata,
  normalizeToolObservation,
} from './tool-observation.js';
import type { SessionEntry } from './types.js';

function entry(input: Partial<SessionEntry> & Pick<SessionEntry, 'id' | 'role' | 'content'>): SessionEntry {
  return {
    channelId: 'discord:room-1',
    timestamp: 1_700_000_000_000 + input.id,
    ...input,
  };
}

describe('recent session summary primitives', () => {
  it('builds a bounded paragraph fallback instead of clipped speaker lines', () => {
    const summary = buildRecentSessionSummaryFallbackText({
      characterName: 'Cardellini',
      maxTokens: 200,
      entries: [
        entry({
          id: 1,
          role: 'user',
          authorId: 'discord:vega',
          authorName: 'Vega',
          content: 'We need room-scoped memory boundaries.',
        }),
        entry({
          id: 2,
          role: 'user',
          authorId: 'discord:iku',
          authorName: 'Iku',
          content: 'Speaker attribution must survive provider rendering.',
        }),
        entry({
          id: 3,
          role: 'assistant',
          content: 'I will keep the summary compact.',
        }),
      ],
    });

    expect(summary).toContain('[History summary]');
    expect(summary).toContain('Earlier in the summarized span,');
    expect(summary).toContain('Vega noted "We need room-scoped memory boundaries');
    expect(summary).toContain('Iku noted "Speaker attribution must survive provider rendering');
    expect(summary).toContain('Cardellini noted "I will keep the summary compact');
    expect(summary).not.toContain('Vega said:');
    expect(summary).not.toContain('\n- Vega:');
  });

  it('compresses repeated tool failures before summary input', () => {
    const failure = normalizeToolObservation({
      toolName: 'search_logs',
      content: 'kubectl logs timed out while reading provider payload output',
      isError: true,
    });
    const metadata = buildToolObservationMetadata(undefined, failure.metadata);
    const sourceBlock = buildSessionSummarySourceBlock({
      characterName: 'Cardellini',
      entries: [
        entry({
          id: 1,
          role: 'tool',
          authorId: 'tool:search_logs',
          authorName: 'search_logs',
          content: failure.content,
          metadata,
        }),
        entry({
          id: 2,
          role: 'tool',
          authorId: 'tool:search_logs',
          authorName: 'search_logs',
          content: failure.content,
          metadata,
        }),
        entry({
          id: 3,
          role: 'tool',
          authorId: 'tool:search_logs',
          authorName: 'search_logs',
          content: failure.content,
          metadata,
        }),
      ],
    });

    expect(sourceBlock).toContain('[Compressed tool failures]');
    expect(sourceBlock).toContain('search_logs failed 3 times; latest error: kubectl logs timed out');
    expect(sourceBlock.match(/kubectl logs timed out/g)).toHaveLength(1);
    expect(sourceBlock).not.toContain('[Tool result: search_logs (error)]');
  });
});

describe('temporal session history window floor', () => {
  const NOW = new Date('2026-07-06T14:10:00Z');

  function dialogueEntry(id: number, role: 'user' | 'assistant', timestamp: number): SessionEntry {
    return {
      id,
      channelId: 'discord:room-1',
      role,
      content: `${role} message ${id}`,
      authorId: role === 'user' ? 'user-1' : 'assistant',
      authorName: role === 'user' ? 'V' : 'P',
      timestamp,
      channelVisibility: 'private',
    } as SessionEntry;
  }

  it('backfills pre-window entries so a temporal cue never strips recent conversation', async () => {
    const { applyTemporalSessionHistoryWindow, TEMPORAL_WINDOW_MIN_CONVERSATIONAL_ENTRIES } =
      await import('./manager-primitives.js');
    const nowMs = NOW.getTime();
    // 20 exchanges last night (before the same-day boundary), 1 exchange this morning.
    const oldEntries = Array.from({ length: 20 }, (_, i) =>
      dialogueEntry(i + 1, i % 2 === 0 ? 'user' : 'assistant', nowMs - 12 * 60 * 60 * 1000 + i * 1000));
    const freshEntries = [
      dialogueEntry(100, 'user', nowMs - 60_000),
      dialogueEntry(101, 'assistant', nowMs - 55_000),
    ];
    const result = applyTemporalSessionHistoryWindow(
      [...oldEntries, ...freshEntries],
      // "today" is a temporal cue -> same_day window.
      { messageText: "I'm off today so let's stay like this" },
      NOW,
    );
    const conversational = result.filter(e => e.role === 'user' || e.role === 'assistant');
    expect(conversational.length).toBeGreaterThanOrEqual(TEMPORAL_WINDOW_MIN_CONVERSATIONAL_ENTRIES);
    // Most recent entries always retained, in chronological order.
    expect(result.at(-1)?.id).toBe(101);
    const ids = result.map(e => e.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('applies the temporal filter unchanged when enough conversation is in-window', async () => {
    const { applyTemporalSessionHistoryWindow } = await import('./manager-primitives.js');
    const nowMs = NOW.getTime();
    const inWindow = Array.from({ length: 16 }, (_, i) =>
      dialogueEntry(i + 1, i % 2 === 0 ? 'user' : 'assistant', nowMs - 60 * 60 * 1000 + i * 1000));
    const old = [dialogueEntry(500, 'user', nowMs - 3 * 24 * 60 * 60 * 1000)];
    const result = applyTemporalSessionHistoryWindow(
      [...old, ...inWindow],
      { messageText: 'what did we do today?' },
      NOW,
    );
    expect(result.map(e => e.id)).not.toContain(500);
    expect(result).toHaveLength(16);
  });
});

describe('non-conversational session entry classification', () => {
  it('classifies legacy completion_handoff rows as non-conversational', async () => {
    const { isNonConversationalSessionEntry } = await import('./manager-primitives.js');
    expect(isNonConversationalSessionEntry({
      metadata: JSON.stringify({
        type: 'completion_handoff',
        schemaVersion: 1,
        dedupeKey: 'abc',
        handoffId: 'handoff:abc',
        source: 'post_turn_action',
        status: 'completed',
        partialResult: false,
      }),
    })).toBe(true);
    expect(isNonConversationalSessionEntry({ metadata: undefined })).toBe(false);
    expect(isNonConversationalSessionEntry({
      metadata: JSON.stringify({ type: 'mirror' }),
    })).toBe(false);
  });
});
