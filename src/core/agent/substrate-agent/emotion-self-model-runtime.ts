import { EmotionAppraisal, type EmotionAppraisalEntry } from '../../emotion/appraisal.js';
import type { EmotionObserver, EmotionObserverResult } from '../../emotion/observer.js';
import { EmotionState, type EmotionObservation, type EmotionStateSnapshot, type VADVector } from '../../emotion/state.js';
import { parseSessionEmotionState } from '../../emotion/session-metadata.js';
import {
  applyCarryOverToSnapshot,
  blendGlobalMoodBaseline,
  carryOverModifierIsSpent,
  decayCarryOverModifier,
  deriveCarryOverModifier,
  isDmContactGroupMember,
  neutralVad,
  type EmotionCarryOverModifier,
} from '../../emotion/scoped-emotion.js';
import {
  createDefaultEmotionScopingSettings,
  type EmotionScopingSettings,
} from '../../../system/config/emotion-scoping-config.js';
import {
  cloneParticipantTrend,
  createParticipantTrend,
  maintainRoomTrends,
  participantMovementIsMeaningful,
  updateParticipantTrend,
  type ParticipantEmotionTrend,
} from '../../emotion/participant-trends.js';
import {
  fromPersistedParticipantTrend,
  toPersistedParticipantTrend,
  type ParticipantTrendStorePort,
} from '../../emotion/participant-trend-persistence.js';
import type { ActiveConcern } from '../../intention/concerns.js';
import type { ActiveConcernContextProvider } from '../../intention/concern-store-port.js';
import {
  filterPendingFollowUpsForActiveChannel,
  type PendingFollowUp,
  type PendingFollowUpContextProvider,
} from '../../intention/pending-follow-ups.js';
import type { ContactStorePort } from '../../contacts/contact-store-port.js';
import type { EmotionalSnapshot } from '../../contacts/store/emotional-baseline.js';
import type { SessionManager } from '../../session/manager.js';
import type { ConversationScope } from '../../session/conversation-scope.js';
import { isIntentionAppraisalArtifact } from '../../session/entry-attribution.js';
import { MetacognitiveMonitor, type MetacognitiveFlag } from '../../self-model/metacognition.js';
import {
  INTERNAL_STATE_NEUTRAL_EMOTION,
  InternalStateComputer,
  type InternalState,
} from '../../self-model/state.js';
import type { SubstrateMessage, TurnID } from '../../../shared/contracts/runtime.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { LLMProviderPort } from '../contracts.js';
import type { DeterministicGateEvent } from '../../../shared/event-bus.js';

const TOP_EMOTION_COUNT = 3;
const MIN_TOP_EMOTION_SCORE = 0.05;

interface EmotionSelfModelRuntimeLogger {
  debug: (message: string, payload: Record<string, unknown>) => void;
}

export interface EmotionSelfModelRuntimeWiring {
  state?: EmotionState;
  observer?: EmotionObserver;
  appraisal?: EmotionAppraisal;
  requireWiring?: boolean;
}

/** One scope's transient emotion slot (bead E1.5). */
interface ScopedEmotionEntry {
  state: EmotionState;
  updatedAtMs: number | null;
}

export interface EmotionSelfModelRuntimeOptions {
  sessionManager: SessionManager;
  llmProvider: LLMProviderPort;
  emotionRuntime?: EmotionSelfModelRuntimeWiring;
  /**
   * E1.5 scoped-emotion config (owner file `emotionScoping`). When omitted,
   * built-in defaults are used so callers that do not thread config (tests,
   * heartbeat) keep working; production wires it from runtime config.
   */
  emotionScopingConfig?: EmotionScopingSettings;
  /**
   * E6.3 per-participant trend store (Postgres in production). Optional so
   * single-scope callers and tests can run without persistence; when omitted,
   * trends accumulate in-memory only for the process lifetime.
   */
  participantTrendStore?: ParticipantTrendStorePort | null;
  getActiveConcernProvider: () => ActiveConcernContextProvider | null;
  getPendingFollowUpProvider: () => PendingFollowUpContextProvider | null;
  getContactStore: () => ContactStorePort | null;
  getSelfModelRuntimeRequired: () => boolean;
  logger: EmotionSelfModelRuntimeLogger;
  /**
   * Typed emotion-appraisal gate telemetry sink (jpvd.4). Forwarded to the
   * internally-constructed EmotionAppraisal so its periodic/vad-shift decision
   * surfaces on the Garden subsystem-health lane. Optional: callers that do not
   * thread it (tests) keep working with no emission.
   */
  onEmotionAppraisalGateEvent?: (event: DeterministicGateEvent) => void;
}

export class EmotionSelfModelRuntime {
  private emotionState: EmotionState | null = null;
  private emotionObserver: EmotionObserver | null = null;
  private emotionAppraisal: EmotionAppraisal | null = null;
  private emotionRuntimeRequired = false;
  private emotionStateUpdatedAtMs: number | null = null;
  private readonly internalStateComputer = new InternalStateComputer();
  private readonly metacognitiveMonitor = new MetacognitiveMonitor();

  // ── E1.5 scoped emotion state ──
  // Per-scope transient EmotionState keyed by ConversationScope.key
  // ('dm:<contactId>' | 'room:<channelId>'), replacing the pre-E1.5 single
  // channel-keyed slot. The companion-global mood baseline is a SEPARATE layer
  // that scope moods modulate (EMA) and that seeds fresh scopes; "her mood"
  // therefore stays a single coherent thing rather than fragmenting per scope.
  private readonly scopedStates = new Map<string, ScopedEmotionEntry>();
  private globalMoodBaseline: VADVector = neutralVad();
  private globalBaselineSeeded = false;
  // Directional carry-over modifiers keyed by the receiving DM scope key.
  private readonly carryOverModifiers = new Map<string, EmotionCarryOverModifier>();
  // The scope processed by the most recent observation (drives switch detection).
  private lastObservedScope: ConversationScope | null = null;
  // Absorbs the wired EmotionState into the first scope so single-scope callers
  // and tests keep using the instance they provided.
  private wiredStateAdopted = false;
  private readonly emotionScopingConfig: EmotionScopingSettings;

  // ── E6.3 per-participant trend lines ──
  // Per room ('room:<channelId>') → per participant (canonical contact key,
  // else authorId) → slow EMA trend fed ONLY by that participant's own
  // messages. Bots/companions are ordinary contacts here. Bounded by config
  // (cap + stale eviction). Hydrated lazily from the trend store per room.
  private readonly roomTrends = new Map<string, Map<string, ParticipantEmotionTrend>>();
  private readonly roomTrendsLoaded = new Set<string>();
  private readonly participantTrendStore: ParticipantTrendStorePort | null;

  private readonly sessionManager: SessionManager;
  private readonly getActiveConcernProvider: () => ActiveConcernContextProvider | null;
  private readonly getPendingFollowUpProvider: () => PendingFollowUpContextProvider | null;
  private readonly getContactStore: () => ContactStorePort | null;
  private readonly getSelfModelRuntimeRequired: () => boolean;
  private readonly logger: EmotionSelfModelRuntimeLogger;

  constructor(options: EmotionSelfModelRuntimeOptions) {
    this.sessionManager = options.sessionManager;
    this.getActiveConcernProvider = options.getActiveConcernProvider;
    this.getPendingFollowUpProvider = options.getPendingFollowUpProvider;
    this.getContactStore = options.getContactStore;
    this.getSelfModelRuntimeRequired = options.getSelfModelRuntimeRequired;
    this.logger = options.logger;
    this.emotionScopingConfig = options.emotionScopingConfig
      ?? createDefaultEmotionScopingSettings();
    this.participantTrendStore = options.participantTrendStore ?? null;

    this.emotionState = options.emotionRuntime?.state ?? null;
    this.emotionObserver = options.emotionRuntime?.observer ?? null;
    this.emotionAppraisal = options.emotionRuntime?.appraisal
      ?? ((this.emotionState && this.emotionObserver)
        ? new EmotionAppraisal({
          llmProvider: options.llmProvider,
          ...(options.onEmotionAppraisalGateEvent
            ? { onGateEvent: options.onEmotionAppraisalGateEvent }
            : {}),
        })
        : null);
    this.emotionRuntimeRequired = options.emotionRuntime?.requireWiring ?? false;
  }

  assertEmotionRuntimeConfigured(): void {
    const partialWiring = (!!this.emotionState && !this.emotionObserver)
      || (!this.emotionState && !!this.emotionObserver);
    if (partialWiring) {
      throw new Error('Emotion runtime wiring must provide both EmotionState and EmotionObserver');
    }
    if (this.emotionAppraisal && (!this.emotionState || !this.emotionObserver)) {
      throw new Error('Emotion appraisal wiring requires EmotionState and EmotionObserver');
    }
    if (!this.emotionRuntimeRequired) return;
    if (!this.emotionState || !this.emotionObserver) {
      throw new Error('Emotion runtime wiring is required but EmotionState/EmotionObserver are not configured');
    }
  }

  assertSelfModelRuntimeConfigured(): void {
    if (!this.getSelfModelRuntimeRequired()) {
      return;
    }

    const activeConcernProvider = this.getActiveConcernProvider();
    if (!activeConcernProvider) {
      throw new Error('Self-model runtime wiring is required but ActiveConcernProvider is not configured');
    }
    const pendingFollowUpProvider = this.getPendingFollowUpProvider();
    if (!pendingFollowUpProvider) {
      throw new Error('Self-model runtime wiring is required but PendingFollowUpProvider is not configured');
    }

    const contactStore = this.getContactStore();
    if (!contactStore) {
      throw new Error('Self-model runtime wiring is required but ContactStorePort is not configured');
    }

    const manager = this.sessionManager as SessionManager & {
      getRecentMessages?: (channelId: string, limit?: number) => Array<unknown>;
    };
    if (typeof manager.getRecentMessages !== 'function') {
      throw new Error('Self-model runtime wiring requires SessionManager.getRecentMessages');
    }
  }

  async observeEmotionState(
    text: string,
    sessionChannelId: string,
    // E1.5: the turn ConversationScope keys the per-scope emotion slot. When
    // omitted (heartbeat, legacy callers) the channel id is used as the key,
    // preserving pre-E1.5 single-channel behavior.
    conversationScope?: ConversationScope,
    // E6.3: identity of the author of THIS message (canonical contact key,
    // else authorId). Drives the per-participant trend line in a group room —
    // only this participant's own trend moves; idle participants never appear.
    authorParticipantKey?: string,
  ): Promise<EmotionStateSnapshot | null> {
    this.assertEmotionRuntimeConfigured();
    if (!this.emotionState || !this.emotionObserver) {
      return null;
    }
    const scopeKey = conversationScope?.key ?? sessionChannelId;
    const entry = this.getOrHydrateScopedState(scopeKey, sessionChannelId);

    // Arm the directional carry-over modifier BEFORE observing: it reads the
    // (unchanged) previous group scope's transient VAD, so ordering is safe.
    await this.maybeArmCarryOverModifier(conversationScope);

    const now = Date.now();
    const elapsedSeconds = entry.updatedAtMs === null
      ? 0
      : Math.max(0, (now - entry.updatedAtMs) / 1000);
    const rawObservation = await this.emotionObserver.observe(
      text,
      elapsedSeconds,
    ) as EmotionObserverResult | EmotionObservation;
    const observation = this.normalizeEmotionObservation(rawObservation);
    const snapshot = entry.state.update(observation, elapsedSeconds);
    entry.updatedAtMs = now;
    this.emotionStateUpdatedAtMs = now;

    // Each scope mood modulates the single companion-global baseline (EMA);
    // "her mood" stays coherent instead of fragmenting per scope.
    this.updateGlobalMoodBaseline(snapshot.mood);

    // E6.3: fold THIS participant's own message into their room trend line.
    // Reuses the observation already computed above — zero extra classifier /
    // LLM calls in the accumulation path.
    await this.accumulateParticipantTrend(conversationScope, authorParticipantKey, observation, now);

    // Surface the decayed carry-over on top of the stored transient state. The
    // stored EmotionState is NOT mutated by the modifier.
    const effective = this.applyActiveCarryOver(scopeKey, snapshot, now);

    if (conversationScope) {
      this.lastObservedScope = conversationScope;
    }
    return effective;
  }

  async computeInternalStateForTurn(input: {
    message: SubstrateMessage;
    responseText: string;
    trustLevel: TrustLevel;
    canonicalContactKey?: string;
    emotionSnapshot: EmotionStateSnapshot | null;
    toolCallCount: number;
    sessionChannelId: string;
    // E1.5: turn ConversationScope, plumbed as an available input. Emotion
    // scoping will use it (dm vs group binding of relational state); this
    // bead does not change emotion behavior.
    conversationScope?: ConversationScope;
  }): Promise<InternalState> {
    const activeConcerns = this.resolveInternalStateActiveConcerns(input.canonicalContactKey);
    const pendingFollowUps = this.resolveInternalStatePendingFollowUps(
      input.canonicalContactKey,
      input.sessionChannelId,
    );
    const [contactEmotionalSnapshot, lastSeenDeltaSeconds] = await Promise.all([
      this.resolveContactEmotionalSnapshot(input.canonicalContactKey),
      this.resolveContactLastSeenDeltaSeconds(
        input.canonicalContactKey,
        Date.now(),
      ),
    ]);
    const recentTurnCount = this.resolveRecentTurnCount(input.sessionChannelId);
    const emotionState = input.emotionSnapshot ?? INTERNAL_STATE_NEUTRAL_EMOTION;
    const emotionObservedAtMs = input.emotionSnapshot ? this.emotionStateUpdatedAtMs : null;

    return this.internalStateComputer.computeState({
      emotionState,
      emotionTelemetry: input.emotionSnapshot
        ? {
          source: 'classifier_inferred',
          observedAtMs: emotionObservedAtMs,
          nowMs: Date.now(),
          provenance: [{
            source: 'classifier_inferred',
            ...(emotionObservedAtMs !== null ? { observedAtMs: emotionObservedAtMs } : {}),
            modality: 'text',
            provenanceRef: `emotion-state:${input.sessionChannelId}`,
          }],
        }
        : {
          source: 'missing',
          observedAtMs: null,
          nowMs: Date.now(),
          provenance: [{
            source: 'missing',
            modality: 'unknown',
            provenanceRef: `emotion-state:${input.sessionChannelId}:missing`,
          }],
        },
      activeConcerns,
      pendingFollowUps,
      trustLevel: input.trustLevel,
      ...(input.canonicalContactKey ? { contactId: input.canonicalContactKey } : {}),
      contactEmotionalSnapshot,
      sessionMetrics: {
        userMessageText: input.message.content,
        responseText: input.responseText,
        toolCallCount: input.toolCallCount,
        recentTurnCount,
        ...(lastSeenDeltaSeconds === null ? {} : { lastSeenDeltaSeconds }),
      },
    });
  }

  computeMetacognitiveFlagsForTurn(input: {
    internalState: InternalState;
    responseText: string;
    toolCallCount: number;
    sessionChannelId: string;
    retrievalProvenanceRefs: readonly string[];
  }): MetacognitiveFlag[] {
    const recentResponses = this.resolveRecentAssistantResponses(input.sessionChannelId);
    return this.metacognitiveMonitor.detectFlags({
      internalState: input.internalState,
      recentResponses,
      latestResponse: input.responseText,
      toolCallCount: input.toolCallCount,
      contradictoryMemorySignalCount: this.countContradictoryMemorySignals(input.retrievalProvenanceRefs),
      supportingMemoryCount: this.countSupportingMemoryEvidenceRefs(input.retrievalProvenanceRefs),
    });
  }

  formatTopEmotions(discrete: Record<string, number>): string {
    const top = Object.entries(discrete)
      .map(([label, score]) => [label.trim().toLowerCase(), score] as const)
      .filter(([label, score]) => label.length > 0 && Number.isFinite(score) && score >= MIN_TOP_EMOTION_SCORE)
      .sort((left, right) => {
        if (right[1] !== left[1]) {
          return right[1] - left[1];
        }
        return left[0].localeCompare(right[0]);
      })
      .slice(0, TOP_EMOTION_COUNT)
      .map(([label, score]) => `${label}=${score.toFixed(3)}`);
    if (top.length === 0) {
      return 'none';
    }
    return top.join(', ');
  }

  getEmotionAppraisalChain(sessionChannelId: string): EmotionAppraisalEntry[] {
    if (!this.emotionAppraisal) return [];
    return this.emotionAppraisal.getChain(sessionChannelId);
  }

  async triggerEmotionAppraisal(params: {
    sessionChannelId: string;
    turnId: TurnID;
    internalState: InternalState;
    templateVariables: Record<string, string> | undefined;
    // E1.5: turn ConversationScope, plumbed as an available input for the
    // emotion scoping bead. Appraisal behavior is unchanged here.
    conversationScope?: ConversationScope;
  }): Promise<void> {
    if (!this.emotionAppraisal) return;

    const manager = this.sessionManager as SessionManager & {
      getRecentMessages?: (channelId: string, limit?: number) => Array<{
        role: 'user' | 'assistant' | 'system' | 'tool';
        content: string;
        timestamp: number;
      }>;
    };
    if (typeof manager.getRecentMessages !== 'function') {
      if (this.emotionRuntimeRequired) {
        throw new Error('Emotion appraisal runtime requires SessionManager.getRecentMessages');
      }
      return;
    }

    const recentMessages = manager.getRecentMessages(params.sessionChannelId, 10)
      .filter(entry => !isIntentionAppraisalArtifact(entry))
      .map((entry) => ({
        role: entry.role,
        content: entry.content,
        timestamp: entry.timestamp,
      }));

    const result = await this.emotionAppraisal.maybeAppraise({
      sessionId: params.sessionChannelId,
      turnId: params.turnId,
      internalState: params.internalState,
      recentMessages,
      personalityTraits: this.resolveEmotionPersonalityTraits(params.templateVariables),
    });
    if (result.appraised) {
      this.logger.debug('Post-turn emotion appraisal completed', {
        sessionChannelId: params.sessionChannelId,
        trigger: result.trigger,
        delta: result.delta,
      });
    }
  }

  /**
   * Resolve the per-scope emotion slot, hydrating it from the channel's session
   * metadata (restart continuity, unchanged mechanism) on first use. A fresh
   * scope with no persisted snapshot is seeded from the companion-global mood
   * baseline when configured, so it opens in "her mood" rather than at neutral.
   */
  private getOrHydrateScopedState(
    scopeKey: string,
    sessionChannelId: string,
  ): ScopedEmotionEntry {
    const existing = this.scopedStates.get(scopeKey);
    if (existing) return existing;

    const manager = this.sessionManager as SessionManager & {
      getRecentMessages?: (channelId: string, limit?: number) => Array<{
        metadata?: string;
        timestamp: number;
      }>;
    };

    if (typeof manager.getRecentMessages !== 'function') {
      if (this.emotionRuntimeRequired) {
        throw new Error('Emotion runtime wiring requires SessionManager.getRecentMessages for metadata recovery');
      }
      return this.registerScopedState(scopeKey, this.createFreshScopedState(), null);
    }

    const recentEntries = manager.getRecentMessages(sessionChannelId, 64)
      .filter(entry => !isIntentionAppraisalArtifact(entry));
    for (let index = recentEntries.length - 1; index >= 0; index -= 1) {
      const entry = recentEntries[index];
      if (!entry.metadata || !entry.metadata.includes('"emotionState"')) {
        continue;
      }
      let snapshot: EmotionStateSnapshot | null;
      try {
        snapshot = parseSessionEmotionState(entry.metadata);
      } catch (error) {
        throw new Error(
          `Failed to parse emotion metadata for session "${sessionChannelId}": ${toErrorMessage(error)}`,
        );
      }
      if (!snapshot) continue;
      // Restart continuity: the first restored scope also re-seeds the global
      // mood baseline so "her mood" survives the restart, not just the scope.
      this.seedGlobalBaselineFromMood(snapshot.mood);
      return this.registerScopedState(
        scopeKey,
        EmotionState.deserialize(snapshot),
        entry.timestamp,
      );
    }

    return this.registerScopedState(scopeKey, this.createFreshScopedState(), null);
  }

  private registerScopedState(
    scopeKey: string,
    state: EmotionState,
    updatedAtMs: number | null,
  ): ScopedEmotionEntry {
    const entry: ScopedEmotionEntry = { state, updatedAtMs };
    this.scopedStates.set(scopeKey, entry);
    return entry;
  }

  /**
   * Build a fresh transient state for a scope. The first fresh scope adopts the
   * wired EmotionState instance (single-scope / test parity); later scopes get
   * their own instance, seeded from the global mood baseline when configured.
   */
  private createFreshScopedState(): EmotionState {
    if (!this.wiredStateAdopted && this.emotionState) {
      this.wiredStateAdopted = true;
      return this.emotionState;
    }
    if (this.emotionScopingConfig.baseline.seedNewScopesFromBaseline && this.globalBaselineSeeded) {
      return new EmotionState({}, { mood: { ...this.globalMoodBaseline } });
    }
    return new EmotionState();
  }

  private seedGlobalBaselineFromMood(mood: VADVector): void {
    if (this.globalBaselineSeeded) return;
    this.globalMoodBaseline = { ...mood };
    this.globalBaselineSeeded = true;
  }

  private updateGlobalMoodBaseline(mood: VADVector): void {
    if (!this.globalBaselineSeeded) {
      this.seedGlobalBaselineFromMood(mood);
      return;
    }
    this.globalMoodBaseline = blendGlobalMoodBaseline(
      this.globalMoodBaseline,
      mood,
      this.emotionScopingConfig.baseline.moodBlendAlpha,
    );
  }

  /** Current companion-global mood baseline (test/telemetry surface). */
  getGlobalMoodBaseline(): VADVector {
    return { ...this.globalMoodBaseline };
  }

  /**
   * Arm the directional carry-over modifier for a group→member-DM switch.
   * Every non-qualifying transition (DM→group, group→group, DM→DM, non-member
   * DM) leaves the receiving scope with no modifier.
   */
  private async maybeArmCarryOverModifier(
    currentScope: ConversationScope | undefined,
  ): Promise<void> {
    if (!currentScope || currentScope.kind !== 'dm') return;
    const previousScope = this.lastObservedScope;
    if (!previousScope || previousScope.kind !== 'group') return;

    const groupEntry = this.scopedStates.get(previousScope.key);
    if (!groupEntry) return;

    const dmContactIsGroupMember = await this.resolveDmGroupMembership(
      currentScope.contact.contactId,
      previousScope,
    );

    // E6.3 consumer: when enabled, source the carry-over from the DM contact's
    // OWN trend in that room (weighted by their own interactions) rather than
    // the room aggregate. Default flag off ⇒ room aggregate ⇒ E1.5 behavior.
    const previousScopeVad = await this.resolveCarryOverSourceVad(
      previousScope.key,
      currentScope.contact.contactId,
      groupEntry.state.getState().vad,
    );

    const modifier = deriveCarryOverModifier({
      previousScope,
      previousScopeVad,
      currentScope,
      dmContactIsGroupMember,
      nowMs: Date.now(),
      config: this.emotionScopingConfig.carryOver,
    });
    if (modifier) {
      this.carryOverModifiers.set(currentScope.key, modifier);
      this.logger.debug('Armed emotion carry-over modifier', {
        fromScope: previousScope.key,
        toScope: currentScope.key,
        vad: modifier.vad,
        halfLifeSeconds: modifier.halfLifeSeconds,
      });
    }
  }

  private async resolveDmGroupMembership(
    dmContactId: string,
    groupScope: import('../../session/conversation-scope.js').GroupConversationScope,
  ): Promise<boolean> {
    let contactRoomIds: Set<string> | undefined;
    const contactStore = this.getContactStore();
    if (contactStore) {
      const contact = await contactStore.getById(dmContactId);
      const channels = contact?.conversationChannels ?? [];
      if (channels.length > 0) {
        contactRoomIds = new Set<string>();
        for (const conversation of channels) {
          const roomId = conversation.channelId.trim();
          if (roomId) contactRoomIds.add(roomId);
        }
      }
    }
    return isDmContactGroupMember({
      dmContactId,
      groupScope,
      ...(contactRoomIds ? { contactRoomIds } : {}),
    });
  }

  private applyActiveCarryOver(
    scopeKey: string,
    snapshot: EmotionStateSnapshot,
    nowMs: number,
  ): EmotionStateSnapshot {
    const modifier = this.carryOverModifiers.get(scopeKey);
    if (!modifier) return snapshot;
    if (carryOverModifierIsSpent(modifier, nowMs, this.emotionScopingConfig.carryOver.minEffectThreshold)) {
      this.carryOverModifiers.delete(scopeKey);
      return snapshot;
    }
    return applyCarryOverToSnapshot(snapshot, decayCarryOverModifier(modifier, nowMs));
  }

  // ── E6.3 per-participant trend accumulation & consumption ──

  /**
   * Carry-over source VAD. With the behavior flag off (default) this is the
   * room aggregate transient VAD — identical to the E1.5 contract. With the
   * flag on, and only when the DM contact has meaningful movement in that room,
   * it is the contact's own trend VAD.
   */
  private async resolveCarryOverSourceVad(
    roomKey: string,
    dmContactId: string,
    aggregateVad: VADVector,
  ): Promise<VADVector> {
    const config = this.emotionScopingConfig.participantTrends;
    if (!config.enabled || !config.carryOverUsesParticipantTrend) return aggregateVad;
    const contactId = dmContactId.trim();
    if (!contactId) return aggregateVad;
    const roomMap = await this.ensureRoomTrendsLoaded(roomKey);
    const trend = roomMap.get(contactId);
    if (!trend) return aggregateVad;
    const meaningful = participantMovementIsMeaningful(trend, {
      minInteractions: config.minInteractionsForMovement,
      minTrendDelta: config.minTrendDelta,
    });
    if (!meaningful) return aggregateVad;
    return { ...trend.vad };
  }

  private async accumulateParticipantTrend(
    conversationScope: ConversationScope | undefined,
    authorParticipantKey: string | undefined,
    observation: EmotionObservation,
    nowMs: number,
  ): Promise<void> {
    const config = this.emotionScopingConfig.participantTrends;
    if (!config.enabled) return;
    if (!conversationScope || conversationScope.kind !== 'group') return;
    const participantKey = authorParticipantKey?.trim();
    if (!participantKey) return;

    const roomKey = conversationScope.key;
    const roomMap = await this.ensureRoomTrendsLoaded(roomKey);

    const previous = roomMap.get(participantKey)
      ?? createParticipantTrend(participantKey, nowMs);
    const updated = updateParticipantTrend(previous, observation, config.emaAlpha, nowMs);
    roomMap.set(participantKey, updated);

    // Enforce cap + stale eviction; delete evicted trends from the store too.
    const { evictedKeys } = maintainRoomTrends(roomMap, {
      maxTrackedParticipants: config.maxTrackedParticipantsPerRoom,
      staleEvictionSeconds: config.staleEvictionSeconds,
    }, nowMs);

    if (this.participantTrendStore) {
      const store = this.participantTrendStore;
      // The just-updated participant may itself have been evicted (cap of 0 is
      // rejected by config, so in practice it survives); only persist if kept.
      if (roomMap.has(participantKey)) {
        await store.saveTrend(toPersistedParticipantTrend(roomKey, updated));
      }
      const evictedToDelete = evictedKeys.filter((key) => key !== participantKey || !roomMap.has(participantKey));
      if (evictedToDelete.length > 0) {
        await store.deleteTrends(roomKey, evictedToDelete);
      }
    }
  }

  private async ensureRoomTrendsLoaded(
    roomKey: string,
  ): Promise<Map<string, ParticipantEmotionTrend>> {
    let roomMap = this.roomTrends.get(roomKey);
    if (!roomMap) {
      roomMap = new Map<string, ParticipantEmotionTrend>();
      this.roomTrends.set(roomKey, roomMap);
    }
    if (this.roomTrendsLoaded.has(roomKey)) return roomMap;
    this.roomTrendsLoaded.add(roomKey);
    if (!this.participantTrendStore) return roomMap;
    const persisted = await this.participantTrendStore.loadRoom(roomKey);
    for (const record of persisted) {
      // In-memory updates within this process take precedence over stale reads.
      if (roomMap.has(record.participantKey)) continue;
      roomMap.set(record.participantKey, fromPersistedParticipantTrend(record));
    }
    return roomMap;
  }

  /** Consumption surface: one participant's trend in a room, cloned. */
  getParticipantTrend(
    roomKey: string,
    participantKey: string,
  ): ParticipantEmotionTrend | null {
    const trend = this.roomTrends.get(roomKey)?.get(participantKey);
    return trend ? cloneParticipantTrend(trend) : null;
  }

  /** Consumption surface: all tracked participant trends in a room, cloned. */
  getRoomParticipantTrends(roomKey: string): ParticipantEmotionTrend[] {
    const roomMap = this.roomTrends.get(roomKey);
    if (!roomMap) return [];
    return [...roomMap.values()].map(cloneParticipantTrend);
  }

  /**
   * Consumption gate: has THIS participant produced enough signal (volume +
   * displacement, both config-owned) to move orientation toward them?
   */
  hasMeaningfulParticipantMovement(roomKey: string, participantKey: string): boolean {
    const trend = this.roomTrends.get(roomKey)?.get(participantKey);
    if (!trend) return false;
    const config = this.emotionScopingConfig.participantTrends;
    return participantMovementIsMeaningful(trend, {
      minInteractions: config.minInteractionsForMovement,
      minTrendDelta: config.minTrendDelta,
    });
  }

  private resolveInternalStateActiveConcerns(canonicalContactKey?: string): ActiveConcern[] {
    const activeConcernProvider = this.getActiveConcernProvider();
    if (!activeConcernProvider) return [];
    const concerns = activeConcernProvider.getActiveConcerns(canonicalContactKey);
    if (!Array.isArray(concerns)) {
      throw new Error('Active concern provider returned an invalid payload for InternalState computation');
    }
    return concerns;
  }

  private resolveInternalStatePendingFollowUps(
    canonicalContactKey?: string,
    sessionChannelId?: string,
  ): PendingFollowUp[] {
    const pendingFollowUpProvider = this.getPendingFollowUpProvider();
    if (!pendingFollowUpProvider) return [];
    const followUps = pendingFollowUpProvider.getPendingFollowUps(canonicalContactKey);
    if (!Array.isArray(followUps)) {
      throw new Error('Pending follow-up provider returned an invalid payload for InternalState computation');
    }
    return filterPendingFollowUpsForActiveChannel(followUps, sessionChannelId);
  }

  private async resolveContactEmotionalSnapshot(canonicalContactKey?: string): Promise<EmotionalSnapshot | null> {
    if (!canonicalContactKey) return null;
    const contactStore = this.getContactStore();
    if (!contactStore) return null;
    return (await contactStore.getEmotionalSnapshot(canonicalContactKey)) ?? null;
  }

  private async resolveContactLastSeenDeltaSeconds(
    canonicalContactKey: string | undefined,
    nowMs: number,
  ): Promise<number | null> {
    if (!canonicalContactKey) return null;
    const contactStore = this.getContactStore();
    if (!contactStore) return null;
    const contact = await contactStore.getById(canonicalContactKey);
    if (!contact?.lastSeen) return null;
    const lastSeenMs = Date.parse(contact.lastSeen);
    if (!Number.isFinite(lastSeenMs)) {
      throw new Error(`Contact "${canonicalContactKey}" has invalid lastSeen timestamp`);
    }
    return Math.max(0, Math.floor((nowMs - lastSeenMs) / 1000));
  }

  private resolveRecentTurnCount(sessionChannelId: string): number {
    const manager = this.sessionManager as SessionManager & {
      getRecentMessages?: (channelId: string, limit?: number) => Array<unknown>;
    };
    if (typeof manager.getRecentMessages !== 'function') {
      return 0;
    }
    const recentMessages = manager.getRecentMessages(sessionChannelId, 12)
      .filter(entry => !isIntentionAppraisalArtifact(entry));
    if (!Array.isArray(recentMessages)) {
      throw new Error('SessionManager.getRecentMessages returned an invalid payload for InternalState computation');
    }
    return recentMessages.length;
  }

  private resolveRecentAssistantResponses(sessionChannelId: string): string[] {
    const manager = this.sessionManager as SessionManager & {
      getRecentMessages?: (channelId: string, limit?: number) => Array<{
        role: 'user' | 'assistant' | 'system' | 'tool';
        content: string;
        timestamp: number;
      }>;
    };
    if (typeof manager.getRecentMessages !== 'function') {
      return [];
    }
    const recentMessages = manager.getRecentMessages(sessionChannelId, 6)
      .filter(entry => !isIntentionAppraisalArtifact(entry));
    if (!Array.isArray(recentMessages)) {
      throw new Error('SessionManager.getRecentMessages returned an invalid payload for metacognitive monitoring');
    }
    const responses: string[] = [];
    for (const entry of recentMessages) {
      if (entry.role !== 'assistant') continue;
      const normalized = entry.content.replace(/\s+/g, ' ').trim();
      if (!normalized) continue;
      responses.push(normalized);
    }
    return responses;
  }

  private countSupportingMemoryEvidenceRefs(retrievalProvenanceRefs: readonly string[]): number {
    let count = 0;
    for (const ref of retrievalProvenanceRefs) {
      if (ref.startsWith('memory:')) {
        count += 1;
      }
    }
    return count;
  }

  private countContradictoryMemorySignals(retrievalProvenanceRefs: readonly string[]): number {
    let count = 0;
    for (const ref of retrievalProvenanceRefs) {
      if (!ref.startsWith('memory:')) continue;
      const lower = ref.toLowerCase();
      if (lower.includes('contradict') || lower.includes('conflict')) {
        count += 1;
      }
    }
    return count;
  }

  private normalizeEmotionObservation(
    rawObservation: unknown,
  ): EmotionObservation {
    if (!rawObservation || typeof rawObservation !== 'object') {
      throw new Error('Emotion observer returned an invalid observation payload');
    }
    if ('observation' in rawObservation) {
      const nested = rawObservation.observation;
      if (!nested || typeof nested !== 'object') {
        throw new Error('Emotion observer returned an invalid nested observation payload');
      }
      return nested;
    }
    return rawObservation;
  }

  private resolveEmotionPersonalityTraits(
    templateVariables: Record<string, string> | undefined,
  ): Record<string, string> {
    if (!templateVariables) return {};
    const traits: Record<string, string> = {};
    for (const [key, rawValue] of Object.entries(templateVariables)) {
      const value = rawValue.replace(/\s+/g, ' ').trim();
      if (!value) continue;
      if (
        key === 'personality'
        || key === 'character.personality'
        || key.startsWith('hexaco.')
        || key.startsWith('hexaco_')
        || key.startsWith('character.hexaco.')
        || key.startsWith('character.hexaco_')
      ) {
        traits[key] = value;
      }
    }
    return traits;
  }
}
