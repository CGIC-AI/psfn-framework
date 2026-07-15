import { describe, expect, it, vi } from 'vitest';
import type {
  ModelUsageData,
  ModelUsageEvent,
  ModelUsageExportData,
  ModelUsageExportPort,
  ModelUsageQueryPort,
} from '../../../shared/telemetry/model-usage.js';
import {
  MODEL_USAGE_GROUP_DIMENSIONS,
  normalizeModelUsageAttribution,
} from '../../../shared/telemetry/model-usage-attribution.js';
import { AdminModelUsageDataService } from './model-usage-service.js';

function usageFixture(): ModelUsageData {
  const emptyCost = {
    inputUsd: 0, inputKnownCalls: 0, outputUsd: 0, outputKnownCalls: 0,
    cacheReadUsd: 0, cacheReadKnownCalls: 0, cacheWriteUsd: 0, cacheWriteKnownCalls: 0,
    totalUsd: 0, totalKnownCalls: 0,
  };
  const totals = {
    calls: 1, successfulCalls: 1, failedCalls: 0, inputTokens: 10, outputTokens: 5,
    cacheReadTokens: 3, cacheWriteTokens: 2, totalTokens: 20,
    providerCostUsd: 0, estimatedCostUsd: 0, totalCostUsd: 0,
    providerCost: emptyCost, estimatedCost: emptyCost, effectiveCost: emptyCost,
    totalDurationMs: 100, durationSamples: 1, totalTtftMs: 20, ttftSamples: 1,
    averageDurationMs: 100, averageTtftMs: 20,
  };
  const recentEvent: ModelUsageEvent = {
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
    telemetryVisibility: 'operator_visible',
    attribution: normalizeModelUsageAttribution({
      companionId: 'companion-a',
      sessionId: 'session-a',
      channelId: 'channel-a',
      channelType: 'api',
      callType: 'background',
      purpose: 'background',
    }),
    provider: 'litellm',
    model: 'deepseek/deepseek-v4-pro',
    requestedProvider: 'litellm',
    requestedModel: 'deepseek/deepseek-v4-pro',
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1500,
    providerCost: {},
    estimatedCost: {},
    effectiveCost: {},
    costSource: 'none',
    metadata: {},
  };
  return {
    query: { range: 'custom', sinceMs: 1, untilMs: 2 },
    resolvedRange: {
      range: 'custom', timezone: 'UTC', sinceMs: 1, untilMs: 2, bucket: 'hour',
      boundary: '[sinceMs, untilMs)', calendarWeekStartsOn: 'monday',
    },
    totals,
    timeSeries: [{ startMs: 1, endMs: 2, ...totals }],
    groups: [],
    eventPage: { order: 'recent', items: [], nextCursor: null, hasMore: false },
    byModel: [{
      key: 'litellm:deepseek/deepseek-v4-pro',
      calls: 1, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 1500, totalCostUsd: 0,
    }],
    byPurpose: [{
      key: 'background',
      calls: 1, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 1500, totalCostUsd: 0,
    }],
    byTool: [{
      key: '(none)',
      calls: 1, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 1500, totalCostUsd: 0,
    }],
    byCallKind: [{
      key: 'completion',
      calls: 1, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 1500, totalCostUsd: 0,
    }],
    groupedBy: {},
    attributionCoverage: {
      totalCalls: 1,
      byDimension: Object.fromEntries(MODEL_USAGE_GROUP_DIMENSIONS.map(dimension => [dimension, {
        knownCalls: 0, unknownCalls: 1, coveragePercent: 0,
      }])) as ModelUsageData['attributionCoverage']['byDimension'],
    },
    recentEvents: [recentEvent],
    expensiveEvents: [],
  };
}

describe('AdminModelUsageDataService', () => {
  it('keeps private usage in aggregate totals while excluding every private detail surface', async () => {
    const aggregate = usageFixture();
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
      calls: 1, inputTokens: 400, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 600, totalCostUsd: 0.5,
    });
    aggregate.byPurpose.push({
      key: 'companion_private.background',
      calls: 1, inputTokens: 400, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 600, totalCostUsd: 0.5,
    });
    const privateEvent: ModelUsageEvent = {
      ...aggregate.recentEvents[0]!,
      id: 'usage-private',
      logicalCallId: 'llm:private',
      telemetryVisibility: 'companion_private',
      attribution: {
        ...aggregate.recentEvents[0]!.attribution,
        originStage: 'companion_private.background',
      },
      model: 'private-model',
      requestedModel: 'private-model',
      providerCostUsd: 0.5,
      metadata: { privateOutcome: 'must-not-reach-garden' },
    };
    aggregate.recentEvents.push(privateEvent);
    aggregate.expensiveEvents.push(privateEvent);

    const visible = usageFixture();
    const store: ModelUsageQueryPort = {
      getUsageData: vi.fn(async query => (
        query?.telemetryVisibility === 'operator_visible' ? visible : aggregate
      )),
    };
    const service = new AdminModelUsageDataService(store as ModelUsageQueryPort & ModelUsageExportPort);

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

  it('returns the canonical persisted projection without repricing or reshaping it', async () => {
    const fixture = usageFixture();
    const store: ModelUsageQueryPort & ModelUsageExportPort = {
      getUsageData: vi.fn(async () => fixture),
      exportUsageEvents: vi.fn(),
    };
    const result = await new AdminModelUsageDataService(store).getModelUsageData(fixture.query);
    // The operator projection is privacy-filtered (a fresh object), but with no
    // private events it must remain structurally identical to the ledger slice —
    // no query-time repricing or reshaping.
    expect(result).toEqual(fixture);
    expect(result.timeSeries[0]?.totalCostUsd).toBe(result.totals.totalCostUsd);
  });

  it('serializes exports returned by the same canonical store query', async () => {
    const fixture = usageFixture();
    const exportData: ModelUsageExportData = {
      query: fixture.query,
      resolvedRange: fixture.resolvedRange,
      rows: [],
    };
    const store: ModelUsageQueryPort & ModelUsageExportPort = {
      getUsageData: vi.fn(),
      exportUsageEvents: vi.fn(async () => exportData),
    };
    const result = await new AdminModelUsageDataService(store)
      .exportModelUsageData(fixture.query, 'json');
    expect(JSON.parse(result.body)).toEqual(exportData);
    expect(store.exportUsageEvents).toHaveBeenCalledWith(fixture.query);
  });
});
