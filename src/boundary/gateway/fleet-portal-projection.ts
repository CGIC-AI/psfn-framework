import type { CompanionFleetEntry } from '../../system/config/companions-config.js';
import { isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';
import type { GatewayFleetCompanionConnection, GatewayFleetConnectionSnapshot } from './server.js';
import { FleetAuthorizationDeniedError } from './fleet-authorization-context.js';
import type {
  FleetPortalAuthorizationBatchPort,
  FleetPortalAuthorizedCompanion,
} from './fleet-portal-authorization.js';

const FLEET_PORTAL_PROTOCOL = Object.freeze({
  schemaVersion: 1 as const,
  maxCompanions: 256,
  maxSerializedBytes: 65_536,
});

export const FLEET_PORTAL_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

export type FleetPortalAvailability = 'online' | 'degraded' | 'offline' | 'unknown';

export interface FleetPortalCompanionProjection {
  readonly companionId: string;
  readonly availability: FleetPortalAvailability;
  readonly headless: boolean;
  readonly gardenPath?: string;
}

export interface FleetPortalProjection {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly session: Readonly<{ state: 'authenticated' }>;
  readonly companions: readonly FleetPortalCompanionProjection[];
}

export interface FleetPortalConnectionSnapshotSource {
  getFleetConnectionSnapshot(): GatewayFleetConnectionSnapshot;
}

export interface GatewayFleetPortalProjectionOptions {
  readonly authorizer: FleetPortalAuthorizationBatchPort;
  readonly fleet: readonly Pick<CompanionFleetEntry, 'companionId' | 'gardenPort'>[];
  readonly source: FleetPortalConnectionSnapshotSource;
  readonly now?: () => Date;
}

function parseProjectionRequest(input: unknown): { sessionToken: string } {
  if (!isRecord(input)
    || Object.keys(input).length !== 1
    || !Object.hasOwn(input, 'sessionToken')
    || typeof input.sessionToken !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(input.sessionToken)) {
    throw new FleetAuthorizationDeniedError('malformed_request');
  }
  return { sessionToken: input.sessionToken };
}

function availability(connection: GatewayFleetCompanionConnection | undefined): FleetPortalAvailability {
  if (!connection) return 'offline';
  if (connection.state === 'registering') return 'unknown';
  if (connection.state === 'ready' && connection.health === 'healthy') return 'online';
  return 'degraded';
}

function indexConnections(
  snapshot: GatewayFleetConnectionSnapshot,
): ReadonlyMap<string, GatewayFleetCompanionConnection> {
  const indexed = new Map<string, GatewayFleetCompanionConnection>();
  for (const connection of snapshot.connections) {
    if (!isRfc4122Uuid(connection.companionId)) {
      throw new Error('Fleet portal connection snapshot contains an invalid companion');
    }
    if (indexed.has(connection.companionId)) {
      throw new Error('Fleet portal connection snapshot contains a colliding companion');
    }
    indexed.set(connection.companionId, connection);
  }
  return indexed;
}

export class GatewayFleetPortalProjection {
  private readonly fleetByCompanionId: ReadonlyMap<
  string,
  Pick<CompanionFleetEntry, 'companionId' | 'gardenPort'>
  >;
  private readonly now: () => Date;

  constructor(private readonly options: GatewayFleetPortalProjectionOptions) {
    if (options.fleet.length === 0 || options.fleet.length > FLEET_PORTAL_PROTOCOL.maxCompanions) {
      throw new Error('Fleet portal projection requires a bounded non-empty manifest');
    }
    const fleet = new Map<string, Pick<CompanionFleetEntry, 'companionId' | 'gardenPort'>>();
    for (const companion of options.fleet) {
      if (!isRfc4122Uuid(companion.companionId)) {
        throw new Error('Fleet portal projection manifest contains an invalid companion');
      }
      if (fleet.has(companion.companionId)) {
        throw new Error('Fleet portal projection manifest contains a colliding companion');
      }
      fleet.set(companion.companionId, Object.freeze({
        companionId: companion.companionId,
        ...(companion.gardenPort !== undefined ? { gardenPort: companion.gardenPort } : {}),
      }));
    }
    this.fleetByCompanionId = fleet;
    this.now = options.now ?? (() => new Date());
  }

  async resolve(input: unknown): Promise<FleetPortalProjection> {
    const request = parseProjectionRequest(input);
    const authorized = await this.options.authorizer.resolve(request);
    const connections = indexConnections(this.options.source.getFleetConnectionSnapshot());
    const now = this.now();
    if (!Number.isFinite(now.getTime())) {
      throw new Error('Fleet portal projection clock is invalid');
    }

    const seen = new Set<string>();
    const companions: FleetPortalCompanionProjection[] = [];
    for (const authority of authorized.companions) {
      this.assertSafeAuthority(authority, seen);
      const manifest = this.fleetByCompanionId.get(authority.companionId);
      if (!manifest) {
        throw new Error('Fleet portal authorization returned an unknown manifest companion');
      }
      const gardenPath = authority.gardenLinkEligible && manifest.gardenPort !== undefined
        ? `/companions/${manifest.companionId}/garden`
        : undefined;
      companions.push(Object.freeze({
        companionId: manifest.companionId,
        availability: availability(connections.get(manifest.companionId)),
        headless: manifest.gardenPort === undefined,
        ...(gardenPath ? { gardenPath } : {}),
      }));
    }
    companions.sort((left, right) => left.companionId.localeCompare(right.companionId));
    return Object.freeze({
      schemaVersion: FLEET_PORTAL_PROTOCOL.schemaVersion,
      generatedAt: now.toISOString(),
      session: Object.freeze({ state: 'authenticated' as const }),
      companions: Object.freeze(companions),
    });
  }

  private assertSafeAuthority(
    authority: FleetPortalAuthorizedCompanion,
    seen: Set<string>,
  ): void {
    if (!isRecord(authority)
      || Object.keys(authority).length !== 2
      || !Object.hasOwn(authority, 'companionId')
      || !Object.hasOwn(authority, 'gardenLinkEligible')
      || !isRfc4122Uuid(authority.companionId)
      || typeof authority.gardenLinkEligible !== 'boolean') {
      throw new Error('Fleet portal authorization result is invalid');
    }
    if (seen.has(authority.companionId)) {
      throw new Error('Fleet portal authorization result contains a colliding companion');
    }
    seen.add(authority.companionId);
  }
}

export function serializeFleetPortalProjection(projection: FleetPortalProjection): Buffer {
  const serialized = Buffer.from(JSON.stringify(projection), 'utf8');
  if (serialized.byteLength > FLEET_PORTAL_PROTOCOL.maxSerializedBytes) {
    throw new Error('Fleet portal projection exceeds its protocol byte bound');
  }
  return serialized;
}
