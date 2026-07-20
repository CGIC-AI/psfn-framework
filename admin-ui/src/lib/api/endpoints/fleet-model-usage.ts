import { apiGet } from '$lib/api/client';
import type {
  ModelUsageBucket,
  ModelUsageRange,
} from '../../../../../src/shared/telemetry/model-usage.js';
import type { FleetModelUsageData } from '../../../../../src/operator/garden/services/fleet-model-usage-service.js';

export interface FleetModelUsageQuery {
  range?: Exclude<ModelUsageRange, 'all'>;
  timezone?: string;
  sinceMs?: number;
  untilMs?: number;
  bucket?: ModelUsageBucket;
}

const FLEET_MODEL_USAGE_QUERY_FIELDS = [
  'range',
  'timezone',
  'sinceMs',
  'untilMs',
  'bucket',
] as const satisfies ReadonlyArray<keyof FleetModelUsageQuery>;

export function buildFleetModelUsagePath(query: FleetModelUsageQuery = {}): string {
  const params = new URLSearchParams();
  for (const field of FLEET_MODEL_USAGE_QUERY_FIELDS) {
    const value = query[field];
    if (value !== undefined) params.set(field, String(value));
  }
  const suffix = params.toString();
  return `/api/admin/fleet-model-usage${suffix ? `?${suffix}` : ''}`;
}

export function getFleetModelUsage(
  query: FleetModelUsageQuery = {},
): Promise<FleetModelUsageData> {
  return apiGet<FleetModelUsageData>(buildFleetModelUsagePath(query));
}

export type {
  FleetModelUsageCompanion,
  FleetModelUsageData,
} from '../../../../../src/operator/garden/services/fleet-model-usage-service.js';
