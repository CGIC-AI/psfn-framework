import { apiGet } from '$lib/api/client';
import type { AdminValuesData } from '$lib/types';

/**
 * Fetch values journal entries from the admin API.
 * Endpoint: GET /api/admin/values
 *
 * Note: This endpoint must be added to the backend api-routes.ts.
 * Until then, the page will show a "no data" state.
 */
export function getValuesData(): Promise<AdminValuesData> {
  return apiGet<AdminValuesData>('/api/admin/values');
}
