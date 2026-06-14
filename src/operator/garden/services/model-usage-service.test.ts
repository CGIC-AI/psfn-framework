import { describe, expect, it, vi } from 'vitest';
import type { ModelUsageData, ModelUsageQueryPort } from '../../../shared/telemetry/model-usage.js';
import { AdminModelUsageDataService } from './model-usage-service.js';

function makeUsageData(): ModelUsageData {
  return {
    query: { limit: 10 },
    totals: {
      calls: 1,
      successfulCalls: 1,
      failedCalls: 0,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1500,
      providerCostUsd: 0,
      estimatedCostUsd: 0,
      totalCostUsd: 0,
      averageDurationMs: null,
      averageTtftMs: null,
    },
    byModel: [{
      key: 'litellm:deepseek/deepseek-v4-pro',
      calls: 1,
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      totalCostUsd: 0,
    }],
    byPurpose: [{
      key: 'background',
      calls: 1,
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      totalCostUsd: 0,
    }],
    byTool: [{
      key: '(none)',
      calls: 1,
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      totalCostUsd: 0,
    }],
    byCallKind: [{
      key: 'completion',
      calls: 1,
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      totalCostUsd: 0,
    }],
    recentEvents: [{
      id: 'usage-1',
      logicalCallId: 'llm:1',
      attempt: 1,
      recordedAtMs: 1,
      startedAtMs: 1,
      dayKey: '2026-06-14',
      monthKey: '2026-06',
      status: 'success',
      callKind: 'completion',
      callType: 'background',
      purpose: 'background',
      provider: 'litellm',
      model: 'deepseek/deepseek-v4-pro',
      requestedProvider: 'litellm',
      requestedModel: 'deepseek/deepseek-v4-pro',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1500,
      estimatedCostUsd: 0,
      costSource: 'none',
      metadata: {},
    }],
    expensiveEvents: [],
  };
}

describe('AdminModelUsageDataService', () => {
  it('hydrates missing usage costs from discovery pricing', async () => {
    const store: ModelUsageQueryPort = {
      getUsageData: vi.fn(async () => makeUsageData()),
    };
    const discovery = {
      getAvailableModels: vi.fn(async () => [{
        id: 'openrouter/deepseek/deepseek-v4-pro',
        pricing: {
          prompt: '0.000002',
          completion: '0.000004',
        },
      }]),
      invalidateCache: vi.fn(),
    };

    const service = new AdminModelUsageDataService(store, discovery);
    const data = await service.getModelUsageData({ limit: 10 });

    expect(data.recentEvents[0]).toMatchObject({
      estimatedCostUsd: 0.004,
      costSource: 'estimate',
      metadata: {
        costHydration: {
          source: 'model_discovery',
          modelId: 'openrouter/deepseek/deepseek-v4-pro',
        },
      },
    });
    expect(data.recentEvents[0]?.providerCostUsd).toBeUndefined();
    expect(data.totals.estimatedCostUsd).toBeCloseTo(0.004, 8);
    expect(data.totals.totalCostUsd).toBeCloseTo(0.004, 8);
    expect(data.byModel[0]?.totalCostUsd).toBeCloseTo(0.004, 8);
  });

  it('hydrates aggregate model totals when historical rows are outside the recent event window', async () => {
    const historical = makeUsageData();
    historical.recentEvents = [];
    historical.expensiveEvents = [];
    const store: ModelUsageQueryPort = {
      getUsageData: vi.fn(async () => historical),
    };
    const discovery = {
      getAvailableModels: vi.fn(async () => [{
        id: 'openrouter/deepseek/deepseek-v4-pro',
        pricing: {
          prompt: '0.000002',
          completion: '0.000004',
        },
      }]),
      invalidateCache: vi.fn(),
    };

    const service = new AdminModelUsageDataService(store, discovery);
    const data = await service.getModelUsageData({ limit: 10 });

    expect(data.recentEvents).toEqual([]);
    expect(data.byModel[0]).toMatchObject({
      key: 'litellm:deepseek/deepseek-v4-pro',
      totalCostUsd: 0.004,
    });
    expect(data.totals.estimatedCostUsd).toBeCloseTo(0.004, 8);
    expect(data.totals.totalCostUsd).toBeCloseTo(0.004, 8);
  });
});
