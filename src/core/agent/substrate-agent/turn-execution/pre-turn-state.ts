import type { CorrelationMetadata, SubstrateMessage, TurnID } from '../../../../shared/contracts/runtime.js';
import type { ContextBudgetTurnCharacteristics } from '../../../../shared/context-budget.js';
import { runWithRequestContext } from '../../../../primitives/llm/request-context.js';
import { resolveBroadcastVisibilityScope, type BroadcastVisibilityScope } from '../../../../system/trust/broadcast-safety.js';
import { classifyChannel, type ChannelMeta } from '../../../../system/trust/policy.js';
import { normalizeChannelVisibility, type ChannelVisibility, type TrustLevel } from '../../../../system/trust/types.js';
import type { MemoryScopeQuery, RetrievalCallerContext, RetrievalModeInput } from '../../../../faculties/memory/types.js';
import { formatAttributedSystemContent } from '../../../session/entry-attribution.js';
import type { SessionManager } from '../../../session/manager.js';
import type { EmotionStateSnapshot } from '../../../emotion/state.js';
import type { EmotionAppraisalEntry } from '../../../emotion/appraisal.js';
import type { InternalState } from '../../../self-model/state.js';
import type { TurnMemorySnapshot, TurnSessionContextSnapshot, TurnSnapshot } from '../../../turns/snapshot.js';
import { createComponentLogger } from '../../../../shared/logger.js';
import { toErrorMessage } from '../../../../shared/utils/errors.js';
import { resolveActiveEmanationState } from '../../active-emanation-state.js';
import { resolveContinuitySubjectKey, type ResolvedAuthorContext } from '../runtime-context.js';
import { collectVisionTurnImageUrls, hasVisionTurnInputs } from '../vision-attachments.js';
import type { TurnExecutionObservability } from './observability.js';

const log = createComponentLogger('SubstrateAgent');
type TurnExecutionRuntime = import('../turn-execution-runtime.js').TurnExecutionRuntime;

export interface PreparedTurnIdentityState {
  authorContext: ResolvedAuthorContext;
  resolvedChannelPrivacy?: ChannelVisibility;
  channelMeta: ChannelMeta;
  channelVisibility: ChannelVisibility;
  broadcastVisibilityScope: BroadcastVisibilityScope | null;
  viewerRequestContext: Partial<CorrelationMetadata>;
  baseVisionToolRequestContext: {
    userMessageText: string;
    imageAttachmentUrls: string[];
  };
  continuitySubjectKey: string | undefined;
  attributedSystemContent: string;
  userSessionEntryId: number | null;
  emotionSessionId: string;
  trustLevel: TrustLevel;
  speakerRole: 'user' | 'system';
  canonicalContactKey?: string;
}

export interface PreTurnComputationResult {
  turnSnapshot: TurnSnapshot;
  emotionSnapshot: EmotionStateSnapshot | null;
  emotionAppraisalChain: readonly EmotionAppraisalEntry[];
  preTurnInternalState: InternalState;
  memoryContextBlock: string;
  memoryContextChars: number;
  scratchpadBlock: string;
}

export async function prepareTurnIdentityState(input: {
  runtime: TurnExecutionRuntime;
  message: SubstrateMessage;
  turnId: TurnID;
  requestId: string;
  turnCorrelationBase: CorrelationMetadata;
  observability: Pick<TurnExecutionObservability, 'emitObservedTurnStage'>;
}): Promise<PreparedTurnIdentityState> {
  const {
    runtime,
    message,
    turnId,
    requestId,
    turnCorrelationBase,
    observability,
  } = input;

  const trustStageStart = Date.now();
  const routingPresenceResolution = resolveActiveEmanationState(
    message.routing?.presence ?? message.routing?.wyoming?.presence,
  );
  const canonicalPresence = routingPresenceResolution.presence;
  const canonicalSatellitePresence = runtime.satellitePresence.resolveCanonicalSatellite(canonicalPresence);
  const canonicalEmbodimentContext = runtime.satellitePresence.resolveCanonicalEmbodiment(canonicalPresence);
  if (canonicalPresence) {
    const nextRouting = {
      ...(message.routing ?? {}),
      ...(canonicalPresence.channelPrivacy ? { channelPrivacy: canonicalPresence.channelPrivacy } : {}),
      presence: canonicalPresence,
    };
    if (message.routing?.wyoming || canonicalSatellitePresence) {
      nextRouting.wyoming = {
        ...(message.routing?.wyoming ?? {}),
        ...(canonicalSatellitePresence?.siteId ? { siteId: canonicalSatellitePresence.siteId } : {}),
        ...(canonicalSatellitePresence ? { satelliteId: canonicalSatellitePresence.satelliteId } : {}),
        presence: canonicalPresence,
      };
    }
    message.routing = nextRouting;
  }

  const authorContext = await runtime.resolveAuthorContext(message);
  const resolvedChannelPrivacy = normalizeChannelVisibility(message.routing?.channelPrivacy)
    ?? authorContext.channelPrivacyLevel;
  if (resolvedChannelPrivacy && message.routing?.channelPrivacy !== resolvedChannelPrivacy) {
    message.routing = {
      ...(message.routing ?? {}),
      channelPrivacy: resolvedChannelPrivacy,
    };
  }
  const channelMeta: ChannelMeta = {
    ...(message.isDirectMessage !== undefined ? { isDirectMessage: message.isDirectMessage } : {}),
    ...(message.routing?.broadcast?.approvalToken
      ? { broadcastApprovalToken: message.routing.broadcast.approvalToken }
      : {}),
    ...(resolvedChannelPrivacy ? { privacyLevel: resolvedChannelPrivacy } : {}),
  };
  const channelVisibility = classifyChannel(message.channelId, channelMeta);
  const broadcastVisibilityScope = resolveBroadcastVisibilityScope(message.channelId, channelMeta);
  const viewerRequestContext: Partial<CorrelationMetadata> = {
    viewerTrustLevel: authorContext.trustLevel,
    viewerChannelVisibility: channelVisibility,
    ...(message.isDirectMessage !== undefined ? { viewerIsDirectMessage: message.isDirectMessage } : {}),
    ...(canonicalEmbodimentContext ? { embodimentContext: canonicalEmbodimentContext } : {}),
  };
  const baseVisionToolRequestContext = {
    userMessageText: message.content,
    imageAttachmentUrls: collectVisionTurnImageUrls(message),
  };

  void runtime.eventBus.emit('agent.turn.start', {
    message: structuredClone(message),
    ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.start'),
  }).catch(error => {
    log.debug('Background turn start emit failed', {
      channelId: message.channelId,
      turnId,
      requestId,
      error: toErrorMessage(error),
    });
  });

  const continuitySubjectKey = authorContext.continuitySubjectKey
    ?? resolveContinuitySubjectKey({
      canonicalContactKey: authorContext.canonicalContactKey,
      subjectIdentityKey: authorContext.subjectIdentityKey,
      authorId: message.authorId,
    });
  const attributedSystemContent = authorContext.speakerRole === 'system'
    ? formatAttributedSystemContent(message.content, message.authorName)
    : message.content;
  observability.emitObservedTurnStage('trust', {
    durationMs: Date.now() - trustStageStart,
    trustLevel: authorContext.trustLevel,
    canonicalContactKey: authorContext.canonicalContactKey ?? null,
  });

  runtime.emotionSelfModelRuntime.assertSelfModelRuntimeConfigured();
  await runtime.sessionManager.awaitPendingAutoCompaction(message.channelId);

  const userSessionEntryId = authorContext.speakerRole === 'system'
    ? runtime.recordSystemMessage(
      message,
      turnId,
      requestId,
      attributedSystemContent,
      continuitySubjectKey,
    )
    : runtime.recordUserMessage(
      message,
      turnId,
      requestId,
      authorContext.trustLevel,
      continuitySubjectKey,
    );

  return {
    authorContext,
    ...(resolvedChannelPrivacy ? { resolvedChannelPrivacy } : {}),
    channelMeta,
    channelVisibility,
    broadcastVisibilityScope,
    viewerRequestContext,
    baseVisionToolRequestContext,
    continuitySubjectKey,
    attributedSystemContent,
    userSessionEntryId,
    emotionSessionId: runtime.resolveSessionChannelId(message.channelId),
    trustLevel: authorContext.trustLevel,
    speakerRole: authorContext.speakerRole,
    ...(authorContext.canonicalContactKey ? { canonicalContactKey: authorContext.canonicalContactKey } : {}),
  };
}

export async function computePreTurnState(input: {
  runtime: TurnExecutionRuntime;
  message: SubstrateMessage;
  channelType: string | undefined;
  taskKind: string | undefined;
  turnId: TurnID;
  requestId: string;
  channelMeta: ChannelMeta;
  authorContext: ResolvedAuthorContext;
  continuitySubjectKey: string | undefined;
  trustLevel: TrustLevel;
  emotionSessionId: string;
  turnBudgetCharacteristics: ContextBudgetTurnCharacteristics;
  focusMemoryScopeQuery: MemoryScopeQuery | null;
  temporalRetrievalCallerContext: RetrievalCallerContext | undefined;
  temporalRetrievalMode: RetrievalModeInput | undefined;
  viewerRequestContext: Partial<CorrelationMetadata>;
  turnCorrelationBase: CorrelationMetadata;
  observability: Pick<TurnExecutionObservability, 'emitObservedTurnStage' | 'emitTurnSnapshotInBackground'>;
}): Promise<PreTurnComputationResult> {
  const {
    runtime,
    message,
    channelType,
    taskKind,
    turnId,
    requestId,
    channelMeta,
    authorContext,
    trustLevel,
    emotionSessionId,
    turnBudgetCharacteristics,
    focusMemoryScopeQuery,
    temporalRetrievalCallerContext,
    temporalRetrievalMode,
    viewerRequestContext,
    turnCorrelationBase,
    observability,
  } = input;

  const memoryProvider = runtime.memoryProvider;
  const bypassMemoryForVisionTurn = hasVisionTurnInputs(message);
  const promptSnapshot = runtime.captureTurnPromptSnapshot({ channelType, taskKind });
  const sessionContextSnapshot = typeof (runtime.sessionManager as SessionManager & {
    captureTurnContextSnapshot?: SessionManager['captureTurnContextSnapshot'];
  }).captureTurnContextSnapshot === 'function'
    ? runtime.sessionManager.captureTurnContextSnapshot(
      message.channelId,
      input.continuitySubjectKey,
      channelMeta,
      authorContext.continuityFallbackKeys,
      turnBudgetCharacteristics,
    )
    : undefined;
  const [emotionSnapshot, memorySnapshot] = await Promise.all([
    runtime.emotionSelfModelRuntime.observeEmotionState(
      message.content,
      emotionSessionId,
    ),
    memoryProvider && typeof memoryProvider.captureTurnMemorySnapshot === 'function'
      ? memoryProvider.captureTurnMemorySnapshot(
        message.content,
        message.channelId,
        trustLevel,
        channelMeta,
        authorContext.canonicalContactKey,
        turnBudgetCharacteristics,
        focusMemoryScopeQuery ?? undefined,
        temporalRetrievalCallerContext,
        temporalRetrievalMode,
      )
      : Promise.resolve(undefined),
  ]);
  const emotionAppraisalChain = runtime.emotionSelfModelRuntime.getEmotionAppraisalChain(emotionSessionId);
  const turnSnapshot: TurnSnapshot = {
    turnId,
    requestId,
    channelId: message.channelId,
    capturedAt: Date.now(),
    trustLevel,
    ...(authorContext.canonicalContactKey ? { canonicalContactKey: authorContext.canonicalContactKey } : {}),
    prompt: promptSnapshot,
    ...(sessionContextSnapshot ? { sessionContext: sessionContextSnapshot as TurnSessionContextSnapshot } : {}),
    ...(memorySnapshot ? { memory: memorySnapshot as TurnMemorySnapshot } : {}),
  };
  observability.emitTurnSnapshotInBackground(turnSnapshot);

  const memoryStageStart = Date.now();
  const internalStatePromise = runtime.emotionSelfModelRuntime.computeInternalStateForTurn({
    message,
    responseText: '',
    trustLevel,
    canonicalContactKey: authorContext.canonicalContactKey,
    emotionSnapshot,
    toolCallCount: 0,
    sessionChannelId: emotionSessionId,
  });
  const memoryPromise = runWithRequestContext(
    {
      ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.memory'),
      ...viewerRequestContext,
    },
    async () => {
      const memoriesBlockPromise = memoryProvider
        && !bypassMemoryForVisionTurn
        ? memoryProvider.retrieve(
          message.content,
          message.channelId,
          trustLevel,
          channelMeta,
          authorContext.canonicalContactKey,
          memorySnapshot,
          turnBudgetCharacteristics,
          undefined,
          focusMemoryScopeQuery ?? undefined,
          temporalRetrievalCallerContext,
          temporalRetrievalMode,
        )
        : Promise.resolve('');
      const proactiveRecallBlockPromise = memoryProvider
        && !bypassMemoryForVisionTurn
        && typeof memoryProvider.retrieveProactiveRecall === 'function'
        ? memoryProvider.retrieveProactiveRecall(
          message.channelId,
          trustLevel,
          channelMeta,
          authorContext.canonicalContactKey,
          memorySnapshot,
          turnBudgetCharacteristics,
          focusMemoryScopeQuery ?? undefined,
        )
        : Promise.resolve('');
      const [memoriesBlock, proactiveRecallBlock] = await Promise.all([
        memoriesBlockPromise,
        proactiveRecallBlockPromise,
      ]);
      return { memoriesBlock, proactiveRecallBlock };
    },
  );
  const [{ memoriesBlock, proactiveRecallBlock }, preTurnInternalState] = await Promise.all([
    memoryPromise,
    internalStatePromise,
  ]);
  const memoryContextBlock = [memoriesBlock, proactiveRecallBlock]
    .map(section => section.trim())
    .filter(section => section.length > 0)
    .join('\n\n');
  const memoryContextChars = memoryContextBlock.length;
  const scratchpadBlock = runtime.buildScratchpadContextBlock();
  observability.emitObservedTurnStage('memory', {
    durationMs: Date.now() - memoryStageStart,
    hasMemoryProvider: memoryProvider != null,
    memoryChars: memoryContextChars,
    proactiveRecallChars: proactiveRecallBlock.length,
    proactiveRecallIncluded: proactiveRecallBlock.length > 0,
    memoryBypassedForVisionTurn: bypassMemoryForVisionTurn,
    scratchpadChars: scratchpadBlock.length,
    scratchpadIncluded: scratchpadBlock.length > 0,
  });

  return {
    turnSnapshot,
    emotionSnapshot,
    emotionAppraisalChain,
    preTurnInternalState,
    memoryContextBlock,
    memoryContextChars,
    scratchpadBlock,
  };
}
