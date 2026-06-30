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
