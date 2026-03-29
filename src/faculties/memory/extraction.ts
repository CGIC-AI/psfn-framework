import type { EmbeddingProviderPort, LLMProviderPort } from '../../core/agent/contracts.js';
import type { PromptRegistryStatePort } from '../../core/identity/prompt-state-port.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import { resolvePreferredContactName } from '../../core/contacts/preferred-name.js';
import type { SessionManager } from '../../core/session/manager.js';
import type { SessionStore } from '../../persistence/sessions/store.js';
import type { SessionEntry } from '../../core/session/types.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { TurnID } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import {
  normalizeCostTelemetryPort,
  type CostTelemetryInput,
  type CostTelemetryPort,
} from '../../shared/telemetry/cost-telemetry-port.js';
import { evaluateCompositionalPolicyForChannelId } from '../../system/capabilities/compositional-policy.js';
import type { MemoryStorePort } from './memory-store-port.js';
import type { ExtractedFact, MemoryFormationVAD } from './types.js';
import { MEMORY_CONFIG } from './types.js';
import { MemoryWriter, type WriteResult } from './writer.js';
import {
  DEFAULT_EMOTIONAL_INTENSITY_IMPORTANCE_WEIGHT,
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
  resolveEmotionalIntensityImportanceWeight,
  resolveGateConfig,
  resolveMaxWrites,
  resolveProfileConfig,
  resolveTelemetryEnabled,
} from './extraction/config.js';
import { runExtractionOrchestration } from './extraction/orchestrator.js';
import { refreshContactProfile as runProfileRefresh } from './extraction/profile-synthesis.js';
import { persistEmotionalStateFromExtraction } from './extraction/emotional.js';
import { resolveMentionOnlyContactForFact } from './extraction/mention-only-contacts.js';
import {
  emitExtractionEnd as emitExtractionEndEvent,
  emitExtractionStart as emitExtractionStartEvent,
  evaluateExtractionTrigger,
  recordExtractionMarker as persistExtractionMarker,
  resetLastExtractionCount,
  resolveCoveredUpToMessageId as resolveCoveredMarker,
  scheduleProfileRefresh,
} from './extraction/runtime-helpers.js';
import { applyEmotionalIntensityImportanceMultiplier } from './extraction/importance.js';
import { resolveExtractionParticipantNames } from './extraction/naming.js';
import {
  computeNoveltyScore,
  computeProfileNovelty,
  deriveEmotionalSignal,
  evaluateFactAcceptance,
} from './extraction/signals.js';
import { parseFactsXml } from './extraction/parser.js';

const log = createComponentLogger('Extraction');

export interface MemoryExtractorFormationOptions {
  getFormationVAD?: () => MemoryFormationVAD | undefined;
}

export class MemoryExtractor {
  private llmClient: LLMProviderPort;
  private sessionManager: SessionManager;
  private memoryStore: MemoryStorePort;
  private writer: MemoryWriter;
  private costTelemetry: CostTelemetryPort;
  private runtimeConfig: SubstrateConfig | null;
  private extractionInterval: number;
  private minImportance: number;
  private minConfidence: number;
  private minNovelty: number;
  private maxWrites: number;
  private emotionalIntensityImportanceWeight: number;
  private telemetryEnabled: boolean;
  private promptRegistry: PromptRegistryStatePort | null;
  private sessionStore: SessionStore | null;
  private contactStore: ContactStorePort | null;
  private acceptingExtractions = true;
  private inFlightExtractions = new Set<Promise<void>>();
  private inFlightByChannel = new Map<string, Promise<void>>();
  private inFlightProfileRefreshes = new Set<Promise<void>>();
  private inFlightProfileByContact = new Map<string, Promise<void>>();
  private getFormationVAD: (() => MemoryFormationVAD | undefined) | null = null;

  constructor(
    llmClient: LLMProviderPort,
    sessionManager: SessionManager,
    memoryStore: MemoryStorePort,
    embeddingService: EmbeddingProviderPort,
    costTelemetry: CostTelemetryInput,
    config?: MemoryExtractorConfig | SubstrateConfig,
    promptRegistry?: PromptRegistryStatePort | null,
    sessionStore?: SessionStore | null,
    contactStore?: ContactStorePort | null,
    formationOptions?: MemoryExtractorFormationOptions,
  ) {
    this.llmClient = llmClient;
    this.sessionManager = sessionManager;
    this.memoryStore = memoryStore;
    this.writer = new MemoryWriter(memoryStore, embeddingService);
    const resolvedTelemetry = normalizeCostTelemetryPort(costTelemetry);
    if (!resolvedTelemetry) {
      throw new Error('MemoryExtractor requires a cost telemetry port');
    }
    this.costTelemetry = resolvedTelemetry;

    if (config && 'primaryModel' in config) {
      this.runtimeConfig = config;
      this.extractionInterval = config.extractionInterval;
      this.minImportance = config.memoryExtractionMinImportance ?? DEFAULT_MIN_IMPORTANCE;
      this.minConfidence = config.memoryExtractionMinConfidence ?? DEFAULT_MIN_CONFIDENCE;
      this.minNovelty = config.memoryExtractionMinNovelty ?? DEFAULT_MIN_NOVELTY;
      this.maxWrites = normalizeMaxWrites(config.memoryExtractionMaxWrites, DEFAULT_MAX_WRITES);
      this.emotionalIntensityImportanceWeight = DEFAULT_EMOTIONAL_INTENSITY_IMPORTANCE_WEIGHT;
      this.telemetryEnabled = config.memoryExtractionTelemetryEnabled ?? true;
    } else {
      const extractorConfig = config as MemoryExtractorConfig | undefined;
      this.runtimeConfig = null;
      this.extractionInterval = extractorConfig?.extractionInterval ?? MEMORY_CONFIG.extractionInterval;
      this.minImportance = extractorConfig?.minImportance ?? DEFAULT_MIN_IMPORTANCE;
      this.minConfidence = extractorConfig?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
      this.minNovelty = extractorConfig?.minNovelty ?? DEFAULT_MIN_NOVELTY;
      this.maxWrites = normalizeMaxWrites(extractorConfig?.maxWrites, DEFAULT_MAX_WRITES);
      this.emotionalIntensityImportanceWeight = extractorConfig?.emotionalIntensityImportanceWeight
        ?? DEFAULT_EMOTIONAL_INTENSITY_IMPORTANCE_WEIGHT;
      this.telemetryEnabled = extractorConfig?.telemetryEnabled ?? true;
    }

    this.promptRegistry = promptRegistry ?? null;
    this.sessionStore = sessionStore ?? null;
    this.contactStore = contactStore ?? null;
    this.getFormationVAD = formationOptions?.getFormationVAD ?? null;
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
    let cachedFormationVAD: MemoryFormationVAD | undefined;
    let didResolveFormationVAD = false;
    const resolveFormationVAD = (): MemoryFormationVAD | undefined => {
      if (!didResolveFormationVAD) {
        cachedFormationVAD = this.getFormationVAD?.();
        didResolveFormationVAD = true;
      }
      return cachedFormationVAD;
    };
    const intensityWeight = resolveEmotionalIntensityImportanceWeight(
      this.runtimeConfig,
      this.emotionalIntensityImportanceWeight,
    );
    const canonicalContactName = canonicalContactId && this.contactStore
      ? resolvePreferredContactName(await this.contactStore.getById(canonicalContactId))
      : undefined;

    await runExtractionOrchestration({
      channelId,
      triggerReason,
      canonicalContactId,
      turnId,
      recoveredEntries,
      resolveParticipantNames: (recentEntries, extractionCanonicalContactId) => resolveExtractionParticipantNames({
        entries: recentEntries,
        canonicalContactName: extractionCanonicalContactId ? canonicalContactName : undefined,
        companionName: this.sessionManager.characterName,
      }),
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
      adjustFactForWrite: fact => (
        this.adjustFactImportanceByEmotion(fact, resolveFormationVAD(), intensityWeight)
      ),
      processFact: (fact, sourceRef, maybeContactId) => (
        this.processFact(
          fact,
          sourceRef,
          maybeContactId,
          resolveFormationVAD(),
          channelId,
          canonicalContactName,
          this.sessionManager.characterName,
        )
      ),
      emitExtractionStart: (extractionChannelId, reason, extractionTurnId) => (
        emitExtractionStartEvent(this.costTelemetry, this.isTelemetryEnabled(), extractionChannelId, reason, extractionTurnId)
      ),
      emitExtractionEnd: telemetry => (
        emitExtractionEndEvent(this.costTelemetry, this.isTelemetryEnabled(), telemetry)
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
    formationVAD?: MemoryFormationVAD,
    channelId?: string,
    canonicalContactName?: string,
    companionName?: string,
  ): Promise<WriteResult> {
    let factContactId = canonicalContactId;
    if (fact.type === 'relational' && this.contactStore && channelId) {
      const mentionOnlyContact = await resolveMentionOnlyContactForFact({
        fact,
        channelId,
        canonicalContactId,
        canonicalContactName,
        companionName,
        contactStore: this.contactStore,
        memoryStore: this.memoryStore,
      });
      if (mentionOnlyContact) {
        factContactId = mentionOnlyContact.id;
      }
    }

    return this.writer.write({
      text: fact.text,
      type: fact.type,
      importance: fact.importance,
      emotionalValence: fact.emotionalValence,
      formationVAD,
      confidence: fact.confidence,
      tags: fact.tags,
      sourceRef,
      sensitivity: fact.sensitivity,
      contactId: factContactId,
    });
  }

  private adjustFactImportanceByEmotion(
    fact: ExtractedFact,
    formationVAD: MemoryFormationVAD | undefined,
    intensityWeight: number,
  ): ExtractedFact {
    const adjustedImportance = applyEmotionalIntensityImportanceMultiplier({
      baseImportance: fact.importance,
      formationVAD,
      intensityWeight,
    });
    if (adjustedImportance === fact.importance) return fact;
    return {
      ...fact,
      importance: adjustedImportance,
    };
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
