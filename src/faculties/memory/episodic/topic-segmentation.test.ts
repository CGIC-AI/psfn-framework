import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import {
  TOPIC_SEGMENTATION_SYSTEM_PROMPT,
  formatSegmentationTranscript,
  parseTopicSegments,
  proposeTopicSegments,
} from './topic-segmentation.js';

function segmentsJson(segments: Array<Record<string, unknown>>): string {
  return JSON.stringify({ segments });
}

describe('parseTopicSegments', () => {
  it('accepts a contiguous full cover with a trailing open segment', () => {
    const content = [
      'Here is the segmentation you asked for:',
      segmentsJson([
        { start_index: 0, end_index: 7, topic: 'atlas scheduler debugging', status: 'closed' },
        { start_index: 8, end_index: 9, topic: 'dinner planning', status: 'open' },
      ]),
    ].join('\n');

    expect(parseTopicSegments(content, 10)).toEqual([
      { startIndex: 0, endIndex: 7, topic: 'atlas scheduler debugging', status: 'closed' },
      { startIndex: 8, endIndex: 9, topic: 'dinner planning', status: 'open' },
    ]);
  });

  it('accepts a single closed segment covering the whole chunk', () => {
    const content = segmentsJson([
      { start_index: 0, end_index: 3, topic: 'release planning', status: 'closed' },
    ]);
    expect(parseTopicSegments(content, 4)).toHaveLength(1);
  });

  it.each([
    ['no JSON object', 'the topics are debugging and dinner', 10],
    ['empty segments array', segmentsJson([]), 10],
    ['segments not an array', JSON.stringify({ segments: 'oops' }), 10],
    [
      'gap between segments',
      segmentsJson([
        { start_index: 0, end_index: 3, topic: 'a', status: 'closed' },
        { start_index: 5, end_index: 9, topic: 'b', status: 'closed' },
      ]),
      10,
    ],
    [
      'overlapping segments',
      segmentsJson([
        { start_index: 0, end_index: 5, topic: 'a', status: 'closed' },
        { start_index: 5, end_index: 9, topic: 'b', status: 'closed' },
      ]),
      10,
    ],
    [
      'cover not starting at zero',
      segmentsJson([{ start_index: 1, end_index: 9, topic: 'a', status: 'closed' }]),
      10,
    ],
    [
      'cover not reaching the final entry',
      segmentsJson([{ start_index: 0, end_index: 8, topic: 'a', status: 'closed' }]),
      10,
    ],
    [
      'open segment before the final segment',
      segmentsJson([
        { start_index: 0, end_index: 4, topic: 'a', status: 'open' },
        { start_index: 5, end_index: 9, topic: 'b', status: 'closed' },
      ]),
      10,
    ],
    [
      'start after end',
      segmentsJson([{ start_index: 4, end_index: 2, topic: 'a', status: 'closed' }]),
      10,
    ],
    [
      'out-of-range index',
      segmentsJson([{ start_index: 0, end_index: 10, topic: 'a', status: 'closed' }]),
      10,
    ],
    [
      'non-integer index',
      segmentsJson([{ start_index: 0, end_index: 9.5, topic: 'a', status: 'closed' }]),
      10,
    ],
    [
      'invalid status',
      segmentsJson([{ start_index: 0, end_index: 9, topic: 'a', status: 'pending' }]),
      10,
    ],
    [
      'empty topic label',
      segmentsJson([{ start_index: 0, end_index: 9, topic: '  ', status: 'closed' }]),
      10,
    ],
    [
      'topic label over the length cap',
      segmentsJson([{ start_index: 0, end_index: 9, topic: 'x'.repeat(81), status: 'closed' }]),
      10,
    ],
  ])('fails closed on %s', (_label, content, entryCount) => {
    expect(() => parseTopicSegments(content, entryCount)).toThrow();
  });

  it('fails closed on an empty chunk', () => {
    expect(() => parseTopicSegments(segmentsJson([]), 0)).toThrow('non-empty chunk');
  });
});

describe('proposeTopicSegments', () => {
  function entry(id: number, content: string): SessionEntry {
    return {
      id,
      channelId: 'terminal:daily',
      role: id % 2 === 1 ? 'user' : 'assistant',
      content,
      timestamp: Date.parse('2026-04-01T10:00:00.000Z') + id * 60_000,
    };
  }

  it('sends the clinical prompt and returns schema-validated segments', async () => {
    const captured: Array<{ systemPrompt?: string; userContent: string; purpose: string }> = [];
    const provider = {
      complete: async (
        context: { systemPrompt?: string; messages: Array<{ role: string; content: string }> },
        purpose: string,
      ) => {
        captured.push({
          systemPrompt: context.systemPrompt,
          userContent: context.messages[0].content,
          purpose,
        });
        return {
          content: segmentsJson([
            { start_index: 0, end_index: 1, topic: 'atlas debugging', status: 'closed' },
          ]),
          toolCalls: [],
          model: 'test-model',
          inputTokens: 0,
          outputTokens: 0,
          stopReason: 'stop',
        };
      },
    };

    const segments = await proposeTopicSegments(provider as never, {
      sessionId: 'terminal:daily',
      channelId: 'terminal:daily',
      entries: [entry(1, 'Please debug atlas.'), entry(2, 'Atlas failure found.')],
    });

    expect(segments).toEqual([
      { startIndex: 0, endIndex: 1, topic: 'atlas debugging', status: 'closed' },
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0].systemPrompt).toBe(TOPIC_SEGMENTATION_SYSTEM_PROMPT);
    expect(captured[0].purpose).toBe('memory');
    expect(captured[0].userContent).toContain('[0] 2026-04-01T10:01:00.000Z user: Please debug atlas.');
    expect(captured[0].userContent).toContain('[1] 2026-04-01T10:02:00.000Z assistant: Atlas failure found.');
  });

  it('rejects an empty chunk before any LLM spend', async () => {
    const provider = {
      complete: async () => {
        throw new Error('must not be called');
      },
    };
    await expect(proposeTopicSegments(provider as never, {
      sessionId: 'terminal:daily',
      channelId: 'terminal:daily',
      entries: [],
    })).rejects.toThrow('non-empty chunk');
  });

  it('clips oversized entry content in the transcript', () => {
    const transcript = formatSegmentationTranscript([entry(1, 'y'.repeat(1000))]);
    expect(transcript.length).toBeLessThan(600);
    expect(transcript).toContain('...');
  });
});
