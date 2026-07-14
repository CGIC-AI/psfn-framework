import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import {
  createPostgresPool,
  ensurePostgresSchema,
  queryOne,
  queryRows,
} from '../postgres.js';
import { POSTGRES_MODEL_USAGE_MIGRATIONS } from './migrations.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type {
  ModelUsageBreakdown,
  ModelUsageAttributionCoverage,
  ModelUsageBudgetQueryPort,
  ModelUsageBudgetSpendSnapshot,
  ModelUsageCallKind,
  ModelUsageCostSource,
  ModelUsageCostBreakdown,
  ModelUsageData,
  ModelUsageEvent,
  ModelUsageEventInput,
  ModelUsageQuery,
  ModelUsageQueryPort,
  ModelUsageRecorder,
  ModelUsageStatus,
  ModelUsageSettlement,
  ModelUsageTotals,
  ModelUsageGroupDimension,
} from '../../shared/telemetry/model-usage.js';
import {
  MODEL_USAGE_CALL_KINDS,
  MODEL_USAGE_COST_SOURCES,
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

const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 2_000;
const DEFAULT_BREAKDOWN_LIMIT = 20;

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
  average_duration_ms: number | string | null;
  average_ttft_ms: number | string | null;
}

interface BreakdownRow {
  key: string | null;
  calls: number | string;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_write_tokens: number | string | null;
  total_tokens: number | string | null;
  total_cost_usd: number | string | null;
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

interface SqlWhere {
  clause: string;
  values: unknown[];
}

export type ModelUsageStoreScope =
  | { companionId: string; fleetAggregation?: never }
  | { companionId?: never; fleetAggregation: true };

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
  return {
    calls: nonNegativeInteger(row?.calls),
    successfulCalls: nonNegativeInteger(row?.successful_calls),
    failedCalls: nonNegativeInteger(row?.failed_calls),
    inputTokens: nonNegativeInteger(row?.input_tokens),
    outputTokens: nonNegativeInteger(row?.output_tokens),
    cacheReadTokens: nonNegativeInteger(row?.cache_read_tokens),
    cacheWriteTokens: nonNegativeInteger(row?.cache_write_tokens),
    totalTokens: nonNegativeInteger(row?.total_tokens),
    providerCostUsd: nonNegativeCost(row?.provider_cost_usd) ?? 0,
    estimatedCostUsd: nonNegativeCost(row?.estimated_cost_usd) ?? 0,
    totalCostUsd: nonNegativeCost(row?.total_cost_usd) ?? 0,
    averageDurationMs: row?.average_duration_ms === null || row?.average_duration_ms === undefined
      ? null
      : asNumber(row.average_duration_ms),
    averageTtftMs: row?.average_ttft_ms === null || row?.average_ttft_ms === undefined
      ? null
      : asNumber(row.average_ttft_ms),
  };
}

function mapBreakdown(row: BreakdownRow): ModelUsageBreakdown {
  return {
    key: row.key?.trim() || 'unknown',
    calls: nonNegativeInteger(row.calls),
    inputTokens: nonNegativeInteger(row.input_tokens),
    outputTokens: nonNegativeInteger(row.output_tokens),
    cacheReadTokens: nonNegativeInteger(row.cache_read_tokens),
    cacheWriteTokens: nonNegativeInteger(row.cache_write_tokens),
    totalTokens: nonNegativeInteger(row.total_tokens),
    totalCostUsd: nonNegativeCost(row.total_cost_usd) ?? 0,
  };
}

export class PostgresModelUsageStore implements ModelUsageRecorder, ModelUsageQueryPort, ModelUsageBudgetQueryPort {
  private readonly ready: Promise<void>;
  private readonly companionId?: string;

  constructor(
    private readonly pool: Pool,
    options: ModelUsageStoreScope,
  ) {
    if ('companionId' in options) {
      this.companionId = optionalText(options.companionId);
      if (!this.companionId) {
        throw new Error('PostgresModelUsageStore companionId must be non-empty');
      }
    }
    this.ready = ensurePostgresSchema(pool, POSTGRES_MODEL_USAGE_MIGRATIONS);
  }

  static connect(databaseUrl: string, options: ModelUsageStoreScope): PostgresModelUsageStore {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-model-usage',
      allowExitOnIdle: true,
    });
    return new PostgresModelUsageStore(pool, options);
  }

  async recordUsageEvent(input: ModelUsageEventInput): Promise<void> {
    const event = normalizeEvent(input, this.companionId);
    await this.ready;
    const inserted = await queryOne<{ id: string }>(this.pool, `
      INSERT INTO model_usage_events (
        id, logical_call_id, attempt, recorded_at_ms, started_at_ms, completed_at_ms,
        duration_ms, ttft_ms, day_key, month_key, status, settlement, call_kind, call_type,
        purpose, origin_type, origin_stage, service, process, companion_id, session_id,
        turn_id, request_id, channel_id, channel_type, tool_name, tool_call_id,
        charge_lane, charge_surface, charge_run_id, charge_root_run_id, charge_parent_run_id,
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
        $28, $29, $30, $31, $32,
        $33, $34, $35, $36, $37, $38,
        $39, $40,
        $41, $42, $43, $44, $45,
        $46, $47, $48,
        $49, $50, $51, $52, $53,
        $54, $55, $56, $57, $58,
        $59, $60, $61, $62, $63,
        $64, $65, $66, $67, $68, $69::jsonb,
        $70
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
    ]);
    if (!inserted) {
      throw new Error(
        `Model usage attempt ${event.logicalCallId}:${event.attempt} conflicts with an existing immutable model usage attempt`,
      );
    }
  }

  async getUsageData(query: ModelUsageQuery = {}): Promise<ModelUsageData> {
    await this.ready;
    const normalizedQuery = normalizeQuery(query, this.companionId);
    const where = buildWhere(normalizedQuery);
    const groupedByDimensions = normalizedQuery.groupBy ?? [];
    const [
      totals,
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
      this.queryBreakdown(where, "provider || ':' || model"),
      this.queryBreakdown(where, 'purpose'),
      this.queryBreakdown(where, 'tool_name'),
      this.queryBreakdown(where, 'call_kind'),
      this.queryEvents(where, normalizedQuery.limit, 'recorded_at_ms DESC, id DESC'),
      this.queryEvents(where, normalizedQuery.limit, 'COALESCE(effective_cost_usd, 0) DESC, recorded_at_ms DESC'),
      this.queryAttributionCoverage(where),
      Promise.all(groupedByDimensions.map(async dimension => [
        dimension,
        await this.queryBreakdown(where, MODEL_USAGE_DIMENSION_SQL[dimension]),
      ] as const)),
    ]);
    return {
      query: normalizedQuery,
      totals,
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
        AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS average_duration_ms,
        AVG(ttft_ms) FILTER (WHERE ttft_ms IS NOT NULL) AS average_ttft_ms
      FROM model_usage_events
      ${where.clause}
    `, where.values);
    return mapTotals(row);
  }

  private async queryBreakdown(where: SqlWhere, expression: string): Promise<ModelUsageBreakdown[]> {
    const rows = await queryRows<BreakdownRow>(this.pool, `
      SELECT
        ${expression} AS key,
        COUNT(*) AS calls,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(effective_cost_usd), 0) AS total_cost_usd
      FROM model_usage_events
      ${where.clause}
      GROUP BY key
      ORDER BY total_cost_usd DESC, total_tokens DESC, calls DESC, key ASC
      LIMIT ${DEFAULT_BREAKDOWN_LIMIT}
    `, where.values);
    return rows.map(mapBreakdown);
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

const QUERY_ENUM_VALUES: Partial<Record<keyof ModelUsageQuery, ReadonlySet<string>>> = {
  callKind: new Set(MODEL_USAGE_CALL_KINDS),
  callType: new Set(MODEL_USAGE_CALL_TYPES),
  originType: new Set(MODEL_USAGE_ORIGIN_TYPES),
  channelType: new Set(MODEL_USAGE_CHANNEL_TYPES),
  chargeLane: new Set(MODEL_USAGE_CHARGE_LANES),
  chargeSurface: new Set(MODEL_USAGE_CHARGE_SURFACES),
  status: new Set(MODEL_USAGE_STATUSES),
  costSource: new Set(MODEL_USAGE_COST_SOURCES),
};
const GROUP_DIMENSION_SET: ReadonlySet<string> = new Set(MODEL_USAGE_GROUP_DIMENSIONS);
const QUERY_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'sinceMs',
  'untilMs',
  'limit',
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
  if (normalized.length > 512) throw new Error(`${field} must be at most 512 characters`);
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
  const normalized: ModelUsageQuery = {
    ...(sinceMs !== undefined ? { sinceMs } : {}),
    ...(untilMs !== undefined ? { untilMs } : {}),
    limit: Math.min(MAX_EVENT_LIMIT, limit ?? DEFAULT_EVENT_LIMIT),
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
  if (query.untilMs !== undefined) push('recorded_at_ms <=', query.untilMs);
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
