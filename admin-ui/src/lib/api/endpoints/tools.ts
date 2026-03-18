import { apiGet } from '$lib/api/client';
import type { AdminAdaptiveToolsData } from '$lib/types/tools';

export function getAdaptiveTools(): Promise<AdminAdaptiveToolsData> {
  return apiGet<AdminAdaptiveToolsData>('/api/admin/tools/adaptive');
}
