import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { resolveConfiguredCompanionDataDir } from '../../../../persistence/layout.js';
import { collectGeneratedImageAttachments } from '../../../../primitives/images/generated-media.js';
import type {
  AgentResponse,
  CorrelationMetadata,
  MessagePromptOverrideMode,
  ObservabilityCallType,
  LLMContext,
  SubstrateMessage,
  TurnID,
  TurnUsage,
} from '../../../../shared/contracts/runtime.js';
import type { ContextBudgetTurnCharacteristics } from '../../../../shared/context-budget.js';
import { createComponentLogger } from '../../../../shared/logger.js';
import { toErrorMessage } from '../../../../shared/utils/errors.js';
import {
  buildCompletionHandoffDedupeKey,
  emitCompletionHandoff,
  safeEmitCompletionHandoffError,
  type CompletionHandoffInput,
} from '../../completion-handoff.js';
import type { ChannelMeta } from '../../../../system/trust/policy.js';
import type { TrustLevel } from '../../../../system/trust/types.js';
import type { ConversationScope } from '../../../session/conversation-scope.js';
import type { InternalState } from '../../../self-model/state.js';
import type { TurnSnapshot } from '../../../turns/snapshot.js';
import {
  BACKGROUND_CONTINUATION_RUNTIME_CLASS,
  FOREGROUND_CHAT_RUNTIME_CLASS,
  resolveRuntimeLaneBudgetProfile,
} from '../../worker-lanes.js';
import type { TurnExecutionObservability } from './observability.js';

const log = createComponentLogger('SubstrateAgent');
type TurnExecutionRuntime = import('../turn-execution-runtime.js').TurnExecutionRuntime;

interface PostTurnBackgroundTask {
  name: string;
  promise: Promise<unknown>;
}

export async function collectTurnResponseAttachments(input: {
  runtime: TurnExecutionRuntime;
  turnMessages: AgentMessage[];
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
  return collectGeneratedImageAttachments({
    turnMessages: input.turnMessages,
    companionDataDir: resolveConfiguredCompanionDataDir(input.runtime.config),
    galleryContext: input.galleryContext,
  });
}

function createPostTurnBackgroundTask(input: {
  name: string;
  run: () => Promise<unknown> | unknown;
  onError: (error: unknown) => void;
}): PostTurnBackgroundTask {
  let promise: Promise<unknown>;
  try {
    promise = Promise.resolve(input.run());
  } catch (error) {
    promise = Promise.reject(error);
  }
  return {
    name: input.name,
    promise: promise.catch((error) => {
      input.onError(error);
      throw error;
    }),
  };
}

async function emitBackgroundContinuationCompletionHandoff(input: {
  runtime: TurnExecutionRuntime;
  message: SubstrateMessage;
  response: AgentResponse;
  turnId: TurnID;
  requestId: string;
  completionSignal: ReturnType<TurnExecutionRuntime['queueBackgroundContinuationCompletion']>;
}): Promise<void> {
  const { runtime, message, response, turnId, requestId, completionSignal } = input;
  const handoff: CompletionHandoffInput = {
    source: 'background_continuation',
    taskId: completionSignal.continuationId,
    taskLabel: completionSignal.taskKind ?? completionSignal.intent ?? 'background_continuation',
    status: 'completed',
    resultSummary: response.content.trim()
      ? response.content
      : 'Background continuation completed without deliverable text.',
    outputRefs: [
      { kind: 'background_continuation', ref: completionSignal.continuationId },
      { kind: 'delivery_session', ref: completionSignal.deliverySessionId },
      { kind: 'source_message', ref: completionSignal.sourceMessageId },
    ],
    validationPerformed: [
      'background_completion_policy',
      `notification_reason:${completionSignal.notificationReason}`,
      `notify_user:${String(completionSignal.notifyUser)}`,
      `queued_for_post_turn_delivery:${String(completionSignal.queuedForPostTurnDelivery)}`,
    ],
    partialResult: false,
    recommendedNextAction: completionSignal.notifyUser
      ? 'Review this internal handoff on the next foreground turn and write any partner update in the companion voice under outbound policy.'
      : 'Keep this as internal completion context unless a later policy decision asks for a companion-authored update.',
    origin: {
      originatingTaskId: completionSignal.continuationId,
      sourceChannelId: message.channelId,
      sourceMessageId: message.id,
      requestId,
      turnId,
    },
    dedupeKey: buildCompletionHandoffDedupeKey([
      'background_continuation',
      completionSignal.continuationId,
      completionSignal.sourceMessageId,
      completionSignal.completedAt.toString(),
    ]),
  };

  try {
    // Companion-facing notice only when the continuation actually produced
    // something to act on; bookkeeping completions stay on the event bus.
    const companionRelevant = completionSignal.notifyUser
      || completionSignal.hasDeliverableContent;
    await emitCompletionHandoff({
      eventBus: runtime.eventBus,
      targetChannelId: completionSignal.deliverySessionId,
      handoff,
      ...(companionRelevant ? { notices: runtime.completionNotices } : {}),
    });
  } catch (error) {
    log.warn('Background continuation completion handoff failed', {
      continuationId: completionSignal.continuationId,
      channelId: message.channelId,
      error: safeEmitCompletionHandoffError(error),
    });
  }
}

export async function schedulePostTurnWork(input: {
  runtime: TurnExecutionRuntime;
  message: SubstrateMessage;
  response: AgentResponse;
  turnMessages: AgentMessage[];
  turnId: TurnID;
  requestId: string;
  startTime: number;
  completedAt: number;
  firstTokenAt: number;
  turnUsage: TurnUsage;
  context: LLMContext;
  deferredContinuationId: string | null;
  turnCallType: ObservabilityCallType;
  turnRuntimeClass: string;
  taskKind: string | undefined;
  turnIntent: string | null;
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
    message,
    response,
    turnMessages,
    turnId,
    requestId,
    startTime,
    completedAt,
    firstTokenAt,
    turnUsage,
    context,
    deferredContinuationId,
    turnCallType,
    turnRuntimeClass,
    taskKind,
    turnIntent,
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
    conversationScope,
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
    contextManifest: context.manifest,
    ...(canonicalContactKey ? { canonicalContactKey } : {}),
  });
  const completionSignal = deferredContinuationId && turnCallType === 'background'
    ? runtime.queueBackgroundContinuationCompletion(
      deferredContinuationId,
      message,
      response,
      taskKind ?? null,
      turnIntent,
    )
    : null;
  const postTurnDeliveries = !completionSignal && turnRuntimeClass === FOREGROUND_CHAT_RUNTIME_CLASS
    ? runtime.dequeueBackgroundContinuationDeliveries(
      runtime.resolveSessionChannelId(message.channelId),
      resolveRuntimeLaneBudgetProfile(BACKGROUND_CONTINUATION_RUNTIME_CLASS).maxDeliveriesPerForegroundTurn,
    )
    : [];
  observability.emitObservedTurnStage('end', {
    durationMs: completedAt - startTime,
    ttftMs: firstTokenAt - startTime,
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
  runtime.sessionManager.recordTurn(
    runtime.buildTurnRecord({
      message,
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
    }),
  );

  await runtime.eventBus.emit('agent.turn.end', {
    message,
    response,
    ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.end'),
  });
  if (completionSignal) {
    await emitBackgroundContinuationCompletionHandoff({
      runtime,
      message,
      response,
      turnId,
      requestId,
      completionSignal,
    });
    await runtime.emitBackgroundContinuationEvent(
      'agent.background.continuation.completed',
      {
        channelId: message.channelId,
        runtimeClass: completionSignal.runtimeClass,
        continuationId: completionSignal.continuationId,
        sourceMessageId: completionSignal.sourceMessageId,
        deliverySessionId: completionSignal.deliverySessionId,
        queuedForPostTurnDelivery: completionSignal.queuedForPostTurnDelivery,
        hasDeliverableContent: completionSignal.hasDeliverableContent,
        notifyUser: completionSignal.notifyUser,
        notificationReason: completionSignal.notificationReason,
        origin: completionSignal.origin,
        urgency: completionSignal.urgency,
        channelContext: completionSignal.channelContext,
        completionAgeMs: completionSignal.completionAgeMs,
        stale: completionSignal.stale,
        taskKind: completionSignal.taskKind,
        intent: completionSignal.intent,
        completedAt: completionSignal.completedAt,
        queueDepth: completionSignal.queueDepth,
        droppedContinuationIds: completionSignal.droppedContinuationIds,
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.background.continuation.completed'),
      },
    );
  } else if (postTurnDeliveries.length > 0) {
    await runtime.emitBackgroundContinuationEvent(
      'agent.background.continuation.post_turn_delivery',
      {
        channelId: message.channelId,
        deliverySessionId: runtime.resolveSessionChannelId(message.channelId),
        runtimeClass: BACKGROUND_CONTINUATION_RUNTIME_CLASS,
        deliveries: postTurnDeliveries,
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.background.continuation.post_turn_delivery'),
      },
    );
  }
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

  const postTurnBackgroundWork: PostTurnBackgroundTask[] = [];
  const memoryExtractor = runtime.memoryExtractor;
  if (memoryExtractor) {
    postTurnBackgroundWork.push(createPostTurnBackgroundTask({
      name: 'memory_extraction',
      run: () => memoryExtractor.maybeExtract(
        message.channelId,
        canonicalContactKey,
        turnId,
        // Location tagging (S10): the static satellite place bound to this turn,
        // threaded into memory formation so memories gain a `location:<placeId>`
        // tag. Absent (non-satellite turn) → no location tag (fail-closed).
        message.routing?.satellite?.placeId,
      ),
      onError: (error) => {
        log.error('Memory extraction error', { error: String(error) });
      },
    }));
  }

  postTurnBackgroundWork.push(createPostTurnBackgroundTask({
    name: 'intention_post_turn_hooks',
    run: () => runtime.runIntentionPostTurnHooks({
      message,
      response,
      turnMessages,
      turnId,
      completedAt,
      ...(canonicalContactKey ? { canonicalContactKey } : {}),
    }),
    onError: (error) => {
      log.error('Intention post-turn hook dispatch error', {
        channelId: message.channelId,
        error: toErrorMessage(error),
      });
    },
  }));

  postTurnBackgroundWork.push(createPostTurnBackgroundTask({
    name: 'emotion_appraisal',
    // E1.5: the turn's ConversationScope is plumbed into the appraisal params
    // as an available input; emotion scoping acts on it without changing this
    // call site's shape.
    run: () => runtime.emotionSelfModelRuntime.triggerEmotionAppraisal({
      sessionChannelId: emotionSessionId,
      turnId,
      internalState,
      templateVariables,
      conversationScope,
    }),
    onError: (error) => {
      log.error('Emotion appraisal error', {
        channelId: message.channelId,
        error: toErrorMessage(error),
      });
    },
  }));

  postTurnBackgroundWork.push(createPostTurnBackgroundTask({
    name: 'auto_compaction',
    run: () => runtime.sessionManager.scheduleAutoCompactionBetweenTurns({
      channelId: message.channelId,
      systemPrompt: fullPrompt,
      memoriesBlock: memoryContextBlock,
      llmProvider: runtime.llmClient,
      channelMeta,
      userId: continuitySubjectKey,
      compactionPromptText: turnSnapshot.sessionContext?.compactionPromptText,
      turnBudgetCharacteristics,
    }),
    onError: (error) => {
      log.error('Auto-compaction dispatch error', {
        channelId: message.channelId,
        error: toErrorMessage(error),
      });
    },
  }));

  runtime.registerPostTurnBackgroundWork({
    channelId: message.channelId,
    turnId,
    requestId,
    work: postTurnBackgroundWork,
    correlation: turnCorrelationBase,
  });
}
