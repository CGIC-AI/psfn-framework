import { apiGet } from '$lib/api/client';
import type {
  AdminReflectionDailyData,
  AdminReflectionJournalData,
  AdminReflectionMetacognitionData,
  AdminValuesData,
} from '$lib/types';

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

export function getReflectionMetacognitionData(): Promise<AdminReflectionMetacognitionData> {
  return apiGet<AdminReflectionMetacognitionData>('/api/admin/values/reflections/metacognition');
}

export function getReflectionDailyData(): Promise<AdminReflectionDailyData> {
  return apiGet<AdminReflectionDailyData>('/api/admin/values/reflections/daily');
}

export function getReflectionJournalData(): Promise<AdminReflectionJournalData> {
  return apiGet<AdminReflectionJournalData>('/api/admin/values/reflections/journal');
}
