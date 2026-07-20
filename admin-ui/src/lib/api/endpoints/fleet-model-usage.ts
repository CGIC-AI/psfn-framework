import { apiGet } from '$lib/api/client';
import type {
  ModelUsageBucket,
  ModelUsageRange,
} from '../../../../../src/shared/telemetry/model-usage.js';
import type { FleetModelUsageData } from '../../../../../src/operator/garden/services/fleet-model-usage-service.js';
import { parseCompanionGardenScope } from '$lib/fleet/companion-scope';
import { parseFleetModelUsageData } from '$lib/fleet/model-usage-data';
import { serializeModelUsageQuery } from './model-usage-query';

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
  const suffix = serializeModelUsageQuery(params);
  return `/api/admin/fleet-model-usage${suffix ? `?${suffix}` : ''}`;
}

export function getFleetModelUsage(
  query: FleetModelUsageQuery = {},
): Promise<FleetModelUsageData> {
  return apiGet<FleetModelUsageData>(buildFleetModelUsagePath(query));
}

export async function getAuthorizedFleetModelUsage(
  gardenPath: string,
  query: FleetModelUsageQuery = {},
  signal?: AbortSignal,
): Promise<FleetModelUsageData> {
  const scope = parseCompanionGardenScope(gardenPath);
  if (!scope || scope.publicPrefix !== gardenPath || scope.innerPath !== '/') {
    throw new Error('Fleet costs require one server-authorized companion Garden path');
  }
  const response = await fetch(`${gardenPath}${buildFleetModelUsagePath(query)}`, {
    cache: 'no-store',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (response.status === 401) {
    if (typeof window !== 'undefined') window.location.assign('/fleet/login');
    throw new Error('Fleet session expired');
  }
  if (!response.ok) {
    throw new Error(response.status === 403
      ? 'Fleet cost access is unavailable'
      : 'Fleet cost telemetry is temporarily unavailable');
  }
  const projection = parseFleetModelUsageData(await response.json());
  if (projection.deployment !== 'fleet') {
    throw new Error('Fleet cost telemetry returned a non-fleet projection');
  }
  return projection;
}

export type {
  FleetModelUsageCompanion,
  FleetModelUsageData,
} from '../../../../../src/operator/garden/services/fleet-model-usage-service.js';
