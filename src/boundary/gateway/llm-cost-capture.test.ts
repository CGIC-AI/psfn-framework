import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyGatewayCapturedProviderCost,
  consumeActiveGatewayCapturedProviderCostEvidence,
  extractGatewayProviderCost,
  extractGatewayProviderCostEvidence,
  extractGatewayProviderCostEvidenceFromHeaders,
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
      expect(consumeActiveGatewayCapturedProviderCostEvidence()).toEqual({
        providerCost: { total: 0.25, currency: 'USD' },
        providerCostEvidence: {
          'header.x-litellm-response-cost': { total: 0.25, currency: 'USD' },
        },
      });

      await fetch('https://provider.test/attempt-2');
      expect(consumeActiveGatewayCapturedProviderCostEvidence()).toBeUndefined();
      expect(consumeActiveGatewayCapturedProviderCostEvidence()).toBeUndefined();
      return {
        content: 'ok',
        toolCalls: [],
        model: 'test-model',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'stop',
      };
    });

    expect(captured.finalAttemptProviderCostEvidence).toBeUndefined();
    expect(applyGatewayCapturedProviderCost(
      captured.result,
      captured.finalAttemptProviderCostEvidence,
    ).usageDetails?.cost).toBeUndefined();
  });

  it('quarantines contradictory header and JSON cost observations from one attempt', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      usage: { cost: 0.1 },
    }), {
      headers: {
        'content-type': 'application/json',
        'x-litellm-response-cost': '0.2',
      },
    })));

    const captured = await withGatewayLLMCostCapture(async () => {
      await fetch('https://provider.test/conflicting-cost');
      return 'done';
    });

    expect(captured.captures).toMatchObject([{
      providerCostEvidence: {
        'header.x-litellm-response-cost': { total: 0.2, currency: 'USD' },
        'jsonBody.usage.cost': { total: 0.1, currency: 'USD' },
      },
      providerCostEvidenceConflict: { fields: ['total'] },
    }]);
    expect(captured.captures[0]?.providerCost).toBeUndefined();
    expect(captured.finalAttemptProviderCostEvidence).toMatchObject({
      providerCostEvidenceConflict: { fields: ['total'] },
    });
  });

  it('quarantines contradictory totals within one JSON body without source precedence', () => {
    const evidence = extractGatewayProviderCostEvidence({
      usage: { cost: 0.1 },
      cost: 0.2,
    }, 'jsonBody');

    expect(evidence.providerCost).toBeUndefined();
    expect(evidence).toMatchObject({
      providerCostEvidence: {
        'jsonBody.usage.cost': { total: 0.1, currency: 'USD' },
        'jsonBody.cost': { total: 0.2, currency: 'USD' },
      },
      providerCostEvidenceConflict: { fields: ['total'] },
    });
  });

  it('marks malformed header and body cost observations as conflicts', () => {
    const headerEvidence = extractGatewayProviderCostEvidenceFromHeaders(
      new Headers({ 'x-litellm-response-cost': '-0.2' }),
    );
    const bodyEvidence = extractGatewayProviderCostEvidence({
      usage: { cost: 'not-money' },
    }, 'jsonBody');

    expect(headerEvidence).toMatchObject({
      providerCostEvidenceConflict: { fields: ['header.x-litellm-response-cost'] },
    });
    expect(bodyEvidence).toMatchObject({
      providerCostEvidenceConflict: { fields: ['jsonBody.usage.cost'] },
    });
  });

  it('retains repeated SSE cost observations and quarantines disagreement', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      'data: {"usage":{"cost":0.1}}',
      '',
      'data: {"usage":{"cost":0.2}}',
      '',
    ].join('\n'), {
      headers: { 'content-type': 'text/event-stream' },
    })));

    const captured = await withGatewayLLMCostCapture(async () => {
      const response = await fetch('https://provider.test/sse-cost');
      await response.text();
      return 'done';
    });

    expect(captured.captures).toMatchObject([{
      providerCostEvidence: {
        'sse[0].usage.cost': { total: 0.1, currency: 'USD' },
        'sse[1].usage.cost': { total: 0.2, currency: 'USD' },
      },
      providerCostEvidenceConflict: { fields: ['total'] },
    }]);
  });

  it('quarantines contradictory response and gateway-captured cost evidence', () => {
    const response = applyGatewayCapturedProviderCost({
      content: 'ok',
      toolCalls: [],
      model: 'test-model',
      inputTokens: 3,
      outputTokens: 2,
      usageDetails: {
        input: 3,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 5,
        cost: { total: 0.1, currency: 'USD' },
      },
      stopReason: 'stop',
    }, {
      providerCostEvidence: {
        gatewayCapture: { total: 0.2, currency: 'USD' },
      },
      providerCost: { total: 0.2, currency: 'USD' },
    });

    expect(response.usageDetails?.cost).toBeUndefined();
    expect(response.usageDetails?.raw).toMatchObject({
      providerCostEvidence: {
        responseUsage: { total: 0.1, currency: 'USD' },
        gatewayCapture: { total: 0.2, currency: 'USD' },
      },
      providerCostEvidenceConflict: {
        fields: ['total'],
      },
    });
  });

  it('quarantines a total contradicted by independently observed components', () => {
    const response = applyGatewayCapturedProviderCost({
      content: 'ok',
      toolCalls: [],
      model: 'test-model',
      inputTokens: 3,
      outputTokens: 2,
      usageDetails: {
        input: 3,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 5,
        cost: { total: 0.1, currency: 'USD' },
      },
      stopReason: 'stop',
    }, {
      providerCostEvidence: {
        gatewayCapture: {
          input: 0.08,
          output: 0.08,
          currency: 'USD',
        },
      },
      providerCost: {
        input: 0.08,
        output: 0.08,
        currency: 'USD',
      },
    });

    expect(response.usageDetails?.cost).toBeUndefined();
    expect(response.usageDetails?.raw).toMatchObject({
      providerCostEvidenceConflict: { fields: ['total'] },
    });
  });
});
