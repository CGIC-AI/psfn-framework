import {
  CHARGE_POLICY_RUNTIME_LANE_VALUES,
  CHARGE_POLICY_SURFACE_VALUES,
} from '../../../shared/contracts/charge-policy.js';
import type { ChargeCostReconciliationQuery } from '../../../shared/telemetry/charge-cost-reconciliation.js';

type ParseResult =
  | { ok: true; value: ChargeCostReconciliationQuery }
  | { ok: false; error: string };

const TEXT_FIELDS = [
  'companionId',
  'channelId',
  'runId',
  'rootRunId',
] as const satisfies ReadonlyArray<keyof ChargeCostReconciliationQuery>;
const ALLOWED_FIELDS = new Set([
  'sinceMs',
  'untilMs',
  'lane',
  'surface',
  ...TEXT_FIELDS,
]);
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F]/u;

function singleValue(
  searchParams: URLSearchParams,
  field: string,
): { ok: true; value?: string } | { ok: false; error: string } {
  const values = searchParams.getAll(field);
  if (values.length === 0) return { ok: true };
  if (values.length > 1) return { ok: false, error: `Duplicate ${field} query parameter.` };
  const value = values[0]?.trim() ?? '';
  if (!value) return { ok: false, error: `${field} query parameter must be non-empty.` };
  if (value.length > 512 || UNSAFE_TEXT.test(value)) {
    return { ok: false, error: `Invalid ${field} query parameter.` };
  }
  return { ok: true, value };
}

function timestampValue(
  searchParams: URLSearchParams,
  field: 'sinceMs' | 'untilMs',
): { ok: true; value?: number } | { ok: false; error: string } {
  const parsed = singleValue(searchParams, field);
  if (!parsed.ok || parsed.value === undefined) return parsed;
  const value = Number(parsed.value);
  if (!Number.isSafeInteger(value) || value < 0) {
    return { ok: false, error: `Invalid ${field} query parameter. Expected a non-negative safe integer.` };
  }
  return { ok: true, value };
}

export function parseChargeCostQuery(searchParams: URLSearchParams): ParseResult {
  for (const field of searchParams.keys()) {
    if (!ALLOWED_FIELDS.has(field)) {
      return { ok: false, error: `Unsupported charge-cost query parameter ${JSON.stringify(field)}.` };
    }
  }
  const sinceMs = timestampValue(searchParams, 'sinceMs');
  if (!sinceMs.ok) return sinceMs;
  const untilMs = timestampValue(searchParams, 'untilMs');
  if (!untilMs.ok) return untilMs;
  if (sinceMs.value !== undefined && untilMs.value !== undefined && sinceMs.value > untilMs.value) {
    return { ok: false, error: 'sinceMs must be less than or equal to untilMs.' };
  }
  const query: ChargeCostReconciliationQuery = {
    ...(sinceMs.value !== undefined ? { sinceMs: sinceMs.value } : {}),
    ...(untilMs.value !== undefined ? { untilMs: untilMs.value } : {}),
  };
  for (const field of TEXT_FIELDS) {
    const parsed = singleValue(searchParams, field);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) query[field] = parsed.value;
  }
  const lane = singleValue(searchParams, 'lane');
  if (!lane.ok) return lane;
  if (lane.value !== undefined) {
    if (!CHARGE_POLICY_RUNTIME_LANE_VALUES.includes(lane.value as typeof CHARGE_POLICY_RUNTIME_LANE_VALUES[number])) {
      return { ok: false, error: `Invalid lane query parameter. Expected one of: ${CHARGE_POLICY_RUNTIME_LANE_VALUES.join(', ')}.` };
    }
    query.lane = lane.value as typeof CHARGE_POLICY_RUNTIME_LANE_VALUES[number];
  }
  const surface = singleValue(searchParams, 'surface');
  if (!surface.ok) return surface;
  if (surface.value !== undefined) {
    if (!CHARGE_POLICY_SURFACE_VALUES.includes(surface.value as typeof CHARGE_POLICY_SURFACE_VALUES[number])) {
      return { ok: false, error: `Invalid surface query parameter. Expected one of: ${CHARGE_POLICY_SURFACE_VALUES.join(', ')}.` };
    }
    query.surface = surface.value as typeof CHARGE_POLICY_SURFACE_VALUES[number];
  }
  return { ok: true, value: query };
}
