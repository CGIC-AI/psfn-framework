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
