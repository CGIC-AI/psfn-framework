import { EmotionAppraisal, type EmotionAppraisalEntry } from '../../core/emotion/appraisal.js';
import type { EmotionObserver, EmotionObserverResult } from '../../core/emotion/observer.js';
import { EmotionState, type EmotionObservation, type EmotionStateSnapshot } from '../../core/emotion/state.js';
import { parseSessionEmotionState } from '../../core/emotion/session-metadata.js';
import type { ActiveConcern, ActiveConcernContextProvider } from '../../core/intention/concerns.js';
import type { PendingFollowUp, PendingFollowUpContextProvider } from '../../core/intention/pending-follow-ups.js';
import type { ContactStore } from '../../contacts/store.js';
import type { EmotionalSnapshot } from '../../contacts/store/emotional-baseline.js';
import type { Contact } from '../../contacts/types.js';
import type { SessionManager } from '../../session/manager.js';
import { isIntentionAppraisalArtifact } from '../../session/entry-attribution.js';
import { MetacognitiveMonitor, type MetacognitiveFlag } from '../../core/self-model/metacognition.js';
import {
  INTERNAL_STATE_NEUTRAL_EMOTION,
  InternalStateComputer,
  type InternalState,
} from '../../core/self-model/state.js';
import type { SubstrateMessage, TurnID } from '../../shared/contracts/runtime.js';
import type { TrustLevel } from '../../trust/types.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { LLMProvider } from '../contracts.js';

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

export interface EmotionSelfModelRuntimeOptions {
  sessionManager: SessionManager;
  llmProvider: LLMProvider;
  emotionRuntime?: EmotionSelfModelRuntimeWiring;
  getActiveConcernProvider: () => ActiveConcernContextProvider | null;
  getPendingFollowUpProvider: () => PendingFollowUpContextProvider | null;
  getContactStore: () => ContactStore | null;
  getSelfModelRuntimeRequired: () => boolean;
  logger: EmotionSelfModelRuntimeLogger;
}

export class EmotionSelfModelRuntime {
  private emotionState: EmotionState | null = null;
  private emotionObserver: EmotionObserver | null = null;
  private emotionAppraisal: EmotionAppraisal | null = null;
  private emotionRuntimeRequired = false;
  private emotionStateSessionId: string | null = null;
  private emotionStateUpdatedAtMs: number | null = null;
  private readonly internalStateComputer = new InternalStateComputer();
  private readonly metacognitiveMonitor = new MetacognitiveMonitor();

  private readonly sessionManager: SessionManager;
  private readonly getActiveConcernProvider: () => ActiveConcernContextProvider | null;
  private readonly getPendingFollowUpProvider: () => PendingFollowUpContextProvider | null;
  private readonly getContactStore: () => ContactStore | null;
  private readonly getSelfModelRuntimeRequired: () => boolean;
  private readonly logger: EmotionSelfModelRuntimeLogger;

  constructor(options: EmotionSelfModelRuntimeOptions) {
    this.sessionManager = options.sessionManager;
    this.getActiveConcernProvider = options.getActiveConcernProvider;
    this.getPendingFollowUpProvider = options.getPendingFollowUpProvider;
    this.getContactStore = options.getContactStore;
    this.getSelfModelRuntimeRequired = options.getSelfModelRuntimeRequired;
    this.logger = options.logger;

    this.emotionState = options.emotionRuntime?.state ?? null;
    this.emotionObserver = options.emotionRuntime?.observer ?? null;
    this.emotionAppraisal = options.emotionRuntime?.appraisal
      ?? ((this.emotionState && this.emotionObserver)
        ? new EmotionAppraisal({ llmProvider: options.llmProvider })
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
      throw new Error('Self-model runtime wiring is required but ContactStore is not configured');
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
  ): Promise<EmotionStateSnapshot | null> {
    this.assertEmotionRuntimeConfigured();
    if (!this.emotionState || !this.emotionObserver) {
      return null;
    }
    this.hydrateEmotionStateForSession(sessionChannelId);

    const now = Date.now();
    const elapsedSeconds = this.emotionStateUpdatedAtMs === null
      ? 0
      : Math.max(0, (now - this.emotionStateUpdatedAtMs) / 1000);
    const rawObservation = await this.emotionObserver.observe(
      text,
      elapsedSeconds,
    ) as EmotionObserverResult | EmotionObservation;
    const observation = this.normalizeEmotionObservation(rawObservation);
    const snapshot = this.emotionState.update(observation, elapsedSeconds);
    this.emotionStateUpdatedAtMs = now;
    return snapshot;
  }

  computeInternalStateForTurn(input: {
    message: SubstrateMessage;
    responseText: string;
    trustLevel: TrustLevel;
    canonicalContactKey?: string;
    emotionSnapshot: EmotionStateSnapshot | null;
    toolCallCount: number;
    sessionChannelId: string;
  }): InternalState {
    const activeConcerns = this.resolveInternalStateActiveConcerns(input.canonicalContactKey);
    const pendingFollowUps = this.resolveInternalStatePendingFollowUps(input.canonicalContactKey);
    const contactEmotionalSnapshot = this.resolveContactEmotionalSnapshot(input.canonicalContactKey);
    const recentTurnCount = this.resolveRecentTurnCount(input.sessionChannelId);
    const lastSeenDeltaSeconds = this.resolveContactLastSeenDeltaSeconds(
      input.canonicalContactKey,
      Date.now(),
    );
    const emotionState = input.emotionSnapshot ?? INTERNAL_STATE_NEUTRAL_EMOTION;

    return this.internalStateComputer.computeState({
      emotionState,
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

  private hydrateEmotionStateForSession(sessionChannelId: string): void {
    if (!this.emotionState) return;
    if (this.emotionStateSessionId === sessionChannelId) return;

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
      this.emotionState = new EmotionState();
      this.emotionStateSessionId = sessionChannelId;
      this.emotionStateUpdatedAtMs = null;
      return;
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
      this.emotionState = EmotionState.deserialize(snapshot);
      this.emotionStateSessionId = sessionChannelId;
      this.emotionStateUpdatedAtMs = entry.timestamp;
      return;
    }

    this.emotionState = new EmotionState();
    this.emotionStateSessionId = sessionChannelId;
    this.emotionStateUpdatedAtMs = null;
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

  private resolveInternalStatePendingFollowUps(canonicalContactKey?: string): PendingFollowUp[] {
    const pendingFollowUpProvider = this.getPendingFollowUpProvider();
    if (!pendingFollowUpProvider) return [];
    const followUps = pendingFollowUpProvider.getPendingFollowUps(canonicalContactKey);
    if (!Array.isArray(followUps)) {
      throw new Error('Pending follow-up provider returned an invalid payload for InternalState computation');
    }
    return followUps;
  }

  private resolveContactEmotionalSnapshot(canonicalContactKey?: string): EmotionalSnapshot | null {
    if (!canonicalContactKey) return null;
    const contactStore = this.getContactStore();
    if (!contactStore) return null;
    const storeWithEmotion = contactStore as ContactStore & {
      getEmotionalSnapshot?: (id: string) => EmotionalSnapshot | undefined;
    };
    if (typeof storeWithEmotion.getEmotionalSnapshot !== 'function') {
      return null;
    }
    return storeWithEmotion.getEmotionalSnapshot(canonicalContactKey) ?? null;
  }

  private resolveContactLastSeenDeltaSeconds(
    canonicalContactKey: string | undefined,
    nowMs: number,
  ): number | null {
    if (!canonicalContactKey) return null;
    const contactStore = this.getContactStore();
    if (!contactStore) return null;
    const storeWithLookup = contactStore as ContactStore & {
      getById?: (id: string) => Contact | undefined;
    };
    if (typeof storeWithLookup.getById !== 'function') {
      return null;
    }
    const contact = storeWithLookup.getById(canonicalContactKey);
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
