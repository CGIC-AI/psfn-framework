import type {
  FinalReflectionExtractionInput,
  LLMProviderPort,
  MemoryExtractionOutputs,
} from '../../core/agent/contracts.js';
import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import type { PromptRegistryStatePort } from '../../core/identity/prompt-state-port.js';
import type { PersonaPreamblePort } from '../../core/identity/persona-preamble.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { Contact } from '../../core/contacts/types.js';
import { resolvePreferredContactName } from '../../core/contacts/preferred-name.js';
import type { SessionStore } from '../../persistence/sessions/store.js';
import type { SessionEntry } from '../../core/session/types.js';
import { isTestingSessionId } from '../../core/session/session-id.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { BiographicalDepthPolicy } from '../../system/config/biographical-depth-policy.js';
import type { GroupMemoryWriteCapSettings } from '../../system/config/group-memory-config.js';
import type { TurnID } from '../../shared/contracts/runtime.js';
import type { IcpConversationCorrelation } from '../../shared/contracts/icp-autonomy.js';
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
import { RECOVERY_CONTEXT_MESSAGE_LIMIT } from './extraction/types.js';
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
import { ExtractionDrainRequeueError } from './extraction/drain-signal.js';
import { refreshRecentContactShape as runRecentContactShapeRefresh } from './extraction/recent-contact-shape-synthesis.js';
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
  evaluateExtractionTriggerForSnapshot,
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
import type { MemoryExtractionSessionPort } from './extraction/session-port.js';
import { projectFinalReflectionForExtraction } from './extraction/reflection-output.js';
import type { BiographicalProfileStorePort } from './biographical/store-port.js';
import type { BiographicalSubjectRef } from './biographical/types.js';
import { deriveBiographicalCollectionDepth } from './biographical/depth-policy.js';

const log = createComponentLogger('Extraction');

function resolveContactBiographicalDepth(
  contactId: string,
  contact: Contact | undefined,
  policy: BiographicalDepthPolicy,
) {
  const subject = { kind: 'contact' as const, contactId, subjectVersion: 1 };
  if (!contact || contact.id !== contactId || contact.archivedAt) {
    return deriveBiographicalCollectionDepth({ subject, policy });
  }
  const relationshipType = contact.relationshipType === 'partner'
    || contact.relationshipType === 'friend'
    || contact.relationshipType === 'family'
    ? contact.relationshipType
    : 'other';
  return deriveBiographicalCollectionDepth({
    subject,
    policy,
    contactEvidence: {
      subject,
      canonicalContactVerified: true,
      trust: {
        verified: true,
        level: contact.trustLevel,
        authorityRef: `contact-store:${contact.id}:trust`,
      },
      relationship: {
        verified: true,
        type: relationshipType,
        authorityRef: `contact-store:${contact.id}:relationship`,
      },
      governedContexts: [],
    },
  });
}

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
   * recent-contact-shape-synthesis prompts are prefixed with the companion's soft persona
   * framing before their strict schema-bound instructions.
   */
  personaPreamble?: PersonaPreamblePort | null;
  biographicalRebuild?: {
    profileStore: BiographicalProfileStorePort;
    companionSubject: Extract<BiographicalSubjectRef, { kind: 'companion' }>;
    policy: BiographicalDepthPolicy;
  };
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

type MemoryExtractorRunOptions =
  Pick<ExtractionRunOptions, 'groupWriteCaps' | 'groupWriteCapContext'>
  & {
    forceSinglePassExtraction?: boolean;
    reflectionSource?: FinalReflectionExtractionInput;
  };

export class MemoryExtractor {
  private llmClient: LLMProviderPort;
  private sessionManager: MemoryExtractionSessionPort;
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
  private inFlightExtractions = new Set<Promise<MemoryExtractionOutputs>>();
  private inFlightByChannel = new Map<string, Promise<MemoryExtractionOutputs>>();
  private inFlightProfileRefreshes = new Set<Promise<void>>();
  private inFlightProfileByContact = new Map<string, Promise<void>>();
  private getFormationVAD: (() => MemoryFormationVAD | undefined) | null = null;
  private emitConcernCandidates: ConcernCandidateExtractionSink | null = null;
  private isAutoContactCreationAllowed: ((channelId: string) => boolean) | null = null;
  private personaPreamble: PersonaPreamblePort | null = null;
  private biographicalRebuild: MemoryExtractorFormationOptions['biographicalRebuild'] = undefined;

  constructor(
    llmClient: LLMProviderPort,
    sessionManager: MemoryExtractionSessionPort,
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
    this.writer = new MemoryWriter(memoryStore, embeddingService, {
      ...(config && 'primaryModel' in config
        ? { memoryRetrievalPolicy: () => config.memoryRetrievalPolicy }
        : {}),
    });
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
    this.biographicalRebuild = formationOptions?.biographicalRebuild;
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
    icpCorrelation?: IcpConversationCorrelation,
    assertEffectAllowed?: () => Promise<void>,
    recoveredEntries?: readonly SessionEntry[],
    // NON-crossing durable fence for the pre-write phase (entry, LLM, parse, DB
    // reads). Separate from `assertEffectAllowed`, which crosses the durable
    // side-effect boundary and must fire only at the write sites.
    assertPreWriteFence?: () => Promise<void>,
    // mmo9.7.4: a welfare-escalated durable claim marks its model call
    // preemption-protected so the aged job runs to completion instead of being
    // gate-preempted back into the defer loop. fxt1: the granting job id rides
    // alongside so the gateway can re-verify the welfare escalation.
    extractOptions?: { preemptionProtected?: boolean; welfareGrantJobId?: string },
  ): Promise<MemoryExtractionOutputs | void> {
    if (!this.acceptingExtractions) {
      log.debug('Skipping extraction trigger while extractor is draining', { channelId });
      return;
    }

    const boundedEntries = recoveredEntries !== undefined ? [...recoveredEntries] : undefined;
    const trigger = boundedEntries === undefined
      ? evaluateExtractionTrigger(
        channelId,
        this.sessionManager,
        this.runtimeConfig,
        this.extractionInterval,
      )
      : evaluateExtractionTriggerForSnapshot(
        channelId,
        boundedEntries,
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

    const outputs = await this.trackExtraction(
      channelId,
      trigger.triggerReason,
      canonicalContactId,
      boundedEntries,
      turnId,
      undefined,
      placeId,
      icpCorrelation,
      assertEffectAllowed,
      // A durable bounded callback may complete an effect receipt only after
      // its own snapshot runs; reusing unrelated channel work would drop it.
      boundedEntries === undefined ? 'coalesce' : 'serialize',
      assertPreWriteFence,
      extractOptions?.preemptionProtected,
      extractOptions?.welfareGrantJobId,
    );
    if (boundedEntries !== undefined) {
      this.advanceIntervalWatermarkAfterCoverage(
        channelId,
        trigger.triggerReason,
        boundedEntries,
      );
    }
    return outputs;
  }

  /**
   * Entry count a durable post-turn handler must read into its bounded snapshot
   * for this extractor's interval to be reachable. The interval trigger counts
   * exact uncovered entries inside the supplied snapshot, so a snapshot smaller
   * than the interval can never satisfy it — the original fixed ten-entry window
   * left every configured interval of 11-50 permanently unable to interval-fire.
   *
   * Sized to the effective interval and clamped to the extraction recovery
   * window: the interval upper bound (50) equals that window by construction, so
   * a valid interval is never truncated. The clamp only fails safe on an
   * out-of-contract interval — the snapshot must never exceed the recovery window
   * the orchestrator feeds the LLM, or coverage would advance over entries the
   * extractor never actually processed.
   */
  getBoundedExtractionSnapshotLimit(): number {
    const interval = this.runtimeConfig?.extractionInterval ?? this.extractionInterval;
    const normalized = Number.isSafeInteger(interval) && interval >= 1
      ? interval
      : MEMORY_CONFIG.extractionInterval;
    return Math.max(1, Math.min(normalized, RECOVERY_CONTEXT_MESSAGE_LIMIT));
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

  async extractFinalReflection(input: FinalReflectionExtractionInput): Promise<void> {
    if (!this.acceptingExtractions) {
      log.debug('Skipping final reflection extraction while extractor is draining', {
        channelId: input.channelId,
        journalEntryId: input.journalEntryId,
      });
      return;
    }

    const entry = projectFinalReflectionForExtraction(input, this.sessionManager.characterName);
    await this.trackExtraction(
      input.channelId,
      'reflection_output',
      undefined,
      [entry],
      undefined,
      { reflectionSource: input },
      undefined,
      undefined,
      undefined,
      'serialize',
    );
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
        forceSinglePassExtraction: true,
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
    const pending = this.inFlightByChannel.get(channelId)
      ?? this.inFlightByChannel.get(resolvedChannelId)
      ?? null;
    return pending ? pending.then(() => undefined) : null;
  }

  private trackExtraction(
    channelId: string,
    triggerReason: ExtractionTriggerReason,
    canonicalContactId?: string,
    recoveredEntries?: SessionEntry[],
    turnId?: TurnID,
    groupOptions?: MemoryExtractorRunOptions,
    placeId?: string,
    icpCorrelation?: IcpConversationCorrelation,
    assertEffectAllowed?: () => Promise<void>,
    scheduling: 'coalesce' | 'serialize' = 'coalesce',
    assertPreWriteFence?: () => Promise<void>,
    preemptionProtected?: boolean,
    welfareGrantJobId?: string,
  ): Promise<MemoryExtractionOutputs> {
    const logicalSessionId = this.resolveExtractionLogicalSessionId(channelId);
    const existing = this.inFlightByChannel.get(logicalSessionId);
    if (existing && scheduling === 'coalesce') {
      log.debug('Reusing in-flight extraction', { channelId, logicalSessionId, triggerReason });
      return existing;
    }

    const start = () => this.runExtraction(
      channelId,
      logicalSessionId,
      triggerReason,
      canonicalContactId,
      recoveredEntries,
      turnId,
      groupOptions,
      placeId,
      icpCorrelation,
      assertEffectAllowed,
      assertPreWriteFence,
      preemptionProtected,
      welfareGrantJobId,
    );
    const promise = existing
      ? existing.then(start, start)
      : start();
    if (existing) {
      log.debug('Queued bounded extraction behind in-flight channel work', {
        channelId,
        logicalSessionId,
        triggerReason,
      });
    }
    this.inFlightExtractions.add(promise);
    this.inFlightByChannel.set(logicalSessionId, promise);
    void promise
      .catch((error) => {
        if (error instanceof ExtractionDrainRequeueError) {
          // Expected control-flow signal on shutdown: a queued durable run failed
          // closed before writing so its job/receipt stay retryable. Not a failure.
          log.debug('Requeued durable bounded extraction interrupted by drain before it wrote', {
            channelId,
            logicalSessionId,
            triggerReason,
          });
          return;
        }
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
    groupOptions?: MemoryExtractorRunOptions,
    placeId?: string,
    icpCorrelation?: IcpConversationCorrelation,
    assertEffectAllowed?: () => Promise<void>,
    assertPreWriteFence?: () => Promise<void>,
    preemptionProtected?: boolean,
    welfareGrantJobId?: string,
  ): Promise<MemoryExtractionOutputs> {
    if (isTestingSessionId(logicalSessionId)) {
      log.debug('Skipping durable extraction for testing session', {
        channelId,
        logicalSessionId,
        triggerReason,
      });
      return { memoryIds: [], concernIds: [], contactIds: [] };
    }
    // u5bv.11: A durable, receipt-bound bounded run (assertEffectAllowed present)
    // can be queued behind other same-session work under serialize scheduling. If
    // the extractor began draining while this run waited its turn, fail closed —
    // retryable — BEFORE crossing the effect boundary or advancing coverage.
    // Resolving normally here is the silent-loss bug: maybeExtract would mark the
    // snapshot covered and the background receipt would complete `applied` without
    // ever writing its facts. Foreground/manual/group drains (no receipt) keep
    // their intentional silent skip and never reach this guard.
    if (assertEffectAllowed && !this.acceptingExtractions) {
      throw new ExtractionDrainRequeueError(channelId, triggerReason);
    }
    // Entry guard on the pre-write phase: use the NON-crossing fence so a
    // transient failure in the LLM/parse/read work below leaves the durable
    // receipt `pending` (safely retryable) instead of crossing the side-effect
    // boundary early. The boundary is crossed later, at the first durable write
    // (processFact / extraction marker), via `assertEffectAllowed`. Callers that
    // supply no pre-write fence fall back to the prior behavior.
    await (assertPreWriteFence ?? assertEffectAllowed)?.();
    if (!this.isExtractionSessionCurrent(channelId, logicalSessionId)) {
      log.debug('Skipping stale extraction after session route changed', {
        channelId,
        logicalSessionId,
        triggerReason,
      });
      return { memoryIds: [], concernIds: [], contactIds: [] };
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
    const reflectionSource = groupOptions?.reflectionSource;
    const extractionSourceSessionId = reflectionSource
      ? `reflection-journal:${reflectionSource.journalEntryId}`
      : logicalSessionId;

    const mutatedContactIds = new Set<string>();
    const mutatedMemoryIds = new Set<string>();

    const outputs = await runExtractionOrchestration({
      channelId,
      triggerReason,
      canonicalContactId,
      turnId,
      sourceSessionId: extractionSourceSessionId,
      recoveredEntries,
      icpCorrelation,
      ...(preemptionProtected ? { preemptionProtected: true } : {}),
      ...(welfareGrantJobId ? { welfareGrantJobId } : {}),
      resolveParticipantNames: (recentEntries, extractionCanonicalContactId) => resolveExtractionParticipantNames({
        entries: recentEntries,
        canonicalContactName: extractionCanonicalContactId ? canonicalContactName : undefined,
        companionName: this.sessionManager.characterName,
      }),
      resolveSourceSpeakerContactId: speaker => this.resolveSourceSpeakerContactId(channelId, speaker),
      ...(this.runtimeConfig?.discordBotId
        ? { companionAuthorIds: [this.runtimeConfig.discordBotId] }
        : {}),
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
      useCompositionalExtraction: groupOptions?.forceSinglePassExtraction
        ? false
        : this.shouldUseCompositionalExtraction(channelId),
      isAcceptingExtractions: () => (
        this.acceptingExtractions
        && this.isExtractionSessionCurrent(channelId, logicalSessionId)
      ),
      // u5bv.11: distinguishes a drain (extractor stopping) from a stale session
      // route so the orchestrator can fail a durable run closed on a mid-flight
      // drain instead of resolving it as a covered no-op.
      isDraining: () => !this.acceptingExtractions,
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
          extractionSourceSessionId,
          canonicalContactName,
          this.sessionManager.characterName,
          triggerReason,
          turnId,
          routing,
          placeId,
          assertEffectAllowed,
          reflectionSource,
          contactId => mutatedContactIds.add(contactId),
          memoryId => mutatedMemoryIds.add(memoryId),
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
        reflectionSource
          ? undefined
          : persistExtractionMarker(this.sessionStore, logicalSessionId, coveredUpToMessageId)
      ),
      maybePersistEmotionalState: (contactId, acceptedFacts, recentEntries) => (
        this.maybePersistEmotionalState(
          logicalSessionId,
          contactId,
          acceptedFacts,
          recentEntries,
        )
      ),
      maybeRefreshRecentContactShape: (
        extractionChannelId,
        reason,
        contactId,
        acceptedWrites,
      ) => this.maybeRefreshRecentContactShape(
        logicalSessionId,
        extractionChannelId,
        reason,
        contactId,
        acceptedWrites,
      ),
      ...(this.emitConcernCandidates
        ? { emitConcernCandidates: this.emitConcernCandidates }
        : {}),
      ...(assertEffectAllowed ? { assertEffectAllowed } : {}),
    });
    return {
      ...outputs,
      memoryIds: [...new Set([...outputs.memoryIds, ...mutatedMemoryIds])],
      contactIds: [...new Set([...outputs.contactIds, ...mutatedContactIds])],
    };
  }

  private hasInFlightExtraction(channelId: string): boolean {
    return this.inFlightByChannel.has(this.resolveExtractionLogicalSessionId(channelId));
  }

  /**
   * Advances the interval watermark after an explicit bounded extraction
   * successfully consumed its snapshot. Callers must invoke this only after
   * the awaited extraction resolved and only when that snapshot was consumed
   * by this run — on failure the watermark stays put so no content is skipped.
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
    assertEffectAllowed?: () => Promise<void>,
    reflectionSource?: FinalReflectionExtractionInput,
    recordMutatedContactId?: (contactId: string) => void,
    recordMutatedMemoryId?: (memoryId: string) => void,
  ): Promise<WriteResult> {
    await assertEffectAllowed?.();
    const selfDirectedMemory = routing?.routingReason === 'self_directed_companion';
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
        ...(recordMutatedContactId ? { onContactCreated: recordMutatedContactId } : {}),
        ...(recordMutatedMemoryId ? { onMemoryRelinked: recordMutatedMemoryId } : {}),
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
      const relationshipMutation = await resolveInterlocutorRelationshipRatchet({
        fact,
        interlocutorContactId: canonicalContactId,
        contactStore: this.contactStore,
        canonicalContactName,
        companionName,
      });
      if (relationshipMutation) recordMutatedContactId?.(canonicalContactId);
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

    await assertEffectAllowed?.();
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
      sourceType: selfDirectedMemory
        ? 'reflection'
        : triggerReason === 'pre_compaction'
          ? 'compaction_summary'
          : undefined,
      ...(routing?.scopeRef ? { scopeRef: routing.scopeRef } : {}),
      ...(routing?.scopeTags ? { scopeTags: routing.scopeTags } : {}),
        provenance: channelId
          ? {
            channelId,
            ...(logicalSessionId ? { sessionId: logicalSessionId } : {}),
            ...(reflectionSource ? {
              templateId: reflectionSource.templateId,
              templateName: reflectionSource.templateName,
              mode: reflectionSource.mode,
            } : {}),
            ...(turnId ? { turnId } : {}),
            ...(triggerReason ? { reason: triggerReason } : {}),
          ...(selfDirectedMemory ? { actor: 'companion' } : {}),
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
          ...(routing?.sourceConversationAt !== undefined
            ? { sourceConversationAt: routing.sourceConversationAt }
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
    return matches.length === 1 ? matches[0]?.id : undefined;
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

  private maybeRefreshRecentContactShape(
    sourceSessionId: string,
    channelId: string,
    triggerReason: ExtractionTriggerReason,
    canonicalContactId: string | undefined,
    acceptedWrites: AcceptedFactWrite[],
  ): Promise<void> {
    // Returns an awaitable that settles when the (idempotent, contact-id-keyed)
    // profile upsert completes, so the orchestrator can keep the parent receipt
    // open until this durable child finishes rather than detaching it (AC3).
    return scheduleProfileRefresh({
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
        this.refreshRecentContactShape(
          sourceSessionId,
          refreshChannelId,
          refreshReason,
          contactId,
          writes,
          config,
        )
      ),
    });
  }

  private async refreshRecentContactShape(
    sourceSessionId: string,
    channelId: string,
    triggerReason: ExtractionTriggerReason,
    canonicalContactId: string,
    acceptedWrites: AcceptedFactWrite[],
    config: ProfileSynthesisConfig,
  ): Promise<void> {
    const targetContact = this.contactStore && typeof this.contactStore.getById === 'function'
      ? await this.contactStore.getById(canonicalContactId)
      : undefined;
    const biographicalRebuild = this.biographicalRebuild
      ? {
          ...this.biographicalRebuild,
          depth: resolveContactBiographicalDepth(
            canonicalContactId,
            targetContact,
            this.biographicalRebuild.policy,
          ),
        }
      : undefined;
    await runRecentContactShapeRefresh({
      llmClient: this.llmClient,
      promptRegistry: this.promptRegistry,
      personaPreamble: this.personaPreamble,
      memoryStore: this.memoryStore,
      channelId,
      sourceSessionId,
      triggerReason,
      canonicalContactId,
      targetContact,
      acceptedWrites,
      config,
      telemetryEnabled: this.isTelemetryEnabled(),
      ...(biographicalRebuild ? { biographicalRebuild } : {}),
    });
  }

  private maybePersistEmotionalState(
    sourceSessionId: string,
    canonicalContactId: string | undefined,
    acceptedFacts: ExtractedFact[],
    recentEntries: SessionEntry[],
  ): Promise<string | undefined> {
    // Awaited by the orchestrator inside the effect-guarded region so this
    // durable child settles before the parent receipt is applied (u5bv.6 AC3).
    // It runs after the durable write boundary is crossed. Any ambiguous or
    // failed contact write must reject the effect so recovery records
    // effect_outcome_unknown instead of silently omitting its output ref.
    return persistEmotionalStateFromExtraction({
      sourceSessionId,
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
