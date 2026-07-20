import type {
  CorrelationMetadata,
  RequestAudience,
  SubstrateMessage,
  TurnID,
} from '../../../../shared/contracts/runtime.js';
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
import type { WikiContextSnapshot } from '../../../../faculties/wiki/active-context.js';
import type { MemoryProvider, WikiRetrievalRequest } from '../../contracts.js';
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
import type {
  ObserverEvalLifecycleState,
  ObserverEvalRoutingSource,
} from '../../../eval/observer-sidecar/types.js';
import { createComponentLogger } from '../../../../shared/logger.js';
import { toErrorMessage } from '../../../../shared/utils/errors.js';
import { resolveActiveEmanationState } from '../../active-emanation-state.js';
import { resolveContinuitySubjectKey, resolveRequesterProvenance, type ResolvedAuthorContext } from '../runtime-context.js';
import { resolveSituatedSiteId } from '../runtime-context-sections/situated-presence.js';
import { collectVisionTurnImageUrls, hasVisionTurnInputs } from '../vision-attachments.js';
import type { TurnExecutionObservability } from './observability.js';
import type { TurnRetrievalQueryEmbedding } from '../../../../shared/retrieval-query-embedding.js';
import { resolveCompanionIdFromConfig } from '../../../identity/companion-runtime.js';
import type { SessionActorKind } from '../../../session/turn-provenance.js';
import { runWithRequestContext } from '../../../../primitives/llm/request-context.js';
import {
  COMPANION_SELF_CREATION_RETRIEVAL_PURPOSE,
} from '../../../../faculties/memory/retrieval/access-scope.js';
import type { ArtifactSensitivitySource } from '../../../../shared/contracts/artifact-sensitivity.js';
import type { TurnExecutionRuntime, TurnSessionIdentity } from './contracts.js';

const log = createComponentLogger('SubstrateAgent');
const MEMORY_RETRIEVAL_RECENT_ENTRY_LIMIT = 6;
const MEMORY_RETRIEVAL_RECENT_ENTRY_MAX_CHARS = 700;
const MEMORY_RETRIEVAL_QUERY_MAX_CHARS = 6_000;

function resolveSessionActorKind(authorContext: ResolvedAuthorContext): SessionActorKind {
  return authorContext.actorKind;
}

function resolveObserverEvalRoutingSource(message: SubstrateMessage): ObserverEvalRoutingSource {
  if (message.routing?.source) {
    return message.routing.source;
  }
  if (message.channelType === 'api' || message.channelType === 'terminal') {
    return message.channelType;
  }
  return 'unspecified';
}

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
  artifactSensitivitySources: ArtifactSensitivitySource[];
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
  createTurnRetrievalQueryEmbedding?: (input: {
    turnId: string;
    requestId: string;
    companionId: string;
    channelId: string;
    canonicalContactId?: string;
    queryText: string;
  }) => TurnRetrievalQueryEmbedding;
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
  const createTurnRetrievalQueryEmbedding = typeof memoryProvider.createTurnRetrievalQueryEmbedding === 'function'
    ? memoryProvider.createTurnRetrievalQueryEmbedding.bind(memoryProvider)
    : undefined;
  if (!getActiveMemoryContext || !refreshActiveMemoryContext) {
    throw new Error(
      'Turn execution memory provider must implement getActiveMemoryContext and refreshActiveMemoryContext: '
      + 'the blocking legacy retrieval fallback is retired from the turn hot path (E5.5, fail closed)',
    );
  }
  return {
    getActiveMemoryContext,
    refreshActiveMemoryContext,
    ...(createTurnRetrievalQueryEmbedding ? { createTurnRetrievalQueryEmbedding } : {}),
  };
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

/**
 * mmo9.7.4: same explicit-degradation classification for the wiki cached
 * snapshot as active-memory. A `ready` snapshot (including the gate-skipped
 * empty snapshot when wiki retrieval is disabled) is healthy and produces no
 * signal; a cold miss, in-flight refresh, or failed refresh does.
 */
function resolveWikiTurnDegradedReason(
  snapshot: WikiContextSnapshot | null,
): 'not_ready' | 'refresh_failed' | 'stale' | null {
  if (!snapshot) return 'not_ready';
  if (snapshot.refreshStatus === 'degraded') return 'refresh_failed';
  if (snapshot.refreshStatus === 'refreshing') return 'stale';
  return null;
}

export async function prepareTurnIdentityState(input: {
  runtime: TurnExecutionRuntime;
  message: SubstrateMessage;
  turnSessionIdentity: TurnSessionIdentity;
  turnId: TurnID;
  requestId: string;
  turnCorrelationBase: CorrelationMetadata;
  observability: Pick<TurnExecutionObservability, 'emitObservedTurnStage'>;
  deferSessionEntryPersistence?: boolean;
  skipSessionEntryPersistence?: boolean;
}): Promise<PreparedTurnIdentityState> {
  const {
    runtime,
    message,
    turnSessionIdentity,
    turnId,
    requestId,
    turnCorrelationBase,
    observability,
    deferSessionEntryPersistence = false,
    skipSessionEntryPersistence = false,
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

  // Cross-companion presence (sprint 10, W5a): a turn situated at a place
  // (satellite-place binding) refreshes this companion's own row in the shared
  // companion_presence table and the co-presence snapshot the situated context
  // section renders later this same turn. New co-present companions emit
  // `presence.companion.co_located` inside this call. No-op when unwired
  // (single-companion / flag-off) or when the turn resolves no place; the port
  // never throws (presence failures are logged, not turn-fatal).
  //
  // Dual presence (vinz.29): a mindspace (plain-chat) turn that foregrounds a
  // VIRTUAL place through the situated fallback (the twin of the last-known
  // physical room, or a deliberate virtual move) counts as presence at that
  // twin — the port writes kind 'virtual' there. The fallback never produces a
  // physical arrival (the port only accepts virtual fallback places), so a
  // Discord DM still cannot look like walking into a physical room.
  if (runtime.companionPresence) {
    await runtime.companionPresence.observeTurnPlace(
      message,
      runtime.resolveSituatedFallbackPlaceId?.(message),
    );
  }

  const authorContext = await runtime.resolveAuthorContext(message);

  // Virtual-activity presence follow (vinz.21): now that the author's trust
  // is resolved, trusted-partner activity in a place-bound virtual
  // companion-room the companion is not present at pulls her virtual presence
  // there (same port path as a deliberate move — arrival semantics +
  // room-entry note into this channel's session, so this turn's context
  // assembly already sees the arrival). Physical-origin turns and every
  // fail-closed case no-op inside the follower; it never throws.
  if (runtime.followVirtualRoomActivity) {
    await runtime.followVirtualRoomActivity(message, authorContext);
  }

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
  // mmo9.4: the foreground turn no longer blocks on pending auto-compaction.
  // Compaction runs as a durable between-turns job that commits atomically
  // (insertCompaction is an append-only synchronous mutation that deletes no
  // entries; its only async gap — the LLM summarization — precedes the atomic
  // insert). A concurrent foreground read therefore sees either the
  // pre-compaction entries (already token-budgeted) or the committed
  // summary+kept form — both internally consistent, no torn read reachable. The
  // turn builds context on the last-committed revision and carries a
  // compactionPending marker (buildContext -> compactionManifest.pending) so it
  // knowingly reflects the pre-compaction form. Do NOT reintroduce a bounded
  // wait here — that is a partial cliff plus nondeterminism; LLM admission /
  // deadline is mmo9.5, not this bead (Law 12.4: no second budget system).
  const compactionPending = runtime.sessionManager.hasPendingAutoCompaction(message.channelId);
  observability.emitPerformanceStage('compaction_wait', {
    durationMs: 0,
    ...(compactionPending
      ? { backgroundJobKind: 'auto_compaction' as const, backgroundJobState: 'running' as const }
      : {}),
  });

  const privateTurnTrigger = message.routing?.privateTurnTrigger === true;
  const userSessionEntryId = privateTurnTrigger || skipSessionEntryPersistence
    ? null
    : deferSessionEntryPersistence
    ? null
    : authorContext.speakerRole === 'system'
      ? runtime.recordSystemMessage(
        message,
        turnSessionIdentity,
        turnId,
        requestId,
        attributedSystemContent,
        continuitySubjectKey,
      )
      : runtime.recordUserMessage(
        message,
        turnSessionIdentity,
        turnId,
        requestId,
        authorContext.trustLevel,
        continuitySubjectKey,
        undefined,
        resolveSessionActorKind(authorContext),
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
    : turnSessionIdentity.logicalSessionId;
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
      channelId: turnSessionIdentity.logicalSessionId,
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

  const requesterProvenance = resolveRequesterProvenance(authorContext, message);
  let requestAudience: RequestAudience | undefined;
  if (
    requesterProvenance === 'self_directed'
    && message.channelId.startsWith('internal:free-time:')
    && message.channelId.length > 'internal:free-time:'.length
  ) {
    requestAudience = 'self';
  } else if (
    requesterProvenance === 'human'
    && authorContext.trustLevel === 'primary'
    && conversationScope.kind === 'dm'
    && conversationScope.envelope.channelPrivacy === 'private'
    && conversationScope.envelope.broadcast === false
  ) {
    requestAudience = 'primary_contact';
  } else if (!message.channelId.startsWith('internal:')) {
    requestAudience = 'external';
  }

  const viewerRequestContext: Partial<CorrelationMetadata> = {
    viewerTrustLevel: authorContext.trustLevel,
    // Requester provenance is orthogonal to trust level: self-directed/system
    // turns carry trustLevel 'primary' for scoping but have no human in the loop.
    // Human-in-the-loop effector gates (world.control Gate 2) read THIS, not trust.
    requesterProvenance,
    ...(requestAudience ? { requestAudience } : {}),
    viewerChannelPrivacy: conversationScope.envelope.channelPrivacy,
    ...(authorContext.canonicalContactKey
      ? { viewerMemorySubjectContactId: authorContext.canonicalContactKey }
      : {}),
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
    emotionSessionId: turnSessionIdentity.logicalSessionId,
    trustLevel: authorContext.trustLevel,
    speakerRole: authorContext.speakerRole,
    ...(authorContext.canonicalContactKey ? { canonicalContactKey: authorContext.canonicalContactKey } : {}),
    conversationScope,
  };
}

export interface StaleSessionWindowHealPort {
  reconcileSessionChannelFromDisk: (
    channelId: string,
  ) => Promise<{ maxEntryId: number; lastMessageEntryId: number | null } | null>;
}

/**
 * Detect-and-heal guard for stale captured session windows
 * (psfn-framework-hgw3.1). The turn just recorded session entry
 * `currentSessionEntryId`, so a fresh store read MUST see that id in the raw
 * capture window; a lower `storeWindowMaxEntryId` means the store served a
 * stale in-memory cache and the window is missing the latest turn(s) —
 * including the previous assistant reply, which makes the model regenerate it.
 * Heals by forcing a disk reconcile and recapturing ONCE.
 *
 * OPERATOR DECISION: this guard must NEVER block, abort, or suppress the
 * reply. After the single heal attempt the turn proceeds with whatever
 * context it has — a duplicate reply is better than no reply — so heal
 * failures are logged and telemetered, never rethrown.
 */
export async function healStaleCapturedSessionWindow(input: {
  snapshot: TurnSessionContextSnapshot;
  currentSessionEntryId: number | null;
  channelId: string;
  turnId: TurnID;
  requestId: string;
  sessionManager: StaleSessionWindowHealPort;
  recapture: () => Promise<TurnSessionContextSnapshot>;
  emitTelemetry: (event: string, payload: Record<string, unknown>) => void;
}): Promise<TurnSessionContextSnapshot> {
  const { snapshot, currentSessionEntryId } = input;
  if (currentSessionEntryId === null) return snapshot;
  const staleWindowMaxEntryId = snapshot.storeWindowMaxEntryId ?? null;
  if (staleWindowMaxEntryId !== null && staleWindowMaxEntryId >= currentSessionEntryId) {
    return snapshot;
  }
  try {
    const reconciled = await input.sessionManager.reconcileSessionChannelFromDisk(input.channelId);
    const recaptured = await input.recapture();
    const recapturedWindowMaxEntryId = recaptured.storeWindowMaxEntryId ?? null;
    const healed = recapturedWindowMaxEntryId !== null
      && recapturedWindowMaxEntryId >= currentSessionEntryId;
    log.warn('Captured session window was stale; reconciled channel from disk and recaptured once', {
      channelId: input.channelId,
      turnId: input.turnId,
      requestId: input.requestId,
      expectedMinEntryId: currentSessionEntryId,
      staleWindowMaxEntryId,
      reconciledMaxEntryId: reconciled?.maxEntryId ?? null,
      recapturedWindowMaxEntryId,
      healed,
    });
    input.emitTelemetry('session.context.stale_window_heal', {
      channelId: input.channelId,
      turnId: input.turnId,
      requestId: input.requestId,
      expectedMinEntryId: currentSessionEntryId,
      staleWindowMaxEntryId,
      reconciledMaxEntryId: reconciled?.maxEntryId ?? null,
      recapturedWindowMaxEntryId,
      healed,
      timestamp: Date.now(),
    });
    return recaptured;
  } catch (error) {
    const errorText = toErrorMessage(error);
    log.warn('Stale session window heal failed; proceeding with the originally captured context', {
      channelId: input.channelId,
      turnId: input.turnId,
      requestId: input.requestId,
      expectedMinEntryId: currentSessionEntryId,
      staleWindowMaxEntryId,
      error: errorText,
    });
    input.emitTelemetry('session.context.stale_window_heal_failed', {
      channelId: input.channelId,
      turnId: input.turnId,
      requestId: input.requestId,
      expectedMinEntryId: currentSessionEntryId,
      staleWindowMaxEntryId,
      error: errorText,
      timestamp: Date.now(),
    });
    return snapshot;
  }
}

export async function computePreTurnState(input: {
  runtime: TurnExecutionRuntime;
  message: SubstrateMessage;
  turnSessionIdentity: TurnSessionIdentity;
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
  currentSessionEntryId: number | null;
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
    turnSessionIdentity,
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
    currentSessionEntryId,
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
  const captureSessionContext = (): Promise<TurnSessionContextSnapshot> => (
    runtime.sessionManager.captureTurnSessionContext({
      channelId: turnSessionIdentity.logicalSessionId,
      userId: input.continuitySubjectKey,
      channelMeta,
      continuityFallbackUserIds: authorContext.continuityFallbackKeys,
      turnBudgetCharacteristics,
      ...(currentSessionEntryId !== null ? { excludeSessionEntryId: currentSessionEntryId } : {}),
    })
  );
  const sessionContextSnapshot = await healStaleCapturedSessionWindow({
    snapshot: await captureSessionContext(),
    currentSessionEntryId,
    channelId: turnSessionIdentity.logicalSessionId,
    turnId,
    requestId,
    sessionManager: runtime.sessionManager,
    recapture: captureSessionContext,
    emitTelemetry: (event, payload) => runtime.emitTelemetry(event, payload),
  });
  const memoryRetrievalContextText = buildMemoryRetrievalContextText(message, sessionContextSnapshot);
  const sessionChannelId = turnSessionIdentity.logicalSessionId;
  const companionId = activeMemorySurface?.createTurnRetrievalQueryEmbedding
    ? resolveCompanionIdFromConfig(runtime.config)
    : undefined;
  const retrievalQueryEmbedding = activeMemorySurface?.createTurnRetrievalQueryEmbedding?.({
    turnId,
    requestId,
    companionId: companionId!,
    channelId: message.channelId,
    ...(authorContext.canonicalContactKey
      ? { canonicalContactId: authorContext.canonicalContactKey }
      : {}),
    queryText: memoryRetrievalContextText,
  });
  const selfCreationCallerContext: RetrievalCallerContext | undefined =
    input.viewerRequestContext.requestAudience === 'self'
      ? {
          accessScope: 'companion_self_creation',
          ...(temporalRetrievalMode ? { retrievalMode: temporalRetrievalMode } : {}),
        }
      : undefined;
  const effectiveRetrievalCallerContext = selfCreationCallerContext ?? temporalRetrievalCallerContext;
  const activeMemoryRequest = {
    contextText: memoryRetrievalContextText,
    channelId: message.channelId,
    sessionChannelId,
    ...(sessionContextSnapshot.rolledOutSessionBoundary
      ? { rolledOutSessionBoundary: sessionContextSnapshot.rolledOutSessionBoundary }
      : {}),
    trustLevel,
    channelMeta,
    conversationScope,
    turnBudgetCharacteristics,
    ...(retrievalQueryEmbedding && companionId
      ? { turnId, requestId, companionId, retrievalQueryEmbedding }
      : {}),
    ...(authorContext.canonicalContactKey ? { canonicalContactId: authorContext.canonicalContactKey } : {}),
    ...(focusMemoryScopeQuery ? { scopeQuery: focusMemoryScopeQuery } : {}),
    ...(effectiveRetrievalCallerContext ? { callerContext: effectiveRetrievalCallerContext } : {}),
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
    const refresh = (): Promise<ActiveMemoryContextSnapshot | null> => (
      refreshActiveMemoryContext(activeMemoryRequest)
    );
    const refreshPromise = selfCreationCallerContext
      ? runWithRequestContext({
          ...turnCorrelationBase,
          channelId: message.channelId,
          callType: 'background',
          originType: 'background',
          originStage: COMPANION_SELF_CREATION_RETRIEVAL_PURPOSE,
          purpose: COMPANION_SELF_CREATION_RETRIEVAL_PURPOSE,
          requesterProvenance: 'self_directed',
          requestAudience: 'self',
        }, refresh)
      : refresh();
    void refreshPromise.catch((error: unknown) => {
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
        routingSource: resolveObserverEvalRoutingSource(message),
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
  // W5b: resolve the companion's current site from the situated place seam so
  // wiki retrieval can add its shared-world scope. The fallback keeps a
  // placeless turn on the same site the situated block foregrounds (mindspace
  // twin, active emanation, or a deliberate virtual `move` — vinz.29/vinz.26)
  // — the shared-scope swap follows the foregrounded place with zero drift.
  // Only meaningful under multi-companion; `resolveWikiRetrievalPlan` ignores
  // it when the flag is off.
  const currentSiteId = runtime.config.multiCompanion === true
    ? resolveSituatedSiteId(
      message,
      runtime.placesRegistry,
      runtime.resolveSituatedFallbackPlaceId?.(message),
    )
    : undefined;
  // mmo9.7.4: wiki retrieval mirrors active-memory — the turn reads a
  // synchronous last-good cached snapshot and schedules an off-path refresh.
  // It NEVER awaits embed+search on the foreground path. Cold/in-flight/failed
  // state is explicit via a typed `wiki.retrieval.turn_degraded` event and the
  // turn proceeds on last-good (or empty, preserving the fail-closed behavior).
  const wikiRetrieval = runtime.wikiRetrieval;
  const wikiRequest: WikiRetrievalRequest | null = wikiRetrieval && !bypassMemoryForVisionTurn
    ? {
      channelId: message.channelId,
      queryText: memoryRetrievalContextText,
      isDirectMessage: channelMeta.isDirectMessage,
      focusActive: focusMemoryScopeQuery != null,
      ...(retrievalQueryEmbedding && companionId
        ? {
          turnId,
          requestId,
          companionId,
          ...(authorContext.canonicalContactKey
            ? { canonicalContactId: authorContext.canonicalContactKey }
            : {}),
          retrievalQueryEmbedding,
        }
        : {}),
      ...(currentSiteId ? { currentSiteId } : {}),
      correlation: turnCorrelationBase,
    }
    : null;
  const wikiContext = wikiRetrieval && wikiRequest
    ? wikiRetrieval.getWikiContextBlock(wikiRequest)
    : null;
  const wikiDegradedReason = wikiRetrieval && wikiRequest
    ? resolveWikiTurnDegradedReason(wikiContext)
    : null;
  if (wikiDegradedReason) {
    void runtime.eventBus.emit('wiki.retrieval.turn_degraded', {
      channelId: message.channelId,
      key: wikiContext?.key ?? 'unresolved',
      reason: wikiDegradedReason,
      refreshStatus: wikiContext?.refreshStatus === 'degraded'
        || wikiContext?.refreshStatus === 'refreshing'
        ? wikiContext.refreshStatus
        : null,
      turnId,
      requestId,
      ...(wikiContext?.lastRefreshError ? { lastRefreshError: wikiContext.lastRefreshError } : {}),
      timestamp: Date.now(),
    }).catch((emitError: unknown) => {
      log.debug('Failed to emit wiki turn degradation event', {
        channelId: message.channelId,
        turnId,
        requestId,
        error: toErrorMessage(emitError),
      });
    });
  }
  if (wikiRetrieval && wikiRequest) {
    void wikiRetrieval.refreshWikiContextBlock(wikiRequest).catch((error: unknown) => {
      log.error('Wiki context refresh failed after scheduling', {
        channelId: message.channelId,
        turnId,
        requestId,
        error: toErrorMessage(error),
      });
    });
  }
  const wikiContextBlock = wikiContext?.block ?? '';
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
    artifactSensitivitySources: activeMemoryContext?.artifactSensitivitySources?.map(source => ({ ...source })) ?? [],
    ...(activeMemoryContext?.manifestSeed ? { memoryManifestSeed: activeMemoryContext.manifestSeed } : {}),
    wikiContextBlock,
    scratchpadBlock,
  };
}
