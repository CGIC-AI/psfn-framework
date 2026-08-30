import type { CompanionFleetEntry } from '../../system/config/companions-config.js';
import { createCompanionDisplayIdentityResolver } from '../../shared/companion-display-identity.js';
import { isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';
import type { GatewayFleetCompanionConnection, GatewayFleetConnectionSnapshot } from './server.js';
import { FleetAuthorizationDeniedError } from './fleet-authorization-context.js';
import type {
  FleetPortalAuthorizationBatchPort,
  FleetPortalAuthorizedCompanion,
} from './fleet-portal-authorization.js';
import { compileFleetSsoGardenPath } from './fleet-sso-route-compiler.js';
import { compileCompanionUiWebSocketPath } from './companion-ui-websocket-path.js';
import {
  FLEET_POSTURE_EXPIRY_TIMEOUT_MS,
  FLEET_POSTURE_STALE_TIMEOUT_MS,
  parseFleetCompanionPosture,
  type FleetChargePosture,
  type FleetFatiguePosture,
} from '../../shared/telemetry/fleet-posture.js';

const FLEET_PORTAL_PROJECTION_PROTOCOL = Object.freeze({
  schemaVersion: 2 as const,
  maxCompanions: 256,
  maxSerializedBytes: 65_536,
});
const FLEET_PORTAL_ROSTER_SCHEMA_VERSION = 1 as const;

export const FLEET_PORTAL_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

export type FleetPortalHealthStatus = 'up' | 'down' | 'unknown';
export type FleetPortalPostureStatus = 'available' | 'stale' | 'unavailable';

export type FleetPortalPosture =
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{
      status: 'available' | 'stale';
      updatedAt: string;
      charge: Readonly<{
        state: FleetChargePosture;
        utilizationPercent: number;
      }>;
      fatigue: Readonly<{
        state: FleetFatiguePosture;
        utilizationPercent: number;
      }>;
    }>;

export interface FleetPortalCompanionProjection {
  readonly companionId: string;
  readonly displayName: string;
  readonly health: Readonly<{
    readonly agentRpc: FleetPortalHealthStatus;
    /** Refined by an authorized companion Garden probe in the browser. */
    readonly adminTransport: FleetPortalHealthStatus;
    readonly channels: FleetPortalHealthStatus;
  }>;
  readonly posture: FleetPortalPosture;
  readonly gardenPath?: string;
  readonly avatarRef?: string;
}

export interface FleetPortalProjection {
  readonly schemaVersion: 2;
  readonly generatedAt: string;
  readonly session: Readonly<{ state: 'authenticated' }>;
  readonly companions: readonly FleetPortalCompanionProjection[];
}

/**
 * Roster entry for the Companion UI switcher (sprint-10 companion roster wire).
 * Display-only: `displayName` is the required manifest label, `avatarRef` is
 * an opaque display ref, and `websocketPath` is the one
 * canonical stream URL a browser may open for this companion. Carries no
 * authority, topology, or availability posture.
 */
export interface FleetPortalRosterCompanion {
  readonly companionId: string;
  readonly displayName: string;
  readonly websocketPath: string;
  readonly avatarRef?: string;
}

export interface FleetPortalRoster {
  readonly schemaVersion: 1;
  readonly companions: readonly FleetPortalRosterCompanion[];
}

export interface FleetPortalConnectionSnapshotSource {
  getFleetConnectionSnapshot(): GatewayFleetConnectionSnapshot;
}

export interface FleetPortalChannelHealthSource {
  healthOf(companionId: string): FleetPortalHealthStatus;
}

export interface GatewayFleetPortalProjectionOptions {
  readonly authorizer: FleetPortalAuthorizationBatchPort;
  readonly fleet: readonly Pick<
  CompanionFleetEntry,
  'companionId' | 'displayName' | 'avatarRef'
  >[];
  readonly source: FleetPortalConnectionSnapshotSource;
  readonly channelHealth?: FleetPortalChannelHealthSource;
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

function agentRpcHealth(
  connection: GatewayFleetCompanionConnection | undefined,
): FleetPortalHealthStatus {
  if (!connection) return 'down';
  if (connection.state === 'registering') return 'unknown';
  return 'up';
}

function posture(
  connection: GatewayFleetCompanionConnection | undefined,
  nowMs: number,
): FleetPortalPosture {
  if (!connection?.posture) return Object.freeze({ status: 'unavailable' as const });
  const summary = parseFleetCompanionPosture(connection.posture, nowMs);
  const ageMs = nowMs - summary.updatedAt;
  if (ageMs > FLEET_POSTURE_EXPIRY_TIMEOUT_MS) {
    return Object.freeze({ status: 'unavailable' as const });
  }
  const status = ageMs > FLEET_POSTURE_STALE_TIMEOUT_MS
    ? 'stale'
    : 'available';
  return Object.freeze({
    status,
    updatedAt: new Date(summary.updatedAt).toISOString(),
    charge: Object.freeze({ ...summary.charge }),
    fatigue: Object.freeze({ ...summary.fatigue }),
  });
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

type ProjectionManifestEntry = Pick<
  CompanionFleetEntry,
  'companionId' | 'displayName' | 'avatarRef'
>;

export class GatewayFleetPortalProjection {
  private readonly fleetByCompanionId: ReadonlyMap<string, ProjectionManifestEntry>;
  private readonly now: () => Date;

  constructor(private readonly options: GatewayFleetPortalProjectionOptions) {
    if (options.fleet.length === 0
      || options.fleet.length > FLEET_PORTAL_PROJECTION_PROTOCOL.maxCompanions) {
      throw new Error('Fleet portal projection requires a bounded non-empty manifest');
    }
    const fleet = new Map<string, ProjectionManifestEntry>();
    for (const companion of options.fleet) {
      if (!isRfc4122Uuid(companion.companionId)) {
        throw new Error('Fleet portal projection manifest contains an invalid companion');
      }
      if (fleet.has(companion.companionId)) {
        throw new Error('Fleet portal projection manifest contains a colliding companion');
      }
      fleet.set(companion.companionId, Object.freeze({
        companionId: companion.companionId,
        ...(companion.displayName !== undefined ? { displayName: companion.displayName } : {}),
        ...(companion.avatarRef !== undefined ? { avatarRef: companion.avatarRef } : {}),
      }));
    }
    this.fleetByCompanionId = fleet;
    this.now = options.now ?? (() => new Date());
  }

  async resolve(input: unknown): Promise<FleetPortalProjection> {
    const request = parseProjectionRequest(input);
    const authorized = await this.options.authorizer.resolve(request);
    const seen = new Set<string>();
    const visibleManifest: ProjectionManifestEntry[] = [];
    for (const authority of authorized.companions) {
      this.assertSafeAuthority(authority, seen);
      const manifest = this.fleetByCompanionId.get(authority.companionId);
      if (!manifest) {
        throw new Error('Fleet portal authorization returned an unknown manifest companion');
      }
      // Bounded authorized projection: principals see only companions they hold
      // a Garden link for. gardenPort is retired (one fleet Garden derives every
      // admin endpoint), so authorization is the only gate.
      if (!authority.gardenLinkEligible) continue;
      visibleManifest.push(manifest);
    }
    return this.buildProjection(visibleManifest);
  }

  /**
   * The configured ADMIN_TOKEN is the fleet deployment's unconditional
   * operator credential: it holds a Garden link to every manifest companion by
   * construction, so its portal projection is the full manifest with no
   * per-principal SSO filtering.
   */
  async resolveAdminToken(): Promise<FleetPortalProjection> {
    return this.buildProjection([...this.fleetByCompanionId.values()]);
  }

  private buildProjection(
    visibleManifest: readonly ProjectionManifestEntry[],
  ): FleetPortalProjection {
    const connections = indexConnections(this.options.source.getFleetConnectionSnapshot());
    const now = this.now();
    if (!Number.isFinite(now.getTime())) {
      throw new Error('Fleet portal projection clock is invalid');
    }
    const displayIdentity = createCompanionDisplayIdentityResolver(visibleManifest);
    const companions: FleetPortalCompanionProjection[] = [];
    for (const manifest of visibleManifest) {
      const gardenPath = compileFleetSsoGardenPath(manifest.companionId);
      const connection = connections.get(manifest.companionId);
      companions.push(Object.freeze({
        companionId: manifest.companionId,
        displayName: displayIdentity.resolve(manifest.companionId).displayLabel,
        health: Object.freeze({
          agentRpc: agentRpcHealth(connection),
          // The gateway does not own the per-companion Garden transport. Do
          // not infer this dimension from the independent agent RPC link.
          adminTransport: 'unknown',
          channels: this.options.channelHealth?.healthOf(manifest.companionId) ?? 'unknown',
        }),
        posture: posture(connection, now.getTime()),
        gardenPath,
        ...(manifest.avatarRef !== undefined ? { avatarRef: manifest.avatarRef } : {}),
      }));
    }
    companions.sort((left, right) => left.companionId.localeCompare(right.companionId));
    return Object.freeze({
      schemaVersion: FLEET_PORTAL_PROJECTION_PROTOCOL.schemaVersion,
      generatedAt: now.toISOString(),
      session: Object.freeze({ state: 'authenticated' as const }),
      companions: Object.freeze(companions),
    });
  }

  /**
   * Roster for the Companion UI switcher. Reuses the SAME authorizer as
   * {@link resolve}: least-authority, non-enumerating — only the companions the
   * session may access appear, and unknown/unauthorized manifest data never
   * leaks. Adds display identity (`displayName`, `avatarRef`) and the canonical
   * per-companion WebSocket path; carries no availability posture or topology.
   */
  async resolveRoster(input: unknown): Promise<FleetPortalRoster> {
    const request = parseProjectionRequest(input);
    const authorized = await this.options.authorizer.resolve(request);
    const seen = new Set<string>();
    const visibleManifest: ProjectionManifestEntry[] = [];
    for (const authority of authorized.companions) {
      this.assertSafeAuthority(authority, seen);
      const manifest = this.fleetByCompanionId.get(authority.companionId);
      if (!manifest) {
        throw new Error('Fleet portal authorization returned an unknown manifest companion');
      }
      visibleManifest.push(manifest);
    }
    const displayIdentity = createCompanionDisplayIdentityResolver(visibleManifest);
    const companions: FleetPortalRosterCompanion[] = [];
    for (const manifest of visibleManifest) {
      companions.push(Object.freeze({
        companionId: manifest.companionId,
        displayName: displayIdentity.resolve(manifest.companionId).displayLabel,
        websocketPath: compileCompanionUiWebSocketPath(manifest.companionId),
        ...(manifest.avatarRef !== undefined ? { avatarRef: manifest.avatarRef } : {}),
      }));
    }
    companions.sort((left, right) => left.companionId.localeCompare(right.companionId));
    return Object.freeze({
      schemaVersion: FLEET_PORTAL_ROSTER_SCHEMA_VERSION,
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
  if (serialized.byteLength > FLEET_PORTAL_PROJECTION_PROTOCOL.maxSerializedBytes) {
    throw new Error('Fleet portal projection exceeds its protocol byte bound');
  }
  return serialized;
}
