import type {
  DashboardCostWindow,
  DashboardStats,
} from '../../types.js';
import type { GardenRequestContext } from '../../garden-request-context.js';

export interface AdminDashboardData {
  stats: DashboardStats;
}

export interface AdminDashboardService {
  getDashboardData(
    options?: { costWindow?: DashboardCostWindow },
    context?: GardenRequestContext,
  ): Promise<AdminDashboardData>;
}
