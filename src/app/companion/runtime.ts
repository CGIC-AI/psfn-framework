// ── Standalone companion composition root ──
//
// Composes the full companion inner-life runtime in a single process using only
// core modules and shared pure-core lanes — free of host-only scaffolding
// (Gateway, Fleet Auth, Custody, Redis, CogSec intake firewall, Discord/voice/
// image channels, Wiki, Skills, Shards, Analysis Workbench, and retired letters/
// doing-mirror surfaces). External host capabilities are injected as typed
// ports on `StartCompanionRuntimeOptions`.

import { randomUUID } from 'node:crypto';

import {
  sanitizeCoreSubstrateConfig,
  type SubstrateConfig,
} from '../../system/config/runtime-config-contracts.js';
import type { CapabilityTierConfig } from '../../system/config/capability-tier-config.js';
import type { InnerLifeConfig } from '../../system/config/inner-life-config.js';
import { setRuntimeTrustPolicy } from '../../system/trust/runtime-policy.js';
import { DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG } from '../../system/config/scheduler-config.js';
import { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import { createMemoryAppCache } from '../../shared/cache/memory-cache.js';
import { emitGardenQueueChanged } from '../../shared/garden-queue-change.js';
import { resolveHealthEventOwner } from '../../shared/contracts/health-event.js';
import type {
  NotificationPort,
  NotifyNtfyParams,
  NotifyNtfyResult,
} from '../../shared/contracts/notification-port.js';
import { EMPTY_PERSONAL_PROJECTS } from '../../shared/contracts/personal-projects-port.js';
import type { SleeptimeWikiPassPort } from '../../shared/contracts/wiki-context.js';
import type { ChannelType } from '../../shared/contracts/channel-types.js';
import type { MessageSender } from '../../system/lifecycle/notifications.js';
import { OutboundReplyDeduper } from '../../system/lifecycle/outbound-reply-dedupe.js';
import type { CapabilityAccess, CapabilityGrantSnapshot } from '../../system/capabilities/access.js';
import { createEligibilityGate } from '../../system/capabilities/eligibility.js';
import { resolveTierCapabilityTokens } from '../../system/capabilities/tiers.js';
import type { CapabilityToken } from '../../system/capabilities/tokens.js';
import { ConfirmationQueue } from '../../system/capabilities/confirmation-queue.js';
import { createApprovalQueuePortFromConfirmationQueue } from '../../system/capabilities/approval-queue-port.js';
import { trustOrd } from '../../system/trust/types.js';
import { createDefaultBiographicalDepthPolicy } from '../../system/config/biographical-depth-policy.js';
import { createDefaultBiographicalCandidatePolicy } from '../../system/config/biographical-candidate-policy.js';
import { createProviderRuntimeServices } from '../../system/config/provider-runtime-factory.js';
import type { ModelUsageRecorder } from '../../shared/telemetry/model-usage.js';
import type { LLMClientRuntimeOptions } from '../../primitives/llm/client.js';
import type { ProviderRuntime } from '../../primitives/llm/provider-runtime.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import { createDecisionRuntime } from '../../primitives/llm/decision/decide.js';
import { createLocalDecisionBackend } from '../../primitives/llm/decision/local-backend.js';
import { createJsonlDecisionShadowSink } from '../../primitives/llm/decision/shadow-record.js';
import {
  resolveCharacterCardHistoryPath,
  resolveConcernResolutionArcJournalPath,
  resolveContactBlockListPath,
  resolveContactsDir,
  resolveDecisionShadowLedgerPath,
  resolveIntrospectionConsentLedgerPath,
  resolveOutreachOutboxLedgerPath,
  resolvePendingContactApprovalsPath,
  resolveRuntimePathSnapshotFromConfig,
  resolveSocialGraphBuilderWatermarkPath,
  resolveSocialGraphProposalsPath,
  type RuntimePathSnapshot,
} from '../../persistence/layout.js';
import { createPostgresPool } from '../../persistence/postgres.js';
import { PostgresPoolOwner, runWithPostgresPoolOwner } from '../../persistence/postgres/pool-owner.js';
import { awaitPostgresStoreReadiness, sealPostgresStoreReadinessBeforeReady } from '../../persistence/postgres/runtime-readiness.js';
import { resolveConfigTenantPoolScope } from '../../persistence/postgres/tenant-pool-scope.js';
import { assertBackgroundWorkFitsTurnRecordFenceLane } from '../../persistence/postgres/turn-record-eligibility-fence.js';
import { ReflectionJournalStore } from '../../persistence/journals/reflection-journal.js';
import type { SessionIntegrityProvider } from '../../persistence/sessions/store.js';
import { createLLMProviderPort, type LLMProviderPort } from '../../core/agent/contracts.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { SubstrateStreamTransport } from '../../core/agent/stream-adapter.js';
import { CompanionAvailabilityRuntime, attachToolAvailability } from '../../core/agent/companion-availability.js';
import { createMemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import type { MemoryDeletionApprovalPort } from '../../faculties/memory/deletion-proposals.js';
import { recoverPendingMemoryDeletionProposals } from '../../faculties/memory/deletion-proposal-recovery.js';
import { EmotionObserver, type TextEmotionClassifierLike } from '../../core/emotion/observer.js';
import { EmotionState } from '../../core/emotion/state.js';
import type { EmoSimProactivityImpulse } from '../../core/emotion/emosim-proactivity-port.js';
import type { SocialImpulseOutreachRuntime } from '../../core/emotion/social-impulse-outreach.js';
import { CharacterCardVersionStore } from '../../core/identity/card-versioning.js';
import { composeSystemPromptTemplate } from '../../core/identity/loader.js';
import { createPersonaPreambleService } from '../../core/identity/persona-preamble.js';
import { createPromptStatePort } from '../../core/identity/prompt-state-port.js';
import { resolveCompanionIdFromConfig, resolveCoreCompanionIdFromConfig } from '../../core/identity/companion-runtime.js';
import { registerContactRuntime } from '../../core/contacts/runtime-wiring.js';
import { createContactTrackingGate, type ContactTrackingChannelLabels } from '../../core/contacts/tracking-gate.js';
import { createFilePendingContactApprovalStore } from '../../core/contacts/pending-contact-approvals.js';
import { ContactBlockListStore } from '../../core/cogsec/contact-block-list.js';
import {
  createIntentionAppraisalHooks,
  createIntentionBehavioralPatternHooks,
  wireIntentionRuntimeStores,
  type LongHorizonFollowUpInput,
} from '../../core/intention/runtime-wiring.js';
import { createAutomatedConcernRuntime } from '../../core/intention/concern-candidates.js';
import { createConcernResolutionArcRecorder } from '../../core/intention/concern-resolution-arc.js';
import { resolveCurrentInternalStateConcernVAD } from '../../core/intention/concern-grooming.js';
import {
  applyConcernCandidateDecision,
  listPendingConcernCandidates as listPendingConcernCandidatesFrom,
} from '../../core/intention/concern-candidate-prompt.js';
import { createLongHorizonFollowUpRouter } from '../../core/intention/long-horizon-follow-up.js';
import {
  ProactiveOutboundDispatcher,
  createApprovedPrimaryChannelPolicy,
} from '../../core/intention/proactive-outbound.js';
import { openFileOutreachOutboxStore } from '../../core/intention/outreach-outbox.js';
import { createSocialOutreachDraftRegistry } from '../../core/intention/social-outreach-turn/drafts.js';
import { createBehavioralPatternMemoryPromotionHook } from '../../core/intention/patterns.js';
import { rehydratePersistedInternalState } from '../../core/self-model/internal-state-persistence.js';
import { registerEmoSimProactivitySampling } from '../../core/scheduler/emosim-proactivity-lane.js';
import { createObserverEvalSidecarRuntimeFromConfig } from '../../core/eval/observer-sidecar/config.js';
import { MemoryWriter } from '../../faculties/memory/writer.js';
import { createCompanionRoomMembershipAuthority } from '../../faculties/memory/companion-provenance.js';
import { hydrateStartupActiveMemoryContexts } from '../../faculties/memory/startup-hydration.js';
import { hydrateStartupActiveCoreMemoryBlocks } from '../../faculties/core-memory/startup-hydration.js';
import {
  EPISODE_SEARCH_DOCUMENT_SCHEMA,
  wireEpisodeSemanticIndexRuntime,
} from '../../faculties/memory/episodic/index.js';
import { EpisodicSynthesizer } from '../../faculties/memory/episodic/synthesis.js';
import { SleepCycleEpisodeConsolidator } from '../../faculties/memory/episodic/sleep-consolidation.js';
import { EpisodeArcWeaver } from '../../faculties/memory/episodic/arc-formation.js';
import { DreamMeaningPass } from '../../faculties/memory/episodic/dream-meaning-pass.js';
import { createHybridEpisodeSearch } from '../../faculties/memory/retrieval/episode-search.js';
import { registerMemoryTools } from '../../faculties/memory/runtime-wiring.js';
import {
  createSubjectAuthorizedMemoryStore,
  memorySubjectAccessContextFromCorrelation,
} from '../../faculties/memory/subject-authorized-store.js';
import {
  createFileSocialGraphBuilderWatermarkStore,
  createFileSocialGraphProposalStore,
} from '../../faculties/memory/social-graph/proposals.js';
import { ObservedGroupMemoryScheduler } from '../../faculties/memory/extraction/group-observed-scheduler.js';
import { JsonGroupMemoryWatermarkStore } from '../../faculties/memory/extraction/group-ranges.js';
import { createPostgresBiographicalProfileStore } from '../../faculties/memory/biographical/postgres-store.js';
import { MemoryBackedBiographicalSourceRevalidator } from '../../faculties/memory/biographical/memory-source.js';
import { BiographySynthesisService } from '../../faculties/memory/biographical/synthesis-service.js';
import { BiographyCompanionReviewService } from '../../faculties/memory/biographical/companion-review-service.js';
import { createBiographySynthesisTargetPort } from '../../faculties/memory/biographical/synthesis-targets.js';
import type { BiographicalSubjectRef } from '../../faculties/memory/biographical/types.js';
import { createRuntimeBiographicalProjection } from '../../faculties/memory/biographical/runtime-projection.js';
import { resolveEmbeddingProviderProvenanceFromConfig, type EmbeddingRuntimeProvider } from '../../faculties/memory/embedding.js';
import { IntrospectionConsentStore } from '../../faculties/introspection/consent-store.js';
import { IntrospectionTurnSensitivityDecisions } from '../../faculties/introspection/turn-sensitivity.js';
import { createAutomataBusProductionRuntime } from '../../faculties/automata/bus/production-runtime.js';
import {
  CanonicalAutomataBusWriter,
  automataBusWorkerBoundsFromOwnerPolicy,
  createAutomataTerminalLifecycleAdapter,
  createProductionAutomataBusWorkerAccess,
} from '../../faculties/automata/bus/production-worker-adapter.js';
import {
  createAutomataBusReviewerFindingAdapter,
  createAutomataBusReviewerModelAdapter,
  createAutomataBusReviewerMutationAdapter,
  createAutomataBusReviewerOutcomeAdapter,
  PostgresAutomataBusReviewerNominationAdapter,
} from '../../faculties/automata/bus/production-reviewer-adapters.js';
import { createAutomataBusReviewerTask } from '../../faculties/automata/bus/reviewer-service.js';
import type { AutomataClassLifecycleRuntime } from '../../faculties/automata/bus/class-lifecycle.js';
import { resolveForegroundSessionOwner } from '../../faculties/automata/session-classification.js';
import { createProductionAutomataRetentionRuntime } from '../../faculties/automata/production-retention-runtime.js';
import { staggerQuietHoursRelease } from '../../core/scheduler/quiet-hours-release-stagger.js';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import type { SubagentHostExecutionPort } from '../../faculties/subagents/host-execution.js';
import type { SubagentControlPort } from '../../faculties/subagents/port.js';
import {
  createBackgroundWorkAutomataLifecycle,
  createIntentionPostTurnHooksAutomataRunner,
} from '../agent/automata-background-work-lifecycle.js';
import { createDefaultConcernRouteDispatcher } from '../agent/concern-route-wiring.js';
import { reconcileConcernResolutionArcsAtStartup } from '../agent/concern-resolution-arc-startup.js';
import { writeStartupSessionMetadata } from '../agent/session-activity.js';
import { wireIcpInitiationSources } from '../agent/icp-initiation-source-wiring.js';
import { createIntentionFollowUpDestinationResolver } from '../agent/intention-follow-up-destination.js';
import { registerMarkdownJournalTools, createOptionalJournalAutoPublisher } from '../agent/journal-runtime.js';
import { registerTemporalWakeupLane } from '../agent/startup/temporal-wakeup-lane.js';
import { registerFreeTimeLane } from '../agent/startup/free-time-lane.js';
import { registerWeightedThoughtOutreachLane } from '../agent/startup/weighted-thought-outreach-lane.js';
import { registerSocialDesireLane } from '../agent/startup/social-desire-lane.js';
import { registerSocialImpulseOutreachLane } from '../agent/startup/social-impulse-outreach-lane.js';
import { registerIntrospectionLane } from '../agent/startup/introspection-lane.js';
import {
  composeIdentity,
  composeSessionRuntimeCoreAsync,
  composeSubstrateAgent,
  wireCoreMemoryRuntime,
  wireDiagnosticsRuntime,
  wireMemoryRuntime,
  wireSelfModelRuntime,
  wireSubagentRuntime,
} from '../startup/composition/core-composition.js';
import {
  buildCharacterPromptVariablesProvider,
  wireCharacterCardRuntime,
  wirePromptRuntime,
  wireReflectionRuntime,
  wireSessionToolsRuntime,
  wireSettingsRuntime,
  wireStaticPromptRegistry,
} from '../startup/composition/core-parity.js';
import {
  createActiveMemoryRefreshFailureAlertHandler,
  createBackupFailureAlertHandler,
  createPromptGenerationFailureAlertHandler,
  createQuarantineExpiryAlertHandler,
  createScheduledTaskFailureAlertHandler,
  createSleepConsolidationFailureAlertHandler,
} from '../startup/support/operator-alerts.js';
import { createRuntimeSafeguardSurfaces } from '../startup/support/safeguard-surfaces.js';
import {
  createRetryableShutdown,
  runShutdownSequence,
} from '../startup/support/shutdown-helpers.js';
import {
  createStartupTextEmotionClassifier,
  warmRuntimeMlServices,
  type StartupTextEmotionClassifier,
} from '../startup/support/ml-warmup.js';
import {
  createCompanionPersistenceRuntime,
  type CompanionPersistenceRuntime,
} from './persistence-runtime.js';
import { buildCompanionSchedulerRuntime } from './scheduler-runtime.js';

const log = createComponentLogger('CompanionRuntime');

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function createDisabledSleeptimeWikiPass(): SleeptimeWikiPassPort {
  return {
    run: async () => ({
      ran: false,
      skippedReason: 'disabled',
      reviewedEpisodes: 0,
      reviewedMemories: 0,
      entriesCreated: 0,
      entriesUpdated: 0,
      proposalsRejected: 0,
      entriesHeld: 0,
      entriesUnchanged: 0,
      nearDuplicatesFolded: 0,
    }),
  };
}

/** Host-injected configuration and ports for `startCompanionRuntime`. */
export interface StartCompanionRuntimeOptions {
  /** Host-built substrate config; inner-life owner files are applied over it. */
  config: SubstrateConfig;
  /** Inner-life policy files loaded via `loadInnerLifeConfig`. */
  innerLife: InnerLifeConfig;
  /** Defaults to the layout resolved from `config.dataDir` / `companionDataDir`. */
  pathSnapshot?: RuntimePathSnapshot;
  /** Provider runtime for the in-process LLM client. */
  providerRuntime?: ProviderRuntime;
  /** Model-usage recorder required for accountable foreground/autonomous calls. */
  modelUsageRecorder: ModelUsageRecorder;
  llmOptions?: Omit<LLMClientRuntimeOptions, 'runtime'>;
  /** Embedding runtime provider. */
  embeddingProvider?: EmbeddingRuntimeProvider;
  /** Text emotion classifier (defaults to HuggingFace Transformers classifier). */
  textEmotionClassifier?: StartupTextEmotionClassifier;
  /** Operator notification sink (defaults to log-only notifier). */
  operatorNotifier?: NotificationPort;
  /** Outbound message sender for proactive lanes. */
  outboundSender?: MessageSender;
  /** Primary outward channel for proactive messages. */
  heartbeatChannel?: { channelId: string; channelType: ChannelType };
  /** Channel availability projection hook. */
  projectAvailability?: (state: 'available' | 'idle' | 'do_not_disturb') => Promise<'applied' | 'unsupported'>;
  /** Operator confirmation port for companion memory-deletion proposals. */
  memoryDeletionApprovalPort?: MemoryDeletionApprovalPort;
  /** Session journal HMAC integrity provider. */
  sessionIntegrityProvider?: SessionIntegrityProvider | null;
  /** Channel ids eligible for cross-channel continuity. */
  continuityChannelIds?: readonly string[];
  continuityChannelPrefixes?: readonly string[];
  /** Contact-tracking channel labels. */
  channelLabels?: ContactTrackingChannelLabels;
  primaryUserId?: string;
  eventBus?: EventBus;
  env?: NodeJS.ProcessEnv;
  /** Optional wrapper around the default in-process foreground stream transport. */
  wrapStreamTransport?: (base: SubstrateStreamTransport) => SubstrateStreamTransport;
  /** Optional host-executed automata port (runs spawned subagents on the host). */
  automataHostExecution?: SubagentHostExecutionPort | null;
  /** Graceful extraction drain timeout on shutdown. */
  shutdownDrainTimeoutMs?: number;
}

export interface CompanionRuntime {
  readonly agentLoop: SubstrateAgent;
  readonly eventBus: EventBus;
  readonly scheduler: Scheduler;
  readonly llmProvider: LLMProviderPort;
  readonly persistence: CompanionPersistenceRuntime;
  readonly sessionManager: SubstrateAgentSessionManager;
  readonly subagentFaculty: SubagentControlPort;
  readonly garden: CompanionGardenHandles;
  stop(): Promise<void>;
}

/** In-process stores and handles exposed for Light Garden operator services. */
export interface CompanionGardenHandles {
  readonly config: SubstrateConfig;
  readonly companionId: string;
  readonly companionDataDir: string;
  readonly characterCard: ReturnType<typeof composeIdentity>['card'];
  readonly cardVersionStore: CharacterCardVersionStore;
  readonly promptStore: ReturnType<typeof wirePromptRuntime>;
  readonly promptRegistry: ReturnType<typeof wireStaticPromptRegistry>;
  readonly memoryStore: ReturnType<typeof createMemoryStorePort>;
  readonly contactStore: Awaited<ReturnType<typeof registerContactRuntime>>;
  readonly sessionStore: SubstrateAgentSessionStore;
  readonly concernStore: NonNullable<CompanionPersistenceRuntime['intentionRuntime']>['concernStore'];
  readonly embeddingService: ReturnType<typeof createProviderRuntimeServices>['embeddingProvider'];
  readonly socialGraphProposalStore: ReturnType<typeof createFileSocialGraphProposalStore>;
  readonly biographicalStore: Awaited<ReturnType<typeof createPostgresBiographicalProfileStore>>;
  readonly emotionState: EmotionState;
  readonly introspectionConsentStore: IntrospectionConsentStore;
  readonly automataBusVector: ReturnType<typeof createAutomataBusProductionRuntime>['vector'];
}

type SubstrateAgentSessionManager = Awaited<ReturnType<typeof composeSessionRuntimeCoreAsync>>['sessionManager'];
type SubstrateAgentSessionStore = Awaited<ReturnType<typeof composeSessionRuntimeCoreAsync>>['sessionStore'];

function createLoggingOperatorNotifier(): NotificationPort {
  return {
    notify: async (params: NotifyNtfyParams): Promise<NotifyNtfyResult> => {
      log.warn('Operator notification has no host sink; logged only', {
        title: params.title ?? '',
        provenance: params.sender.provenance,
      });
      return { status: 'debounced', topic: 'unconfigured' };
    },
  };
}

function createFixedCapabilityAccess(owner: CapabilityTierConfig): CapabilityAccess & {
  snapshotOwnerGrant(): CapabilityGrantSnapshot;
} {
  const tier = owner.tier;
  const customTokens = Object.freeze([...owner.customTokens]);
  const granted = new Set<CapabilityToken>(resolveTierCapabilityTokens(tier, customTokens));
  return {
    getTier: () => tier,
    getGrantedTokens: () => granted,
    has: token => granted.has(token),
    snapshotOwnerGrant: () => Object.freeze({
      tier,
      customTokens,
      grantedTokens: Object.freeze([...granted]),
    }),
  };
}

function formatDegradedChannels(degraded: Array<{ channelId: string; error: string }>): string {
  return degraded.map(({ channelId, error }) => `${channelId}: ${error}`).join('; ');
}

function applyInnerLifeConfig(config: SubstrateConfig, innerLife: InnerLifeConfig): void {
  Object.assign(config, innerLife.settings);
  setRuntimeTrustPolicy(innerLife.trustPolicy);
  config.subagentRoles = innerLife.subagentRoles;
  config.automataPolicy = innerLife.automataPolicy;
}

export async function startCompanionRuntime(
  options: StartCompanionRuntimeOptions,
): Promise<CompanionRuntime> {
  const postgresPoolOwner = new PostgresPoolOwner('agent');
  try {
    return await runWithPostgresPoolOwner(
      postgresPoolOwner,
      () => composeCompanionRuntime(options, postgresPoolOwner),
    );
  } catch (error) {
    await postgresPoolOwner.close().catch(() => undefined);
    throw error;
  }
}

async function composeCompanionRuntime(
  options: StartCompanionRuntimeOptions,
  postgresPoolOwner: PostgresPoolOwner,
): Promise<CompanionRuntime> {
  const { config, innerLife } = options;
  const schedulerConfig = innerLife.scheduler;
  applyInnerLifeConfig(config, innerLife);
  const env = options.env ?? process.env;
  const pathSnapshot = options.pathSnapshot ?? resolveRuntimePathSnapshotFromConfig(config);
  const eventBus = options.eventBus ?? new EventBus();
  const capabilityAccess = createFixedCapabilityAccess(innerLife.capabilityTier);
  config.capabilityTier = capabilityAccess.getTier();
  const eligibilityGate = createEligibilityGate(() => capabilityAccess);

  const providerServices = createProviderRuntimeServices({
    config,
    providerEnv: env,
    llmOptions: {
      ...(options.llmOptions ?? {}),
      ...(options.providerRuntime ? { runtime: options.providerRuntime } : {}),
    },
    modelUsageRecorder: options.modelUsageRecorder,
    ...(options.embeddingProvider ? { embeddingProvider: options.embeddingProvider } : {}),
  });
  const { llmClient, embeddingProvider } = providerServices;
  const llmProvider = createLLMProviderPort(llmClient);
  const embeddingDims = embeddingProvider.dims;
  const primaryUserId = options.primaryUserId ?? env.PRIMARY_USER_ID;

  assertBackgroundWorkFitsTurnRecordFenceLane(
    schedulerConfig.backgroundWork.supervisor.maxConcurrentSessions,
  );
  const persistenceRuntime = await createCompanionPersistenceRuntime({
    config,
    pathSnapshot,
    embeddingDims,
    ...(primaryUserId ? { primaryUserId } : {}),
  });

  const companionAvailability = new CompanionAvailabilityRuntime({
    store: persistenceRuntime.companionAvailabilityStore,
    project: async snapshot => (options.projectAvailability
      ? await options.projectAvailability(snapshot.state)
      : 'unsupported'),
    queueReadBatchSize: schedulerConfig.backgroundWork.supervisor.maxConcurrentSessions,
    drainRetryDelayMs: schedulerConfig.backgroundWork.supervisor.retryBaseDelayMs,
    returnContextMaxChars: schedulerConfig.freeTime.returnNote.summaryMaxTokens,
    onProjectionDegraded: snapshot => {
      log.warn('Channel does not support companion availability projection', {
        state: snapshot.state,
        revision: snapshot.revision,
      });
    },
    onProjectionError: (error, snapshot) => {
      log.error('Channel availability projection failed; durable state remains authoritative', {
        state: snapshot.state,
        revision: snapshot.revision,
        error: error instanceof Error ? error.message : String(error),
      });
    },
    onDrainError: (error, queued) => {
      log.error('Protected message queue drain paused after delivery failure', {
        channelId: queued.message.channelId,
        messageId: queued.message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    },
    onDrainRuntimeError: error => {
      log.error('Protected message queue persistence failure paused draining', {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  await companionAvailability.initialize();
  const detachToolAvailability = attachToolAvailability({
    eventBus,
    runtime: companionAvailability,
    isLongRunningTool: toolName => toolName === 'execute',
    onError: error => {
      log.error('Long-running tool availability projection failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const operatorNotifier = options.operatorNotifier ?? createLoggingOperatorNotifier();
  const pendingContactApprovals = createFilePendingContactApprovalStore(
    resolvePendingContactApprovalsPath(pathSnapshot.companionDataDir),
  );
  const socialGraphProposalStore = createFileSocialGraphProposalStore(
    resolveSocialGraphProposalsPath(pathSnapshot.companionDataDir),
  );
  const socialGraphWatermarkStore = createFileSocialGraphBuilderWatermarkStore(
    resolveSocialGraphBuilderWatermarkPath(pathSnapshot.companionDataDir),
  );
  const contactTrackingGate = createContactTrackingGate({
    channelLabels: options.channelLabels ?? {},
    pendingApprovals: pendingContactApprovals,
    notifyOperatorPendingContact: async (entry) => {
      await operatorNotifier.notify({
        sender: { kind: 'system', provenance: 'system.contacts.pending_approval' },
        title: 'Contact approval required',
        priority: 4,
        message: [
          `New speaker awaiting contact approval: ${entry.displayName}`,
          `Channel: ${entry.channel} (${entry.channelId})`,
          `First seen: ${entry.firstSeenAt}`,
          'Review in admin: /contact-approvals',
        ].join('\n'),
      });
    },
    logger: log,
    onQueueChanged: () => emitGardenQueueChanged(eventBus, 'contact-approvals'),
  });

  const postgresDatabaseUrl = config.postgresDatabaseUrl?.trim();
  if (!postgresDatabaseUrl) {
    throw new Error('Companion runtime requires POSTGRES_DATABASE_URL');
  }

  let longHorizonFollowUpRouter:
    | ((input: LongHorizonFollowUpInput) => Promise<string>)
    | null = null;
  const routeLongHorizonFollowUp = async (input: LongHorizonFollowUpInput): Promise<string> => {
    if (!longHorizonFollowUpRouter) {
      throw new Error('Long-horizon intention follow-up scheduler is not ready');
    }
    return longHorizonFollowUpRouter(input);
  };

  const coreConfig = sanitizeCoreSubstrateConfig(config);
  const { card, systemPrompt } = composeIdentity(coreConfig);
  const cardVersionStore = new CharacterCardVersionStore(
    coreConfig.characterCardPath,
    resolveCharacterCardHistoryPath(pathSnapshot.companionDataDir),
  );
  const cardProposalQueue = createApprovalQueuePortFromConfirmationQueue(new ConfirmationQueue({
    idFactory: () => `card-${randomUUID()}`,
  }));
  log.info(`Loaded character: ${card.data.name}`);
  coreConfig.characterName = card.data.name;
  const textClassifier = options.textEmotionClassifier ?? createStartupTextEmotionClassifier({
    model: coreConfig.textEmotionModel,
    cacheDir: coreConfig.textEmotionCacheDir,
    dtype: coreConfig.textEmotionDtype,
  });
  await warmRuntimeMlServices({
    textClassifier,
    embeddingService: embeddingProvider,
    textEmotionModel: coreConfig.textEmotionModel?.trim() || 'host-supplied',
    logger: log,
  });
  const emotionObserver = new EmotionObserver({
    textClassifier: textClassifier as TextEmotionClassifierLike,
  });
  const emotionState = new EmotionState();
  const { safeguardAuditTrail, identityCoolingOff, externalRateLimiter } = createRuntimeSafeguardSurfaces(
    pathSnapshot.companionDataDir,
    env,
  );

  const companionId = resolveCompanionIdFromConfig(coreConfig);
  const invalidatePromptCache = (reason: string): void => {
    coreConfig.runtimeHooks?.invalidatePromptPrefixCache?.(reason);
  };
  const promptRegistry = wireStaticPromptRegistry(pathSnapshot.companionDataDir, {
    invalidatePromptCache,
  });
  const appCache = createMemoryAppCache({ name: 'app-cache' });
  const decisionRuntime = createDecisionRuntime({
    local: createLocalDecisionBackend({
      llmProvider,
      resolveQuestionMode: () => coreConfig.decisionBackend?.localQuestionMode ?? 'combined',
    }),
    resolveSettings: () => coreConfig.decisionBackend,
    shadowSink: createJsonlDecisionShadowSink(
      resolveDecisionShadowLedgerPath(pathSnapshot.companionDataDir),
    ),
  });

  const automataPolicy = coreConfig.automataPolicy ?? (() => {
    throw new Error('Automata Bus runtime requires automata-policy.json');
  })();
  const automataStore = persistenceRuntime.automataBusStore;
  const automataRegistry = persistenceRuntime.automataRunRegistry;
  const automataBusProductionRuntime = createAutomataBusProductionRuntime({
    pool: automataStore.getQueryPool(),
    store: automataStore,
    companionId,
    embeddingProvider,
    embeddingIdentity: resolveEmbeddingProviderProvenanceFromConfig(coreConfig, embeddingProvider.dims),
    appCache,
    policy: automataPolicy.bus.query,
    reindexLeaseDurationMs: automataPolicy.bus.reindex.leaseDurationMs,
  });
  const automataWriter = new CanonicalAutomataBusWriter({
    companionId,
    store: automataStore,
    runtime: automataBusProductionRuntime,
  });
  const automataReviewer = createAutomataBusReviewerTask({
    nominations: new PostgresAutomataBusReviewerNominationAdapter({
      pool: automataStore.getQueryPool(),
      companionId,
    }),
    findings: createAutomataBusReviewerFindingAdapter({ store: automataStore, companionId }),
    model: createAutomataBusReviewerModelAdapter({ llmProvider }),
    mutations: createAutomataBusReviewerMutationAdapter({
      companionId,
      registry: automataRegistry,
      store: automataStore,
      writer: automataWriter,
    }),
    outcomes: createAutomataBusReviewerOutcomeAdapter({
      companionId,
      registry: automataRegistry,
      store: automataStore,
      writer: automataWriter,
    }),
    policy: automataPolicy.bus.reviewer,
  });
  const automataWorkerAccess = createProductionAutomataBusWorkerAccess({
    companionId,
    registry: automataRegistry,
    store: automataStore,
    runtime: automataBusProductionRuntime,
    writer: automataWriter,
    bounds: automataBusWorkerBoundsFromOwnerPolicy({
      query: automataPolicy.bus.query,
      recentRunLimit: automataPolicy.recentRunLimit,
    }),
  });
  const automataTerminalLifecycle = createAutomataTerminalLifecycleAdapter({
    companionId,
    registry: automataRegistry,
    store: automataStore,
    writer: automataWriter,
    health: {
      publisher: eventBus,
      source: { owner: resolveHealthEventOwner(companionId), process: 'agent' },
    },
  });
  const automataClassLifecycle: AutomataClassLifecycleRuntime = {
    registry: automataRegistry,
    workerAccess: automataWorkerAccess,
    terminal: automataTerminalLifecycle,
    telemetry: event => log.debug('Automata class lifecycle stage', { ...event }),
  };

  const observerEvalSidecar = createObserverEvalSidecarRuntimeFromConfig(coreConfig, {
    postgresDatabaseUrl,
    eventBus,
    ...(resolveConfigTenantPoolScope(coreConfig) ? { tenant: resolveConfigTenantPoolScope(coreConfig)! } : {}),
    emitProactivityImpulse: async (impulse: EmoSimProactivityImpulse) => {
      await eventBus.emit('emotion.proactive.transition', {
        correlationId: impulse.correlationId,
        lever: impulse.kind,
        stage: 'would_message',
        outcome: 'qualified',
        firedAtMs: impulse.firedAtMs,
        timestamp: impulse.firedAtMs,
      });
      await eventBus.emitRequired('emotion.emosim.proactivity.impulse', impulse);
    },
    proactivityStateStore: persistenceRuntime.emosimProactivityStateStore,
  });

  const sessionIntegrityProvider = options.sessionIntegrityProvider ?? null;
  const sessionComposition = await composeSessionRuntimeCoreAsync({
    ...(sessionIntegrityProvider
      ? {
          runtimeMode: 'production' as const,
          sessionIntegrityProvider,
          sessionIntegrityOperatorAlert: {
            notifier: operatorNotifier,
            companionName: card.data.name,
          },
        }
      : { runtimeMode: 'non-production' as const }),
    config: coreConfig,
    postgresDatabaseUrl,
    eventBus,
    enableContinuity: true,
    continuityChannelIds: options.continuityChannelIds ?? [],
    ...(options.continuityChannelPrefixes ? { continuityChannelPrefixes: options.continuityChannelPrefixes } : {}),
    promptRegistry,
    sessionIntegrityRepairBackupRootDir: pathSnapshot.runtimePathLayout.backupsDir,
    automataRetentionCompanionId: companionId,
    sessionTailCache: null,
  });
  const { sessionStore, sessionManager } = sessionComposition;

  const automataRetention = createProductionAutomataRetentionRuntime({
    companionId,
    sessionsDir: sessionComposition.sessionsDir,
    batchLimit: automataPolicy.recentRunLimit,
    registry: automataRegistry,
    runs: persistenceRuntime.automataRunStore,
    bus: automataStore,
    retentionStore: persistenceRuntime.automataRetentionStore,
    sagaStore: persistenceRuntime.automataPurgeSagaStore,
    projection: sessionComposition.exactSessionProjection,
    redisTail: null,
    writeBarrier: {
      seal: async (input, target) => {
        sessionComposition.exactSessionWriteBarrier.seal(input, target);
        await Promise.all([
          sessionComposition.sessionStore.flushSessionTailWrites(),
          sessionComposition.exactSessionProjection.flushPendingWrites(),
        ]);
      },
    },
  });
  sessionManager.characterName = card.data.name;
  sessionManager.intakeSinkGate = null;
  const selfAuthoredMutationIntake = {
    getIntakeSinkGate: () => null,
    getIntakeScreening: () => sessionManager.intakeScreening,
    getActiveTurnIntakeEnvelopes: () => agentLoop.getActiveTurnIntakeEnvelopes(),
    getActiveTurnSessionIdentity: () => agentLoop.getActiveTurnSessionIdentity(),
  };

  const memoryStore = createMemoryStorePort(persistenceRuntime.memoryStore);
  const characterPromptVariablesProvider = buildCharacterPromptVariablesProvider(cardVersionStore);
  const personaPreamble = createPersonaPreambleService({
    registry: promptRegistry,
    personaVariables: characterPromptVariablesProvider,
  });
  const agentLoop = composeSubstrateAgent({
    eventBus,
    llmProvider,
    runtime: providerServices.runtime,
    sessionManager,
    systemPrompt,
    characterName: card.data.name,
    characterPromptVariablesProvider,
    config: coreConfig,
    ...(options.wrapStreamTransport
      ? { streamTransport: options.wrapStreamTransport({ stream: llmProvider.stream.bind(llmProvider) }) }
      : {}),
    streamRuntimeOptions: {
      onTerminalFailure: createPromptGenerationFailureAlertHandler(operatorNotifier, card.data.name),
    },
    emotionRuntime: {
      observer: emotionObserver,
      state: emotionState,
      requireWiring: true,
    },
    observerEvalSidecar,
    appCache,
    backgroundWorkStore: persistenceRuntime.backgroundWorkStore,
    backgroundWorkTuning: schedulerConfig.backgroundWork,
    backgroundWorkWelfare:
      schedulerConfig.backgroundWorkWelfare ?? DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG,
    backgroundWorkAutomataLifecycle: createBackgroundWorkAutomataLifecycle(automataRegistry),
    intentionHooksAutomataRunner: createIntentionPostTurnHooksAutomataRunner(automataClassLifecycle),
    classifySessionAtCreation: async (message) => {
      const owner = resolveForegroundSessionOwner({
        channelId: message.channelId,
        channelType: message.channelType,
        hasIcpCorrelation: message.routing?.icpCorrelation !== undefined,
        ...(message.routing?.canonicalContactId
          ? { canonicalContactId: message.routing.canonicalContactId }
          : {}),
      });
      await persistenceRuntime.automataSessionClassification.ensureClassifiedAtCreation({
        companionId,
        sessionId: sessionManager.resolveSessionChannelId(message.channelId),
        createdAtMs: message.timestamp.getTime(),
        ...(owner ? { owner } : {}),
      });
    },
    contactTrackingGate,
  });
  agentLoop.artifactApprovalQueue = cardProposalQueue;
  agentLoop.artifactApprovalNotifier = operatorNotifier;
  agentLoop.scratchpadProvider = memoryStore;
  agentLoop.intakeSinkGate = null;
  agentLoop.setCapabilityAccess(capabilityAccess);
  wireDiagnosticsRuntime(eventBus);

  eventBus.on(
    'memory.active_context.refresh',
    createActiveMemoryRefreshFailureAlertHandler({
      notifier: operatorNotifier,
      companionName: card.data.name,
      failureThreshold: coreConfig.memoryRefreshFailureAlertThreshold,
    }),
  );
  eventBus.on('backup.failed', createBackupFailureAlertHandler(operatorNotifier, card.data.name));
  eventBus.on('schedule.task.failed', createScheduledTaskFailureAlertHandler(operatorNotifier, card.data.name));
  eventBus.on(
    'memory.sleep_consolidation.failure',
    createSleepConsolidationFailureAlertHandler(operatorNotifier, card.data.name),
  );
  eventBus.on('intake.quarantine.expired', createQuarantineExpiryAlertHandler(operatorNotifier, card.data.name));

  const promptStore = wirePromptRuntime(
    agentLoop,
    pathSnapshot.companionDataDir,
    composeSystemPromptTemplate(),
    {
      cardStore: cardVersionStore,
      confirmationQueue: cardProposalQueue,
      identityCoolingOff,
      getCapabilityTier: () => capabilityAccess.getTier(),
      invalidatePromptCache,
      intake: selfAuthoredMutationIntake,
    },
  );
  wireCharacterCardRuntime(agentLoop, cardVersionStore, {
    getCapabilityTier: () => capabilityAccess.getTier(),
    confirmationQueue: cardProposalQueue,
  });
  wireSettingsRuntime(agentLoop, coreConfig, { registerSystemTool: false });
  wireSessionToolsRuntime(agentLoop, sessionManager, pathSnapshot.companionDataDir, llmProvider, promptRegistry);

  const contactStore = await registerContactRuntime(
    agentLoop,
    persistenceRuntime.contactStore ?? (() => {
      throw new Error('PostgreSQL core runtime requires an injected contact store');
    })(),
    primaryUserId,
    {
      exportDir: resolveContactsDir(pathSnapshot.companionDataDir),
      proposalQueue: cardProposalQueue,
      blockList: new ContactBlockListStore(resolveContactBlockListPath(pathSnapshot.companionDataDir)),
      intake: selfAuthoredMutationIntake,
    },
  );

  const biographicalPool = createPostgresPool(postgresDatabaseUrl, {
    applicationName: 'biographical-projection',
    allowExitOnIdle: true,
    ...resolveConfigTenantPoolScope(coreConfig),
  });
  let biographicalStore;
  try {
    biographicalStore = await awaitPostgresStoreReadiness(
      'biographical_projection',
      () => createPostgresBiographicalProfileStore(biographicalPool),
    );
  } catch (error) {
    await biographicalPool.end();
    throw error;
  }
  const biographicalDepthPolicy = coreConfig.biographicalDepthPolicy ?? createDefaultBiographicalDepthPolicy();
  const biographicalRevalidator = new MemoryBackedBiographicalSourceRevalidator(memoryStore);
  const biographicalProjection = createRuntimeBiographicalProjection({
    store: biographicalStore,
    revalidator: biographicalRevalidator,
    contactStore,
    companionId,
    policy: biographicalDepthPolicy,
  });
  const biographyCompanionSubject: Extract<BiographicalSubjectRef, { kind: 'companion' }> = {
    kind: 'companion',
    companionId,
    subjectVersion: 1,
  };
  const biographySynthesis = new BiographySynthesisService({
    memoryStore,
    profileStore: biographicalStore,
    llmClient: llmProvider,
    promptRegistry,
    companionSubject: biographyCompanionSubject,
    targets: createBiographySynthesisTargetPort({
      contactStore,
      companionSubject: biographyCompanionSubject,
      depthPolicy: () => coreConfig.biographicalDepthPolicy ?? biographicalDepthPolicy,
    }),
    candidatePolicy: () => (
      coreConfig.biographicalCandidatePolicy ?? createDefaultBiographicalCandidatePolicy()
    ),
    depthPolicy: () => coreConfig.biographicalDepthPolicy ?? biographicalDepthPolicy,
  });
  const biographyCompanionReview = new BiographyCompanionReviewService({
    profileStore: biographicalStore,
    llmClient: llmProvider,
    personaPreamble,
    companionId,
    candidatePolicy: () => (
      coreConfig.biographicalCandidatePolicy ?? createDefaultBiographicalCandidatePolicy()
    ),
  });

  const intentionRuntime = persistenceRuntime.intentionRuntime ?? (() => {
    throw new Error('PostgreSQL core runtime requires injected intention persistence stores');
  })();
  wireIntentionRuntimeStores(agentLoop, intentionRuntime, persistenceRuntime.intentionProviders ?? {
    concernProvider: null,
    pendingFollowUpProvider: null,
    behavioralPatternProvider: null,
  });
  const introspectionConsentStore = new IntrospectionConsentStore(
    resolveIntrospectionConsentLedgerPath(pathSnapshot.companionDataDir),
  );
  introspectionConsentStore.load();
  const introspectionTurnSensitivityDecisions = new IntrospectionTurnSensitivityDecisions();
  agentLoop.setIntrospectionTurnSensitivityDecisions(introspectionTurnSensitivityDecisions);
  const coreMemoryStore = wireCoreMemoryRuntime({
    agentLoop,
    sessionManager,
    config: coreConfig,
    concernStore: intentionRuntime.concernStore,
    eventBus,
  });
  const concernResolutionArcRecorder = createConcernResolutionArcRecorder({
    concernStore: intentionRuntime.concernStore,
    journal: new ReflectionJournalStore(
      resolveConcernResolutionArcJournalPath(pathSnapshot.companionDataDir),
    ),
    emotionSink: {
      applyConcernResolutionDelta: (concern, generationId, delta) => (
        agentLoop.applyConcernResolutionDelta(concern.contactId, generationId, delta)
      ),
    },
  });
  eventBus.on('intention.concern.resolution_appraisal', concernResolutionArcRecorder);
  await reconcileConcernResolutionArcsAtStartup({
    concernStore: intentionRuntime.concernStore,
    recorder: concernResolutionArcRecorder,
  });
  wireSelfModelRuntime(agentLoop);

  const intentionAppraisalHooks = createIntentionAppraisalHooks(
    intentionRuntime.concernStore,
    intentionRuntime.pendingFollowUpStore,
    {
      completionVadProvider: (followUp, asOf) => resolveCurrentInternalStateConcernVAD(
        followUp,
        agentLoop.getCurrentInternalState(),
        asOf,
      ),
      nearTermFollowUpHorizonMs: schedulerConfig.intentionFollowUp.nearTermHorizonMs,
      routeLongHorizonFollowUp,
      eventBus,
    },
  );
  const intentionBehavioralHooks = createIntentionBehavioralPatternHooks(
    intentionRuntime.behavioralPatternTracker,
  );
  const automatedConcernRuntime = await createAutomatedConcernRuntime({
    eventBus,
    llmProvider,
    concernStore: intentionRuntime.concernStore,
    personaPreamble,
    routeDispatcher: createDefaultConcernRouteDispatcher({
      companionDataDir: pathSnapshot.companionDataDir,
      eventBus,
      pendingFollowUpStore: intentionRuntime.pendingFollowUpStore,
      sessionActivity: sessionManager,
    }),
    automataClassLifecycle,
  });

  const episodicStore = persistenceRuntime.episodicStore;
  const memoryExtractor = wireMemoryRuntime({
    agentLoop,
    llmProvider,
    decisionRuntime,
    sessionManager,
    sessionStore,
    memoryStore,
    embeddingService: embeddingProvider,
    eventBus,
    config: coreConfig,
    promptRegistry,
    contactStore,
    episodicStore,
    concernCandidateSink: automatedConcernRuntime.extractionSink,
    biographicalProjection,
    biographicalRebuild: {
      profileStore: biographicalStore,
      companionSubject: biographyCompanionSubject,
      policy: biographicalDepthPolicy,
    },
    isAutoContactCreationAllowed: (channelId: string) => contactTrackingGate.isAutoContactCreationAllowed(channelId),
    personaPreamble,
    automataBusWorkerAccess: automataWorkerAccess,
    automataTerminalLifecycle,
    automataRunRegistry: automataRegistry,
  });
  const promptState = createPromptStatePort({ layers: promptStore, registry: promptRegistry });

  agentLoop.setBackgroundWorkExecutionScope(
    handler => companionAvailability.run('do_not_disturb', handler),
  );
  writeStartupSessionMetadata(
    sessionManager,
    pathSnapshot.companionDataDir,
    config.sessionRestartBehavior ?? 'reuse_latest_session',
  );
  const activeMemoryHydration = await hydrateStartupActiveMemoryContexts({
    memoryProvider: agentLoop.memoryProvider,
    sessionManager,
  });
  const activeCoreMemoryHydration = hydrateStartupActiveCoreMemoryBlocks({ sessionManager });
  const continuityFailures: string[] = [];
  if (activeMemoryHydration.degraded.length > 0) {
    continuityFailures.push(`active memory [${formatDegradedChannels(activeMemoryHydration.degraded)}]`);
  }
  if (activeCoreMemoryHydration.degraded.length > 0) {
    continuityFailures.push(`active core memory [${formatDegradedChannels(activeCoreMemoryHydration.degraded)}]`);
  }
  if (continuityFailures.length > 0) {
    throw new Error(`Startup continuity hydration failed: ${continuityFailures.join('; ')}`);
  }

  agentLoop.setInternalStateStore(persistenceRuntime.internalStateStore);
  const internalStateRehydration = await rehydratePersistedInternalState({
    store: persistenceRuntime.internalStateStore,
    agent: agentLoop,
  });
  if (internalStateRehydration.outcome === 'restored') {
    log.info('Rehydrated persisted internal state', {
      savedAt: internalStateRehydration.savedAt,
      ageMs: internalStateRehydration.ageMs,
    });
  } else if (internalStateRehydration.outcome === 'gap_detected') {
    log.warn('Persisted internal state too stale to rehydrate; continuity gap surfaced', {
      offlineSince: internalStateRehydration.gap.offlineSince,
      gapMs: internalStateRehydration.gap.gapMs,
    });
    await eventBus.emit('internal_state.gap_detected', {
      offlineSince: internalStateRehydration.gap.offlineSince,
      gapMs: internalStateRehydration.gap.gapMs,
      timestamp: Date.now(),
    });
  } else {
    log.info('No persisted internal state snapshot found; starting fresh');
  }

  const {
    scheduler,
    postTurnActions,
    backgroundMaintenance,
  } = buildCompanionSchedulerRuntime({
    eventBus,
    eligibilityGate,
    config,
    schedulerConfig,
    sessionManager,
    llmProvider,
    embeddingDims,
    memoryStore,
    agentLoop,
    concernStore: intentionRuntime.concernStore,
    concernReviewWorker: automatedConcernRuntime.worker,
    pathSnapshot,
    contactStore,
    socialGraphProposalStore,
    socialGraphWatermarkStore,
    companionAvailability,
    automataReviewer: { task: automataReviewer, companionId },
    automataLifecycle: automataClassLifecycle,
    automataRetention,
    biographySynthesis,
    biographyCompanionReview,
  });

  const embeddingProvenance = resolveEmbeddingProviderProvenanceFromConfig(config, embeddingProvider.dims);
  const episodeEmbeddingProfile = {
    documentSchema: EPISODE_SEARCH_DOCUMENT_SCHEMA,
    ...embeddingProvenance,
  };
  const episodeSessionQuarantineFilter = {
    isSessionRetiredOrQuarantined: (sessionId: string) => (
      sessionManager.isSessionRetiredOrQuarantined(sessionId)
    ),
    getRetiredLogicalSessionIds: () => sessionManager.getRetiredLogicalSessionIds(),
  };
  const episodeSearch = createHybridEpisodeSearch({
    store: episodicStore,
    embeddingService: embeddingProvider,
    profile: episodeEmbeddingProfile,
    memoryRetrievalPolicy: () => config.memoryRetrievalPolicy,
    onDegraded: diagnostic => {
      log.warn('Episode search semantic mode degraded', diagnostic);
    },
  });

  let socialImpulseOutreachRuntime: SocialImpulseOutreachRuntime | undefined;
  const {
    weightedThoughtCandidateAdapter: icpWeightedThoughtCandidateAdapter,
    intentionCandidateAdapter: icpIntentionCandidateAdapter,
    unregisterFeltImpulseAdapter: unregisterIcpFeltImpulseAdapter,
    stopCandidateLifecycleSupervisor: stopIcpCandidateLifecycleSupervisor,
  } = wireIcpInitiationSources({
    config: schedulerConfig.icpAutonomy,
    localCompanionId: config.companionId,
    candidateStore: undefined,
    feltImpulseFunnelStore: persistenceRuntime.icpFeltImpulseFunnelStore,
    peers: undefined,
    isExternalCompanionAuthorized: () => capabilityAccess.has('external.companion'),
    llmProvider,
    eventBus,
    pendingFollowUpStore: intentionRuntime.pendingFollowUpStore,
    concernStore: intentionRuntime.concernStore,
    presenceEnabled: false,
    contactStore,
    weightedThoughtStore: persistenceRuntime.weightedThoughtStore,
    socialDesireStore: persistenceRuntime.socialDesireStore,
    handleFeltImpulse: async signal => {
      if (!socialImpulseOutreachRuntime) {
        throw new Error('social impulse outreach runtime is not composed');
      }
      await socialImpulseOutreachRuntime.onImpulse(signal);
    },
    lifecycleConfig: schedulerConfig.weightedThoughtOutreach.lifecycle,
  });

  const journalAutoPublisher = createOptionalJournalAutoPublisher(pathSnapshot.workspaceRoot, config);
  registerIntrospectionLane({
    scheduler,
    schedulerConfig,
    sessionManager,
    sessionStore,
    llmProvider,
    systemPrompt,
    introspectionConsentStore,
    persistenceRuntime,
    companionDataDir: pathSnapshot.companionDataDir,
    journalPublisher: journalAutoPublisher,
  });

  const { subagentFaculty } = wireSubagentRuntime({
    agentLoop,
    eventBus,
    llmProvider,
    sessionStore,
    embeddingService: embeddingProvider,
    memoryStore,
    sessionManager,
    config,
    parentSystemPrompt: systemPrompt,
    auditTrail: safeguardAuditTrail,
    snapshotParentCapabilityGrant: () => capabilityAccess.snapshotOwnerGrant(),
    automataRunRegistry: automataRegistry,
    automataSessionClassification: persistenceRuntime.automataSessionClassification,
    automataBusWorkerAccess: automataWorkerAccess,
    automataLifecyclePort: automataTerminalLifecycle,
    hostExecution: options.automataHostExecution ?? null,
  });

  const roomMembershipAuthority = createCompanionRoomMembershipAuthority(sessionStore);
  const memoryWriter = new MemoryWriter(memoryStore, embeddingProvider, {
    memoryRetrievalPolicy: () => config.memoryRetrievalPolicy,
    ...(config.companionId ? { companionId: config.companionId } : {}),
    roomMembershipAuthority,
  });
  memoryWriter.intakeSinkGateProvider = () => sessionManager.intakeSinkGate;

  const episodeEmbeddingRuntime = wireEpisodeSemanticIndexRuntime({
    store: episodicStore,
    embedding: embeddingProvider,
    provider: embeddingProvenance.provider,
    model: embeddingProvenance.model,
    backfillLimit: schedulerConfig.episodeSynthesis.maxEpisodesPerRun,
    backgroundMaintenance,
    onBatch: async (source, result) => {
      const health = await episodicStore.getEpisodeEmbeddingIndexHealth(episodeEmbeddingProfile);
      const details = {
        source,
        selected: result.selected,
        written: result.written,
        concurrentlyChanged: result.concurrentlyChanged.length,
        invalid: result.invalid.length,
        failed: result.failed.length,
        noProgress: result.noProgress,
        current: health.current,
        missing: health.missing,
        stale: health.stale,
        persistedFailures: health.failed,
      };
      if (result.failed.length > 0 || result.invalid.length > 0 || result.noProgress) {
        log.warn('Episode semantic index batch completed without full progress', details);
      } else {
        log.info('Episode semantic index batch completed', details);
      }
    },
    onLiveResult: (result) => {
      if (result.status === 'failed' || result.status === 'invalid') {
        log.warn('Live episode semantic indexing failed; persisted for retry', {
          episodeId: result.episodeId,
          error: result.error,
        });
      }
    },
    onLiveError: (error, episode) => {
      log.error('Live episode semantic indexing failed before retry state was persisted', {
        episodeId: episode.id,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  void episodeEmbeddingRuntime.startupBackfill.catch((error: unknown) => {
    log.error('Startup episode semantic index backfill failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  const emitThreadAssignment = (event: {
    outcome: 'merged' | 'noop' | 'merge_skipped_oversize' | 'legacy_session_thread_extracted';
    winningThreadId: string;
    losingThreadId: string;
    updatedEpisodeCount: number;
    timestamp: number;
  }): void => {
    eventBus.emit('memory.episodic.thread_assignment', event).catch((error: unknown) => {
      log.warn('Episodic thread-assignment event emit failed', {
        outcome: event.outcome,
        winningThreadId: event.winningThreadId,
        error: String(error),
      });
    });
  };
  const firstPersonPreservingEpisodicStore = persistenceRuntime.firstPersonPreservingEpisodicStore;
  const episodicSynthesizer = new EpisodicSynthesizer(firstPersonPreservingEpisodicStore, sessionManager, {
    onThreadAssignment: emitThreadAssignment,
    transcriptMessageLimit: schedulerConfig.episodeSynthesis.transcriptMessageLimit,
    maxEpisodesPerRun: schedulerConfig.episodeSynthesis.maxEpisodesPerRun,
    maxPriorCandidates: schedulerConfig.episodeSynthesis.maxPriorCandidates,
    gapSplitMinutes: schedulerConfig.episodeSynthesis.gapSplitMinutes,
    maxEntriesPerEpisode: schedulerConfig.episodeSynthesis.maxEntriesPerEpisode,
    minConversationalEntries: schedulerConfig.episodeSynthesis.minConversationalEntries,
    minSingleEntryChars: schedulerConfig.episodeSynthesis.minSingleEntryChars,
    topicSegmentation: {
      enabled: schedulerConfig.episodeSynthesis.topicSegmentationEnabled,
      llmProvider,
      personaPreamble,
      onEvent: (event) => {
        eventBus.emit('memory.episode_synthesis.segmentation', event).catch((error) => {
          log.warn('Episode-synthesis segmentation telemetry emit failed', {
            sessionId: event.sessionId,
            outcome: event.outcome,
            error: String(error),
          });
        });
      },
    },
  });
  const sleepConsolidator = new SleepCycleEpisodeConsolidator(firstPersonPreservingEpisodicStore, sessionManager.storedSessionTranscriptReader, llmProvider, {
    reviewWindowMs: schedulerConfig.sleepConsolidation.reviewWindowDays * MS_PER_DAY,
    refinementWindowMs: schedulerConfig.sleepConsolidation.refinementWindowHours * MS_PER_HOUR,
    adjacencyGapMs: schedulerConfig.sleepConsolidation.adjacencyGapMinutes * MS_PER_MINUTE,
    maxRefinementsPerRun: schedulerConfig.sleepConsolidation.maxRefinementsPerRun,
    maxConsolidationsPerRun: schedulerConfig.sleepConsolidation.maxConsolidationsPerRun,
    transcriptMessageLimit: schedulerConfig.sleepConsolidation.transcriptMessageLimit,
    maxTranscriptCharsPerEpisode: schedulerConfig.sleepConsolidation.maxTranscriptCharsPerEpisode,
    personaPreamble,
    onConsolidationFailure: (failure) => {
      eventBus.emit('memory.sleep_consolidation.failure', failure).catch((error: unknown) => {
        log.warn('Sleep-consolidation failure event emit failed', {
          sessionId: failure.sessionId,
          error: String(error),
        });
      });
    },
    onRefinementGate: (event) => {
      eventBus.emit('memory.sleep_consolidation.refinement_gate', event).catch((error: unknown) => {
        log.warn('Sleep-consolidation refinement gate event emit failed', { error: String(error) });
      });
    },
  });
  const arcWeaver = new EpisodeArcWeaver(episodicStore, llmProvider, {
    onThreadAssignment: emitThreadAssignment,
    passIntervalMs: schedulerConfig.arcFormation.passIntervalDays * MS_PER_DAY,
    reviewWindowMs: schedulerConfig.arcFormation.reviewWindowDays * MS_PER_DAY,
    minConfidence: schedulerConfig.arcFormation.minConfidence,
    maxArcsPerRun: schedulerConfig.arcFormation.maxArcsPerRun,
    maxEpisodesPerRun: schedulerConfig.arcFormation.maxEpisodesPerRun,
    onEvent: (event) => {
      eventBus.emit('memory.arc_formation.outcome', event).catch((error: unknown) => {
        log.warn('Arc-formation outcome event emit failed', {
          sessionId: event.sessionId,
          outcome: event.outcome,
          error: String(error),
        });
      });
    },
    personaPreamble,
  });
  const companionAuthoredEpisodicStore = persistenceRuntime.companionAuthoredEpisodicStore;
  const dreamMeaningPass = new DreamMeaningPass({
    getProcessingWatermark: scope => episodicStore.getProcessingWatermark(scope),
    searchByTime: searchOptions => episodicStore.searchByTime(searchOptions),
    upsertProcessingWatermark: input => episodicStore.upsertProcessingWatermark(input),
    updateCompanionAuthoredEpisode: input => (
      companionAuthoredEpisodicStore.updateCompanionAuthoredEpisode(input)
    ),
  }, agentLoop, {
    transcriptReader: sessionManager.storedSessionTranscriptReader,
    contactTrust: {
      resolveTrustRanks: async (contactIds) => {
        const entries = await Promise.all(contactIds.map(async (contactId) => {
          const contact = await contactStore.getById(contactId);
          return contact ? ([contactId, trustOrd(contact.trustLevel)] as const) : undefined;
        }));
        return new Map(entries.filter(
          (entry): entry is readonly [string, number] => entry !== undefined,
        ));
      },
    },
    onGateEvent: (event) => {
      eventBus.emit('memory.dream_meaning.gate', event).catch((error: unknown) => {
        log.warn('Dream-meaning gate event emit failed', { error: String(error) });
      });
    },
  });
  const sleeptimeWikiPass = createDisabledSleeptimeWikiPass();

  intentionRuntime.behavioralPatternTracker.setPromotionHook(
    createBehavioralPatternMemoryPromotionHook(memoryWriter),
  );
  const toolMemoryStore = createSubjectAuthorizedMemoryStore(
    memoryStore,
    () => memorySubjectAccessContextFromCorrelation(getRequestContext()),
  );
  const toolMemoryWriter = new MemoryWriter(toolMemoryStore, embeddingProvider, {
    memoryRetrievalPolicy: () => config.memoryRetrievalPolicy,
    ...(config.companionId ? { companionId: config.companionId } : {}),
    roomMembershipAuthority,
  });
  toolMemoryWriter.intakeSinkGateProvider = () => sessionManager.intakeSinkGate;
  registerMemoryTools(agentLoop, {
    writer: toolMemoryWriter,
    companionId: config.companionId,
    roomMembershipAuthority,
    memoryStore: toolMemoryStore,
    episodicStore,
    episodeSearch,
    sessionReader: sessionStore,
    sessionQuarantineFilter: episodeSessionQuarantineFilter,
    retrievalAccessScope: () => {
      const context = getRequestContext();
      return context?.requesterProvenance === 'self_directed'
        && context.channelId?.startsWith('internal:reflection:') === true
        ? 'companion_self_reflection'
        : undefined;
    },
    contactStore,
    memoryDeletionProposalStore: persistenceRuntime.memoryDeletionProposalStore,
    ...(options.memoryDeletionApprovalPort
      ? { memoryDeletionApprovalPort: options.memoryDeletionApprovalPort }
      : {}),
    memoryDeletionPolicy: () => config.memoryDeletionPolicy,
    memoryRetrievalPolicy: () => config.memoryRetrievalPolicy,
  });
  if (options.memoryDeletionApprovalPort) {
    await recoverPendingMemoryDeletionProposals(
      persistenceRuntime.memoryDeletionProposalStore,
      options.memoryDeletionApprovalPort,
    );
  }
  registerMarkdownJournalTools(agentLoop, pathSnapshot.workspaceRoot);

  const outboundSender: MessageSender = options.outboundSender ?? {
    send: async (channelId: string) => {
      throw new Error(`No host outbound sender is wired; cannot deliver to ${channelId}`);
    },
  };
  longHorizonFollowUpRouter = createLongHorizonFollowUpRouter({
    store: persistenceRuntime.scheduledPromptStore,
    scheduler,
    agentLoop,
    sender: outboundSender,
  });

  const outreachOutbox = await openFileOutreachOutboxStore(
    resolveOutreachOutboxLedgerPath(pathSnapshot.companionDataDir),
    { readLimitSettings: config },
  );
  const heartbeatChannel = options.heartbeatChannel;
  const heartbeatChannelId = heartbeatChannel?.channelId;
  const socialImpulseOutreachLane = registerSocialImpulseOutreachLane({
    companionId: resolveCoreCompanionIdFromConfig(config),
    store: persistenceRuntime.socialImpulseOutreachStore,
    getMode: () => config.emosimProactivity?.mode ?? 'off',
  });
  socialImpulseOutreachRuntime = socialImpulseOutreachLane.runtime;
  const socialOutreachDrafts = createSocialOutreachDraftRegistry();
  const listPendingConcernCandidates = () => listPendingConcernCandidatesFrom(intentionRuntime.concernStore);
  const outboundReplyGuard = new OutboundReplyDeduper();
  const proactiveOutbound = heartbeatChannelId
    ? new ProactiveOutboundDispatcher({
      sender: outboundSender,
      rateLimiter: externalRateLimiter,
      isApprovedPrimaryChannel: createApprovedPrimaryChannelPolicy(heartbeatChannelId),
      eventBus,
    })
    : null;
  const outwardQuietHours = staggerQuietHoursRelease(schedulerConfig.episodicProcessing, undefined);

  registerTemporalWakeupLane({
    scheduler,
    sessionManager,
    config: schedulerConfig.temporalWakeup,
    quietHours: outwardQuietHours,
    eventBus,
    agentLoop,
    llmProvider,
    promptRegistry: promptState.registry,
    proactiveOutbound,
    companionName: card.data.name,
    postTurnActions,
  });
  registerFreeTimeLane({
    scheduler,
    sessionManager,
    config: schedulerConfig.freeTime,
    restWindow: schedulerConfig.episodicProcessing,
    chooserSettings: schedulerConfig.socialAutonomy.freeTimeChooser,
    eventBus,
    agentLoop,
    llmProvider,
    promptRegistry: promptState.registry,
    companionName: card.data.name,
    companionId: config.companionId,
    chargePolicy: config.chargePolicy,
    personalProjects: EMPTY_PERSONAL_PROJECTS,
    contactStore,
    automataLifecycle: automataClassLifecycle,
    listPendingConcernCandidates,
    restSilenceStore: persistenceRuntime.schedulerLaneStateStore,
    postTurnActions,
  });
  registerWeightedThoughtOutreachLane({
    scheduler,
    schedulerConfig,
    eventBus,
    weightedThoughtStore: persistenceRuntime.weightedThoughtStore,
    llmProvider,
    companionName: card.data.name,
    heartbeatChannelId,
    contactStore,
    concernStore: intentionRuntime.concernStore,
    icpWeightedThoughtCandidateAdapter,
  });
  const { socialDesireOutbound, socialDesireHumanDeliveryPolicy, impulseTarget } = registerSocialDesireLane({
    schedulerConfig,
    scheduler,
    postTurnActions,
    eventBus,
    log,
    socialDesireStore: persistenceRuntime.socialDesireStore,
    outreachOutbox,
    heartbeatChannel,
    contactStore,
    icpPeers: undefined,
    localCompanionId: config.companionId,
    turns: agentLoop,
    sessions: sessionStore,
    readEmotion: () => emotionState.getState(),
    drafts: socialOutreachDrafts,
    concernStore: intentionRuntime.concernStore,
    companionName: card.data.name,
    attachFeltSignalWriter: (writer) => {
      agentLoop.socialDesireFeltSignals = writer;
    },
  });
  socialImpulseOutreachLane.setDesireTarget(impulseTarget);
  registerEmoSimProactivitySampling(scheduler, observerEvalSidecar);

  const observedGroupMemoryScheduler = new ObservedGroupMemoryScheduler({
    channelGroupMemory: undefined,
    sessionReader: sessionStore,
    watermarkStore: new JsonGroupMemoryWatermarkStore(
      `${pathSnapshot.companionDataDir}/group-memory-watermarks.json`,
    ),
    memoryExtractor,
    // This runtime uses the scheduler only to classify channel memory scope;
    // observed extraction and its timed retry run in the agent process.
    failureRetry: schedulerConfig.groupMemoryExtraction.failureRetry,
    contactStore,
    companionNames: [card.data.name],
    companionAuthorIds: config.discordBotId ? [config.discordBotId] : [],
    ...(config.groupMemory ? { groupMemory: config.groupMemory } : {}),
  });

  await wireReflectionRuntime(
    agentLoop,
    scheduler,
    agentLoop,
    outboundSender,
    pathSnapshot.companionDataDir,
    heartbeatChannelId,
    {
      eventBus,
      llmProvider,
      reasoningEffort: agentLoop.getReasoningEffortRuntime(),
      decisionRuntime,
      automataClassLifecycle,
      capabilityTier: config.capabilityTier,
      compositionalPolicy: config.compositionalPolicy,
      characterPromptVariablesProvider: buildCharacterPromptVariablesProvider(cardVersionStore),
      memoryWriter,
      promptRegistry: promptState.registry,
      reflectionStore: persistenceRuntime.reflectionStore,
      sessionManager,
      conversationalActivityWorkset: sessionComposition.conversationalActivityWorkset,
      emotionState,
      contactStore,
      getActiveConcerns: intentionAppraisalHooks.getActiveConcerns,
      getRecentResolvedConcerns: intentionAppraisalHooks.getRecentResolvedConcerns,
      onIntentionConcernDecision: intentionAppraisalHooks.onIntentionConcernDecision,
      onIntentionFollowUpDecision: intentionAppraisalHooks.onIntentionFollowUpDecision,
      resolveIntentionFollowUpDestination: createIntentionFollowUpDestinationResolver({
        ...(heartbeatChannelId
          ? { heartbeatChannel: { channelId: heartbeatChannelId, channelType: 'discord' as const } }
          : {}),
        contactStore,
        sessionStore,
        capabilityRuntime: capabilityAccess,
      }),
      getPendingFollowUpsForResurfacing: intentionAppraisalHooks.getPendingFollowUpsForResurfacing,
      onIntentionFollowUpActivated: intentionAppraisalHooks.onIntentionFollowUpActivated,
      onIntentionFollowUpDampened: intentionAppraisalHooks.onIntentionFollowUpDampened,
      onBehavioralPatternOutcome: intentionBehavioralHooks.onBehavioralPatternOutcome,
      pendingFollowUpStore: intentionRuntime.pendingFollowUpStore,
      intentionFollowUpHorizonMs: schedulerConfig.intentionFollowUp.nearTermHorizonMs,
      routeLongHorizonFollowUp,
      ...(icpIntentionCandidateAdapter ? { icpIntentionCandidateAdapter } : {}),
      scheduledPromptStore: persistenceRuntime.scheduledPromptStore,
      coreMemoryStore,
      episodicSynthesizer,
      sleepConsolidator,
      arcWeaver,
      dreamMeaningPass,
      episodicReviewStore: episodicStore,
      sleeptimeWikiPass,
      proactiveOutbound,
      outboundReplyGuard,
      outreachOutbox,
      ...(socialDesireOutbound ? { socialDesireOutbound } : {}),
      ...(socialDesireHumanDeliveryPolicy ? { socialDesireHumanDeliveryPolicy } : {}),
      listPendingConcernCandidates,
      concernCandidateReview: {
        list: listPendingConcernCandidates,
        decide: ({ id, decision, actionId }) => applyConcernCandidateDecision(intentionRuntime.concernStore, {
          id,
          decision,
          evidenceRef: { kind: 'runtime', ref: `sleeptime-review:${actionId}` },
        }),
      },
      verifyPersonalProjectLive: async () => false,
      memoryMaintenanceStore: memoryStore,
      episodicDiagnosticsStore: episodicStore,
      postTurnActions,
      backgroundMaintenance,
      episodicProcessingRestWindow: schedulerConfig.episodicProcessing,
      orientationRewriteGate: schedulerConfig.orientationRewrite,
      resolvedConcernStore: intentionRuntime.concernStore,
      reflectionNoveltyGate: schedulerConfig.reflectionNovelty,
      nearTurnMemoryCadence: schedulerConfig.nearTurnMemory,
      episodeSynthesis: schedulerConfig.episodeSynthesis,
      episodicWatermarkStore: episodicStore,
      companionNames: [card.data.name],
      companionAuthorIds: config.discordBotId ? [config.discordBotId] : [],
      memoryScopeClassifier: observedGroupMemoryScheduler,
      intentionAppraisalEnabled: config.intentionAppraisalEnabled !== false,
      vaultAutoPublisher: journalAutoPublisher,
    },
  );

  const postgresReadiness = await sealPostgresStoreReadinessBeforeReady();
  if (postgresReadiness.degraded.length > 0) {
    log.warn('Optional PostgreSQL stores degraded at startup', {
      stores: postgresReadiness.degraded.map(entry => entry.store).join(','),
      mismatches: postgresReadiness.degraded.map(entry => entry.mismatch).join('; '),
    });
  }
  scheduler.start();
  await eventBus.emit('system.init', {});
  await eventBus.emit('system.ready', {});
  log.info('Ready — waiting for messages');

  const stopSequence = createRetryableShutdown(async () => {
    unregisterIcpFeltImpulseAdapter();
    await stopIcpCandidateLifecycleSupervisor();
    const drainTimeoutMs = options.shutdownDrainTimeoutMs ?? schedulerConfig.tickIntervalMs;
    await runShutdownSequence([
      { step: 'emit system.shutdown event', action: () => eventBus.emit('system.shutdown', {}) },
      {
        step: 'abort background work recovery',
        action: () => agentLoop.abortBackgroundWorkRecovery(),
        failClosed: true,
      },
      { step: 'stop scheduler', action: () => scheduler.stop() },
      {
        step: 'stop durable background work supervisor',
        action: () => agentLoop.stopBackgroundWork(),
        failClosed: true,
      },
      {
        step: 'drain memory extractor',
        action: async () => {
          const drained = await memoryExtractor.stop({ timeoutMs: drainTimeoutMs });
          if (!drained) {
            log.warn('Proceeding with shutdown before extraction drain completed', { timeoutMs: drainTimeoutMs });
          }
        },
      },
      {
        step: 'write graceful shutdown markers',
        action: () => {
          const markedChannels = sessionStore.markGracefulShutdownForActiveChannels();
          if (markedChannels.length > 0) {
            log.info('Wrote graceful shutdown markers', { channels: markedChannels });
          }
        },
      },
      {
        step: 'close database',
        action: async () => {
          await detachToolAvailability();
          await companionAvailability.stop();
          await persistenceRuntime.contactLifecycleRecovery?.stop();
          await biographicalPool.end();
          await persistenceRuntime.icpFeltImpulseFunnelStore.close();
          await persistenceRuntime.emosimProactivityStateStore.close();
          await persistenceRuntime.socialImpulseOutreachStore.close();
          await persistenceRuntime.backgroundWorkStore.close();
          await persistenceRuntime.automataBusStore.close();
          await persistenceRuntime.automataRunRegistry.close();
          await persistenceRuntime.introspectionLandmarkStore.close();
          await persistenceRuntime.companionAvailabilityStore.close();
          await postgresPoolOwner.close();
        },
      },
    ], log);
    log.info('Stopped');
  });

  return {
    agentLoop,
    eventBus,
    scheduler,
    llmProvider,
    persistence: persistenceRuntime,
    sessionManager,
    subagentFaculty,
    garden: {
      config: coreConfig,
      companionId,
      companionDataDir: pathSnapshot.companionDataDir,
      characterCard: card,
      cardVersionStore,
      promptStore,
      promptRegistry,
      memoryStore,
      contactStore,
      sessionStore,
      concernStore: intentionRuntime.concernStore,
      embeddingService: embeddingProvider,
      socialGraphProposalStore,
      biographicalStore,
      emotionState,
      introspectionConsentStore,
      automataBusVector: automataBusProductionRuntime.vector,
    },
    stop: stopSequence,
  };
}
