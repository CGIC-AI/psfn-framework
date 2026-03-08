export const DASHBOARD_COST_WINDOWS = ['today', 'week', 'month'] as const;
export type DashboardCostWindow = typeof DASHBOARD_COST_WINDOWS[number];

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
