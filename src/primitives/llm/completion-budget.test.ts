import { describe, expect, it } from 'vitest';
import { resolveCompletionTokenBudget } from './completion-budget.js';

describe('resolveCompletionTokenBudget', () => {
  it('preserves a smaller request budget', () => {
    expect(resolveCompletionTokenBudget({
      requestedMaxTokens: 128,
      configuredMaxOutputTokens: 8192,
      capabilityMaxOutputTokens: 16_384,
    })).toBe(128);
  });

  it('bounds a large request by owner tuning and provider capability', () => {
    expect(resolveCompletionTokenBudget({
      requestedMaxTokens: 214_404,
      configuredMaxOutputTokens: 8192,
      capabilityMaxOutputTokens: 16_384,
    })).toBe(8192);
  });

  it('bounds stale owner tuning by the provider capability', () => {
    expect(resolveCompletionTokenBudget({
      configuredMaxOutputTokens: 214_404,
      capabilityMaxOutputTokens: 8192,
    })).toBe(8192);
  });

  it('uses the routed candidate as the ceiling when no owner metadata exists', () => {
    expect(resolveCompletionTokenBudget({
      requestedMaxTokens: 214_404,
      fallbackMaxTokens: 4096,
    })).toBe(4096);
  });

  it('keeps an absent budget absent', () => {
    expect(resolveCompletionTokenBudget({})).toBeUndefined();
  });
});
