import type {
  ModelUsageCallKind,
  ModelUsageCostSource,
  ModelUsageEvent,
  ModelUsageQuery,
  ModelUsageResolvedRange,
  ModelUsageSettlement,
  ModelUsageStatus,
} from '../../../shared/telemetry/model-usage.js';

export interface ModelUsageEventRow {
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
  telemetry_visibility: NonNullable<ModelUsageEvent['telemetryVisibility']>;
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
  runtime_lane_class: ModelUsageEvent['attribution']['runtimeLaneClass'] | null;
  charge_lane: ModelUsageEvent['attribution']['chargeLane'] | null;
  charge_surface: string | null;
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

export interface TotalsRow {
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

export interface FleetTokenTotalsRow {
  companion_id: string;
  calls: number | string;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_write_tokens: number | string | null;
  total_tokens: number | string | null;
}

export interface FleetAllTokenTotalsRow extends FleetTokenTotalsRow {
  earliest_ms: number | string | null;
}

export interface BreakdownRow extends TotalsRow {
  key: string | null;
}

interface TimeBucketRow extends TotalsRow {
  bucket_start_ms: number | string;
}

export interface DimensionTimeBucketRow extends TimeBucketRow {
  series_key: string | null;
}

export interface GroupRow extends TotalsRow {
  dimension_0: string | null;
  dimension_1: string | null;
  is_other: boolean;
  sort_rank: number | string;
}

export interface CostHydrationBreakdownRow extends BreakdownRow {
  model_key: string;
  cost_source: ModelUsageCostSource;
}

export type CoverageRow = Record<string, number | string | null | undefined> & {
  total_calls: number | string;
};

export interface BudgetSpendRow {
  daily_estimated_cost_usd: number | string | null;
  monthly_estimated_cost_usd: number | string | null;
  daily_unknown_cost_attempts: number | string;
  monthly_unknown_cost_attempts: number | string;
}

export interface IcpConversationCostProjectionRow {
  actual_cost_usd: number | string | null;
  pending_projected_cost_usd: number | string | null;
  actual_attempt_count: number | string;
  unknown_cost_attempt_count: number | string;
  pending_reservation_count: number | string;
  stale_reservation_count: number | string;
  settled_reservation_count: number | string;
  attributed_companion_count: number | string;
}

export interface IcpConversationCostReservationRow {
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

export interface SqlWhere {
  clause: string;
  values: unknown[];
}

export interface PreparedModelUsageQuery {
  query: ModelUsageQuery;
  resolvedRange: ModelUsageResolvedRange;
  where: SqlWhere;
}
