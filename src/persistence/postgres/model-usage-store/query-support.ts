import { createHash } from 'node:crypto';
import type {
  FleetModelUsageTokenTotals,
  ModelUsageAttributionAnomalies,
  ModelUsageAttributionCoverage,
  ModelUsageBreakdown,
  ModelUsageCostBreakdown,
  ModelUsageEvent,
  ModelUsageExportRow,
  ModelUsageGroup,
  ModelUsageGroupDimension,
  ModelUsageQuery,
  ModelUsageTotals,
} from '../../../shared/telemetry/model-usage.js';
import {
  MODEL_USAGE_RETIRED_CHARGE_SURFACE,
  MODEL_USAGE_RETIRED_CHARGE_SURFACE_VALUES,
  MODEL_USAGE_UNKNOWN_DIMENSION,
  normalizeModelUsageAttribution,
  normalizeStoredModelUsageChargeSurface,
} from '../../../shared/telemetry/model-usage-attribution.js';
import { roundModelUsageUsd } from '../../../shared/telemetry/model-usage-accounting.js';
import { isRecord } from '../../../shared/utils/types.js';
import {
  asNumber,
  canonicalize,
  nonNegativeCost,
  nonNegativeInteger,
  normalizeTelemetryVisibility,
} from './common.js';
import type {
  BreakdownRow,
  FleetTokenTotalsRow,
  ModelUsageEventRow,
  SqlWhere,
  TotalsRow,
} from './rows.js';

export const MODEL_USAGE_DIMENSION_SQL: Record<ModelUsageGroupDimension, string> = {
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
  runtimeLaneClass: 'runtime_lane_class',
  chargeLane: 'charge_lane',
  chargeSurface: `CASE
    WHEN charge_surface IN (${
  MODEL_USAGE_RETIRED_CHARGE_SURFACE_VALUES.map(value => `'${value}'`).join(', ')
}) THEN '${MODEL_USAGE_RETIRED_CHARGE_SURFACE}'
    ELSE charge_surface
  END`,
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

export function mapEventRow(row: ModelUsageEventRow): ModelUsageEvent {
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
    telemetryVisibility: normalizeTelemetryVisibility(row.telemetry_visibility),
    attribution: {
      ...normalizeModelUsageAttribution({
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
        runtimeLaneClass: row.runtime_lane_class === null
          || row.runtime_lane_class === MODEL_USAGE_UNKNOWN_DIMENSION
          ? undefined
          : row.runtime_lane_class,
        chargeLane: row.charge_lane === null || row.charge_lane === MODEL_USAGE_UNKNOWN_DIMENSION
          ? undefined
          : row.charge_lane,
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
      }, {
        // A stored `unknown` is durable evidence, not permission to reclassify
        // history using today's inference rules.
        inferChargeLane: false,
      }),
      chargeSurface: normalizeStoredModelUsageChargeSurface(row.charge_surface),
    },
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

export function attributionAnomaliesFromCoverage(
  coverage: ModelUsageAttributionCoverage,
): ModelUsageAttributionAnomalies {
  const chargeLane = coverage.byDimension.chargeLane;
  const session = coverage.byDimension.sessionId;
  const unknownRatePercent = (dimension: typeof chargeLane): number => (
    coverage.totalCalls === 0
      ? 0
      : Math.round((dimension.unknownCalls / coverage.totalCalls) * 10_000) / 100
  );
  return {
    unknownChargeLaneCalls: chargeLane.unknownCalls,
    unknownChargeLaneRatePercent: unknownRatePercent(chargeLane),
    unknownSessionCalls: session.unknownCalls,
    unknownSessionRatePercent: unknownRatePercent(session),
  };
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

export function mapTotals(row: TotalsRow | undefined): ModelUsageTotals {
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

export function mapFleetTokenTotals(row?: FleetTokenTotalsRow): FleetModelUsageTokenTotals {
  return {
    calls: nonNegativeInteger(row?.calls),
    inputTokens: nonNegativeInteger(row?.input_tokens),
    outputTokens: nonNegativeInteger(row?.output_tokens),
    cacheReadTokens: nonNegativeInteger(row?.cache_read_tokens),
    cacheWriteTokens: nonNegativeInteger(row?.cache_write_tokens),
    totalTokens: nonNegativeInteger(row?.total_tokens),
  };
}

export function addFleetTokenTotals(
  left: FleetModelUsageTokenTotals,
  right: FleetModelUsageTokenTotals,
): FleetModelUsageTokenTotals {
  return {
    calls: left.calls + right.calls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

export function mapBreakdown(row: BreakdownRow): ModelUsageBreakdown {
  const metrics = mapTotals(row);
  return {
    key: row.key?.trim() || 'unknown',
    ...metrics,
  };
}

export function mapExportRow(event: ModelUsageEvent): ModelUsageExportRow {
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

export const MODEL_USAGE_AGGREGATE_SQL = `
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

export function emptyModelUsageTotals(): ModelUsageTotals {
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

export function addModelUsageTotals(left: ModelUsageTotals, right: ModelUsageTotals): ModelUsageTotals {
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

export function groupComparator(query: ModelUsageQuery): (left: ModelUsageGroup, right: ModelUsageGroup) => number {
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

export function encodeEventCursor(
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

export function decodeEventCursor(value: string, query: ModelUsageQuery): ModelUsageEventCursor {
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

export function appendEventCursor(
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
