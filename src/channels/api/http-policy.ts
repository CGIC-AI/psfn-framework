import type { IncomingMessage } from 'node:http';
import {
  getBearerToken,
  getCookieValue,
  getBearerPrincipal,
  INSECURE_LOCAL_API_PRINCIPAL,
  isExpectedApiToken,
  principalFromApiKeyToken,
  principalFromSatelliteApiKeyToken,
  type ApiAuthPrincipal,
} from '../backplane/http/auth.js';
import { isLoopbackHost } from '../../shared/net/hosts.js';

export { isLoopbackHost } from '../../shared/net/hosts.js';

export const API_CORS_ALLOWED_METHODS = 'GET, POST, OPTIONS';
export const API_CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Title',
  'HTTP-Referer',
  'X-Session-ID',
  'X-User-ID',
  'X-User-Name',
  'X-Channel-Privacy',
  'X-Channel-ID',
  'X-PSFN-Channel-Type',
  'X-PSFN-Channel-ID',
  'X-PSFN-Author-ID',
  'X-PSFN-Author-Name',
  'X-PSFN-Satellite-Claim-Type',
  'X-PSFN-Satellite-ID',
  'X-PSFN-Satellite-Endpoint-ID',
  'X-PSFN-Satellite-Session-ID',
  'X-PSFN-Satellite-Thread-ID',
  'X-PSFN-Satellite-Capabilities',
  'X-PSFN-Satellite-Telemetry-Scopes',
  'X-PSFN-Client-Cert-Fingerprint-SHA256',
  'X-PSFN-Client-Cert-SPKI-SHA256',
  'X-PSFN-Client-Cert-Subject',
  'X-PSFN-Client-Cert-SAN',
  'X-Broadcast-Approval-Token',
  'X-Broadcast-Visibility-Scope',
  'X-Canonical-Contact-ID',
  'X-Identity-Claim-Channel',
  'X-Identity-Claim-User-ID',
  'X-Identity-Claim-Nonce',
  'X-Identity-Claim-Expires',
  'X-Identity-Claim-Signature',
] as const;

export interface PolicyError {
  status: number;
  type: string;
  message: string;
}

export interface CorsPolicyAllowed {
  ok: true;
  headers?: Record<string, string>;
}

export interface CorsPolicyDenied {
  ok: false;
  error: PolicyError;
}

export type CorsPolicyDecision = CorsPolicyAllowed | CorsPolicyDenied;

export interface PrincipalResolutionSuccess {
  ok: true;
  principal: ApiAuthPrincipal;
}

export interface PrincipalResolutionFailure {
  ok: false;
  error: PolicyError;
}

export type PrincipalResolution = PrincipalResolutionSuccess | PrincipalResolutionFailure;

export interface ResolveApiPrincipalOptions {
  apiKey?: string;
  alternateApiToken?: string;
  alternateCookieTokenNames?: readonly string[];
  /**
   * Per-satellite credentials (`API_SATELLITE_KEYS`). Each key resolves to a
   * DISTINCT satellite-scoped principal id so `satellites.json`
   * `auth.apiKeyPrincipalIds` can isolate endpoints from each other
   * (Sprint-10 finding H4).
   */
  satelliteApiKeys?: readonly string[];
  allowInsecureWithoutAuth: boolean;
  isTelemetryIngest: boolean;
}

interface ParsedCorsOrigin {
  origin: string;
  protocol: 'http:' | 'https:';
  hostname: string;
  port: string;
}

export interface ResolveApiCorsAllowedOriginsOptions {
  explicitAllowlist?: readonly string[];
  adminHost?: string;
  adminPort?: number;
}

export interface CorsWildcardHostPattern {
  protocol: 'http:' | 'https:';
  hostnameSuffix: string;
  port: string;
}

interface CorsSameRequestHostPattern {
  protocol: 'http:' | 'https:';
  port: string;
}

export interface CorsAllowedOrigins {
  exactOrigins: ReadonlySet<string>;
  wildcardHostPatterns: readonly CorsWildcardHostPattern[];
  sameRequestHostPatterns: readonly CorsSameRequestHostPattern[];
}

const DEFAULT_ADMIN_HOST = '127.0.0.1';
const UNSAFE_ADMIN_BIND_HOSTS = new Set(['*', '0.0.0.0', '::', '[::]']);
const LOOPBACK_ADMIN_HOST_ALIASES = ['localhost', '127.0.0.1', '[::1]'] as const;
const SAME_REQUEST_HOST_ORIGIN_TOKEN_PREFIX = 'psfn+same-request-host://';

function parseHttpOrigin(value: string): ParsedCorsOrigin | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  if (!parsed.hostname || parsed.username || parsed.password) {
    return null;
  }

  return {
    origin: parsed.origin,
    protocol: parsed.protocol,
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port,
  };
}

function matchesWildcardHostPattern(origin: ParsedCorsOrigin, pattern: CorsWildcardHostPattern): boolean {
  if (pattern.protocol !== origin.protocol) return false;
  if (pattern.port !== origin.port) return false;

  if (origin.hostname === pattern.hostnameSuffix) {
    return false;
  }

  return origin.hostname.endsWith(`.${pattern.hostnameSuffix}`);
}

function parseRequestHostHeader(
  hostHeader: string,
  protocol: 'http:' | 'https:',
): ParsedCorsOrigin | null {
  const trimmed = hostHeader.trim();
  if (!trimmed) return null;

  if (
    trimmed.includes('://')
    || trimmed.includes('/')
    || trimmed.includes('?')
    || trimmed.includes('#')
    || trimmed.includes('@')
  ) {
    return null;
  }

  return parseHttpOrigin(`${protocol}//${trimmed}`);
}

function parseSameRequestHostOriginToken(value: string): CorsSameRequestHostPattern | null {
  if (!value.startsWith(SAME_REQUEST_HOST_ORIGIN_TOKEN_PREFIX)) {
    return null;
  }

  const payload = value.slice(SAME_REQUEST_HOST_ORIGIN_TOKEN_PREFIX.length);
  const separatorIndex = payload.indexOf(':');
  if (separatorIndex <= 0) {
    return null;
  }

  const protocolToken = payload.slice(0, separatorIndex);
  const portToken = payload.slice(separatorIndex + 1);
  if ((protocolToken !== 'http' && protocolToken !== 'https') || !/^\d+$/.test(portToken)) {
    return null;
  }

  const port = Number.parseInt(portToken, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return null;
  }

  return {
    protocol: `${protocolToken}:`,
    port: String(port),
  };
}

function buildSameRequestHostOriginToken(protocol: 'http:' | 'https:', port: number): string {
  return `${SAME_REQUEST_HOST_ORIGIN_TOKEN_PREFIX}${protocol.slice(0, -1)}:${port}`;
}

function matchesSameRequestHostPattern(
  req: IncomingMessage,
  origin: ParsedCorsOrigin,
  pattern: CorsSameRequestHostPattern,
): boolean {
  if (pattern.protocol !== origin.protocol) return false;
  if (pattern.port !== origin.port) return false;

  const hostHeader = clampHttpHeader(singleHeader(req.headers.host), 512);
  if (!hostHeader) return false;

  const parsedHost = parseRequestHostHeader(hostHeader, origin.protocol);
  if (!parsedHost) return false;

  return parsedHost.hostname === origin.hostname;
}

function isCorsOriginAllowlisted(
  req: IncomingMessage,
  origin: ParsedCorsOrigin,
  allowlist: CorsAllowedOrigins,
): boolean {
  if (allowlist.exactOrigins.has(origin.origin)) {
    return true;
  }

  for (const pattern of allowlist.wildcardHostPatterns) {
    if (matchesWildcardHostPattern(origin, pattern)) {
      return true;
    }
  }

  for (const pattern of allowlist.sameRequestHostPatterns) {
    if (matchesSameRequestHostPattern(req, origin, pattern)) {
      return true;
    }
  }

  return false;
}

export function corsAllowlistIsEmpty(allowlist: CorsAllowedOrigins): boolean {
  return (
    allowlist.exactOrigins.size === 0
    && allowlist.wildcardHostPatterns.length === 0
    && allowlist.sameRequestHostPatterns.length === 0
  );
}

export function normalizeCorsAllowedOrigins(origins: readonly string[] | undefined): CorsAllowedOrigins {
  const exactOrigins = new Set<string>();
  const wildcardHostPatterns: CorsWildcardHostPattern[] = [];
  const sameRequestHostPatterns: CorsSameRequestHostPattern[] = [];
  const wildcardPatternKeys = new Set<string>();
  const sameRequestHostPatternKeys = new Set<string>();
  if (!origins) {
    return { exactOrigins, wildcardHostPatterns, sameRequestHostPatterns };
  }

  for (const origin of origins) {
    const trimmed = origin.trim();
    if (!trimmed || trimmed === '*') continue;

    const sameRequestHostPattern = parseSameRequestHostOriginToken(trimmed);
    if (sameRequestHostPattern) {
      const patternKey = `${sameRequestHostPattern.protocol}//$request-host:${sameRequestHostPattern.port}`;
      if (!sameRequestHostPatternKeys.has(patternKey)) {
        sameRequestHostPatternKeys.add(patternKey);
        sameRequestHostPatterns.push(sameRequestHostPattern);
      }
      continue;
    }

    const parsed = parseHttpOrigin(trimmed);
    if (!parsed || parsed.hostname === '*') continue;

    if (parsed.hostname.startsWith('*.')) {
      const hostnameSuffix = parsed.hostname.slice(2);
      if (!hostnameSuffix || hostnameSuffix.includes('*')) continue;

      const patternKey = `${parsed.protocol}//*.${hostnameSuffix}:${parsed.port}`;
      if (!wildcardPatternKeys.has(patternKey)) {
        wildcardPatternKeys.add(patternKey);
        wildcardHostPatterns.push({
          protocol: parsed.protocol,
          hostnameSuffix,
          port: parsed.port,
        });
      }
      continue;
    }

    if (parsed.hostname.includes('*')) continue;
    exactOrigins.add(parsed.origin);
  }

  return {
    exactOrigins,
    wildcardHostPatterns,
    sameRequestHostPatterns,
  };
}

function normalizeAdminHostForOrigin(host: string): string | null {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return null;
  if (UNSAFE_ADMIN_BIND_HOSTS.has(normalized)) return null;
  if (
    normalized.includes('://')
    || normalized.includes('/')
    || normalized.includes('?')
    || normalized.includes('#')
    || normalized.includes('*')
  ) {
    return null;
  }

  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    return normalized;
  }

  if (normalized.includes(':')) {
    return `[${normalized}]`;
  }

  return normalized;
}

function toLoopbackCandidate(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1);
  }
  return host;
}

function deriveAdminOriginHosts(adminHost: string | undefined): string[] {
  const normalizedHost = normalizeAdminHostForOrigin(adminHost ?? DEFAULT_ADMIN_HOST);
  if (!normalizedHost) return [];

  if (!isLoopbackHost(toLoopbackCandidate(normalizedHost))) {
    return [normalizedHost];
  }

  const hosts = [normalizedHost, ...LOOPBACK_ADMIN_HOST_ALIASES];
  return Array.from(new Set(hosts));
}

function isUnsafeAdminBindHost(adminHost: string | undefined): boolean {
  const normalized = (adminHost ?? DEFAULT_ADMIN_HOST).trim().toLowerCase();
  return UNSAFE_ADMIN_BIND_HOSTS.has(normalized);
}

export function resolveApiCorsAllowedOrigins(
  options: ResolveApiCorsAllowedOriginsOptions,
): string[] {
  const mergedOrigins: string[] = [];
  const deduped = new Set<string>();
  const addOrigin = (origin: string): void => {
    const trimmed = origin.trim();
    if (!trimmed || trimmed === '*') return;
    if (deduped.has(trimmed)) return;
    deduped.add(trimmed);
    mergedOrigins.push(trimmed);
  };

  for (const explicitOrigin of options.explicitAllowlist ?? []) {
    addOrigin(explicitOrigin);
  }

  if (
    !options.adminPort
    || !Number.isInteger(options.adminPort)
    || options.adminPort <= 0
    || options.adminPort > 65_535
  ) {
    return mergedOrigins;
  }

  for (const host of deriveAdminOriginHosts(options.adminHost)) {
    const parsed = parseHttpOrigin(`http://${host}:${options.adminPort}`);
    if (!parsed) continue;
    addOrigin(parsed.origin);
  }

  if (mergedOrigins.length === 0 && isUnsafeAdminBindHost(options.adminHost)) {
    addOrigin(buildSameRequestHostOriginToken('http:', options.adminPort));
  }

  return mergedOrigins;
}

export function singleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function clampHttpHeader(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

export function appendVaryValue(existing: unknown, value: string): string {
  const varyValues = new Set<string>();

  if (typeof existing === 'string') {
    for (const item of existing.split(',')) {
      const trimmed = item.trim();
      if (trimmed) varyValues.add(trimmed);
    }
  } else if (Array.isArray(existing)) {
    for (const item of existing) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed) varyValues.add(trimmed);
    }
  }

  varyValues.add(value);
  return Array.from(varyValues).join(', ');
}

export function evaluateCorsPolicy(
  req: IncomingMessage,
  corsAllowedOrigins: CorsAllowedOrigins,
  existingVaryHeader: unknown,
): CorsPolicyDecision {
  const origin = clampHttpHeader(singleHeader(req.headers.origin), 512);
  if (!origin) {
    return { ok: true };
  }

  const parsedOrigin = parseHttpOrigin(origin);
  if (!parsedOrigin || !isCorsOriginAllowlisted(req, parsedOrigin, corsAllowedOrigins)) {
    return {
      ok: false,
      error: {
        status: 403,
        type: 'cors_origin_not_allowed',
        message: 'Origin is not allowed by API_CORS_ALLOWLIST',
      },
    };
  }

  return {
    ok: true,
    headers: {
      Vary: appendVaryValue(existingVaryHeader, 'Origin'),
      'Access-Control-Allow-Origin': parsedOrigin.origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': API_CORS_ALLOWED_METHODS,
      'Access-Control-Allow-Headers': API_CORS_ALLOWED_HEADERS.join(', '),
      'Access-Control-Max-Age': '600',
    },
  };
}

export function resolveApiRequestPrincipal(
  req: IncomingMessage,
  options: ResolveApiPrincipalOptions,
): PrincipalResolution {
  const satelliteApiKeys = options.satelliteApiKeys ?? [];
  if (options.apiKey || satelliteApiKeys.length > 0) {
    if (options.apiKey) {
      const bearerPrincipal = getBearerPrincipal(req, options.apiKey)
        ?? (options.alternateApiToken ? getBearerPrincipal(req, options.alternateApiToken) : null);
      if (bearerPrincipal) {
        return { ok: true, principal: bearerPrincipal };
      }
    }
    const bearerToken = getBearerToken(req);
    for (const satelliteKey of satelliteApiKeys) {
      if (!isExpectedApiToken(bearerToken, satelliteKey)) continue;
      return { ok: true, principal: principalFromSatelliteApiKeyToken(satelliteKey) };
    }
    if (options.apiKey && options.alternateApiToken) {
      for (const cookieName of options.alternateCookieTokenNames ?? []) {
        const cookieToken = getCookieValue(req, cookieName);
        if (!isExpectedApiToken(cookieToken, options.alternateApiToken)) continue;
        return { ok: true, principal: principalFromApiKeyToken(options.alternateApiToken) };
      }
    }

    return {
      ok: false,
      error: {
        status: 401,
        type: 'invalid_api_key',
        message: 'Invalid or missing API key',
      },
    };
  }

  if (options.isTelemetryIngest) {
    return {
      ok: false,
      error: {
        status: 503,
        type: 'telemetry_auth_unconfigured',
        message: 'Telemetry ingestion requires API authentication to be configured',
      },
    };
  }

  if (options.allowInsecureWithoutAuth) {
    return {
      ok: true,
      principal: INSECURE_LOCAL_API_PRINCIPAL,
    };
  }

  return {
    ok: false,
    error: {
      status: 503,
      type: 'api_auth_unconfigured',
      message: 'API_KEY is required unless ALLOW_INSECURE_LOCAL_API=true',
    },
  };
}
