import type { IncomingMessage } from 'node:http';
import {
  getBearerPrincipal,
  INSECURE_LOCAL_API_PRINCIPAL,
  type ApiAuthPrincipal,
} from '../http/auth.js';

export const API_CORS_ALLOWED_METHODS = 'GET, POST, OPTIONS';
export const API_CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Session-ID',
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
  allowInsecureWithoutAuth: boolean;
  isTelemetryIngest: boolean;
}

interface ParsedCorsOrigin {
  origin: string;
  protocol: 'http:' | 'https:';
  hostname: string;
  port: string;
}

export interface CorsWildcardHostPattern {
  protocol: 'http:' | 'https:';
  hostnameSuffix: string;
  port: string;
}

export interface CorsAllowedOrigins {
  exactOrigins: ReadonlySet<string>;
  wildcardHostPatterns: readonly CorsWildcardHostPattern[];
}

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

function isCorsOriginAllowlisted(origin: ParsedCorsOrigin, allowlist: CorsAllowedOrigins): boolean {
  if (allowlist.exactOrigins.has(origin.origin)) {
    return true;
  }

  for (const pattern of allowlist.wildcardHostPatterns) {
    if (matchesWildcardHostPattern(origin, pattern)) {
      return true;
    }
  }

  return false;
}

export function corsAllowlistIsEmpty(allowlist: CorsAllowedOrigins): boolean {
  return allowlist.exactOrigins.size === 0 && allowlist.wildcardHostPatterns.length === 0;
}

export function normalizeCorsAllowedOrigins(origins: readonly string[] | undefined): CorsAllowedOrigins {
  const exactOrigins = new Set<string>();
  const wildcardHostPatterns: CorsWildcardHostPattern[] = [];
  const wildcardPatternKeys = new Set<string>();
  if (!origins) {
    return { exactOrigins, wildcardHostPatterns };
  }

  for (const origin of origins) {
    const trimmed = origin.trim();
    if (!trimmed || trimmed === '*') continue;

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
  };
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') return true;
  return normalized.startsWith('127.');
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
  if (!parsedOrigin || !isCorsOriginAllowlisted(parsedOrigin, corsAllowedOrigins)) {
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
  if (options.apiKey) {
    const principal = getBearerPrincipal(req, options.apiKey);
    if (!principal) {
      return {
        ok: false,
        error: {
          status: 401,
          type: 'invalid_api_key',
          message: 'Invalid or missing API key',
        },
      };
    }
    return { ok: true, principal };
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
