import type { IncomingMessage } from 'node:http';
import { isLoopbackHost } from '../../shared/net/hosts.js';
import type { FleetAuthConfig } from '../../system/config/fleet-auth-config.js';
import { resolveFleetLocalOperatorSubject } from './fleet-auth-broker.js';

const FLEET_AUTH_SESSION_COOKIE_NAME = '__Host-psfn_session';
export const FLEET_LOCAL_OPERATOR_SESSION_COOKIE_NAME = 'psfn_local_operator_session';
export const FLEET_LOCAL_OPERATOR_LOGIN_PATH = '/v1/fleet-auth/local-operator-login';

const OPAQUE_SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface FleetLocalOperatorLoginConfig {
  readonly adminToken: string;
  readonly allowedOrigins: readonly string[];
}

export interface FleetLocalOperatorLoginRegistration {
  readonly loginPath: string;
  readonly allowedOrigins: readonly string[];
}

export type FleetBrowserSession = Readonly<{
  token: string;
  kind: 'canonical' | 'local_operator';
}>;

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function cookieValues(raw: string, name: string): string[] {
  const values: string[] = [];
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    if (value) values.push(value);
  }
  return values;
}

export function readFleetBrowserSession(
  request: Pick<IncomingMessage, 'headers'>,
  localOperatorEnabled: boolean,
): FleetBrowserSession | undefined {
  const raw = singleHeader(request.headers.cookie);
  if (!raw) return undefined;
  const canonical = cookieValues(raw, FLEET_AUTH_SESSION_COOKIE_NAME);
  const local = localOperatorEnabled
    ? cookieValues(raw, FLEET_LOCAL_OPERATOR_SESSION_COOKIE_NAME)
    : [];
  if (canonical.length + local.length !== 1) return undefined;
  const value = canonical[0] ?? local[0];
  if (!value || !OPAQUE_SESSION_PATTERN.test(value)) return undefined;
  return Object.freeze({
    token: value,
    kind: canonical.length === 1 ? 'canonical' : 'local_operator',
  });
}

export function validateFleetLocalOperatorOrigins(origins: readonly string[]): readonly string[] {
  if (origins.length === 0) {
    throw new Error('Fleet local operator login requires at least one loopback browser origin');
  }
  const normalized = origins.map((origin) => {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('Fleet local operator login origin is invalid');
    }
    if (parsed.origin !== origin
      || parsed.protocol !== 'http:'
      || !isLoopbackHost(parsed.hostname)
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
      || !parsed.port) {
      throw new Error('Fleet local operator login origins must be exact loopback HTTP origins with a port');
    }
    return parsed.origin;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Fleet local operator login origins must be unique');
  }
  return Object.freeze(normalized);
}

export function fleetLocalOperatorOriginAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  return origin !== undefined && allowedOrigins.includes(origin);
}

export function resolveFleetLocalOperatorLoginConfig(options: {
  enabled: boolean;
  trustProxy: boolean;
  adminToken?: string;
  rawAllowedOrigins?: string;
  fleetAuth: FleetAuthConfig;
}): FleetLocalOperatorLoginConfig | undefined {
  if (!options.enabled) return undefined;
  if (!options.trustProxy) {
    throw new Error('Fleet local operator login requires the trusted gateway ingress');
  }
  const adminToken = options.adminToken?.trim();
  if (!adminToken) {
    throw new Error('Fleet local operator login requires ADMIN_TOKEN');
  }
  resolveFleetLocalOperatorSubject(options.fleetAuth);
  const origins = (options.rawAllowedOrigins ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
  return Object.freeze({
    adminToken,
    allowedOrigins: validateFleetLocalOperatorOrigins(origins),
  });
}
