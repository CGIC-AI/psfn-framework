import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyGatewayCapturedProviderCost,
  consumeActiveGatewayCapturedProviderCost,
  extractGatewayProviderCost,
  withGatewayLLMCostCapture,
} from './llm-cost-capture.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it('consumes provider evidence per physical attempt without reusing stale cost', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', {
        headers: {
          'content-type': 'application/json',
          'x-litellm-response-cost': '0.25',
        },
      }))
      .mockResolvedValueOnce(new Response('{}', {
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const captured = await withGatewayLLMCostCapture(async () => {
      await fetch('https://provider.test/attempt-1');
      expect(consumeActiveGatewayCapturedProviderCost()).toEqual({
        total: 0.25,
        currency: 'USD',
      });

      await fetch('https://provider.test/attempt-2');
      expect(consumeActiveGatewayCapturedProviderCost()).toBeUndefined();
      expect(consumeActiveGatewayCapturedProviderCost()).toBeUndefined();
      return {
        content: 'ok',
        toolCalls: [],
        model: 'test-model',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'stop',
      };
    });

    expect(captured.finalAttemptProviderCost).toBeUndefined();
    expect(applyGatewayCapturedProviderCost(
      captured.result,
      captured.finalAttemptProviderCost,
    ).usageDetails?.cost).toBeUndefined();
  });
});
