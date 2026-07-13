import { describe, expect, it } from 'vitest';
import { extractGatewayProviderCost } from './llm-cost-capture.js';

describe('extractGatewayProviderCost', () => {
  it('normalizes provider component economics when LiteLLM exposes them', () => {
    expect(extractGatewayProviderCost({
      usage: {
        cost: 0.95,
        cost_details: {
          prompt_cost: 0.4,
          completion_cost: 0.3,
          cache_read_cost: 0.05,
          cache_write_cost: 0.2,
        },
      },
    })).toEqual({
      input: 0.4,
      output: 0.3,
      cacheRead: 0.05,
      cacheWrite: 0.2,
      total: 0.95,
      currency: 'USD',
    });
  });

  it('keeps a provider-reported total explicitly unallocated', () => {
    expect(extractGatewayProviderCost({ usage: { cost: 0.25 } })).toEqual({
      total: 0.25,
      currency: 'USD',
    });
  });
});
