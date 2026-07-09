import type { EmbeddingProviderPort, LLMProviderPort } from '../../core/agent/contracts.js';
import type { PromptRegistryStatePort } from '../../core/identity/prompt-state-port.js';
import type { PersonaPreamblePort } from '../../core/identity/persona-preamble.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import { resolvePreferredContactName } from '../../core/contacts/preferred-name.js';
import type { SessionManager } from '../../core/session/manager.js';
import type { SessionStore } from '../../persistence/sessions/store.js';
import type { SessionEntry } from '../../core/session/types.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { GroupMemoryWriteCapSettings } from '../../system/config/group-memory-config.js';
import type { TurnID } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
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
  type ConcernCandidateExtractionSink,
  type AcceptedFactWrite,
  type ExtractionTriggerReason,
  type MemoryExtractorConfig,
  type MemoryExtractorDrainOptions,
  type ProfileSynthesisConfig,
} from './extraction/types.js';
import type {
  ExtractionFactRouting,
  ExtractionSourceSpeaker,
} from './extraction/speaker-routing.js';
import {
  normalizeMaxWrites,
  resolveEmotionalIntensityImportanceWeight,
  resolveGateConfig,
  resolveMaxWrites,
  resolveProfileConfig,
  resolveTelemetryEnabled,
} from './extraction/config.js';
import {
  runExtractionOrchestration,
  type ExtractionRunOptions,
} from './extraction/orchestrator.js';
import { refreshContactProfile as runProfileRefresh } from './extraction/profile-synthesis.js';
import { persistEmotionalStateFromExtraction } from './extraction/emotional.js';
import {
  resolveInterlocutorRelationshipRatchet,
  resolveMentionOnlyContactForFact,
} from './extraction/mention-only-contacts.js';
import {
  advanceExtractionWatermarkForCoverage,
  emitExtractionEnd as emitExtractionEndEvent,
  emitExtractionStart as emitExtractionStartEvent,
  evaluateExtractionTrigger,
  recordExtractionMarker as persistExtractionMarker,
  resetLastExtractionCount,
  resolveCoveredUpToMessageId as resolveCoveredMarker,
  scheduleProfileRefresh,
} from './extraction/runtime-helpers.js';
import { applyEmotionalIntensityImportanceMultiplier } from './extraction/importance.js';
import { applyLocationTag } from './extraction/location-tags.js';
import { resolveExtractionParticipantNames } from './extraction/naming.js';
import {
  computeNoveltyScore,
  computeProfileNovelty,
  deriveEmotionalSignal,
  evaluateExtractionPreLlmGate,
  evaluateFactAcceptance,
} from './extraction/signals.js';
import { parseFactsXml } from './extraction/parser.js';

const log = createComponentLogger('Extraction');

export interface MemoryExtractorFormationOptions {
  getFormationVAD?: () => MemoryFormationVAD | undefined;
  emitConcernCandidates?: ConcernCandidateExtractionSink;
  /**
   * Contact-tracking policy gate predicate (E3.4). When it returns false for a
   * channel, extraction must not create contact rows for that channel — the
   * mention-only contact path is skipped and facts keep transcript/provenance
   * attribution (sourceSpeakerName) without contact-keyed records. Absent
   * predicate behaves as 'auto' (allowed) everywhere. Reserved modes throw at
   * use inside the predicate (fail closed).
   */
  isAutoContactCreationAllowed?: (channelId: string) => boolean;
  /**
   * Shared persona preamble service (E6.1). When present, extraction and
   * profile-synthesis prompts are prefixed with the companion's soft persona
   * framing before their strict schema-bound instructions.
   */
  personaPreamble?: PersonaPreamblePort | null;
}

export interface ObservedGroupExtractionOptions {
  channelId: string;
  triggerReason: Extract<
    ExtractionTriggerReason,
    'observed_count' | 'observed_time' | 'direct_mention' | 'high_salience' | 'backlog_lag'
  >;
  recoveredEntries: SessionEntry[];
  groupWriteCaps: GroupMemoryWriteCapSettings;
  backfill?: boolean;
}

export interface GroupBackfillExtractionOptions {
  channelId: string;
  recoveredEntries: SessionEntry[];
  groupWriteCaps: GroupMemoryWriteCapSettings;
}

type MemoryExtractorGroupOptions =
  Pick<ExtractionRunOptions, 'groupWriteCaps' | 'groupWriteCapContext'>
  & { forceLegacyExtraction?: boolean };

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
  private emitConcernCandidates: ConcernCandidateExtractionSink | null = null;
  private isAutoContactCreationAllowed: ((channelId: string) => boolean) | null = null;
  private personaPreamble: PersonaPreamblePort | null = null;

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
    // htm9.3: the extractor's writes gate at the memory_write sink. The gate
    // is late-bound onto the session manager by composition, so the writer
    // follows it through a provider closure.
    this.writer.intakeSinkGateProvider = () => this.sessionManager.intakeSinkGate;
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
    this.emitConcernCandidates = formationOptions?.emitConcernCandidates ?? null;
    this.isAutoContactCreationAllowed = formationOptions?.isAutoContactCreationAllowed ?? null;
    this.personaPreamble = formationOptions?.personaPreamble ?? null;
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
    const reusedInFlight = this.hasInFlightExtraction(channelId);
    await this.trackExtraction(channelId, 'crash_recovery', canonicalContactId, orderedEntries);
    if (!reusedInFlight) {
      this.advanceIntervalWatermarkAfterCoverage(channelId, 'crash_recovery', orderedEntries);
    }
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
    const reusedInFlight = this.hasInFlightExtraction(channelId);
    await this.trackExtraction(channelId, 'pre_compaction', canonicalContactId, orderedEntries);
    if (!reusedInFlight) {
      this.advanceIntervalWatermarkAfterCoverage(channelId, 'pre_compaction', orderedEntries);
    }
  }

  async maybeExtract(
    channelId: string,
    canonicalContactId?: string,
    turnId?: TurnID,
    placeId?: string,
  ): Promise<void> {
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

    await this.trackExtraction(channelId, trigger.triggerReason, canonicalContactId, undefined, turnId, undefined, placeId);
  }

  async extract(
    channelId: string,
    canonicalContactId?: string,
    turnId?: TurnID,
    placeId?: string,
  ): Promise<void> {
    if (!this.acceptingExtractions) {
      log.debug('Skipping extraction request while extractor is draining', { channelId });
      return;
    }

    await this.trackExtraction(channelId, 'manual', canonicalContactId, undefined, turnId, undefined, placeId);
  }

  async extractObservedGroupRange(options: ObservedGroupExtractionOptions): Promise<boolean> {
    if (options.recoveredEntries.length === 0) return false;
    if (!this.acceptingExtractions) {
      log.debug('Skipping observed group extraction while extractor is draining', {
        channelId: options.channelId,
        triggerReason: options.triggerReason,
      });
      return false;
    }

    const orderedEntries = [...options.recoveredEntries]
      .sort((left, right) => left.id - right.id);
    // trackExtraction reuses an existing in-flight run for this channel and
    // drops these recoveredEntries; reporting success would let the caller mark
    // an unprocessed range complete (mlwk.22). Only claim success when this call
    // actually starts the extraction that covers the range.
    const reusedInFlight = this.hasInFlightExtraction(options.channelId);
    await this.trackExtraction(
      options.channelId,
      options.triggerReason,
      undefined,
      orderedEntries,
      undefined,
      {
        groupWriteCaps: options.groupWriteCaps,
        groupWriteCapContext: {
          backfill: options.backfill ?? false,
        },
      },
    );
    return !reusedInFlight;
  }

  async extractGroupBackfillRange(options: GroupBackfillExtractionOptions): Promise<boolean> {
    if (options.recoveredEntries.length === 0) return false;
    if (!this.acceptingExtractions) {
      log.debug('Skipping operator group backfill while extractor is draining', {
        channelId: options.channelId,
      });
      return false;
    }

    const orderedEntries = [...options.recoveredEntries]
      .sort((left, right) => left.id - right.id);
    // See extractObservedGroupRange: a reused in-flight run drops these entries,
    // so only report success when this call starts the covering extraction
    // (mlwk.22).
    const reusedInFlight = this.hasInFlightExtraction(options.channelId);
    await this.trackExtraction(
      options.channelId,
      'operator_backfill',
      undefined,
      orderedEntries,
      undefined,
      {
        groupWriteCaps: options.groupWriteCaps,
        groupWriteCapContext: {
          backfill: true,
        },
        forceLegacyExtraction: true,
      },
    );
    return !reusedInFlight;
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

  getPendingExtractionPromise(channelId: string): Promise<void> | null {
    const resolvedChannelId = this.resolveExtractionLogicalSessionId(channelId);
    return this.inFlightByChannel.get(channelId)
      ?? this.inFlightByChannel.get(resolvedChannelId)
      ?? null;
  }

  private trackExtraction(
    channelId: string,
    triggerReason: ExtractionTriggerReason,
    canonicalContactId?: string,
    recoveredEntries?: SessionEntry[],
    turnId?: TurnID,
    groupOptions?: MemoryExtractorGroupOptions,
    placeId?: string,
  ): Promise<void> {
    const logicalSessionId = this.resolveExtractionLogicalSessionId(channelId);
    const existing = this.inFlightByChannel.get(logicalSessionId);
    if (existing) {
      log.debug('Reusing in-flight extraction', { channelId, logicalSessionId, triggerReason });
      return existing;
    }

    const promise = this.runExtraction(
      channelId,
      logicalSessionId,
      triggerReason,
      canonicalContactId,
      recoveredEntries,
      turnId,
      groupOptions,
      placeId,
    );
    this.inFlightExtractions.add(promise);
    this.inFlightByChannel.set(logicalSessionId, promise);
    void promise
      .catch((error) => {
        log.error('Extraction run failed', {
          channelId,
          logicalSessionId,
          triggerReason,
          error: String(error),
        });
      })
      .finally(() => {
        this.inFlightExtractions.delete(promise);
        if (this.inFlightByChannel.get(logicalSessionId) === promise) {
          this.inFlightByChannel.delete(logicalSessionId);
        }
      });

    return promise;
  }

  private async runExtraction(
    channelId: string,
    logicalSessionId: string,
    triggerReason: ExtractionTriggerReason,
    canonicalContactId?: string,
    recoveredEntries?: SessionEntry[],
    turnId?: TurnID,
    groupOptions?: MemoryExtractorGroupOptions,
    placeId?: string,
  ): Promise<void> {
    if (!this.isExtractionSessionCurrent(channelId, logicalSessionId)) {
      log.debug('Skipping stale extraction after session route changed', {
        channelId,
        logicalSessionId,
        triggerReason,
      });
      return;
    }
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
    const canonicalContactName = canonicalContactId
      && this.contactStore
      && typeof this.contactStore.getById === 'function'
      ? resolvePreferredContactName(await this.contactStore.getById(canonicalContactId))
      : undefined;

    await runExtractionOrchestration({
      channelId,
      triggerReason,
      canonicalContactId,
      turnId,
      sourceSessionId: logicalSessionId,
      recoveredEntries,
      resolveParticipantNames: (recentEntries, extractionCanonicalContactId) => resolveExtractionParticipantNames({
        entries: recentEntries,
        canonicalContactName: extractionCanonicalContactId ? canonicalContactName : undefined,
        companionName: this.sessionManager.characterName,
      }),
      resolveSourceSpeakerContactId: speaker => this.resolveSourceSpeakerContactId(channelId, speaker),
      llmClient: this.llmClient,
      sessionManager: this.sessionManager,
      memoryStore: this.memoryStore,
      promptRegistry: this.promptRegistry,
      personaPreamble: this.personaPreamble,
      gateConfig: resolveGateConfig(this.runtimeConfig, {
        minImportance: this.minImportance,
        minConfidence: this.minConfidence,
        minNovelty: this.minNovelty,
      }),
      maxWrites: resolveMaxWrites(this.runtimeConfig, this.maxWrites),
      ...(groupOptions?.groupWriteCaps
        ? { groupWriteCaps: groupOptions.groupWriteCaps }
        : {}),
      ...(groupOptions?.groupWriteCapContext
        ? { groupWriteCapContext: groupOptions.groupWriteCapContext }
        : {}),
      telemetryEnabled: this.isTelemetryEnabled(),
      useCompositionalExtraction: groupOptions?.forceLegacyExtraction
        ? false
        : this.shouldUseCompositionalExtraction(channelId),
      isAcceptingExtractions: () => (
        this.acceptingExtractions
        && this.isExtractionSessionCurrent(channelId, logicalSessionId)
      ),
      adjustFactForWrite: fact => (
        this.adjustFactImportanceByEmotion(fact, resolveFormationVAD(), intensityWeight)
      ),
      processFact: (fact, sourceRef, maybeContactId, routing) => (
        this.processFact(
          fact,
          sourceRef,
          maybeContactId,
          resolveFormationVAD(),
          channelId,
          logicalSessionId,
          canonicalContactName,
          this.sessionManager.characterName,
          triggerReason,
          turnId,
          routing,
          placeId,
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
      recordExtractionMarker: (_extractionChannelId, coveredUpToMessageId) => (
        persistExtractionMarker(this.sessionStore, logicalSessionId, coveredUpToMessageId)
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
      ...(this.emitConcernCandidates
        ? { emitConcernCandidates: this.emitConcernCandidates }
        : {}),
    });
  }

  private hasInFlightExtraction(channelId: string): boolean {
    return this.inFlightByChannel.has(this.resolveExtractionLogicalSessionId(channelId));
  }

  /**
   * Advances the interval watermark after an out-of-band extraction
   * (pre_compaction / crash_recovery) successfully consumed a batch, so the
   * next interval trigger does not re-send the same messages
   * (psfn-framework-xcw8). Callers must only invoke this after the awaited
   * extraction resolved and only when the batch was actually consumed by this
   * run (not coalesced into an unrelated in-flight run) — on failure the
   * watermark stays put so no content is skipped without extraction.
   */
  private advanceIntervalWatermarkAfterCoverage(
    channelId: string,
    triggerReason: ExtractionTriggerReason,
    consumedEntries: SessionEntry[],
  ): void {
    const logicalSessionId = this.resolveExtractionLogicalSessionId(channelId);
    if (!this.isExtractionSessionCurrent(channelId, logicalSessionId)) {
      log.debug('Skipping interval watermark advance for stale extraction session', {
        channelId,
        logicalSessionId,
        triggerReason,
      });
      return;
    }

    const advance = advanceExtractionWatermarkForCoverage(
      channelId,
      this.sessionManager,
      consumedEntries,
    );
    if (advance && this.isTelemetryEnabled()) {
      log.debug('Advanced extraction interval watermark after out-of-band extraction', {
        channelId,
        triggerReason,
        previousCount: advance.previousCount,
        nextCount: advance.nextCount,
        coveredUpToMessageId: advance.coveredUpToMessageId,
        consumedEntryCount: consumedEntries.length,
      });
    }
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

  private resolveExtractionLogicalSessionId(channelId: string): string {
    const resolver = this.sessionManager.resolveSessionChannelId;
    if (typeof resolver !== 'function') return channelId;
    return resolver.call(this.sessionManager, channelId);
  }

  private isExtractionSessionCurrent(channelId: string, logicalSessionId: string): boolean {
    const isRetired = this.sessionManager.isSessionRetiredOrQuarantined;
    if (typeof isRetired === 'function' && isRetired.call(this.sessionManager, logicalSessionId)) {
      return false;
    }
    return this.resolveExtractionLogicalSessionId(channelId) === logicalSessionId;
  }

  private async processFact(
    fact: ExtractedFact,
    sourceRef: string,
    canonicalContactId?: string,
    formationVAD?: MemoryFormationVAD,
    channelId?: string,
    logicalSessionId?: string,
    canonicalContactName?: string,
    companionName?: string,
    triggerReason?: ExtractionTriggerReason,
    turnId?: TurnID,
    routing?: ExtractionFactRouting,
    placeId?: string,
  ): Promise<WriteResult> {
    let factContactId = canonicalContactId;
    // Contact-tracking policy gate (E3.4): non-'auto' channels must not have
    // extraction create contact rows (mention-only path included). Facts keep
    // speaker-name provenance; they just gain no contact-keyed records.
    const contactCreationAllowed = !channelId
      || this.isAutoContactCreationAllowed === null
      || this.isAutoContactCreationAllowed(channelId);
    if (fact.type === 'relational' && this.contactStore && channelId && contactCreationAllowed) {
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

    // Deliberate interlocutor progression path (psfn-framework-kada.1). When a
    // relational fact stays attributed to the routed contact (the mention-only
    // path did not divert it to a third party) and is not attributed to a
    // distinct third-party subject, that contact is the conversation partner
    // themselves. Facts about their own bond with the companion may ratchet
    // their relationshipType upward. Gated by the same ContactTrackingGate as
    // the mention path; the ratchet's own conservative evidence bar and the
    // store's primary-contact guard do the rest.
    if (
      fact.type === 'relational'
      && this.contactStore
      && channelId
      && contactCreationAllowed
      && canonicalContactId
      && factContactId === canonicalContactId
      && !routing?.subjectContactId
    ) {
      await resolveInterlocutorRelationshipRatchet({
        fact,
        interlocutorContactId: canonicalContactId,
        contactStore: this.contactStore,
        canonicalContactName,
        companionName,
      });
    }

    if (routing && this.isTelemetryEnabled()) {
      log.debug('Resolved extracted fact contact routing', {
        channelId,
        triggerReason,
        turnId,
        triggerContactId: routing.triggerContactId,
        routedContactId: routing.routedContactId,
        sourceContactId: routing.sourceContactId,
        sourceAuthorId: routing.sourceAuthorId,
        sourceSpeakerName: routing.sourceSpeakerName,
        subjectContactId: routing.subjectContactId,
        subjectName: routing.subjectName,
        addressMode: routing.addressMode,
        scopeRef: routing.scopeRef,
        scopeTags: routing.scopeTags,
        sourceMessageIds: routing.sourceMessageIds,
        sourceSpanStartMessageId: routing.sourceSpanStartMessageId,
        sourceSpanEndMessageId: routing.sourceSpanEndMessageId,
        routingReason: routing.routingReason,
      });
    }

    return this.writer.write({
      text: fact.text,
      type: fact.type,
      importance: fact.importance,
      emotionalValence: fact.emotionalValence,
      formationVAD,
      confidence: fact.confidence,
      // Location tagging (S10): when the turn carried a resolved satellite place,
      // add a `location:<placeId>` marker to the existing generic tags array
      // (tags-based, no schema change). Absent a placeId this is a no-op copy.
      tags: applyLocationTag(fact.tags, placeId),
      retentionClass: fact.retentionClass,
      sourceRef,
      sourceType: triggerReason === 'pre_compaction' ? 'compaction_summary' : undefined,
      ...(routing?.scopeRef ? { scopeRef: routing.scopeRef } : {}),
      ...(routing?.scopeTags ? { scopeTags: routing.scopeTags } : {}),
        provenance: channelId
          ? {
            channelId,
            ...(logicalSessionId ? { sessionId: logicalSessionId } : {}),
            ...(turnId ? { turnId } : {}),
            ...(triggerReason ? { reason: triggerReason } : {}),
          ...(routing?.triggerContactId ? { triggerContactId: routing.triggerContactId } : {}),
          ...(routing?.routedContactId ? { routedContactId: routing.routedContactId } : {}),
          ...(routing?.sourceContactId ? { sourceContactId: routing.sourceContactId } : {}),
          ...(routing?.sourceAuthorId ? { sourceAuthorId: routing.sourceAuthorId } : {}),
          ...(routing?.sourceSpeakerName ? { sourceSpeakerName: routing.sourceSpeakerName } : {}),
          ...(routing?.subjectContactId ? { subjectContactId: routing.subjectContactId } : {}),
          ...(routing?.subjectName ? { subjectName: routing.subjectName } : {}),
          ...(routing?.addressMode ? { addressMode: routing.addressMode } : {}),
          ...(routing?.routingReason ? { routingReason: routing.routingReason } : {}),
          ...(routing?.sourceMessageIds ? { sourceMessageIds: routing.sourceMessageIds } : {}),
          ...(routing?.sourceSpanStartMessageId
            ? { sourceSpanStartMessageId: routing.sourceSpanStartMessageId }
            : {}),
          ...(routing?.sourceSpanEndMessageId
            ? { sourceSpanEndMessageId: routing.sourceSpanEndMessageId }
            : {}),
        }
        : undefined,
      sensitivity: fact.sensitivity,
      contactId: factContactId,
    });
  }

  private async resolveSourceSpeakerContactId(
    channelId: string,
    speaker: ExtractionSourceSpeaker,
  ): Promise<string | undefined> {
    if (!this.contactStore) return undefined;

    const authorId = speaker.authorId?.trim();
    if (authorId) {
      const channel = resolveExtractionIdentityChannel(channelId);
      const byChannelIdentity = await this.contactStore.getByChannelIdentity(channel, authorId);
      if (byChannelIdentity) return byChannelIdentity.id;

      if (channel === 'discord') {
        const byDiscordUserId = await this.contactStore.getByDiscordUserId(authorId);
        if (byDiscordUserId) return byDiscordUserId.id;
      }
    }

    const speakerNameKey = normalizeContactNameKey(speaker.name);
    if (!speakerNameKey || GENERIC_SOURCE_SPEAKER_KEYS.has(speakerNameKey)) return undefined;

    const matches = (await this.contactStore.listAll())
      .filter((contact) => {
        const contactName = resolvePreferredContactName(contact, contact.displayName);
        return normalizeContactNameKey(contactName) === speakerNameKey;
      });
    return matches.length === 1 ? matches[0].id : undefined;
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
    const targetContact = this.contactStore && typeof this.contactStore.getById === 'function'
      ? await this.contactStore.getById(canonicalContactId)
      : undefined;
    await runProfileRefresh({
      llmClient: this.llmClient,
      promptRegistry: this.promptRegistry,
      personaPreamble: this.personaPreamble,
      memoryStore: this.memoryStore,
      channelId,
      triggerReason,
      canonicalContactId,
      targetContact,
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
    void persistEmotionalStateFromExtraction({
      canonicalContactId,
      acceptedFacts,
      recentEntries,
      contactStore: this.contactStore,
      telemetryEnabled: this.isTelemetryEnabled(),
    }).catch((error: unknown) => {
      log.warn('Failed to persist emotional state from extraction', {
        canonicalContactId: canonicalContactId ?? null,
        acceptedFactCount: acceptedFacts.length,
        recentEntryCount: recentEntries.length,
        error: toErrorMessage(error),
      });
    });
  }

  private isTelemetryEnabled(): boolean {
    return resolveTelemetryEnabled(this.runtimeConfig, this.telemetryEnabled);
  }
}

const GENERIC_SOURCE_SPEAKER_KEYS = new Set([
  'assistant',
  'companion',
  'the assistant',
  'the companion',
  'the user',
  'user',
]);

function resolveExtractionIdentityChannel(channelId: string): string {
  if (channelId.startsWith('discord:') || channelId.startsWith('discord-voice:')) return 'discord';
  if (channelId.startsWith('api:')) return 'api';
  if (channelId.startsWith('telegram:')) return 'telegram';
  if (channelId.startsWith('internal:')) return 'internal';

  const separatorIndex = channelId.indexOf(':');
  if (separatorIndex > 0) return channelId.slice(0, separatorIndex);
  return 'unknown';
}

function normalizeContactNameKey(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export { parseFactsXml };

export type {
  MemoryExtractorConfig,
  MemoryExtractorDrainOptions,
} from './extraction/types.js';

export const __test = {
  evaluateFactAcceptance,
  evaluateExtractionPreLlmGate,
  computeNoveltyScore,
  computeProfileNovelty,
  deriveEmotionalSignal,
  resetLastExtractionCount,
};
