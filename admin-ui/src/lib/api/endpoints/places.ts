import { apiGet, apiPatch } from '$lib/api/client';
import type {
  AdminAffordanceView,
  AdminBoundSatelliteView,
  AdminDanglingSatelliteView,
  AdminPlacesData,
  AdminPlaceView,
  AdminSatelliteRebindResult,
} from '../../../../../src/operator/garden/services/places-service.js';

// Re-export the canonical admin view types (no shadow DTO mirror — see PSFN-00yo.1).
export type {
  AdminAffordanceView,
  AdminBoundSatelliteView,
  AdminDanglingSatelliteView,
  AdminPlacesData,
  AdminPlaceView,
  AdminSatelliteRebindResult,
};

/** GET /api/admin/places — sites + places + affordances + bound/unbound/dangling satellites. */
export function getPlaces(): Promise<AdminPlacesData> {
  return apiGet<AdminPlacesData>('/api/admin/places');
}

/** GET /api/admin/places/map — Mermaid (flowchart TB) world map source. */
export function getPlacesMap(): Promise<{ mermaid: string }> {
  return apiGet<{ mermaid: string }>('/api/admin/places/map');
}

/**
 * PATCH /api/admin/places/satellites/:satelliteId/binding — the only path that
 * changes a satellite's static placeId. Pass `null` to unbind. Fails closed on
 * an unknown satellite or an unknown target place; returns the refreshed doc.
 */
export function rebindSatellite(
  satelliteId: string,
  placeId: string | null
): Promise<AdminSatelliteRebindResult> {
  return apiPatch<AdminSatelliteRebindResult>(
    `/api/admin/places/satellites/${encodeURIComponent(satelliteId)}/binding`,
    { placeId }
  );
}
