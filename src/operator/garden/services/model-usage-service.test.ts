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
      telemetryVisibility: 'operator_visible',
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
  it('keeps private usage in aggregate totals while excluding every private detail surface', async () => {
    const aggregate = makeUsageData();
    aggregate.totals = {
      ...aggregate.totals,
      calls: 2,
      successfulCalls: 2,
      inputTokens: 1400,
      outputTokens: 700,
      totalTokens: 2100,
      providerCostUsd: 0.6,
      totalCostUsd: 0.6,
    };
    aggregate.byModel.push({
      key: 'litellm:private-model',
      calls: 1,
      inputTokens: 400,
      outputTokens: 200,
      totalTokens: 600,
      totalCostUsd: 0.5,
    });
    aggregate.byPurpose.push({
      key: 'companion_private.background',
      calls: 1,
      inputTokens: 400,
      outputTokens: 200,
      totalTokens: 600,
      totalCostUsd: 0.5,
    });
    const privateEvent = {
      ...aggregate.recentEvents[0]!,
      id: 'usage-private',
      logicalCallId: 'llm:private',
      telemetryVisibility: 'companion_private' as const,
      purpose: 'background',
      originStage: 'companion_private.background',
      model: 'private-model',
      requestedModel: 'private-model',
      providerCostUsd: 0.5,
      metadata: { privateOutcome: 'must-not-reach-garden' },
    };
    aggregate.recentEvents.push(privateEvent);
    aggregate.expensiveEvents.push(privateEvent);

    const visible = makeUsageData();
    const store: ModelUsageQueryPort = {
      getUsageData: vi.fn(async query => (
        query?.telemetryVisibility === 'operator_visible' ? visible : aggregate
      )),
    };
    const service = new AdminModelUsageDataService(store);

    const data = await service.getModelUsageData({ limit: 10 });

    expect(data.totals).toEqual(aggregate.totals);
    expect(data.byModel).toEqual(visible.byModel);
    expect(data.byPurpose).toEqual(visible.byPurpose);
    expect(data.byTool).toEqual(visible.byTool);
    expect(data.byCallKind).toEqual(visible.byCallKind);
    expect(data.recentEvents).toEqual(visible.recentEvents);
    expect(data.expensiveEvents).toEqual(visible.expensiveEvents);
    expect(JSON.stringify(data)).not.toContain('companion_private');
    expect(JSON.stringify(data)).not.toContain('must-not-reach-garden');
    expect(store.getUsageData).toHaveBeenCalledWith({ limit: 10, telemetryVisibility: 'operator_visible' });
  });

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
