import { apiGet } from '../client';
import type { AdminDashboardData } from '$lib/types';

export function getDashboard(): Promise<AdminDashboardData> {
  return apiGet('/api/admin/dashboard');
}
