import { describe, expect, it } from 'vitest';
import {
  aggregateDashboardCostWindows,
  isDashboardCostWindow,
  resolveDashboardCostWindow,
  startOfDashboardUtcDay,
  startOfDashboardUtcMonth,
  startOfDashboardUtcWeek,
} from './dashboard-cost-windows.js';

describe('dashboard cost window aggregation', () => {
  it('aggregates period-bounded totals for today/week/month windows', () => {
    const nowMs = Date.UTC(2026, 2, 18, 12, 0, 0, 0);
    const monthStartMs = startOfDashboardUtcMonth(nowMs);
    const weekStartMs = startOfDashboardUtcWeek(nowMs);
    const dayStartMs = startOfDashboardUtcDay(nowMs);

    const samples = [
      { timestampMs: nowMs - (1 * 60 * 60 * 1000), llmCalls: 2, toolCalls: 1, estimatedCostUsd: 0.2 },
      { timestampMs: nowMs - (2 * 24 * 60 * 60 * 1000), llmCalls: 1, toolCalls: 0, estimatedCostUsd: 0.3 },
      { timestampMs: nowMs - (10 * 24 * 60 * 60 * 1000), llmCalls: 4, toolCalls: 2, estimatedCostUsd: 0.4 },
      { timestampMs: nowMs - (40 * 24 * 60 * 60 * 1000), llmCalls: 9, toolCalls: 9, estimatedCostUsd: 0.9 },
    ];

    const expected = {
      today: { turns: 0, llmCalls: 0, toolCalls: 0, estimatedCostUsd: 0 },
      week: { turns: 0, llmCalls: 0, toolCalls: 0, estimatedCostUsd: 0 },
      month: { turns: 0, llmCalls: 0, toolCalls: 0, estimatedCostUsd: 0 },
    };

    for (const sample of samples) {
      if (sample.timestampMs < monthStartMs) continue;
      expected.month.turns += 1;
      expected.month.llmCalls += sample.llmCalls;
      expected.month.toolCalls += sample.toolCalls;
      expected.month.estimatedCostUsd += sample.estimatedCostUsd;

      if (sample.timestampMs >= weekStartMs) {
        expected.week.turns += 1;
        expected.week.llmCalls += sample.llmCalls;
        expected.week.toolCalls += sample.toolCalls;
        expected.week.estimatedCostUsd += sample.estimatedCostUsd;
      }

      if (sample.timestampMs >= dayStartMs) {
        expected.today.turns += 1;
        expected.today.llmCalls += sample.llmCalls;
        expected.today.toolCalls += sample.toolCalls;
        expected.today.estimatedCostUsd += sample.estimatedCostUsd;
      }
    }

    const totals = aggregateDashboardCostWindows(samples, nowMs);
    expect(totals).toEqual(expected);
  });

  it('fails closed when telemetry fields are invalid or missing', () => {
    const nowMs = Date.UTC(2026, 2, 18, 12, 0, 0, 0);
    const totals = aggregateDashboardCostWindows([
      { timestampMs: Number.NaN, llmCalls: 99, toolCalls: 99, estimatedCostUsd: 99 },
      { timestampMs: nowMs - 1000, llmCalls: -5, toolCalls: Number.NaN, estimatedCostUsd: -1 },
    ], nowMs);

    expect(totals.today).toEqual({
      turns: 1,
      llmCalls: 0,
      toolCalls: 0,
      estimatedCostUsd: 0,
    });
    expect(totals.week).toEqual(totals.today);
    expect(totals.month).toEqual(totals.today);
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
