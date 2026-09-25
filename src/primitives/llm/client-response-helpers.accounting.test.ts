import { describe, expect, it } from 'vitest';
import { capInputTokensToContextWindow, normalizeLLMUsageDetails } from './client-response-helpers.js';

describe('normalizeLLMUsageDetails accounting evidence', () => {
  it('rejects an unknown nonempty provider usage shape', () => {
    expect(() => normalizeLLMUsageDetails({ bananas: 7 }, 0, 0))
      .toThrow('Unsupported provider usage shape');
  });

  it('rejects malformed negative provider counts instead of coercing them to zero', () => {
    expect(() => normalizeLLMUsageDetails({
      prompt_tokens: -1,
      completion_tokens: 2,
      total_tokens: 1,
    }, 0, 0)).toThrow('usage.prompt_tokens must be a non-negative integer');
  });

  it('separates LiteLLM cache hits from prompt tokens without double counting', () => {
    expect(normalizeLLMUsageDetails({
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_cache_hit_tokens: 25,
      total_tokens: 110,
    }, 0, 0)).toMatchObject({
      input: 75,
      output: 10,
      cacheRead: 25,
      cacheWrite: 0,
      totalTokens: 110,
    });
  });

  it('rejects a provider total that contradicts the separated cache buckets', () => {
    expect(() => normalizeLLMUsageDetails({
      input: 90,
      output: 10,
      cacheRead: 20,
      cacheWrite: 5,
      totalTokens: 145,
    }, 0, 0)).toThrow(
      'usage.totalTokens must equal input + output + cacheRead + cacheWrite (125)',
    );
  });

  it('preserves an explicit zero input bucket for a fully cached provider attempt', () => {
    expect(normalizeLLMUsageDetails({
      input: 0,
      output: 5,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 105,
    }, 20, 5)).toMatchObject({
      input: 0,
      output: 5,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 105,
    });
  });

  it('preserves a computed zero input bucket for a fully cached raw provider attempt', () => {
    expect(normalizeLLMUsageDetails({
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_cache_hit_tokens: 100,
      total_tokens: 105,
    }, 20, 5)).toMatchObject({
      input: 0,
      output: 5,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 105,
    });
  });
});

describe('capInputTokensToContextWindow (2sm32)', () => {
  it('caps a base64-inflated estimate at the routed context window', () => {
    expect(capInputTokensToContextWindow(3_600_000, { contextWindow: 65_536 })).toBe(65_536);
    expect(capInputTokensToContextWindow(1_200, { contextWindow: 65_536 })).toBe(1_200);
    expect(capInputTokensToContextWindow(3_600_000, {})).toBe(3_600_000);
  });
});
