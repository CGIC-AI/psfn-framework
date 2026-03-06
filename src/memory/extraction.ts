import type { EmbeddingService, LLMProvider } from '../agent/contracts.js';
import type { EventBus } from '../event-bus.js';
import type { PromptRegistryStore } from '../identity/prompt-registry.js';
import type { ContactStore } from '../contacts/store.js';
import type { SessionManager } from '../session/manager.js';
import type { SessionStore } from '../session/store.js';
import type { SessionEntry } from '../session/types.js';
import type { SubstrateConfig, TurnID } from '../types.js';
import { createComponentLogger } from '../logger.js';
import { evaluateCompositionalPolicyForChannelId } from '../compositional/policy.js';
import type { MemoryStore } from './store.js';
import type { ExtractedFact } from './types.js';
import { MEMORY_CONFIG } from './types.js';
import { MemoryWriter, type WriteResult } from './writer.js';
import {
  DEFAULT_MAX_WRITES,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MIN_IMPORTANCE,
  DEFAULT_MIN_NOVELTY,
  type AcceptedFactWrite,
  type ExtractionTriggerReason,
  type MemoryExtractorConfig,
  type MemoryExtractorDrainOptions,
  type ProfileSynthesisConfig,
} from './extraction/types.js';
import {
  normalizeMaxWrites,
  resolveGateConfig,
  resolveMaxWrites,
  resolveProfileConfig,
  resolveTelemetryEnabled,
} from './extraction/config.js';
import { runExtractionOrchestration } from './extraction/orchestrator.js';
import { refreshContactProfile as runProfileRefresh } from './extraction/profile-synthesis.js';
import { persistEmotionalStateFromExtraction } from './extraction/emotional.js';
import {
  emitExtractionEnd as emitExtractionEndEvent,
  emitExtractionStart as emitExtractionStartEvent,
  evaluateExtractionTrigger,
  recordExtractionMarker as persistExtractionMarker,
  resetLastExtractionCount,
  resolveCoveredUpToMessageId as resolveCoveredMarker,
  scheduleProfileRefresh,
} from './extraction/runtime-helpers.js';
import {
  computeNoveltyScore,
  computeProfileNovelty,
  deriveEmotionalSignal,
  evaluateFactAcceptance,
} from './extraction/signals.js';
import { parseFactsXml } from './extraction/parser.js';

const log = createComponentLogger('Extraction');

export class MemoryExtractor {
  private llmClient: LLMProvider;
  private sessionManager: SessionManager;
  private memoryStore: MemoryStore;
  private writer: MemoryWriter;
  private eventBus: EventBus;
  private runtimeConfig: SubstrateConfig | null;
  private extractionInterval: number;
  private minImportance: number;
  private minConfidence: number;
  private minNovelty: number;
  private maxWrites: number;
  private telemetryEnabled: boolean;
  private promptRegistry: PromptRegistryStore | null;
  private sessionStore: SessionStore | null;
  private contactStore: ContactStore | null;
  private acceptingExtractions = true;
  private inFlightExtractions = new Set<Promise<void>>();
  private inFlightByChannel = new Map<string, Promise<void>>();
  private inFlightProfileRefreshes = new Set<Promise<void>>();
  private inFlightProfileByContact = new Map<string, Promise<void>>();

  constructor(
    llmClient: LLMProvider,
    sessionManager: SessionManager,
    memoryStore: MemoryStore,
    embeddingService: EmbeddingService,
    eventBus: EventBus,
    config?: MemoryExtractorConfig | SubstrateConfig,
    promptRegistry?: PromptRegistryStore | null,
    sessionStore?: SessionStore | null,
    contactStore?: ContactStore | null,
  ) {
    this.llmClient = llmClient;
    this.sessionManager = sessionManager;
    this.memoryStore = memoryStore;
    this.writer = new MemoryWriter(memoryStore, embeddingService);
    this.eventBus = eventBus;

    if (config && 'primaryModel' in config) {
      this.runtimeConfig = config;
      this.extractionInterval = config.extractionInterval;
      this.minImportance = config.memoryExtractionMinImportance ?? DEFAULT_MIN_IMPORTANCE;
      this.minConfidence = config.memoryExtractionMinConfidence ?? DEFAULT_MIN_CONFIDENCE;
      this.minNovelty = config.memoryExtractionMinNovelty ?? DEFAULT_MIN_NOVELTY;
      this.maxWrites = normalizeMaxWrites(config.memoryExtractionMaxWrites, DEFAULT_MAX_WRITES);
      this.telemetryEnabled = config.memoryExtractionTelemetryEnabled ?? true;
    } else {
      const extractorConfig = config as MemoryExtractorConfig | undefined;
      this.runtimeConfig = null;
      this.extractionInterval = extractorConfig?.extractionInterval ?? MEMORY_CONFIG.extractionInterval;
      this.minImportance = extractorConfig?.minImportance ?? DEFAULT_MIN_IMPORTANCE;
      this.minConfidence = extractorConfig?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
      this.minNovelty = extractorConfig?.minNovelty ?? DEFAULT_MIN_NOVELTY;
      this.maxWrites = normalizeMaxWrites(extractorConfig?.maxWrites, DEFAULT_MAX_WRITES);
      this.telemetryEnabled = extractorConfig?.telemetryEnabled ?? true;
    }

    this.promptRegistry = promptRegistry ?? null;
    this.sessionStore = sessionStore ?? null;
    this.contactStore = contactStore ?? null;
  }

  async queueRetroactiveExtraction(
    channelId: string,
    recoveredEntries: SessionEntry[],
    canonicalContactId?: string,
  ): Promise<void> {
    if (recoveredEntries.length === 0) return;
    if (!this.acceptingExtractions) {
      log.debug('Skipping crash recovery extraction while extractor is draining', { channelId });
      return;
    }

    const orderedEntries = [...recoveredEntries].sort((left, right) => left.id - right.id);
    await this.trackExtraction(channelId, 'crash_recovery', canonicalContactId, orderedEntries);
  }

  async queueCompactionExtraction(
    channelId: string,
    compactedEntries: SessionEntry[],
    canonicalContactId?: string,
  ): Promise<void> {
    if (compactedEntries.length === 0) return;
    if (!this.acceptingExtractions) {
      log.debug('Skipping pre-compaction extraction while extractor is draining', { channelId });
      return;
    }

    const orderedEntries = [...compactedEntries].sort((left, right) => left.id - right.id);
    await this.trackExtraction(channelId, 'pre_compaction', canonicalContactId, orderedEntries);
  }

  async maybeExtract(channelId: string, canonicalContactId?: string, turnId?: TurnID): Promise<void> {
    if (!this.acceptingExtractions) {
      log.debug('Skipping extraction trigger while extractor is draining', { channelId });
      return;
    }

    const trigger = evaluateExtractionTrigger(
      channelId,
      this.sessionManager,
      this.runtimeConfig,
      this.extractionInterval,
    );
    if (!trigger) return;

    if (this.isTelemetryEnabled()) {
      log.debug('Extraction trigger matched', {
        channelId,
        triggerReason: trigger.triggerReason,
        currentCount: trigger.currentCount,
        lastCount: trigger.lastCount,
        deltaMessages: trigger.currentCount - trigger.lastCount,
        interval: trigger.interval,
        thresholdPct: trigger.thresholdPct,
        totalTokens: trigger.totalTokens,
        tokenBudget: trigger.tokenBudget,
      });
    }

    await this.trackExtraction(channelId, trigger.triggerReason, canonicalContactId, undefined, turnId);
  }

  async extract(channelId: string, canonicalContactId?: string, turnId?: TurnID): Promise<void> {
    if (!this.acceptingExtractions) {
      log.debug('Skipping extraction request while extractor is draining', { channelId });
      return;
    }

    await this.trackExtraction(channelId, 'manual', canonicalContactId, undefined, turnId);
  }

  async stop(options?: MemoryExtractorDrainOptions): Promise<boolean> {
    this.acceptingExtractions = false;
    return this.drain(options);
  }

  async drain(options?: MemoryExtractorDrainOptions): Promise<boolean> {
    const timeoutMs = options?.timeoutMs ?? 10_000;
    const activeCount = this.inFlightExtractions.size + this.inFlightProfileRefreshes.size;
    if (activeCount === 0) return true;

    log.info('Waiting for extraction drain', { inFlight: activeCount, timeoutMs });

    const pending = Promise.allSettled([
      ...this.inFlightExtractions,
      ...this.inFlightProfileRefreshes,
    ]).then(() => true);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      if (timeoutMs <= 0) return;
      timer = setTimeout(() => resolve(false), timeoutMs);
    });

    const drained = timeoutMs <= 0
      ? await pending
      : await Promise.race([pending, timeout]);

    if (timer) clearTimeout(timer);

    if (!drained) {
      log.warn('Timed out waiting for extraction drain', {
        timeoutMs,
        inFlightExtractions: this.inFlightExtractions.size,
        inFlightProfileRefreshes: this.inFlightProfileRefreshes.size,
      });
      return false;
    }

    log.info('Extraction drain complete');
    return true;
  }

  private trackExtraction(
    channelId: string,
    triggerReason: ExtractionTriggerReason,
    canonicalContactId?: string,
    recoveredEntries?: SessionEntry[],
    turnId?: TurnID,
  ): Promise<void> {
    const existing = this.inFlightByChannel.get(channelId);
    if (existing) {
      log.debug('Reusing in-flight extraction', { channelId, triggerReason });
      return existing;
    }

    const promise = this.runExtraction(channelId, triggerReason, canonicalContactId, recoveredEntries, turnId);
    this.inFlightExtractions.add(promise);
    this.inFlightByChannel.set(channelId, promise);
    void promise
      .catch((error) => {
        log.error('Extraction run failed', {
          channelId,
          triggerReason,
          error: String(error),
        });
      })
      .finally(() => {
        this.inFlightExtractions.delete(promise);
        if (this.inFlightByChannel.get(channelId) === promise) {
          this.inFlightByChannel.delete(channelId);
        }
      });

    return promise;
  }

  private async runExtraction(
    channelId: string,
    triggerReason: ExtractionTriggerReason,
    canonicalContactId?: string,
    recoveredEntries?: SessionEntry[],
    turnId?: TurnID,
  ): Promise<void> {
    await runExtractionOrchestration({
      channelId,
      triggerReason,
      canonicalContactId,
      turnId,
      recoveredEntries,
      llmClient: this.llmClient,
      sessionManager: this.sessionManager,
      memoryStore: this.memoryStore,
      promptRegistry: this.promptRegistry,
      gateConfig: resolveGateConfig(this.runtimeConfig, {
        minImportance: this.minImportance,
        minConfidence: this.minConfidence,
        minNovelty: this.minNovelty,
      }),
      maxWrites: resolveMaxWrites(this.runtimeConfig, this.maxWrites),
      telemetryEnabled: this.isTelemetryEnabled(),
      useCompositionalExtraction: this.shouldUseCompositionalExtraction(channelId),
      isAcceptingExtractions: () => this.acceptingExtractions,
      processFact: (fact, sourceRef, maybeContactId) => this.processFact(fact, sourceRef, maybeContactId),
      emitExtractionStart: (extractionChannelId, reason, extractionTurnId) => (
        emitExtractionStartEvent(this.eventBus, this.isTelemetryEnabled(), extractionChannelId, reason, extractionTurnId)
      ),
      emitExtractionEnd: telemetry => (
        emitExtractionEndEvent(this.eventBus, this.isTelemetryEnabled(), telemetry)
      ),
      resolveCoveredUpToMessageId: (extractionChannelId, entries) => (
        resolveCoveredMarker(this.sessionManager, extractionChannelId, entries)
      ),
      recordExtractionMarker: (extractionChannelId, coveredUpToMessageId) => (
        persistExtractionMarker(this.sessionStore, extractionChannelId, coveredUpToMessageId)
      ),
      maybePersistEmotionalState: (contactId, acceptedFacts, recentEntries) => (
        this.maybePersistEmotionalState(contactId, acceptedFacts, recentEntries)
      ),
      maybeRefreshContactProfile: (
        extractionChannelId,
        reason,
        contactId,
        acceptedWrites,
      ) => this.maybeRefreshContactProfile(extractionChannelId, reason, contactId, acceptedWrites),
    });
  }

  private shouldUseCompositionalExtraction(channelId: string): boolean {
    if (!this.runtimeConfig) return false;

    return evaluateCompositionalPolicyForChannelId({
      policy: this.runtimeConfig.compositionalPolicy,
      capabilityTier: this.runtimeConfig.capabilityTier,
      channelId,
      purpose: 'extraction',
    }).allowed;
  }

  private async processFact(
    fact: ExtractedFact,
    sourceRef: string,
    canonicalContactId?: string,
  ): Promise<WriteResult> {
    return this.writer.write({
      text: fact.text,
      type: fact.type,
      importance: fact.importance,
      emotionalValence: fact.emotionalValence,
      confidence: fact.confidence,
      tags: fact.tags,
      sourceRef,
      sensitivity: fact.sensitivity,
      contactId: canonicalContactId,
    });
  }

  private maybeRefreshContactProfile(
    channelId: string,
    triggerReason: ExtractionTriggerReason,
    canonicalContactId: string | undefined,
    acceptedWrites: AcceptedFactWrite[],
  ): void {
    scheduleProfileRefresh({
      channelId,
      triggerReason,
      canonicalContactId,
      acceptedWrites,
      acceptingExtractions: this.acceptingExtractions,
      profileConfig: resolveProfileConfig(this.runtimeConfig),
      telemetryEnabled: this.isTelemetryEnabled(),
      inFlightProfileByContact: this.inFlightProfileByContact,
      inFlightProfileRefreshes: this.inFlightProfileRefreshes,
      startRefresh: (refreshChannelId, refreshReason, contactId, writes, config) => (
        this.refreshContactProfile(refreshChannelId, refreshReason, contactId, writes, config)
      ),
    });
  }

  private async refreshContactProfile(
    channelId: string,
    triggerReason: ExtractionTriggerReason,
    canonicalContactId: string,
    acceptedWrites: AcceptedFactWrite[],
    config: ProfileSynthesisConfig,
  ): Promise<void> {
    await runProfileRefresh({
      llmClient: this.llmClient,
      promptRegistry: this.promptRegistry,
      memoryStore: this.memoryStore,
      channelId,
      triggerReason,
      canonicalContactId,
      acceptedWrites,
      config,
      telemetryEnabled: this.isTelemetryEnabled(),
    });
  }

  private maybePersistEmotionalState(
    canonicalContactId: string | undefined,
    acceptedFacts: ExtractedFact[],
    recentEntries: SessionEntry[],
  ): void {
    persistEmotionalStateFromExtraction({
      canonicalContactId,
      acceptedFacts,
      recentEntries,
      contactStore: this.contactStore,
      telemetryEnabled: this.isTelemetryEnabled(),
    });
  }

  private isTelemetryEnabled(): boolean {
    return resolveTelemetryEnabled(this.runtimeConfig, this.telemetryEnabled);
  }
}

export { parseFactsXml };

export type {
  MemoryExtractorConfig,
  MemoryExtractorDrainOptions,
} from './extraction/types.js';

export const __test = {
  evaluateFactAcceptance,
  computeNoveltyScore,
  computeProfileNovelty,
  deriveEmotionalSignal,
  resetLastExtractionCount,
};
