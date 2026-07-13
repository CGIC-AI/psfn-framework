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
});
