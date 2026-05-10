import type {
  DashboardCostWindow,
  DashboardCostWindowTotals,
  DashboardCostWindowUsage,
} from '../types.js';

export const DASHBOARD_COST_WINDOWS: readonly DashboardCostWindow[] = ['today', 'week', 'month'];

export interface DashboardUsageSample {
  timestampMs: number;
  llmCalls: number;
  toolCalls: number;
  estimatedCostUsd: number;
}

const DAY_MS = 86_400_000;
const DASHBOARD_COST_WINDOW_SET = new Set<DashboardCostWindow>(DASHBOARD_COST_WINDOWS);

function emptyUsage(): DashboardCostWindowUsage {
  return {
    turns: 0,
    llmCalls: 0,
    toolCalls: 0,
    estimatedCostUsd: 0,
  };
}

function sanitizeCount(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function sanitizeCost(value: number): number {
  return Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function addUsage(target: DashboardCostWindowUsage, sample: DashboardUsageSample): void {
  target.turns += 1;
  target.llmCalls += sanitizeCount(sample.llmCalls);
  target.toolCalls += sanitizeCount(sample.toolCalls);
  target.estimatedCostUsd += sanitizeCost(sample.estimatedCostUsd);
}

export function createEmptyDashboardCostWindowTotals(): DashboardCostWindowTotals {
  return {
    today: emptyUsage(),
    week: emptyUsage(),
    month: emptyUsage(),
  };
}

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

export function aggregateDashboardCostWindows(
  samples: readonly DashboardUsageSample[],
  nowMs: number,
): DashboardCostWindowTotals {
  const totals = createEmptyDashboardCostWindowTotals();
  const monthStartMs = startOfDashboardUtcMonth(nowMs);
  const weekStartMs = startOfDashboardUtcWeek(nowMs);
  const dayStartMs = startOfDashboardUtcDay(nowMs);

  for (const sample of samples) {
    const timestampMs = Number.isFinite(sample.timestampMs) ? sample.timestampMs : Number.NaN;
    if (!Number.isFinite(timestampMs) || timestampMs < monthStartMs) {
      continue;
    }

    addUsage(totals.month, sample);
    if (timestampMs >= weekStartMs) {
      addUsage(totals.week, sample);
    }
    if (timestampMs >= dayStartMs) {
      addUsage(totals.today, sample);
    }
  }

  return totals;
}
