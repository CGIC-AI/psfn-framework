import type { ObservabilityCallType } from '../contracts/runtime.js';
import type {
  ModelUsageAttribution,
  ModelUsageAttributionInput,
  ModelUsageChannelType,
  ModelUsageChargeLane,
  ModelUsageChargeSurface,
  ModelUsageGroupDimension,
} from './model-usage-attribution.js';

export {
  MODEL_USAGE_CALL_TYPES,
  MODEL_USAGE_CHANNEL_TYPES,
  MODEL_USAGE_CHARGE_LANES,
  MODEL_USAGE_CHARGE_SURFACES,
  MODEL_USAGE_GROUP_DIMENSIONS,
  MODEL_USAGE_ORIGIN_TYPES,
  MODEL_USAGE_UNKNOWN_DIMENSION,
} from './model-usage-attribution.js';
export type {
  ModelUsageAttribution,
  ModelUsageAttributionInput,
  ModelUsageGroupDimension,
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

export type ModelUsageCallKind = typeof MODEL_USAGE_CALL_KINDS[number];
export type ModelUsageStatus = typeof MODEL_USAGE_STATUSES[number];
export type ModelUsageSettlement = 'complete' | 'partial' | 'unknown';
export type ModelUsageCostSource = typeof MODEL_USAGE_COST_SOURCES[number];

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
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
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
  chargeLane?: ModelUsageChargeLane;
  chargeSurface?: ModelUsageChargeSurface;
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
  averageDurationMs: number | null;
  averageTtftMs: number | null;
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

export interface ModelUsageData {
  query: ModelUsageQuery;
  totals: ModelUsageTotals;
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
