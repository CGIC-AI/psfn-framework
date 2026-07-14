import type {
  DashboardCostWindow,
} from '$lib/types';

export const DASHBOARD_COST_WINDOWS: readonly DashboardCostWindow[] = ['today', 'week', 'month'];
export const DASHBOARD_MODEL_USAGE_POLL_INTERVAL_MS = 15_000;

export interface DashboardCostWindowOption {
  value: DashboardCostWindow;
  label: string;
}

export interface DashboardCostWindowSelection {
  committed: DashboardCostWindow;
  pending: DashboardCostWindow | null;
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

export function createDashboardCostWindowSelection(
  committed: DashboardCostWindow,
): DashboardCostWindowSelection {
  return { committed, pending: null };
}

export function beginDashboardCostWindowSelection(
  selection: DashboardCostWindowSelection,
  pending: DashboardCostWindow,
): DashboardCostWindowSelection {
  return pending === selection.committed
    ? { committed: selection.committed, pending: null }
    : { committed: selection.committed, pending };
}

export function commitDashboardCostWindowSelection(
  _selection: DashboardCostWindowSelection,
  committed: DashboardCostWindow,
): DashboardCostWindowSelection {
  return { committed, pending: null };
}

export function rejectDashboardCostWindowSelection(
  selection: DashboardCostWindowSelection,
): DashboardCostWindowSelection {
  return { committed: selection.committed, pending: null };
}

export function shouldPublishDashboardResponse(requestId: number, latestRequestId: number): boolean {
  return requestId === latestRequestId;
}
