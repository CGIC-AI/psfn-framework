import { apiGet } from '$lib/api/client';
import type { AdminDashboardData } from '$lib/types';

export function getDashboard(): Promise<AdminDashboardData> {
  return apiGet<AdminDashboardData>('/api/admin/dashboard');
}
