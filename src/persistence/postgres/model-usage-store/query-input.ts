import type {
  ModelUsageGroupDimension,
  ModelUsageQuery,
} from '../../../shared/telemetry/model-usage.js';
import {
  MODEL_USAGE_BUCKETS,
  MODEL_USAGE_CALL_KINDS,
  MODEL_USAGE_COST_SOURCES,
  MODEL_USAGE_EVENT_ORDERS,
  MODEL_USAGE_GROUP_SORTS,
  MODEL_USAGE_RANGES,
  MODEL_USAGE_SORT_DIRECTIONS,
  MODEL_USAGE_STATUSES,
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
import type { SqlWhere } from './rows.js';
import { MODEL_USAGE_DIMENSION_SQL } from './query-support.js';

const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 2_000;
export const DEFAULT_TOP_N = 20;
const MAX_TOP_N = 100;

const QUERY_TEXT_FIELDS = [
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

const QUERY_ENUM_VALUES: Partial<Record<keyof ModelUsageQuery, ReadonlySet<string>>> = {
  callKind: new Set(MODEL_USAGE_CALL_KINDS),
  callType: new Set(MODEL_USAGE_CALL_TYPES),
  originType: new Set(MODEL_USAGE_ORIGIN_TYPES),
  channelType: new Set(MODEL_USAGE_CHANNEL_TYPES),
  runtimeLaneClass: new Set(MODEL_USAGE_RUNTIME_LANE_CLASSES),
  chargeLane: new Set(MODEL_USAGE_CHARGE_LANES),
  chargeSurface: new Set(MODEL_USAGE_CHARGE_SURFACES),
  status: new Set(MODEL_USAGE_STATUSES),
  costSource: new Set(MODEL_USAGE_COST_SOURCES),
  range: new Set(MODEL_USAGE_RANGES),
  bucket: new Set(MODEL_USAGE_BUCKETS),
  sortBy: new Set(MODEL_USAGE_GROUP_SORTS),
  sortDirection: new Set(MODEL_USAGE_SORT_DIRECTIONS),
  eventOrder: new Set(MODEL_USAGE_EVENT_ORDERS),
  telemetryVisibility: new Set(['operator_visible', 'companion_private']),
};

export const GROUP_DIMENSION_SET: ReadonlySet<string> = new Set(MODEL_USAGE_GROUP_DIMENSIONS);

const QUERY_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'sinceMs',
  'untilMs',
  'limit',
  'topN',
  'groupBy',
  ...QUERY_TEXT_FIELDS,
  ...Object.keys(QUERY_ENUM_VALUES),
]);

export function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_EVENT_LIMIT;
  }
  return Math.min(MAX_EVENT_LIMIT, Math.floor(limit));
}

function normalizeQueryInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

export function normalizeQueryText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  const maxLength = field === 'cursor' ? 2_048 : 512;
  if (normalized.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters`);
  }
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(normalized)) {
    throw new Error(`${field} must not contain control characters`);
  }
  return normalized;
}

export function normalizeQuery(
  query: ModelUsageQuery,
  tenantCompanionId?: string,
): ModelUsageQuery {
  for (const field of Object.keys(query)) {
    if (!QUERY_ALLOWED_FIELDS.has(field)) {
      throw new Error(`Model usage query has unsupported field ${JSON.stringify(field)}`);
    }
  }
  const sinceMs = normalizeQueryInteger(query.sinceMs, 'sinceMs');
  const untilMs = normalizeQueryInteger(query.untilMs, 'untilMs');
  if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
    throw new Error('sinceMs must be less than or equal to untilMs');
  }
  const limit = query.limit === undefined
    ? DEFAULT_EVENT_LIMIT
    : normalizeQueryInteger(query.limit, 'limit');
  if (limit === 0) throw new Error('limit must be at least 1');
  const topN = query.topN === undefined
    ? DEFAULT_TOP_N
    : normalizeQueryInteger(query.topN, 'topN');
  if (topN === 0 || (topN ?? DEFAULT_TOP_N) > MAX_TOP_N) {
    throw new Error(`topN must be between 1 and ${MAX_TOP_N}`);
  }
  const normalized: ModelUsageQuery = {
    ...(sinceMs !== undefined ? { sinceMs } : {}),
    ...(untilMs !== undefined ? { untilMs } : {}),
    limit: Math.min(MAX_EVENT_LIMIT, limit ?? DEFAULT_EVENT_LIMIT),
    topN: topN ?? DEFAULT_TOP_N,
  };
  for (const field of QUERY_TEXT_FIELDS) {
    const value = normalizeQueryText(query[field], String(field));
    if (value !== undefined) (normalized as Record<string, unknown>)[field] = value;
  }
  for (const [field, allowed] of Object.entries(QUERY_ENUM_VALUES)) {
    const value = query[field as keyof ModelUsageQuery];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !allowed.has(value)) {
      throw new Error(`${field} has unsupported value ${JSON.stringify(value)}`);
    }
    (normalized as Record<string, unknown>)[field] = value;
  }
  if (query.groupBy !== undefined) {
    if (!Array.isArray(query.groupBy)) throw new Error('groupBy must be an array');
    const groupBy = [...new Set(query.groupBy.map((dimension) => {
      if (typeof dimension !== 'string' || !GROUP_DIMENSION_SET.has(dimension)) {
        throw new Error(`groupBy has unsupported dimension ${JSON.stringify(dimension)}`);
      }
      return dimension as ModelUsageGroupDimension;
    }))];
    normalized.groupBy = groupBy;
    if (groupBy.length > 2) throw new Error('groupBy supports at most two dimensions');
  }
  if (tenantCompanionId) {
    const requestedCompanionId = normalized.companionId;
    if (requestedCompanionId && requestedCompanionId !== tenantCompanionId) {
      throw new Error(
        `Model usage query companionId ${JSON.stringify(requestedCompanionId)} is outside `
        + `the Garden tenant ${JSON.stringify(tenantCompanionId)}`,
      );
    }
    normalized.companionId = tenantCompanionId;
  }
  return normalized;
}

export function buildWhere(query: ModelUsageQuery): SqlWhere {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const push = (clause: string, value: unknown): void => {
    values.push(value);
    clauses.push(`${clause} $${values.length}`);
  };
  if (query.sinceMs !== undefined) push('recorded_at_ms >=', query.sinceMs);
  if (query.untilMs !== undefined) push('recorded_at_ms <', query.untilMs);
  if (query.provider) push('provider =', query.provider);
  if (query.model) push('model =', query.model);
  if (query.telemetryVisibility) push('telemetry_visibility =', query.telemetryVisibility);
  const dimensionFilters: ReadonlyArray<[ModelUsageGroupDimension, unknown]> = [
    ['companionId', query.companionId],
    ['sessionId', query.sessionId],
    ['channelId', query.channelId],
    ['channelType', query.channelType],
    ['callKind', query.callKind],
    ['callType', query.callType],
    ['purpose', query.purpose],
    ['originType', query.originType],
    ['originStage', query.originStage],
    ['service', query.service],
    ['process', query.process],
    ['slotKey', query.slotKey],
    ['requestedProvider', query.requestedProvider],
    ['requestedModel', query.requestedModel],
    ['toolName', query.toolName],
    ['runtimeLaneClass', query.runtimeLaneClass],
    ['chargeLane', query.chargeLane],
    ['chargeSurface', query.chargeSurface],
    ['chargeEventId', query.chargeEventId],
    ['chargeRunId', query.chargeRunId],
    ['chargeRootRunId', query.chargeRootRunId],
    ['chargeParentRunId', query.chargeParentRunId],
    ['shardId', query.shardId],
    ['subagentId', query.subagentId],
    ['conversationId', query.conversationId],
    ['rootInitiationId', query.rootInitiationId],
    ['workloadType', query.workloadType],
    ['workloadId', query.workloadId],
    ['status', query.status],
    ['costSource', query.costSource],
  ];
  for (const [dimension, value] of dimensionFilters) {
    if (value !== undefined) push(`${MODEL_USAGE_DIMENSION_SQL[dimension]} =`, value);
  }
  if (query.turnId) push('turn_id =', query.turnId);
  if (query.requestId) push('request_id =', query.requestId);
  if (query.toolCallId) push('tool_call_id =', query.toolCallId);
  if (query.runId) {
    values.push(query.runId);
    const index = values.length;
    clauses.push(`(charge_run_id = $${index} OR charge_root_run_id = $${index})`);
  }
  return {
    clause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    values,
  };
}

export function appendCompanionAllowlist(
  where: SqlWhere,
  companionIds: readonly string[],
): SqlWhere {
  const values = [...where.values, companionIds];
  const clause = `companion_id = ANY($${values.length}::text[])`;
  return {
    clause: where.clause ? `${where.clause} AND ${clause}` : `WHERE ${clause}`,
    values,
  };
}
