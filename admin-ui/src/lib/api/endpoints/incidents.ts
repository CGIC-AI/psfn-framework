import { apiGet } from '$lib/api/client';
import type { IncidentTimelineSnapshot } from '$lib/types';

/**
 * Fetch correlated runtime incidents rebuilt from the persisted health stream.
 * Each incident carries the same id the operator alert was keyed on.
 * Endpoint: GET /api/admin/incidents
 */
export function getIncidents(): Promise<IncidentTimelineSnapshot> {
  return apiGet<IncidentTimelineSnapshot>('/api/admin/incidents');
}
