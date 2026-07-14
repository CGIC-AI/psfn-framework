import { describe, expect, it, vi } from 'vitest';
import type { ModelUsageData, ModelUsageQueryPort } from '../../../shared/telemetry/model-usage.js';
import { MODEL_USAGE_GROUP_DIMENSIONS } from '../../../shared/telemetry/model-usage-attribution.js';
import { AdminModelUsageDataService } from './model-usage-service.js';

function makeUsageData(): ModelUsageData {
  const attributionCoverage = {
    totalCalls: 1,
    byDimension: Object.fromEntries(MODEL_USAGE_GROUP_DIMENSIONS.map(dimension => [dimension, {
      knownCalls: 0,
      unknownCalls: 1,
      coveragePercent: 0,
    }])) as ModelUsageData['attributionCoverage']['byDimension'],
  };
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
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1500,
      totalCostUsd: 0,
    }],
    byPurpose: [{
      key: 'background',
      calls: 1,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1500,
      totalCostUsd: 0,
    }],
    byTool: [{
      key: 'unknown',
      calls: 1,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1500,
      totalCostUsd: 0,
    }],
    byCallKind: [{
      key: 'completion',
      calls: 1,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
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
      settlement: 'complete',
      callKind: 'completion',
      attribution: {
        companionId: 'unknown',
        sessionId: 'unknown',
        channelId: 'unknown',
        channelType: 'unknown',
        callType: 'background',
        purpose: 'background',
        originType: 'unknown',
        originStage: 'unknown',
        service: 'unknown',
        process: 'unknown',
        turnId: 'unknown',
        requestId: 'unknown',
        toolName: 'unknown',
        toolCallId: 'unknown',
        chargeLane: 'unknown',
        chargeSurface: 'unknown',
        chargeRunId: 'unknown',
        chargeRootRunId: 'unknown',
        chargeParentRunId: 'unknown',
        shardId: 'unknown',
        subagentId: 'unknown',
        conversationId: 'unknown',
        rootInitiationId: 'unknown',
        workloadType: 'unknown',
        workloadId: 'unknown',
      },
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
      providerCost: {},
      estimatedCost: {},
      effectiveCost: {},
      costSource: 'none',
      metadata: {},
    }],
    expensiveEvents: [],
    groupedBy: {},
    attributionCoverage,
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

  it('reconciles hydrated costs across requested channel and cost-source groups', async () => {
    const usage = makeUsageData();
    usage.query = { limit: 10, groupBy: ['channelId', 'costSource'] };
    usage.recentEvents[0]!.attribution.channelId = 'channel-1';
    const baseBreakdown = {
      calls: 1,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1500,
      totalCostUsd: 0,
    };
    usage.groupedBy = {
      channelId: [{ key: 'channel-1', ...baseBreakdown }],
      costSource: [{ key: 'none', ...baseBreakdown }],
    };
    const store: ModelUsageQueryPort = {
      getUsageData: vi.fn(async () => usage),
    };
    const discovery = {
      getAvailableModels: vi.fn(async () => [{
        id: 'openrouter/deepseek/deepseek-v4-pro',
        pricing: { prompt: '0.000002', completion: '0.000004' },
      }]),
      invalidateCache: vi.fn(),
    };

    const data = await new AdminModelUsageDataService(store, discovery)
      .getModelUsageData(usage.query);

    expect(data.groupedBy.channelId).toEqual([
      expect.objectContaining({ key: 'channel-1', calls: 1, totalCostUsd: 0.004 }),
    ]);
    expect(data.groupedBy.costSource).toEqual([
      expect.objectContaining({ key: 'estimate', calls: 1, totalCostUsd: 0.004 }),
    ]);
    expect(data.groupedBy.costSource?.some(entry => entry.key === 'none')).toBe(false);
    expect(data.groupedBy.channelId?.reduce((sum, entry) => sum + entry.totalCostUsd, 0))
      .toBeCloseTo(data.totals.totalCostUsd, 8);
    expect(data.groupedBy.costSource?.reduce((sum, entry) => sum + entry.totalCostUsd, 0))
      .toBeCloseTo(data.totals.totalCostUsd, 8);
  });
});
