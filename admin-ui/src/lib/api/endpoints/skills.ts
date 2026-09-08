import { apiGet, apiPost, apiPatch, apiDelete } from '$lib/api/client';
import { ApiError } from '$lib/api/errors';
import type { AdminSkillsData, ManagedSkill, SkillVersionConflict } from '$lib/types';

/**
 * Fetch skills snapshot from the admin API.
 * Endpoint: GET /api/admin/skills
 *
 * When the skills runtime is not available, the backend returns { snapshot: null, managed: [], disabledSkills: [] }.
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
  /**
   * The version the editor was opened against. The Garden route compare-and-
   * swaps on it, so a save built from a stale read is refused with 409 instead
   * of overwriting a concurrent agent revision (psfn-framework-2ug9l).
   */
  expectedVersion: number;
}): Promise<{ ok: boolean; skill: ManagedSkill }> {
  return apiPatch('/api/admin/skills', input);
}

/**
 * Recognize the typed compare-and-swap rejection a stale skill save receives.
 * Returns the versions involved so the editor can tell the operator exactly
 * which revision landed underneath them; any other failure returns null and is
 * reported as an ordinary save error.
 */
export function skillVersionConflict(error: unknown): SkillVersionConflict | null {
  if (!(error instanceof ApiError) || error.status !== 409 || !error.body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(error.body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  if (record.code !== 'skill_version_conflict'
    || typeof record.skillName !== 'string'
    || typeof record.expectedVersion !== 'number'
    || typeof record.currentVersion !== 'number') {
    return null;
  }
  return {
    skillName: record.skillName,
    expectedVersion: record.expectedVersion,
    currentVersion: record.currentVersion,
  };
}

/**
 * Toggle a skill's enabled/disabled state.
 * Endpoint: POST /api/admin/skills/toggle
 */
export function toggleSkill(name: string): Promise<{ ok: boolean; name: string; enabled: boolean }> {
  return apiPost('/api/admin/skills/toggle', { name });
}

/**
 * Delete a managed skill.
 * Endpoint: DELETE /api/admin/skills/:name
 */
export function deleteSkill(name: string): Promise<{ ok: boolean }> {
  return apiDelete(`/api/admin/skills/${encodeURIComponent(name)}`);
}
