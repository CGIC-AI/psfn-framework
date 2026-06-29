import { describe, expect, it } from 'vitest';
import { buildSessionHistorySummaryText } from './manager-primitives.js';
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

describe('buildSessionHistorySummaryText', () => {
  it('preserves speaker names in fallback multi-user summaries', () => {
    const summary = buildSessionHistorySummaryText({
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
    expect(summary).toContain('In the summarized span,');
    expect(summary).toContain('Vega said: We need room-scoped memory boundaries');
    expect(summary).toContain('Iku said: Speaker attribution must survive provider rendering');
    expect(summary).toContain('Cardellini said: I will keep the summary compact');
    expect(summary).not.toContain('\n- Vega:');
  });

  it('compresses repeated tool failures into one bounded summary line', () => {
    const failure = normalizeToolObservation({
      toolName: 'search_logs',
      content: 'kubectl logs timed out while reading provider payload output',
      isError: true,
    });
    const metadata = buildToolObservationMetadata(undefined, failure.metadata);
    const summary = buildSessionHistorySummaryText({
      characterName: 'Cardellini',
      maxTokens: 200,
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

    expect(summary).toContain('Tool reported: search_logs failed 3 times.');
    expect(summary).toContain('Most recent failure: [Tool result: search_logs (error)]');
    expect(summary.match(/kubectl logs timed out/g)).toHaveLength(1);
  });
});
