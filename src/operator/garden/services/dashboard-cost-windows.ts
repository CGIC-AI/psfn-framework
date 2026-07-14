import type {
  DashboardCostWindow,
  DashboardCostWindowUsage,
} from '../types.js';
import type { ModelUsageTotals } from '../../../shared/telemetry/model-usage.js';

export const DASHBOARD_COST_WINDOWS: readonly DashboardCostWindow[] = ['today', 'week', 'month'];
export const DASHBOARD_MODEL_USAGE_REFRESH_INTERVAL_MS = 15_000;

const DAY_MS = 86_400_000;
const DASHBOARD_COST_WINDOW_SET = new Set<DashboardCostWindow>(DASHBOARD_COST_WINDOWS);

export function isDashboardCostWindow(value: string): value is DashboardCostWindow {
  return DASHBOARD_COST_WINDOW_SET.has(value as DashboardCostWindow);
}

export function resolveDashboardCostWindow(value: string | null | undefined): DashboardCostWindow {
  if (!value) return 'today';
  return isDashboardCostWindow(value) ? value : 'today';
}

export function startOfDashboardUtcDay(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export function startOfDashboardUtcWeek(nowMs: number): number {
  const dayStartMs = startOfDashboardUtcDay(nowMs);
  const weekday = new Date(nowMs).getUTCDay();
  // Monday is the start of the week.
  const dayOffset = (weekday + 6) % 7;
  return dayStartMs - (dayOffset * DAY_MS);
}

export function startOfDashboardUtcMonth(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

export function resolveDashboardCostWindowRange(
  window: DashboardCostWindow,
  nowMs: number,
): { sinceMs: number; untilMs: number } {
  switch (window) {
    case 'today':
      return { sinceMs: startOfDashboardUtcDay(nowMs), untilMs: nowMs + 1 };
    case 'week':
      return { sinceMs: startOfDashboardUtcWeek(nowMs), untilMs: nowMs + 1 };
    case 'month':
      return { sinceMs: startOfDashboardUtcMonth(nowMs), untilMs: nowMs + 1 };
  }
}

export function mapModelUsageTotalsToDashboardUsage(
  totals: ModelUsageTotals,
): DashboardCostWindowUsage {
  return {
    calls: totals.calls,
    successfulCalls: totals.successfulCalls,
    failedCalls: totals.failedCalls,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    totalTokens: totals.totalTokens,
    providerCostUsd: totals.providerCostUsd,
    estimatedCostUsd: totals.estimatedCostUsd,
    effectiveCostUsd: totals.totalCostUsd,
  };
}
