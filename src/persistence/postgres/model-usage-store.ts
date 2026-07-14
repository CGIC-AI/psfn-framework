import type { Pool, PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import {
  createPostgresPool,
  ensurePostgresSchemaWithAdvisoryLock,
  queryOne,
  queryRows,
  withPostgresClient,
} from '../postgres.js';
import {
  POSTGRES_MODEL_USAGE_MIGRATION_ADVISORY_LOCK,
  POSTGRES_MODEL_USAGE_MIGRATIONS,
} from './migrations.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type {
  ModelUsageBreakdown,
  ModelUsageAttributionCoverage,
  ModelUsageBudgetQueryPort,
  ModelUsageBudgetSpendSnapshot,
  ModelUsageCallKind,
  ModelUsageCostHydrationBreakdown,
  ModelUsageCostHydrationData,
  ModelUsageCostHydrationQueryPort,
  ModelUsageCostSource,
  ModelUsageCostBreakdown,
  ModelUsageData,
  ModelUsageExportData,
  ModelUsageExportPort,
  ModelUsageExportRow,
  ModelUsageEvent,
  ModelUsageEventInput,
  ModelUsageQuery,
  ModelUsageQueryPort,
  ModelUsageReconciliationQuery,
  ModelUsageReconciliationQueryPort,
  ModelUsageRecorder,
  ModelUsageStatus,
  ModelUsageSettlement,
  ModelUsageTotals,
  ModelUsageGroupDimension,
  ModelUsageGroup,
  ModelUsageResolvedRange,
  ModelUsageTimeBucket,
  EnabledIcpCostBreakerPolicy,
  IcpConversationCostAccountingPort,
  IcpConversationCostProjection,
  IcpConversationCostProjectionQuery,
  IcpConversationCostReservationInput,
  IcpConversationCostReservationReason,
  IcpConversationCostReservationResult,
} from '../../shared/telemetry/model-usage.js';
import {
  MODEL_USAGE_BUCKETS,
  MODEL_USAGE_CALL_KINDS,
  MODEL_USAGE_COST_SOURCES,
  MODEL_USAGE_EVENT_ORDERS,
  MODEL_USAGE_GROUP_SORTS,
  MODEL_USAGE_RANGES,
  MODEL_USAGE_SORT_DIRECTIONS,
  MODEL_USAGE_STATUSES,
} from '../../shared/telemetry/model-usage.js';
import {
  MODEL_USAGE_CALL_TYPES,
  MODEL_USAGE_CHANNEL_TYPES,
  MODEL_USAGE_CHARGE_LANES,
  MODEL_USAGE_CHARGE_SURFACES,
  MODEL_USAGE_GROUP_DIMENSIONS,
  MODEL_USAGE_ORIGIN_TYPES,
  MODEL_USAGE_UNKNOWN_DIMENSION,
  normalizeModelUsageAttribution,
} from '../../shared/telemetry/model-usage-attribution.js';
import {
  reconcileModelUsageAccounting,
  roundModelUsageUsd,
} from '../../shared/telemetry/model-usage-accounting.js';
import { boundModelUsageMetadata } from '../../shared/telemetry/model-usage-metadata.js';
import { isRecord } from '../../shared/utils/types.js';
import { parseIcpConversationCorrelation } from '../../shared/contracts/icp-autonomy.js';
import {
  createModelUsageBucketBoundaries,
  resolveModelUsageRange,
} from '../../shared/telemetry/model-usage-range.js';

const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 2_000;
const DEFAULT_BREAKDOWN_LIMIT = 20;
const DEFAULT_TOP_N = 20;
const MAX_TOP_N = 100;
const MAX_EXPORT_ROWS = 50_000;

interface ModelUsageEventRow {
  id: string;
  logical_call_id: string;
  attempt: number | string;
  recorded_at_ms: number | string;
  started_at_ms: number | string;
  completed_at_ms: number | string | null;
  duration_ms: number | string | null;
  ttft_ms: number | string | null;
  day_key: string;
  month_key: string;
  status: ModelUsageStatus;
  settlement: ModelUsageSettlement;
  call_kind: ModelUsageCallKind;
  call_type: ModelUsageEvent['attribution']['callType'];
  purpose: string;
  origin_type: ModelUsageEvent['attribution']['originType'] | null;
  origin_stage: string | null;
  service: string | null;
  process: string | null;
  companion_id: string;
  session_id: string;
  turn_id: string | null;
  request_id: string | null;
  channel_id: string | null;
  channel_type: string;
  tool_name: string | null;
  tool_call_id: string | null;
  charge_lane: ModelUsageEvent['attribution']['chargeLane'] | null;
  charge_surface: ModelUsageEvent['attribution']['chargeSurface'] | null;
  charge_event_id: string | null;
  charge_run_id: string | null;
  charge_root_run_id: string | null;
  charge_parent_run_id: string | null;
  shard_id: string;
  subagent_id: string;
  conversation_id: string;
  root_initiation_id: string;
  workload_type: string;
  workload_id: string;
  provider: string;
  model: string;
  slot_key: string | null;
  requested_provider: string | null;
  requested_model: string | null;
  input_tokens: number | string;
  output_tokens: number | string;
  cache_read_tokens: number | string;
  cache_write_tokens: number | string;
  total_tokens: number | string;
  provider_input_cost_usd: number | string | null;
  provider_output_cost_usd: number | string | null;
  provider_cache_read_cost_usd: number | string | null;
  provider_cache_write_cost_usd: number | string | null;
  provider_cost_usd: number | string | null;
  estimated_input_cost_usd: number | string | null;
  estimated_output_cost_usd: number | string | null;
  estimated_cache_read_cost_usd: number | string | null;
  estimated_cache_write_cost_usd: number | string | null;
  estimated_cost_usd: number | string | null;
  effective_input_cost_usd: number | string | null;
  effective_output_cost_usd: number | string | null;
  effective_cache_read_cost_usd: number | string | null;
  effective_cache_write_cost_usd: number | string | null;
  effective_cost_usd: number | string | null;
  cost_source: ModelUsageCostSource;
  currency: string | null;
  stop_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  metadata_json: unknown;
  event_fingerprint: string;
}

interface TotalsRow {
  calls: number | string;
  successful_calls: number | string;
  failed_calls: number | string;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_write_tokens: number | string | null;
  total_tokens: number | string | null;
  provider_cost_usd: number | string | null;
  estimated_cost_usd: number | string | null;
  total_cost_usd: number | string | null;
  provider_input_cost_usd: number | string | null;
  provider_input_known_calls: number | string;
  provider_output_cost_usd: number | string | null;
  provider_output_known_calls: number | string;
  provider_cache_read_cost_usd: number | string | null;
  provider_cache_read_known_calls: number | string;
  provider_cache_write_cost_usd: number | string | null;
  provider_cache_write_known_calls: number | string;
  provider_cost_known_calls: number | string;
  estimated_input_cost_usd: number | string | null;
  estimated_input_known_calls: number | string;
  estimated_output_cost_usd: number | string | null;
  estimated_output_known_calls: number | string;
  estimated_cache_read_cost_usd: number | string | null;
  estimated_cache_read_known_calls: number | string;
  estimated_cache_write_cost_usd: number | string | null;
  estimated_cache_write_known_calls: number | string;
  estimated_cost_known_calls: number | string;
  effective_input_cost_usd: number | string | null;
  effective_input_known_calls: number | string;
  effective_output_cost_usd: number | string | null;
  effective_output_known_calls: number | string;
  effective_cache_read_cost_usd: number | string | null;
  effective_cache_read_known_calls: number | string;
  effective_cache_write_cost_usd: number | string | null;
  effective_cache_write_known_calls: number | string;
  effective_cost_known_calls: number | string;
  total_duration_ms: number | string | null;
  duration_samples: number | string;
  total_ttft_ms: number | string | null;
  ttft_samples: number | string;
  average_duration_ms: number | string | null;
  average_ttft_ms: number | string | null;
}

interface BreakdownRow extends TotalsRow {
  key: string | null;
}

interface TimeBucketRow extends TotalsRow {
  bucket_start_ms: number | string;
}

interface GroupRow extends TotalsRow {
  dimension_0: string | null;
  dimension_1: string | null;
  is_other: boolean;
  sort_rank: number | string;
}

interface CostHydrationBreakdownRow extends BreakdownRow {
  model_key: string;
  cost_source: ModelUsageCostSource;
}

type CoverageRow = Record<string, number | string | null | undefined> & {
  total_calls: number | string;
};

interface BudgetSpendRow {
  daily_estimated_cost_usd: number | string | null;
  monthly_estimated_cost_usd: number | string | null;
  daily_unknown_cost_attempts: number | string;
  monthly_unknown_cost_attempts: number | string;
}

interface IcpConversationCostProjectionRow {
  actual_cost_usd: number | string | null;
  pending_projected_cost_usd: number | string | null;
  actual_attempt_count: number | string;
  unknown_cost_attempt_count: number | string;
  pending_reservation_count: number | string;
  stale_reservation_count: number | string;
  settled_reservation_count: number | string;
  attributed_companion_count: number | string;
}

interface IcpConversationCostReservationRow {
  logical_call_id: string;
  attempt: number | string;
  conversation_id: string;
  root_initiation_id: string;
  companion_id: string;
  cost_purpose: string;
  closeout_eligible: boolean;
  projected_cost_usd: number | string;
  status: 'pending' | 'settled' | 'settled_unknown';
  reservation_reason: 'below_warning' | 'final_closeout_reserve';
  settled_event_id: string | null;
  created_at_ms: number | string;
  settled_at_ms: number | string | null;
}

interface SqlWhere {
  clause: string;
  values: unknown[];
}

interface PreparedModelUsageQuery {
  query: ModelUsageQuery;
  resolvedRange: ModelUsageResolvedRange;
  where: SqlWhere;
}

export type ModelUsageStoreScope =
  | { companionId: string; fleetAggregation?: never }
  | { companionId?: never; fleetAggregation: true };

function resolveStoreCompanionId(scope: unknown): string | undefined {
  if (!isRecord(scope)) {
    throw new Error('PostgresModelUsageStore scope must be an object');
  }
  const keys = Object.keys(scope);
  if (keys.some(key => key !== 'companionId' && key !== 'fleetAggregation')) {
    throw new Error('PostgresModelUsageStore scope contains unsupported fields');
  }
  const hasCompanion = Object.prototype.hasOwnProperty.call(scope, 'companionId');
  const hasFleet = Object.prototype.hasOwnProperty.call(scope, 'fleetAggregation');
  if (hasCompanion === hasFleet) {
    throw new Error(
      'PostgresModelUsageStore scope requires exactly one of companionId or fleetAggregation',
    );
  }
  if (hasCompanion) {
    const companionId = optionalText(
      typeof scope.companionId === 'string' ? scope.companionId : undefined,
    );
    if (!companionId) {
      throw new Error('PostgresModelUsageStore companionId must be non-empty');
    }
    return companionId;
  }
  if (scope.fleetAggregation !== true) {
    throw new Error('PostgresModelUsageStore fleetAggregation must be true');
  }
  return undefined;
}

const MODEL_USAGE_DIMENSION_SQL: Record<ModelUsageGroupDimension, string> = {
  companionId: 'companion_id',
  sessionId: 'session_id',
  channelId: 'channel_id',
  channelType: 'channel_type',
  callKind: 'call_kind',
  callType: 'call_type',
  purpose: 'purpose',
  originType: 'origin_type',
  originStage: 'origin_stage',
  service: 'service',
  process: 'process',
  provider: 'provider',
  model: 'model',
  slotKey: 'slot_key',
  requestedProvider: 'requested_provider',
  requestedModel: 'requested_model',
  toolName: 'tool_name',
  chargeLane: 'charge_lane',
  chargeSurface: 'charge_surface',
  chargeEventId: 'charge_event_id',
  chargeRunId: 'charge_run_id',
  chargeRootRunId: 'charge_root_run_id',
  chargeParentRunId: 'charge_parent_run_id',
  shardId: 'shard_id',
  subagentId: 'subagent_id',
  conversationId: 'conversation_id',
  rootInitiationId: 'root_initiation_id',
  workloadType: 'workload_type',
  workloadId: 'workload_id',
  status: 'status',
  costSource: 'cost_source',
};

function normalizeText(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function asNullableNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const numeric = asNumber(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function nonNegativeInteger(value: unknown): number {
  const numeric = asNumber(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function inputNonNegativeInteger(
  value: unknown,
  field: string,
  fallback: number = 0,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function nonNegativeCost(value: unknown): number | undefined {
  const numeric = asNullableNumber(value);
  if (numeric === undefined || numeric < 0) return undefined;
  return numeric;
}

function inputNonNegativeCost(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite number >= 0`);
  }
  return value;
}

function validateEnabledIcpCostPolicy(
  policy: unknown,
): EnabledIcpCostBreakerPolicy {
  if (!isRecord(policy) || policy.enabled !== true) {
    throw new Error('ICP conversation cost accounting requires an enabled owner policy');
  }
  const warningThresholdUsd = inputNonNegativeCost(
    policy.warningThresholdUsd,
    'policy.warningThresholdUsd',
  );
  const hardLimitUsd = inputNonNegativeCost(policy.hardLimitUsd, 'policy.hardLimitUsd');
  const finalCloseoutReserveUsd = inputNonNegativeCost(
    policy.finalCloseoutReserveUsd,
    'policy.finalCloseoutReserveUsd',
  );
  if (
    warningThresholdUsd <= 0
    || finalCloseoutReserveUsd <= 0
    || Math.abs((warningThresholdUsd + finalCloseoutReserveUsd) - hardLimitUsd) > 1e-9
  ) {
    throw new Error('ICP conversation cost policy thresholds do not define one exact closeout band');
  }
  const pendingReservationStaleAfterMs = inputNonNegativeInteger(
    policy.pendingReservationStaleAfterMs,
    'policy.pendingReservationStaleAfterMs',
  );
  if (pendingReservationStaleAfterMs <= 0 || !isRecord(policy.includedCostPurposes)) {
    throw new Error('ICP conversation cost policy requires a positive stale interval and purpose map');
  }
  const includedCostPurposes = policy.includedCostPurposes;
  const purposeKeys = ['conversation_turn', 'tool', 'summary', 'extraction', 'sidecar'] as const;
  const conversationTurn = includedCostPurposes.conversation_turn;
  const tool = includedCostPurposes.tool;
  const summary = includedCostPurposes.summary;
  const extraction = includedCostPurposes.extraction;
  const sidecar = includedCostPurposes.sidecar;
  if (
    Object.keys(includedCostPurposes).some(
      key => !purposeKeys.some(purpose => purpose === key),
    )
    || typeof conversationTurn !== 'boolean'
    || typeof tool !== 'boolean'
    || typeof summary !== 'boolean'
    || typeof extraction !== 'boolean'
    || typeof sidecar !== 'boolean'
    || !conversationTurn
  ) {
    throw new Error('ICP conversation cost policy has an invalid includedCostPurposes map');
  }
  return {
    enabled: true,
    warningThresholdUsd,
    hardLimitUsd,
    finalCloseoutReserveUsd,
    pendingReservationStaleAfterMs,
    includedCostPurposes: {
      conversation_turn: conversationTurn,
      tool,
      summary,
      extraction,
      sidecar,
    },
  };
}

function readIcpCostPurposeFromMetadata(metadata: Record<string, unknown>): string | undefined {
  const icpCost = metadata.icpCost;
  if (!isRecord(icpCost) || typeof icpCost.purpose !== 'string') return undefined;
  return icpCost.purpose.trim() || undefined;
}

function mergeCostTotal(
  cost: ModelUsageCostBreakdown | undefined,
  total: number | undefined,
  field: string,
): ModelUsageCostBreakdown | undefined {
  if (!cost && total === undefined) return undefined;
  if (
    cost?.total !== undefined
    && total !== undefined
    && Math.round(cost.total * 1_000_000_000_000) !== Math.round(total * 1_000_000_000_000)
  ) {
    throw new Error(`${field}Usd must match the structured total`);
  }
  return {
    ...(cost ?? {}),
    ...(cost?.total === undefined && total !== undefined ? { total } : {}),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter(key => record[key] !== undefined)
      .map(key => [key, canonicalize(record[key])]),
  );
}

function eventFingerprint(event: ModelUsageEvent): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(event)))
    .digest('hex');
}

function dayKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function monthKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 7);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_EVENT_LIMIT;
  }
  return Math.min(MAX_EVENT_LIMIT, Math.floor(limit));
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeEvent(
  input: ModelUsageEventInput,
  expectedCompanionId?: string,
): ModelUsageEvent {
  const declaredCurrency = optionalText(input.currency)?.toUpperCase();
  if (declaredCurrency && declaredCurrency !== 'USD') {
    throw new Error('currency must be USD until explicit currency conversion is implemented');
  }
  const recordedAtMs = inputNonNegativeInteger(input.recordedAtMs, 'recordedAtMs', Date.now());
  const startedAtMs = inputNonNegativeInteger(input.startedAtMs, 'startedAtMs', recordedAtMs);
  const completedAtMs = input.completedAtMs !== undefined
    ? inputNonNegativeInteger(input.completedAtMs, 'completedAtMs')
    : undefined;
  const durationMs = input.durationMs !== undefined
    ? inputNonNegativeInteger(input.durationMs, 'durationMs')
    : (completedAtMs !== undefined ? Math.max(0, completedAtMs - startedAtMs) : undefined);
  const inputTokens = inputNonNegativeInteger(input.inputTokens, 'inputTokens');
  const outputTokens = inputNonNegativeInteger(input.outputTokens, 'outputTokens');
  const cacheReadTokens = inputNonNegativeInteger(input.cacheReadTokens, 'cacheReadTokens');
  const cacheWriteTokens = inputNonNegativeInteger(input.cacheWriteTokens, 'cacheWriteTokens');
  const providerCost = mergeCostTotal(input.providerCost, input.providerCostUsd, 'providerCost');
  const estimatedCost = mergeCostTotal(input.estimatedCost, input.estimatedCostUsd, 'estimatedCost');
  const effectiveCost = mergeCostTotal(input.effectiveCost, input.effectiveCostUsd, 'effectiveCost');
  const accounting = reconcileModelUsageAccounting({
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(input.totalTokens !== undefined ? { totalTokens: input.totalTokens } : {}),
    },
    ...(providerCost ? { providerCost } : {}),
    ...(estimatedCost ? { estimatedCost } : {}),
    ...(effectiveCost ? { effectiveCost } : {}),
    ...(input.costSource ? { costSource: input.costSource } : {}),
  });
  const providerCostUsd = accounting.providerCost.total;
  const estimatedCostUsd = accounting.estimatedCost.total;
  const effectiveCostUsd = accounting.effectiveCost.total;
  const logicalCallId = normalizeText(input.logicalCallId, `usage-${recordedAtMs}`);
  const attempt = inputNonNegativeInteger(input.attempt, 'attempt');
  const declaredCompanionId = optionalText(input.attribution.companionId);
  if (!expectedCompanionId && !declaredCompanionId) {
    throw new Error('Fleet model usage events require an explicit companionId attribution');
  }
  if (expectedCompanionId && declaredCompanionId && declaredCompanionId !== expectedCompanionId) {
    throw new Error(
      `Model usage companion attribution ${JSON.stringify(declaredCompanionId)} does not match `
      + `the store tenant ${JSON.stringify(expectedCompanionId)}`,
    );
  }
  const attribution = normalizeModelUsageAttribution({
    ...input.attribution,
    ...(expectedCompanionId ? { companionId: expectedCompanionId } : {}),
  });

  return {
    id: normalizeText(input.id, `${logicalCallId}:${attempt}`),
    logicalCallId,
    attempt,
    recordedAtMs,
    startedAtMs,
    ...(completedAtMs !== undefined ? { completedAtMs } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(input.ttftMs !== undefined ? { ttftMs: inputNonNegativeInteger(input.ttftMs, 'ttftMs') } : {}),
    dayKey: dayKey(recordedAtMs),
    monthKey: monthKey(recordedAtMs),
    status: input.status,
    settlement: input.settlement ?? (input.status === 'success' ? 'complete' : 'unknown'),
    callKind: input.callKind,
    attribution,
    provider: normalizeText(input.provider, 'unknown'),
    model: normalizeText(input.model, 'unknown'),
    ...(optionalText(input.slotKey) ? { slotKey: optionalText(input.slotKey) } : {}),
    ...(optionalText(input.requestedProvider) ? { requestedProvider: optionalText(input.requestedProvider) } : {}),
    ...(optionalText(input.requestedModel) ? { requestedModel: optionalText(input.requestedModel) } : {}),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: accounting.usage.totalTokens,
    ...(providerCostUsd !== undefined ? { providerCostUsd } : {}),
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
    ...(effectiveCostUsd !== undefined ? { effectiveCostUsd } : {}),
    providerCost: accounting.providerCost,
    estimatedCost: accounting.estimatedCost,
    effectiveCost: accounting.effectiveCost,
    costSource: accounting.costSource,
    ...(optionalText(declaredCurrency ?? accounting.effectiveCost.currency ?? accounting.providerCost.currency ?? accounting.estimatedCost.currency)
      ? { currency: optionalText(declaredCurrency ?? accounting.effectiveCost.currency ?? accounting.providerCost.currency ?? accounting.estimatedCost.currency) }
      : {}),
    ...(optionalText(input.stopReason) ? { stopReason: optionalText(input.stopReason) } : {}),
    ...(optionalText(input.errorCode) ? { errorCode: optionalText(input.errorCode) } : {}),
    ...(optionalText(input.errorMessage) ? { errorMessage: optionalText(input.errorMessage) } : {}),
    metadata: boundModelUsageMetadata(input.metadata),
  };
}

function mapEventRow(row: ModelUsageEventRow): ModelUsageEvent {
  const event: ModelUsageEvent = {
    id: row.id,
    logicalCallId: row.logical_call_id,
    attempt: nonNegativeInteger(row.attempt),
    recordedAtMs: nonNegativeInteger(row.recorded_at_ms),
    startedAtMs: nonNegativeInteger(row.started_at_ms),
    dayKey: row.day_key,
    monthKey: row.month_key,
    status: row.status,
    settlement: row.settlement,
    callKind: row.call_kind,
    attribution: normalizeModelUsageAttribution({
      companionId: row.companion_id,
      sessionId: row.session_id,
      channelId: row.channel_id ?? undefined,
      channelType: row.channel_type === MODEL_USAGE_UNKNOWN_DIMENSION
        ? undefined
        : row.channel_type as Exclude<
            ModelUsageEvent['attribution']['channelType'],
            typeof MODEL_USAGE_UNKNOWN_DIMENSION
          >,
      callType: row.call_type,
      purpose: row.purpose,
      originType: row.origin_type === null || row.origin_type === MODEL_USAGE_UNKNOWN_DIMENSION
        ? undefined
        : row.origin_type,
      originStage: row.origin_stage ?? undefined,
      service: row.service ?? undefined,
      process: row.process ?? undefined,
      turnId: row.turn_id ?? undefined,
      requestId: row.request_id ?? undefined,
      toolName: row.tool_name ?? undefined,
      toolCallId: row.tool_call_id ?? undefined,
      chargeLane: row.charge_lane === null || row.charge_lane === MODEL_USAGE_UNKNOWN_DIMENSION
        ? undefined
        : row.charge_lane,
      chargeSurface: row.charge_surface === null || row.charge_surface === MODEL_USAGE_UNKNOWN_DIMENSION
        ? undefined
        : row.charge_surface,
      chargeEventId: row.charge_event_id ?? undefined,
      chargeRunId: row.charge_run_id ?? undefined,
      chargeRootRunId: row.charge_root_run_id ?? undefined,
      chargeParentRunId: row.charge_parent_run_id ?? undefined,
      shardId: row.shard_id,
      subagentId: row.subagent_id,
      conversationId: row.conversation_id,
      rootInitiationId: row.root_initiation_id,
      workloadType: row.workload_type,
      workloadId: row.workload_id,
    }),
    provider: row.provider,
    model: row.model,
    inputTokens: nonNegativeInteger(row.input_tokens),
    outputTokens: nonNegativeInteger(row.output_tokens),
    cacheReadTokens: nonNegativeInteger(row.cache_read_tokens),
    cacheWriteTokens: nonNegativeInteger(row.cache_write_tokens),
    totalTokens: nonNegativeInteger(row.total_tokens),
    providerCost: mapCostBreakdown(row, 'provider'),
    estimatedCost: mapCostBreakdown(row, 'estimated'),
    effectiveCost: mapCostBreakdown(row, 'effective'),
    costSource: row.cost_source,
    metadata: parseMetadata(row.metadata_json),
  };
  if (row.completed_at_ms !== null) event.completedAtMs = nonNegativeInteger(row.completed_at_ms);
  if (row.duration_ms !== null) event.durationMs = nonNegativeInteger(row.duration_ms);
  if (row.ttft_ms !== null) event.ttftMs = nonNegativeInteger(row.ttft_ms);
  if (row.slot_key && row.slot_key !== MODEL_USAGE_UNKNOWN_DIMENSION) event.slotKey = row.slot_key;
  if (row.requested_provider && row.requested_provider !== MODEL_USAGE_UNKNOWN_DIMENSION) {
    event.requestedProvider = row.requested_provider;
  }
  if (row.requested_model && row.requested_model !== MODEL_USAGE_UNKNOWN_DIMENSION) {
    event.requestedModel = row.requested_model;
  }
  if (row.provider_cost_usd !== null) {
    const providerCostUsd = nonNegativeCost(row.provider_cost_usd);
    if (providerCostUsd !== undefined) {
      event.providerCostUsd = providerCostUsd;
    }
  }
  if (row.estimated_cost_usd !== null) {
    const estimatedCostUsd = nonNegativeCost(row.estimated_cost_usd);
    if (estimatedCostUsd !== undefined) event.estimatedCostUsd = estimatedCostUsd;
  }
  if (row.effective_cost_usd !== null) {
    const effectiveCostUsd = nonNegativeCost(row.effective_cost_usd);
    if (effectiveCostUsd !== undefined) event.effectiveCostUsd = effectiveCostUsd;
  }
  if (row.currency) event.currency = row.currency;
  if (row.stop_reason) event.stopReason = row.stop_reason;
  if (row.error_code) event.errorCode = row.error_code;
  if (row.error_message) event.errorMessage = row.error_message;
  return event;
}

function mapCostBreakdown(
  row: ModelUsageEventRow,
  source: 'provider' | 'estimated' | 'effective',
): ModelUsageCostBreakdown {
  const values = source === 'provider'
    ? {
        input: row.provider_input_cost_usd,
        output: row.provider_output_cost_usd,
        cacheRead: row.provider_cache_read_cost_usd,
        cacheWrite: row.provider_cache_write_cost_usd,
        total: row.provider_cost_usd,
      }
    : source === 'estimated'
      ? {
          input: row.estimated_input_cost_usd,
          output: row.estimated_output_cost_usd,
          cacheRead: row.estimated_cache_read_cost_usd,
          cacheWrite: row.estimated_cache_write_cost_usd,
          total: row.estimated_cost_usd,
        }
      : {
          input: row.effective_input_cost_usd,
          output: row.effective_output_cost_usd,
          cacheRead: row.effective_cache_read_cost_usd,
          cacheWrite: row.effective_cache_write_cost_usd,
          total: row.effective_cost_usd,
        };
  return {
    ...(values.input !== null ? { input: nonNegativeCost(values.input) } : {}),
    ...(values.output !== null ? { output: nonNegativeCost(values.output) } : {}),
    ...(values.cacheRead !== null ? { cacheRead: nonNegativeCost(values.cacheRead) } : {}),
    ...(values.cacheWrite !== null ? { cacheWrite: nonNegativeCost(values.cacheWrite) } : {}),
    ...(values.total !== null ? { total: nonNegativeCost(values.total) } : {}),
    ...(row.currency ? { currency: row.currency } : {}),
  };
}

function mapTotals(row: TotalsRow | undefined): ModelUsageTotals {
  const cost = (value: unknown): number => roundModelUsageUsd(nonNegativeCost(value) ?? 0);
  const aggregateCost = (
    prefix: 'provider' | 'estimated' | 'effective',
    totalField: 'provider_cost_usd' | 'estimated_cost_usd' | 'total_cost_usd',
  ) => ({
    inputUsd: cost(row?.[`${prefix}_input_cost_usd`]),
    inputKnownCalls: nonNegativeInteger(row?.[`${prefix}_input_known_calls`]),
    outputUsd: cost(row?.[`${prefix}_output_cost_usd`]),
    outputKnownCalls: nonNegativeInteger(row?.[`${prefix}_output_known_calls`]),
    cacheReadUsd: cost(row?.[`${prefix}_cache_read_cost_usd`]),
    cacheReadKnownCalls: nonNegativeInteger(row?.[`${prefix}_cache_read_known_calls`]),
    cacheWriteUsd: cost(row?.[`${prefix}_cache_write_cost_usd`]),
    cacheWriteKnownCalls: nonNegativeInteger(row?.[`${prefix}_cache_write_known_calls`]),
    totalUsd: cost(row?.[totalField]),
    totalKnownCalls: nonNegativeInteger(row?.[`${prefix}_cost_known_calls`]),
  });
  return {
    calls: nonNegativeInteger(row?.calls),
    successfulCalls: nonNegativeInteger(row?.successful_calls),
    failedCalls: nonNegativeInteger(row?.failed_calls),
    inputTokens: nonNegativeInteger(row?.input_tokens),
    outputTokens: nonNegativeInteger(row?.output_tokens),
    cacheReadTokens: nonNegativeInteger(row?.cache_read_tokens),
    cacheWriteTokens: nonNegativeInteger(row?.cache_write_tokens),
    totalTokens: nonNegativeInteger(row?.total_tokens),
    providerCostUsd: cost(row?.provider_cost_usd),
    estimatedCostUsd: cost(row?.estimated_cost_usd),
    totalCostUsd: cost(row?.total_cost_usd),
    providerCost: aggregateCost('provider', 'provider_cost_usd'),
    estimatedCost: aggregateCost('estimated', 'estimated_cost_usd'),
    effectiveCost: aggregateCost('effective', 'total_cost_usd'),
    totalDurationMs: nonNegativeInteger(row?.total_duration_ms),
    durationSamples: nonNegativeInteger(row?.duration_samples),
    totalTtftMs: nonNegativeInteger(row?.total_ttft_ms),
    ttftSamples: nonNegativeInteger(row?.ttft_samples),
    averageDurationMs: row?.average_duration_ms === null || row?.average_duration_ms === undefined
      ? null
      : asNumber(row.average_duration_ms),
    averageTtftMs: row?.average_ttft_ms === null || row?.average_ttft_ms === undefined
      ? null
      : asNumber(row.average_ttft_ms),
  };
}

function mapBreakdown(row: BreakdownRow): ModelUsageBreakdown {
  const metrics = mapTotals(row);
  return {
    key: row.key?.trim() || 'unknown',
    ...metrics,
  };
}

function mapExportRow(event: ModelUsageEvent): ModelUsageExportRow {
  return {
    id: event.id,
    logicalCallId: event.logicalCallId,
    attempt: event.attempt,
    recordedAtMs: event.recordedAtMs,
    status: event.status,
    callKind: event.callKind,
    attribution: event.attribution,
    provider: event.provider,
    model: event.model,
    ...(event.slotKey !== undefined ? { slotKey: event.slotKey } : {}),
    ...(event.requestedProvider !== undefined ? { requestedProvider: event.requestedProvider } : {}),
    ...(event.requestedModel !== undefined ? { requestedModel: event.requestedModel } : {}),
    inputTokens: event.inputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    outputTokens: event.outputTokens,
    totalTokens: event.totalTokens,
    providerCost: event.providerCost,
    estimatedCost: event.estimatedCost,
    effectiveCost: event.effectiveCost,
    costSource: event.costSource,
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.ttftMs !== undefined ? { ttftMs: event.ttftMs } : {}),
  };
}

const MODEL_USAGE_AGGREGATE_SQL = `
  COUNT(*) AS calls,
  COUNT(*) FILTER (WHERE status = 'success') AS successful_calls,
  COUNT(*) FILTER (WHERE status = 'failure') AS failed_calls,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(total_tokens), 0) AS total_tokens,
  COALESCE(SUM(provider_cost_usd), 0) AS provider_cost_usd,
  COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd,
  COALESCE(SUM(effective_cost_usd), 0) AS total_cost_usd,
  COALESCE(SUM(provider_input_cost_usd), 0) AS provider_input_cost_usd,
  COUNT(provider_input_cost_usd) AS provider_input_known_calls,
  COALESCE(SUM(provider_output_cost_usd), 0) AS provider_output_cost_usd,
  COUNT(provider_output_cost_usd) AS provider_output_known_calls,
  COALESCE(SUM(provider_cache_read_cost_usd), 0) AS provider_cache_read_cost_usd,
  COUNT(provider_cache_read_cost_usd) AS provider_cache_read_known_calls,
  COALESCE(SUM(provider_cache_write_cost_usd), 0) AS provider_cache_write_cost_usd,
  COUNT(provider_cache_write_cost_usd) AS provider_cache_write_known_calls,
  COUNT(provider_cost_usd) AS provider_cost_known_calls,
  COALESCE(SUM(estimated_input_cost_usd), 0) AS estimated_input_cost_usd,
  COUNT(estimated_input_cost_usd) AS estimated_input_known_calls,
  COALESCE(SUM(estimated_output_cost_usd), 0) AS estimated_output_cost_usd,
  COUNT(estimated_output_cost_usd) AS estimated_output_known_calls,
  COALESCE(SUM(estimated_cache_read_cost_usd), 0) AS estimated_cache_read_cost_usd,
  COUNT(estimated_cache_read_cost_usd) AS estimated_cache_read_known_calls,
  COALESCE(SUM(estimated_cache_write_cost_usd), 0) AS estimated_cache_write_cost_usd,
  COUNT(estimated_cache_write_cost_usd) AS estimated_cache_write_known_calls,
  COUNT(estimated_cost_usd) AS estimated_cost_known_calls,
  COALESCE(SUM(effective_input_cost_usd), 0) AS effective_input_cost_usd,
  COUNT(effective_input_cost_usd) AS effective_input_known_calls,
  COALESCE(SUM(effective_output_cost_usd), 0) AS effective_output_cost_usd,
  COUNT(effective_output_cost_usd) AS effective_output_known_calls,
  COALESCE(SUM(effective_cache_read_cost_usd), 0) AS effective_cache_read_cost_usd,
  COUNT(effective_cache_read_cost_usd) AS effective_cache_read_known_calls,
  COALESCE(SUM(effective_cache_write_cost_usd), 0) AS effective_cache_write_cost_usd,
  COUNT(effective_cache_write_cost_usd) AS effective_cache_write_known_calls,
  COUNT(effective_cost_usd) AS effective_cost_known_calls,
  COALESCE(SUM(duration_ms), 0) AS total_duration_ms,
  COUNT(duration_ms) AS duration_samples,
  COALESCE(SUM(ttft_ms), 0) AS total_ttft_ms,
  COUNT(ttft_ms) AS ttft_samples,
  AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS average_duration_ms,
  AVG(ttft_ms) FILTER (WHERE ttft_ms IS NOT NULL) AS average_ttft_ms
`;

function emptyAggregateCost(): ModelUsageTotals['providerCost'] {
  return {
    inputUsd: 0,
    inputKnownCalls: 0,
    outputUsd: 0,
    outputKnownCalls: 0,
    cacheReadUsd: 0,
    cacheReadKnownCalls: 0,
    cacheWriteUsd: 0,
    cacheWriteKnownCalls: 0,
    totalUsd: 0,
    totalKnownCalls: 0,
  };
}

function emptyModelUsageTotals(): ModelUsageTotals {
  return {
    calls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    providerCostUsd: 0,
    estimatedCostUsd: 0,
    totalCostUsd: 0,
    providerCost: emptyAggregateCost(),
    estimatedCost: emptyAggregateCost(),
    effectiveCost: emptyAggregateCost(),
    totalDurationMs: 0,
    durationSamples: 0,
    totalTtftMs: 0,
    ttftSamples: 0,
    averageDurationMs: null,
    averageTtftMs: null,
  };
}

function addAggregateCost(
  left: ModelUsageTotals['providerCost'],
  right: ModelUsageTotals['providerCost'],
): ModelUsageTotals['providerCost'] {
  return {
    inputUsd: roundModelUsageUsd(left.inputUsd + right.inputUsd),
    inputKnownCalls: left.inputKnownCalls + right.inputKnownCalls,
    outputUsd: roundModelUsageUsd(left.outputUsd + right.outputUsd),
    outputKnownCalls: left.outputKnownCalls + right.outputKnownCalls,
    cacheReadUsd: roundModelUsageUsd(left.cacheReadUsd + right.cacheReadUsd),
    cacheReadKnownCalls: left.cacheReadKnownCalls + right.cacheReadKnownCalls,
    cacheWriteUsd: roundModelUsageUsd(left.cacheWriteUsd + right.cacheWriteUsd),
    cacheWriteKnownCalls: left.cacheWriteKnownCalls + right.cacheWriteKnownCalls,
    totalUsd: roundModelUsageUsd(left.totalUsd + right.totalUsd),
    totalKnownCalls: left.totalKnownCalls + right.totalKnownCalls,
  };
}

function addModelUsageTotals(left: ModelUsageTotals, right: ModelUsageTotals): ModelUsageTotals {
  const durationSamples = left.durationSamples + right.durationSamples;
  const ttftSamples = left.ttftSamples + right.ttftSamples;
  const totalDurationMs = left.totalDurationMs + right.totalDurationMs;
  const totalTtftMs = left.totalTtftMs + right.totalTtftMs;
  return {
    calls: left.calls + right.calls,
    successfulCalls: left.successfulCalls + right.successfulCalls,
    failedCalls: left.failedCalls + right.failedCalls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    providerCostUsd: roundModelUsageUsd(left.providerCostUsd + right.providerCostUsd),
    estimatedCostUsd: roundModelUsageUsd(left.estimatedCostUsd + right.estimatedCostUsd),
    totalCostUsd: roundModelUsageUsd(left.totalCostUsd + right.totalCostUsd),
    providerCost: addAggregateCost(left.providerCost, right.providerCost),
    estimatedCost: addAggregateCost(left.estimatedCost, right.estimatedCost),
    effectiveCost: addAggregateCost(left.effectiveCost, right.effectiveCost),
    totalDurationMs,
    durationSamples,
    totalTtftMs,
    ttftSamples,
    averageDurationMs: durationSamples === 0 ? null : totalDurationMs / durationSamples,
    averageTtftMs: ttftSamples === 0 ? null : totalTtftMs / ttftSamples,
  };
}

function groupComparator(query: ModelUsageQuery): (left: ModelUsageGroup, right: ModelUsageGroup) => number {
  const sortBy = query.sortBy ?? 'effectiveCostUsd';
  const direction = query.sortDirection === 'asc' ? 1 : -1;
  const value = (group: ModelUsageGroup): number => {
    switch (sortBy) {
      case 'calls': return group.metrics.calls;
      case 'totalTokens': return group.metrics.totalTokens;
      case 'effectiveCostUsd': return group.metrics.totalCostUsd;
      case 'averageDurationMs': return group.metrics.averageDurationMs ?? -1;
      case 'averageTtftMs': return group.metrics.averageTtftMs ?? -1;
    }
  };
  return (left, right) => (
    direction * (value(left) - value(right))
    || JSON.stringify(left.dimensions).localeCompare(JSON.stringify(right.dimensions))
  );
}

interface ModelUsageEventCursor {
  queryHash: string;
  order: 'recent' | 'expensive';
  recordedAtMs: number;
  id: string;
  effectiveCostUsd: number;
}

function eventCursorQueryHash(query: ModelUsageQuery): string {
  const { cursor: _cursor, limit: _limit, ...stableQuery } = query;
  return createHash('sha256').update(JSON.stringify(canonicalize(stableQuery))).digest('hex');
}

function encodeEventCursor(
  event: ModelUsageEvent,
  order: ModelUsageEventCursor['order'],
  query: ModelUsageQuery,
): string {
  const cursor: ModelUsageEventCursor = {
    queryHash: eventCursorQueryHash(query),
    order,
    recordedAtMs: event.recordedAtMs,
    id: event.id,
    effectiveCostUsd: event.effectiveCostUsd ?? 0,
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeEventCursor(value: string, query: ModelUsageQuery): ModelUsageEventCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new Error('cursor is malformed');
  }
  if (!isRecord(parsed)) throw new Error('cursor is malformed');
  const keys = Object.keys(parsed);
  if (keys.some(key => !['queryHash', 'order', 'recordedAtMs', 'id', 'effectiveCostUsd'].includes(key))) {
    throw new Error('cursor contains unsupported fields');
  }
  if (
    parsed.queryHash !== eventCursorQueryHash(query)
    || (parsed.order !== 'recent' && parsed.order !== 'expensive')
    || !Number.isSafeInteger(parsed.recordedAtMs)
    || typeof parsed.id !== 'string'
    || !parsed.id
    || parsed.id.length > 512
    || typeof parsed.effectiveCostUsd !== 'number'
    || !Number.isFinite(parsed.effectiveCostUsd)
    || parsed.effectiveCostUsd < 0
  ) {
    throw new Error('cursor does not match this model usage query');
  }
  return parsed as unknown as ModelUsageEventCursor;
}

function appendEventCursor(
  where: SqlWhere,
  order: ModelUsageEventCursor['order'],
  cursor: ModelUsageEventCursor | undefined,
): SqlWhere {
  if (!cursor) return where;
  if (cursor.order !== order) throw new Error('cursor event order does not match the query');
  const values = [...where.values];
  const addValue = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  const recorded = addValue(cursor.recordedAtMs);
  const id = addValue(cursor.id);
  let cursorClause = `(recorded_at_ms < ${recorded} OR (recorded_at_ms = ${recorded} AND id < ${id}))`;
  if (order === 'expensive') {
    const cost = addValue(cursor.effectiveCostUsd);
    cursorClause = `(COALESCE(effective_cost_usd, 0) < ${cost}
      OR (COALESCE(effective_cost_usd, 0) = ${cost} AND recorded_at_ms < ${recorded})
      OR (COALESCE(effective_cost_usd, 0) = ${cost} AND recorded_at_ms = ${recorded} AND id < ${id}))`;
  }
  return {
    clause: where.clause ? `${where.clause} AND ${cursorClause}` : `WHERE ${cursorClause}`,
    values,
  };
}

export class PostgresModelUsageStore implements ModelUsageRecorder, ModelUsageQueryPort, ModelUsageCostHydrationQueryPort, ModelUsageBudgetQueryPort, ModelUsageExportPort, ModelUsageReconciliationQueryPort, IcpConversationCostAccountingPort {
  private readonly ready: Promise<void>;
  private readonly companionId?: string;

  constructor(
    private readonly pool: Pool,
    options: ModelUsageStoreScope,
  ) {
    this.companionId = resolveStoreCompanionId(options);
    this.ready = ensurePostgresSchemaWithAdvisoryLock(
      pool,
      POSTGRES_MODEL_USAGE_MIGRATIONS,
      POSTGRES_MODEL_USAGE_MIGRATION_ADVISORY_LOCK,
    );
  }

  static connect(databaseUrl: string, options: ModelUsageStoreScope): PostgresModelUsageStore {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-model-usage',
      allowExitOnIdle: true,
    });
    return new PostgresModelUsageStore(pool, options);
  }

  private requireFleetIcpCostAccounting(): void {
    if (this.companionId !== undefined) {
      throw new Error('ICP conversation cost accounting requires the fleet-scoped model usage store');
    }
  }

  private async lockIcpConversation(client: PoolClient, conversationId: string): Promise<void> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 1347240271))',
      [conversationId],
    );
  }

  private async assertIcpConversationRoot(
    client: PoolClient,
    conversationId: string,
    rootInitiationId: string,
  ): Promise<void> {
    const conflicting = await client.query<{ root_initiation_id: string }>(`
      SELECT root_initiation_id
      FROM icp_conversation_cost_reservations
      WHERE conversation_id = $1 AND root_initiation_id <> $2
      UNION ALL
      SELECT root_initiation_id
      FROM model_usage_events
      WHERE conversation_id = $1
        AND root_initiation_id <> $2
        AND metadata_json -> 'icpCost' ->> 'purpose' IN (
          'conversation_turn', 'tool', 'summary', 'extraction', 'sidecar'
        )
      LIMIT 1
    `, [conversationId, rootInitiationId]);
    if (conflicting.rows.length > 0) {
      throw new Error('ICP conversation cost accounting detected conflicting root initiation identity');
    }
  }

  private async queryIcpConversationCostProjection(
    client: PoolClient,
    query: IcpConversationCostProjectionQuery,
  ): Promise<IcpConversationCostProjection> {
    const policy = validateEnabledIcpCostPolicy(query.policy);
    const nowMs = inputNonNegativeInteger(query.nowMs, 'nowMs', Date.now());
    const includedPurposes = Object.entries(policy.includedCostPurposes)
      .filter(([, included]) => included)
      .map(([purpose]) => purpose);
    const row = (await client.query<IcpConversationCostProjectionRow>(`
      WITH matching_events AS (
        SELECT companion_id, effective_cost_usd, currency
        FROM model_usage_events
        WHERE conversation_id = $1
          AND root_initiation_id = $2
          AND shard_id = 'unknown'
          AND subagent_id = 'unknown'
          AND metadata_json -> 'icpCost' ->> 'purpose' = ANY($3::text[])
      ),
      matching_reservations AS (
        SELECT companion_id, projected_cost_usd, status, created_at_ms
        FROM icp_conversation_cost_reservations
        WHERE conversation_id = $1
          AND root_initiation_id = $2
          AND cost_purpose = ANY($3::text[])
      ),
      event_totals AS (
        SELECT
          COALESCE(SUM(effective_cost_usd) FILTER (
            WHERE effective_cost_usd IS NOT NULL AND currency = 'USD'
          ), 0) AS actual_cost_usd,
          COUNT(*) AS actual_attempt_count,
          COUNT(*) FILTER (
            WHERE effective_cost_usd IS NULL OR currency IS DISTINCT FROM 'USD'
          ) AS unknown_cost_attempt_count
        FROM matching_events
      ),
      reservation_totals AS (
        SELECT
          COALESCE(SUM(projected_cost_usd) FILTER (
            WHERE status IN ('pending', 'settled_unknown')
          ), 0) AS pending_projected_cost_usd,
          COUNT(*) FILTER (WHERE status IN ('pending', 'settled_unknown')) AS pending_reservation_count,
          COUNT(*) FILTER (
            WHERE status IN ('pending', 'settled_unknown') AND created_at_ms < $4
          ) AS stale_reservation_count,
          COUNT(*) FILTER (WHERE status IN ('settled', 'settled_unknown')) AS settled_reservation_count
        FROM matching_reservations
      ),
      companions AS (
        SELECT companion_id FROM matching_events
        UNION
        SELECT companion_id FROM matching_reservations
      )
      SELECT
        event_totals.*,
        reservation_totals.*,
        (SELECT COUNT(*) FROM companions) AS attributed_companion_count
      FROM event_totals, reservation_totals
    `, [
      query.conversationId,
      query.rootInitiationId,
      includedPurposes,
      Math.max(0, nowMs - policy.pendingReservationStaleAfterMs),
    ])).rows.at(0);
    if (!row) {
      throw new Error('ICP conversation cost projection query returned no aggregate row');
    }
    const actualCostUsd = roundModelUsageUsd(nonNegativeCost(row.actual_cost_usd) ?? 0);
    const pendingProjectedCostUsd = roundModelUsageUsd(
      nonNegativeCost(row.pending_projected_cost_usd) ?? 0,
    );
    const projectedTotalCostUsd = roundModelUsageUsd(actualCostUsd + pendingProjectedCostUsd);
    const unknownCostAttemptCount = nonNegativeInteger(row.unknown_cost_attempt_count);
    const enforcementState = unknownCostAttemptCount > 0
      ? 'unknown_cost'
      : projectedTotalCostUsd > policy.hardLimitUsd
        ? 'hard_stop'
        : projectedTotalCostUsd > policy.warningThresholdUsd
          ? 'warning'
          : 'normal';
    return {
      conversationId: query.conversationId,
      rootInitiationId: query.rootInitiationId,
      actualCostUsd,
      pendingProjectedCostUsd,
      projectedTotalCostUsd,
      warningThresholdUsd: policy.warningThresholdUsd,
      hardLimitUsd: policy.hardLimitUsd,
      remainingToHardLimitUsd: roundModelUsageUsd(
        Math.max(0, policy.hardLimitUsd - projectedTotalCostUsd),
      ),
      actualAttemptCount: nonNegativeInteger(row.actual_attempt_count),
      unknownCostAttemptCount,
      pendingReservationCount: nonNegativeInteger(row.pending_reservation_count),
      staleReservationCount: nonNegativeInteger(row.stale_reservation_count),
      settledReservationCount: nonNegativeInteger(row.settled_reservation_count),
      attributedCompanionCount: nonNegativeInteger(row.attributed_companion_count),
      enforcementState,
    };
  }

  private async recordIcpConversationCostDecision(
    client: PoolClient,
    input: {
      logicalCallId: string;
      attempt: number;
      recordedAtMs: number;
      companionId: string;
      costPurpose: string;
      closeoutEligible: boolean;
      allowed: boolean;
      replayed: boolean;
      reason: IcpConversationCostReservationReason;
      projectedRequestCostUsd: number;
      projectedTotalAfterAttemptUsd: number;
      projection: IcpConversationCostProjection;
    },
  ): Promise<void> {
    await client.query(`
      INSERT INTO icp_conversation_cost_decisions (
        decision_id, recorded_at_ms, logical_call_id, attempt, conversation_id,
        root_initiation_id, companion_id, cost_purpose, closeout_eligible,
        allowed, replayed, reason, projected_request_cost_usd, actual_cost_usd,
        pending_projected_cost_usd, projected_total_cost_usd,
        unknown_cost_attempt_count, warning_threshold_usd, hard_limit_usd
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19
      )
    `, [
      randomUUID(),
      input.recordedAtMs,
      input.logicalCallId,
      input.attempt,
      input.projection.conversationId,
      input.projection.rootInitiationId,
      input.companionId,
      input.costPurpose,
      input.closeoutEligible,
      input.allowed,
      input.replayed,
      input.reason,
      input.projectedRequestCostUsd,
      input.projection.actualCostUsd,
      input.projection.pendingProjectedCostUsd,
      input.projectedTotalAfterAttemptUsd,
      input.projection.unknownCostAttemptCount,
      input.projection.warningThresholdUsd,
      input.projection.hardLimitUsd,
    ]);
  }

  async getIcpConversationCostProjection(
    query: IcpConversationCostProjectionQuery,
  ): Promise<IcpConversationCostProjection> {
    this.requireFleetIcpCostAccounting();
    await this.ready;
    const conversationId = normalizeText(query.conversationId, '');
    const rootInitiationId = normalizeText(query.rootInitiationId, '');
    if (!conversationId || !rootInitiationId) {
      throw new Error('ICP conversation cost projection requires conversation and root initiation ids');
    }
    return await withPostgresClient(this.pool, async (client) => {
      await this.lockIcpConversation(client, conversationId);
      await this.assertIcpConversationRoot(client, conversationId, rootInitiationId);
      return await this.queryIcpConversationCostProjection(client, {
        ...query,
        conversationId,
        rootInitiationId,
      });
    });
  }

  async reserveIcpConversationCost(
    input: IcpConversationCostReservationInput,
  ): Promise<IcpConversationCostReservationResult> {
    this.requireFleetIcpCostAccounting();
    await this.ready;
    const policy = validateEnabledIcpCostPolicy(input.policy);
    const correlation = parseIcpConversationCorrelation(input.correlation);
    if (!policy.includedCostPurposes[correlation.costPurpose]) {
      throw new Error(`ICP cost purpose ${correlation.costPurpose} is excluded by owner policy`);
    }
    const logicalCallId = normalizeText(input.logicalCallId, '');
    if (!logicalCallId) throw new Error('ICP cost reservation requires logicalCallId');
    const attempt = inputNonNegativeInteger(input.attempt, 'attempt');
    const projectedCostUsd = inputNonNegativeCost(
      input.projectedCostUsd,
      'projectedCostUsd',
    );
    const requestedAtMs = inputNonNegativeInteger(input.requestedAtMs, 'requestedAtMs', Date.now());
    const closeoutEligible = correlation.costPurpose === 'conversation_turn'
      && correlation.fatigueDecision === 'allow_overcharge';

    return await withPostgresClient(this.pool, async (client) => {
      await this.lockIcpConversation(client, correlation.conversationId);
      await this.assertIcpConversationRoot(
        client,
        correlation.conversationId,
        correlation.rootInitiationId,
      );
      const existing = (await client.query<IcpConversationCostReservationRow>(`
        SELECT *
        FROM icp_conversation_cost_reservations
        WHERE logical_call_id = $1 AND attempt = $2
        FOR UPDATE
      `, [logicalCallId, attempt])).rows.at(0);
      if (existing) {
        if (
          existing.conversation_id !== correlation.conversationId
          || existing.root_initiation_id !== correlation.rootInitiationId
          || existing.companion_id !== correlation.localCompanionId
          || existing.cost_purpose !== correlation.costPurpose
          || existing.closeout_eligible !== closeoutEligible
          || Math.abs(asNumber(existing.projected_cost_usd) - projectedCostUsd) > 1e-12
        ) {
          throw new Error('ICP cost reservation identity conflicts with an existing physical attempt');
        }
        const projection = await this.queryIcpConversationCostProjection(client, {
          conversationId: correlation.conversationId,
          rootInitiationId: correlation.rootInitiationId,
          policy,
          nowMs: requestedAtMs,
        });
        const allowed = existing.status === 'pending';
        const reason: IcpConversationCostReservationReason = existing.status === 'settled_unknown'
          ? 'unknown_historical_cost'
          : existing.status === 'settled'
            ? 'attempt_already_settled'
            : existing.reservation_reason;
        await this.recordIcpConversationCostDecision(client, {
          logicalCallId,
          attempt,
          recordedAtMs: requestedAtMs,
          companionId: correlation.localCompanionId,
          costPurpose: correlation.costPurpose,
          closeoutEligible,
          allowed,
          replayed: true,
          reason,
          projectedRequestCostUsd: projectedCostUsd,
          projectedTotalAfterAttemptUsd: projection.projectedTotalCostUsd,
          projection,
        });
        return {
          allowed,
          replayed: true,
          reason,
          projectedRequestCostUsd: projectedCostUsd,
          projection,
        };
      }

      const before = await this.queryIcpConversationCostProjection(client, {
        conversationId: correlation.conversationId,
        rootInitiationId: correlation.rootInitiationId,
        policy,
        nowMs: requestedAtMs,
      });
      const projectedTotalAfterAttemptUsd = roundModelUsageUsd(
        before.projectedTotalCostUsd + projectedCostUsd,
      );
      let allowed = true;
      let reason: IcpConversationCostReservationReason = 'below_warning';
      if (before.unknownCostAttemptCount > 0) {
        allowed = false;
        reason = 'unknown_historical_cost';
      } else if (projectedTotalAfterAttemptUsd > policy.hardLimitUsd) {
        allowed = false;
        reason = 'hard_limit_exceeded';
      } else if (!closeoutEligible && projectedTotalAfterAttemptUsd > policy.warningThresholdUsd) {
        allowed = false;
        reason = 'warning_closeout_reserve_only';
      } else if (closeoutEligible && projectedTotalAfterAttemptUsd > policy.warningThresholdUsd) {
        reason = 'final_closeout_reserve';
      }

      let projection = before;
      if (allowed) {
        await client.query(`
          INSERT INTO icp_conversation_cost_reservations (
            logical_call_id, attempt, conversation_id, root_initiation_id,
            companion_id, cost_purpose, closeout_eligible, projected_cost_usd,
            status, reservation_reason, created_at_ms
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)
        `, [
          logicalCallId,
          attempt,
          correlation.conversationId,
          correlation.rootInitiationId,
          correlation.localCompanionId,
          correlation.costPurpose,
          closeoutEligible,
          projectedCostUsd,
          reason,
          requestedAtMs,
        ]);
        projection = await this.queryIcpConversationCostProjection(client, {
          conversationId: correlation.conversationId,
          rootInitiationId: correlation.rootInitiationId,
          policy,
          nowMs: requestedAtMs,
        });
      }
      await this.recordIcpConversationCostDecision(client, {
        logicalCallId,
        attempt,
        recordedAtMs: requestedAtMs,
        companionId: correlation.localCompanionId,
        costPurpose: correlation.costPurpose,
        closeoutEligible,
        allowed,
        replayed: false,
        reason,
        projectedRequestCostUsd: projectedCostUsd,
        projectedTotalAfterAttemptUsd,
        projection,
      });
      return {
        allowed,
        replayed: false,
        reason,
        projectedRequestCostUsd: projectedCostUsd,
        projection,
      };
    });
  }

  async recordUsageEvent(input: ModelUsageEventInput): Promise<void> {
    const event = normalizeEvent(input, this.companionId);
    await this.ready;
    await withPostgresClient(this.pool, async (client) => {
      const initialReservation = (await client.query<IcpConversationCostReservationRow>(`
        SELECT *
        FROM icp_conversation_cost_reservations
        WHERE logical_call_id = $1 AND attempt = $2
      `, [event.logicalCallId, event.attempt])).rows.at(0);
      let reservationForSettlement: IcpConversationCostReservationRow | undefined;
      if (initialReservation) {
        await this.lockIcpConversation(client, initialReservation.conversation_id);
        const lockedReservation = (await client.query<IcpConversationCostReservationRow>(`
          SELECT *
          FROM icp_conversation_cost_reservations
          WHERE logical_call_id = $1 AND attempt = $2
          FOR UPDATE
        `, [event.logicalCallId, event.attempt])).rows.at(0);
        const icpCostPurpose = readIcpCostPurposeFromMetadata(event.metadata);
        if (
          !lockedReservation
          || lockedReservation.conversation_id !== event.attribution.conversationId
          || lockedReservation.root_initiation_id !== event.attribution.rootInitiationId
          || lockedReservation.companion_id !== event.attribution.companionId
          || lockedReservation.cost_purpose !== icpCostPurpose
          || event.attribution.shardId !== MODEL_USAGE_UNKNOWN_DIMENSION
          || event.attribution.subagentId !== MODEL_USAGE_UNKNOWN_DIMENSION
        ) {
          throw new Error('Model usage event does not match its canonical ICP cost reservation');
        }
        reservationForSettlement = lockedReservation;
      }

      const inserted = (await client.query<{ id: string }>(`
      INSERT INTO model_usage_events (
        id, logical_call_id, attempt, recorded_at_ms, started_at_ms, completed_at_ms,
        duration_ms, ttft_ms, day_key, month_key, status, settlement, call_kind, call_type,
        purpose, origin_type, origin_stage, service, process, companion_id, session_id,
        turn_id, request_id, channel_id, channel_type, tool_name, tool_call_id,
        charge_lane, charge_surface, charge_event_id, charge_run_id, charge_root_run_id, charge_parent_run_id,
        shard_id, subagent_id, conversation_id, root_initiation_id, workload_type, workload_id,
        provider, model,
        slot_key, requested_provider, requested_model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, total_tokens,
        provider_input_cost_usd, provider_output_cost_usd,
        provider_cache_read_cost_usd, provider_cache_write_cost_usd, provider_cost_usd,
        estimated_input_cost_usd, estimated_output_cost_usd,
        estimated_cache_read_cost_usd, estimated_cache_write_cost_usd, estimated_cost_usd,
        effective_input_cost_usd, effective_output_cost_usd,
        effective_cache_read_cost_usd, effective_cache_write_cost_usd, effective_cost_usd,
        cost_source, currency, stop_reason, error_code, error_message, metadata_json,
        event_fingerprint
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21,
        $22, $23, $24, $25, $26, $27,
        $28, $29, $30, $31, $32, $33,
        $34, $35, $36, $37, $38, $39,
        $40, $41,
        $42, $43, $44, $45, $46,
        $47, $48, $49,
        $50, $51, $52, $53, $54,
        $55, $56, $57, $58, $59,
        $60, $61, $62, $63, $64,
        $65, $66, $67, $68, $69, $70::jsonb,
        $71
      )
      ON CONFLICT (logical_call_id, attempt) DO UPDATE
        SET id = model_usage_events.id
        WHERE model_usage_events.event_fingerprint = EXCLUDED.event_fingerprint
      RETURNING id
    `, [
      event.id,
      event.logicalCallId,
      event.attempt,
      event.recordedAtMs,
      event.startedAtMs,
      event.completedAtMs ?? null,
      event.durationMs ?? null,
      event.ttftMs ?? null,
      event.dayKey,
      event.monthKey,
      event.status,
      event.settlement,
      event.callKind,
      event.attribution.callType,
      event.attribution.purpose,
      event.attribution.originType,
      event.attribution.originStage,
      event.attribution.service,
      event.attribution.process,
      event.attribution.companionId,
      event.attribution.sessionId,
      event.attribution.turnId,
      event.attribution.requestId,
      event.attribution.channelId,
      event.attribution.channelType,
      event.attribution.toolName,
      event.attribution.toolCallId,
      event.attribution.chargeLane,
      event.attribution.chargeSurface,
      event.attribution.chargeEventId,
      event.attribution.chargeRunId,
      event.attribution.chargeRootRunId,
      event.attribution.chargeParentRunId,
      event.attribution.shardId,
      event.attribution.subagentId,
      event.attribution.conversationId,
      event.attribution.rootInitiationId,
      event.attribution.workloadType,
      event.attribution.workloadId,
      event.provider,
      event.model,
      event.slotKey ?? MODEL_USAGE_UNKNOWN_DIMENSION,
      event.requestedProvider ?? MODEL_USAGE_UNKNOWN_DIMENSION,
      event.requestedModel ?? MODEL_USAGE_UNKNOWN_DIMENSION,
      event.inputTokens,
      event.outputTokens,
      event.cacheReadTokens,
      event.cacheWriteTokens,
      event.totalTokens,
      event.providerCost.input ?? null,
      event.providerCost.output ?? null,
      event.providerCost.cacheRead ?? null,
      event.providerCost.cacheWrite ?? null,
      event.providerCostUsd ?? null,
      event.estimatedCost.input ?? null,
      event.estimatedCost.output ?? null,
      event.estimatedCost.cacheRead ?? null,
      event.estimatedCost.cacheWrite ?? null,
      event.estimatedCostUsd ?? null,
      event.effectiveCost.input ?? null,
      event.effectiveCost.output ?? null,
      event.effectiveCost.cacheRead ?? null,
      event.effectiveCost.cacheWrite ?? null,
      event.effectiveCostUsd ?? null,
      event.costSource,
      event.currency ?? null,
      event.stopReason ?? null,
      event.errorCode ?? null,
      event.errorMessage ?? null,
      JSON.stringify(event.metadata),
      eventFingerprint(event),
      ])).rows.at(0);
      if (!inserted) {
        throw new Error(
          `Model usage attempt ${event.logicalCallId}:${event.attempt} conflicts with an existing immutable model usage attempt`,
        );
      }
      if (reservationForSettlement) {
        const settlementKnown = event.settlement === 'complete'
          && event.effectiveCostUsd !== undefined
          && event.currency === 'USD';
        await client.query(`
          UPDATE icp_conversation_cost_reservations
          SET status = $3,
              settled_event_id = $4,
              settled_at_ms = $5
          WHERE logical_call_id = $1 AND attempt = $2
        `, [
          event.logicalCallId,
          event.attempt,
          settlementKnown ? 'settled' : 'settled_unknown',
          inserted.id,
          event.recordedAtMs,
        ]);
      }
    });
  }

  async getUsageData(query: ModelUsageQuery = {}): Promise<ModelUsageData> {
    await this.ready;
    const prepared = await this.prepareQuery(query);
    const { query: normalizedQuery, resolvedRange, where } = prepared;
    const groupedByDimensions = normalizedQuery.groupBy ?? [];
    const [
      totals,
      timeSeries,
      groups,
      eventPage,
      byModel,
      byPurpose,
      byTool,
      byCallKind,
      recentEvents,
      expensiveEvents,
      attributionCoverage,
      groupedByEntries,
    ] = await Promise.all([
      this.queryTotals(where),
      this.queryTimeSeries(where, resolvedRange),
      this.queryGroups(where, normalizedQuery),
      this.queryEventPage(where, normalizedQuery),
      this.queryBreakdown(where, "provider || ':' || model"),
      this.queryBreakdown(where, 'purpose'),
      this.queryBreakdown(where, 'tool_name'),
      this.queryBreakdown(where, 'call_kind'),
      this.queryEvents(where, normalizedQuery.limit, 'recorded_at_ms DESC, id DESC'),
      this.queryEvents(where, normalizedQuery.limit, 'COALESCE(effective_cost_usd, 0) DESC, recorded_at_ms DESC, id DESC'),
      this.queryAttributionCoverage(where),
      Promise.all(groupedByDimensions.map(async dimension => [
        dimension,
        await this.queryBreakdown(where, MODEL_USAGE_DIMENSION_SQL[dimension]),
      ] as const)),
    ]);
    return {
      query: normalizedQuery,
      resolvedRange,
      totals,
      timeSeries,
      groups,
      eventPage,
      byModel,
      byPurpose,
      byTool,
      byCallKind,
      groupedBy: Object.fromEntries(groupedByEntries),
      attributionCoverage,
      recentEvents,
      expensiveEvents,
    };
  }

  async getUsageEventsForReconciliation(
    query: ModelUsageReconciliationQuery = {},
  ): Promise<ModelUsageEvent[]> {
    await this.ready;
    const normalizedQuery = normalizeQuery(query, this.companionId);
    return await this.queryAllEvents(buildWhere(normalizedQuery));
  }

  async getUsageCostHydrationData(
    query: ModelUsageQuery = {},
    dimensions: readonly ModelUsageGroupDimension[],
  ): Promise<ModelUsageCostHydrationData> {
    await this.ready;
    const { where } = await this.prepareQuery(query);
    const uniqueDimensions = [...new Set(dimensions.map((dimension) => {
      if (typeof dimension !== 'string' || !GROUP_DIMENSION_SET.has(dimension)) {
        throw new Error(`Cost hydration has unsupported dimension ${JSON.stringify(dimension)}`);
      }
      return dimension;
    }))];
    const entries = await Promise.all(uniqueDimensions.map(async dimension => [
      dimension,
      await this.queryCostHydrationBreakdown(where, dimension),
    ] as const));
    return { byDimension: Object.fromEntries(entries) };
  }

  async exportUsageEvents(query: ModelUsageQuery = {}): Promise<ModelUsageExportData> {
    await this.ready;
    const prepared = await this.prepareQuery({ ...query, cursor: undefined });
    const rows = await queryRows<ModelUsageEventRow>(this.pool, `
      SELECT *
      FROM model_usage_events
      ${prepared.where.clause}
      ORDER BY recorded_at_ms ASC, id ASC
      LIMIT ${MAX_EXPORT_ROWS + 1}
    `, prepared.where.values);
    if (rows.length > MAX_EXPORT_ROWS) {
      throw new Error(`Model usage export exceeds the ${MAX_EXPORT_ROWS} row safety limit`);
    }
    return {
      query: prepared.query,
      resolvedRange: prepared.resolvedRange,
      rows: rows.map(row => mapExportRow(mapEventRow(row))),
    };
  }

  private async prepareQuery(query: ModelUsageQuery): Promise<PreparedModelUsageQuery> {
    const normalizedQuery = normalizeQuery(query, this.companionId);
    let allSinceMs: number | undefined;
    if ((normalizedQuery.range ?? 'all') === 'all') {
      const unboundedWhere = buildWhere({ ...normalizedQuery, sinceMs: undefined, untilMs: undefined });
      const earliest = await queryOne<{ earliest_ms: number | string | null }>(this.pool, `
        SELECT MIN(recorded_at_ms) AS earliest_ms
        FROM model_usage_events
        ${unboundedWhere.clause}
      `, unboundedWhere.values);
      if (earliest?.earliest_ms !== null && earliest?.earliest_ms !== undefined) {
        allSinceMs = nonNegativeInteger(earliest.earliest_ms);
      }
    }
    const resolvedRange = resolveModelUsageRange(normalizedQuery, {
      nowMs: Date.now(),
      ...(allSinceMs !== undefined ? { allSinceMs } : {}),
    });
    const canonicalQuery: ModelUsageQuery = {
      ...normalizedQuery,
      range: resolvedRange.range,
      timezone: resolvedRange.timezone,
    };
    const where = buildWhere({
      ...canonicalQuery,
      sinceMs: resolvedRange.sinceMs,
      untilMs: resolvedRange.untilMs,
    });
    return { query: canonicalQuery, resolvedRange, where };
  }

  async getModelBudgetSpend(
    nowMs = Date.now(),
    scope?: { companionId: string },
  ): Promise<ModelUsageBudgetSpendSnapshot> {
    await this.ready;
    const now = inputNonNegativeInteger(nowMs, 'nowMs');
    const requestedCompanionId = normalizeQueryText(scope?.companionId, 'companionId');
    if (this.companionId && requestedCompanionId && requestedCompanionId !== this.companionId) {
      throw new Error(
        `Model budget companionId ${JSON.stringify(requestedCompanionId)} does not match `
        + `the store tenant ${JSON.stringify(this.companionId)}`,
      );
    }
    const budgetCompanionId = this.companionId ?? requestedCompanionId;
    if (!budgetCompanionId) {
      throw new Error('Fleet model budget queries require an explicit companionId');
    }
    const nowDate = new Date(now);
    const day = dayKey(now);
    const month = monthKey(now);
    const dayStartMs = Date.parse(`${day}T00:00:00.000Z`);
    const monthStartMs = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1);
    const row = await queryOne<BudgetSpendRow>(this.pool, `
      SELECT
        COALESCE(SUM(estimated_cost_usd) FILTER (
          WHERE recorded_at_ms >= $1
        ), 0) AS daily_estimated_cost_usd,
        COALESCE(SUM(estimated_cost_usd), 0) AS monthly_estimated_cost_usd,
        COUNT(*) FILTER (
          WHERE recorded_at_ms >= $1 AND estimated_cost_usd IS NULL
        ) AS daily_unknown_cost_attempts,
        COUNT(*) FILTER (
          WHERE estimated_cost_usd IS NULL
        ) AS monthly_unknown_cost_attempts
      FROM model_usage_events
      WHERE recorded_at_ms >= $2
        AND recorded_at_ms <= $3
        AND call_kind IN ('chat', 'completion')
        AND companion_id = $4
    `, [dayStartMs, monthStartMs, now, budgetCompanionId]);
    return {
      dayKey: day,
      monthKey: month,
      dailyEstimatedCostUsd: roundModelUsageUsd(nonNegativeCost(row?.daily_estimated_cost_usd) ?? 0),
      monthlyEstimatedCostUsd: roundModelUsageUsd(nonNegativeCost(row?.monthly_estimated_cost_usd) ?? 0),
      dailyUnknownCostAttempts: nonNegativeInteger(row?.daily_unknown_cost_attempts),
      monthlyUnknownCostAttempts: nonNegativeInteger(row?.monthly_unknown_cost_attempts),
    };
  }

  private async queryTotals(where: SqlWhere): Promise<ModelUsageTotals> {
    const row = await queryOne<TotalsRow>(this.pool, `
      SELECT
        ${MODEL_USAGE_AGGREGATE_SQL}
      FROM model_usage_events
      ${where.clause}
    `, where.values);
    return mapTotals(row);
  }

  private async queryBreakdown(where: SqlWhere, expression: string): Promise<ModelUsageBreakdown[]> {
    const rows = await queryRows<BreakdownRow>(this.pool, `
      SELECT
        ${expression} AS key,
        ${MODEL_USAGE_AGGREGATE_SQL}
      FROM model_usage_events
      ${where.clause}
      GROUP BY key
      ORDER BY total_cost_usd DESC, total_tokens DESC, calls DESC, key ASC
      LIMIT ${DEFAULT_BREAKDOWN_LIMIT}
    `, where.values);
    return rows.map(mapBreakdown);
  }

  private async queryTimeSeries(
    where: SqlWhere,
    range: ModelUsageResolvedRange,
  ): Promise<ModelUsageTimeBucket[]> {
    const timezoneParameter = where.values.length + 1;
    const expression = range.bucket === 'hour'
      ? 'FLOOR(recorded_at_ms / 3600000.0) * 3600000'
      : `EXTRACT(EPOCH FROM (date_trunc('${range.bucket}', to_timestamp(recorded_at_ms / 1000.0) AT TIME ZONE $${timezoneParameter}) AT TIME ZONE $${timezoneParameter})) * 1000`;
    const values = range.bucket === 'hour' ? where.values : [...where.values, range.timezone];
    const rows = await queryRows<TimeBucketRow>(this.pool, `
      SELECT
        ${expression} AS bucket_start_ms,
        ${MODEL_USAGE_AGGREGATE_SQL}
      FROM model_usage_events
      ${where.clause}
      GROUP BY bucket_start_ms
      ORDER BY bucket_start_ms ASC
    `, values);
    const byStart = new Map(rows.map(row => [nonNegativeInteger(row.bucket_start_ms), mapTotals(row)]));
    return createModelUsageBucketBoundaries(range).map(boundary => ({
      startMs: boundary.startMs,
      endMs: boundary.endMs,
      ...emptyModelUsageTotals(),
      ...(byStart.get(boundary.startMs) ?? {}),
    }));
  }

  private async queryGroups(where: SqlWhere, query: ModelUsageQuery): Promise<ModelUsageGroup[]> {
    const dimensions = query.groupBy ?? [];
    if (dimensions.length === 0) return [];
    const expressions = dimensions.map(dimension => MODEL_USAGE_DIMENSION_SQL[dimension]);
    const rows = await queryRows<GroupRow>(this.pool, `
      SELECT
        ${expressions[0]} AS dimension_0,
        ${expressions[1] ?? 'NULL::text'} AS dimension_1,
        FALSE AS is_other,
        0 AS sort_rank,
        ${MODEL_USAGE_AGGREGATE_SQL}
      FROM model_usage_events
      ${where.clause}
      GROUP BY ${expressions.join(', ')}
      LIMIT 5001
    `, where.values);
    if (rows.length > 5_000) {
      throw new Error('Model usage grouping exceeds the 5000-group safety limit');
    }
    const groups = rows.map((row): ModelUsageGroup => ({
      dimensions: Object.fromEntries(dimensions.map((dimension, index) => [
        dimension,
        (index === 0 ? row.dimension_0 : row.dimension_1)?.trim() || MODEL_USAGE_UNKNOWN_DIMENSION,
      ])),
      isOther: false,
      metrics: mapTotals(row),
    }));
    groups.sort(groupComparator(query));
    const topN = query.topN ?? DEFAULT_TOP_N;
    if (groups.length <= topN) return groups;
    const visible = groups.slice(0, topN);
    const otherMetrics = groups.slice(topN).reduce(
      (total, group) => addModelUsageTotals(total, group.metrics),
      emptyModelUsageTotals(),
    );
    return [...visible, {
      dimensions: Object.fromEntries(dimensions.map(dimension => [dimension, 'Other'])),
      isOther: true,
      metrics: otherMetrics,
    }];
  }

  private async queryEventPage(where: SqlWhere, query: ModelUsageQuery): Promise<ModelUsageData['eventPage']> {
    const order = query.eventOrder ?? 'recent';
    const limit = normalizeLimit(query.limit);
    const cursor = query.cursor ? decodeEventCursor(query.cursor, query) : undefined;
    const cursorWhere = appendEventCursor(where, order, cursor);
    const orderBy = order === 'recent'
      ? 'recorded_at_ms DESC, id DESC'
      : 'COALESCE(effective_cost_usd, 0) DESC, recorded_at_ms DESC, id DESC';
    const rows = await queryRows<ModelUsageEventRow>(this.pool, `
      SELECT *
      FROM model_usage_events
      ${cursorWhere.clause}
      ORDER BY ${orderBy}
      LIMIT ${limit + 1}
    `, cursorWhere.values);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(mapEventRow);
    const last = items.at(-1);
    return {
      order,
      items,
      hasMore,
      nextCursor: hasMore && last ? encodeEventCursor(last, order, query) : null,
    };
  }

  private async queryCostHydrationBreakdown(
    where: SqlWhere,
    dimension: ModelUsageGroupDimension,
  ): Promise<ModelUsageCostHydrationBreakdown[]> {
    const expression = MODEL_USAGE_DIMENSION_SQL[dimension];
    const rows = await queryRows<CostHydrationBreakdownRow>(this.pool, `
      SELECT
        ${expression} AS key,
        provider || ':' || model AS model_key,
        cost_source,
        COUNT(*) AS calls,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(effective_cost_usd), 0) AS total_cost_usd
      FROM model_usage_events
      ${where.clause}
      GROUP BY key, model_key, cost_source
      ORDER BY key ASC, model_key ASC, cost_source ASC
    `, where.values);
    return rows.map(row => ({
      ...mapBreakdown(row),
      modelKey: row.model_key,
      costSource: row.cost_source,
    }));
  }

  private async queryAttributionCoverage(where: SqlWhere): Promise<ModelUsageAttributionCoverage> {
    const coverageColumns = MODEL_USAGE_GROUP_DIMENSIONS.flatMap((dimension, index) => {
      const expression = MODEL_USAGE_DIMENSION_SQL[dimension];
      return [
        `COUNT(*) FILTER (WHERE ${expression} <> '${MODEL_USAGE_UNKNOWN_DIMENSION}') AS known_${index}`,
        `COUNT(*) FILTER (WHERE ${expression} = '${MODEL_USAGE_UNKNOWN_DIMENSION}') AS unknown_${index}`,
      ];
    });
    const row = await queryOne<CoverageRow>(this.pool, `
      SELECT
        COUNT(*) AS total_calls,
        ${coverageColumns.join(',\n        ')}
      FROM model_usage_events
      ${where.clause}
    `, where.values);
    const totalCalls = nonNegativeInteger(row?.total_calls);
    return {
      totalCalls,
      byDimension: Object.fromEntries(MODEL_USAGE_GROUP_DIMENSIONS.map((dimension, index) => {
        const knownCalls = nonNegativeInteger(row?.[`known_${index}`]);
        const unknownCalls = nonNegativeInteger(row?.[`unknown_${index}`]);
        return [dimension, {
          knownCalls,
          unknownCalls,
          coveragePercent: totalCalls === 0 ? 0 : Math.round((knownCalls / totalCalls) * 10_000) / 100,
        }];
      })) as ModelUsageAttributionCoverage['byDimension'],
    };
  }

  private async queryEvents(where: SqlWhere, limit: number | undefined, orderBy: string): Promise<ModelUsageEvent[]> {
    const safeLimit = normalizeLimit(limit);
    const rows = await queryRows<ModelUsageEventRow>(this.pool, `
      SELECT *
      FROM model_usage_events
      ${where.clause}
      ORDER BY ${orderBy}
      LIMIT ${safeLimit}
    `, where.values);
    return rows.map(mapEventRow);
  }

  private async queryAllEvents(where: SqlWhere): Promise<ModelUsageEvent[]> {
    const rows = await queryRows<ModelUsageEventRow>(this.pool, `
      SELECT *
      FROM model_usage_events
      ${where.clause}
      ORDER BY recorded_at_ms ASC, logical_call_id ASC, attempt ASC, id ASC
    `, where.values);
    return rows.map(mapEventRow);
  }
}

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
  chargeLane: new Set(MODEL_USAGE_CHARGE_LANES),
  chargeSurface: new Set(MODEL_USAGE_CHARGE_SURFACES),
  status: new Set(MODEL_USAGE_STATUSES),
  costSource: new Set(MODEL_USAGE_COST_SOURCES),
  range: new Set(MODEL_USAGE_RANGES),
  bucket: new Set(MODEL_USAGE_BUCKETS),
  sortBy: new Set(MODEL_USAGE_GROUP_SORTS),
  sortDirection: new Set(MODEL_USAGE_SORT_DIRECTIONS),
  eventOrder: new Set(MODEL_USAGE_EVENT_ORDERS),
};
const GROUP_DIMENSION_SET: ReadonlySet<string> = new Set(MODEL_USAGE_GROUP_DIMENSIONS);
const QUERY_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'sinceMs',
  'untilMs',
  'limit',
  'topN',
  'groupBy',
  ...QUERY_TEXT_FIELDS,
  ...Object.keys(QUERY_ENUM_VALUES),
]);

function normalizeQueryInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeQueryText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  const maxLength = field === 'cursor' ? 2_048 : 512;
  if (normalized.length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters`);
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(normalized)) {
    throw new Error(`${field} must not contain control characters`);
  }
  return normalized;
}

function normalizeQuery(
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

function buildWhere(query: ModelUsageQuery): SqlWhere {
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

export function createPostgresModelUsageStoreFromConfig(
  config: Pick<SubstrateConfig, 'persistenceBackend' | 'postgresDatabaseUrl' | 'companionId'>,
  scope?: ModelUsageStoreScope,
): PostgresModelUsageStore | null {
  if (config.persistenceBackend !== 'postgres') {
    return null;
  }
  const databaseUrl = config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) return null;
  if (scope) return PostgresModelUsageStore.connect(databaseUrl, scope);
  const companionId = optionalText(config.companionId);
  if (!companionId) {
    throw new Error('PostgreSQL model usage persistence requires a configured companionId');
  }
  return PostgresModelUsageStore.connect(databaseUrl, { companionId });
}
