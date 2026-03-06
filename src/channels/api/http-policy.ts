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

export function normalizeCorsAllowedOrigins(origins: readonly string[] | undefined): Set<string> {
  const normalized = new Set<string>();
  if (!origins) return normalized;

  for (const origin of origins) {
    const trimmed = origin.trim();
    if (!trimmed || trimmed === '*') continue;
    normalized.add(trimmed);
  }

  return normalized;
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
  corsAllowedOrigins: ReadonlySet<string>,
  existingVaryHeader: unknown,
): CorsPolicyDecision {
  const origin = clampHttpHeader(singleHeader(req.headers.origin), 512);
  if (!origin) {
    return { ok: true };
  }

  if (!corsAllowedOrigins.has(origin)) {
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
      'Access-Control-Allow-Origin': origin,
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
