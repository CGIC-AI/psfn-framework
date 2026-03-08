import { apiGet } from '$lib/api/client';
import { buildDashboardCostWindowPath, type DashboardCostWindow } from '$lib/dashboard/cost-window';
import type { AdminDashboardData } from '$lib/types';

export function getDashboard(costWindow: DashboardCostWindow = 'today'): Promise<AdminDashboardData> {
  return apiGet<AdminDashboardData>(buildDashboardCostWindowPath(costWindow));
}
