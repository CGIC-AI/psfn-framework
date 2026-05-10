import { apiGet } from '$lib/api/client';
import { buildDashboardCostWindowPath } from '$lib/dashboard/cost-window';
import type { AdminDashboardData, DashboardCostWindow } from '$lib/types';

export function getDashboard(costWindow: DashboardCostWindow = 'today'): Promise<AdminDashboardData> {
  return apiGet<AdminDashboardData>(buildDashboardCostWindowPath(costWindow));
}
