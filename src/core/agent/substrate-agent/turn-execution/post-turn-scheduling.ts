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
import type { ContextBudgetTurnCharacteristics } from '../../../../shared/context-budget.js';
import { createComponentLogger } from '../../../../shared/logger.js';
import { toErrorMessage } from '../../../../shared/utils/errors.js';
import type { ChannelMeta } from '../../../../system/trust/policy.js';
import type { TrustLevel } from '../../../../system/trust/types.js';
import type { ConversationScope } from '../../../session/conversation-scope.js';
import type { InternalState } from '../../../self-model/state.js';
import type { TurnSnapshot } from '../../../turns/snapshot.js';
import type { TurnExecutionObservability } from './observability.js';
import { resolveMessagePlaceId } from '../message-location.js';

const log = createComponentLogger('SubstrateAgent');
type TurnExecutionRuntime = import('../turn-execution-runtime.js').TurnExecutionRuntime;

interface PostTurnBackgroundTask {
  name: string;
  promise: Promise<unknown>;
}

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

export async function schedulePostTurnWork(input: {
  runtime: TurnExecutionRuntime;
  message: SubstrateMessage;
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
    ...(taskKind ? { taskKind } : {}),
    contextManifest: context.manifest,
    ...(canonicalContactKey ? { canonicalContactKey } : {}),
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
    });

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

  const postTurnBackgroundWork: PostTurnBackgroundTask[] = [];
  const memoryExtractor = runtime.memoryExtractor;
  if (memoryExtractor) {
    postTurnBackgroundWork.push(createPostTurnBackgroundTask({
      name: 'memory_extraction',
      run: () => memoryExtractor.maybeExtract(
        message.channelId,
        canonicalContactKey,
        turnId,
        // Location tagging (S10): gateway-authoritative companion-room place
        // first, then the static satellite binding. Absent means no location
        // tag (fail-closed).
        resolveMessagePlaceId(message),
        message.routing?.icpCorrelation,
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
      ...(message.routing?.icpCorrelation
        ? { icpCorrelation: message.routing.icpCorrelation }
        : {}),
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
      ...(message.routing?.icpCorrelation
        ? { icpCorrelation: message.routing.icpCorrelation }
        : {}),
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
      ...(message.routing?.icpCorrelation
        ? { icpCorrelation: message.routing.icpCorrelation }
        : {}),
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
  // This is the durable completion marker for post-turn scheduling. Keep it
  // last: a recovery may skip this whole scheduler only after every awaited
  // effect ran and every background task was handed to the runtime owner.
  runtime.sessionManager.recordTurn(turnRecord);
}
