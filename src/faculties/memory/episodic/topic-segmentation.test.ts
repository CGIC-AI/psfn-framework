import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import {
  TOPIC_SEGMENTATION_SYSTEM_PROMPT,
  TopicSegmentationValidationError,
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

    expect(parseTopicSegments(content, 10)).toEqual({
      segments: [
        { startIndex: 0, endIndex: 7, topic: 'atlas scheduler debugging', status: 'closed' },
        { startIndex: 8, endIndex: 9, topic: 'dinner planning', status: 'open' },
      ],
      repairs: [],
    });
  });

  it('accepts a single closed segment covering the whole chunk', () => {
    const content = segmentsJson([
      { start_index: 0, end_index: 3, topic: 'release planning', status: 'closed' },
    ]);
    expect(parseTopicSegments(content, 4).segments).toHaveLength(1);
  });

  // iu7v0 regression fixtures: the two validator failures seen in production
  // (an uncovered trailing tail, an over-long topic label) are now repaired
  // deterministically and reported, instead of failing the whole chunk.
  it('repairs an uncovered trailing tail by extending the final segment', () => {
    const content = segmentsJson([
      { start_index: 0, end_index: 6, topic: 'atlas scheduler debugging', status: 'closed' },
      { start_index: 7, end_index: 10, topic: 'dinner planning', status: 'open' },
    ]);
    expect(parseTopicSegments(content, 14)).toEqual({
      segments: [
        { startIndex: 0, endIndex: 6, topic: 'atlas scheduler debugging', status: 'closed' },
        { startIndex: 7, endIndex: 13, topic: 'dinner planning', status: 'open' },
      ],
      repairs: ['trailing_gap_extended'],
    });
  });

  it('truncates an over-long topic label to the label cap', () => {
    const longTopic = `${'release planning and rollout coordination '.repeat(4)}tail`;
    const { segments, repairs } = parseTopicSegments(segmentsJson([
      { start_index: 0, end_index: 13, topic: longTopic, status: 'closed' },
    ]), 14);
    expect(segments[0]!.topic.length).toBeLessThanOrEqual(80);
    expect(longTopic.startsWith(segments[0]!.topic)).toBe(true);
    expect(repairs).toEqual(['topic_truncated']);
  });

  it('repairs the remaining unambiguous boundary defects and reports each one', () => {
    const { segments, repairs } = parseTopicSegments(segmentsJson([
      { start_index: 1, end_index: 4, topic: 'a', status: 'open' },
      { start_index: 5, end_index: 12, topic: 'b', status: 'closed' },
    ]), 10);
    expect(segments).toEqual([
      { startIndex: 0, endIndex: 4, topic: 'a', status: 'closed' },
      { startIndex: 5, endIndex: 9, topic: 'b', status: 'closed' },
    ]);
    expect(repairs.sort()).toEqual(['final_segment_clamped', 'leading_gap_extended', 'non_final_open_closed']);
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
      'out-of-range index on a non-final segment',
      segmentsJson([
        { start_index: 0, end_index: 12, topic: 'a', status: 'closed' },
        { start_index: 13, end_index: 14, topic: 'b', status: 'closed' },
      ]),
      10,
    ],
    [
      'start after end',
      segmentsJson([{ start_index: 4, end_index: 2, topic: 'a', status: 'closed' }]),
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
  ])('fails closed on %s', (_label, content, entryCount) => {
    expect(() => parseTopicSegments(content, entryCount)).toThrow(TopicSegmentationValidationError);
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

    expect(segments).toEqual({
      segments: [{ startIndex: 0, endIndex: 1, topic: 'atlas debugging', status: 'closed' }],
      repairs: [],
      correctiveRetry: false,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].systemPrompt).toBe(TOPIC_SEGMENTATION_SYSTEM_PROMPT);
    expect(captured[0].purpose).toBe('memory');
    expect(captured[0].userContent).toContain('[0] 2026-04-01T10:01:00.000Z user: Please debug atlas.');
    expect(captured[0].userContent).toContain('[1] 2026-04-01T10:02:00.000Z assistant: Atlas failure found.');
  });

  function queuedProvider(responses: Array<string | Error>) {
    const prompts: string[] = [];
    return {
      prompts,
      complete: async (context: { messages: Array<{ role: string; content: string }> }) => {
        prompts.push(context.messages[0]!.content);
        const next = responses.shift();
        if (next === undefined) throw new Error('unexpected extra segmentation call');
        if (next instanceof Error) throw next;
        return {
          content: next,
          toolCalls: [],
          model: 'test-model',
          inputTokens: 0,
          outputTokens: 0,
          stopReason: 'stop',
        };
      },
    };
  }

  const chunk = () => [entry(1, 'Please debug atlas.'), entry(2, 'Atlas failure found.'), entry(3, 'Dinner?')];
  const request = () => ({ sessionId: 'terminal:daily', channelId: 'terminal:daily', entries: chunk() });

  it('makes one corrective retry naming the violation when repair cannot settle it', async () => {
    const provider = queuedProvider([
      segmentsJson([{ start_index: 0, end_index: 2, topic: '   ', status: 'closed' }]),
      segmentsJson([{ start_index: 0, end_index: 2, topic: 'atlas debugging', status: 'closed' }]),
    ]);

    const result = await proposeTopicSegments(provider as never, request());

    expect(result).toEqual({
      segments: [{ startIndex: 0, endIndex: 2, topic: 'atlas debugging', status: 'closed' }],
      repairs: [],
      correctiveRetry: true,
    });
    expect(provider.prompts).toHaveLength(2);
    expect(provider.prompts[1]).toContain('Your previous answer was rejected: segment 0 topic must be a non-empty string');
    expect(provider.prompts[1]).toContain('Cover every entry index from 0 through 2');
  });

  it('fails closed after the corrective retry also violates the schema, keeping both rejections', async () => {
    const provider = queuedProvider([
      'no json at all',
      segmentsJson([
        { start_index: 0, end_index: 0, topic: 'a', status: 'closed' },
        { start_index: 2, end_index: 2, topic: 'b', status: 'closed' },
      ]),
    ]);

    const failure = await proposeTopicSegments(provider as never, request()).catch(error => error);

    expect(failure).toBeInstanceOf(TopicSegmentationValidationError);
    expect(failure.message).toContain('segment 1 leaves a gap or overlap');
    expect(failure.message).toContain('after one corrective retry; first rejection: segmentation response contains no JSON object');
    expect(provider.prompts).toHaveLength(2);
  });

  it('never retries a provider failure', async () => {
    const provider = queuedProvider([new Error('provider unavailable')]);
    await expect(proposeTopicSegments(provider as never, request())).rejects.toThrow('provider unavailable');
    expect(provider.prompts).toHaveLength(1);
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
