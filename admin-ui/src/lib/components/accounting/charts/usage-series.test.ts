import { describe, expect, it } from 'vitest';
import type {
  ModelUsageDimensionTimeBucket,
  ModelUsageTimeBucket,
  ModelUsageTotals,
} from '../../../../../../src/shared/telemetry/model-usage.js';
import {
  buildTokenCompositionBuckets,
  buildUsageByModelChartData,
} from './usage-series';

const EMPTY_COST = {
  inputUsd: 0,
  inputKnownCalls: 0,
  outputUsd: 0,
  outputKnownCalls: 0,
  cacheReadUsd: 0,
  cacheReadKnownCalls: 0,
  cacheWriteUsd: 0,
  cacheWriteKnownCalls: 0,
  totalUsd: 0,
  totalKnownCalls: 0,
};

function totals(overrides: Partial<ModelUsageTotals> = {}): ModelUsageTotals {
  return {
    calls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    providerCostUsd: 0,
    estimatedCostUsd: 0,
    totalCostUsd: 0,
    providerCost: EMPTY_COST,
    estimatedCost: EMPTY_COST,
    effectiveCost: EMPTY_COST,
    totalDurationMs: 0,
    durationSamples: 0,
    totalTtftMs: 0,
    ttftSamples: 0,
    averageDurationMs: null,
    averageTtftMs: null,
    ...overrides,
  };
}

function timeBucket(
  startMs: number,
  overrides: Partial<ModelUsageTotals> = {},
): ModelUsageTimeBucket {
  return { startMs, endMs: startMs + 100, ...totals(overrides) };
}

function modelBucket(
  startMs: number,
  key: string,
  effectiveCostUsd: number,
): ModelUsageDimensionTimeBucket {
  return {
    key,
    startMs,
    endMs: startMs + 100,
    ...totals({
      calls: effectiveCostUsd * 10,
      totalTokens: effectiveCostUsd * 100,
      effectiveCost: { ...EMPTY_COST, totalUsd: effectiveCostUsd },
      totalCostUsd: effectiveCostUsd,
    }),
  };
}

describe('usage chart series transforms', () => {
  it('assembles a bucket-by-model matrix and merges models below the top five', () => {
    const chart = buildUsageByModelChartData(
      [timeBucket(100), timeBucket(200)],
      [
        modelBucket(100, 'provider-a:model-a', 6),
        modelBucket(100, 'provider-b:model-b', 5),
        modelBucket(100, 'provider-c:model-c', 4),
        modelBucket(100, 'provider-d:model-d', 3),
        modelBucket(100, 'provider-e:model-e', 2),
        modelBucket(100, 'provider-f:model-f', 0.5),
        modelBucket(200, 'provider-a:model-a', 2),
        modelBucket(200, 'provider-f:model-f', 0.5),
      ],
      'effectiveCost',
      5,
    );

    expect(chart.seriesKeys).toEqual([
      'provider-a:model-a',
      'provider-b:model-b',
      'provider-c:model-c',
      'provider-d:model-d',
      'provider-e:model-e',
      'Other',
    ]);
    expect(chart.buckets).toEqual([
      {
        startMs: 100,
        segments: [
          { key: 'provider-a:model-a', value: 6 },
          { key: 'provider-b:model-b', value: 5 },
          { key: 'provider-c:model-c', value: 4 },
          { key: 'provider-d:model-d', value: 3 },
          { key: 'provider-e:model-e', value: 2 },
          { key: 'Other', value: 0.5 },
        ],
      },
      {
        startMs: 200,
        segments: [
          { key: 'provider-a:model-a', value: 2 },
          { key: 'provider-b:model-b', value: 0 },
          { key: 'provider-c:model-c', value: 0 },
          { key: 'provider-d:model-d', value: 0 },
          { key: 'provider-e:model-e', value: 0 },
          { key: 'Other', value: 0.5 },
        ],
      },
    ]);
  });

  it('maps the existing tokens and requests metric semantics without inventing totals', () => {
    const rows = [modelBucket(100, 'provider-a:model-a', 2)];

    expect(buildUsageByModelChartData([timeBucket(100)], rows, 'totalTokens', 5)
      .buckets[0]?.segments[0]?.value).toBe(200);
    expect(buildUsageByModelChartData([timeBucket(100)], rows, 'calls', 5)
      .buckets[0]?.segments[0]?.value).toBe(20);
  });

  it('maps all four token components in stable semantic order', () => {
    expect(buildTokenCompositionBuckets([
      timeBucket(100, {
        inputTokens: 10,
        cacheReadTokens: 20,
        cacheWriteTokens: 30,
        outputTokens: 40,
        totalTokens: 100,
      }),
    ])).toEqual([{
      startMs: 100,
      segments: [
        { key: 'input', value: 10 },
        { key: 'cacheRead', value: 20 },
        { key: 'cacheWrite', value: 30 },
        { key: 'output', value: 40 },
      ],
    }]);
  });
});
