import type { CorrelationMetadata, ObservabilityCallType, SubstrateMessage, TurnID } from '../../../shared/contracts/runtime.js';
import { isDeferredToolHandoffMessageId } from '../deferred-tool-handoff.js';

export type TurnStageName = 'trust' | 'memory' | 'fatigue' | 'context' | 'prompt' | 'first-token' | 'end';

export interface TurnStageTelemetryParams {
  message: SubstrateMessage;
  turnStartMs: number;
  turnId: TurnID;
  requestId: string;
  stage: TurnStageName;
  callType: ObservabilityCallType;
  payload: Record<string, unknown>;
}

export interface TurnConversationAttributionContext {
  sessionId: string;
  rootInitiationId: string;
}

export function resolveTurnCallType(
  message: SubstrateMessage,
  taskKind: string | undefined,
): ObservabilityCallType {
  if (isDeferredToolHandoffMessageId(message.id)) {
    return 'background';
  }
  if (taskKind === 'heartbeat' || taskKind === 'reflection') {
    return 'scheduled';
  }
  if (message.channelId.startsWith('internal:')) {
    return 'scheduled';
  }
  return 'chat';
}

export function buildTurnCorrelation(
  message: SubstrateMessage,
  callType: ObservabilityCallType,
  turnId: TurnID,
  requestId: string,
  conversation: TurnConversationAttributionContext,
): CorrelationMetadata {
  const sessionId = conversation.sessionId.trim();
  const rootInitiationId = conversation.rootInitiationId.trim();
  if (!sessionId || !rootInitiationId) {
    throw new Error('Turn correlation requires a logical session and root initiation');
  }
  const shardId = message.channelId.startsWith('shard:')
    ? message.channelId.slice('shard:'.length).trim() || undefined
    : undefined;
  const subagentId = message.channelId.startsWith('subagent:')
    ? message.channelId.slice('subagent:'.length).trim() || undefined
    : undefined;
  return {
    sessionId,
    turnId,
    requestId,
    channelId: message.channelId,
    channelType: message.channelType,
    callType,
    purpose: 'agent.turn',
    originType: callType,
    originStage: 'agent.turn',
    ...(message.routing?.icpCorrelation
      ? { icpCorrelation: message.routing.icpCorrelation }
      : {}),
    service: 'agent',
    process: 'substrate-agent',
    conversationId: sessionId,
    rootInitiationId,
    ...(shardId ? { shardId, workloadType: 'shard', workloadId: shardId } : {}),
    ...(subagentId ? { subagentId, workloadType: 'subagent', workloadId: subagentId } : {}),
  };
}

export function withCorrelationPurpose(
  correlation: CorrelationMetadata,
  purpose: string,
): CorrelationMetadata {
  return {
    ...correlation,
    purpose,
    originStage: purpose,
  };
}

export function withAdaptiveCorrelation(
  correlation: CorrelationMetadata | undefined,
  activeTurnCorrelation: CorrelationMetadata | null,
  purpose: string,
): Partial<CorrelationMetadata> {
  if (correlation) {
    return withCorrelationPurpose(correlation, purpose);
  }
  if (activeTurnCorrelation) {
    return withCorrelationPurpose(activeTurnCorrelation, purpose);
  }
  return { purpose };
}

export function buildTurnStageTelemetry(
  params: TurnStageTelemetryParams,
): Record<string, unknown> {
  return {
    turnId: params.turnId,
    requestId: params.requestId,
    channelId: params.message.channelId,
    callType: params.callType,
    purpose: `agent.turn.stage.${params.stage}`,
    stage: params.stage,
    elapsedMs: Math.max(0, Date.now() - params.turnStartMs),
    ...params.payload,
  };
}
