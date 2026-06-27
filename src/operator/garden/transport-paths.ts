import { dirname, join } from 'node:path';
import { DEFAULT_GATEWAY_SOCKET_PATH } from '../../system/security/policy-constants.js';
import { parseOptionalPositiveIntEnv, parseOptionalStringEnv } from '../../shared/utils/env.js';

export const DEFAULT_ADMIN_TRANSPORT_SOCKET_BASENAME = 'garden-admin.sock';
export const DEFAULT_ADMIN_TRANSPORT_TIMEOUT_MS = 15_000;

export type GardenAdminTransportMode = 'socket' | 'network';
export type GardenAdminTransportPeerAuthMode = 'none';

export interface GardenAdminTransportSocketEndpoint {
  mode: 'socket';
  socketPath: string;
  timeoutMs: number;
}

export interface GardenAdminTransportTlsClientConfig {
  caPath?: string;
}

export interface GardenAdminTransportNetworkClientEndpoint {
  mode: 'network';
  httpUrl: URL;
  wsUrl: URL;
  timeoutMs: number;
  peerAuthMode: GardenAdminTransportPeerAuthMode;
  tls?: GardenAdminTransportTlsClientConfig;
}

export type GardenAdminTransportClientEndpoint =
  | GardenAdminTransportSocketEndpoint
  | GardenAdminTransportNetworkClientEndpoint;

export interface GardenAdminTransportTlsServerConfig {
  certPath: string;
  keyPath: string;
}

export interface GardenAdminTransportNetworkServerEndpoint {
  mode: 'network';
  host: string;
  port: number;
  scheme: 'http' | 'https';
  timeoutMs: number;
  peerAuthMode: GardenAdminTransportPeerAuthMode;
  tls?: GardenAdminTransportTlsServerConfig;
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
  const caPath = parseOptionalStringEnv(env.ADMIN_TRANSPORT_TLS_CA_PATH);
  return {
    mode: 'network',
    httpUrl,
    wsUrl: toAdminTransportWebSocketUrl(httpUrl),
    timeoutMs: resolveAdminTransportTimeoutMs(env),
    peerAuthMode: resolveAdminTransportPeerAuthMode(env),
    ...(caPath ? { tls: { caPath } } : {}),
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

  const certPath = parseOptionalStringEnv(env.ADMIN_TRANSPORT_TLS_CERT_PATH);
  const keyPath = parseOptionalStringEnv(env.ADMIN_TRANSPORT_TLS_KEY_PATH);
  if ((certPath && !keyPath) || (!certPath && keyPath)) {
    throw new Error(
      'ADMIN_TRANSPORT_TLS_CERT_PATH and ADMIN_TRANSPORT_TLS_KEY_PATH must be set together',
    );
  }

  return {
    mode: 'network',
    host,
    port,
    scheme: certPath && keyPath ? 'https' : 'http',
    timeoutMs: resolveAdminTransportTimeoutMs(env),
    peerAuthMode: resolveAdminTransportPeerAuthMode(env),
    ...(certPath && keyPath ? { tls: { certPath, keyPath } } : {}),
  };
}

function resolveAdminTransportTimeoutMs(env: NodeJS.ProcessEnv): number {
  return parseOptionalPositiveIntEnv(env.ADMIN_TRANSPORT_TIMEOUT_MS)
    ?? DEFAULT_ADMIN_TRANSPORT_TIMEOUT_MS;
}

function rejectNetworkOnlyClientEnv(env: NodeJS.ProcessEnv): void {
  const url = parseOptionalStringEnv(env.ADMIN_TRANSPORT_URL);
  const caPath = parseOptionalStringEnv(env.ADMIN_TRANSPORT_TLS_CA_PATH);
  const peerAuthMode = parseOptionalStringEnv(env.ADMIN_TRANSPORT_PEER_AUTH_MODE);
  if (url || caPath || peerAuthMode) {
    throw new Error(
      'ADMIN_TRANSPORT_URL, ADMIN_TRANSPORT_TLS_CA_PATH, and ADMIN_TRANSPORT_PEER_AUTH_MODE require ADMIN_TRANSPORT_MODE=network',
    );
  }
}

function rejectNetworkOnlyServerEnv(env: NodeJS.ProcessEnv): void {
  const listenHost = parseOptionalStringEnv(env.ADMIN_TRANSPORT_LISTEN_HOST);
  const listenPort = parseOptionalStringEnv(env.ADMIN_TRANSPORT_LISTEN_PORT);
  const certPath = parseOptionalStringEnv(env.ADMIN_TRANSPORT_TLS_CERT_PATH);
  const keyPath = parseOptionalStringEnv(env.ADMIN_TRANSPORT_TLS_KEY_PATH);
  const peerAuthMode = parseOptionalStringEnv(env.ADMIN_TRANSPORT_PEER_AUTH_MODE);
  if (listenHost || listenPort || certPath || keyPath || peerAuthMode) {
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
    throw new Error(`${envName} must be a valid http or https URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${envName} must use http or https`);
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
  if (!rawMode) return 'none';
  const normalized = rawMode.toLowerCase();
  if (normalized === 'none') return 'none';
  throw new Error(
    `Unsupported ADMIN_TRANSPORT_PEER_AUTH_MODE=${rawMode}; psfn-framework-z49b owns mTLS/SPIFFE peer authorization`,
  );
}
