import {
  MODEL_USAGE_BUCKETS,
  MODEL_USAGE_RANGES,
  type FleetModelUsageQuery,
  type FleetModelUsageSummary,
  type FleetModelUsageTokenTotals,
  type ModelUsageResolvedRange,
} from '../../../../src/shared/telemetry/model-usage.js';
import {
  hasExactKeys,
  isRecord,
  isRfc4122Uuid,
} from '../../../../src/shared/utils/types.js';
import { serializeModelUsageQuery } from '../api/endpoints/model-usage-query.js';
import { throwIfAborted } from '../api/abort.js';
import { withFleetSessionTransitionLock } from '../api/fleet-session.js';

const MAX_FLEET_COMPANIONS = 256;
const TOKEN_TOTAL_FIELDS = [
  'calls',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
] as const;
const RESOLVED_RANGE_FIELDS = [
  'range',
  'timezone',
  'sinceMs',
  'untilMs',
  'bucket',
  'boundary',
  'calendarWeekStartsOn',
] as const;

export interface FleetModelUsageProjection extends FleetModelUsageSummary {
  schemaVersion: 1;
  generatedAt: string;
}

export type FleetUsageViewState = 'loading' | 'unavailable' | 'ready';

export function resolveFleetUsageViewState(input: {
  loading: boolean;
  errorMessage: string;
  projection: FleetModelUsageProjection | null;
}): FleetUsageViewState {
  if (input.errorMessage) return 'unavailable';
  if (input.loading) return 'loading';
  return input.projection ? 'ready' : 'unavailable';
}

function parseTokenTotals(value: unknown): FleetModelUsageTokenTotals {
  if (!isRecord(value) || !hasExactKeys(value, TOKEN_TOTAL_FIELDS)) {
    throw new Error('Cluster usage returned invalid token totals');
  }
  for (const field of TOKEN_TOTAL_FIELDS) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
      throw new Error('Cluster usage returned invalid token totals');
    }
  }
  const totals = Object.fromEntries(
    TOKEN_TOTAL_FIELDS.map(field => [field, value[field] as number]),
  ) as unknown as FleetModelUsageTokenTotals;
  if (totals.totalTokens !== totals.inputTokens
    + totals.outputTokens
    + totals.cacheReadTokens
    + totals.cacheWriteTokens) {
    throw new Error('Cluster usage returned inconsistent token totals');
  }
  return totals;
}

function parseResolvedRange(value: unknown): ModelUsageResolvedRange {
  if (!isRecord(value)
    || !hasExactKeys(value, RESOLVED_RANGE_FIELDS)
    || typeof value.range !== 'string'
    || !MODEL_USAGE_RANGES.includes(value.range as ModelUsageResolvedRange['range'])
    || typeof value.timezone !== 'string'
    || value.timezone.length === 0
    || value.timezone.length > 128
    || !Number.isSafeInteger(value.sinceMs)
    || (value.sinceMs as number) < 0
    || !Number.isSafeInteger(value.untilMs)
    || (value.untilMs as number) < (value.sinceMs as number)
    || typeof value.bucket !== 'string'
    || !MODEL_USAGE_BUCKETS.includes(value.bucket as ModelUsageResolvedRange['bucket'])
    || value.bucket === 'auto'
    || value.boundary !== '[sinceMs, untilMs)'
    || value.calendarWeekStartsOn !== 'monday') {
    throw new Error('Cluster usage returned an invalid resolved range');
  }
  return {
    range: value.range as ModelUsageResolvedRange['range'],
    timezone: value.timezone,
    sinceMs: value.sinceMs as number,
    untilMs: value.untilMs as number,
    bucket: value.bucket as ModelUsageResolvedRange['bucket'],
    boundary: '[sinceMs, untilMs)',
    calendarWeekStartsOn: 'monday',
  };
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new Error('Cluster usage token totals overflowed');
  }
  return result;
}

function addTokenTotals(
  left: FleetModelUsageTokenTotals,
  right: FleetModelUsageTokenTotals,
): FleetModelUsageTokenTotals {
  return {
    calls: checkedAdd(left.calls, right.calls),
    inputTokens: checkedAdd(left.inputTokens, right.inputTokens),
    outputTokens: checkedAdd(left.outputTokens, right.outputTokens),
    cacheReadTokens: checkedAdd(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: checkedAdd(left.cacheWriteTokens, right.cacheWriteTokens),
    totalTokens: checkedAdd(left.totalTokens, right.totalTokens),
  };
}

export function parseFleetModelUsageProjection(value: unknown): FleetModelUsageProjection {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'schemaVersion',
      'generatedAt',
      'resolvedRange',
      'combined',
      'companions',
    ])
    || value.schemaVersion !== 1
    || typeof value.generatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.generatedAt))
    || !Array.isArray(value.companions)
    || value.companions.length > MAX_FLEET_COMPANIONS) {
    throw new Error('Cluster usage returned an invalid bounded projection');
  }
  const seen = new Set<string>();
  const companions = value.companions.map((row) => {
    if (!isRecord(row)
      || !hasExactKeys(row, ['companionId', 'usage'])
      || typeof row.companionId !== 'string'
      || !isRfc4122Uuid(row.companionId)
      || seen.has(row.companionId)) {
      throw new Error('Cluster usage returned an invalid companion projection');
    }
    seen.add(row.companionId);
    return {
      companionId: row.companionId,
      usage: parseTokenTotals(row.usage),
    };
  });
  const zero: FleetModelUsageTokenTotals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
  const conserved = companions.reduce(
    (total, companion) => addTokenTotals(total, companion.usage),
    zero,
  );
  const combined = parseTokenTotals(value.combined);
  if (TOKEN_TOTAL_FIELDS.some(field => combined[field] !== conserved[field])) {
    throw new Error('Cluster usage combined totals do not conserve companion totals');
  }
  return {
    schemaVersion: 1,
    generatedAt: value.generatedAt,
    resolvedRange: parseResolvedRange(value.resolvedRange),
    combined,
    companions,
  };
}

export function buildFleetModelUsageSummaryPath(query: FleetModelUsageQuery = {}): string {
  const params = new URLSearchParams();
  if (query.range !== undefined) params.set('range', query.range);
  if (query.timezone !== undefined) params.set('timezone', query.timezone);
  if (query.sinceMs !== undefined) params.set('sinceMs', String(query.sinceMs));
  if (query.untilMs !== undefined) params.set('untilMs', String(query.untilMs));
  const suffix = serializeModelUsageQuery(params);
  return `/v1/fleet/model-usage${suffix ? `?${suffix}` : ''}`;
}

export async function fetchFleetModelUsageProjection(
  query: FleetModelUsageQuery = {},
  signal?: AbortSignal,
): Promise<FleetModelUsageProjection> {
  return await withFleetSessionTransitionLock(async transitionSignal => {
    const response = await fetch(buildFleetModelUsageSummaryPath(query), {
      cache: 'no-store',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: transitionSignal,
    });
    throwIfAborted(transitionSignal);
    if (response.status === 401) {
      if (typeof window !== 'undefined') window.location.assign('/fleet/login');
      throw new Error('Cluster session expired');
    }
    if (!response.ok) {
      throw new Error(response.status === 403
        ? 'Cluster usage access is unavailable'
        : 'Cluster usage is temporarily unavailable');
    }
    return parseFleetModelUsageProjection(await response.json());
  }, signal);
}
