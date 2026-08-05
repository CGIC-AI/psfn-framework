import { companionGardenRoot } from './companion-scope';
import { throwIfAborted } from '../api/abort';
import { withFleetSessionTransitionLock } from '../api/fleet-session';
import {
  hasExactKeys,
  isRecord,
  isRfc4122Uuid,
} from '../../../../src/shared/utils/types.js';
const MAX_FLEET_COMPANIONS = 256;

export type FleetPortalHealthStatus = 'up' | 'down' | 'unknown';
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
  health: FleetPortalHealthDimensions;
  posture: FleetPortalPosture;
  gardenPath?: string;
  avatarRef?: string;
}

export interface FleetPortalProjection {
  schemaVersion: 2;
  generatedAt: string;
  session: { state: 'authenticated' };
  companions: FleetPortalCompanion[];
}

export interface FleetCardDetails {
  adminTransport: FleetPortalHealthStatus;
  avatarUrl?: string;
}

export interface FleetPortalHealthDimensions {
  agentRpc: FleetPortalHealthStatus;
  adminTransport: FleetPortalHealthStatus;
  channels: FleetPortalHealthStatus;
}

export type FleetCardHealth = FleetPortalHealthDimensions;

interface FleetReferencePhoto {
  id: string;
}

function parseHealthStatus(value: unknown): FleetPortalHealthStatus {
  if (value === 'up' || value === 'down' || value === 'unknown') return value;
  throw new Error('Cluster portal returned an invalid health dimension');
}

function parseHealth(value: unknown): FleetPortalCompanion['health'] {
  if (!isRecord(value)
    || !hasExactKeys(value, ['agentRpc', 'adminTransport', 'channels'])) {
    throw new Error('Cluster portal returned an invalid health projection');
  }
  return {
    agentRpc: parseHealthStatus(value.agentRpc),
    adminTransport: parseHealthStatus(value.adminTransport),
    channels: parseHealthStatus(value.channels),
  };
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
    throw new Error('Cluster portal returned an invalid posture metric');
  }
  return {
    state: value.state as FleetPortalPostureState,
    utilizationPercent: value.utilizationPercent as number,
  };
}

function parsePosture(value: unknown): FleetPortalPosture {
  if (!isRecord(value)
    || !['available', 'stale', 'unavailable'].includes(String(value.status))) {
    throw new Error('Cluster portal returned an invalid posture');
  }
  if (value.status === 'unavailable') {
    if (!hasExactKeys(value, ['status'])) {
      throw new Error('Cluster portal unavailable posture was widened');
    }
    return { status: 'unavailable' };
  }
  if (!hasExactKeys(value, ['status', 'updatedAt', 'charge', 'fatigue'])
    || typeof value.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error('Cluster portal returned an invalid timestamped posture');
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
    || value.health === undefined
    || value.posture === undefined
    || (value.avatarRef !== undefined
      && (typeof value.avatarRef !== 'string' || value.avatarRef.length > 2_048))
    || (value.gardenPath !== undefined
      && value.gardenPath !== companionGardenRoot(value.companionId))) {
    throw new Error('Cluster portal returned an invalid companion projection');
  }
  const keys = [
    'companionId',
    'displayName',
    'health',
    'posture',
    ...(value.gardenPath === undefined ? [] : ['gardenPath']),
    ...(value.avatarRef === undefined ? [] : ['avatarRef']),
  ];
  if (!hasExactKeys(value, keys)) {
    throw new Error('Cluster portal companion projection was widened');
  }
  seen.add(value.companionId);
  return {
    companionId: value.companionId,
    displayName: value.displayName,
    health: parseHealth(value.health),
    posture: parsePosture(value.posture),
    ...(typeof value.gardenPath === 'string' ? { gardenPath: value.gardenPath } : {}),
    ...(typeof value.avatarRef === 'string' ? { avatarRef: value.avatarRef } : {}),
  };
}

export function parseFleetPortalProjection(value: unknown): FleetPortalProjection {
  if (!isRecord(value)
    || !hasExactKeys(value, ['schemaVersion', 'generatedAt', 'session', 'companions'])
    || value.schemaVersion !== 2
    || typeof value.generatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.generatedAt))
    || !isRecord(value.session)
    || !hasExactKeys(value.session, ['state'])
    || value.session.state !== 'authenticated'
    || !Array.isArray(value.companions)
    || value.companions.length > MAX_FLEET_COMPANIONS) {
    throw new Error('Cluster portal returned an invalid bounded projection');
  }
  const seen = new Set<string>();
  return {
    schemaVersion: 2,
    generatedAt: value.generatedAt,
    session: { state: 'authenticated' },
    companions: value.companions.map(companion => parseCompanion(companion, seen)),
  };
}

export function resolveFleetCardHealth(
  companion: FleetPortalCompanion,
  details?: FleetCardDetails,
): FleetCardHealth {
  return {
    agentRpc: companion.health.agentRpc,
    adminTransport: details?.adminTransport ?? companion.health.adminTransport,
    channels: companion.health.channels,
  };
}

export function selectFirstReferenceAvatar(
  references: readonly FleetReferencePhoto[],
  gardenPath: string,
): string | undefined {
  const first = references[0];
  if (!first?.id.trim()) return undefined;
  return `${gardenPath}/api/admin/image-references/${encodeURIComponent(first.id)}/blob`;
}

export async function fetchFleetCardDetails(
  companion: FleetPortalCompanion,
  signal?: AbortSignal,
): Promise<FleetCardDetails> {
  if (!companion.gardenPath) return { adminTransport: 'unknown' };
  try {
    const response = await fetch(`${companion.gardenPath}/api/admin/image-references`, {
      cache: 'no-store',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      return { adminTransport: 'down' };
    }
    if (!response.ok) return { adminTransport: 'unknown' };
    const value: unknown = await response.json();
    if (!isRecord(value) || !Array.isArray(value.references)) {
      return { adminTransport: 'up' };
    }
    const references = value.references.flatMap((reference): FleetReferencePhoto[] => (
      isRecord(reference) && typeof reference.id === 'string' && reference.id.trim()
        ? [{ id: reference.id }]
        : []
    ));
    const avatarUrl = selectFirstReferenceAvatar(references, companion.gardenPath);
    return {
      adminTransport: 'up',
      ...(avatarUrl ? { avatarUrl } : {}),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof TypeError || error instanceof SyntaxError) {
      // Browser fetch reports a network-level transport failure as TypeError;
      // Response.json reports an unusable successful payload as SyntaxError.
      // Neither proves the companion transport is down.
      return { adminTransport: 'unknown' };
    }
    throw error;
  }
}

export async function fetchFleetPortalProjection(signal?: AbortSignal): Promise<FleetPortalProjection> {
  return await withFleetSessionTransitionLock(async transitionSignal => {
    let response: Response;
    try {
      response = await fetch('/v1/fleet/portal', {
        cache: 'no-store',
        credentials: 'include',
        headers: { Accept: 'application/json' },
        signal: transitionSignal,
      });
    } catch (error) {
      throwIfAborted(transitionSignal);
      throw error;
    }
    throwIfAborted(transitionSignal);
    if (response.status === 401) {
      if (typeof window !== 'undefined') window.location.assign('/fleet/login');
      throw new Error('Cluster session expired');
    }
    if (!response.ok) {
      throw new Error(response.status === 403
        ? 'Cluster access is unavailable'
        : 'Cluster status is temporarily unavailable');
    }
    return parseFleetPortalProjection(await response.json());
  }, signal);
}
