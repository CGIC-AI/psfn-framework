import type { CorrelationMetadata, SubstrateMessage, TurnID } from '../../../../shared/contracts/runtime.js';
import type { ContextBudgetTurnCharacteristics } from '../../../../shared/context-budget.js';
import { resolveBroadcastVisibilityScope, type BroadcastVisibilityScope } from '../../../../system/trust/broadcast-safety.js';
import { getVisibilityDisclosureCeiling, type ChannelMeta } from '../../../../system/trust/policy.js';
import { normalizeChannelPrivacy, type ChannelPrivacy, type ContextEnvelope } from '../../../../system/trust/context-envelope.js';
import type { TrustLevel } from '../../../../system/trust/types.js';
import type { MemoryScopeQuery, RetrievalCallerContext, RetrievalModeInput } from '../../../../faculties/memory/types.js';
import type {
  ActiveMemoryContextRequest,
  ActiveMemoryContextSnapshot,
} from '../../../../faculties/memory/active-context.js';
import type { MemoryProvider } from '../../contracts.js';
import type { ContextManifestMemorySeed } from '../../../session/context-manifest.js';
import { formatAttributedSystemContent } from '../../../session/entry-attribution.js';
import {
  peerCompanionMayBindAsCanonicalContact,
  type ConversationScope,
} from '../../../session/conversation-scope.js';
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
  resolvedChannelPrivacy?: ChannelPrivacy;
  channelMeta: ChannelMeta;
  /** The turn's Context Envelope (identical object to conversationScope.envelope). */
  contextEnvelope: ContextEnvelope;
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
  /**
   * The turn's ConversationScope, resolved exactly once per turn at
   * session-manager ingress and threaded to every scope consumer.
   */
  conversationScope: ConversationScope;
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
  /**
   * E8.3: supplemental wiki RAG block. Empty unless wiki retrieval is wired,
   * enabled, and the deterministic gate fires. Always within its own token cap
   * and assembled into the prompt AFTER memory context, never displacing it.
   */
  wikiContextBlock: string;
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

interface TurnActiveMemorySurface {
  getActiveMemoryContext: (request: ActiveMemoryContextRequest) => ActiveMemoryContextSnapshot | null;
  refreshActiveMemoryContext: (request: ActiveMemoryContextRequest) => Promise<ActiveMemoryContextSnapshot | null>;
}

/**
 * E5.5: the turn hot path serves only the cached active-memory context and
 * schedules a background refresh. The blocking legacy `retrieve()` fallback is
 * retired, so a memory provider wired into turn execution MUST expose the
 * active-context surface. A provider without it is a wiring bug and fails
 * closed instead of silently producing empty memory forever.
 */
function requireTurnActiveMemorySurface(memoryProvider: MemoryProvider | null): TurnActiveMemorySurface | null {
  if (!memoryProvider) return null;
  const getActiveMemoryContext = typeof memoryProvider.getActiveMemoryContext === 'function'
    ? memoryProvider.getActiveMemoryContext.bind(memoryProvider)
    : undefined;
  const refreshActiveMemoryContext = typeof memoryProvider.refreshActiveMemoryContext === 'function'
    ? memoryProvider.refreshActiveMemoryContext.bind(memoryProvider)
    : undefined;
  if (!getActiveMemoryContext || !refreshActiveMemoryContext) {
    throw new Error(
      'Turn execution memory provider must implement getActiveMemoryContext and refreshActiveMemoryContext: '
      + 'the blocking legacy retrieval fallback is retired from the turn hot path (E5.5, fail closed)',
    );
  }
  return { getActiveMemoryContext, refreshActiveMemoryContext };
}

/**
 * Classifies why a turn is proceeding without a fresh active-memory context.
 * `ready` snapshots are healthy (serving last-good while the background lane
 * refreshes is the designed steady state) and produce no degradation signal.
 */
function resolveActiveMemoryTurnDegradedReason(
  snapshot: ActiveMemoryContextSnapshot | null,
): 'not_ready' | 'refresh_failed' | 'stale' | null {
  if (!snapshot) return 'not_ready';
  if (snapshot.refreshStatus === 'degraded') return 'refresh_failed';
  if (snapshot.refreshStatus === 'refreshing') return 'stale';
  return null;
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
  // E3.2: only adapter-declared routing privacy (X-Channel-Privacy header,
  // satellite registry) reaches ChannelMeta. Per-contact conversation-channel
  // privacy is provenance evidence and never gates (docs/context-envelope.md).
  const resolvedChannelPrivacy = normalizeChannelPrivacy(message.routing?.channelPrivacy);
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
  const broadcastVisibilityScope = resolveBroadcastVisibilityScope(message.channelId, channelMeta);
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

  // Single per-turn ConversationScope resolution (session-manager ingress).
  // Resolved after the turn's user message is recorded so the recent-speaker
  // scan sees the same session state the context build sees.
  //
  // E1.7: a scheduler-dispatched reflection/heartbeat turn may carry an explicit
  // group scope hint. When present, the reflection reflects on the ROOM: the
  // conversation scope is rebuilt around the room channel (its own recent-speaker
  // roster and room key), decoupled from the internal reflection transport
  // channel, and no single canonical contact is bound. A dm/absent hint leaves
  // the channel-derived resolution byte-identical.
  //
  // E1.8 guard: a peer companion (machine intelligence) is never selected as the
  // canonical human for a shared room. It binds as the canonical contact only in
  // a genuine DM with that companion (companion-DM is legitimate; the
  // speaking_with machine-intelligence flag still flows to prompt state via
  // authorContext independently of this binding).
  const reflectionScopeHint = message.routing?.reflectionScope;
  const canonicalContactMayBind = peerCompanionMayBindAsCanonicalContact({
    isDirectMessage: channelMeta.isDirectMessage,
    contactIsMachineIntelligence: authorContext.speakingWithIsMachineIntelligence,
  });
  // E3.3 envelope derivation inputs: scan the recent-speaker window ONCE and
  // resolve how many speakers are resolvable to contacts, then hand both to
  // the single scope resolution so ConversationScope.envelope is derived at
  // ingress. Group reflection turns fail closed (no contact lookups through
  // the internal transport channel).
  const scopeChannelId = reflectionScopeHint?.kind === 'group'
    ? reflectionScopeHint.roomId
    : message.channelId;
  const recentSpeakers = runtime.sessionManager.getRecentConversationSpeakers(scopeChannelId);
  const resolvedSpeakerContactCount = reflectionScopeHint?.kind === 'group'
    ? undefined
    : await runtime.countResolvableSpeakerContacts(message, recentSpeakers);
  const conversationScope = reflectionScopeHint?.kind === 'group'
    ? runtime.sessionManager.resolveConversationScope({
      channelId: reflectionScopeHint.roomId,
      recentSpeakers,
    })
    : runtime.sessionManager.resolveConversationScope({
      channelId: message.channelId,
      channelMeta,
      recentSpeakers,
      ...(resolvedSpeakerContactCount !== undefined ? { resolvedSpeakerContactCount } : {}),
      ...(continuitySubjectKey ? { userId: continuitySubjectKey } : {}),
      ...(canonicalContactMayBind && authorContext.canonicalContactKey
        ? {
          contact: {
            contactId: authorContext.canonicalContactKey,
            displayName: authorContext.resolvedUserName,
          },
        }
        : {}),
    });

  const viewerRequestContext: Partial<CorrelationMetadata> = {
    viewerTrustLevel: authorContext.trustLevel,
    viewerChannelPrivacy: conversationScope.envelope.channelPrivacy,
    ...(message.isDirectMessage !== undefined ? { viewerIsDirectMessage: message.isDirectMessage } : {}),
    ...(canonicalEmbodimentContext ? { embodimentContext: canonicalEmbodimentContext } : {}),
  };

  return {
    authorContext,
    ...(resolvedChannelPrivacy ? { resolvedChannelPrivacy } : {}),
    channelMeta,
    contextEnvelope: conversationScope.envelope,
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
    conversationScope,
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
  conversationScope: ConversationScope;
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
    conversationScope,
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
  const activeMemorySurface = requireTurnActiveMemorySurface(memoryProvider);
  const bypassMemoryForVisionTurn = hasVisionTurnInputs(message);
  const promptSnapshot = runtime.captureTurnPromptSnapshot({ channelType, taskKind });
  // Single session-context derivation for the turn (E2.2): captured once here,
  // it feeds the retrieval query, the live context build (assembleTurnPrompt
  // passes it to buildContext), and the persisted PromptPlan turn snapshot.
  const sessionContextSnapshot = await runtime.sessionManager.captureTurnSessionContext({
    channelId: message.channelId,
    userId: input.continuitySubjectKey,
    channelMeta,
    continuityFallbackUserIds: authorContext.continuityFallbackKeys,
    turnBudgetCharacteristics,
  });
  const memoryRetrievalContextText = buildMemoryRetrievalContextText(message, sessionContextSnapshot);
  const sessionChannelId = runtime.resolveSessionChannelId(message.channelId);
  const activeMemoryRequest = {
    contextText: memoryRetrievalContextText,
    channelId: message.channelId,
    sessionChannelId,
    trustLevel,
    channelMeta,
    conversationScope,
    turnBudgetCharacteristics,
    ...(authorContext.canonicalContactKey ? { canonicalContactId: authorContext.canonicalContactKey } : {}),
    ...(focusMemoryScopeQuery ? { scopeQuery: focusMemoryScopeQuery } : {}),
    ...(temporalRetrievalCallerContext ? { callerContext: temporalRetrievalCallerContext } : {}),
    ...(temporalRetrievalMode ? { retrievalMode: temporalRetrievalMode } : {}),
  };
  const activeMemoryContext = activeMemorySurface && !bypassMemoryForVisionTurn
    ? activeMemorySurface.getActiveMemoryContext(activeMemoryRequest)
    : null;
  // E5.5: degraded state is explicit, never silent. When the turn proceeds
  // without a fresh active context (cold start, failed refresh, or a refresh
  // still in flight from an earlier pass) a typed event records why. The turn
  // itself continues on the last-good context: the background refresh catches
  // up next pass, and remembering a turn late is acceptable in this design.
  const activeMemoryDegradedReason = activeMemorySurface && !bypassMemoryForVisionTurn
    ? resolveActiveMemoryTurnDegradedReason(activeMemoryContext)
    : null;
  if (activeMemoryDegradedReason) {
    void runtime.eventBus.emit('memory.active_context.turn_degraded', {
      channelId: message.channelId,
      key: activeMemoryContext?.key ?? 'unresolved',
      reason: activeMemoryDegradedReason,
      refreshStatus: activeMemoryContext?.refreshStatus === 'degraded'
        || activeMemoryContext?.refreshStatus === 'refreshing'
        ? activeMemoryContext.refreshStatus
        : null,
      turnId,
      requestId,
      ...(activeMemoryContext?.lastRefreshError ? { lastRefreshError: activeMemoryContext.lastRefreshError } : {}),
      timestamp: Date.now(),
    }).catch((emitError: unknown) => {
      log.debug('Failed to emit active memory turn degradation event', {
        channelId: message.channelId,
        turnId,
        requestId,
        error: toErrorMessage(emitError),
      });
    });
  }
  const refreshActiveMemoryContext = activeMemorySurface && !bypassMemoryForVisionTurn
    ? activeMemorySurface.refreshActiveMemoryContext
    : undefined;
  const activeMemoryRefreshScheduled = refreshActiveMemoryContext !== undefined;
  if (refreshActiveMemoryContext) {
    void refreshActiveMemoryContext(activeMemoryRequest).catch((error: unknown) => {
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
    // E1.5: the turn's ConversationScope keys the per-scope emotion slot and
    // drives directional group→DM carry-over.
    conversationScope,
    // E6.3: this message's author identity (canonical contact key, else raw
    // authorId) keys the per-participant trend line inside a group room. Only
    // this author's own trend moves; idle participants are never touched.
    authorContext.canonicalContactKey ?? message.authorId,
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
        sensitivity: getVisibilityDisclosureCeiling(conversationScope.envelope),
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
    sessionContext: sessionContextSnapshot,
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
    conversationScope,
  });
  const memoryContextBlock = bypassMemoryForVisionTurn
    ? ''
    : activeMemoryContext?.contextBlock ?? '';
  const memoryContextChars = memoryContextBlock.length;
  // E8.3: supplemental wiki RAG resolved AFTER memory context above. Memory
  // content/budget is already fixed at this point, so wiki can never displace
  // it; wiki carries its own bounded, config-owned token cap and fails closed
  // to '' on any error. Skipped on vision-bypass turns and when unwired.
  const wikiContextBlock = runtime.wikiRetrieval && !bypassMemoryForVisionTurn
    ? await runtime.wikiRetrieval.retrieveContextBlock({
      channelId: message.channelId,
      queryText: memoryRetrievalContextText,
      isDirectMessage: channelMeta.isDirectMessage,
      focusActive: focusMemoryScopeQuery != null,
      correlation: turnCorrelationBase,
    })
    : '';
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
    wikiContextBlock,
    scratchpadBlock,
  };
}
