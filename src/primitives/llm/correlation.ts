import {
  COMPANION_PRIVATE_BACKGROUND_PURPOSE,
  type CompletionPurpose,
  type CorrelationMetadata,
  type ModelPurpose,
} from '../../shared/contracts/runtime.js';
import { parseIcpConversationCorrelation } from '../../shared/contracts/icp-autonomy.js';
import {
  isObservabilityCallType,
  type ObservabilityCallType,
} from '../../shared/contracts/observability-call-types.js';

export interface ResolvedCorrelationMetadata extends CorrelationMetadata {
  requestId: string;
  originType: ObservabilityCallType;
  originStage: string;
}

export function normalizeCorrelationValue(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function inferCallType(
  purpose: CompletionPurpose | ModelPurpose,
  channelId?: string,
): ObservabilityCallType {
  const normalizedChannelId = normalizeCorrelationValue(channelId)?.toLowerCase();
  if (normalizedChannelId?.startsWith('internal:')) {
    return 'scheduled';
  }

  switch (purpose) {
    case 'chat':
      return 'chat';
    case 'reasoning':
      return 'tool';
    case 'memory':
    case 'extraction':
      return 'memory';
    case 'summary':
      return 'summary';
    case 'context':
    case 'background':
    case 'import_processing':
    case 'vision':
    case 'longContext':
    case 'moa':
    default:
      return 'background';
  }
}

export function resolveCorrelationMetadata(
  contextCorrelation: Partial<CorrelationMetadata> | undefined,
  optionCorrelation: Partial<CorrelationMetadata> | undefined,
  purpose: CompletionPurpose | 'chat',
): ResolvedCorrelationMetadata {
  const merged: Partial<CorrelationMetadata> = {
    ...(contextCorrelation ?? {}),
    ...(optionCorrelation ?? {}),
  };

  const companionPrivate = merged.telemetryVisibility === 'companion_private';
  if (companionPrivate) {
    return {
      requestId: 'companion-private',
      callType: 'background',
      purpose: COMPANION_PRIVATE_BACKGROUND_PURPOSE,
      originType: 'background',
      originStage: COMPANION_PRIVATE_BACKGROUND_PURPOSE,
      telemetryVisibility: 'companion_private',
    };
  }

  const rawIcpCorrelation = optionCorrelation?.icpCorrelation
    ?? contextCorrelation?.icpCorrelation;
  const icpCorrelation = rawIcpCorrelation === undefined
    ? undefined
    : parseIcpConversationCorrelation(rawIcpCorrelation);
  const requireIcpMatch = (
    field: string,
    declared: string | undefined,
    expected: string,
  ): string => {
    const normalized = normalizeCorrelationValue(declared);
    if (normalized !== undefined && normalized !== expected) {
      throw new Error(
        `ICP conversation correlation ${field} conflicts with flattened correlation metadata`,
      );
    }
    return expected;
  };

  if (icpCorrelation && (merged.shardId !== undefined || merged.subagentId !== undefined)) {
    throw new Error('ICP conversation correlation cannot share shard or subagent budget scope');
  }
  const turnId = normalizeCorrelationValue(merged.turnId);
  const companionId = icpCorrelation
    ? requireIcpMatch('companionId', merged.companionId, icpCorrelation.localCompanionId)
    : normalizeCorrelationValue(merged.companionId);
  const sessionId = normalizeCorrelationValue(merged.sessionId);
  const channelId = icpCorrelation
    ? requireIcpMatch('channelId', merged.channelId, icpCorrelation.channelId)
    : normalizeCorrelationValue(merged.channelId);
  const channelType = normalizeCorrelationValue(merged.channelType) as typeof merged.channelType;
  const resolvedTurnId = icpCorrelation
    ? requireIcpMatch('turnId', turnId, icpCorrelation.turnId)
    : turnId;
  const requestId = icpCorrelation
    ? requireIcpMatch('requestId', merged.requestId, icpCorrelation.requestId)
    : (normalizeCorrelationValue(merged.requestId) ?? resolvedTurnId ?? 'unknown');
  const toolName = normalizeCorrelationValue(merged.toolName);
  const toolCallId = normalizeCorrelationValue(merged.toolCallId);
  const service = normalizeCorrelationValue(merged.service);
  const process = normalizeCorrelationValue(merged.process);
  const chargeLane = icpCorrelation
    ? requireIcpMatch('chargeLane', merged.chargeLane, icpCorrelation.chargeLane) as typeof merged.chargeLane
    : normalizeCorrelationValue(merged.chargeLane) as typeof merged.chargeLane;
  const chargeSurface = normalizeCorrelationValue(merged.chargeSurface) as typeof merged.chargeSurface;
  const chargeEventId = normalizeCorrelationValue(merged.chargeEventId);
  const chargeRunId = normalizeCorrelationValue(merged.chargeRunId);
  const chargeRootRunId = normalizeCorrelationValue(merged.chargeRootRunId);
  const chargeParentRunId = normalizeCorrelationValue(merged.chargeParentRunId);
  const shardId = normalizeCorrelationValue(merged.shardId);
  const subagentId = normalizeCorrelationValue(merged.subagentId);
  const conversationId = icpCorrelation
    ? requireIcpMatch('conversationId', merged.conversationId, icpCorrelation.conversationId)
    : normalizeCorrelationValue(merged.conversationId);
  const rootInitiationId = icpCorrelation
    ? requireIcpMatch('rootInitiationId', merged.rootInitiationId, icpCorrelation.rootInitiationId)
    : normalizeCorrelationValue(merged.rootInitiationId);
  const workloadType = normalizeCorrelationValue(merged.workloadType);
  const workloadId = normalizeCorrelationValue(merged.workloadId);

  const inferredCallType = inferCallType(purpose, channelId);
  const originType = isObservabilityCallType(merged.originType)
    ? merged.originType
    : (isObservabilityCallType(merged.callType) ? merged.callType : inferredCallType);
  const originStage = normalizeCorrelationValue(merged.originStage)
    ?? normalizeCorrelationValue(merged.purpose)
    ?? String(purpose);

  const callType = isObservabilityCallType(merged.callType)
    ? merged.callType
    : originType;
  const resolvedPurpose = normalizeCorrelationValue(merged.purpose) ?? originStage;

  return {
    ...(companionId ? { companionId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(resolvedTurnId ? { turnId: resolvedTurnId } : {}),
    requestId,
    ...(channelId ? { channelId } : {}),
    ...(channelType ? { channelType } : {}),
    callType,
    ...(toolName ? { toolName } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    purpose: resolvedPurpose,
    originType,
    originStage,
    ...(service ? { service } : {}),
    ...(process ? { process } : {}),
    ...(chargeLane ? { chargeLane } : {}),
    ...(chargeSurface ? { chargeSurface } : {}),
    ...(chargeEventId ? { chargeEventId } : {}),
    ...(chargeRunId ? { chargeRunId } : {}),
    ...(chargeRootRunId ? { chargeRootRunId } : {}),
    ...(chargeParentRunId ? { chargeParentRunId } : {}),
    ...(shardId ? { shardId } : {}),
    ...(subagentId ? { subagentId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(rootInitiationId ? { rootInitiationId } : {}),
    ...(workloadType ? { workloadType } : {}),
    ...(workloadId ? { workloadId } : {}),
    ...(icpCorrelation ? { icpCorrelation } : {}),
  };
}

export function toCorrelationLogFields(
  correlation: Partial<CorrelationMetadata> | undefined,
): {
  requestId: string;
  originType: ObservabilityCallType;
  originStage: string;
  turnId?: string;
  channelId?: string;
  toolName?: string;
  toolCallId?: string;
} {
  const companionPrivate = correlation?.telemetryVisibility === 'companion_private';
  if (companionPrivate) {
    return {
      requestId: 'companion-private',
      originType: 'background',
      originStage: COMPANION_PRIVATE_BACKGROUND_PURPOSE,
    };
  }
  const turnId = normalizeCorrelationValue(correlation?.turnId);
  const requestId = normalizeCorrelationValue(correlation?.requestId) ?? turnId ?? 'unknown';
  const channelId = normalizeCorrelationValue(correlation?.channelId);
  const toolName = normalizeCorrelationValue(correlation?.toolName);
  const toolCallId = normalizeCorrelationValue(correlation?.toolCallId);
  const originType = isObservabilityCallType(correlation?.originType)
    ? correlation.originType
    : (isObservabilityCallType(correlation?.callType) ? correlation.callType : 'background');
  const originStage = normalizeCorrelationValue(correlation?.originStage)
    ?? normalizeCorrelationValue(correlation?.purpose)
    ?? 'unknown';

  return {
    ...(turnId ? { turnId } : {}),
    requestId,
    ...(channelId ? { channelId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    originType,
    originStage,
  };
}
