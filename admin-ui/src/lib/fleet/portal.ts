import { companionGardenRoot } from './companion-scope';
import {
  hasExactKeys,
  isRecord,
  isRfc4122Uuid,
} from '../../../../src/shared/utils/types.js';
const MAX_FLEET_COMPANIONS = 256;

export type FleetPortalAvailability = 'online' | 'degraded' | 'offline' | 'unknown';
export type FleetPortalPostureState = 'clear' | 'pressured' | 'exhausted';
export type FleetPortalPosture =
  | { status: 'unavailable' }
  | {
      status: 'available' | 'stale';
      updatedAt: string;
      charge: { state: FleetPortalPostureState; utilizationPercent: number };
      fatigue: { state: FleetPortalPostureState; utilizationPercent: number };
    };

export interface FleetPortalCompanion {
  companionId: string;
  displayName: string;
  availability: FleetPortalAvailability;
  posture: FleetPortalPosture;
  gardenPath?: string;
  avatarRef?: string;
}

export interface FleetPortalProjection {
  schemaVersion: 1;
  generatedAt: string;
  session: { state: 'authenticated' };
  companions: FleetPortalCompanion[];
}

function parsePostureMetric(value: unknown): {
  state: FleetPortalPostureState;
  utilizationPercent: number;
} {
  if (!isRecord(value)
    || !hasExactKeys(value, ['state', 'utilizationPercent'])
    || !['clear', 'pressured', 'exhausted'].includes(String(value.state))
    || !Number.isInteger(value.utilizationPercent)
    || (value.utilizationPercent as number) < 0
    || (value.utilizationPercent as number) > 100) {
    throw new Error('Fleet portal returned an invalid posture metric');
  }
  return {
    state: value.state as FleetPortalPostureState,
    utilizationPercent: value.utilizationPercent as number,
  };
}

function parsePosture(value: unknown): FleetPortalPosture {
  if (!isRecord(value)
    || !['available', 'stale', 'unavailable'].includes(String(value.status))) {
    throw new Error('Fleet portal returned an invalid posture');
  }
  if (value.status === 'unavailable') {
    if (!hasExactKeys(value, ['status'])) {
      throw new Error('Fleet portal unavailable posture was widened');
    }
    return { status: 'unavailable' };
  }
  if (!hasExactKeys(value, ['status', 'updatedAt', 'charge', 'fatigue'])
    || typeof value.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error('Fleet portal returned an invalid timestamped posture');
  }
  return {
    status: value.status as 'available' | 'stale',
    updatedAt: value.updatedAt,
    charge: parsePostureMetric(value.charge),
    fatigue: parsePostureMetric(value.fatigue),
  };
}

function parseCompanion(value: unknown, seen: Set<string>): FleetPortalCompanion {
  if (!isRecord(value)
    || typeof value.companionId !== 'string'
    || !isRfc4122Uuid(value.companionId)
    || seen.has(value.companionId)
    || typeof value.displayName !== 'string'
    || value.displayName.trim().length === 0
    || value.displayName.length > 256
    || !['online', 'degraded', 'offline', 'unknown'].includes(String(value.availability))
    || value.posture === undefined
    || (value.avatarRef !== undefined
      && (typeof value.avatarRef !== 'string' || value.avatarRef.length > 2_048))
    || (value.gardenPath !== undefined
      && value.gardenPath !== companionGardenRoot(value.companionId))) {
    throw new Error('Fleet portal returned an invalid companion projection');
  }
  const keys = [
    'availability',
    'companionId',
    'displayName',
    'posture',
    ...(value.gardenPath === undefined ? [] : ['gardenPath']),
    ...(value.avatarRef === undefined ? [] : ['avatarRef']),
  ];
  if (!hasExactKeys(value, keys)) {
    throw new Error('Fleet portal companion projection was widened');
  }
  seen.add(value.companionId);
  return {
    companionId: value.companionId,
    displayName: value.displayName,
    availability: value.availability as FleetPortalAvailability,
    posture: parsePosture(value.posture),
    ...(typeof value.gardenPath === 'string' ? { gardenPath: value.gardenPath } : {}),
    ...(typeof value.avatarRef === 'string' ? { avatarRef: value.avatarRef } : {}),
  };
}

export function parseFleetPortalProjection(value: unknown): FleetPortalProjection {
  if (!isRecord(value)
    || !hasExactKeys(value, ['schemaVersion', 'generatedAt', 'session', 'companions'])
    || value.schemaVersion !== 1
    || typeof value.generatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.generatedAt))
    || !isRecord(value.session)
    || !hasExactKeys(value.session, ['state'])
    || value.session.state !== 'authenticated'
    || !Array.isArray(value.companions)
    || value.companions.length > MAX_FLEET_COMPANIONS) {
    throw new Error('Fleet portal returned an invalid bounded projection');
  }
  const seen = new Set<string>();
  return {
    schemaVersion: 1,
    generatedAt: value.generatedAt,
    session: { state: 'authenticated' },
    companions: value.companions.map(companion => parseCompanion(companion, seen)),
  };
}

export async function fetchFleetPortalProjection(signal?: AbortSignal): Promise<FleetPortalProjection> {
  const response = await fetch('/v1/fleet/portal', {
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
      ? 'Fleet access is unavailable'
      : 'Fleet status is temporarily unavailable');
  }
  return parseFleetPortalProjection(await response.json());
}
