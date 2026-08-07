import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  MODEL_USAGE_RANGES,
  type FleetModelUsageQuery,
} from '../../shared/telemetry/model-usage.js';
import { resolveModelUsageRange } from '../../shared/telemetry/model-usage-range.js';
import type { FleetModelUsageProjectionPort } from './fleet-model-usage-projection.js';
import { FleetAuthorizationDeniedError } from './fleet-authorization-context.js';

export const FLEET_MODEL_USAGE_API_PATH = '/v1/fleet/model-usage';

interface FleetModelUsageRouteRequest {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly sessionToken: string;
  readonly rawPath: string;
  readonly rawQuery: string;
}

const ALLOWED_QUERY_FIELDS = new Set(['range', 'timezone', 'sinceMs', 'untilMs']);
const RANGE_VALUES = new Set<string>(MODEL_USAGE_RANGES);
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F]/u;
const REAUTHENTICATION_DENIALS = new Set([
  'session_absent',
  'session_ambiguous',
  'session_revoked',
  'session_replaced',
  'session_expired',
  'session_authn_stale',
  'session_authz_stale',
  'session_epoch_stale',
  'authority_generation_stale',
]);

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': String(body.byteLength),
    'Content-Type': 'application/json; charset=utf-8',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    Vary: 'Cookie',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  response.end(body);
}

function singleValue(
  searchParams: URLSearchParams,
  field: string,
): { ok: true; value?: string } | { ok: false; error: string } {
  const values = searchParams.getAll(field);
  if (values.length === 0) return { ok: true };
  if (values.length !== 1) {
    return { ok: false, error: `Duplicate ${field} query parameter.` };
  }
  const value = values[0]?.trim() ?? '';
  if (!value || value.length > 128 || UNSAFE_TEXT.test(value)) {
    return { ok: false, error: `Invalid ${field} query parameter.` };
  }
  return { ok: true, value };
}

function timestampValue(
  searchParams: URLSearchParams,
  field: 'sinceMs' | 'untilMs',
): { ok: true; value?: number } | { ok: false; error: string } {
  const parsed = singleValue(searchParams, field);
  if (!parsed.ok) return parsed;
  if (parsed.value === undefined) return { ok: true };
  const value = Number(parsed.value);
  if (!Number.isSafeInteger(value) || value < 0) {
    return { ok: false, error: `${field} must be a non-negative safe integer.` };
  }
  return { ok: true, value };
}

function parseFleetModelUsageQuery(
  rawQuery: string,
): { ok: true; value: FleetModelUsageQuery } | { ok: false; error: string } {
  const searchParams = new URLSearchParams(rawQuery);
  for (const field of searchParams.keys()) {
    if (!ALLOWED_QUERY_FIELDS.has(field)) {
      return { ok: false, error: `Unsupported fleet model-usage query parameter ${JSON.stringify(field)}.` };
    }
  }
  const range = singleValue(searchParams, 'range');
  if (!range.ok) return range;
  if (range.value !== undefined && !RANGE_VALUES.has(range.value)) {
    return { ok: false, error: `Invalid range query parameter.` };
  }
  const timezone = singleValue(searchParams, 'timezone');
  if (!timezone.ok) return timezone;
  const sinceMs = timestampValue(searchParams, 'sinceMs');
  if (!sinceMs.ok) return sinceMs;
  const untilMs = timestampValue(searchParams, 'untilMs');
  if (!untilMs.ok) return untilMs;
  const query: FleetModelUsageQuery = {
    ...(range.value !== undefined ? { range: range.value as FleetModelUsageQuery['range'] } : {}),
    ...(timezone.value !== undefined ? { timezone: timezone.value } : {}),
    ...(sinceMs.value !== undefined ? { sinceMs: sinceMs.value } : {}),
    ...(untilMs.value !== undefined ? { untilMs: untilMs.value } : {}),
  };
  try {
    resolveModelUsageRange(query, { nowMs: Date.now() });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, value: query };
}

export class GatewayFleetModelUsageHttpRoutes {
  constructor(private readonly options: { readonly projection: FleetModelUsageProjectionPort }) {}

  matches(rawPath: string): boolean {
    return rawPath === FLEET_MODEL_USAGE_API_PATH;
  }

  sendUnauthenticated(response: ServerResponse): void {
    sendJson(response, 401, { error: { type: 'fleet_model_usage_denied' } });
  }

  async handle(input: FleetModelUsageRouteRequest): Promise<void> {
    if (input.request.method !== 'GET' || !this.matches(input.rawPath)) {
      sendJson(input.response, 404, { error: { type: 'not_found' } });
      return;
    }
    const query = parseFleetModelUsageQuery(input.rawQuery);
    if (!query.ok) {
      sendJson(input.response, 400, { error: { type: 'invalid_query', message: query.error } });
      return;
    }
    try {
      sendJson(input.response, 200, await this.options.projection.resolve({
        sessionToken: input.sessionToken,
        query: query.value,
      }));
    } catch (error) {
      if (error instanceof FleetAuthorizationDeniedError) {
        if (error.code === 'authorization_store_error') {
          sendJson(input.response, 503, { error: { type: 'fleet_model_usage_unavailable' } });
        } else if (REAUTHENTICATION_DENIALS.has(error.code)) {
          this.sendUnauthenticated(input.response);
        } else {
          sendJson(input.response, 403, { error: { type: 'fleet_model_usage_denied' } });
        }
        return;
      }
      sendJson(input.response, 503, { error: { type: 'fleet_model_usage_unavailable' } });
    }
  }
}
