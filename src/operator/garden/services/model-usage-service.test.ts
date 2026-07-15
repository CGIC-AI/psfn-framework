import { describe, expect, it, vi } from 'vitest';
import type {
  ModelUsageData,
  ModelUsageExportData,
  ModelUsageExportPort,
  ModelUsageQueryPort,
} from '../../../shared/telemetry/model-usage.js';
import { MODEL_USAGE_GROUP_DIMENSIONS } from '../../../shared/telemetry/model-usage-attribution.js';
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
    byModel: [], byPurpose: [], byTool: [], byCallKind: [], groupedBy: {},
    attributionCoverage: {
      totalCalls: 1,
      byDimension: Object.fromEntries(MODEL_USAGE_GROUP_DIMENSIONS.map(dimension => [dimension, {
        knownCalls: 0, unknownCalls: 1, coveragePercent: 0,
      }])) as ModelUsageData['attributionCoverage']['byDimension'],
    },
    recentEvents: [], expensiveEvents: [],
  };
}

describe('AdminModelUsageDataService', () => {
  it('returns the canonical persisted projection without repricing or reshaping it', async () => {
    const fixture = usageFixture();
    const store: ModelUsageQueryPort & ModelUsageExportPort = {
      getUsageData: vi.fn(async () => fixture),
      exportUsageEvents: vi.fn(),
    };
    const result = await new AdminModelUsageDataService(store).getModelUsageData(fixture.query);
    expect(result).toBe(fixture);
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
