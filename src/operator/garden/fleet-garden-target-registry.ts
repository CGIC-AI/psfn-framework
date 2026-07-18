// ── Fleet Garden target registry ──
// Immutable, server-derived routing identity for every companion the one
// fleet Garden control plane may address. Identity (companion ID, exact
// admin-transport endpoint, expected agent identity) is built once at startup
// and can never change; mutable health/probe state lives in a separate map so
// no health transition can ever rewrite where a companion's requests go.
// There is deliberately no mutable "current companion" on this seam.

import { resolve as resolvePath } from 'node:path';
import {
  createCompanionId,
  LOWERCASE_RFC4122_COMPANION_ID_PATTERN,
  type CompanionId,
} from '../../shared/routing/companion-id.js';
import type { ResolvedCompanionsFleetConfig } from '../../system/config/companions-config.js';
import {
  DEFAULT_ADMIN_TRANSPORT_TIMEOUT_MS,
  resolveCompanionAdminTransportSocketPath,
  type GardenAdminTransportClientEndpoint,
} from './transport-paths.js';

export class FleetGardenTargetRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetGardenTargetRegistryError';
  }
}

/**
 * Trusted routing material for one companion target. Contains no
 * caller-supplied paths, no mutable selected state, no reusable browser
 * authority, and no copied owner data.
 */
export interface FleetGardenTargetIdentity {
  readonly companionId: CompanionId;
  /** Exact socket or mTLS agent-admin endpoint derived from deployment topology. */
  readonly endpoint: GardenAdminTransportClientEndpoint;
  /**
   * The capability audience the remote agent must prove before a domain
   * module runs — the material verifying the remote process represents this
   * exact companion. Derived, never caller-supplied.
   */
  readonly expectedAgentAudience: `agent:${string}`;
}

export type FleetGardenTargetHealth =
  | { readonly status: 'unknown' }
  | { readonly status: 'ready'; readonly probedAt: string }
  | { readonly status: 'unavailable'; readonly probedAt: string; readonly reason: string };

export interface FleetGardenTargetReadiness {
  readonly companionId: CompanionId;
  readonly health: FleetGardenTargetHealth;
}

export interface FleetGardenTargetRegistryEntryInput {
  readonly companionId: CompanionId;
  readonly endpoint: GardenAdminTransportClientEndpoint;
}

const INITIAL_HEALTH: FleetGardenTargetHealth = Object.freeze({ status: 'unknown' as const });

function endpointCollisionKey(endpoint: GardenAdminTransportClientEndpoint): string {
  return endpoint.mode === 'socket'
    ? `socket:${resolvePath(endpoint.socketPath)}`
    : `network:${endpoint.httpUrl.origin}`;
}

function freezeEndpoint(
  endpoint: GardenAdminTransportClientEndpoint,
  companionId: string,
): GardenAdminTransportClientEndpoint {
  if (!Number.isSafeInteger(endpoint.timeoutMs) || endpoint.timeoutMs < 1) {
    throw new FleetGardenTargetRegistryError(
      `Fleet Garden target ${companionId} requires a positive integer endpoint timeout`,
    );
  }
  if (endpoint.mode === 'socket') {
    if (!endpoint.socketPath.trim()) {
      throw new FleetGardenTargetRegistryError(
        `Fleet Garden target ${companionId} requires a non-empty admin transport socket path`,
      );
    }
    return Object.freeze({
      mode: 'socket' as const,
      socketPath: endpoint.socketPath,
      timeoutMs: endpoint.timeoutMs,
    });
  }
  if (endpoint.httpUrl.protocol !== 'https:' || endpoint.wsUrl.protocol !== 'wss:') {
    throw new FleetGardenTargetRegistryError(
      `Fleet Garden target ${companionId} network endpoint must use https/wss with mTLS`,
    );
  }
  const tls = endpoint.tls;
  if (!tls.caPath.trim() || !tls.certPath.trim() || !tls.keyPath.trim()
    || !tls.expectedPeerSpiffeUri.trim()) {
    throw new FleetGardenTargetRegistryError(
      `Fleet Garden target ${companionId} network endpoint requires complete mTLS material`,
    );
  }
  return Object.freeze({
    mode: 'network' as const,
    httpUrl: new URL(endpoint.httpUrl.toString()),
    wsUrl: new URL(endpoint.wsUrl.toString()),
    timeoutMs: endpoint.timeoutMs,
    peerAuthMode: endpoint.peerAuthMode,
    tls: Object.freeze({ ...tls }),
  });
}

/**
 * The immutable fleet target registry. Built once from validated fleet
 * configuration; an incomplete, colliding, or malformed registry fails
 * construction instead of starting a Garden that could route wrongly.
 * Routing identity never changes after construction; only the separate
 * health map mutates.
 */
export class FleetGardenTargetRegistry {
  private readonly targets: ReadonlyMap<string, FleetGardenTargetIdentity>;
  private readonly health = new Map<string, FleetGardenTargetHealth>();

  constructor(entries: readonly FleetGardenTargetRegistryEntryInput[]) {
    if (entries.length === 0) {
      throw new FleetGardenTargetRegistryError(
        'Fleet Garden target registry requires at least one companion target',
      );
    }
    const targets = new Map<string, FleetGardenTargetIdentity>();
    const endpointKeys = new Set<string>();
    for (const entry of entries) {
      const companionId = createCompanionId(entry.companionId, 'Fleet Garden target companionId');
      if (!LOWERCASE_RFC4122_COMPANION_ID_PATTERN.test(companionId)) {
        throw new FleetGardenTargetRegistryError(
          'Fleet Garden target companionId must be one lowercase RFC-4122 UUID',
        );
      }
      if (targets.has(companionId)) {
        throw new FleetGardenTargetRegistryError(
          `Fleet Garden target registry contains duplicate companion ${companionId}`,
        );
      }
      const endpoint = freezeEndpoint(entry.endpoint, companionId);
      const collisionKey = endpointCollisionKey(endpoint);
      if (endpointKeys.has(collisionKey)) {
        throw new FleetGardenTargetRegistryError(
          `Fleet Garden target registry contains colliding endpoint for companion ${companionId}`,
        );
      }
      endpointKeys.add(collisionKey);
      targets.set(companionId, Object.freeze({
        companionId,
        endpoint,
        expectedAgentAudience: `agent:${companionId}` as const,
      }));
      this.health.set(companionId, INITIAL_HEALTH);
    }
    this.targets = targets;
  }

  companionIds(): readonly CompanionId[] {
    return Object.freeze([...this.targets.values()].map(target => target.companionId));
  }

  has(companionId: string): boolean {
    return this.targets.has(companionId);
  }

  /**
   * Resolve one immutable target identity. Unknown selections throw — the
   * registry never synthesizes an entry and never falls back to another
   * companion.
   */
  resolve(companionId: CompanionId): FleetGardenTargetIdentity {
    const target = this.targets.get(companionId);
    if (!target) {
      throw new FleetGardenTargetRegistryError(
        'Unknown Fleet Garden companion target',
      );
    }
    return target;
  }

  /** Record health for a registered target. Health can never alter identity. */
  reportHealth(companionId: CompanionId, health: FleetGardenTargetHealth): void {
    if (!this.targets.has(companionId)) {
      throw new FleetGardenTargetRegistryError(
        'Cannot report health for an unknown Fleet Garden companion target',
      );
    }
    this.health.set(companionId, Object.freeze({ ...health }));
  }

  healthOf(companionId: CompanionId): FleetGardenTargetHealth {
    const health = this.health.get(companionId);
    if (!health || !this.targets.has(companionId)) {
      throw new FleetGardenTargetRegistryError(
        'Unknown Fleet Garden companion target',
      );
    }
    return health;
  }

  /** Per-target readiness snapshot. Every registered companion appears independently. */
  readiness(): readonly FleetGardenTargetReadiness[] {
    return Object.freeze([...this.targets.values()].map(target => Object.freeze({
      companionId: target.companionId,
      health: this.healthOf(target.companionId),
    })));
  }
}

/**
 * Derive socket-mode target entries for every fleet companion from the
 * validated companion ID alone (`garden-admin-<companionId>.sock`). No
 * manifest path overrides and no delimiter-packed endpoint env variables are
 * accepted — the naming scheme in `resolveCompanionAdminTransportSocketPath`
 * is the single source of endpoint truth for local supervisor topology.
 */
export function deriveFleetGardenSocketTargets(
  fleet: { readonly companions: ReadonlyArray<
    Pick<ResolvedCompanionsFleetConfig['companions'][number], 'companionId'>
  >; },
  env: NodeJS.ProcessEnv = process.env,
): FleetGardenTargetRegistryEntryInput[] {
  return fleet.companions.map(companion => ({
    companionId: companion.companionId,
    endpoint: {
      mode: 'socket' as const,
      socketPath: resolveCompanionAdminTransportSocketPath(companion.companionId, env),
      timeoutMs: DEFAULT_ADMIN_TRANSPORT_TIMEOUT_MS,
    },
  }));
}
