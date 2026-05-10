import type {
  DashboardCostWindow,
  DashboardCostWindowTotals,
  DashboardCostWindowUsage,
} from '$lib/types';

export const DASHBOARD_COST_WINDOWS: readonly DashboardCostWindow[] = ['today', 'week', 'month'];

export interface DashboardCostWindowOption {
  value: DashboardCostWindow;
  label: string;
}

const DASHBOARD_COST_WINDOW_SET = new Set<DashboardCostWindow>(DASHBOARD_COST_WINDOWS);

export const DASHBOARD_COST_WINDOW_OPTIONS: readonly DashboardCostWindowOption[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

export function isDashboardCostWindow(value: string): value is DashboardCostWindow {
  return DASHBOARD_COST_WINDOW_SET.has(value as DashboardCostWindow);
}

export function resolveDashboardCostWindow(value: string | null | undefined): DashboardCostWindow {
  if (!value) return 'today';
  return isDashboardCostWindow(value) ? value : 'today';
}

export function buildDashboardCostWindowPath(costWindow: DashboardCostWindow): string {
  return `/api/admin/dashboard?costWindow=${encodeURIComponent(costWindow)}`;
}

type DashboardCostWindowUsageInput = Partial<Record<keyof DashboardCostWindowUsage, unknown>> | null | undefined;
type DashboardCostWindowTotalsInput = Partial<Record<DashboardCostWindow, DashboardCostWindowUsageInput>> | null | undefined;

function asNonNegativeFiniteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

export function normalizeDashboardCostWindowUsage(
  usage: DashboardCostWindowUsageInput,
): DashboardCostWindowUsage {
  return {
    turns: asNonNegativeFiniteNumber(usage?.turns),
    llmCalls: asNonNegativeFiniteNumber(usage?.llmCalls),
    toolCalls: asNonNegativeFiniteNumber(usage?.toolCalls),
    estimatedCostUsd: asNonNegativeFiniteNumber(usage?.estimatedCostUsd),
  };
}

export function normalizeDashboardCostWindowTotals(
  byWindow: DashboardCostWindowTotalsInput,
): DashboardCostWindowTotals {
  return {
    today: normalizeDashboardCostWindowUsage(byWindow?.today),
    week: normalizeDashboardCostWindowUsage(byWindow?.week),
    month: normalizeDashboardCostWindowUsage(byWindow?.month),
  };
}

export function resolveSelectedDashboardCostWindowUsage(
  byWindow: DashboardCostWindowTotalsInput,
  selected: DashboardCostWindow,
): DashboardCostWindowUsage {
  return normalizeDashboardCostWindowTotals(byWindow)[selected];
}
