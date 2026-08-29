import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import { join } from 'node:path';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { PendingContactApprovalStore } from '../../core/contacts/pending-contact-approvals.js';
import type { CharacterCardVersionStore } from '../../core/identity/card-versioning.js';
import { resolveCompanionNameFromConfig } from '../../core/identity/companion-runtime.js';
import { createPromptStatePort, type PromptStatePort } from '../../core/identity/prompt-state-port.js';
import {
  PromptRuntimeLayoutStore,
  resolvePromptRuntimeLayoutPath,
} from '../../core/identity/prompt-runtime.js';
import { invalidateCachedPromptRuntimeLayoutStore } from '../../core/identity/prompt-runtime-store-cache.js';
import type { CharacterCardV2 } from '../../core/identity/types.js';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import { resolveMorningWakeSnapshot } from '../../core/scheduler/temporal-wakeup.js';
import type { SessionManager } from '../../core/session/manager.js';
import type { PostTurnActionRuntime } from '../../core/agent/post-turn-action-runtime.js';
import { getObserverEvalSidecarHealthSnapshot } from '../../core/eval/observer-sidecar/runtime.js';
import type { ObserverEvalSidecarRuntime } from '../../core/eval/observer-sidecar/types.js';
import type { ConcernStorePort } from '../../core/intention/concern-store-port.js';
import type { OutreachOutboxStore } from '../../core/intention/outreach-outbox.js';
import { NorthStarStore } from '../../faculties/north-star/store.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import { createCompanionRoomMembershipAuthority } from '../../faculties/memory/companion-provenance.js';
import {
  createSubjectAuthorizedMemoryStore,
  type MemorySubjectAccessContext,
} from '../../faculties/memory/subject-authorized-store.js';
import { JsonGroupMemoryWatermarkStore } from '../../faculties/memory/extraction/group-ranges.js';
import type { GroupMemoryBackfillExtractorPort } from '../../faculties/memory/extraction/group-backfill.js';
import type { EpisodicStorePort } from '../../faculties/memory/episodic/store-port.js';
import {
  DEFAULT_PASS_INTERVAL_MS as DREAM_MEANING_PASS_INTERVAL_MS,
} from '../../faculties/memory/episodic/dream-meaning-pass.js';
import type { ShardExecutionPort } from '../../faculties/shards/port.js';
import type { SkillsRuntime } from '../../faculties/skills/runtime.js';
import type { AutomataRunRegistry } from '../../faculties/automata/run-registry.js';
import { ValuesJournalStore } from '../../faculties/values/store.js';
import { ReflectionJournalStore } from '../../persistence/journals/reflection-journal.js';
import { ReflectionMetacognitionJournalStore } from '../../persistence/journals/reflection-metacognition-journal.js';
import { ReflectionDailyJournalStore } from '../../persistence/journals/reflection-substrate.js';
import {
  resolveConfiguredCompanionDataDir,
  resolveConfiguredSystemDataDir,
  resolveChargeLedgerPath,
  resolveCogSecEventsPath,
  resolveConcernResolutionArcJournalPath,
  resolveDriftReviewCardsPath,
  resolveFatigueLedgerPath,
  resolveHumanAttentionLedgerPath,
  resolveIntakeQuarantinePath,
  resolveLegacyValuesJournalPath,
  resolveNorthStarPath,
  resolveReflectionDailyJournalsDir,
  resolveReflectionJournalPath,
  resolveReflectionMetacognitionJournalPath,
  resolveValuesJournalPath,
} from '../../persistence/layout.js';
import { readLastActiveSession } from '../../system/lifecycle/notifications.js';
import type { SessionStore } from '../../persistence/sessions/store.js';
import type { EventBus, EventMap } from '../../shared/event-bus.js';
import { emitGardenQueueChanged } from '../../shared/garden-queue-change.js';
import { RunChargeLedger } from '../../shared/telemetry/charge-ledger.js';
import { FatigueLedger } from '../../shared/telemetry/fatigue-ledger.js';
import { HumanAttentionPressureLedger } from '../../core/agent/fatigue/human-attention-ledger.js';
import type { ChannelGroupMemoryConfig } from '../../system/config/group-memory-config.js';
import { createPostgresModelUsageStoreFromConfig } from '../../persistence/postgres/model-usage-store.js';
import {
  resolveConfigTenantPoolScope,
  type TenantPoolScope,
} from '../../persistence/postgres/tenant-pool-scope.js';
import { createPostgresAnalysisWorkbenchTraceStoreFromConfig } from '../../persistence/postgres/analysis-workbench-trace-store.js';
import { createPostgresObserverEvalSidecarStore } from '../../core/eval/observer-sidecar/persistence.js';
import { createOwnerFileConfigStore } from '../../system/config/config-store.js';
import { AdminPartnerAffectShadowDataService } from './services/partner-affect-shadow-service.js';
import { AdminAutomataDataService, type AdminAutomataBusReadPort, type AdminAutomataLessonReadPort, type AdminAutomataReindexPort } from './services/automata-service.js';
import type { PartnerAffectShadowStorePort } from '../../core/emotion/partner-affect/shadow-store-port.js';
import {
  createDefaultEmoSimProactivitySettings,
  createDefaultObserverEvalSidecarSettings,
  sanitizeCoreSubstrateConfig,
  type SubstrateConfig,
} from '../../system/config/runtime-config-contracts.js';
import type {
  AdaptiveToolsStateProvider,
  AdminModelDiscoveryApi,
  ConfirmationQueueAdminApi,
  GardenAdminDomainServices,
} from './admin-contract.js';
import { AdminChatBootstrapService } from './chat/bootstrap.js';
import { AdminActionPipeDataService } from './services/action-pipe-service.js';
import { AdminAdaptiveToolsDataService } from './services/adaptive-tools-service.js';
import {
  AdminAuditHistoryDataService,
  GardenAuditHistoryJsonlStore,
  type GatewayAuditHistoryReader,
} from './services/audit-history-service.js';
import { registerAuditTimelineSources } from './services/audit-event-collector.js';
import { AdminChargeLedgerDataService } from './services/charge-ledger-service.js';
import { AdminChargeCostReconciliationDataService } from './services/charge-cost-reconciliation-service.js';
import { AdminConcernDataService } from './services/concern-service.js';
import { AdminSubjectVisibleAuditService } from './services/subject-visible-audit-service.js';
import { AdminContactsDataService } from './services/contacts-service.js';
import { createContactRelationshipScoreReader } from '../../core/contacts/trust-drift-signals.js';
import { createAdminPendingContactsService } from './services/pending-contacts-service.js';
import { createAdminRoomsService } from './services/rooms-service.js';
import { createAdminPlacesService } from './services/places-service.js';
import { createAdminEnrollmentService } from './services/enrollment-service.js';
import { HubIdentityEnrollmentService } from '../../core/enrollment/service.js';
import type { HubIdentityEnrollmentStorePort } from '../../core/enrollment/enrollment-store-port.js';
import { createAdminGraphProposalsService } from './services/graph-proposals-service.js';
import type { SocialGraphProposalStore } from '../../faculties/memory/social-graph/proposals.js';
import { AdminDashboardDataService } from './services/dashboard-service.js';
import { AdminSkillsDataService } from './services/skills-service.js';
import { AdminDiagnosticsDataService } from './services/diagnostics-service.js';
import { AdminEpisodicMemoryDataService } from './services/episodic-memory-service.js';
import { AdminGroupMemoryDataService } from './services/group-memory-diagnostics-service.js';
import { AdminIdentityDataService } from './services/identity-service.js';
import { AdminImagesDataService } from './services/images-service.js';
import { AdminMemoryDataService } from './services/memory-service.js';
import { AdminPrivacyBreakGlassService } from './services/privacy-break-glass-service.js';
import { AdminModelUsageDataService } from './services/model-usage-service.js';
import {
  AdminObserverEvalSidecarDataService,
  type AdminRecentProactivityOutcomeCounts,
  type AdminObserverEvalSidecarService,
} from './services/observer-eval-sidecar-service.js';
import { AdminPromptsDataService } from './services/prompts-service.js';
import { AdminSchedulerService } from './services/scheduler-service.js';
import {
  AdminSubsystemHealthDataService,
  type EpisodicWatermarkLaneDefinition,
} from './services/subsystem-health-service.js';
import { createAdminToolConformanceService } from './services/tool-conformance-service.js';
import type { ToolConformanceRunner } from '../../core/agent/tool-conformance/runner.js';
import type { GatewaySystemDataWriterPort } from '../../boundary/gateway/system-data-writer.js';
import { AdminSessionDataService } from './services/session-service.js';
import { AdminSettingsDataService, reloadOwnerModelsFromDisk } from './services/settings-service.js';
import {
  enqueuePendingCapabilityTierChangeNotice,
  formatCapabilityTierChangeNotice,
} from '../../system/capabilities/change-notice.js';
import { OwnerFileReloadWatcher } from './services/owner-file-reload-watcher.js';
import {
  createAdminIntakeQuarantineService,
  type IntakeReleaseRedeliveryPort,
} from './services/intake-quarantine-service.js';
import { createIntakeQuarantineStore } from '../../core/cogsec/intake/quarantine-store.js';
import { createAdminDriftReviewService } from './services/drift-review-service.js';
import { createDriftReviewCardStore } from '../../core/cogsec/drift/drift-review-card-store.js';
import { CogSecEventStore } from '../../core/cogsec/events.js';
import { AdminShardFoldReviewDataService } from './services/shard-fold-review-service.js';
import { AdminWikiDataService } from './services/wiki-service.js';
import { AdminWishlistDataService } from './services/wishlist-service.js';
import type { AdminIcpTestInitiationPort, AdminWishlistBeadCreatePort } from './services/types.js';
import type { AdminToolHealthProvider } from './tool-health-provider.js';
import type { GatewayCredentialPresenceResult } from '../../boundary/gateway/protocol.js';
import type { IcpInitiationCandidateStorePort } from '../../core/icp/autonomy-store-ports.js';
import type { IcpAutonomyRuntimeEnablement } from '../../core/icp/runtime-enablement.js';
import type { IcpFeltImpulseFunnelStorePort } from '../../core/icp/felt-impulse-funnel.js';
import type { IcpAdminProjectionStore } from '../../persistence/postgres/icp-admin-projection-store.js';
import { AdminIcpAutonomyDataService } from './services/icp-autonomy-service.js';
import type { SpeakingArbiterAdminStore } from '../../persistence/postgres/speaking-arbiter-admin-store.js';
import { AdminRoomArbiterDataService } from './services/room-arbiter-service.js';
import { AdminSharedWorkspaceService } from './services/shared-workspace-service.js';
import { requireAuditOpaqueIdKeyring } from './audit-opaque-id-keyring.js';
import type { BackgroundWorkStorePort } from '../../core/agent/background-work/store-port.js';
import type { OperatorAlertSinkConfiguration } from '../../shared/contracts/operator-alerting.js';

const log = createComponentLogger('GardenAdminContract');
const DAY_MS = 24 * 60 * 60_000;

/** Build the canonical operator-facing episodic watermark lanes. */
export function buildEpisodicWatermarkLaneDefinitions(config: {
  episodeSynthesis: { daytimeSlots: readonly string[] };
  arcFormation: { passIntervalDays: number };
}): readonly EpisodicWatermarkLaneDefinition[] {
  const slotMinutes = config.episodeSynthesis.daytimeSlots
    .map((slot) => {
      const [hour, minute] = slot.split(':').map(Number);
      if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
        throw new Error('Episode synthesis Garden cadence requires validated HH:mm daytime slots');
      }
      return (hour ?? 0) * 60 + (minute ?? 0);
    })
    .sort((left, right) => left - right);
  if (slotMinutes.length === 0) {
    throw new Error('Episode synthesis Garden cadence requires at least one daytime slot');
  }
  const dailyGaps = slotMinutes.map((slot, index) => {
    const next = slotMinutes[(index + 1) % slotMinutes.length] ?? slot;
    return next > slot ? next - slot : 24 * 60 - slot + next;
  });
  const maximumSlotGapMinutes = Math.max(...dailyGaps);
  return [
    {
      processor: 'episodic_synthesis',
      label: 'Episode synthesis watermark',
      description: 'Durable candidate-episode synthesis progress.',
      intervalMs: maximumSlotGapMinutes * 60_000,
    },
    {
      processor: 'sleep_consolidation',
      label: 'Sleep consolidation watermark',
      description: 'Durable nightly episode-consolidation progress.',
      intervalMs: DAY_MS,
    },
    {
      processor: 'dream_meaning',
      label: 'Dream meaning watermark',
      description: 'Durable first-person episode-meaning progress.',
      intervalMs: DREAM_MEANING_PASS_INTERVAL_MS,
    },
    {
      processor: 'wiki_pass',
      label: 'Sleeptime wiki watermark',
      description: 'Durable nightly wiki synthesis progress.',
      intervalMs: DAY_MS,
    },
    {
      processor: 'arc_formation',
      label: 'Arc formation watermark',
      description: 'Durable cross-day episodic arc-formation progress.',
      intervalMs: config.arcFormation.passIntervalDays * DAY_MS,
    },
  ];
}

export interface InProcessGardenAdminContractOptions {
  env?: NodeJS.ProcessEnv;
  apiBaseUrl?: string;
  apiHost?: string;
  apiPort?: number;
  memoryStore: MemoryStorePort;
  automataRunRegistry?: AutomataRunRegistry | null;
  /** Optional content source for the read-only Automata Bus operator projection. */
  automataBusReadPort?: AdminAutomataBusReadPort | null;
  /** Optional content-safe current-finding lesson projection. */
  automataLessonReadPort?: AdminAutomataLessonReadPort | null;
  /** Companion-bound, owner-policy-bounded rebuild of disposable Bus index state. */
  automataReindexPort?: AdminAutomataReindexPort | null;
  biographicalReviewService?: GardenAdminDomainServices['biographicalReview'];
  /** Fixed legacy-mode scope; fleet requests always use signed request context. */
  legacyMemorySubjectAccessContext?: Readonly<MemorySubjectAccessContext>;
  subsystemOutputRefStore?: Pick<BackgroundWorkStorePort, 'getSubsystemOutputProjection'> | null;
  /**
   * Resolve the trusted subject scope for Garden memory access. The resolver
   * must be bound by authenticated runtime authority, never request payloads.
   * Absence intentionally leaves the Garden memory surface fail closed.
   */
  resolveMemorySubjectAccessContext?: () => MemorySubjectAccessContext;
  episodicStore?: EpisodicStorePort | null;
  sessionStore: SessionStore;
  sessionManager: SessionManager;
  /** Canonical system-authored turn placement for released quarantine content. */
  intakeReleaseConversationTurn?: IntakeReleaseRedeliveryPort;
  scheduler: Scheduler;
  shardManager: ShardExecutionPort;
  eventBus: EventBus;
  contactStore?: ContactStorePort | null;
  concernStore?: ConcernStorePort | null;
  pendingFollowUpStore?: Pick<
    import('../../core/intention/pending-follow-up-store-port.js').PendingFollowUpStorePort,
    'list'
  > | null;
  scheduledPromptStore?: Pick<
    import('../../core/scheduler/scheduled-prompt-store-port.js').ScheduledPromptStorePort,
    'listPending'
  > | null;
  characterCard: CharacterCardV2;
  config: SubstrateConfig;
  embeddingService: EmbeddingProviderPort | null;
  modelDiscovery?: AdminModelDiscoveryApi | null;
  promptState?: PromptStatePort | null;
  cardVersionStore?: CharacterCardVersionStore | null;
  skillsRuntime?: SkillsRuntime | null;
  confirmationQueueApi?: ConfirmationQueueAdminApi | null;
  adaptiveToolsStateProvider?: AdaptiveToolsStateProvider | null;
  toolHealthProvider?: AdminToolHealthProvider | null;
  getCredentialPresence?: () => Promise<GatewayCredentialPresenceResult>;
  toolConformanceRunner?: ToolConformanceRunner | null;
  systemDataWriter?: GatewaySystemDataWriterPort;
  postTurnActions?: PostTurnActionRuntime | null;
  outreachOutbox?: OutreachOutboxStore | null;
  observerEvalSidecar?: ObserverEvalSidecarRuntime | null;
  channelGroupMemory?: ChannelGroupMemoryConfig;
  memoryExtractor?: GroupMemoryBackfillExtractorPort | null;
  companionAuthorIds?: readonly string[];
  /** Pending contact approvals queue (E3.4 contact-tracking policy gate). */
  pendingContactApprovals?: PendingContactApprovalStore | null;
  /** Social-graph edge proposals emitted by the graph-builder worker (E4.2). */
  socialGraphProposals?: SocialGraphProposalStore | null;
  /**
   * Hub-identity ↔ contact enrollment store (S10 D2a). When present (and a
   * contact store is wired) the Garden enrollment surface is live; absent, the
   * enrollment routes are simply not mounted. Biometrics never enter core.
   */
  hubIdentityEnrollmentStore?: HubIdentityEnrollmentStorePort | null;
  /** Shared runtime charge ledger; supplying it avoids duplicate event subscribers. */
  chargeLedger?: RunChargeLedger;
  humanAttentionLedger?: HumanAttentionPressureLedger;
  /** Runtime log directory for bounded diagnostics reads. Defaults to /app/logs when absent. */
  logsDir?: string;
  effectiveSchedulerConfig?: import('../../system/config/scheduler-config.js').SchedulerRuntimeConfig;
  icpInitiationCandidateStore?: IcpInitiationCandidateStorePort | null;
  icpFeltImpulseFunnelStore?: IcpFeltImpulseFunnelStorePort | null;
  icpAdminProjectionStore?: IcpAdminProjectionStore | null;
  /** Shadow-only Partner Affect observation store (docs/partner-affect.md slice 1). */
  partnerAffectShadowStore?: PartnerAffectShadowStorePort | null;
  icpRuntimeEnablement?: IcpAutonomyRuntimeEnablement | null;
  icpTestInitiation?: AdminIcpTestInitiationPort;
  /** Read-only fleet-wide arbiter projection; null in single-companion mode (jp36.8.1). */
  speakingArbiterAdminStore?: SpeakingArbiterAdminStore | null;
  /** Existing gateway-backed Beads create primitive used for explicit wish conversion. */
  wishlistBeadCreator?: AdminWishlistBeadCreatePort;
  /** Redacted startup snapshot used for the zero-sink health banner. */
  operatorAlerting?: OperatorAlertSinkConfiguration;
}

export function createInProcessGardenAdminContract(
  options: InProcessGardenAdminContractOptions,
): GardenAdminDomainServices {
  const publicConfig = sanitizeCoreSubstrateConfig(options.config) as SubstrateConfig;
  const promptState = options.promptState ?? createPromptStatePort({});
  const companionDataDir = resolveConfiguredCompanionDataDir(options.config);
  const configStore = createOwnerFileConfigStore({
    dataDir: options.config.dataDir,
    // capability-tier.json is a per-companion owner file (dnll.2): the Garden
    // editor must read/write the selected companion's file, not a shared one.
    companionDataDir,
    seedDir: process.env.CONFIG_DIR,
    defaultContextWindow: options.config.defaultContextWindow,
  });
  const resolveLastActiveSessionId = () => readLastActiveSession(companionDataDir)?.sessionId ?? null;
  const valuesJournal = new ValuesJournalStore(resolveValuesJournalPath(companionDataDir), {
    legacyFilePaths: [resolveLegacyValuesJournalPath(companionDataDir)],
  });
  const reflectionMetacognitionJournal = new ReflectionMetacognitionJournalStore(
    resolveReflectionMetacognitionJournalPath(companionDataDir),
  );
  const reflectionDailyJournal = new ReflectionDailyJournalStore(
    resolveReflectionDailyJournalsDir(companionDataDir),
  );
  const reflectionJournal = new ReflectionJournalStore(
    resolveReflectionJournalPath(companionDataDir),
  );
  const concernResolutionArcJournal = new ReflectionJournalStore(
    resolveConcernResolutionArcJournalPath(companionDataDir),
  );
  const northStarStore = new NorthStarStore(resolveNorthStarPath(companionDataDir));
  const chargeLedger = options.chargeLedger
    ?? new RunChargeLedger(resolveChargeLedgerPath(companionDataDir), options.eventBus);
  const fatigueLedger = new FatigueLedger(resolveFatigueLedgerPath(companionDataDir), options.eventBus);
  const humanAttentionLedger = options.humanAttentionLedger
    ?? new HumanAttentionPressureLedger(resolveHumanAttentionLedgerPath(companionDataDir));
  // The ledger is fleet-wide but has one explicit owner: the first companion
  // in canonical topology order. Garden reads it through a read-only pool and
  // retains the selected companion's query pin.
  const modelUsageStore = createPostgresModelUsageStoreFromConfig(
    options.config,
    undefined,
    'read_only',
  );
  const auditOpaqueIdKeyring = requireAuditOpaqueIdKeyring(
    options.config.gatewaySessionIntegrityAuthToken,
  );
  const modelUsage = modelUsageStore
    ? new AdminModelUsageDataService(modelUsageStore)
    : null;
  // vb11: durable analysis-workbench trace ring, bounded to the same 50-entry
  // window the in-memory dashboard ring uses, so traces survive a restart.
  // The trace-store factory resolves the tenant schema/role from config itself
  // (psfn-framework-stmof), so it needs no scope threaded from here.
  const analysisWorkbenchTraceStore = createPostgresAnalysisWorkbenchTraceStoreFromConfig(
    options.config,
    50,
  );
  const auditHistory = new AdminAuditHistoryDataService({
    gardenStore: new GardenAuditHistoryJsonlStore(join(companionDataDir, 'garden-audit-history.jsonl')),
    gatewayReader: resolveGatewayAuditReader(options.config),
    chargeLedger,
    scopeId: options.config.companionId ?? companionDataDir,
    opaqueIdKeyring: auditOpaqueIdKeyring,
  });
  const subjectAudit = new AdminSubjectVisibleAuditService({
    auditHistory,
    sessionManager: options.sessionManager,
    companionDataDir,
  });
  registerAuditTimelineSources({
    eventBus: options.eventBus,
    activeToolInvocations: new Map(),
    appendAuditTimelineEntry: (actionType, decision, narrative, details, actor) => {
      const joinedDetails = details
        ?.filter((detail): detail is string => typeof detail === 'string' && detail.trim().length > 0)
        .join(' ');
      auditHistory.appendGardenEntry({
        actionType,
        decision,
        narrative,
        ...(joinedDetails ? { details: joinedDetails } : {}),
        ...(actor ? { actor } : {}),
      });
    },
    resolveCompanionName: () => resolveCompanionNameFromConfig(options.config),
  });
  const promptRuntimeLayoutPath = resolvePromptRuntimeLayoutPath(companionDataDir);
  const promptRuntimeLayoutStore = new PromptRuntimeLayoutStore(
    promptRuntimeLayoutPath,
    {
      onMutation: (reason) => {
        invalidateCachedPromptRuntimeLayoutStore(promptRuntimeLayoutPath);
        options.config.runtimeHooks?.invalidatePromptPrefixCache?.(reason);
      },
    },
  );
  const adaptiveTools = new AdminAdaptiveToolsDataService({
    eventBus: options.eventBus,
    stateProvider: options.adaptiveToolsStateProvider ?? null,
    toolHealthProvider: options.toolHealthProvider ?? null,
  });
  const schedulerService = new AdminSchedulerService(
    options.scheduler,
    // Per-companion state (heartbeat-policy.json + reflection-metacognition
    // journal). Must match the runtime, which roots both under companionDataDir
    // (agent/main.ts wireReflectionRuntime); config.dataDir is the shared
    // system-data root and would collide across a multi-companion fleet.
    companionDataDir,
    // Live habit wake-window snapshot: recompute from the current scheduler
    // config + active-session partner timestamps on each read (E7.2).
    () => resolveMorningWakeSnapshot({
      sessionManager: options.sessionManager,
      morning: configStore.loadScheduler().temporalWakeup.morningWake,
    }),
  );
  const subsystemHealth = new AdminSubsystemHealthDataService({
    eventBus: options.eventBus,
    scheduler: schedulerService,
    postTurnActionQueueProvider: options.postTurnActions ?? null,
    ...(options.operatorAlerting ? { operatorAlerting: options.operatorAlerting } : {}),
    watermarkProvider: options.episodicStore ?? null,
    watermarkDefinitions: () => (
      buildEpisodicWatermarkLaneDefinitions(configStore.loadScheduler())
    ),
    ...(options.memoryStore.getStartupMemorySubjectClassificationCoverage
      ? {
        startupMemorySubjectClassificationCoverage:
          options.memoryStore.getStartupMemorySubjectClassificationCoverage(),
      }
      : {}),
  });
  const partnerAffectShadow = options.partnerAffectShadowStore
    ? new AdminPartnerAffectShadowDataService({
      store: options.partnerAffectShadowStore,
      loadPolicy: () => configStore.loadPartnerAffectShadow(),
    })
    : null;
  const toolConformance = options.toolConformanceRunner
    ? createAdminToolConformanceService(options.toolConformanceRunner)
    : null;
  const settingsService = new AdminSettingsDataService({
    config: options.config,
    configStore,
    ...(options.systemDataWriter ? { systemDataWriter: options.systemDataWriter } : {}),
    onCapabilityTierChanged: async (change) => {
      const targetSessionId = readLastActiveSession(companionDataDir)?.sessionId
        ?? options.sessionManager.listRecentSessions(1).at(0)?.sessionId;
      if (targetSessionId) {
        const entryId = options.sessionManager.recordSystemMessage(
          targetSessionId,
          formatCapabilityTierChangeNotice(change),
          'system:capability-policy',
          'Capability policy',
        );
        if (entryId === null) {
          throw new Error(
            `session "${targetSessionId}" cannot persist the companion capability-tier notice`,
          );
        }
      } else {
        enqueuePendingCapabilityTierChangeNotice(companionDataDir, change);
      }
      const event: EventMap['capability.tier.changed'] = {
        companionId: options.config.companionId ?? 'single-companion',
        previousTier: change.previous.tier,
        currentTier: change.current.tier,
        currentGrantedTokens: [...change.current.grantedTokens],
        grantedTokens: [...change.granted],
        withdrawnTokens: [...change.withdrawn],
        ...(targetSessionId ? { sessionId: targetSessionId } : {}),
        delivery: targetSessionId ? 'immediate' : 'pending',
        timestamp: Date.now(),
      };
      if (change.withdrawn.includes('external.companion')) {
        await options.eventBus.emitRequired('capability.tier.changed', event);
      } else {
        await options.eventBus.emit('capability.tier.changed', event);
      }
    },
    ...(options.getCredentialPresence ? { getCredentialPresence: options.getCredentialPresence } : {}),
    ...(options.effectiveSchedulerConfig
      ? { effectiveSchedulerConfig: options.effectiveSchedulerConfig }
      : {}),
  });
  // bead nudf: hot-reload models.json when it is edited directly on disk (no
  // Garden save) by re-reading it and driving the same in-place applySettings +
  // refreshModels hook the Garden save path uses. Other owner files are not
  // watched (see OwnerFileReloadWatcher.watchedOwnerFiles) and still require a
  // restart after a direct edit.
  const ownerFileReloadWatcher = new OwnerFileReloadWatcher({
    files: [{
      ownerFile: 'models.json',
      path: join(options.config.dataDir, 'models.json'),
      reload: () => {
        const result = reloadOwnerModelsFromDisk({ config: options.config, configStore });
        if (!result.ok) {
          throw new Error(`models.json disk reload failed: ${result.message}`);
        }
      },
    }],
  });
  ownerFileReloadWatcher.start();
  const icpContactStore = options.contactStore;
  const icpAutonomy = options.icpRuntimeEnablement && options.effectiveSchedulerConfig
    ? new AdminIcpAutonomyDataService({
      localCompanionId: options.config.companionId,
      candidateStore: options.icpInitiationCandidateStore ?? null,
      feltImpulseFunnelStore: options.icpFeltImpulseFunnelStore ?? null,
      projectionStore: options.icpAdminProjectionStore ?? null,
      runtimeEnablement: options.icpRuntimeEnablement,
      ...(options.icpTestInitiation ? { testInitiation: options.icpTestInitiation } : {}),
      settingsService,
      operatorLeaseTtlMs:
        options.effectiveSchedulerConfig.icpAutonomy.availability.operatorLeaseTtlMs,
      // hrmrq.34: sibling-seed visibility — count ICP-eligible companion
      // contacts so the quiet explanation can name a missing seed explicitly.
      ...(icpContactStore
        ? {
          countCompanionPeerContacts: async () => {
            const contacts = await icpContactStore.listAll();
            return contacts.filter(contact => contact.isMachineIntelligence === true
              && [
                ...(contact.channelIdentities ?? []),
                ...(contact.channels ?? []),
              ].some(identity => identity.channel.trim().toLowerCase() === 'companion')).length;
          },
        }
        : {}),
    })
    : null;
  const roomArbiter = new AdminRoomArbiterDataService({
    arbiterStore: options.speakingArbiterAdminStore ?? null,
  });

  // ── Intake quarantine approval queue (htm9.11 Cognitive Security tab) ──
  // Reads the same companion-data quarantine file the gateway/agent screening
  // pipelines write (the store reloads from disk on every operation), applies
  // human release/discard decisions through the envelope state machine, and
  // persists flywheel always-allow/always-deny into intake-policy sourceLists
  // through the settings owner-file path. The underlying store is constructed
  // LAZILY on first use: intake-policy.json is loaded on request (same lazy
  // posture as the settings service), so a missing owner file fails the
  // quarantine API call loudly instead of failing every Garden startup.
  let quarantineStore: ReturnType<typeof createIntakeQuarantineStore> | null = null;
  const getQuarantineStore = (): ReturnType<typeof createIntakeQuarantineStore> => {
    if (!quarantineStore) {
      const intakePolicy = configStore.loadIntakePolicy();
      quarantineStore = createIntakeQuarantineStore(
        resolveIntakeQuarantinePath(companionDataDir),
        {
          itemTtlHours: intakePolicy.quarantine.itemTtlHours,
          maxHeldItems: intakePolicy.quarantine.maxHeldItems,
          onExpired: ({ entry, expiredAtMs, reason }) => {
            void options.eventBus.emit('intake.quarantine.expired', {
              envelopeId: entry.id,
              ...(entry.sourceChannelId ? { sourceChannelId: entry.sourceChannelId } : {}),
              heldAtMs: entry.heldAtMs,
              expiredAtMs,
              reason,
            }).catch((error: unknown) => {
              log.error('Failed to emit intake quarantine expiry alert event', {
                envelopeId: entry.id,
                error: toErrorMessage(error),
              });
            });
          },
        },
      );
    }
    return quarantineStore;
  };
  const intakeQuarantine = createAdminIntakeQuarantineService({
    store: {
      hold: (input) => getQuarantineStore().hold(input),
      list: () => getQuarantineStore().list(),
      getById: (id) => getQuarantineStore().getById(id),
      applyDecision: (input) => getQuarantineStore().applyDecision(input),
      recordRedelivery: (input) => getQuarantineStore().recordRedelivery(input),
      findByArtifactPath: (path) => getQuarantineStore().findByArtifactPath(path),
      findByArtifactPaths: (paths) => getQuarantineStore().findByArtifactPaths(paths),
      recordAccessAttempt: (input) => getQuarantineStore().recordAccessAttempt(input),
      recordAccessAttempts: (inputs) => getQuarantineStore().recordAccessAttempts(inputs),
      checkArtifactAccesses: (batch) => getQuarantineStore().checkArtifactAccesses(batch),
      readRevisionToken: () => getQuarantineStore().readRevisionToken(),
      listActiveArtifactPaths: () => getQuarantineStore().listActiveArtifactPaths(),
      listActiveArtifactIdentities: () => getQuarantineStore().listActiveArtifactIdentities(),
    },
    settingsService,
    // Fresh store per decision: CogSecEventStore snapshots the file at
    // construction and the gateway writes the same file concurrently.
    cogSecEvents: () => new CogSecEventStore(resolveCogSecEventsPath(companionDataDir)),
    // A release must run through the ordinary system-turn pipeline. Merely
    // appending a system row to L0 creates an audit-visible entry that never
    // enters a TurnRecord or produces a reply. The injected port keeps the
    // firewall as author, carries the released envelope, executes the turn,
    // and delivers any companion response through the channel's normal egress.
    redeliverReleased: options.intakeReleaseConversationTurn ?? (async () => ({
      delivered: false,
      reason: 'canonical intake-release conversation turn is not configured',
    })),
    onQueueChanged: () => emitGardenQueueChanged(options.eventBus, 'intake-quarantine'),
  });

  // ── Drift review cards (htm9.14/htm9.15 Cognitive Security tab) ──
  // Reads the same companion-data card file the nightly drift lanes write
  // (the store reloads from disk on every operation) and records the
  // operator decision. Acknowledge/dismiss never mutate memories, trust, or
  // emotion; the operator-approved second-arrow consolidation is the single
  // exception, applied through the live memory store's existing supersession
  // machinery (same in-process instance the agent runtime uses).
  // The legacy admin session proves operator access but carries no subject
  // identity. Fleet-auth must supply that authority before Garden may expose
  // or mutate subject-classified memories.
  const legacyMemorySubjectAccessContext = Object.freeze({
    ...(options.legacyMemorySubjectAccessContext ?? {}),
  });
  const gardenMemoryStore = createSubjectAuthorizedMemoryStore(
    options.memoryStore,
    options.legacyMemorySubjectAccessContext !== undefined
      ? legacyMemorySubjectAccessContext
      : options.resolveMemorySubjectAccessContext ?? legacyMemorySubjectAccessContext,
  );
  const driftReviews = createAdminDriftReviewService({
    store: createDriftReviewCardStore(resolveDriftReviewCardsPath(companionDataDir)),
    memoryStore: gardenMemoryStore,
  });
  const memory = new AdminMemoryDataService({
    memoryStore: gardenMemoryStore,
    // A fixed subject projection is created from the underlying store by
    // AdminMemoryDataService for each immutable admitted request.
    fleetMemoryStore: options.memoryStore,
    contactStore: options.contactStore,
    embeddingService: options.embeddingService,
    ...(options.config.companionId ? { companionId: options.config.companionId } : {}),
    roomMembershipAuthority: createCompanionRoomMembershipAuthority(options.sessionStore),
    resolveCompanionName: () => resolveCompanionNameFromConfig(options.config),
    appendAuditTimelineEntry: (actionType, decision, narrative, details, requestContext) => {
      const joinedDetails = details
        ?.filter((detail): detail is string => typeof detail === 'string' && detail.trim().length > 0)
        .join(' ');
      auditHistory.appendGardenEntry({
        actionType,
        decision,
        narrative,
        ...(joinedDetails ? { details: joinedDetails } : {}),
        actor: 'operator',
        ...(requestContext ? { requestContext } : {}),
      });
    },
  });

  let automata: AdminAutomataDataService | null = null;
  if (options.automataRunRegistry) {
    if (!options.config.companionId) {
      throw new Error('Automata Garden service requires config.companionId');
    }
    if (!options.config.automataPolicy) {
      throw new Error('Automata Garden service requires automata-policy.json');
    }
    automata = new AdminAutomataDataService({
      registry: options.automataRunRegistry,
      companionId: options.config.companionId,
      readPolicy: {
        defaultPageLimit: options.config.automataPolicy.recentRunLimit,
        maxPageLimit: options.config.automataPolicy.operatorMutationLimit,
      },
      bus: options.automataBusReadPort ?? null,
      lessons: options.automataLessonReadPort ?? null,
      reindex: options.automataReindexPort ?? null,
    });
  }

  return {
    automata,
    dashboard: new AdminDashboardDataService({
      getMemoryStatsForRequest: context => memory.getStatsForRequest(context),
      sessionStore: options.sessionStore,
      sessionManager: options.sessionManager,
      scheduler: options.scheduler,
      shardManager: options.shardManager,
      eventBus: options.eventBus,
      modelUsageService: modelUsage,
      adaptiveToolsService: adaptiveTools,
      analysisWorkbenchTraceStore,
      resolveLastActiveSessionId,
      ...(options.effectiveSchedulerConfig
        && options.pendingFollowUpStore
        && options.scheduledPromptStore
        ? {
          intentionFollowUpRuntime: {
            nearTermHorizonMs: options.effectiveSchedulerConfig.intentionFollowUp.nearTermHorizonMs,
            pendingFollowUpStore: options.pendingFollowUpStore,
            scheduledPromptStore: options.scheduledPromptStore,
          },
        }
        : {}),
    }),
    diagnostics: new AdminDiagnosticsDataService({
      eventBus: options.eventBus,
      contactLifecycle: options.contactStore ?? null,
      ...(options.logsDir ? { logsDir: options.logsDir } : {}),
    }),
    images: new AdminImagesDataService({
      config: options.config,
      companionDataDir,
    }),
    auditHistory,
    subjectAudit,
    charges: new AdminChargeLedgerDataService(
      chargeLedger,
      fatigueLedger,
      options.config.chargePolicy?.fatigue ?? null,
      humanAttentionLedger,
    ),
    chargeCosts: modelUsageStore && options.config.companionId
      ? new AdminChargeCostReconciliationDataService(
          chargeLedger,
          modelUsageStore,
          options.config.companionId,
        )
      : null,
    modelUsage,
    observerEvalSidecar: createObserverEvalSidecarAdminService({
      config: options.config,
      runtime: options.observerEvalSidecar ?? null,
      eventBus: options.eventBus,
      // Agent process: this Garden serves exactly one companion, so its sidecar
      // pool must stay inside that companion's tenant boundary.
      tenant: resolveConfigTenantPoolScope(options.config),
    }),
    actionPipe: options.postTurnActions
      ? new AdminActionPipeDataService(options.postTurnActions, options.outreachOutbox ?? null)
      : null,
    shards: new AdminShardFoldReviewDataService(options.shardManager),
    adaptiveTools,
    wiki: options.config.workspacePath
      ? new AdminWikiDataService({
        workspacePath: options.config.workspacePath,
        systemDataDir: resolveConfiguredSystemDataDir(options.config),
        ...(options.systemDataWriter ? { systemDataWriter: options.systemDataWriter } : {}),
        // s10f9: shared-world writes project into shared.shared_wiki_chunks via
        // the SAME embedding port the runtime composed (gateway-backed in the
        // agent process). Multi-companion + missing Postgres fails the write
        // closed inside the projection runner.
        sharedProjection: {
          ...(options.config.postgresDatabaseUrl?.trim()
            ? { databaseUrl: options.config.postgresDatabaseUrl.trim() }
            : {}),
          ...(options.embeddingService ? { embedding: options.embeddingService } : {}),
          multiCompanion: options.config.multiCompanion === true,
          eventBus: options.eventBus,
        },
      })
      : null,
    wishlist: options.config.workspacePath
      ? new AdminWishlistDataService(
        options.config.workspacePath,
        options.wishlistBeadCreator,
      )
      : null,
    episodicMemory: options.episodicStore
      ? new AdminEpisodicMemoryDataService(options.episodicStore)
      : null,
    groupMemory: new AdminGroupMemoryDataService({
      ...(options.config.groupMemory ? { groupMemory: options.config.groupMemory } : {}),
      ...(options.channelGroupMemory ? { channelGroupMemory: options.channelGroupMemory } : {}),
      sessionStore: options.sessionStore,
      memoryStore: gardenMemoryStore,
      fleetMemoryStore: options.memoryStore,
      ...(options.contactStore ? { contactStore: options.contactStore } : {}),
      watermarkStore: new JsonGroupMemoryWatermarkStore(join(companionDataDir, 'group-memory-watermarks.json')),
      ...(options.memoryExtractor ? { memoryExtractor: options.memoryExtractor } : {}),
      eventBus: options.eventBus,
      companionNames: [resolveCompanionNameFromConfig(options.config)],
      companionAuthorIds: options.companionAuthorIds ?? [],
    }),
    memory,
    biographicalReview: options.biographicalReviewService ?? null,
    privacyBreakGlass: new AdminPrivacyBreakGlassService({
      memoryStore: options.memoryStore,
      journalReader: {
        listStream: (stream, limit) => {
          switch (stream) {
            case 'values-journal':
              return valuesJournal.list({ limit });
            case 'reflection-metacognition':
              return reflectionMetacognitionJournal.listRecent({ limit });
            case 'reflection-daily':
              return reflectionDailyJournal.listRecent({ limit });
            case 'reflection-journal':
              return reflectionJournal.listRecent({ limit });
          }
        },
      },
      confirmTtlMs: Math.min(options.config.fleetAuth?.ttls.escalationGrantMs ?? 120_000, 120_000),
    }),
    sessions: new AdminSessionDataService({
      sessionStore: options.sessionStore,
      sessionManager: options.sessionManager,
      eventBus: options.eventBus,
      contactStore: options.contactStore,
      concernStore: options.concernStore,
      memoryStore: gardenMemoryStore,
      subsystemOutputRefStore: options.subsystemOutputRefStore,
      config: options.config,
    }),
    contacts: new AdminContactsDataService({
      contactStore: options.contactStore,
      memoryStore: gardenMemoryStore,
      fleetMemoryStore: options.memoryStore,
      sessionStore: options.sessionStore,
      relationshipScoreReader: options.contactStore
        ? createContactRelationshipScoreReader(options.contactStore)
        : null,
    }),
    pendingContacts: options.pendingContactApprovals
      ? createAdminPendingContactsService({
        pendingApprovals: options.pendingContactApprovals,
        contactStore: options.contactStore ?? null,
        onQueueChanged: () => emitGardenQueueChanged(options.eventBus, 'contact-approvals'),
      })
      : null,
    rooms: createAdminRoomsService({
      contactStore: options.contactStore ?? null,
    }),
    places: createAdminPlacesService({
      dataDir: options.config.dataDir,
      fleetCompanionIds: options.config.companionFleet?.companions.map(
        companion => companion.companionId,
      ) ?? [],
      ...(options.systemDataWriter ? { systemDataWriter: options.systemDataWriter } : {}),
    }),
    enrollment: options.hubIdentityEnrollmentStore && options.contactStore
      ? createAdminEnrollmentService({
        enrollmentService: new HubIdentityEnrollmentService(
          options.hubIdentityEnrollmentStore,
          options.contactStore,
        ),
      })
      : null,
    graphProposals: options.socialGraphProposals
      ? createAdminGraphProposalsService({
        proposalStore: options.socialGraphProposals,
        contactStore: options.contactStore ?? null,
        onQueueChanged: () => emitGardenQueueChanged(options.eventBus, 'graph-proposals'),
      })
      : null,
    concerns: options.concernStore
      ? new AdminConcernDataService(options.concernStore, concernResolutionArcJournal)
      : null,
    settings: settingsService,
    ownerFileReloadWatcher,
    sharedWorkspace: options.config.sharedWorkspacePath
      ? new AdminSharedWorkspaceService(options.config.sharedWorkspacePath)
      : null,
    intakeQuarantine,
    driftReviews,
    identity: new AdminIdentityDataService({
      characterCard: options.characterCard,
      config: publicConfig,
      cardVersionStore: options.cardVersionStore,
      promptStore: promptState.layers,
    }),
    prompts: new AdminPromptsDataService({
      promptStore: promptState.layers,
      promptRegistry: promptState.registry,
      northStarStore,
      promptRuntimeLayoutStore,
      sessionStore: options.sessionStore,
      sessionManager: options.sessionManager,
      resolveCompanionName: () => resolveCompanionNameFromConfig(options.config),
      appendAuditTimelineEntry: (actionType, decision, narrative, details) => {
        const joinedDetails = details
          ?.filter((detail): detail is string => typeof detail === 'string' && detail.trim().length > 0)
          .join(' ');
        auditHistory.appendGardenEntry({
          actionType,
          decision,
          narrative,
          ...(joinedDetails ? { details: joinedDetails } : {}),
          actor: 'operator',
        });
      },
      companionValuesLayerProvider: () => valuesJournal.buildCompanionDerivedLayer(),
    }),
    scheduler: schedulerService,
    subsystemHealth,
    partnerAffectShadow,
    toolConformance,
    icpAutonomy,
    roomArbiter,
    skills: options.skillsRuntime
      ? new AdminSkillsDataService(options.skillsRuntime, configStore)
      : null,
    confirmations: options.confirmationQueueApi ?? null,
    values: valuesJournal,
    reflectionMetacognitionJournal,
    reflectionDailyJournal,
    reflectionJournal,
    modelDiscovery: options.modelDiscovery ?? null,
    chatBootstrap: new AdminChatBootstrapService(options.contactStore, {
      apiBaseUrl: options.apiBaseUrl,
      apiHost: options.apiHost,
      apiPort: options.apiPort,
      config: options.config,
      resolveGlobalDefaultSessionId: resolveLastActiveSessionId,
    }),
  };
}

export function createObserverEvalSidecarAdminService(input: {
  config: SubstrateConfig;
  runtime?: ObserverEvalSidecarRuntime | null;
  eventBus?: EventBus;
  /**
   * Tenant boundary for the sidecar's own pool. The sidecar tables are
   * companion-local, so the agent's in-process Garden pins its companion
   * schema/role here (psfn-framework-cc3v7). Fleet Garden reaches this service
   * through an agent-audience child assertion and companion transport proxy.
   */
  tenant?: TenantPoolScope;
}): AdminObserverEvalSidecarService {
  const settings = input.config.observerEvalSidecar ?? createDefaultObserverEvalSidecarSettings();
  const proactivity = input.config.emosimProactivity ?? createDefaultEmoSimProactivitySettings();
  const companionId = input.config.companionId?.trim() || null;
  const manifestBinding = input.config.companionRuntimeIdentity?.observerEvalSidecar;
  let lastTransition: EventMap['emotion.proactive.transition'] | null = null;
  const recentSinceMs = Date.now();
  let recentTotal = 0;
  const recentCounts: AdminRecentProactivityOutcomeCounts = {
    qualified: 0,
    delivered: 0,
    suppressed: 0,
    deferred: 0,
    deduped: 0,
    other: 0,
  };
  input.eventBus?.on('emotion.proactive.transition', (event) => {
    lastTransition = structuredClone(event);
    recentTotal += 1;
    if (event.outcome === 'qualified') recentCounts.qualified += 1;
    else if (event.outcome === 'sent') recentCounts.delivered += 1;
    else if (event.outcome === 'deferred' || event.outcome === 'throttled') {
      recentCounts.deferred += 1;
    } else if (event.outcome === 'deduped') recentCounts.deduped += 1;
    else if (event.outcome === 'suppressed'
      || event.outcome === 'declined'
      || event.outcome === 'rejected'
      || event.outcome === 'not_authorized'
      || event.outcome === 'no_eligible_peer') {
      recentCounts.suppressed += 1;
    } else recentCounts.other += 1;
  });

  const postgresDatabaseUrl = input.config.postgresDatabaseUrl?.trim();
  const persistence = settings.persistence.enabled
    && settings.garden.exposeTelemetry
    && input.config.persistenceBackend === 'postgres'
    && postgresDatabaseUrl
    ? createPostgresObserverEvalSidecarStore(postgresDatabaseUrl, {}, input.tenant)
    : null;

  return new AdminObserverEvalSidecarDataService({
    persistence,
    // The Postgres store implements both the observation and lever ports;
    // the Garden admin service is the ONLY reader of lever events.
    leverEvents: persistence,
    getHealthSnapshot: () => getObserverEvalSidecarHealthSnapshot(input.runtime),
    companionId,
    binding: companionId && manifestBinding
      ? {
          companionId,
          sidecarId: manifestBinding.sidecarId,
          sessionLabel: manifestBinding.sessionLabel,
          agentName: manifestBinding.agentName,
        }
      : null,
    configuredEnabled: settings.enabled,
    proactivityMode: proactivity.mode,
    proactivityProfile: proactivity.thresholdProfile,
    getRecentProactivityOutcomes: () => ({
      sinceMs: recentSinceMs,
      total: recentTotal,
      counts: structuredClone(recentCounts),
    }),
    getLastTransition: () => lastTransition ? structuredClone(lastTransition) : null,
  });
}

function resolveGatewayAuditReader(_config: SubstrateConfig): GatewayAuditHistoryReader | null {
  return null;
}
