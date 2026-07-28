import type { AgentMessage } from '../../../../boundary/pi-agent/index.js';
import { collectGeneratedImageAttachments } from '../../../../primitives/images/generated-media.js';
import { emitCompanionArtifactCreatedEvents } from '../../../../channels/backplane/companion-relay/artifact-emission.js';
import type {
  AgentResponse,
  CorrelationMetadata,
  MessagePromptOverrideMode,
  LLMContext,
  SubstrateMessage,
  TurnID,
  TurnUsage,
} from '../../../../shared/contracts/runtime.js';
import type { PendingPaidDeliverable } from '../../../../shared/paid-deliverable-tracking.js';
import {
  resolveAdaptiveContextBudgetProfile,
  type ContextBudgetTurnCharacteristics,
} from '../../../../shared/context-budget.js';
import { countTokens } from '../../../../primitives/llm/tokens.js';
import { createComponentLogger } from '../../../../shared/logger.js';
import { toErrorMessage } from '../../../../shared/utils/errors.js';
import { buildTurnSubsystemProjectionRef } from '../../../../shared/contracts/subsystem-output-refs.js';
import type { ChannelMeta } from '../../../../system/trust/policy.js';
import type { TrustLevel } from '../../../../system/trust/types.js';
import type { ConversationScope } from '../../../session/conversation-scope.js';
import type { InternalState } from '../../../self-model/state.js';
import { projectEmotionAppraisalState } from '../../../emotion/appraisal-state.js';
import type { TurnSnapshot } from '../../../turns/snapshot.js';
import type { TurnExecutionObservability } from './observability.js';
import { resolveMessagePlaceId } from '../message-location.js';
import {
  createBackgroundWorkIdentity,
  createTurnRecordBackgroundWorkHandoff,
  fingerprintBackgroundWorkPayload,
  fingerprintBackgroundWorkTurnRecord,
  fingerprintEmotionAppraisalPersonalityProjection,
  type BackgroundWorkKind,
  type BackgroundWorkPayload,
  type BackgroundWorkSourceRef,
  type EnqueueBackgroundWorkInput,
} from '../../background-work/types.js';
import type { TurnExecutionRuntime, TurnSessionIdentity } from './contracts.js';
import type { CapturedSessionReads } from '../../../session/manager/captured-session-owner.js';

const log = createComponentLogger('SubstrateAgent');

export async function collectTurnResponseAttachments(input: {
  runtime: TurnExecutionRuntime;
  turnMessages: AgentMessage[];
  paidDeliverables?: readonly PendingPaidDeliverable[];
  galleryContext?: {
    channelId?: string;
    channelType?: string;
    turnId?: string;
    requestId?: string;
    sourceMessageId?: string;
    userSessionEntryId?: number;
    assistantSessionEntryId?: number;
  };
}): Promise<NonNullable<AgentResponse['attachments']>> {
  const attachments = await collectGeneratedImageAttachments({
    turnMessages: input.turnMessages,
    personalFilesDir: input.runtime.config.workspacePath,
    paidDeliverables: input.paidDeliverables,
    galleryContext: input.galleryContext,
  });
  if (attachments.length > 0) {
    // Companion relay artifact announcement choke point (w9hj.1): redacted at
    // emission; never blocks the outbound reply.
    try {
      await emitCompanionArtifactCreatedEvents({
        eventBus: input.runtime.eventBus,
        attachments,
        ...(input.galleryContext?.channelId ? { channelId: input.galleryContext.channelId } : {}),
      });
    } catch (error) {
      log.error('Failed to emit companion artifact events', {
        channelId: input.galleryContext?.channelId,
        error: toErrorMessage(error),
      });
    }
  }
  return attachments;
}

function createBackgroundWorkInput(input: {
  kind: BackgroundWorkKind;
  payload: BackgroundWorkPayload;
  source: BackgroundWorkSourceRef;
}): EnqueueBackgroundWorkInput {
  const identity = createBackgroundWorkIdentity({
    logicalSessionId: input.source.logicalSessionId,
    turnId: input.source.turnId,
    kind: input.kind,
  });
  return {
    ...identity,
    logicalSessionId: input.source.logicalSessionId,
    kind: input.kind,
    payload: input.payload,
    payloadFingerprint: fingerprintBackgroundWorkPayload(input.payload),
    sourceTurnId: input.source.turnId,
    sourceRequestId: input.source.requestId,
    sourceChannelId: input.source.channelId,
    createdAtMs: input.source.createdAtMs,
    maxAttempts: 5,
  };
}

export async function schedulePostTurnWork(input: {
  runtime: TurnExecutionRuntime;
  sessionReads: CapturedSessionReads;
  message: SubstrateMessage;
  turnSessionIdentity: TurnSessionIdentity;
  response: AgentResponse;
  turnMessages: AgentMessage[];
  turnId: TurnID;
  requestId: string;
  startTime: number;
  completedAt: number;
  firstTokenAt: number | null;
  turnUsage: TurnUsage;
  context: LLMContext;
  taskKind: string | undefined;
  turnCorrelationBase: CorrelationMetadata;
  userSessionEntryId: number | null;
  assistantSessionEntryId: number | null;
  promptMode: MessagePromptOverrideMode;
  fullPrompt: string;
  contextMessageCount: number;
  memoryContextChars: number;
  memoryContextBlock: string;
  trustLevel: TrustLevel;
  speakerRole: 'user' | 'system';
  canonicalContactKey: string | undefined;
  continuitySubjectKey: string | undefined;
  turnSnapshot: TurnSnapshot;
  internalStateSnapshotRef: string;
  internalState: InternalState;
  templateVariables: Record<string, string>;
  emotionSessionId: string;
  channelMeta: ChannelMeta;
  conversationScope: ConversationScope;
  turnBudgetCharacteristics: ContextBudgetTurnCharacteristics;
  persistedUserMessageContent?: string;
  onTurnRecordPersisted?: () => void;
  observability: Pick<
    TurnExecutionObservability,
    'emitObservedTurnStage'
    | 'getObservedTurnStages'
    | 'getObservedTurnRetrievals'
    | 'getObservedTurnSnapshot'
    | 'getRetrievalProvenanceRefs'
  >;
}): Promise<void> {
  const {
    runtime,
    sessionReads,
    message,
    turnSessionIdentity,
    response,
    turnMessages,
    turnId,
    requestId,
    startTime,
    completedAt,
    firstTokenAt,
    turnUsage,
    context,
    taskKind,
    turnCorrelationBase,
    userSessionEntryId,
    assistantSessionEntryId,
    promptMode,
    fullPrompt,
    contextMessageCount,
    memoryContextChars,
    memoryContextBlock,
    trustLevel,
    speakerRole,
    canonicalContactKey,
    continuitySubjectKey,
    turnSnapshot,
    internalStateSnapshotRef,
    internalState,
    templateVariables,
    emotionSessionId,
    channelMeta,
    turnBudgetCharacteristics,
    persistedUserMessageContent,
    observability,
  } = input;

  const retrievalProvenanceRefs = observability.getRetrievalProvenanceRefs();
  const inferredPostTurnActions = await runtime.inferPostTurnActions({
    message,
    response,
    turnMessages,
    turnId,
    completedAt,
    ...(taskKind ? { taskKind } : {}),
    contextManifest: context.manifest,
    ...(canonicalContactKey ? { canonicalContactKey } : {}),
    capturedSessionReads: sessionReads,
  });
  observability.emitObservedTurnStage('end', {
    durationMs: completedAt - startTime,
    ...(firstTokenAt !== null ? { ttftMs: Math.max(0, firstTokenAt - startTime) } : {}),
    inputTokens: turnUsage.inputTokens,
    outputTokens: turnUsage.outputTokens,
    ...(response.metadata.noReply
      ? {
          responseDisposition: 'intentional_no_reply',
          noReplyAuditId: response.metadata.noReply.auditId,
          noReplySource: response.metadata.noReply.source,
        }
      : {}),
  });
  const turnRecord = runtime.buildTurnRecord({
    message,
    turnSessionIdentity,
    turnId,
    requestId,
    startedAt: startTime,
    completedAt,
    userSessionEntryId,
    assistantSessionEntryId,
    response,
    turnMessages,
    promptMode,
    promptText: fullPrompt,
    contextMessageCount,
    memoryContextChars,
    trustLevel,
    speakerRole,
    canonicalContactKey,
    retrievalProvenanceRefs,
    ...(persistedUserMessageContent ? { persistedUserMessageContent } : {}),
    turnSnapshot,
    turnObservability: {
      stages: observability.getObservedTurnStages(),
      retrievals: observability.getObservedTurnRetrievals(),
      ...(observability.getObservedTurnSnapshot() ? { snapshot: observability.getObservedTurnSnapshot() } : {}),
    },
    internalStateSnapshotRef,
  }, sessionReads);

  await runtime.eventBus.emit('agent.turn.end', {
    message,
    response,
    ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.end'),
  });
  if (inferredPostTurnActions.length > 0) {
    await runtime.eventBus.emit('agent.post_turn.actions.inferred', {
      message,
      response,
      actions: inferredPostTurnActions,
      ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.post_turn.actions.inferred'),
    });
  }
  await runtime.costTelemetry.recordTurnUsage({
    message,
    usage: turnUsage,
    ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.usage'),
  });

  const logicalSessionId = turnSessionIdentity.logicalSessionId;
  const turnRecordLogicalSessionId = turnRecord.sessionId ?? turnRecord.channelId;
  if (turnRecord.channelId !== turnSessionIdentity.sourceChannelId
    || turnRecordLogicalSessionId !== logicalSessionId) {
    throw new Error('TurnRecord source does not match the captured turn identity');
  }
  const source: BackgroundWorkSourceRef = {
    schemaVersion: 1,
    logicalSessionId,
    channelId: turnSessionIdentity.sourceChannelId,
    turnId,
    requestId,
    turnRecordFingerprint: fingerprintBackgroundWorkTurnRecord(turnRecord),
    createdAtMs: completedAt,
    ...(userSessionEntryId !== null ? { userSessionEntryId } : {}),
    ...(assistantSessionEntryId !== null ? { assistantSessionEntryId } : {}),
  };
  const persistedTurnBudgetCharacteristics: Omit<ContextBudgetTurnCharacteristics, 'messageText'> = {
    ...(turnBudgetCharacteristics.channelId !== undefined
      ? { channelId: turnBudgetCharacteristics.channelId }
      : {}),
    ...(turnBudgetCharacteristics.channelType !== undefined
      ? { channelType: turnBudgetCharacteristics.channelType }
      : {}),
    ...(turnBudgetCharacteristics.isDirectMessage !== undefined
      ? { isDirectMessage: turnBudgetCharacteristics.isDirectMessage }
      : {}),
    ...(turnBudgetCharacteristics.taskKind !== undefined
      ? { taskKind: turnBudgetCharacteristics.taskKind }
      : {}),
    ...(turnBudgetCharacteristics.modelSelection !== undefined
      ? { modelSelection: turnBudgetCharacteristics.modelSelection }
      : {}),
  };
  const persistedChannelMeta = {
    ...(channelMeta.isDirectMessage !== undefined
      ? { isDirectMessage: channelMeta.isDirectMessage }
      : {}),
    ...(channelMeta.privacyLevel !== undefined
      ? { privacyLevel: channelMeta.privacyLevel }
      : {}),
    ...(channelMeta.disclosureConsentGranted !== undefined
      ? { disclosureConsentGranted: channelMeta.disclosureConsentGranted }
      : {}),
  };
  const icpCorrelation = message.routing?.icpCorrelation;
  const placeId = resolveMessagePlaceId(message);
  const payloads: BackgroundWorkPayload[] = [];
  if (runtime.memoryExtractor) {
    payloads.push({
      schemaVersion: 1,
      kind: 'memory_extraction',
      source,
      ...(canonicalContactKey ? { canonicalContactId: canonicalContactKey } : {}),
      ...(placeId ? { placeId } : {}),
      ...(icpCorrelation ? { icpCorrelation } : {}),
    });
  }
  payloads.push(
    {
      schemaVersion: 1,
      kind: 'intention_post_turn_hooks',
      source,
      ...(canonicalContactKey ? { canonicalContactKey } : {}),
    },
    {
      schemaVersion: 1,
      kind: 'emotion_appraisal',
      source,
      emotionSessionId,
      internalStateSnapshotRef,
      appraisalState: projectEmotionAppraisalState(internalState),
      personalityOwnerRef: 'character-card',
      personalityProjectionHash: fingerprintEmotionAppraisalPersonalityProjection(templateVariables),
      ...(icpCorrelation ? { icpCorrelation } : {}),
    },
    {
      schemaVersion: 1,
      kind: 'auto_compaction',
      source,
      systemPromptTokenCount: countTokens(fullPrompt),
      memoriesTokenCount: countTokens(memoryContextBlock),
      adaptiveProfile: resolveAdaptiveContextBudgetProfile(runtime.config, turnBudgetCharacteristics),
      turnBudgetCharacteristics: persistedTurnBudgetCharacteristics,
      ...(continuitySubjectKey ? { userId: continuitySubjectKey } : {}),
      ...(Object.keys(persistedChannelMeta).length > 0 ? { channelMeta: persistedChannelMeta } : {}),
      ...(icpCorrelation ? { icpCorrelation } : {}),
    },
  );
  const backgroundWorkInputs = payloads.map(payload => createBackgroundWorkInput({
    kind: payload.kind,
    payload,
    source,
  }));
  if (payloads.some(payload => payload.kind === 'memory_extraction')) {
    const projectionBinding = {
      logicalSessionId: source.logicalSessionId,
      sourceChannelId: source.channelId,
      sourceTurnId: source.turnId,
      sourceRequestId: source.requestId,
    };
    turnRecord.extractedMemoryIds = [buildTurnSubsystemProjectionRef('memory', projectionBinding)];
    turnRecord.concernDeltaRefs = [buildTurnSubsystemProjectionRef('concern', projectionBinding)];
    turnRecord.contactDeltaRefs = [buildTurnSubsystemProjectionRef('contact', projectionBinding)];
  }
  turnRecord.backgroundWorkHandoff = createTurnRecordBackgroundWorkHandoff(backgroundWorkInputs);
  // Record first, then atomically enqueue the complete manifest. A crash on
  // either side is recoverable: no queue row can outlive its canonical source,
  // and delivery/startup replay can safely re-enqueue the stable turn IDs.
  await runtime.sessionManager.recordTurn(turnRecord);
  input.onTurnRecordPersisted?.();
  try {
    await runtime.enqueuePostTurnBackgroundWork(backgroundWorkInputs);
  } catch (error) {
    runtime.sessionManager.deferBackgroundWorkHandoffRecovery(turnRecord);
    throw error;
  }
}
