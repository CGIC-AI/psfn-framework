import { apiGet, apiPost, apiPatch } from '$lib/api/client';
import type { AdminSkillsData, ManagedSkill } from '$lib/types';

/**
 * Fetch skills snapshot from the admin API.
 * Endpoint: GET /api/admin/skills
 *
 * When the skills runtime is not available, the backend returns { snapshot: null, managed: [] }.
 */
export function getSkillsData(): Promise<AdminSkillsData> {
  return apiGet<AdminSkillsData>('/api/admin/skills');
}

/**
 * Create a new managed skill.
 * Endpoint: POST /api/admin/skills
 */
export function createSkill(input: {
  name: string;
  category: string;
  content: string;
  description?: string;
}): Promise<{ ok: boolean; skill: ManagedSkill }> {
  return apiPost('/api/admin/skills', input);
}

/**
 * Update an existing managed skill.
 * Endpoint: PATCH /api/admin/skills
 */
export function updateSkill(input: {
  name: string;
  content: string;
  description?: string;
}): Promise<{ ok: boolean; skill: ManagedSkill }> {
  return apiPatch('/api/admin/skills', input);
}
