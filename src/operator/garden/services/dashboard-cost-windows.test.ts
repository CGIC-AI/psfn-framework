import { describe, expect, it } from 'vitest';
import type { ModelUsageTotals } from '../../../shared/telemetry/model-usage.js';
import {
  isDashboardCostWindow,
  mapModelUsageTotalsToDashboardUsage,
  resolveDashboardCostWindow,
  resolveDashboardCostWindowRange,
  startOfDashboardUtcDay,
  startOfDashboardUtcMonth,
  startOfDashboardUtcWeek,
} from './dashboard-cost-windows.js';

describe('dashboard durable model-usage windows', () => {
  it('resolves UTC today/week/month ranges with a half-open boundary after data-through', () => {
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

  it('validates and resolves supported dashboard cost windows', () => {
    expect(isDashboardCostWindow('today')).toBe(true);
    expect(isDashboardCostWindow('week')).toBe(true);
    expect(isDashboardCostWindow('month')).toBe(true);
    expect(isDashboardCostWindow('quarter')).toBe(false);
    expect(resolveDashboardCostWindow('week')).toBe('week');
    expect(resolveDashboardCostWindow('bogus')).toBe('today');
    expect(resolveDashboardCostWindow(undefined)).toBe('today');
  });
});
