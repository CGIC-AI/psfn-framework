import type {
  FinalReflectionExtractionInput,
  LLMProviderPort,
  MemoryExtractionOutputs,
} from '../../core/agent/contracts.js';
import { extractionPreGateSkips, type ExtractionPreGateDecisions } from './extraction/decision-pregate.js';
import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import type { PromptRegistryStatePort } from '../../core/identity/prompt-state-port.js';
import type { PersonaPreamblePort } from '../../core/identity/persona-preamble.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { Contact } from '../../core/contacts/types.js';
import { resolveExtractionSourceContactId } from './extraction/contact-resolution.js';
import { resolvePreferredContactName } from '../../core/contacts/preferred-name.js';
import type { SessionStore } from '../../persistence/sessions/store.js';
import type { SessionEntry } from '../../core/session/types.js';
import { isTestingSessionId } from '../../core/session/session-id.js';
import { assertMemorySourceIsNotTestingHarness } from '../../core/session/testing-harness-provenance.js';
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
import { RECOVERY_CONTEXT_MESSAGE_LIMIT, type ExtractionEndTelemetry } from './extraction/types.js';
import { isNonConversationalSessionEntry } from '../../core/session/manager-primitives.js';
import { MemoryWriter, type WriteResult } from './writer.js';
import { createCompanionRoomMembershipAuthority } from './companion-provenance.js';
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
import {
  isCompanionOwnedRouting,
  type ExtractionFactRouting,
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
  selectUncoveredSnapshotEntries,
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
import type { AutomataBusWorkerAccess } from '../automata/bus/worker-access.js';
import type { AutomataTerminalLifecyclePort } from '../automata/terminal-lifecycle.js';
import type { AutomataRunRegistry } from '../automata/run-registry.js';
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
    || contact.relationshipType === 'ai_companion'
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
  /** Typed decisions for the opt-in interval extraction pre-gate (epic 4lf3r). */
  decisions?: ExtractionPreGateDecisions;
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
  /** Companion-bound Automata Bus worker adapter; owner policy gates extraction. */
  automataBusWorkerAccess?: AutomataBusWorkerAccess | null;
  /** Authoritative durable run registry paired with the Bus worker adapter. */
  automataRunRegistry?: AutomataRunRegistry | null;
  /** Durable terminal handoff adapter; receives references, never source text. */
  automataTerminalLifecycle?: AutomataTerminalLifecyclePort | null;
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

export interface DirectBackfillExtractionOptions {
  channelId: string;
  /** One bounded chunk of conversational entries from an existing transcript. */
  recoveredEntries: SessionEntry[];
  canonicalContactId?: string;
}

export interface DirectBackfillExtractionResult {
  outputs: MemoryExtractionOutputs;
  telemetry: ExtractionEndTelemetry;
}

type MemoryExtractorRunOptions =
  Pick<ExtractionRunOptions, 'groupWriteCaps' | 'groupWriteCapContext'>
  & {
    forceSinglePassExtraction?: boolean;
    reflectionSource?: FinalReflectionExtractionInput;
    externalConversation?: true;
    /**
     * Operator replay of an old transcript range. Facts go through the normal
     * routing and write path, but present-tense side effects (current formation
     * mood, concern candidates, contact emotional state, Recent Contact Shape)
     * are not derived from historical messages.
     */
    historicalReplay?: true;
    onExtractionEnd?: (telemetry: ExtractionEndTelemetry) => void;
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
  private automataBusWorkerAccess: AutomataBusWorkerAccess | null = null;
  private automataRunRegistry: AutomataRunRegistry | null = null;
  private automataTerminalLifecycle: AutomataTerminalLifecyclePort | null = null;
  private biographicalRebuild: MemoryExtractorFormationOptions['biographicalRebuild'] = undefined;
  private decisions: MemoryExtractorFormationOptions['decisions'] = undefined;

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
        ? {
            memoryRetrievalPolicy: () => config.memoryRetrievalPolicy,
            ...(config.companionId ? { companionId: config.companionId } : {}),
            ...(sessionStore
              ? { roomMembershipAuthority: createCompanionRoomMembershipAuthority(sessionStore) }
              : {}),
          }
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
    this.automataBusWorkerAccess = formationOptions?.automataBusWorkerAccess ?? null;
    this.automataRunRegistry = formationOptions?.automataRunRegistry ?? null;
    this.automataTerminalLifecycle = formationOptions?.automataTerminalLifecycle ?? null;
    this.biographicalRebuild = formationOptions?.biographicalRebuild;
    this.decisions = formationOptions?.decisions;
  }

  /**
   * Re-extract one bounded chunk of an existing direct or companion-DM
   * transcript for the operator backfill (psfn-framework-d5e0p.17). The chunk
   * is serialized behind live work on the same session (never coalesced into
   * it), and resolves only when the run actually completed: a drain, a
   * retired/quarantined session or a session route change rejects, so the
   * caller never records an unprocessed range as covered.
   */
  async extractDirectBackfillRange(
    options: DirectBackfillExtractionOptions,
  ): Promise<DirectBackfillExtractionResult> {
    const channelId = options.channelId.trim();
    if (!channelId || isTestingSessionId(channelId)) {
      throw new Error('Direct backfill extraction requires a non-testing session');
    }
    const entries = options.recoveredEntries
      .filter(entry => !isNonConversationalSessionEntry(entry))
      .map(entry => ({ ...entry }))
      .sort((left, right) => left.id - right.id);
    if (
      entries.length === 0
      || entries.length > RECOVERY_CONTEXT_MESSAGE_LIMIT
      || new Set(entries.map(entry => entry.id)).size !== entries.length
    ) {
      throw new Error(
        `Direct backfill extraction requires 1-${RECOVERY_CONTEXT_MESSAGE_LIMIT} unique conversational entries`,
      );
    }
    assertMemorySourceIsNotTestingHarness(entries);
    const logicalSessionId = this.resolveExtractionLogicalSessionId(channelId);
    const assertEligible = async (): Promise<void> => {
      if (!this.acceptingExtractions) {
        throw new ExtractionDrainRequeueError(channelId, 'operator_backfill');
      }
      if (!this.isExtractionSessionCurrent(channelId, logicalSessionId)) {
        throw new Error('Direct backfill source session is retired, quarantined or rerouted');
      }
    };
    await assertEligible();
    const completed: { telemetry?: ExtractionEndTelemetry } = {};
    const outputs = await this.trackExtraction(
      channelId,
      'operator_backfill',
      options.canonicalContactId,
      entries,
      undefined,
      {
        forceSinglePassExtraction: true,
        historicalReplay: true,
        onExtractionEnd: (value) => { completed.telemetry = value; },
      },
      undefined,
      undefined,
      assertEligible,
      'serialize',
      assertEligible,
    );
    // A completed run either passed the pre-LLM gate decision or recorded the
    // coverage of the range; the stale-route skip emits neither.
    const telemetry = completed.telemetry;
    if (!telemetry || (telemetry.preLlmGateSkipped !== true && telemetry.coveredUpToMessageId === undefined)) {
      throw new Error('Direct backfill extraction did not complete for its range');
    }
    return { outputs, telemetry };
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
    extractOptions?: { preemptionProtected?: boolean; welfareGrantJobId?: string; automataOwnerRunId?: string },
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
    const uncoveredBoundedEntries = boundedEntries === undefined
      ? undefined
      : selectUncoveredSnapshotEntries(channelId, boundedEntries);
    // Epic 4lf3r: only the "every N messages" interval trigger may be
    // pre-gated — the live foreground path and the durable post-turn snapshot
    // path alike. Threshold, pre-compaction, crash-recovery and manual runs
    // never are.
    if (
      trigger.triggerReason === 'interval'
      && this.decisions?.siteSettings('memory.extraction_pregate')?.enabled === true
      && await extractionPreGateSkips({
        decisions: this.decisions,
        channelId,
        entries: boundedEntries === undefined
          ? this.sessionManager.getRecentMessages(channelId, trigger.currentCount - trigger.lastCount)
          : uncoveredBoundedEntries!,
      })
    ) {
      log.debug('Extraction pre-gate found nothing to remember; skipping this interval', { channelId });
      // The foreground trigger already consumed its interval; a skipped bounded
      // snapshot consumes its interval the same way so the next post-turn job
      // does not re-ask about the same messages.
      if (boundedEntries !== undefined) {
        this.advanceIntervalWatermarkAfterCoverage(channelId, trigger.triggerReason, boundedEntries);
      }
      return;
    }

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

    const extractionEntries = boundedEntries === undefined
      ? undefined
      : (uncoveredBoundedEntries && uncoveredBoundedEntries.length > 0
        ? uncoveredBoundedEntries
        : boundedEntries);
    const outputs = await this.trackExtraction(
      channelId,
      trigger.triggerReason,
      canonicalContactId,
      extractionEntries,
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
      extractOptions?.automataOwnerRunId,
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
   * Countable conversational entry bound a durable post-turn handler reads
   * into its snapshot. Returning the full recovery window (50) ensures every
   * uncovered conversational entry since the channel's extraction coverage
   * watermark is captured — including odd/small intervals where multi-message
   * turns jump past `interval` (e.g. 4 -> 6 on interval 5) and would otherwise
   * drop the oldest uncovered user message (psfn-framework-d5e0p.13).
   */
  getBoundedExtractionSnapshotLimit(): number {
    return RECOVERY_CONTEXT_MESSAGE_LIMIT;
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

  /** Process an admitted external transcript snapshot without a foreground turn. */
  async extractExternalConversation(input: {
    sessionId: string;
    entries: readonly SessionEntry[];
    canonicalContactId: string;
  }): Promise<MemoryExtractionOutputs> {
    const sessionId = input.sessionId.trim();
    const canonicalContactId = input.canonicalContactId.trim();
    if (!sessionId || !canonicalContactId || isTestingSessionId(sessionId)) {
      throw new Error('External conversation extraction requires a non-testing session and canonical contact');
    }
    const entries = input.entries.map(entry => ({ ...entry })).sort((left, right) => left.id - right.id);
    if (entries.length === 0 || entries.length > RECOVERY_CONTEXT_MESSAGE_LIMIT
      || entries.some(entry => (
        entry.channelId !== sessionId
        || !Number.isSafeInteger(entry.id) || entry.id < 1
        || (entry.role !== 'user' && entry.role !== 'assistant')
        || !entry.content.trim()
        || !Number.isFinite(entry.timestamp)
      ))
      || new Set(entries.map(entry => entry.id)).size !== entries.length) {
      throw new Error('External conversation extraction requires a bounded, unique conversational snapshot for its exact session');
    }
    assertMemorySourceIsNotTestingHarness(entries);
    const sessionStore = this.sessionStore;
    if (!sessionStore) {
      throw new Error('External conversation extraction requires the canonical session store');
    }
    const assertEligible = async (): Promise<void> => {
      if (!this.acceptingExtractions) {
        throw new ExtractionDrainRequeueError(sessionId, 'external_conversation');
      }
      if (!this.isExtractionSessionCurrent(sessionId, sessionId, true)) {
        throw new Error('External conversation extraction source session is retired or quarantined');
      }
    };
    await assertEligible();
    return this.trackExtraction(
      sessionId,
      'external_conversation',
      canonicalContactId,
      entries,
      undefined,
      { externalConversation: true },
      undefined,
      undefined,
      assertEligible,
      'serialize',
      assertEligible,
    );
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
    automataOwnerRunId?: string,
  ): Promise<MemoryExtractionOutputs> {
    const logicalSessionId = groupOptions?.externalConversation
      ? channelId
      : this.resolveExtractionLogicalSessionId(channelId);
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
      automataOwnerRunId,
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
    automataOwnerRunId?: string,
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
    if (!this.isExtractionSessionCurrent(channelId, logicalSessionId, groupOptions?.externalConversation)) {
      log.debug('Skipping stale extraction after session route changed', {
        channelId,
        logicalSessionId,
        triggerReason,
      });
      return { memoryIds: [], concernIds: [], contactIds: [] };
    }
    let cachedFormationVAD: MemoryFormationVAD | undefined;
    let didResolveFormationVAD = false;
    const historicalReplay = groupOptions?.historicalReplay === true;
    const resolveFormationVAD = (): MemoryFormationVAD | undefined => {
      // The companion's current mood is not the mood these old messages formed in.
      if (historicalReplay) return undefined;
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
      ...(automataOwnerRunId ? { automataOwnerRunId } : {}),
      resolveParticipantNames: (recentEntries, extractionCanonicalContactId) => resolveExtractionParticipantNames({
        entries: recentEntries,
        canonicalContactName: extractionCanonicalContactId ? canonicalContactName : undefined,
        companionName: this.sessionManager.characterName,
      }),
      resolveSourceSpeakerContactId: speaker => resolveExtractionSourceContactId(channelId, speaker, this.contactStore),
      resolveContacts: async () => this.contactStore ? this.contactStore.listAll() : [],
      ...(this.runtimeConfig?.discordBotId
        ? { companionAuthorIds: [this.runtimeConfig.discordBotId] }
        : {}),
      llmClient: this.llmClient,
      sessionManager: this.sessionManager,
      memoryStore: this.memoryStore,
      promptRegistry: this.promptRegistry,
      personaPreamble: this.personaPreamble,
      automataBusWorkerAccess: this.automataBusWorkerAccess,
      automataRunRegistry: this.automataRunRegistry,
      automataTerminalLifecycle: this.automataTerminalLifecycle,
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
        && this.isExtractionSessionCurrent(channelId, logicalSessionId, groupOptions?.externalConversation)
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
      emitExtractionEnd: (telemetry) => {
        groupOptions?.onExtractionEnd?.(telemetry);
        return emitExtractionEndEvent(this.costTelemetry, this.isTelemetryEnabled(), telemetry);
      },
      resolveCoveredUpToMessageId: (extractionChannelId, entries) => (
        resolveCoveredMarker(this.sessionManager, extractionChannelId, entries)
      ),
      recordExtractionMarker: (_extractionChannelId, coveredUpToMessageId) => (
        reflectionSource || groupOptions?.externalConversation
          ? undefined
          : persistExtractionMarker(this.sessionStore, logicalSessionId, coveredUpToMessageId)
      ),
      maybePersistEmotionalState: (contactId, acceptedFacts, recentEntries) => (
        historicalReplay
          ? Promise.resolve(undefined)
          : this.maybePersistEmotionalState(
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
      ) => (
        historicalReplay
          ? Promise.resolve()
          : this.maybeRefreshRecentContactShape(
            logicalSessionId,
            extractionChannelId,
            reason,
            contactId,
            acceptedWrites,
          )
      ),
      ...(this.emitConcernCandidates && !historicalReplay
        ? { emitConcernCandidates: this.emitConcernCandidates }
        : {}),
      ...(assertEffectAllowed ? { assertEffectAllowed } : {}),
    });
    if (groupOptions?.externalConversation) {
      await assertEffectAllowed?.();
      // External receipts complete only after the exact snapshot and all its
      // effects finish. Keep marker failures retryable and inside serialization.
      this.sessionStore!.insertExtractionMarker(logicalSessionId, recoveredEntries!.at(-1)!.id);
      advanceExtractionWatermarkForCoverage(logicalSessionId, recoveredEntries!);
    }
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

  private isExtractionSessionCurrent(
    channelId: string,
    logicalSessionId: string,
    capturedLogicalSession = false,
  ): boolean {
    const isRetired = this.sessionManager.isSessionRetiredOrQuarantined;
    if (typeof isRetired === 'function' && isRetired.call(this.sessionManager, logicalSessionId)) {
      return false;
    }
    return capturedLogicalSession || this.resolveExtractionLogicalSessionId(channelId) === logicalSessionId;
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
    const companionOwned = isCompanionOwnedRouting(routing?.routingReason);
    let resolvedRouting = routing;
    let factContactId = canonicalContactId;
    // Contact-tracking policy gate (E3.4): non-'auto' channels must not have
    // extraction create contact rows (mention-only path included). Facts keep
    // speaker-name provenance; they just gain no contact-keyed records.
    const contactCreationAllowed = !channelId
      || this.isAutoContactCreationAllowed === null
      || this.isAutoContactCreationAllowed(channelId);
    if (
      !companionOwned && !routing?.subjectContactId
      && (fact.type === 'relational' || routing?.routingReason === 'unresolved_direct_subject')
      && this.contactStore && channelId && contactCreationAllowed
    ) {
      const mentionOnlyContact = await resolveMentionOnlyContactForFact({
        fact,
        subjectName: routing?.subjectName,
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
        if (routing) resolvedRouting = {
          ...routing, routedContactId: mentionOnlyContact.id, subjectContactId: mentionOnlyContact.id,
          subjectName: routing.subjectName ?? mentionOnlyContact.displayName,
        };
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
      && (!resolvedRouting?.subjectContactId
        || (resolvedRouting.subjectContactId === canonicalContactId && resolvedRouting.sourceContactId === canonicalContactId))
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

    if (resolvedRouting && this.isTelemetryEnabled()) {
      log.debug('Resolved extracted fact contact routing', {
        channelId,
        triggerReason,
        turnId,
        triggerContactId: resolvedRouting.triggerContactId,
        routedContactId: resolvedRouting.routedContactId,
        sourceContactId: resolvedRouting.sourceContactId,
        sourceAuthorId: resolvedRouting.sourceAuthorId,
        sourceSpeakerName: resolvedRouting.sourceSpeakerName,
        subjectContactId: resolvedRouting.subjectContactId,
        subjectName: resolvedRouting.subjectName,
        addressMode: resolvedRouting.addressMode,
        scopeRef: resolvedRouting.scopeRef,
        scopeTags: resolvedRouting.scopeTags,
        sourceMessageIds: resolvedRouting.sourceMessageIds,
        sourceSpanStartMessageId: resolvedRouting.sourceSpanStartMessageId,
        sourceSpanEndMessageId: resolvedRouting.sourceSpanEndMessageId,
        routingReason: resolvedRouting.routingReason,
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
      ...(resolvedRouting?.scopeRef ? { scopeRef: resolvedRouting.scopeRef } : {}),
      ...(resolvedRouting?.scopeTags ? { scopeTags: resolvedRouting.scopeTags } : {}),
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
          ...(companionOwned ? { actor: 'companion', subjectScope: 'companion_internal' } : {}),
          ...(resolvedRouting?.triggerContactId ? { triggerContactId: resolvedRouting.triggerContactId } : {}),
          ...(resolvedRouting?.routedContactId ? { routedContactId: resolvedRouting.routedContactId } : {}),
          ...(resolvedRouting?.sourceContactId ? { sourceContactId: resolvedRouting.sourceContactId } : {}),
          ...(resolvedRouting?.sourceAuthorId ? { sourceAuthorId: resolvedRouting.sourceAuthorId } : {}),
          ...(resolvedRouting?.sourceSpeakerName ? { sourceSpeakerName: resolvedRouting.sourceSpeakerName } : {}),
          ...(resolvedRouting?.subjectContactId ? { subjectContactId: resolvedRouting.subjectContactId } : {}),
          ...(resolvedRouting?.subjectName ? { subjectName: resolvedRouting.subjectName } : {}),
          ...(resolvedRouting?.addressMode ? { addressMode: resolvedRouting.addressMode } : {}),
          ...(resolvedRouting?.routingReason ? { routingReason: resolvedRouting.routingReason } : {}),
          ...(resolvedRouting?.sourceMessageIds ? { sourceMessageIds: resolvedRouting.sourceMessageIds } : {}),
          ...(resolvedRouting?.sourceSpanStartMessageId
            ? { sourceSpanStartMessageId: resolvedRouting.sourceSpanStartMessageId }
            : {}),
          ...(resolvedRouting?.sourceSpanEndMessageId
            ? { sourceSpanEndMessageId: resolvedRouting.sourceSpanEndMessageId }
            : {}),
          ...(resolvedRouting?.sourceConversationAt !== undefined
            ? { sourceConversationAt: resolvedRouting.sourceConversationAt }
            : {}),
          ...(resolvedRouting?.icpDyadId ? { icpDyadId: resolvedRouting.icpDyadId } : {}),
          ...(resolvedRouting?.sourceActivityIds ? { sourceActivityIds: resolvedRouting.sourceActivityIds } : {}),
          ...(resolvedRouting?.sourceTurnIds ? { sourceTurnIds: resolvedRouting.sourceTurnIds } : {}),
          // ccgdz.3: admission identity of the source bytes and the identity of
          // the run that derived this memory. Both are verified upstream; an
          // absent field means the chain is unproven here, never that it is clean.
          ...(resolvedRouting?.sourceAdmissions ? { sourceAdmissions: resolvedRouting.sourceAdmissions } : {}),
          ...(resolvedRouting?.derivationRunId ? { derivationRunId: resolvedRouting.derivationRunId } : {}),
        }
        : undefined,
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
