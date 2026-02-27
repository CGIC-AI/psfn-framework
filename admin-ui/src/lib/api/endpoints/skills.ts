import { apiGet } from '$lib/api/client';
import type { AdminSkillsData } from '$lib/types';

/**
 * Fetch skills snapshot from the admin API.
 * Endpoint: GET /api/admin/skills
 *
 * Note: This endpoint must be added to the backend api-routes.ts.
 * Until then, the page will show a "no data" state.
 */
export function getSkillsData(): Promise<AdminSkillsData> {
  return apiGet<AdminSkillsData>('/api/admin/skills');
}
