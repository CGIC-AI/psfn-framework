import { describe, expect, it, vi } from 'vitest';
import { createWebSearchQueryJson, normalizeWebSearchLimit, planWebSearchUrls } from './search.js';
import { runWithRequestContext } from '../../../primitives/llm/request-context.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';

function makeResponse(content: string) {
  return {
    content,
    toolCalls: [],
    model: 'planner-model',
    inputTokens: 5,
    outputTokens: 5,
    stopReason: 'stop',
  };
}

function makeProvider(complete: ReturnType<typeof vi.fn>): LLMProviderPort {
  return { complete } as unknown as LLMProviderPort;
}

describe('createWebSearchQueryJson', () => {
  it('returns parsed JSON from the first attempt with baseline correlation metadata', async () => {
    const complete = vi.fn(async () => makeResponse('["https://example.test/a"]'));
    const queryJson = createWebSearchQueryJson(makeProvider(complete));

    const result = await runWithRequestContext({ requestId: 'req-1' }, async () => {
      return queryJson('find urls');
    });

    expect(result).toEqual(['https://example.test/a']);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        correlation: expect.objectContaining({
          requestId: 'req-1:web-search:1',
          callType: 'tool',
          toolName: 'web',
          purpose: 'agent.web.search',
          originType: 'tool',
          originStage: 'agent.web.search',
        }),
      }),
      'reasoning',
    );
  });

  it('retries on JSON parse failure with distinct .retry correlation metadata', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(makeResponse('not json'))
      .mockResolvedValueOnce(makeResponse('{"ok":true}'));
    const queryJson = createWebSearchQueryJson(makeProvider(complete));

    const result = await runWithRequestContext({ requestId: 'req-2' }, async () => {
      return queryJson('find urls');
    });

    expect(result).toEqual({ ok: true });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        correlation: expect.objectContaining({
          requestId: 'req-2:web-search:1',
          purpose: 'agent.web.search',
          originStage: 'agent.web.search',
        }),
      }),
      'reasoning',
    );
    expect(complete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        correlation: expect.objectContaining({
          requestId: 'req-2:web-search:2',
          purpose: 'agent.web.search.retry',
          originStage: 'agent.web.search.retry',
        }),
      }),
      'reasoning',
    );
  });

  it('returns null when every attempt fails to parse', async () => {
    const complete = vi.fn(async () => makeResponse('still not json'));
    const queryJson = createWebSearchQueryJson(makeProvider(complete));

    await expect(queryJson('find urls')).resolves.toBeNull();
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('treats maxRetries as the total attempt budget', async () => {
    const complete = vi.fn(async () => makeResponse('nope'));
    const queryJson = createWebSearchQueryJson(makeProvider(complete));

    await expect(queryJson('find urls', 3)).resolves.toBeNull();
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it('does not retry when the attempt budget is one', async () => {
    const complete = vi.fn(async () => makeResponse('nope'));
    const queryJson = createWebSearchQueryJson(makeProvider(complete));

    await expect(queryJson('find urls', 1)).resolves.toBeNull();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('propagates provider errors without retrying', async () => {
    const complete = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const queryJson = createWebSearchQueryJson(makeProvider(complete));

    await expect(queryJson('find urls')).rejects.toThrow('provider unavailable');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('propagates provider errors thrown on a retry attempt', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(makeResponse('not json'))
      .mockRejectedValueOnce(new Error('network down'));
    const queryJson = createWebSearchQueryJson(makeProvider(complete));

    await expect(queryJson('find urls')).rejects.toThrow('network down');
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

describe('planWebSearchUrls', () => {
  it('normalizes, dedupes, and caps planned HTTPS urls', async () => {
    const queryJson = vi.fn(async () => [
      'https://example.test/a ',
      'https://example.test/a',
      'http://insecure.test/b',
      'https://example.test/c',
      42,
    ]);

    const urls = await planWebSearchUrls('query', 2, queryJson);
    expect(urls).toEqual(['https://example.test/a', 'https://example.test/c']);
    expect(queryJson).toHaveBeenCalledWith(expect.stringContaining('up to 2'), 2);
  });

  it('returns an empty list when planning yields no array', async () => {
    const queryJson = vi.fn(async () => null);
    await expect(planWebSearchUrls('query', 3, queryJson)).resolves.toEqual([]);
  });
});

describe('normalizeWebSearchLimit', () => {
  it('defaults and clamps limits', () => {
    expect(normalizeWebSearchLimit(undefined)).toBe(3);
    expect(normalizeWebSearchLimit('4')).toBe(3);
    expect(normalizeWebSearchLimit(0)).toBe(1);
    expect(normalizeWebSearchLimit(99)).toBe(5);
    expect(normalizeWebSearchLimit(2.9)).toBe(2);
  });
});
