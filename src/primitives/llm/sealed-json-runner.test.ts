import { describe, expect, it, vi } from 'vitest';
import {
  assertExactJsonKeys,
  boundedSealedText,
  completeSealedJsonObject,
  parseSealedJsonObject,
  stripMarkdownJsonFence,
} from './sealed-json-runner.js';

describe('sealed-json-runner primitive', () => {
  it('strips optional markdown JSON fences and parses strict JSON objects', () => {
    expect(stripMarkdownJsonFence('```json\n{"ok":true}\n```')).toBe('{"ok":true}');
    expect(parseSealedJsonObject('```json\n{"a":1}\n```', 'audit', { allowMarkdownFence: true })).toEqual({ a: 1 });
    expect(() => parseSealedJsonObject('```json\n{"a":1}\n```', 'strict')).toThrow(/malformed JSON/u);
    expect(() => parseSealedJsonObject('[1,2]', 'strict')).toThrow(/must return a JSON object/u);
  });

  it('enforces exact keys and bounded text invariants', () => {
    expect(() => assertExactJsonKeys({ a: 1, b: 2 }, ['a', 'b'], 'test')).not.toThrow();
    expect(() => assertExactJsonKeys({ a: 1, extra: 2 }, ['a'], 'test')).toThrow(/invalid response shape/u);
    expect(boundedSealedText('  hello\nworld  ', 'summary', 20, { collapseWhitespace: true })).toBe('hello world');
    expect(() => boundedSealedText('bad\0text', 'summary', 20)).toThrow(/1-20 characters/u);
  });

  it('completes a sealed work-spec request and wires deadline abort cleanup', async () => {
    const complete = vi.fn(async (_context, purpose, options) => {
      expect(purpose).toBe('background');
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options?.modelHint).toEqual({ maxTokens: 128, temperature: 0 });
      return {
        content: '{"verdict":"ok"}',
        model: 'test-model',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });

    const result = await completeSealedJsonObject({
      llmProvider: { complete },
      label: 'checker',
      systemPrompt: 'Return JSON only.',
      payload: { probe: 1 },
      workSpec: {
        purpose: 'background',
        durable: false,
        correlation: {
          requestId: 'req-1',
          channelId: 'internal:test',
          callType: 'background',
          purpose: 'agent.intention.appraisal',
        },
      },
      exactKeys: ['verdict'],
      deadlineMs: 5_000,
      modelHint: { maxTokens: 128, temperature: 0 },
    });

    expect(result.parsed).toEqual({ verdict: 'ok' });
    expect(result.response.model).toBe('test-model');
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
