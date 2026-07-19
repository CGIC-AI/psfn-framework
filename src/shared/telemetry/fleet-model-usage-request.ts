import {
  MODEL_USAGE_BUCKETS,
  MODEL_USAGE_RANGES,
  type ModelUsageQuery,
  type ModelUsageResolvedRange,
} from './model-usage.js';
import { resolveModelUsageRange } from './model-usage-range.js';

const FLEET_QUERY_FIELDS = new Set(['range', 'timezone', 'sinceMs', 'untilMs', 'bucket']);
const MODEL_USAGE_RANGE_VALUES = new Set<string>(MODEL_USAGE_RANGES);
const MODEL_USAGE_BUCKET_VALUES = new Set<string>(MODEL_USAGE_BUCKETS);

export const FLEET_MODEL_USAGE_ALL_TIME_ERROR =
  'Fleet model usage does not support all-time queries';

export function requireBoundedFleetModelUsageQuery(
  query: ModelUsageQuery,
): ModelUsageQuery {
  const isImplicitAllTime = query.range === undefined
    && query.sinceMs === undefined
    && query.untilMs === undefined;
  if (query.range === 'all' || isImplicitAllTime) {
    throw new Error(FLEET_MODEL_USAGE_ALL_TIME_ERROR);
  }
  return query;
}

function optionalSingle(
  query: Readonly<Partial<Record<string, readonly string[]>>>,
  field: string,
): string | undefined {
  const values = query[field];
  if (values === undefined) return undefined;
  if (values.length !== 1) throw new Error(`Fleet model usage ${field} must occur exactly once`);
  const value = values[0].trim();
  if (!value) throw new Error(`Fleet model usage ${field} must be non-empty`);
  return value;
}

function optionalInteger(
  query: Readonly<Partial<Record<string, readonly string[]>>>,
  field: 'sinceMs' | 'untilMs',
): number | undefined {
  const raw = optionalSingle(query, field);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Fleet model usage ${field} must be a non-negative safe integer`);
  }
  return value;
}

/** Parses the already-canonical fleet route selectors without adding detail filters. */
export function parseFleetModelUsageResourceQuery(
  query: Readonly<Partial<Record<string, readonly string[]>>>,
): ModelUsageQuery {
  if (Object.keys(query).some(field => !FLEET_QUERY_FIELDS.has(field))) {
    throw new Error('Fleet model usage query contains an unsupported selector');
  }
  const range = optionalSingle(query, 'range');
  const timezone = optionalSingle(query, 'timezone');
  const sinceMs = optionalInteger(query, 'sinceMs');
  const untilMs = optionalInteger(query, 'untilMs');
  const bucket = optionalSingle(query, 'bucket');
  if (range !== undefined && !MODEL_USAGE_RANGE_VALUES.has(range)) {
    throw new Error('Fleet model usage range is invalid');
  }
  if (bucket !== undefined && !MODEL_USAGE_BUCKET_VALUES.has(bucket)) {
    throw new Error('Fleet model usage bucket is invalid');
  }
  return requireBoundedFleetModelUsageQuery({
    ...(range === undefined ? {} : { range: range as ModelUsageQuery['range'] }),
    ...(timezone === undefined ? {} : { timezone }),
    ...(sinceMs === undefined ? {} : { sinceMs }),
    ...(untilMs === undefined ? {} : { untilMs }),
    ...(bucket === undefined ? {} : { bucket: bucket as ModelUsageQuery['bucket'] }),
  });
}

export function buildFleetModelUsageInternalRequestTarget(
  range: ModelUsageResolvedRange,
): string {
  const params = new URLSearchParams({
    range: 'custom',
    timezone: range.timezone,
    sinceMs: String(range.sinceMs),
    untilMs: String(range.untilMs),
    bucket: range.bucket,
    limit: '1',
    topN: '100',
    groupBy: 'model',
  });
  return `/api/admin/model-usage?${params.toString()}`;
}

/** Derives the only per-companion read that a signed fleet request may fan out. */
export function resolveFleetModelUsageInternalRequestTarget(
  query: ModelUsageQuery,
  nowMs: number,
): string {
  return buildFleetModelUsageInternalRequestTarget(resolveModelUsageRange(
    requireBoundedFleetModelUsageQuery(query),
    { nowMs },
  ));
}

export function parseFleetModelUsageInternalRequestTarget(
  requestTarget: string,
): ModelUsageResolvedRange | null {
  let parsed: URL;
  try {
    parsed = new URL(requestTarget, 'http://localhost');
  } catch {
    return null;
  }
  const expectedFields = [
    'range', 'timezone', 'sinceMs', 'untilMs', 'bucket', 'limit', 'topN', 'groupBy',
  ];
  if (!requestTarget.startsWith('/')
    || parsed.origin !== 'http://localhost'
    || parsed.pathname !== '/api/admin/model-usage'
    || parsed.hash
    || [...parsed.searchParams.keys()].some(field => !expectedFields.includes(field))
    || expectedFields.some(field => parsed.searchParams.getAll(field).length !== 1)
    || parsed.searchParams.get('range') !== 'custom'
    || parsed.searchParams.get('groupBy') !== 'model'
    || parsed.searchParams.get('limit') !== '1'
    || parsed.searchParams.get('topN') !== '100') {
    return null;
  }
  const timezone = parsed.searchParams.get('timezone') ?? '';
  const sinceMs = Number(parsed.searchParams.get('sinceMs'));
  const untilMs = Number(parsed.searchParams.get('untilMs'));
  const bucket = parsed.searchParams.get('bucket');
  if (!timezone
    || !Number.isSafeInteger(sinceMs)
    || sinceMs < 0
    || !Number.isSafeInteger(untilMs)
    || untilMs <= sinceMs
    || !['hour', 'day', 'week', 'month'].includes(bucket ?? '')) {
    return null;
  }
  try {
    const resolved = resolveModelUsageRange({
      range: 'custom',
      timezone,
      sinceMs,
      untilMs,
      bucket: bucket as ModelUsageQuery['bucket'],
    }, { nowMs: untilMs - 1 });
    return buildFleetModelUsageInternalRequestTarget(resolved) === requestTarget
      ? resolved
      : null;
  } catch {
    return null;
  }
}

/** Rebinds a signed exact child target to the original fleet query semantics. */
export function resolveAuthorizedFleetModelUsageRange(
  query: ModelUsageQuery,
  requestTarget: string,
): ModelUsageResolvedRange {
  const internal = parseFleetModelUsageInternalRequestTarget(requestTarget);
  if (!internal) throw new Error('Signed fleet model-usage child target is invalid');
  const resolved = resolveModelUsageRange(
    requireBoundedFleetModelUsageQuery(query),
    { nowMs: internal.untilMs - 1 },
  );
  if (buildFleetModelUsageInternalRequestTarget(resolved) !== requestTarget) {
    throw new Error('Signed fleet model-usage child target does not match the fleet query');
  }
  return resolved;
}
