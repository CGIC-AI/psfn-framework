import { describe, expect, it, vi } from 'vitest';
import type { ModelUsageEventInput } from '../../shared/telemetry/model-usage.js';
import { withEmbeddingUsageAccounting } from './embedding-accounting.js';

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
    });

    await expect(accounted.embedBatch(['hello'])).resolves.toEqual([
      new Float32Array([1, 2]),
    ]);

    expect(events).toMatchObject([{
      attempt: 1,
      status: 'success',
      settlement: 'complete',
      provider: 'api',
      model: 'text-embedding-3-small',
      inputTokens: 8,
      cacheReadTokens: 2,
      totalTokens: 10,
      providerCost: { total: 0.001, currency: 'USD' },
      metadata: expect.objectContaining({ rawUsage: { prompt_tokens: 10 } }),
    }]);
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
