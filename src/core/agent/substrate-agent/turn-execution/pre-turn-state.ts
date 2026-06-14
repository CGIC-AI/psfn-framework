import type { CorrelationMetadata, SubstrateMessage, TurnID } from '../../../../shared/contracts/runtime.js';
import type { ContextBudgetTurnCharacteristics } from '../../../../shared/context-budget.js';
import { resolveBroadcastVisibilityScope, type BroadcastVisibilityScope } from '../../../../system/trust/broadcast-safety.js';
import { classifyChannel, type ChannelMeta } from '../../../../system/trust/policy.js';
import { normalizeChannelVisibility, type ChannelVisibility, type TrustLevel } from '../../../../system/trust/types.js';
import type { MemoryScopeQuery, RetrievalCallerContext, RetrievalModeInput } from '../../../../faculties/memory/types.js';
import type { ContextManifestMemorySeed } from '../../../session/context-manifest.js';
import { formatAttributedSystemContent } from '../../../session/entry-attribution.js';
import type { SessionManager } from '../../../session/manager.js';
import type { EmotionStateSnapshot } from '../../../emotion/state.js';
import type { EmotionAppraisalEntry } from '../../../emotion/appraisal.js';
import type { InternalState } from '../../../self-model/state.js';
import type { TurnSessionContextSnapshot, TurnSnapshot } from '../../../turns/snapshot.js';
import { dispatchObserverEvalTurn } from '../../../eval/observer-sidecar/runtime.js';
import type { ObserverEvalLifecycleState } from '../../../eval/observer-sidecar/types.js';
import { createComponentLogger } from '../../../../shared/logger.js';
import { toErrorMessage } from '../../../../shared/utils/errors.js';
import { resolveActiveEmanationState } from '../../active-emanation-state.js';
import { resolveContinuitySubjectKey, type ResolvedAuthorContext } from '../runtime-context.js';
import { collectVisionTurnImageUrls, hasVisionTurnInputs } from '../vision-attachments.js';
import type { TurnExecutionObservability } from './observability.js';

const log = createComponentLogger('SubstrateAgent');
type TurnExecutionRuntime = import('../turn-execution-runtime.js').TurnExecutionRuntime;
const MEMORY_RETRIEVAL_RECENT_ENTRY_LIMIT = 6;
const MEMORY_RETRIEVAL_RECENT_ENTRY_MAX_CHARS = 700;
const MEMORY_RETRIEVAL_QUERY_MAX_CHARS = 6_000;

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
  observerEvalLifecycleState: ObserverEvalLifecycleState;
  preTurnInternalState: InternalState;
  memoryContextBlock: string;
  memoryContextChars: number;
  memoryManifestSeed?: ContextManifestMemorySeed;
  scratchpadBlock: string;
}

function truncateRetrievalContextEntry(value: string): string {
  const compacted = value.replace(/\s+/g, ' ').trim();
  if (compacted.length <= MEMORY_RETRIEVAL_RECENT_ENTRY_MAX_CHARS) {
    return compacted;
  }
  return `${compacted.slice(0, MEMORY_RETRIEVAL_RECENT_ENTRY_MAX_CHARS - 3)}...`;
}

function parseSessionEntryRequestIds(metadata: string | undefined): Set<string> {
  if (!metadata) return new Set();
  try {
    const parsed = JSON.parse(metadata) as { turn?: Record<string, unknown> };
    const turn = parsed.turn;
    if (!turn || typeof turn !== 'object') return new Set();
    return new Set(
      [turn.requestId, turn.sourceMessageId]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map(value => value.trim()),
    );
  } catch {
    return new Set();
  }
}

function isCurrentTurnSessionEntry(
  entry: TurnSessionContextSnapshot['recentEntries'][number],
  message: SubstrateMessage,
): boolean {
  if (parseSessionEntryRequestIds(entry.metadata).has(message.id)) {
    return true;
  }
  return entry.role === 'user' && entry.content === message.content;
}

function buildMemoryRetrievalContextText(
  message: SubstrateMessage,
  sessionContextSnapshot: TurnSessionContextSnapshot | undefined,
): string {
  const currentTurnText = message.content.trim();
  const recentLines = (sessionContextSnapshot?.recentEntries ?? [])
    .filter(entry => entry.role === 'user' || entry.role === 'assistant')
    .filter(entry => !isCurrentTurnSessionEntry(entry, message))
    .slice(-MEMORY_RETRIEVAL_RECENT_ENTRY_LIMIT)
    .map(entry => truncateRetrievalContextEntry(entry.content))
    .filter(line => line.trim().length > 0);

  if (recentLines.length === 0) {
    return message.content;
  }

  // Put continuity anchors first so lexical fallback can find long-lived thread terms
  // instead of spending its limited token budget on generic current-turn phrasing.
  const queryText = [
    recentLines.join('\n'),
    currentTurnText,
  ].join('\n\n');

  if (queryText.length <= MEMORY_RETRIEVAL_QUERY_MAX_CHARS) {
    return queryText;
  }
  return queryText.slice(0, MEMORY_RETRIEVAL_QUERY_MAX_CHARS);
}

export async function prepareTurnIdentityState(input: {
  runtime: TurnExecutionRuntime;
  message: SubstrateMessage;
  turnId: TurnID;
  requestId: string;
  turnCorrelationBase: CorrelationMetadata;
  observability: Pick<TurnExecutionObservability, 'emitObservedTurnStage'>;
  deferSessionEntryPersistence?: boolean;
}): Promise<PreparedTurnIdentityState> {
  const {
    runtime,
    message,
    turnId,
    requestId,
    turnCorrelationBase,
    observability,
    deferSessionEntryPersistence = false,
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

  const userSessionEntryId = deferSessionEntryPersistence
    ? null
    : authorContext.speakerRole === 'system'
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
  const memoryRetrievalContextText = buildMemoryRetrievalContextText(message, sessionContextSnapshot);
  const activeMemoryRequest = {
    contextText: memoryRetrievalContextText,
    channelId: message.channelId,
    trustLevel,
    channelMeta,
    turnBudgetCharacteristics,
    ...(authorContext.canonicalContactKey ? { canonicalContactId: authorContext.canonicalContactKey } : {}),
    ...(focusMemoryScopeQuery ? { scopeQuery: focusMemoryScopeQuery } : {}),
    ...(temporalRetrievalCallerContext ? { callerContext: temporalRetrievalCallerContext } : {}),
    ...(temporalRetrievalMode ? { retrievalMode: temporalRetrievalMode } : {}),
  };
  const activeMemoryContext = memoryProvider && !bypassMemoryForVisionTurn
    && typeof memoryProvider.getActiveMemoryContext === 'function'
    ? memoryProvider.getActiveMemoryContext(activeMemoryRequest)
    : null;
  const activeMemoryRefreshScheduled = !!(
    memoryProvider
    && !bypassMemoryForVisionTurn
    && typeof memoryProvider.refreshActiveMemoryContext === 'function'
  );
  if (activeMemoryRefreshScheduled) {
    void memoryProvider.refreshActiveMemoryContext(activeMemoryRequest).catch((error: unknown) => {
      const errorText = toErrorMessage(error);
      log.error('Active memory context refresh failed after scheduling', {
        channelId: message.channelId,
        turnId,
        requestId,
        error: errorText,
      });
      void runtime.eventBus.emit('memory.active_context.refresh', {
        channelId: message.channelId,
        key: activeMemoryContext?.key ?? 'unresolved',
        phase: 'degraded',
        error: errorText,
        timestamp: Date.now(),
      }).catch((emitError: unknown) => {
        log.debug('Failed to emit active memory refresh degradation event', {
          channelId: message.channelId,
          turnId,
          requestId,
          error: toErrorMessage(emitError),
        });
      });
    });
  }
  const emotionSnapshot = await runtime.emotionSelfModelRuntime.observeEmotionState(
    message.content,
    emotionSessionId,
  );
  const emotionAppraisalChain = runtime.emotionSelfModelRuntime.getEmotionAppraisalChain(emotionSessionId);
  const turnSnapshotCapturedAt = Date.now();
  const observerEvalLifecycleState = await dispatchObserverEvalTurn({
    sidecarRuntime: runtime.observerEvalSidecar,
    logger: log,
    input: {
      schemaVersion: 1,
      turn: {
        turnId,
        requestId,
        sourceMessageId: message.id,
        channelId: message.channelId,
        channelType: message.channelType,
        messageTimestampMs: message.timestamp.getTime(),
        ...(taskKind ? { taskKind } : {}),
      },
      source: {
        routingSource: message.routing?.source ?? 'unspecified',
        isDirectMessage: message.isDirectMessage ?? false,
        ...(channelMeta.privacyLevel ? { channelPrivacy: channelMeta.privacyLevel } : {}),
      },
      emotion: {
        snapshot: emotionSnapshot,
        appraisalEntryCount: emotionAppraisalChain.length,
      },
      metadata: {
        trustLevel,
        speakerRole: authorContext.speakerRole,
        contactResolved: Boolean(authorContext.canonicalContactKey),
        contentLength: message.content.length,
        attachmentCount: message.attachments?.length ?? 0,
        hasVisionInput: bypassMemoryForVisionTurn,
      },
      provenance: {
        seam: 'substrate-agent.pre-turn.emotion-observed',
        capturedAt: turnSnapshotCapturedAt,
        emotionSessionId,
        emotionSnapshotSource: 'observeEmotionState',
        correlation: {
          callType: turnCorrelationBase.callType,
          purpose: turnCorrelationBase.purpose,
        },
      },
    },
  });
  const turnSnapshot: TurnSnapshot = {
    turnId,
    requestId,
    channelId: message.channelId,
    capturedAt: turnSnapshotCapturedAt,
    trustLevel,
    ...(authorContext.canonicalContactKey ? { canonicalContactKey: authorContext.canonicalContactKey } : {}),
    prompt: promptSnapshot,
    ...(sessionContextSnapshot ? { sessionContext: sessionContextSnapshot as TurnSessionContextSnapshot } : {}),
  };
  observability.emitTurnSnapshotInBackground(turnSnapshot);

  const memoryStageStart = Date.now();
  const preTurnInternalState = await runtime.emotionSelfModelRuntime.computeInternalStateForTurn({
    message,
    responseText: '',
    trustLevel,
    canonicalContactKey: authorContext.canonicalContactKey,
    emotionSnapshot,
    toolCallCount: 0,
    sessionChannelId: emotionSessionId,
  });
  const memoryContextBlock = bypassMemoryForVisionTurn ? '' : activeMemoryContext?.contextBlock ?? '';
  const memoryContextChars = memoryContextBlock.length;
  const scratchpadBlock = runtime.buildScratchpadContextBlock();
  observability.emitObservedTurnStage('memory', {
    durationMs: Date.now() - memoryStageStart,
    hasMemoryProvider: memoryProvider != null,
    memoryChars: memoryContextChars,
    memoryBypassedForVisionTurn: bypassMemoryForVisionTurn,
    activeMemoryContextKey: activeMemoryContext?.key ?? null,
    activeMemoryContextVersion: activeMemoryContext?.versionPointer ?? null,
    activeMemoryRefreshStatus: activeMemoryContext?.refreshStatus ?? 'not_ready',
    activeMemoryRefreshScheduled,
    scratchpadChars: scratchpadBlock.length,
    scratchpadIncluded: scratchpadBlock.length > 0,
  });

  return {
    turnSnapshot,
    emotionSnapshot,
    emotionAppraisalChain,
    observerEvalLifecycleState,
    preTurnInternalState,
    memoryContextBlock,
    memoryContextChars,
    ...(activeMemoryContext?.manifestSeed ? { memoryManifestSeed: activeMemoryContext.manifestSeed } : {}),
    scratchpadBlock,
  };
}
