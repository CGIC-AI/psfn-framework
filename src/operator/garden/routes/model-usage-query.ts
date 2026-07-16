import {
  MODEL_USAGE_CALL_KINDS,
  MODEL_USAGE_BUCKETS,
  MODEL_USAGE_COST_SOURCES,
  MODEL_USAGE_EVENT_ORDERS,
  MODEL_USAGE_GROUP_SORTS,
  MODEL_USAGE_RANGES,
  MODEL_USAGE_SORT_DIRECTIONS,
  MODEL_USAGE_STATUSES,
  type ModelUsageQuery,
} from '../../../shared/telemetry/model-usage.js';
import {
  MODEL_USAGE_CALL_TYPES,
  MODEL_USAGE_CHANNEL_TYPES,
  MODEL_USAGE_CHARGE_LANES,
  MODEL_USAGE_CHARGE_SURFACES,
  MODEL_USAGE_GROUP_DIMENSIONS,
  MODEL_USAGE_ORIGIN_TYPES,
  MODEL_USAGE_RUNTIME_LANE_CLASSES,
} from '../../../shared/telemetry/model-usage-attribution.js';
import { resolveModelUsageRange } from '../../../shared/telemetry/model-usage-range.js';

type ParseResult =
  | { ok: true; value: ModelUsageQuery }
  | { ok: false; error: string };

const TEXT_FIELDS = [
  'provider',
  'model',
  'toolName',
  'purpose',
  'originStage',
  'service',
  'process',
  'companionId',
  'sessionId',
  'channelId',
  'turnId',
  'requestId',
  'toolCallId',
  'chargeEventId',
  'chargeRunId',
  'chargeRootRunId',
  'chargeParentRunId',
  'shardId',
  'subagentId',
  'conversationId',
  'rootInitiationId',
  'workloadType',
  'workloadId',
  'slotKey',
  'requestedProvider',
  'requestedModel',
  'runId',
  'timezone',
  'cursor',
] as const satisfies ReadonlyArray<keyof ModelUsageQuery>;

const ENUM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  callKind: MODEL_USAGE_CALL_KINDS,
  callType: MODEL_USAGE_CALL_TYPES,
  originType: MODEL_USAGE_ORIGIN_TYPES,
  channelType: MODEL_USAGE_CHANNEL_TYPES,
  runtimeLaneClass: MODEL_USAGE_RUNTIME_LANE_CLASSES,
  chargeLane: MODEL_USAGE_CHARGE_LANES,
  chargeSurface: MODEL_USAGE_CHARGE_SURFACES,
  status: MODEL_USAGE_STATUSES,
  costSource: MODEL_USAGE_COST_SOURCES,
  range: MODEL_USAGE_RANGES,
  bucket: MODEL_USAGE_BUCKETS,
  sortBy: MODEL_USAGE_GROUP_SORTS,
  sortDirection: MODEL_USAGE_SORT_DIRECTIONS,
  eventOrder: MODEL_USAGE_EVENT_ORDERS,
};

const ALLOWED_FIELDS = new Set([
  'sinceMs',
  'untilMs',
  'limit',
  'topN',
  'groupBy',
  ...TEXT_FIELDS,
  ...Object.keys(ENUM_FIELDS),
]);
const GROUP_DIMENSIONS = new Set<string>(MODEL_USAGE_GROUP_DIMENSIONS);
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F]/u;
const MAX_QUERY_PARAMETERS = 64;

function singleValue(
  searchParams: URLSearchParams,
  field: string,
): { ok: true; value?: string } | { ok: false; error: string } {
  const values = searchParams.getAll(field);
  if (values.length === 0) return { ok: true };
  if (values.length > 1) {
    return { ok: false, error: `Duplicate ${field} query parameter.` };
  }
  const value = values[0]?.trim() ?? '';
  if (!value) return { ok: false, error: `${field} query parameter must be non-empty.` };
  const maxLength = field === 'cursor' ? 2_048 : 512;
  if (value.length > maxLength || UNSAFE_TEXT.test(value)) {
    return { ok: false, error: `Invalid ${field} query parameter.` };
  }
  return { ok: true, value };
}

function integerValue(
  searchParams: URLSearchParams,
  field: 'sinceMs' | 'untilMs' | 'limit' | 'topN',
): { ok: true; value?: number } | { ok: false; error: string } {
  const parsed = singleValue(searchParams, field);
  if (!parsed.ok) return parsed;
  if (parsed.value === undefined) return { ok: true };
  const value = Number(parsed.value);
  const minimum = field === 'limit' || field === 'topN' ? 1 : 0;
  if (!Number.isSafeInteger(value) || value < minimum) {
    return {
      ok: false,
      error: `Invalid ${field} query parameter. Expected a safe integer >= ${minimum}.`,
    };
  }
  const maximum = field === 'limit' ? 2_000 : (field === 'topN' ? 100 : undefined);
  if (maximum !== undefined && value > maximum) {
    return { ok: false, error: `${field} query parameter must be at most ${maximum}.` };
  }
  return { ok: true, value };
}

export function parseModelUsageQuery(searchParams: URLSearchParams): ParseResult {
  if ([...searchParams].length > MAX_QUERY_PARAMETERS) {
    return { ok: false, error: `Model usage query supports at most ${MAX_QUERY_PARAMETERS} parameters.` };
  }
  for (const field of searchParams.keys()) {
    if (!ALLOWED_FIELDS.has(field)) {
      return { ok: false, error: `Unsupported model usage query parameter ${JSON.stringify(field)}.` };
    }
  }

  const sinceMs = integerValue(searchParams, 'sinceMs');
  if (!sinceMs.ok) return sinceMs;
  const untilMs = integerValue(searchParams, 'untilMs');
  if (!untilMs.ok) return untilMs;
  const limit = integerValue(searchParams, 'limit');
  if (!limit.ok) return limit;
  const topN = integerValue(searchParams, 'topN');
  if (!topN.ok) return topN;
  if (
    sinceMs.value !== undefined
    && untilMs.value !== undefined
    && sinceMs.value > untilMs.value
  ) {
    return { ok: false, error: 'sinceMs must be less than or equal to untilMs.' };
  }

  const query: ModelUsageQuery = {
    ...(sinceMs.value !== undefined ? { sinceMs: sinceMs.value } : {}),
    ...(untilMs.value !== undefined ? { untilMs: untilMs.value } : {}),
    ...(limit.value !== undefined ? { limit: limit.value } : {}),
    ...(topN.value !== undefined ? { topN: topN.value } : {}),
  };
  for (const field of TEXT_FIELDS) {
    const parsed = singleValue(searchParams, field);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) {
      (query as Record<string, unknown>)[field] = parsed.value;
    }
  }
  for (const [field, allowed] of Object.entries(ENUM_FIELDS)) {
    const parsed = singleValue(searchParams, field);
    if (!parsed.ok) return parsed;
    if (parsed.value === undefined) continue;
    if (!allowed.includes(parsed.value)) {
      return {
        ok: false,
        error: `Invalid ${field} query parameter. Expected one of: ${allowed.join(', ')}.`,
      };
    }
    (query as Record<string, unknown>)[field] = parsed.value;
  }

  const rawGroupBy = searchParams.getAll('groupBy');
  if (rawGroupBy.length > 0) {
    const groupBy = [...new Set(rawGroupBy.flatMap(value => value.split(',')).map(value => value.trim()))];
    if (groupBy.some(value => !value || !GROUP_DIMENSIONS.has(value))) {
      return {
        ok: false,
        error: `Invalid groupBy query parameter. Expected dimensions from: ${MODEL_USAGE_GROUP_DIMENSIONS.join(', ')}.`,
      };
    }
    if (groupBy.length > 2) {
      return { ok: false, error: 'groupBy supports at most two dimensions.' };
    }
    query.groupBy = groupBy as ModelUsageQuery['groupBy'];
  }

  try {
    resolveModelUsageRange(query, { nowMs: Date.now() });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  return { ok: true, value: query };
}
