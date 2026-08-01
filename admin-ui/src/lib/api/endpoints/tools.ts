import { apiGet, apiPost } from '$lib/api/client';
import type { AdminAdaptiveToolsData } from '$lib/types/tools';

export function getAdaptiveTools(): Promise<AdminAdaptiveToolsData> {
  return apiGet<AdminAdaptiveToolsData>('/api/admin/tools/adaptive');
}

export function releaseMcp(serverId?: string): Promise<{ released: true; serverId?: string }> {
  return apiPost('/api/admin/tools/mcp/release', serverId ? { serverId } : {});
}
