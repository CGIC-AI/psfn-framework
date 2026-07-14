import {
  MODEL_USAGE_CALL_KINDS,
  MODEL_USAGE_COST_SOURCES,
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
} from '../../../shared/telemetry/model-usage-attribution.js';

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
] as const satisfies ReadonlyArray<keyof ModelUsageQuery>;

const ENUM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  callKind: MODEL_USAGE_CALL_KINDS,
  callType: MODEL_USAGE_CALL_TYPES,
  originType: MODEL_USAGE_ORIGIN_TYPES,
  channelType: MODEL_USAGE_CHANNEL_TYPES,
  chargeLane: MODEL_USAGE_CHARGE_LANES,
  chargeSurface: MODEL_USAGE_CHARGE_SURFACES,
  status: MODEL_USAGE_STATUSES,
  costSource: MODEL_USAGE_COST_SOURCES,
};

const ALLOWED_FIELDS = new Set([
  'sinceMs',
  'untilMs',
  'limit',
  'groupBy',
  ...TEXT_FIELDS,
  ...Object.keys(ENUM_FIELDS),
]);
const GROUP_DIMENSIONS = new Set<string>(MODEL_USAGE_GROUP_DIMENSIONS);
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F]/u;

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
  if (value.length > 512 || UNSAFE_TEXT.test(value)) {
    return { ok: false, error: `Invalid ${field} query parameter.` };
  }
  return { ok: true, value };
}

function integerValue(
  searchParams: URLSearchParams,
  field: 'sinceMs' | 'untilMs' | 'limit',
): { ok: true; value?: number } | { ok: false; error: string } {
  const parsed = singleValue(searchParams, field);
  if (!parsed.ok) return parsed;
  if (parsed.value === undefined) return { ok: true };
  const value = Number(parsed.value);
  const minimum = field === 'limit' ? 1 : 0;
  if (!Number.isSafeInteger(value) || value < minimum) {
    return {
      ok: false,
      error: `Invalid ${field} query parameter. Expected a safe integer >= ${minimum}.`,
    };
  }
  return { ok: true, value };
}

export function parseModelUsageQuery(searchParams: URLSearchParams): ParseResult {
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
    query.groupBy = groupBy as ModelUsageQuery['groupBy'];
  }

  return { ok: true, value: query };
}
