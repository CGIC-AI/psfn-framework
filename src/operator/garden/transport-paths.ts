import { dirname, join, resolve } from 'node:path';
import { DEFAULT_GATEWAY_SOCKET_PATH } from '../../system/security/policy-constants.js';
import { parseOptionalPositiveIntEnv, parseOptionalStringEnv } from '../../shared/utils/env.js';
import { normalizeSpiffeUri } from '../../shared/net/mtls.js';

export const DEFAULT_ADMIN_TRANSPORT_SOCKET_BASENAME = 'garden-admin.sock';
export const DEFAULT_ADMIN_TRANSPORT_TIMEOUT_MS = 15_000;
export const ADMIN_TRANSPORT_TLS_CA_PATH_ENV = 'ADMIN_TRANSPORT_TLS_CA_PATH';
export const ADMIN_TRANSPORT_TLS_CERT_PATH_ENV = 'ADMIN_TRANSPORT_TLS_CERT_PATH';
export const ADMIN_TRANSPORT_TLS_KEY_PATH_ENV = 'ADMIN_TRANSPORT_TLS_KEY_PATH';
export const ADMIN_TRANSPORT_TLS_EXPECTED_PEER_SPIFFE_URI_ENV = 'ADMIN_TRANSPORT_TLS_EXPECTED_PEER_SPIFFE_URI';

export type GardenAdminTransportMode = 'socket' | 'network';
export type GardenAdminTransportPeerAuthMode = 'mtls-spiffe';

export interface GardenAdminTransportSocketEndpoint {
  mode: 'socket';
  socketPath: string;
  timeoutMs: number;
}

export interface GardenAdminTransportTlsConfig {
  caPath: string;
  certPath: string;
  keyPath: string;
  expectedPeerSpiffeUri: string;
}

export interface GardenAdminTransportNetworkClientEndpoint {
  mode: 'network';
  httpUrl: URL;
  wsUrl: URL;
  timeoutMs: number;
  peerAuthMode: GardenAdminTransportPeerAuthMode;
  tls: GardenAdminTransportTlsConfig;
}

export type GardenAdminTransportClientEndpoint =
  | GardenAdminTransportSocketEndpoint
  | GardenAdminTransportNetworkClientEndpoint;

export type GardenAdminTransportTlsServerConfig = GardenAdminTransportTlsConfig;

export interface GardenAdminTransportNetworkServerEndpoint {
  mode: 'network';
  host: string;
  port: number;
  scheme: 'https';
  timeoutMs: number;
  peerAuthMode: GardenAdminTransportPeerAuthMode;
  tls: GardenAdminTransportTlsServerConfig;
}

export type GardenAdminTransportServerEndpoint =
  | GardenAdminTransportSocketEndpoint
  | GardenAdminTransportNetworkServerEndpoint;

export function resolveAdminTransportSocketPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicitSocketPath = parseOptionalStringEnv(env.ADMIN_TRANSPORT_SOCKET);
  if (explicitSocketPath) {
    return explicitSocketPath;
  }

  const gatewaySocketPath = parseOptionalStringEnv(env.GATEWAY_SOCKET)
    ?? DEFAULT_GATEWAY_SOCKET_PATH;
  return join(dirname(gatewaySocketPath), DEFAULT_ADMIN_TRANSPORT_SOCKET_BASENAME);
}

/**
 * Per-companion admin transport socket path (sprint-10 W4: one Garden per
 * companion). N agent processes cannot share one admin socket, so each
 * companion's admin transport binds `garden-admin-<companionId>.sock` in the
 * same directory the single-companion socket would live in (explicit
 * ADMIN_TRANSPORT_SOCKET, else the gateway socket directory). The supervisor
 * launcher exports the derived path as ADMIN_TRANSPORT_SOCKET for both the
 * companion's agent (server side) and its operator (client side), so this
 * function is the single source of the naming scheme.
 */
export function resolveCompanionAdminTransportSocketPath(
  companionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const trimmed = companionId.trim();
  if (!trimmed) {
    throw new Error('resolveCompanionAdminTransportSocketPath requires a non-empty companionId');
  }
  const baseSocketPath = resolveAdminTransportSocketPath(env);
  return join(dirname(baseSocketPath), `garden-admin-${trimmed}.sock`);
}

export function assertCompanionAdminTransportSocketPath(
  companionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const actual = resolveAdminTransportSocketPath(env);
  const expected = resolveCompanionAdminTransportSocketPath(companionId, env);
  if (resolve(actual) !== resolve(expected)) {
    throw new Error(
      `Multi-companion admin transport mismatch: expected ${expected} for companion `
      + `${JSON.stringify(companionId)}, got ${actual}`,
    );
  }
  return actual;
}

export function resolveAdminTransportMode(
  env: NodeJS.ProcessEnv = process.env,
): GardenAdminTransportMode {
  const rawMode = parseOptionalStringEnv(env.ADMIN_TRANSPORT_MODE);
  if (!rawMode) return 'socket';
  const normalized = rawMode.toLowerCase();
  if (normalized === 'socket' || normalized === 'unix') return 'socket';
  if (normalized === 'network') return 'network';
  throw new Error(
    `Invalid ADMIN_TRANSPORT_MODE=${rawMode}; expected socket, unix, or network`,
  );
}

export function resolveAdminTransportClientEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): GardenAdminTransportClientEndpoint {
  const mode = resolveAdminTransportMode(env);
  if (mode === 'socket') {
    rejectNetworkOnlyClientEnv(env);
    return {
      mode: 'socket',
      socketPath: resolveAdminTransportSocketPath(env),
      timeoutMs: resolveAdminTransportTimeoutMs(env),
    };
  }

  const httpUrl = parseAdminTransportHttpUrl(
    parseOptionalStringEnv(env.ADMIN_TRANSPORT_URL),
    'ADMIN_TRANSPORT_URL',
  );
  return {
    mode: 'network',
    httpUrl,
    wsUrl: toAdminTransportWebSocketUrl(httpUrl),
    timeoutMs: resolveAdminTransportTimeoutMs(env),
    peerAuthMode: resolveAdminTransportPeerAuthMode(env),
    tls: resolveAdminTransportTlsConfig(env),
  };
}

export function resolveAdminTransportServerEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): GardenAdminTransportServerEndpoint {
  const mode = resolveAdminTransportMode(env);
  if (mode === 'socket') {
    rejectNetworkOnlyServerEnv(env);
    return {
      mode: 'socket',
      socketPath: resolveAdminTransportSocketPath(env),
      timeoutMs: resolveAdminTransportTimeoutMs(env),
    };
  }

  const host = parseOptionalStringEnv(env.ADMIN_TRANSPORT_LISTEN_HOST);
  if (!host) {
    throw new Error('ADMIN_TRANSPORT_LISTEN_HOST is required when ADMIN_TRANSPORT_MODE=network');
  }

  const port = parseOptionalPositiveIntEnv(env.ADMIN_TRANSPORT_LISTEN_PORT);
  if (!port) {
    throw new Error('ADMIN_TRANSPORT_LISTEN_PORT is required when ADMIN_TRANSPORT_MODE=network');
  }

  return {
    mode: 'network',
    host,
    port,
    scheme: 'https',
    timeoutMs: resolveAdminTransportTimeoutMs(env),
    peerAuthMode: resolveAdminTransportPeerAuthMode(env),
    tls: resolveAdminTransportTlsConfig(env),
  };
}

function resolveAdminTransportTimeoutMs(env: NodeJS.ProcessEnv): number {
  return parseOptionalPositiveIntEnv(env.ADMIN_TRANSPORT_TIMEOUT_MS)
    ?? DEFAULT_ADMIN_TRANSPORT_TIMEOUT_MS;
}

function rejectNetworkOnlyClientEnv(env: NodeJS.ProcessEnv): void {
  const url = parseOptionalStringEnv(env.ADMIN_TRANSPORT_URL);
  const caPath = parseOptionalStringEnv(env[ADMIN_TRANSPORT_TLS_CA_PATH_ENV]);
  const certPath = parseOptionalStringEnv(env[ADMIN_TRANSPORT_TLS_CERT_PATH_ENV]);
  const keyPath = parseOptionalStringEnv(env[ADMIN_TRANSPORT_TLS_KEY_PATH_ENV]);
  const expectedPeerSpiffeUri = parseOptionalStringEnv(env[ADMIN_TRANSPORT_TLS_EXPECTED_PEER_SPIFFE_URI_ENV]);
  const peerAuthMode = parseOptionalStringEnv(env.ADMIN_TRANSPORT_PEER_AUTH_MODE);
  if (url || caPath || certPath || keyPath || expectedPeerSpiffeUri || peerAuthMode) {
    throw new Error(
      'ADMIN_TRANSPORT_URL, ADMIN_TRANSPORT_TLS_*, and ADMIN_TRANSPORT_PEER_AUTH_MODE require ADMIN_TRANSPORT_MODE=network',
    );
  }
}

function rejectNetworkOnlyServerEnv(env: NodeJS.ProcessEnv): void {
  const listenHost = parseOptionalStringEnv(env.ADMIN_TRANSPORT_LISTEN_HOST);
  const listenPort = parseOptionalStringEnv(env.ADMIN_TRANSPORT_LISTEN_PORT);
  const caPath = parseOptionalStringEnv(env[ADMIN_TRANSPORT_TLS_CA_PATH_ENV]);
  const certPath = parseOptionalStringEnv(env[ADMIN_TRANSPORT_TLS_CERT_PATH_ENV]);
  const keyPath = parseOptionalStringEnv(env[ADMIN_TRANSPORT_TLS_KEY_PATH_ENV]);
  const expectedPeerSpiffeUri = parseOptionalStringEnv(env[ADMIN_TRANSPORT_TLS_EXPECTED_PEER_SPIFFE_URI_ENV]);
  const peerAuthMode = parseOptionalStringEnv(env.ADMIN_TRANSPORT_PEER_AUTH_MODE);
  if (listenHost || listenPort || caPath || certPath || keyPath || expectedPeerSpiffeUri || peerAuthMode) {
    throw new Error(
      'ADMIN_TRANSPORT_LISTEN_*, ADMIN_TRANSPORT_TLS_*, and ADMIN_TRANSPORT_PEER_AUTH_MODE require ADMIN_TRANSPORT_MODE=network',
    );
  }
}

function parseAdminTransportHttpUrl(rawUrl: string | undefined, envName: string): URL {
  if (!rawUrl) {
    throw new Error(`${envName} is required when ADMIN_TRANSPORT_MODE=network`);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${envName} must be a valid https URL`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`${envName} must use https`);
  }
  if (!parsed.hostname) {
    throw new Error(`${envName} must include a host`);
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error(`${envName} must not include a path, query, or fragment`);
  }

  return parsed;
}

function toAdminTransportWebSocketUrl(httpUrl: URL): URL {
  const wsUrl = new URL(httpUrl.toString());
  wsUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return wsUrl;
}

function resolveAdminTransportPeerAuthMode(
  env: NodeJS.ProcessEnv,
): GardenAdminTransportPeerAuthMode {
  const rawMode = parseOptionalStringEnv(env.ADMIN_TRANSPORT_PEER_AUTH_MODE);
  if (!rawMode) return 'mtls-spiffe';
  const normalized = rawMode.toLowerCase();
  if (normalized === 'mtls-spiffe') return 'mtls-spiffe';
  throw new Error(
    `Unsupported ADMIN_TRANSPORT_PEER_AUTH_MODE=${rawMode}; expected mtls-spiffe`,
  );
}

function resolveAdminTransportTlsConfig(
  env: NodeJS.ProcessEnv,
): GardenAdminTransportTlsConfig {
  const caPath = parseOptionalStringEnv(env[ADMIN_TRANSPORT_TLS_CA_PATH_ENV]);
  const certPath = parseOptionalStringEnv(env[ADMIN_TRANSPORT_TLS_CERT_PATH_ENV]);
  const keyPath = parseOptionalStringEnv(env[ADMIN_TRANSPORT_TLS_KEY_PATH_ENV]);
  const expectedPeerSpiffeUri = parseOptionalStringEnv(env[ADMIN_TRANSPORT_TLS_EXPECTED_PEER_SPIFFE_URI_ENV]);
  if (!caPath || !certPath || !keyPath || !expectedPeerSpiffeUri) {
    throw new Error(
      `ADMIN_TRANSPORT_MODE=network requires ${ADMIN_TRANSPORT_TLS_CA_PATH_ENV}, `
        + `${ADMIN_TRANSPORT_TLS_CERT_PATH_ENV}, ${ADMIN_TRANSPORT_TLS_KEY_PATH_ENV}, `
        + `and ${ADMIN_TRANSPORT_TLS_EXPECTED_PEER_SPIFFE_URI_ENV}`,
    );
  }

  return {
    caPath,
    certPath,
    keyPath,
    expectedPeerSpiffeUri: normalizeSpiffeUri(
      expectedPeerSpiffeUri,
      ADMIN_TRANSPORT_TLS_EXPECTED_PEER_SPIFFE_URI_ENV,
    ),
  };
}
