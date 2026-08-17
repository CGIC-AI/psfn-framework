import {
  CHANNEL_TYPES,
  type ChannelType,
  type ObservabilityCallType,
} from '../contracts/runtime-base.js';
import {
  OBSERVABILITY_CALL_TYPES,
  isObservabilityCallType,
} from '../contracts/observability-call-types.js';
import {
  CHARGE_POLICY_RUNTIME_LANE_VALUES,
  CHARGE_POLICY_SURFACE_VALUES,
  type ChargePolicyRuntimeLane,
  type ChargePolicySurface,
} from '../contracts/charge-policy.js';
import {
  RUNTIME_LANE_CLASSES,
  type RuntimeLaneClass,
} from '../contracts/runtime-lanes.js';

export const MODEL_USAGE_UNKNOWN_DIMENSION = 'unknown' as const;

export const MODEL_USAGE_CALL_TYPES = OBSERVABILITY_CALL_TYPES;
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
export const MODEL_USAGE_RETIRED_CHARGE_SURFACE = 'retired' as const;
export const MODEL_USAGE_RETIRED_CHARGE_SURFACE_VALUES = [
  'ownerFileInspection',
  'localFilesystem',
  'localEmbedding',
  'externalEmbedding',
] as const;
export const MODEL_USAGE_CHARGE_SURFACES = [
  ...CHARGE_POLICY_SURFACE_VALUES,
  MODEL_USAGE_RETIRED_CHARGE_SURFACE,
  MODEL_USAGE_UNKNOWN_DIMENSION,
] as const;

const MODEL_USAGE_CHARGE_ATTRIBUTION_KEYS = [
  'chargeLane',
  'chargeSurface',
  'chargeEventId',
  'chargeRunId',
  'chargeRootRunId',
  'chargeParentRunId',
] as const;

type ModelUsageChargeAttributionKey =
  (typeof MODEL_USAGE_CHARGE_ATTRIBUTION_KEYS)[number];

/**
 * Native baseline work may retain provider-cost telemetry, but Law 38 forbids
 * attaching it to an existing charge roll. Strip the producer's charge
 * classification and lineage before crossing a native usage boundary. The
 * model-usage recorder may still derive a reporting lane from canonical
 * call/session attribution; that lane does not recreate a charge event,
 * surface, or lineage.
 */
export function stripChargeAttribution<T extends object>(
  input: T,
): Omit<T, ModelUsageChargeAttributionKey> {
  const stripped = {
    ...input,
  } as T & Partial<Record<ModelUsageChargeAttributionKey, unknown>>;
  for (const key of MODEL_USAGE_CHARGE_ATTRIBUTION_KEYS) {
    delete stripped[key];
  }
  return stripped;
}

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

export interface ModelUsageChargeLaneResolutionInput {
  explicitChargeLane?: ChargePolicyRuntimeLane;
  callType: ObservabilityCallType;
  runtimeLaneClass?: RuntimeLaneClass;
  sessionId?: string;
  channelId?: string;
}

/**
 * Resolve the ledger's charge lane from canonical call attribution.
 *
 * Explicit charge context always wins. Otherwise an already-resolved runtime
 * class maps directly to its reporting lane. Without one, foreground work is
 * interactive, session-attributed companion cognition is background, and
 * scheduled session work is maintenance. Genuinely unclassified session-less
 * system work remains unresolved so the ledger records the loud `unknown` anomaly.
 */
export function resolveModelUsageChargeLane(
  input: ModelUsageChargeLaneResolutionInput,
): ChargePolicyRuntimeLane | undefined {
  if (input.explicitChargeLane) return input.explicitChargeLane;
  if (input.runtimeLaneClass === RUNTIME_LANE_CLASSES.foregroundChat) {
    return 'interactive';
  }
  if (input.runtimeLaneClass === RUNTIME_LANE_CLASSES.maintenanceReflection) {
    return 'maintenance';
  }
  if (
    input.runtimeLaneClass === RUNTIME_LANE_CLASSES.postTurnAppraisal
    || input.runtimeLaneClass === RUNTIME_LANE_CLASSES.backgroundContinuation
  ) {
    return 'background';
  }
  if (input.callType === 'chat') {
    return 'interactive';
  }
  if (input.callType === 'scheduled') {
    return input.sessionId?.trim() ? 'maintenance' : undefined;
  }
  const hasSessionAttribution = Boolean(input.sessionId?.trim() || input.channelId?.trim());
  if (!hasSessionAttribution) return undefined;
  if (input.callType === 'tool') {
    return 'interactive';
  }

  return 'background';
}

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

const CHANNEL_TYPE_SET: ReadonlySet<string> = new Set(CHANNEL_TYPES);
const CHARGE_LANE_SET: ReadonlySet<string> = new Set(CHARGE_POLICY_RUNTIME_LANE_VALUES);
const RUNTIME_LANE_CLASS_SET: ReadonlySet<string> = new Set(Object.values(RUNTIME_LANE_CLASSES));
const CHARGE_SURFACE_SET: ReadonlySet<string> = new Set(CHARGE_POLICY_SURFACE_VALUES);
const RETIRED_CHARGE_SURFACE_SET: ReadonlySet<string> = new Set(
  MODEL_USAGE_RETIRED_CHARGE_SURFACE_VALUES,
);
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

/**
 * Historical ledger rows may contain charge surfaces retired by Law 38.
 * Preserve those rows under one explicit read-only category without allowing
 * the retired values through `ModelUsageAttributionInput` or the writer
 * normalizer.
 */
export function normalizeStoredModelUsageChargeSurface(
  value: unknown,
): ModelUsageChargeSurface {
  if (
    value === undefined
    || value === null
    || value === MODEL_USAGE_UNKNOWN_DIMENSION
  ) {
    return MODEL_USAGE_UNKNOWN_DIMENSION;
  }
  const normalized = normalizeDimension(value, 'stored attribution.chargeSurface');
  if (CHARGE_SURFACE_SET.has(normalized)) {
    return normalized as ChargePolicySurface;
  }
  if (RETIRED_CHARGE_SURFACE_SET.has(normalized)) {
    return MODEL_USAGE_RETIRED_CHARGE_SURFACE;
  }
  throw new Error(
    `stored attribution.chargeSurface has unsupported value ${JSON.stringify(normalized)}`,
  );
}

function normalizeObservabilityCallType(
  value: unknown,
  field: string,
  options: { required: true },
): ObservabilityCallType;
function normalizeObservabilityCallType(
  value: unknown,
  field: string,
  options?: { required?: false },
): ObservabilityCallType | typeof MODEL_USAGE_UNKNOWN_DIMENSION;
function normalizeObservabilityCallType(
  value: unknown,
  field: string,
  options: { required?: boolean } = {},
): ObservabilityCallType | typeof MODEL_USAGE_UNKNOWN_DIMENSION {
  if (value === undefined && !options.required) return MODEL_USAGE_UNKNOWN_DIMENSION;
  const normalized = normalizeDimension(value, field);
  if (!isObservabilityCallType(normalized)) {
    throw new Error(`${field} has unsupported value ${JSON.stringify(normalized)}`);
  }
  return normalized;
}

function deriveWorkerId(channelId: string, prefix: 'shard:' | 'subagent:'): string | undefined {
  if (!channelId.startsWith(prefix)) return undefined;
  const value = channelId.slice(prefix.length).trim();
  return value || undefined;
}

export function normalizeModelUsageAttribution(
  input: ModelUsageAttributionInput,
  options: { inferChargeLane?: boolean } = {},
): ModelUsageAttribution {
  const channelId = normalizeDimension(input.channelId, 'attribution.channelId');
  const explicitSessionId = input.sessionId === undefined ? undefined : input.sessionId;
  const sessionId = normalizeDimension(explicitSessionId ?? (
    input.callType !== 'scheduled' && channelId !== MODEL_USAGE_UNKNOWN_DIMENSION
      ? channelId
      : undefined
  ), 'attribution.sessionId');
  const runtimeLaneClass = normalizeEnum<RuntimeLaneClass>(
    input.runtimeLaneClass,
    'attribution.runtimeLaneClass',
    RUNTIME_LANE_CLASS_SET,
  );
  const explicitChargeLane = normalizeEnum<ChargePolicyRuntimeLane>(
    input.chargeLane,
    'attribution.chargeLane',
    CHARGE_LANE_SET,
  );
  const resolvedChargeLane = options.inferChargeLane === false
    ? (explicitChargeLane === MODEL_USAGE_UNKNOWN_DIMENSION ? undefined : explicitChargeLane)
    : resolveModelUsageChargeLane({
        ...(explicitChargeLane === MODEL_USAGE_UNKNOWN_DIMENSION
          ? {}
          : { explicitChargeLane }),
        callType: input.callType,
        ...(runtimeLaneClass === MODEL_USAGE_UNKNOWN_DIMENSION
          ? {}
          : { runtimeLaneClass }),
        ...(sessionId === MODEL_USAGE_UNKNOWN_DIMENSION ? {} : { sessionId }),
        ...(channelId === MODEL_USAGE_UNKNOWN_DIMENSION ? {} : { channelId }),
      });
  const shardId = input.shardId
    ?? (channelId === MODEL_USAGE_UNKNOWN_DIMENSION ? undefined : deriveWorkerId(channelId, 'shard:'));
  const subagentId = input.subagentId
    ?? (channelId === MODEL_USAGE_UNKNOWN_DIMENSION ? undefined : deriveWorkerId(channelId, 'subagent:'));
  const workloadType = input.workloadType
    ?? (shardId ? 'shard' : (subagentId ? 'subagent' : undefined));
  const workloadId = input.workloadId ?? shardId ?? subagentId;

  return {
    companionId: normalizeDimension(input.companionId, 'attribution.companionId'),
    sessionId,
    channelId,
    channelType: normalizeEnum<ChannelType>(
      input.channelType,
      'attribution.channelType',
      CHANNEL_TYPE_SET,
    ),
    callType: normalizeObservabilityCallType(
      input.callType,
      'attribution.callType',
      { required: true },
    ),
    purpose: normalizeDimension(input.purpose, 'attribution.purpose'),
    originType: normalizeObservabilityCallType(
      input.originType,
      'attribution.originType',
    ),
    originStage: normalizeDimension(input.originStage, 'attribution.originStage'),
    service: normalizeDimension(input.service, 'attribution.service'),
    process: normalizeDimension(input.process, 'attribution.process'),
    turnId: normalizeDimension(input.turnId, 'attribution.turnId'),
    requestId: normalizeDimension(input.requestId, 'attribution.requestId'),
    toolName: normalizeDimension(input.toolName, 'attribution.toolName'),
    toolCallId: normalizeDimension(input.toolCallId, 'attribution.toolCallId'),
    runtimeLaneClass,
    chargeLane: resolvedChargeLane ?? MODEL_USAGE_UNKNOWN_DIMENSION,
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
