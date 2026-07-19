import {
  COMPANION_PRIVATE_BACKGROUND_PURPOSE,
  type CorrelationMetadata,
  type ObservabilityCallType,
  type TelemetryVisibility,
} from '../contracts/runtime-base.js';
import type { IcpConversationCorrelation } from '../contracts/icp-autonomy.js';
import type { IcpCostBreakerConfig } from '../contracts/charge-policy.js';
import type {
  ModelUsageAttribution,
  ModelUsageAttributionInput,
  ModelUsageChannelType,
  ModelUsageChargeLane,
  ModelUsageChargeSurface,
  ModelUsageGroupDimension,
  ModelUsageRuntimeLaneClass,
} from './model-usage-attribution.js';

export {
  MODEL_USAGE_CALL_TYPES,
  MODEL_USAGE_CHANNEL_TYPES,
  MODEL_USAGE_CHARGE_LANES,
  MODEL_USAGE_CHARGE_SURFACES,
  MODEL_USAGE_GROUP_DIMENSIONS,
  MODEL_USAGE_ORIGIN_TYPES,
  MODEL_USAGE_RUNTIME_LANE_CLASSES,
  MODEL_USAGE_UNKNOWN_DIMENSION,
} from './model-usage-attribution.js';
export type {
  ModelUsageAttribution,
  ModelUsageAttributionInput,
  ModelUsageGroupDimension,
  ModelUsageRuntimeLaneClass,
} from './model-usage-attribution.js';

export const MODEL_USAGE_CALL_KINDS = [
  'chat',
  'completion',
  'embedding',
  'image_create',
  'image_edit',
] as const;
export const MODEL_USAGE_STATUSES = ['success', 'failure'] as const;
export const MODEL_USAGE_COST_SOURCES = ['provider', 'estimate', 'none'] as const;
export const MODEL_USAGE_RANGES = [
  'today',
  'week',
  'month',
  'quarter',
  'year',
  'all',
  'custom',
] as const;
export const MODEL_USAGE_BUCKETS = ['auto', 'hour', 'day', 'week', 'month'] as const;
export const MODEL_USAGE_GROUP_SORTS = [
  'calls',
  'totalTokens',
  'effectiveCostUsd',
  'averageDurationMs',
  'averageTtftMs',
] as const;
export const MODEL_USAGE_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export const MODEL_USAGE_EVENT_ORDERS = ['recent', 'expensive'] as const;

export type ModelUsageCallKind = typeof MODEL_USAGE_CALL_KINDS[number];
export type ModelUsageStatus = typeof MODEL_USAGE_STATUSES[number];
export type ModelUsageSettlement = 'complete' | 'partial' | 'unknown';
export type ModelUsageCostSource = typeof MODEL_USAGE_COST_SOURCES[number];
export type ModelUsageRange = typeof MODEL_USAGE_RANGES[number];
export type ModelUsageBucket = typeof MODEL_USAGE_BUCKETS[number];
export type ResolvedModelUsageBucket = Exclude<ModelUsageBucket, 'auto'>;
export type ModelUsageGroupSort = typeof MODEL_USAGE_GROUP_SORTS[number];
export type ModelUsageSortDirection = typeof MODEL_USAGE_SORT_DIRECTIONS[number];
export type ModelUsageEventOrder = typeof MODEL_USAGE_EVENT_ORDERS[number];

export const COMPANION_PRIVATE_BACKGROUND_TELEMETRY = Object.freeze({
  callType: 'background',
  purpose: COMPANION_PRIVATE_BACKGROUND_PURPOSE,
  originType: 'background',
  originStage: COMPANION_PRIVATE_BACKGROUND_PURPOSE,
  telemetryVisibility: 'companion_private',
}) satisfies Pick<
  CorrelationMetadata,
  'callType' | 'purpose' | 'originType' | 'originStage' | 'telemetryVisibility'
>;

export interface ModelUsageCostBreakdown {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  currency?: string;
}

export interface ModelUsageEventInput {
  id?: string;
  logicalCallId: string;
  attempt?: number;
  recordedAtMs?: number;
  startedAtMs?: number;
  completedAtMs?: number;
  durationMs?: number;
  ttftMs?: number;
  status: ModelUsageStatus;
  settlement?: ModelUsageSettlement;
  callKind: ModelUsageCallKind;
  /** Privacy visibility classifier; companion_private calls are filtered from operator telemetry. */
  telemetryVisibility?: TelemetryVisibility;
  attribution: ModelUsageAttributionInput;
  provider: string;
  model: string;
  slotKey?: string;
  requestedProvider?: string;
  requestedModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  providerCostUsd?: number;
  estimatedCostUsd?: number;
  effectiveCostUsd?: number;
  providerCost?: ModelUsageCostBreakdown;
  estimatedCost?: ModelUsageCostBreakdown;
  effectiveCost?: ModelUsageCostBreakdown;
  costSource?: ModelUsageCostSource;
  currency?: string;
  stopReason?: string;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface ModelUsageEvent extends Required<Pick<
  ModelUsageEventInput,
  | 'id'
  | 'logicalCallId'
  | 'attempt'
  | 'recordedAtMs'
  | 'startedAtMs'
  | 'status'
  | 'settlement'
  | 'callKind'
  | 'telemetryVisibility'
  | 'provider'
  | 'model'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'totalTokens'
  | 'costSource'
  | 'providerCost'
  | 'estimatedCost'
  | 'effectiveCost'
>> {
  attribution: ModelUsageAttribution;
  dayKey: string;
  monthKey: string;
  completedAtMs?: number;
  durationMs?: number;
  ttftMs?: number;
  slotKey?: string;
  requestedProvider?: string;
  requestedModel?: string;
  providerCostUsd?: number;
  estimatedCostUsd?: number;
  effectiveCostUsd?: number;
  currency?: string;
  stopReason?: string;
  errorCode?: string;
  errorMessage?: string;
  metadata: Record<string, unknown>;
}

export interface ModelUsageQuery {
  range?: ModelUsageRange;
  /** IANA timezone used only to resolve calendar ranges and day/week/month buckets. */
  timezone?: string;
  sinceMs?: number;
  untilMs?: number;
  bucket?: ModelUsageBucket;
  limit?: number;
  cursor?: string;
  eventOrder?: ModelUsageEventOrder;
  topN?: number;
  sortBy?: ModelUsageGroupSort;
  sortDirection?: ModelUsageSortDirection;
  provider?: string;
  model?: string;
  toolName?: string;
  callKind?: ModelUsageCallKind;
  callType?: ObservabilityCallType;
  purpose?: string;
  originType?: ObservabilityCallType | 'unknown';
  originStage?: string;
  service?: string;
  process?: string;
  companionId?: string;
  sessionId?: string;
  channelId?: string;
  channelType?: ModelUsageChannelType;
  turnId?: string;
  requestId?: string;
  toolCallId?: string;
  runtimeLaneClass?: ModelUsageRuntimeLaneClass;
  chargeLane?: ModelUsageChargeLane;
  chargeSurface?: ModelUsageChargeSurface;
  chargeEventId?: string;
  chargeRunId?: string;
  chargeRootRunId?: string;
  chargeParentRunId?: string;
  shardId?: string;
  subagentId?: string;
  conversationId?: string;
  rootInitiationId?: string;
  workloadType?: string;
  workloadId?: string;
  slotKey?: string;
  requestedProvider?: string;
  requestedModel?: string;
  status?: ModelUsageStatus;
  costSource?: ModelUsageCostSource;
  runId?: string;
  /** Internal detail filter. Operator services force this to operator_visible. */
  telemetryVisibility?: TelemetryVisibility;
  groupBy?: ModelUsageGroupDimension[];
}

export interface ModelUsageTotals {
  calls: number;
  successfulCalls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  providerCostUsd: number;
  estimatedCostUsd: number;
  totalCostUsd: number;
  providerCost: ModelUsageAggregateCost;
  estimatedCost: ModelUsageAggregateCost;
  effectiveCost: ModelUsageAggregateCost;
  totalDurationMs: number;
  durationSamples: number;
  totalTtftMs: number;
  ttftSamples: number;
  averageDurationMs: number | null;
  averageTtftMs: number | null;
}

export interface ModelUsageAggregateCost {
  inputUsd: number;
  inputKnownCalls: number;
  outputUsd: number;
  outputKnownCalls: number;
  cacheReadUsd: number;
  cacheReadKnownCalls: number;
  cacheWriteUsd: number;
  cacheWriteKnownCalls: number;
  totalUsd: number;
  totalKnownCalls: number;
}

export interface ModelUsageBreakdown {
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  successfulCalls?: number;
  failedCalls?: number;
  providerCost?: ModelUsageAggregateCost;
  estimatedCost?: ModelUsageAggregateCost;
  effectiveCost?: ModelUsageAggregateCost;
  totalDurationMs?: number;
  durationSamples?: number;
  totalTtftMs?: number;
  ttftSamples?: number;
  averageDurationMs?: number | null;
  averageTtftMs?: number | null;
}

export interface ModelUsageResolvedRange {
  range: ModelUsageRange;
  timezone: string;
  sinceMs: number;
  untilMs: number;
  bucket: ResolvedModelUsageBucket;
  /** Every analytics query uses the half-open interval [sinceMs, untilMs). */
  boundary: '[sinceMs, untilMs)';
  calendarWeekStartsOn: 'monday';
}

export interface ModelUsageTimeBucket extends ModelUsageTotals {
  startMs: number;
  endMs: number;
}

/** Sparse per-key totals for one resolved time bucket. */
export interface ModelUsageDimensionTimeBucket extends ModelUsageTimeBucket {
  key: string;
}

export interface ModelUsageGroup {
  dimensions: Partial<Record<ModelUsageGroupDimension, string>>;
  isOther: boolean;
  metrics: ModelUsageTotals;
}

export interface ModelUsageEventPage {
  order: ModelUsageEventOrder;
  items: ModelUsageEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Complete aggregate slice used to hydrate missing costs without reading display-limited events. */
export interface ModelUsageCostHydrationBreakdown extends ModelUsageBreakdown {
  modelKey: string;
  costSource: ModelUsageCostSource;
}

export interface ModelUsageCostHydrationData {
  byDimension: Partial<Record<ModelUsageGroupDimension, ModelUsageCostHydrationBreakdown[]>>;
}

export interface ModelUsageDimensionCoverage {
  knownCalls: number;
  unknownCalls: number;
  coveragePercent: number;
}

export interface ModelUsageAttributionCoverage {
  totalCalls: number;
  byDimension: Record<ModelUsageGroupDimension, ModelUsageDimensionCoverage>;
}

export interface ModelUsagePeriodComparison {
  sinceMs: number;
  untilMs: number;
  totals: ModelUsageTotals;
}

export interface ModelUsageData {
  query: ModelUsageQuery;
  resolvedRange: ModelUsageResolvedRange;
  totals: ModelUsageTotals;
  previousPeriod?: ModelUsagePeriodComparison;
  timeSeries: ModelUsageTimeBucket[];
  /** Sparse series for the chart's provider:model key and the query's primary group dimension. */
  seriesByDimension?: Partial<Record<ModelUsageGroupDimension, ModelUsageDimensionTimeBucket[]>>;
  groups: ModelUsageGroup[];
  eventPage: ModelUsageEventPage;
  byModel: ModelUsageBreakdown[];
  byPurpose: ModelUsageBreakdown[];
  byTool: ModelUsageBreakdown[];
  byCallKind: ModelUsageBreakdown[];
  groupedBy: Partial<Record<ModelUsageGroupDimension, ModelUsageBreakdown[]>>;
  attributionCoverage: ModelUsageAttributionCoverage;
  recentEvents: ModelUsageEvent[];
  expensiveEvents: ModelUsageEvent[];
}

export interface ModelUsageRecorder {
  recordUsageEvent(event: ModelUsageEventInput): Promise<void>;
}

export interface ModelUsageQueryPort {
  getUsageData(query?: ModelUsageQuery): Promise<ModelUsageData>;
}

export interface ModelUsageExportRow {
  id: string;
  logicalCallId: string;
  attempt: number;
  recordedAtMs: number;
  status: ModelUsageStatus;
  callKind: ModelUsageCallKind;
  attribution: ModelUsageAttribution;
  provider: string;
  model: string;
  slotKey?: string;
  requestedProvider?: string;
  requestedModel?: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
  providerCost: ModelUsageCostBreakdown;
  estimatedCost: ModelUsageCostBreakdown;
  effectiveCost: ModelUsageCostBreakdown;
  costSource: ModelUsageCostSource;
  durationMs?: number;
  ttftMs?: number;
}

export interface ModelUsageExportData {
  query: ModelUsageQuery;
  resolvedRange: ModelUsageResolvedRange;
  rows: ModelUsageExportRow[];
}

export interface ModelUsageExportPort {
  exportUsageEvents(query?: ModelUsageQuery): Promise<ModelUsageExportData>;
}

export type ModelUsageReconciliationQuery = Omit<ModelUsageQuery, 'limit' | 'groupBy'>;

/** Internal complete event read for reconciling the immutable usage and charge ledgers. */
export interface ModelUsageReconciliationQueryPort {
  getUsageEventsForReconciliation(query?: ModelUsageReconciliationQuery): Promise<ModelUsageEvent[]>;
}

export interface ModelUsageCostHydrationQueryPort extends ModelUsageQueryPort {
  getUsageCostHydrationData(
    query: ModelUsageQuery | undefined,
    dimensions: readonly ModelUsageGroupDimension[],
  ): Promise<ModelUsageCostHydrationData>;
}

export interface ModelUsageBudgetSpendSnapshot {
  dayKey: string;
  monthKey: string;
  dailyEstimatedCostUsd: number;
  monthlyEstimatedCostUsd: number;
  dailyUnknownCostAttempts: number;
  monthlyUnknownCostAttempts: number;
}

/** Canonical budget projection over immutable PostgreSQL model attempts. */
export interface ModelUsageBudgetQueryPort {
  getModelBudgetSpend(
    nowMs?: number,
    scope?: { companionId: string },
  ): Promise<ModelUsageBudgetSpendSnapshot>;
}

export type EnabledIcpCostBreakerPolicy = Extract<IcpCostBreakerConfig, { enabled: true }>;

export type IcpConversationCostEnforcementState =
  | 'normal'
  | 'warning'
  | 'hard_stop'
  | 'unknown_cost';

export interface IcpConversationCostProjection {
  conversationId: string;
  rootInitiationId: string;
  actualCostUsd: number;
  pendingProjectedCostUsd: number;
  projectedTotalCostUsd: number;
  warningThresholdUsd: number;
  hardLimitUsd: number;
  remainingToHardLimitUsd: number;
  actualAttemptCount: number;
  unknownCostAttemptCount: number;
  pendingReservationCount: number;
  staleReservationCount: number;
  settledReservationCount: number;
  attributedCompanionCount: number;
  enforcementState: IcpConversationCostEnforcementState;
}

export interface IcpConversationCostProjectionQuery {
  conversationId: string;
  rootInitiationId: string;
  policy: EnabledIcpCostBreakerPolicy;
  nowMs?: number;
}

export interface IcpConversationCostReservationInput {
  logicalCallId: string;
  attempt: number;
  projectedCostUsd: number;
  correlation: IcpConversationCorrelation;
  policy: EnabledIcpCostBreakerPolicy;
  requestedAtMs?: number;
}

export type IcpConversationCostReservationReason =
  | 'below_warning'
  | 'final_closeout_reserve'
  | 'warning_closeout_reserve_only'
  | 'hard_limit_exceeded'
  | 'unknown_historical_cost'
  | 'attempt_already_settled';

export interface IcpConversationCostReservationResult {
  allowed: boolean;
  replayed: boolean;
  reason: IcpConversationCostReservationReason;
  projectedRequestCostUsd: number;
  projection: IcpConversationCostProjection;
}

export type IcpConversationCostBreakerBlockReason =
  | Extract<
      IcpConversationCostReservationReason,
      | 'warning_closeout_reserve_only'
      | 'hard_limit_exceeded'
      | 'unknown_historical_cost'
      | 'attempt_already_settled'
    >
  | 'missing_cost_metadata'
  | 'accounting_unavailable';

export type IcpConversationCostBreakerDecisionReason =
  | IcpConversationCostReservationReason
  | 'missing_cost_metadata'
  | 'accounting_unavailable';

/** Content-free operator/Garden projection for one physical pre-call decision. */
export interface IcpConversationCostBreakerEvent {
  timestampMs: number;
  outcome: 'reserved' | 'warning' | 'blocked';
  reason: IcpConversationCostBreakerDecisionReason;
  logicalCallId: string;
  attempt: number;
  conversationId: string;
  rootInitiationId: string;
  localCompanionId: string;
  costPurpose: IcpConversationCorrelation['costPurpose'];
  costOriginStage: IcpConversationCorrelation['costOriginStage'];
  provider: string;
  model: string;
  slotKey?: string;
  routingPurpose: string;
  projectedRequestCostUsd?: number;
  replayed: boolean;
  projection?: IcpConversationCostProjection;
}

/** Fleet-only atomic reservation/query surface owned by canonical model accounting. */
export interface IcpConversationCostAccountingPort {
  reserveIcpConversationCost(
    input: IcpConversationCostReservationInput,
  ): Promise<IcpConversationCostReservationResult>;
  getIcpConversationCostProjection(
    query: IcpConversationCostProjectionQuery,
  ): Promise<IcpConversationCostProjection>;
}
