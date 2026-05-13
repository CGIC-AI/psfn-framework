import { apiGet } from '$lib/api/client';
import type { AdminSatelliteRegistryView } from '../../../../../src/shared/contracts/satellite-registry.js';

export type { AdminSatelliteRegistryView };

export function getSatellites(): Promise<AdminSatelliteRegistryView> {
  return apiGet<AdminSatelliteRegistryView>('/api/admin/satellites');
}
