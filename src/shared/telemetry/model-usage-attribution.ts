import {
  CHANNEL_TYPES,
  type ChannelType,
  type ObservabilityCallType,
} from '../contracts/runtime.js';
import {
  CHARGE_POLICY_RUNTIME_LANE_VALUES,
  CHARGE_POLICY_SURFACE_VALUES,
  type ChargePolicyRuntimeLane,
  type ChargePolicySurface,
} from '../contracts/charge-policy.js';
import {
  RUNTIME_LANE_CLASSES,
  type RuntimeLaneClass,
} from '../../core/agent/worker-lanes.js';

export const MODEL_USAGE_UNKNOWN_DIMENSION = 'unknown' as const;

export const MODEL_USAGE_CALL_TYPES = [
  'chat',
  'tool',
  'memory',
  'summary',
  'background',
  'scheduled',
] as const satisfies readonly ObservabilityCallType[];
export const MODEL_USAGE_ORIGIN_TYPES = [
  ...MODEL_USAGE_CALL_TYPES,
  MODEL_USAGE_UNKNOWN_DIMENSION,
] as const;
export const MODEL_USAGE_CHANNEL_TYPES = [
  ...CHANNEL_TYPES,
  MODEL_USAGE_UNKNOWN_DIMENSION,
] as const;
export const MODEL_USAGE_CHARGE_LANES = [
  ...CHARGE_POLICY_RUNTIME_LANE_VALUES,
  MODEL_USAGE_UNKNOWN_DIMENSION,
] as const;
export const MODEL_USAGE_CHARGE_SURFACES = [
  ...CHARGE_POLICY_SURFACE_VALUES,
  MODEL_USAGE_UNKNOWN_DIMENSION,
] as const;

/**
 * mmo9.7.3: per-lane spend attribution. `runtimeLaneClass` records the SINGLE
 * gate-resolved `RuntimeLaneClass` (`resolveRuntimeLaneClassForModelCall`) the
 * boundary already produced for a call — never a second lane resolver. It is
 * strictly richer than the charge economy's `chargeLane` (the runtime class maps
 * onto a charge lane), and is always available even for autonomous calls that
 * never touch the run-charge snapshot, so per-companion x lane x model spend has
 * no silent gaps.
 */
export type ModelUsageRuntimeLaneClass = RuntimeLaneClass | typeof MODEL_USAGE_UNKNOWN_DIMENSION;
export const MODEL_USAGE_RUNTIME_LANE_CLASSES = [
  ...Object.values(RUNTIME_LANE_CLASSES),
  MODEL_USAGE_UNKNOWN_DIMENSION,
] as readonly ModelUsageRuntimeLaneClass[];

export const MODEL_USAGE_GROUP_DIMENSIONS = [
  'companionId',
  'sessionId',
  'channelId',
  'channelType',
  'callKind',
  'callType',
  'purpose',
  'originType',
  'originStage',
  'service',
  'process',
  'provider',
  'model',
  'slotKey',
  'requestedProvider',
  'requestedModel',
  'toolName',
  'runtimeLaneClass',
  'chargeLane',
  'chargeSurface',
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
  'status',
  'costSource',
] as const;

export type ModelUsageGroupDimension = typeof MODEL_USAGE_GROUP_DIMENSIONS[number];
export type ModelUsageChannelType = typeof MODEL_USAGE_CHANNEL_TYPES[number];
export type ModelUsageChargeLane = typeof MODEL_USAGE_CHARGE_LANES[number];
export type ModelUsageChargeSurface = typeof MODEL_USAGE_CHARGE_SURFACES[number];

export interface ModelUsageAttributionInput {
  companionId?: string;
  sessionId?: string;
  channelId?: string;
  channelType?: ChannelType;
  callType: ObservabilityCallType;
  purpose: string;
  originType?: ObservabilityCallType;
  originStage?: string;
  service?: string;
  process?: string;
  turnId?: string;
  requestId?: string;
  toolName?: string;
  toolCallId?: string;
  runtimeLaneClass?: RuntimeLaneClass;
  chargeLane?: ChargePolicyRuntimeLane;
  chargeSurface?: ChargePolicySurface;
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
}

export interface ModelUsageAttribution {
  companionId: string;
  sessionId: string;
  channelId: string;
  channelType: ModelUsageChannelType;
  callType: ObservabilityCallType;
  purpose: string;
  originType: ObservabilityCallType | typeof MODEL_USAGE_UNKNOWN_DIMENSION;
  originStage: string;
  service: string;
  process: string;
  turnId: string;
  requestId: string;
  toolName: string;
  toolCallId: string;
  runtimeLaneClass: ModelUsageRuntimeLaneClass;
  chargeLane: ModelUsageChargeLane;
  chargeSurface: ModelUsageChargeSurface;
  chargeEventId: string;
  chargeRunId: string;
  chargeRootRunId: string;
  chargeParentRunId: string;
  shardId: string;
  subagentId: string;
  conversationId: string;
  rootInitiationId: string;
  workloadType: string;
  workloadId: string;
}

const OBSERVABILITY_CALL_TYPES: ReadonlySet<ObservabilityCallType> = new Set(MODEL_USAGE_CALL_TYPES);
const CHANNEL_TYPE_SET: ReadonlySet<string> = new Set(CHANNEL_TYPES);
const CHARGE_LANE_SET: ReadonlySet<string> = new Set(CHARGE_POLICY_RUNTIME_LANE_VALUES);
const RUNTIME_LANE_CLASS_SET: ReadonlySet<string> = new Set(Object.values(RUNTIME_LANE_CLASSES));
const CHARGE_SURFACE_SET: ReadonlySet<string> = new Set(CHARGE_POLICY_SURFACE_VALUES);
const MAX_DIMENSION_LENGTH = 512;
const UNSAFE_DIMENSION_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/u;

function normalizeDimension(value: unknown, field: string): string {
  if (value === undefined) return MODEL_USAGE_UNKNOWN_DIMENSION;
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string when provided`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} must be non-empty when provided`);
  }
  if (normalized.length > MAX_DIMENSION_LENGTH) {
    throw new Error(`${field} must be at most ${MAX_DIMENSION_LENGTH} characters`);
  }
  if (UNSAFE_DIMENSION_CHARACTERS.test(normalized)) {
    throw new Error(`${field} must not contain control characters`);
  }
  return normalized;
}

function normalizeEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: ReadonlySet<string>,
  options: { required?: boolean } = {},
): T | typeof MODEL_USAGE_UNKNOWN_DIMENSION {
  if (value === undefined && !options.required) return MODEL_USAGE_UNKNOWN_DIMENSION;
  const normalized = normalizeDimension(value, field);
  if (!allowed.has(normalized)) {
    throw new Error(`${field} has unsupported value ${JSON.stringify(normalized)}`);
  }
  return normalized as T;
}

function deriveWorkerId(channelId: string, prefix: 'shard:' | 'subagent:'): string | undefined {
  if (!channelId.startsWith(prefix)) return undefined;
  const value = channelId.slice(prefix.length).trim();
  return value || undefined;
}

export function normalizeModelUsageAttribution(
  input: ModelUsageAttributionInput,
): ModelUsageAttribution {
  const channelId = normalizeDimension(input.channelId, 'attribution.channelId');
  const explicitSessionId = input.sessionId === undefined ? undefined : input.sessionId;
  const shardId = input.shardId
    ?? (channelId === MODEL_USAGE_UNKNOWN_DIMENSION ? undefined : deriveWorkerId(channelId, 'shard:'));
  const subagentId = input.subagentId
    ?? (channelId === MODEL_USAGE_UNKNOWN_DIMENSION ? undefined : deriveWorkerId(channelId, 'subagent:'));
  const workloadType = input.workloadType
    ?? (shardId ? 'shard' : (subagentId ? 'subagent' : undefined));
  const workloadId = input.workloadId ?? shardId ?? subagentId;

  return {
    companionId: normalizeDimension(input.companionId, 'attribution.companionId'),
    sessionId: normalizeDimension(explicitSessionId ?? (channelId !== MODEL_USAGE_UNKNOWN_DIMENSION
      ? channelId
      : undefined), 'attribution.sessionId'),
    channelId,
    channelType: normalizeEnum<ChannelType>(
      input.channelType,
      'attribution.channelType',
      CHANNEL_TYPE_SET,
    ),
    callType: normalizeEnum<ObservabilityCallType>(
      input.callType,
      'attribution.callType',
      OBSERVABILITY_CALL_TYPES,
      { required: true },
    ) as ObservabilityCallType,
    purpose: normalizeDimension(input.purpose, 'attribution.purpose'),
    originType: normalizeEnum<ObservabilityCallType>(
      input.originType,
      'attribution.originType',
      OBSERVABILITY_CALL_TYPES,
    ),
    originStage: normalizeDimension(input.originStage, 'attribution.originStage'),
    service: normalizeDimension(input.service, 'attribution.service'),
    process: normalizeDimension(input.process, 'attribution.process'),
    turnId: normalizeDimension(input.turnId, 'attribution.turnId'),
    requestId: normalizeDimension(input.requestId, 'attribution.requestId'),
    toolName: normalizeDimension(input.toolName, 'attribution.toolName'),
    toolCallId: normalizeDimension(input.toolCallId, 'attribution.toolCallId'),
    runtimeLaneClass: normalizeEnum<RuntimeLaneClass>(
      input.runtimeLaneClass,
      'attribution.runtimeLaneClass',
      RUNTIME_LANE_CLASS_SET,
    ),
    chargeLane: normalizeEnum<ChargePolicyRuntimeLane>(
      input.chargeLane,
      'attribution.chargeLane',
      CHARGE_LANE_SET,
    ),
    chargeSurface: normalizeEnum<ChargePolicySurface>(
      input.chargeSurface,
      'attribution.chargeSurface',
      CHARGE_SURFACE_SET,
    ),
    chargeEventId: normalizeDimension(input.chargeEventId, 'attribution.chargeEventId'),
    chargeRunId: normalizeDimension(input.chargeRunId, 'attribution.chargeRunId'),
    chargeRootRunId: normalizeDimension(input.chargeRootRunId, 'attribution.chargeRootRunId'),
    chargeParentRunId: normalizeDimension(input.chargeParentRunId, 'attribution.chargeParentRunId'),
    shardId: normalizeDimension(shardId, 'attribution.shardId'),
    subagentId: normalizeDimension(subagentId, 'attribution.subagentId'),
    conversationId: normalizeDimension(input.conversationId, 'attribution.conversationId'),
    rootInitiationId: normalizeDimension(input.rootInitiationId, 'attribution.rootInitiationId'),
    workloadType: normalizeDimension(workloadType, 'attribution.workloadType'),
    workloadId: normalizeDimension(workloadId, 'attribution.workloadId'),
  };
}
