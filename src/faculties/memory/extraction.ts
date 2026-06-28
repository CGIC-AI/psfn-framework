import type { EmbeddingProviderPort, LLMProviderPort } from '../../core/agent/contracts.js';
import type { PromptRegistryStatePort } from '../../core/identity/prompt-state-port.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import { resolvePreferredContactName } from '../../core/contacts/preferred-name.js';
import type { SessionManager } from '../../core/session/manager.js';
import type { SessionStore } from '../../persistence/sessions/store.js';
import type { SessionEntry } from '../../core/session/types.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { GroupMemoryWriteCapSettings } from '../../system/config/group-memory-config.js';
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
  evaluateExtractionPreLlmGate,
  evaluateFactAcceptance,
} from './extraction/signals.js';
import { parseFactsXml } from './extraction/parser.js';

const log = createComponentLogger('Extraction');

export interface MemoryExtractorFormationOptions {
  getFormationVAD?: () => MemoryFormationVAD | undefined;
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
    return true;
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
    const resolvedChannelId = this.sessionManager.resolveSessionChannelId(channelId);
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
    groupOptions?: Pick<ExtractionRunOptions, 'groupWriteCaps' | 'groupWriteCapContext'>,
  ): Promise<void> {
    const existing = this.inFlightByChannel.get(channelId);
    if (existing) {
      log.debug('Reusing in-flight extraction', { channelId, triggerReason });
      return existing;
    }

    const promise = this.runExtraction(
      channelId,
      triggerReason,
      canonicalContactId,
      recoveredEntries,
      turnId,
      groupOptions,
    );
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
    groupOptions?: Pick<ExtractionRunOptions, 'groupWriteCaps' | 'groupWriteCapContext'>,
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
      useCompositionalExtraction: this.shouldUseCompositionalExtraction(channelId),
      isAcceptingExtractions: () => this.acceptingExtractions,
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
          canonicalContactName,
          this.sessionManager.characterName,
          triggerReason,
          turnId,
          routing,
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
    triggerReason?: ExtractionTriggerReason,
    turnId?: TurnID,
    routing?: ExtractionFactRouting,
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
      tags: fact.tags,
      sourceRef,
      sourceType: triggerReason === 'pre_compaction' ? 'compaction_summary' : undefined,
      ...(routing?.scopeRef ? { scopeRef: routing.scopeRef } : {}),
      ...(routing?.scopeTags ? { scopeTags: routing.scopeTags } : {}),
      provenance: channelId
        ? {
          channelId,
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
export {
  classifyGroupMemoryChannel,
  resolveGroupMemorySettingsForChannel,
} from './extraction/group-classifier.js';
export {
  buildGroupMemoryRangePlan,
  createEmptyWatermark,
  GROUP_MEMORY_POLICY_VERSION,
  JsonGroupMemoryWatermarkStore,
} from './extraction/group-ranges.js';
export {
  GROUP_MEMORY_SALIENCE_REASON_CODES,
  GROUP_MEMORY_SALIENCE_SKIP_REASONS,
  selectGroupMemorySalienceCandidates,
} from './extraction/group-salience.js';
export {
  computeGroupMemoryWriteCandidateScore,
  selectGroupMemoryWriteCandidates,
} from './extraction/group-write-caps.js';

export type {
  GroupMemoryWriteCapSkip,
  GroupMemoryWriteCapSkipReason,
  MemoryExtractorConfig,
  MemoryExtractorDrainOptions,
} from './extraction/types.js';
export type {
  GroupMemoryChannelTopology,
  GroupMemoryClassification,
  GroupMemoryClassificationMode,
  GroupMemoryClassificationReason,
  GroupMemoryModeSource,
  GroupMemoryParticipantWindow,
  GroupMemoryRecentParticipant,
  GroupMemoryResolvedSettings,
  GroupMemorySessionReader,
  GroupMemoryTopologyKind,
  GroupMemoryTopologyResolution,
  GroupMemoryTopologySource,
} from './extraction/group-classifier.js';
export type {
  GroupMemoryFailureInput,
  GroupMemoryFailureRecord,
  GroupMemoryRangeChunk,
  GroupMemoryRangePlan,
  GroupMemoryRangePlanOptions,
  GroupMemoryRangeSessionReader,
  GroupMemorySpanRecord,
  GroupMemoryWatermarkMutationInput,
  GroupMemoryWatermarkRecord,
  GroupMemoryWatermarkStatus,
  GroupMemoryWatermarkStorePort,
} from './extraction/group-ranges.js';
export type {
  GroupMemorySalienceCandidateSpan,
  GroupMemorySalienceReason,
  GroupMemorySalienceSelection,
  GroupMemorySalienceSelectionOptions,
  GroupMemorySalienceSkipReason,
  GroupMemorySalienceTelemetry,
} from './extraction/group-salience.js';
export type {
  GroupMemoryWriteCandidate,
  GroupMemoryWriteCandidateRouting,
  GroupMemoryWriteSelection,
  GroupMemoryWriteSelectionOptions,
  GroupMemoryWriteSelectionTelemetry,
} from './extraction/group-write-caps.js';

export const __test = {
  evaluateFactAcceptance,
  evaluateExtractionPreLlmGate,
  computeNoveltyScore,
  computeProfileNovelty,
  deriveEmotionalSignal,
  resetLastExtractionCount,
};
