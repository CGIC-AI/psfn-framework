import type { ResolvedCompanionsFleetConfig } from '../../system/config/companions-config.js';
import { parseOptionalStringEnv } from '../../shared/utils/env.js';
import {
  requireMtlsPeerFileConfig,
  type RequiredMtlsPeerFileConfig,
} from '../../shared/net/mtls.js';
import { createCompanionId, type CompanionId } from '../../shared/routing/companion-id.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';

export interface FleetSsoGardenUpstream {
  readonly companionId: CompanionId;
  readonly origin: URL;
  readonly tls?: RequiredMtlsPeerFileConfig;
}

export const FLEET_SSO_COMPANION_ROUTE_PREFIX = '/companions/';
export const FLEET_SSO_GARDEN_ROUTE_MARKER = '/garden';

/**
 * Companion-scoped Garden route parsing failure. `invalid_target` marks a
 * request target that is malformed at the protocol level; `not_found` marks a
 * target under the companion prefix whose selection is malformed or unknown.
 * Both must surface as generic denials that never reveal whether a companion
 * exists.
 */
export class CompanionScopedGardenRouteError extends Error {
  constructor(readonly code: 'invalid_target' | 'not_found', message: string) {
    super(message);
    this.name = 'CompanionScopedGardenRouteError';
  }
}

export interface ParsedFleetSsoOuterTarget {
  readonly rawPath: string;
  readonly rawQuery: string;
}

/**
 * One immutable, server-derived companion selection parsed from a canonical
 * `/companions/<companionId>/garden/...` request target. This is the single
 * parser shared by the gateway router and the fleet Garden control plane so
 * both hops bind exactly the same companion for the same bytes.
 */
export interface CompanionScopedGardenRoute {
  readonly companionId: CompanionId;
  /** Inner Garden target (path plus optional query) the capability is compiled over. */
  readonly innerTarget: string;
  /** The public route prefix (`/companions/<companionId>/garden`). */
  readonly publicPrefix: string;
}

/**
 * Split an origin-form request target into path and query, failing closed on
 * fragments, backslashes, encoded separators, duplicate slashes, and dot
 * segments before any companion selection or route matching happens.
 */
export function parseFleetSsoOuterTarget(rawTarget: string): ParsedFleetSsoOuterTarget {
  if (!rawTarget.startsWith('/') || rawTarget.startsWith('//') || rawTarget.includes('#')
    || rawTarget.includes('\\') || /%2f|%5c/iu.test(rawTarget)) {
    throw new CompanionScopedGardenRouteError('invalid_target', 'Request target is invalid');
  }
  const question = rawTarget.indexOf('?');
  const rawPath = question < 0 ? rawTarget : rawTarget.slice(0, question);
  const rawQuery = question < 0 ? '' : rawTarget.slice(question + 1);
  if (rawQuery.includes('?') || rawPath.includes('//') || /(?:^|\/)\.\.?($|\/)/u.test(rawPath)) {
    throw new CompanionScopedGardenRouteError('invalid_target', 'Request target is invalid');
  }
  return Object.freeze({ rawPath, rawQuery });
}

/**
 * Parse one companion-scoped Garden route. Returns `undefined` when the target
 * is not under the companion prefix; throws `CompanionScopedGardenRouteError`
 * when the target is malformed or the companion selection is not one exact
 * lowercase RFC-4122 UUID followed by the Garden marker.
 */
export function parseCompanionScopedGardenRoute(
  rawTarget: string,
): CompanionScopedGardenRoute | undefined {
  const { rawPath, rawQuery } = parseFleetSsoOuterTarget(rawTarget);
  if (!rawPath.startsWith(FLEET_SSO_COMPANION_ROUTE_PREFIX)) return undefined;
  const rest = rawPath.slice(FLEET_SSO_COMPANION_ROUTE_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) {
    throw new CompanionScopedGardenRouteError('not_found', 'Resource not found');
  }
  const rawCompanionId = rest.slice(0, slash);
  const afterCompanion = rest.slice(slash);
  if (!isRfc4122Uuid(rawCompanionId)
    || !afterCompanion.startsWith(FLEET_SSO_GARDEN_ROUTE_MARKER)
    || (afterCompanion.length > FLEET_SSO_GARDEN_ROUTE_MARKER.length
      && afterCompanion[FLEET_SSO_GARDEN_ROUTE_MARKER.length] !== '/')) {
    throw new CompanionScopedGardenRouteError('not_found', 'Resource not found');
  }
  const gardenPath = afterCompanion.slice(FLEET_SSO_GARDEN_ROUTE_MARKER.length) || '/';
  return Object.freeze({
    companionId: createCompanionId(rawCompanionId, 'companion-scoped Garden route companionId'),
    innerTarget: rawQuery ? `${gardenPath}?${rawQuery}` : gardenPath,
    publicPrefix: `${FLEET_SSO_COMPANION_ROUTE_PREFIX}${rawCompanionId}${FLEET_SSO_GARDEN_ROUTE_MARKER}`,
  });
}

export const FLEET_SSO_GARDEN_HOST_ENV = 'FLEET_SSO_GARDEN_HOST';
export const FLEET_SSO_GARDEN_TLS_CA_PATH_ENV = 'FLEET_SSO_GARDEN_TLS_CA_PATH';
export const FLEET_SSO_GARDEN_TLS_CERT_PATH_ENV = 'FLEET_SSO_GARDEN_TLS_CERT_PATH';
export const FLEET_SSO_GARDEN_TLS_KEY_PATH_ENV = 'FLEET_SSO_GARDEN_TLS_KEY_PATH';
export const FLEET_SSO_GARDEN_TLS_EXPECTED_PEER_SPIFFE_URI_ENV =
  'FLEET_SSO_GARDEN_TLS_EXPECTED_PEER_SPIFFE_URI';
export const FLEET_SSO_GARDEN_TLS_SERVER_NAME_ENV = 'FLEET_SSO_GARDEN_TLS_SERVER_NAME';

export function resolveFleetSsoGardenTls(
  env: NodeJS.ProcessEnv,
): RequiredMtlsPeerFileConfig | undefined {
  const caPath = parseOptionalStringEnv(env[FLEET_SSO_GARDEN_TLS_CA_PATH_ENV]);
  const certPath = parseOptionalStringEnv(env[FLEET_SSO_GARDEN_TLS_CERT_PATH_ENV]);
  const keyPath = parseOptionalStringEnv(env[FLEET_SSO_GARDEN_TLS_KEY_PATH_ENV]);
  const expectedPeerSpiffeUri = parseOptionalStringEnv(
    env[FLEET_SSO_GARDEN_TLS_EXPECTED_PEER_SPIFFE_URI_ENV],
  );
  const serverName = parseOptionalStringEnv(env[FLEET_SSO_GARDEN_TLS_SERVER_NAME_ENV]);
  const configured = [caPath, certPath, keyPath, expectedPeerSpiffeUri].filter(Boolean).length;
  if (configured === 0) {
    if (serverName) {
      throw new Error(`${FLEET_SSO_GARDEN_TLS_SERVER_NAME_ENV} requires Fleet SSO Garden TLS`);
    }
    return undefined;
  }
  if (configured !== 4) {
    throw new Error(
      'Fleet SSO Garden TLS requires CA, certificate, key, and expected peer SPIFFE URI',
    );
  }
  return requireMtlsPeerFileConfig({
    caPath,
    certPath,
    keyPath,
    expectedPeerSpiffeUri,
    serverName,
  }, 'Fleet SSO Garden TLS');
}

export function resolveFleetSsoGardenUpstreams(input: {
  fleet?: ResolvedCompanionsFleetConfig;
  companionId?: string;
  gardenPort?: number;
  env: NodeJS.ProcessEnv;
}): FleetSsoGardenUpstream[] {
  const host = parseOptionalStringEnv(input.env[FLEET_SSO_GARDEN_HOST_ENV]) ?? '127.0.0.1';
  if (host.includes('/') || host.includes('@') || host.includes('?') || host.includes('#')) {
    throw new Error(`${FLEET_SSO_GARDEN_HOST_ENV} must be a bare host name or address`);
  }
  const tls = resolveFleetSsoGardenTls(input.env);
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!loopback && !tls) {
    throw new Error('Non-loopback Fleet SSO Garden upstream requires configured mTLS');
  }
  if (!input.fleet && input.companionId && !isRfc4122Uuid(input.companionId)) {
    throw new Error('Fleet SSO companionId must be one lowercase RFC4122 UUID');
  }
  const companions = input.fleet?.companions ?? (input.companionId && input.gardenPort
    ? [{
        companionId: createCompanionId(input.companionId, 'Fleet SSO companionId'),
        gardenPort: input.gardenPort,
      }]
    : []);
  const upstreams = companions.flatMap((companion) => {
    if (companion.gardenPort === undefined) return [];
    const bracketedHost = host.includes(':') ? `[${host}]` : host;
    return [{
      companionId: companion.companionId,
      origin: new URL(`${tls ? 'https' : 'http'}://${bracketedHost}:${companion.gardenPort}`),
      ...(tls ? { tls } : {}),
    }];
  });
  if (upstreams.length === 0) {
    throw new Error('Fleet auth requires at least one companion with a Garden port');
  }
  return upstreams;
}
