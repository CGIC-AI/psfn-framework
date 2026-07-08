import type {
  DashboardCostWindow,
  DashboardStats,
} from '../../types.js';

export interface AdminDashboardData {
  stats: DashboardStats;
}

export interface AdminDashboardService {
  getDashboardData(options?: { costWindow?: DashboardCostWindow }): Promise<AdminDashboardData>;
}
