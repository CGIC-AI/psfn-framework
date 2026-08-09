import type { AdminDashboardData } from '$lib/types';

export type DashboardTool = AdminDashboardData['stats']['toolStatus'][number];
export type DashboardToolFilter = 'issues' | 'all';

export interface DashboardToolCounts {
  healthy: number;
  degraded: number;
  unavailable: number;
  notApplicable: number;
}

export function countDashboardTools(tools: readonly DashboardTool[]): DashboardToolCounts {
  const counts: DashboardToolCounts = {
    healthy: 0,
    degraded: 0,
    unavailable: 0,
    notApplicable: 0,
  };

  for (const tool of tools) {
    if (tool.status === 'not_applicable') {
      counts.notApplicable += 1;
    } else {
      counts[tool.status] += 1;
    }
  }

  return counts;
}

export function filterDashboardTools(
  tools: readonly DashboardTool[],
  filter: DashboardToolFilter,
  query: string,
): DashboardTool[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return tools.filter((tool) => {
    if (filter === 'issues' && tool.status === 'healthy') return false;
    if (!normalizedQuery) return true;
    return `${tool.name} ${tool.status} ${tool.detail ?? ''}`
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });
}

export function memorySharePercent(count: number, total: number): number {
  if (!Number.isFinite(count) || !Number.isFinite(total) || count <= 0 || total <= 0) return 0;
  return Math.min(100, (count / total) * 100);
}
