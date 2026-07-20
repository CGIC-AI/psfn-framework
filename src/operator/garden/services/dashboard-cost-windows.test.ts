import { describe, expect, it } from 'vitest';
import type {
  ModelUsageTimeBucket,
  ModelUsageTotals,
} from '../../../shared/telemetry/model-usage.js';
import {
  isDashboardCostWindow,
  mapModelUsageTimeSeriesToDashboardSparkline,
  mapModelUsageTotalsToDashboardUsage,
  resolveDashboardCostWindowBucket,
  resolveDashboardCostWindow,
  resolveDashboardCostWindowRange,
  startOfDashboardUtcDay,
  startOfDashboardUtcMonth,
  startOfDashboardUtcQuarter,
  startOfDashboardUtcWeek,
} from './dashboard-cost-windows.js';

describe('dashboard durable model-usage windows', () => {
  it('resolves UTC today/week/month/quarter ranges with a half-open boundary after data-through', () => {
    const nowMs = Date.UTC(2026, 2, 18, 12, 34, 56, 789);

    expect(resolveDashboardCostWindowRange('today', nowMs)).toEqual({
      sinceMs: startOfDashboardUtcDay(nowMs),
      untilMs: nowMs + 1,
    });
    expect(resolveDashboardCostWindowRange('week', nowMs)).toEqual({
      sinceMs: startOfDashboardUtcWeek(nowMs),
      untilMs: nowMs + 1,
    });
    expect(resolveDashboardCostWindowRange('month', nowMs)).toEqual({
      sinceMs: startOfDashboardUtcMonth(nowMs),
      untilMs: nowMs + 1,
    });
    expect(resolveDashboardCostWindowRange('quarter', nowMs)).toEqual({
      sinceMs: startOfDashboardUtcQuarter(nowMs),
      untilMs: nowMs + 1,
    });
    expect(startOfDashboardUtcQuarter(nowMs)).toBe(Date.UTC(2026, 0, 1));
  });

  it.each([
    ['today', 'hour'],
    ['week', 'day'],
    ['month', 'day'],
    ['quarter', 'week'],
  ] as const)('uses compact %s dashboard sparkline buckets', (window, bucket) => {
    expect(resolveDashboardCostWindowBucket(window)).toBe(bucket);
  });

  it('maps the canonical query totals without dropping cache or cost evidence', () => {
    const totals: ModelUsageTotals = {
      calls: 4,
      successfulCalls: 3,
      failedCalls: 1,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 30,
      cacheWriteTokens: 20,
      totalTokens: 190,
      providerCostUsd: 0.11,
      estimatedCostUsd: 0.13,
      totalCostUsd: 0.12,
      averageDurationMs: 250,
      averageTtftMs: 75,
    };

    expect(mapModelUsageTotalsToDashboardUsage(totals)).toEqual({
      calls: 4,
      successfulCalls: 3,
      failedCalls: 1,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 30,
      cacheWriteTokens: 20,
      totalTokens: 190,
      providerCostUsd: 0.11,
      estimatedCostUsd: 0.13,
      effectiveCostUsd: 0.12,
    });
  });

  it('projects aggregate time buckets into a compact sparse-safe sparkline', () => {
    const totals: ModelUsageTotals = {
      calls: 1,
      successfulCalls: 1,
      failedCalls: 0,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 30,
      cacheWriteTokens: 20,
      totalTokens: 190,
      providerCostUsd: 0.11,
      estimatedCostUsd: 0.13,
      totalCostUsd: 0.12,
      averageDurationMs: 250,
      averageTtftMs: 75,
    };
    const timeSeries = [
      { ...totals, startMs: 100, endMs: 200, totalTokens: 0, totalCostUsd: 0 },
      { ...totals, startMs: 200, endMs: 300 },
    ] as ModelUsageTimeBucket[];

    expect(mapModelUsageTimeSeriesToDashboardSparkline(timeSeries)).toEqual([
      { startMs: 100, totalTokens: 0, effectiveCostUsd: 0 },
      { startMs: 200, totalTokens: 190, effectiveCostUsd: 0.12 },
    ]);
  });

  it('validates and resolves supported dashboard cost windows', () => {
    expect(isDashboardCostWindow('today')).toBe(true);
    expect(isDashboardCostWindow('week')).toBe(true);
    expect(isDashboardCostWindow('month')).toBe(true);
    expect(isDashboardCostWindow('quarter')).toBe(true);
    expect(resolveDashboardCostWindow('quarter')).toBe('quarter');
    expect(resolveDashboardCostWindow('week')).toBe('week');
    expect(resolveDashboardCostWindow('bogus')).toBe('today');
    expect(resolveDashboardCostWindow(undefined)).toBe('today');
  });
});
