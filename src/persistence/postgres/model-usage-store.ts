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
} from '../../shared/telemetry/model-usage.js';
import { reconcileModelUsageAccounting } from '../../shared/telemetry/model-usage-accounting.js';
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
  call_type: ModelUsageEvent['callType'];
  purpose: string;
  origin_type: ModelUsageEvent['originType'] | null;
  origin_stage: string | null;
  service: string | null;
  process: string | null;
  turn_id: string | null;
  request_id: string | null;
  channel_id: string | null;
  tool_name: string | null;
  tool_call_id: string | null;
  charge_lane: ModelUsageEvent['chargeLane'] | null;
  charge_surface: ModelUsageEvent['chargeSurface'] | null;
  charge_run_id: string | null;
  charge_root_run_id: string | null;
  charge_parent_run_id: string | null;
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
  estimated_cost_usd: number | string;
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
  total_tokens: number | string | null;
  total_cost_usd: number | string | null;
}

interface SqlWhere {
  clause: string;
  values: unknown[];
}

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
): ModelUsageCostBreakdown | undefined {
  if (!cost && total === undefined) return undefined;
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

function normalizeEvent(input: ModelUsageEventInput): ModelUsageEvent {
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
  const accounting = reconcileModelUsageAccounting({
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(input.totalTokens !== undefined ? { totalTokens: input.totalTokens } : {}),
    },
    ...(mergeCostTotal(input.providerCost, input.providerCostUsd)
      ? { providerCost: mergeCostTotal(input.providerCost, input.providerCostUsd) }
      : {}),
    ...(mergeCostTotal(input.estimatedCost, input.estimatedCostUsd)
      ? { estimatedCost: mergeCostTotal(input.estimatedCost, input.estimatedCostUsd) }
      : {}),
    ...(mergeCostTotal(input.effectiveCost, input.effectiveCostUsd)
      ? { effectiveCost: mergeCostTotal(input.effectiveCost, input.effectiveCostUsd) }
      : {}),
    ...(input.costSource ? { costSource: input.costSource } : {}),
  });
  const providerCostUsd = accounting.providerCost.total;
  const estimatedCostUsd = accounting.estimatedCost.total ?? 0;
  const effectiveCostUsd = accounting.effectiveCost.total;
  const logicalCallId = normalizeText(input.logicalCallId, `usage-${recordedAtMs}`);
  const attempt = inputNonNegativeInteger(input.attempt, 'attempt');

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
    callType: input.callType,
    purpose: normalizeText(input.purpose, 'unknown'),
    ...(input.originType ? { originType: input.originType } : {}),
    ...(optionalText(input.originStage) ? { originStage: optionalText(input.originStage) } : {}),
    ...(optionalText(input.service) ? { service: optionalText(input.service) } : {}),
    ...(optionalText(input.process) ? { process: optionalText(input.process) } : {}),
    ...(optionalText(input.turnId) ? { turnId: optionalText(input.turnId) } : {}),
    ...(optionalText(input.requestId) ? { requestId: optionalText(input.requestId) } : {}),
    ...(optionalText(input.channelId) ? { channelId: optionalText(input.channelId) } : {}),
    ...(optionalText(input.toolName) ? { toolName: optionalText(input.toolName) } : {}),
    ...(optionalText(input.toolCallId) ? { toolCallId: optionalText(input.toolCallId) } : {}),
    ...(input.chargeLane ? { chargeLane: input.chargeLane } : {}),
    ...(input.chargeSurface ? { chargeSurface: input.chargeSurface } : {}),
    ...(optionalText(input.chargeRunId) ? { chargeRunId: optionalText(input.chargeRunId) } : {}),
    ...(optionalText(input.chargeRootRunId) ? { chargeRootRunId: optionalText(input.chargeRootRunId) } : {}),
    ...(optionalText(input.chargeParentRunId) ? { chargeParentRunId: optionalText(input.chargeParentRunId) } : {}),
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
    estimatedCostUsd,
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
    callType: row.call_type,
    purpose: row.purpose,
    provider: row.provider,
    model: row.model,
    inputTokens: nonNegativeInteger(row.input_tokens),
    outputTokens: nonNegativeInteger(row.output_tokens),
    cacheReadTokens: nonNegativeInteger(row.cache_read_tokens),
    cacheWriteTokens: nonNegativeInteger(row.cache_write_tokens),
    totalTokens: nonNegativeInteger(row.total_tokens),
    estimatedCostUsd: nonNegativeCost(row.estimated_cost_usd) ?? 0,
    providerCost: mapCostBreakdown(row, 'provider'),
    estimatedCost: mapCostBreakdown(row, 'estimated'),
    effectiveCost: mapCostBreakdown(row, 'effective'),
    costSource: row.cost_source,
    metadata: parseMetadata(row.metadata_json),
  };
  if (row.completed_at_ms !== null) event.completedAtMs = nonNegativeInteger(row.completed_at_ms);
  if (row.duration_ms !== null) event.durationMs = nonNegativeInteger(row.duration_ms);
  if (row.ttft_ms !== null) event.ttftMs = nonNegativeInteger(row.ttft_ms);
  if (row.origin_type) event.originType = row.origin_type;
  if (row.origin_stage) event.originStage = row.origin_stage;
  if (row.service) event.service = row.service;
  if (row.process) event.process = row.process;
  if (row.turn_id) event.turnId = row.turn_id;
  if (row.request_id) event.requestId = row.request_id;
  if (row.channel_id) event.channelId = row.channel_id;
  if (row.tool_name) event.toolName = row.tool_name;
  if (row.tool_call_id) event.toolCallId = row.tool_call_id;
  if (row.charge_lane) event.chargeLane = row.charge_lane;
  if (row.charge_surface) event.chargeSurface = row.charge_surface;
  if (row.charge_run_id) event.chargeRunId = row.charge_run_id;
  if (row.charge_root_run_id) event.chargeRootRunId = row.charge_root_run_id;
  if (row.charge_parent_run_id) event.chargeParentRunId = row.charge_parent_run_id;
  if (row.slot_key) event.slotKey = row.slot_key;
  if (row.requested_provider) event.requestedProvider = row.requested_provider;
  if (row.requested_model) event.requestedModel = row.requested_model;
  if (row.provider_cost_usd !== null) {
    const providerCostUsd = nonNegativeCost(row.provider_cost_usd);
    if (providerCostUsd !== undefined) {
      event.providerCostUsd = providerCostUsd;
    }
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
    totalTokens: nonNegativeInteger(row.total_tokens),
    totalCostUsd: nonNegativeCost(row.total_cost_usd) ?? 0,
  };
}

export class PostgresModelUsageStore implements ModelUsageRecorder, ModelUsageQueryPort {
  private readonly ready: Promise<void>;

  constructor(private readonly pool: Pool) {
    this.ready = ensurePostgresSchema(pool, POSTGRES_MODEL_USAGE_MIGRATIONS);
  }

  static connect(databaseUrl: string): PostgresModelUsageStore {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-model-usage',
      allowExitOnIdle: true,
    });
    return new PostgresModelUsageStore(pool);
  }

  async recordUsageEvent(input: ModelUsageEventInput): Promise<void> {
    const event = normalizeEvent(input);
    await this.ready;
    const inserted = await queryOne<{ id: string }>(this.pool, `
      INSERT INTO model_usage_events (
        id, logical_call_id, attempt, recorded_at_ms, started_at_ms, completed_at_ms,
        duration_ms, ttft_ms, day_key, month_key, status, settlement, call_kind, call_type,
        purpose, origin_type, origin_stage, service, process, turn_id, request_id,
        channel_id, tool_name, tool_call_id, charge_lane, charge_surface,
        charge_run_id, charge_root_run_id, charge_parent_run_id, provider, model,
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
        $22, $23, $24, $25, $26,
        $27, $28, $29, $30, $31,
        $32, $33, $34, $35, $36,
        $37, $38, $39,
        $40, $41, $42, $43, $44,
        $45, $46, $47, $48, $49,
        $50, $51, $52, $53, $54,
        $55, $56, $57, $58, $59, $60::jsonb,
        $61
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
      event.callType,
      event.purpose,
      event.originType ?? null,
      event.originStage ?? null,
      event.service ?? null,
      event.process ?? null,
      event.turnId ?? null,
      event.requestId ?? null,
      event.channelId ?? null,
      event.toolName ?? null,
      event.toolCallId ?? null,
      event.chargeLane ?? null,
      event.chargeSurface ?? null,
      event.chargeRunId ?? null,
      event.chargeRootRunId ?? null,
      event.chargeParentRunId ?? null,
      event.provider,
      event.model,
      event.slotKey ?? null,
      event.requestedProvider ?? null,
      event.requestedModel ?? null,
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
      event.estimatedCostUsd,
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
    const normalizedQuery = normalizeQuery(query);
    const where = buildWhere(normalizedQuery);
    const [totals, byModel, byPurpose, byTool, byCallKind, recentEvents, expensiveEvents] = await Promise.all([
      this.queryTotals(where),
      this.queryBreakdown(where, "provider || ':' || model"),
      this.queryBreakdown(where, 'purpose'),
      this.queryBreakdown(where, "COALESCE(tool_name, '(none)')"),
      this.queryBreakdown(where, 'call_kind'),
      this.queryEvents(where, normalizedQuery.limit, 'recorded_at_ms DESC, id DESC'),
      this.queryEvents(where, normalizedQuery.limit, 'COALESCE(effective_cost_usd, 0) DESC, recorded_at_ms DESC'),
    ]);
    return {
      query: normalizedQuery,
      totals,
      byModel,
      byPurpose,
      byTool,
      byCallKind,
      recentEvents,
      expensiveEvents,
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

function normalizeQuery(query: ModelUsageQuery): ModelUsageQuery {
  return {
    ...(Number.isFinite(query.sinceMs) ? { sinceMs: Math.max(0, Math.floor(query.sinceMs!)) } : {}),
    ...(Number.isFinite(query.untilMs) ? { untilMs: Math.max(0, Math.floor(query.untilMs!)) } : {}),
    limit: normalizeLimit(query.limit),
    ...(optionalText(query.provider) ? { provider: optionalText(query.provider) } : {}),
    ...(optionalText(query.model) ? { model: optionalText(query.model) } : {}),
    ...(optionalText(query.toolName) ? { toolName: optionalText(query.toolName) } : {}),
    ...(query.callKind ? { callKind: query.callKind } : {}),
    ...(optionalText(query.runId) ? { runId: optionalText(query.runId) } : {}),
  };
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
  if (query.toolName) push('tool_name =', query.toolName);
  if (query.callKind) push('call_kind =', query.callKind);
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
  config: Pick<SubstrateConfig, 'persistenceBackend' | 'postgresDatabaseUrl'>,
): PostgresModelUsageStore | null {
  if (config.persistenceBackend !== 'postgres') {
    return null;
  }
  const databaseUrl = config.postgresDatabaseUrl?.trim();
  return databaseUrl ? PostgresModelUsageStore.connect(databaseUrl) : null;
}
