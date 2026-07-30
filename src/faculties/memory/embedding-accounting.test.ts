import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelUsageEventInput } from '../../shared/telemetry/model-usage.js';
import { withEmbeddingUsageAccounting } from './embedding-accounting.js';
import { ApiEmbeddingProvider } from './embedding.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('withEmbeddingUsageAccounting', () => {
  it('records provider usage once for direct non-gateway embedding callers', async () => {
    const events: ModelUsageEventInput[] = [];
    const provider = {
      kind: 'api' as const,
      model: 'text-embedding-3-small',
      dims: 2,
      embed: vi.fn(),
      embedBatch: vi.fn(),
      embedBatchWithUsage: vi.fn(async () => ({
        embeddings: [new Float32Array([1, 2])],
        usageDetails: {
          input: 8,
          output: 0,
          cacheRead: 2,
          cacheWrite: 0,
          totalTokens: 10,
          cost: { total: 0.001, currency: 'USD' },
          raw: { prompt_tokens: 10 },
        },
      })),
    };
    const accounted = withEmbeddingUsageAccounting(provider, {
      async recordUsageEvent(event) {
        events.push(event);
      },
    }, { companionId: 'companion-a' });

    await expect(runWithRequestContext({
      sessionId: 'session-1',
      channelId: 'channel-1',
      channelType: 'discord',
      callType: 'chat',
      originType: 'chat',
      conversationId: 'conversation-1',
      rootInitiationId: 'root-1',
      chargeLane: 'interactive',
      chargeSurface: 'externalModelConsult',
      chargeEventId: 'charge-event-1',
      chargeRunId: 'charge-run-1',
      chargeRootRunId: 'charge-root-1',
      chargeParentRunId: 'charge-parent-1',
    }, async () => await accounted.embedBatch(['hello']))).resolves.toEqual([
      new Float32Array([1, 2]),
    ]);

    expect(events).toMatchObject([{
      attempt: 1,
      status: 'success',
      settlement: 'complete',
      attribution: {
        companionId: 'companion-a',
        sessionId: 'session-1',
        channelId: 'channel-1',
        channelType: 'discord',
        callType: 'memory',
        purpose: 'embedding',
        originType: 'chat',
        conversationId: 'conversation-1',
        rootInitiationId: 'root-1',
      },
      provider: 'api',
      model: 'text-embedding-3-small',
      inputTokens: 8,
      cacheReadTokens: 2,
      totalTokens: 10,
      providerCost: { total: 0.001, currency: 'USD' },
      metadata: expect.objectContaining({ rawUsage: { prompt_tokens: 10 } }),
    }]);
    for (const field of [
      'chargeLane',
      'chargeSurface',
      'chargeEventId',
      'chargeRunId',
      'chargeRootRunId',
      'chargeParentRunId',
    ]) {
      expect(events[0]?.attribution).not.toHaveProperty(field);
    }
    expect(provider.embedBatchWithUsage).toHaveBeenCalledTimes(1);
    expect(provider.embedBatch).not.toHaveBeenCalled();
  });

  it('records a failed physical embedding attempt before rethrowing', async () => {
    const events: ModelUsageEventInput[] = [];
    const provider = {
      kind: 'ollama' as const,
      model: 'nomic-embed-text',
      dims: 2,
      embed: vi.fn(),
      embedBatch: vi.fn(async () => {
        throw new Error('provider unavailable');
      }),
    };
    const accounted = withEmbeddingUsageAccounting(provider, {
      async recordUsageEvent(event) {
        events.push(event);
      },
    });

    await expect(accounted.embedBatch(['hello'])).rejects.toThrow('provider unavailable');
    expect(events).toMatchObject([{
      attempt: 1,
      status: 'failure',
      settlement: 'unknown',
      provider: 'ollama',
      errorMessage: 'provider unavailable',
    }]);
  });

  it('settles known usage and cost when a billable embedding response has an invalid vector count', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 2] }],
      usage: {
        prompt_tokens: 9,
        total_tokens: 9,
        cost: { total: 0.25, currency: 'USD' },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const events: ModelUsageEventInput[] = [];
    const provider = new ApiEmbeddingProvider({
      endpoint: 'https://embeddings.example/v1/embeddings',
      model: 'text-embedding-3-small',
      dims: 2,
    });
    const accounted = withEmbeddingUsageAccounting(provider, {
      async recordUsageEvent(event) {
        events.push(event);
      },
    });

    await expect(accounted.embedBatch(['first', 'second']))
      .rejects.toThrow('response count mismatch: expected 2, got 1');

    expect(events).toMatchObject([{
      attempt: 1,
      status: 'failure',
      settlement: 'complete',
      inputTokens: 9,
      totalTokens: 9,
      providerCost: { total: 0.25, currency: 'USD' },
      effectiveCost: { total: 0.25, currency: 'USD' },
      providerCostUsd: 0.25,
      effectiveCostUsd: 0.25,
      costSource: 'provider',
      errorMessage: 'api embedding response count mismatch: expected 2, got 1',
      metadata: expect.objectContaining({
        rawUsage: expect.objectContaining({
          providerCostEvidence: expect.objectContaining({
            bodyUsage: { total: 0.25, currency: 'USD' },
          }),
        }),
      }),
    }]);
  });

  it('settles known usage and cost when billable embedding vectors are malformed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 'not-a-number'] }],
      usage: {
        prompt_tokens: 6,
        total_tokens: 6,
        cost: { total: 0.15, currency: 'USD' },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const events: ModelUsageEventInput[] = [];
    const accounted = withEmbeddingUsageAccounting(new ApiEmbeddingProvider({
      endpoint: 'https://embeddings.example/v1/embeddings',
      model: 'text-embedding-3-small',
      dims: 2,
    }), {
      async recordUsageEvent(event) {
        events.push(event);
      },
    });

    await expect(accounted.embedBatch(['first']))
      .rejects.toThrow('invalid embedding vectors');

    expect(events).toMatchObject([{
      status: 'failure',
      settlement: 'complete',
      inputTokens: 6,
      totalTokens: 6,
      providerCostUsd: 0.15,
      effectiveCostUsd: 0.15,
      costSource: 'provider',
    }]);
  });

  it('marks known embedding usage with quarantined cost evidence as partially settled', async () => {
    const events: ModelUsageEventInput[] = [];
    const provider = {
      kind: 'api' as const,
      model: 'text-embedding-3-small',
      dims: 2,
      embed: vi.fn(),
      embedBatch: vi.fn(),
      embedBatchWithUsage: vi.fn(async () => ({
        embeddings: [new Float32Array([1, 2])],
        usageDetails: {
          input: 9,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 9,
          raw: {
            providerCostEvidence: {
              bodyUsage: { total: 0.1, currency: 'USD' },
              headers: { total: 0.2, currency: 'USD' },
            },
            providerCostEvidenceConflict: { fields: ['total'] },
          },
        },
      })),
    };
    const accounted = withEmbeddingUsageAccounting(provider, {
      async recordUsageEvent(event) {
        events.push(event);
      },
    });

    await expect(accounted.embedBatch(['first'])).resolves.toHaveLength(1);
    expect(events).toMatchObject([{
      status: 'success',
      settlement: 'partial',
      inputTokens: 9,
      metadata: expect.objectContaining({
        rawUsage: expect.objectContaining({
          providerCostEvidenceConflict: { fields: ['total'] },
        }),
      }),
    }]);
  });

  it('records an estimate from canonical rates when provider cost is absent', async () => {
    const events: ModelUsageEventInput[] = [];
    const provider = {
      kind: 'api' as const,
      model: 'text-embedding-3-small',
      dims: 2,
      embed: vi.fn(),
      embedBatch: vi.fn(),
      embedBatchWithUsage: vi.fn(async () => ({
        embeddings: [new Float32Array([1, 2])],
        usageDetails: {
          input: 1_000,
          output: 0,
          cacheRead: 500,
          cacheWrite: 0,
          totalTokens: 1_500,
        },
      })),
    };
    const accounted = withEmbeddingUsageAccounting(provider, {
      async recordUsageEvent(event) {
        events.push(event);
      },
    }, {
      estimatedRates: {
        inputPer1MUsd: 2,
        cacheReadPer1MUsd: 0.2,
        currency: 'USD',
      },
    });

    await accounted.embedBatch(['hello']);

    expect(events).toMatchObject([{
      inputTokens: 1_000,
      cacheReadTokens: 500,
      totalTokens: 1_500,
      estimatedCost: {
        input: 0.002,
        output: 0,
        cacheRead: 0.0001,
        cacheWrite: 0,
        total: 0.0021,
        currency: 'USD',
      },
      effectiveCost: {
        total: 0.0021,
      },
      estimatedCostUsd: 0.0021,
      effectiveCostUsd: 0.0021,
      costSource: 'estimate',
      currency: 'USD',
    }]);
  });

  it('does not fabricate an embedding total without an exact canonical rate match', async () => {
    const events: ModelUsageEventInput[] = [];
    const provider = {
      kind: 'api' as const,
      model: 'unpriced-embedding',
      dims: 2,
      embed: vi.fn(),
      embedBatch: vi.fn(),
      embedBatchWithUsage: vi.fn(async () => ({
        embeddings: [new Float32Array([1, 2])],
        usageDetails: {
          input: 10,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 10,
        },
      })),
    };
    const accounted = withEmbeddingUsageAccounting(provider, {
      async recordUsageEvent(event) {
        events.push(event);
      },
    });

    await accounted.embedBatch(['hello']);

    expect(events[0]?.estimatedCostUsd).toBeUndefined();
    expect(events[0]?.effectiveCostUsd).toBeUndefined();
    expect(events[0]?.effectiveCost).toEqual({});
    expect(events[0]?.costSource).toBe('none');
  });
});
