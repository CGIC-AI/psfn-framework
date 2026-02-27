import { apiGet } from '$lib/api/client';
import type { AdminSchedulerData } from '$lib/types';

/**
 * Fetch scheduler tasks from the admin API.
 * Endpoint: GET /api/admin/scheduler
 *
 * Note: This endpoint must be added to the backend api-routes.ts.
 * Until then, the page will show a "no data" state.
 */
export function getSchedulerData(): Promise<AdminSchedulerData> {
  return apiGet<AdminSchedulerData>('/api/admin/scheduler');
}
