import { apiGet } from '$lib/api/client';
import type { SubsystemHealthSnapshot } from '$lib/types';

/**
 * Fetch live background-lane health from the admin API.
 * Endpoint: GET /api/admin/subsystem-health
 */
export function getSubsystemHealth(): Promise<SubsystemHealthSnapshot> {
  return apiGet<SubsystemHealthSnapshot>('/api/admin/subsystem-health');
}
