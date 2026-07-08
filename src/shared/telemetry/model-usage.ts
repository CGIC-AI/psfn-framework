import type { ObservabilityCallType } from '../contracts/runtime.js';
import type {
  ChargePolicyRuntimeLane,
  ChargePolicySurface,
} from '../contracts/charge-policy.js';

export const MODEL_USAGE_CALL_KINDS = [
  'chat',
  'completion',
  'embedding',
  'image_create',
  'image_edit',
] as const;

export type ModelUsageCallKind = typeof MODEL_USAGE_CALL_KINDS[number];
export type ModelUsageStatus = 'success' | 'failure';
export type ModelUsageCostSource = 'provider' | 'estimate' | 'none';

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
  callKind: ModelUsageCallKind;
  callType: ObservabilityCallType;
  purpose: string;
  originType?: ObservabilityCallType;
  originStage?: string;
  service?: string;
  process?: string;
  turnId?: string;
  requestId?: string;
  channelId?: string;
  toolName?: string;
  toolCallId?: string;
  chargeLane?: ChargePolicyRuntimeLane;
  chargeSurface?: ChargePolicySurface;
  chargeRunId?: string;
  chargeRootRunId?: string;
  chargeParentRunId?: string;
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
  | 'callKind'
  | 'callType'
  | 'purpose'
  | 'provider'
  | 'model'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'totalTokens'
  | 'estimatedCostUsd'
  | 'costSource'
>> {
  dayKey: string;
  monthKey: string;
  completedAtMs?: number;
  durationMs?: number;
  ttftMs?: number;
  originType?: ObservabilityCallType;
  originStage?: string;
  service?: string;
  process?: string;
  turnId?: string;
  requestId?: string;
  channelId?: string;
  toolName?: string;
  toolCallId?: string;
  chargeLane?: ChargePolicyRuntimeLane;
  chargeSurface?: ChargePolicySurface;
  chargeRunId?: string;
  chargeRootRunId?: string;
  chargeParentRunId?: string;
  slotKey?: string;
  requestedProvider?: string;
  requestedModel?: string;
  providerCostUsd?: number;
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
  runId?: string;
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
  totalTokens: number;
  totalCostUsd: number;
}

export interface ModelUsageData {
  query: ModelUsageQuery;
  totals: ModelUsageTotals;
  byModel: ModelUsageBreakdown[];
  byPurpose: ModelUsageBreakdown[];
  byTool: ModelUsageBreakdown[];
  byCallKind: ModelUsageBreakdown[];
  recentEvents: ModelUsageEvent[];
  expensiveEvents: ModelUsageEvent[];
}

export interface ModelUsageRecorder {
  recordUsageEvent(event: ModelUsageEventInput): Promise<void>;
}

export interface ModelUsageQueryPort {
  getUsageData(query?: ModelUsageQuery): Promise<ModelUsageData>;
}
