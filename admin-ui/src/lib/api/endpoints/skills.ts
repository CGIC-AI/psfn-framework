import { apiGet } from '$lib/api/client';
import type { AdminSkillsData } from '$lib/types';

/**
 * Fetch skills snapshot from the admin API.
 * Endpoint: GET /api/admin/skills
 *
 * When the skills runtime is not available, the backend returns { snapshot: null }.
 */
export function getSkillsData(): Promise<AdminSkillsData> {
  return apiGet<AdminSkillsData>('/api/admin/skills');
}
