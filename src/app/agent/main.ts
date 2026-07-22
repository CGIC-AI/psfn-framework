// ── Agent Container Entry Point ──
// Runs inside an isolated container. Connects to gateway via the configured RPC endpoint.
// Run: npx tsx src/app/agent/main.ts

import { join, resolve } from 'node:path';
import { ensureActiveTimezone } from '../../shared/time/active-timezone.js';
import { createComponentLogger } from '../../shared/logger.js';
import { GatewayClient } from '../../boundary/gateway/client.js';
import { resolveCoreCompanionIdFromConfig } from '../../core/identity/companion-runtime.js';
import { formatGatewayRpcEndpoint } from '../../boundary/gateway/transport.js';
import { attachCompanionEventForwarder } from '../../channels/backplane/companion-relay/agent-forwarder.js';
import { createPolicyGovernedShardParentIcpDelivery } from '../../channels/backplane/shard-parent-icp-ingress.js';
import { parsePositiveIntEnv } from '../../shared/utils/env.js';
import { MemoryWriter } from '../../faculties/memory/writer.js';
import { resolveDocumentIngestLimits } from '../../faculties/file-ingest/index.js';
import { EpisodicSynthesizer } from '../../faculties/memory/episodic/index.js';
import { SleepCycleEpisodeConsolidator } from '../../faculties/memory/episodic/sleep-consolidation.js';
import { EpisodeArcWeaver } from '../../faculties/memory/episodic/arc-formation.js';
import { DreamMeaningPass } from '../../faculties/memory/episodic/dream-meaning-pass.js';
import { SleeptimeWikiPass } from '../../faculties/wiki/sleeptime-wiki-pass.js';
import { WikiStore } from '../../faculties/wiki/store.js';
import { ProactiveOutboundDispatcher } from '../../core/intention/proactive-outbound.js';
import {
  registerTemporalWakeupTasks,
  TEMPORAL_WAKEUP_MORNING_TASK_NAME,
} from '../../core/scheduler/temporal-wakeup.js';
import { registerFreeTimeTasks } from '../../core/scheduler/free-time.js';
import {
  FreeTimeWorkspaceResolver,
  type FreeTimeProjectRecord,
  type FreeTimeWorkspaceContext,
} from '../../core/scheduler/free-time-workspace-resolver.js';
import type { PersonalProjectWorkContext } from '../../faculties/wiki/personal-projects.js';
import {
  FreeTimeChooser,
  createFreeTimeRoomChannelResolver,
  type FreeTimeProjectSummary,
} from '../../core/scheduler/free-time-chooser.js';
import { InMemoryRestWindowPolicy } from '../../core/scheduler/rest-window-policy.js';
import { classifyChannelDisclosure, getVisibilityDisclosureCeiling } from '../../system/trust/policy.js';
import { trustOrd } from '../../system/trust/types.js';
import { deriveConversationScopeEnvelope } from '../../core/session/conversation-scope.js';
import { registerWeightedThoughtOutreachTask } from '../../core/scheduler/weighted-thought-outreach-lane.js';
import { createLlmNudgeEvaluator } from '../../core/intention/weighted-thought-nudge-evaluator.js';
import { recordWeightedThought } from '../../core/intention/weighted-thought-store-port.js';
import { registerSocialDesireOutreachTask } from '../../core/scheduler/social-desire-outreach-lane.js';
import { createLlmSocialDesireConsentEvaluator } from '../../core/intention/social-desire-consent-evaluator.js';
import {
  createSocialDesireConsentLedger,
  createSocialDesireOutboundRuntime,
  type SocialDesireDeliveryChannel,
  type SocialDesireOutboundRuntime,
} from '../../core/intention/social-desire-outreach.js';
import { createContactSocialDesireTierSource } from '../../core/intention/social-desire-store-port.js';
import {
  createSocialDesireHumanDeliveryPolicy,
  type SocialDesireHumanDeliveryPolicy,
} from '../../core/intention/social-desire-human-policy.js';
import { composeCompanionDmChannelId } from '../../shared/contracts/companion-channels.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { CanonicalCompanionPeerValidationError } from '../../core/icp/agent-facing-autonomy.js';
import { REFLECTION_SILENT_TOKEN } from '../../core/scheduler/reflection-policy.js';
import {
  getRunChargeSnapshot,
  runWithChargeContext,
} from '../../shared/telemetry/run-charge.js';
import { RunChargeLedger } from '../../shared/telemetry/charge-ledger.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import { summarizeRecentSessionEntries } from '../../core/session/manager/compaction-service.js';
import type { ChannelType } from '../../shared/contracts/runtime.js';
import { createFileOutreachOutboxStore } from '../../core/intention/outreach-outbox.js';
import { registerMemoryTools } from '../../faculties/memory/runtime-wiring.js';
import {
  createSubjectAuthorizedMemoryStore,
  memorySubjectAccessContextFromCorrelation,
} from '../../faculties/memory/subject-authorized-store.js';
import { registerGitTools } from '../../boundary/integrations/git/runtime-wiring.js';
import { registerShellTools } from '../../boundary/integrations/shell/runtime-wiring.js';
import { GatewayShellOps } from '../../boundary/integrations/shell/gateway-ops.js';
import type { SandboxExecutionPort } from '../../boundary/sandbox/capabilities/contracts.js';
import { GatewayGitOps } from '../../boundary/integrations/git/gateway-ops.js';
import { registerBeadsTools } from '../../boundary/integrations/beads/runtime-wiring.js';
import { resolveBeadsToolsEnabled } from '../../boundary/integrations/beads/enablement.js';
import { GatewayBeadsOps } from '../../boundary/integrations/beads/gateway-ops.js';
import { registerWorldTools } from '../../boundary/integrations/world/runtime-wiring.js';
import { GatewayWorldOps } from '../../boundary/integrations/world/gateway-ops.js';
import { createBehavioralPatternMemoryPromotionHook } from '../../core/intention/patterns.js';
import {
  wireOperatorHookRuntime,
  wireShardAndThinkRuntime,
} from '../startup/composition/composition.js';
import { createPreToolHookGate } from '../../boundary/gateway/pre-tool-hook.js';
import { resolveToolAliasMatchers } from '../../core/agent/tool-surface/registry.js';
import {
  buildCharacterPromptVariablesProvider,
  buildReplConfig,
  wireReflectionRuntime,
} from '../startup/composition/parity.js';
import { createAgentPersistenceRuntime } from '../../persistence/runtime-factory.js';
import { CompanionPresenceRuntime } from '../../core/agent/companion-presence-runtime.js';
import {
  resolveDriftReviewCardsPath,
  resolveChargeLedgerPath,
  resolveIntakeQuarantinePath,
  resolveIntrospectionValuesFindingsPath,
  resolveLegacyValuesJournalPath,
  resolveOutreachOutboxLedgerPath,
  resolvePendingContactApprovalsPath,
  resolveSocialGraphProposalsPath,
  resolveSocialGraphBuilderWatermarkPath,
  resolveValuesJournalPath,
} from '../../persistence/layout.js';
import { createFilePendingContactApprovalStore } from '../../core/contacts/pending-contact-approvals.js';
import {
  createFileSocialGraphProposalStore,
  createFileSocialGraphBuilderWatermarkStore,
} from '../../faculties/memory/social-graph/proposals.js';
import { createContactTrackingGate } from '../../core/contacts/tracking-gate.js';
import { rehydratePersistedInternalState } from '../../core/self-model/internal-state-persistence.js';
import { createPostgresObserverEvalSidecarStore } from '../../core/eval/observer-sidecar/persistence.js';
import { resolveConfigTenantPoolScope } from '../../persistence/postgres/tenant-pool-scope.js';
import { createEmoSimDyadRelationshipAdvisoryProvider } from '../../core/eval/observer-sidecar/dyad-relationship-advisory-provider.js';
import { ModuleLoader } from '../../system/modules/loader.js';
import { DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE } from '../../core/agent/tool-wiring-validator.js';
import { registerGatewayMessageHandlers } from './gateway-message-handlers.js';
import { registerIcpTargetChannelInitiationCommand } from './icp-target-channel-command.js';
import { OutboundReplyDeduper } from '../../system/lifecycle/outbound-reply-dedupe.js';
import { resolveGatewayConnectFailureExitCode } from './gateway-connect-failure.js';
import { ObservedGroupMemoryScheduler } from '../../faculties/memory/extraction/group-observed-scheduler.js';
import { PassiveNameCandidateBuilder } from '../../core/participation/passive-name-candidate.js';
import { ParticipationAppraiser } from '../../core/participation/appraiser.js';
import {
  SpeakingReservationPhase,
  type IcpSocialPrecedenceResolver,
} from '../../core/agent/arbiter/reservation-phase.js';
import { SpeakingEgressLeasePhase } from '../../core/agent/arbiter/egress-lease-phase.js';
import { createIcpSpeakingPrecedenceResolver } from '../../core/icp/speaking-precedence-resolver.js';
import { readRoomEpisodePressureFromLedger } from '../../core/agent/fatigue/room-episode-pressure.js';
import { createAgentLoopEgressReplySender } from './egress-reply-sender.js';
import {
  createDefaultEgressLeasePhaseSettings,
} from '../../system/config/participation-config.js';
import { JsonGroupMemoryWatermarkStore } from '../../faculties/memory/extraction/group-ranges.js';
import { createNoopSatelliteRoutingPort } from '../../core/agent/satellite-adapter-port.js';
import { createRequestCapabilityVerifier } from '../../boundary/fleet-auth/request-capability.js';
import {
  createSignalShutdownHandler,
  installSignalHandlers,
  registerProcessErrorHandlers,
} from '../startup/support/signal-shutdown.js';
import { buildAgentControlPlane } from './control-plane.js';
import type { AgentControlPlaneShutdownTargets } from './control-plane.js';
import { createLLMProviderPort } from '../../core/agent/contracts.js';
import { wireIcpInitiationSources } from './icp-initiation-source-wiring.js';
import { wireCompanionPresenceContext } from './companion-presence-wiring.js';
import { createGatewayOpsPortFromClient } from '../../boundary/gateway/gateway-ops-port.js';
import {
  bootstrapAgentCoreRuntime,
} from './core-bootstrap.js';
import { resolveSharedSatelliteFatigueEligibility } from '../../core/agent/fatigue/shared-satellite-eligibility.js';
import {
  buildApiHealthChecks,
  resolveAgentApiSurfaceBindings,
} from './api-surface.js';
import { startOptionalAdminTransportServer } from './admin-surface.js';
import {
  buildAgentSchedulerRuntime,
} from './scheduler-runtime.js';
import {
  createSessionActivityTracker,
  writeStartupSessionMetadata,
} from './session-activity.js';
import { loadIntakePolicyConfig } from '../../system/config/intake-policy-config.js';
import { maybeCreateIntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import { loadPartnerAffectShadowConfig } from '../../system/config/partner-affect-shadow-config.js';
import { createPartnerAffectShadowIngestBridge } from '../../core/emotion/partner-affect/shadow-ingest-bridge.js';
import { createIntakeQuarantineStore } from '../../core/cogsec/intake/quarantine-store.js';
import { createDriftReviewCardStore } from '../../core/cogsec/drift/drift-review-card-store.js';
import { createDriftVelocityEvidencePort } from '../../core/cogsec/drift/drift-evidence-adapters.js';
import { createSecondArrowEvidencePort } from '../../core/cogsec/drift/second-arrow-evidence-adapters.js';
import { emitGardenQueueChanged } from '../../shared/garden-queue-change.js';
import { enforceNetworkIsolationOnStartup } from './startup-guards.js';
import {
  DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG,
  DEFAULT_INTROSPECTION_AUDIT_CONFIG,
} from '../../system/config/scheduler-config.js';
import {
  createLLMCompanionLandmarkReflector,
  createLLMIntrospectionAuditor,
} from '../../faculties/introspection/model-runtime.js';
import { IntrospectionAuditRuntime } from '../../faculties/introspection/runtime.js';
import { registerIntrospectionAuditTask } from '../../faculties/introspection/scheduler-lane.js';
import { registerToolUsageEvaluatorTask } from '../../core/agent/tool-surface/usage-evaluator-scheduler-lane.js';
import { createTurnRecordIntrospectionSource } from '../../faculties/introspection/source.js';
import {
  createLLMValuesConsistencyEvaluator,
  IntrospectionValuesConsistencyRuntime,
  ValuesConsistencyFindingStore,
} from '../../faculties/introspection/values-consistency.js';
import { ValuesJournalStore } from '../../faculties/values/store.js';
import {
  hydrateStartupContinuity,
  requireWikiStartupHydrationTuning,
} from './startup-continuity.js';
import {
  createOptionalJournalAutoPublisher,
  registerMarkdownJournalTools,
} from './journal-runtime.js';
import { prepareAgentStartupContext } from './startup-context.js';
import { AgentApiBackend } from '../../channels/api/agent-backend.js';
import { resolveActiveHealthProbeConfig } from '../../channels/api/active-health-probe.js';
import { buildExternalChannelProfiles, resolveDiscordCompanionView } from '../../channels/backplane/config.js';
import { createAgentFleetPostureProvider } from './fleet-posture.js';

const log = createComponentLogger('Agent');
ensureActiveTimezone();
const DEFAULT_SHUTDOWN_FORCE_EXIT_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const {
    config,
    coreConfig,
    lifecycleRuntimeContract,
    runtimeStatusMeta,
    pathSnapshot,
    schedulerConfig,
    channelsConfig,
    satelliteRegistryConfig,
    placesRegistryConfig,
    backupConfig,
    capabilityRuntime,
    eligibilityGate,
    gatewayRpcEndpoint,
    moduleRegistryPath,
    eventBus,
    stopDebugObserver,
  } = prepareAgentStartupContext({
    env: process.env,
    log,
  });

  log.info('Initializing...');
  log.info('Lifecycle runtime contract resolved', runtimeStatusMeta);
  await enforceNetworkIsolationOnStartup();

  // ── Connect to gateway ──

  const embeddingDims = config.embeddingDims ?? 1024;
  const primaryUserId = config.voiceTargetUserId?.trim() || process.env.PRIMARY_USER_ID;

  log.info(`Connecting to gateway at ${formatGatewayRpcEndpoint(gatewayRpcEndpoint)}...`);
  let gateway: GatewayClient;
  try {
    gateway = await GatewayClient.connectEndpoint(gatewayRpcEndpoint, embeddingDims, {
      companionId: resolveCoreCompanionIdFromConfig(config),
      ...(config.fleetAuthVerifier
        ? {
            requestCapabilityVerifier: createRequestCapabilityVerifier(
              config.fleetAuthVerifier.requestCapabilities,
            ),
          }
        : {}),
      ...(config.gatewayCompanionAuthToken
        ? { companionAuthToken: config.gatewayCompanionAuthToken }
        : {}),
      ...(config.gatewaySessionIntegrityAuthToken
        ? { sessionIntegrityAuthToken: config.gatewaySessionIntegrityAuthToken }
        : {}),
      // 23pp per-companion model selection: this companion's effective purpose →
      // slot-key map (settings.json + settings.overlay.json, validated at startup
      // against models.json). Transported per call as the wire slotKey and
      // re-validated fail-closed by the gateway registry.
      ...(config.modelPurposeSelection
        ? { modelPurposeSelection: config.modelPurposeSelection }
        : {}),
      onModelBudgetBlocked: (event) => {
        eventBus.emit('model.budget.blocked', event).catch((error) => {
          log.error('Failed to bridge gateway model budget telemetry', {
            error: error instanceof Error ? error.message : String(error),
            provider: event.provider,
            model: event.model,
            reason: event.reason,
          });
        });
      },
    });
  } catch (error) {
    // The connect retry budget (exponential backoff in the transport client) was
    // exhausted before the gateway became ready. Exit through the supervised
    // restart path so a fresh process re-attempts the connection, rather than
    // dying with a generic fatal exit(1).
    const exitCode = resolveGatewayConnectFailureExitCode(lifecycleRuntimeContract.restart);
    log.error('Gateway connection could not be established; exiting for supervised restart', {
      error: error instanceof Error ? error.message : String(error),
      exitCode,
      restartStrategy: lifecycleRuntimeContract.restart.strategy,
    });
    process.exit(exitCode);
  }
  // Self-report companion identity before any other traffic. Multi-companion
  // gateways reject unidentified agents fail-closed; a failure here is fatal.
  await gateway.identifyAsAgent();
  const llmProvider = createLLMProviderPort(gateway);
  const gatewayOps = createGatewayOpsPortFromClient(gateway);
  log.info('Connected to gateway', {
    ...(config.companionId ? { companionId: config.companionId } : {}),
  });
  let shuttingDown = false;
  let stopFn: () => Promise<void> = async () => {};
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Callback API intentionally receives this Promise-returning lifecycle handler.
  const unregisterGatewayDisconnect = gateway.onDisconnect(async (event) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.error('Gateway connection lost; shutting down agent process', {
      source: event.source,
      error: event.error?.message,
    });
    // Fail closed on disconnect (bead imlb): the GatewayClient has no in-process
    // reconnect, and surface routing (companionConnections) is only repopulated
    // when the agent re-runs gateway.client.identify on a fresh connection. If a
    // graceful stop fails we must NOT linger — a process left alive here is
    // "connected but unregistered": it never re-identifies, so inbound channel
    // routing keeps failing with companion_not_connected. Force the exit so the
    // supervisor restarts the process and re-registers every surface.
    try {
      await stopFn();
    } catch (error) {
      log.error('Gateway disconnect shutdown failed; forcing exit so the supervisor restarts and re-registers surfaces', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    process.exit(resolveGatewayConnectFailureExitCode(lifecycleRuntimeContract.restart));
  });

  const persistenceRuntime = await createAgentPersistenceRuntime({
    config,
    pathSnapshot,
    embeddingDims,
    primaryUserId,
    contactLifecycleGateway: gateway,
    onContactLifecycleRecoveryFailure: (error) => {
      log.error('Contact lifecycle recovery worker failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const {
    backend: persistenceBackend,
    memoryStore: companionMemoryStore,
    episodicStore: companionEpisodicStore,
    backgroundWorkStore,
    reflectionStore,
    contactStore: persistedContactStore,
    hubIdentityEnrollmentStore: persistedHubIdentityEnrollmentStore,
    intentionRuntime: persistedIntentionRuntime,
    intentionProviders,
  } = persistenceRuntime;
  log.info('PostgreSQL persistence backend selected', {
    persistenceBackend,
  });

  // ── Cross-companion presence (sprint 10, W5a) ──
  // Multi-companion only: the persistence factory hands back a shared-schema
  // presence store IFF the flag is on (and has already provisioned the shared
  // schema). The runtime writes this agent's own row on situated turns, serves
  // co-presence to the situated context section, and emits co-location events.
  // Fails closed here if COMPANION_ID is not the fleet-contract UUID format.
  const companionPresenceRuntime = persistenceRuntime.companionPresenceStore
    ? new CompanionPresenceRuntime({
      store: persistenceRuntime.companionPresenceStore,
      companionId: config.companionId ?? '',
      eventBus,
      placesRegistry: placesRegistryConfig,
    })
    : null;
  if (companionPresenceRuntime) {
    log.info('Cross-companion presence runtime enabled', {
      companionId: config.companionId,
    });
  }

  // ── Contact-tracking policy gate (E3.4) ──
  // Per-channel contactTracking labels come from channels.json contextEnvelope
  // (default 'auto'). Approval-mode channels enqueue new speakers into a
  // durable pending-approval queue; the operator notification goes through the
  // gateway notification path with a system-derived sender.
  const pendingContactApprovals = createFilePendingContactApprovalStore(
    resolvePendingContactApprovalsPath(pathSnapshot.companionDataDir),
  );

  // ── Social-graph builder worker stores (E4.2) ──
  // Durable, file-backed proposal queue + advisory watermark cursor for the
  // background graph-builder worker. Shared between the scheduler task (writer)
  // and the Garden review surface (reader/decider).
  const socialGraphProposalStore = createFileSocialGraphProposalStore(
    resolveSocialGraphProposalsPath(pathSnapshot.companionDataDir),
  );
  const socialGraphWatermarkStore = createFileSocialGraphBuilderWatermarkStore(
    resolveSocialGraphBuilderWatermarkPath(pathSnapshot.companionDataDir),
  );
  const contactTrackingGate = createContactTrackingGate({
    channelLabels: channelsConfig.contextEnvelope.channels,
    pendingApprovals: pendingContactApprovals,
    notifyOperatorPendingContact: async (entry) => {
      await gateway.notifyNtfy({
        sender: { kind: 'system', provenance: 'system.contacts.pending_approval' },
        title: 'PSFN contact approval required',
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

  // ── Load identity (mounted read-only in container) ──

  const postgresDatabaseUrl = config.postgresDatabaseUrl?.trim();
  if (!postgresDatabaseUrl) {
    throw new Error('Agent core runtime requires POSTGRES_DATABASE_URL');
  }

  const {
    card,
    systemPrompt,
    cardVersionStore,
    cardProposalQueue,
    coreRuntime,
    emotionState,
    operatorNotifier,
    safeguardSurfaces,
  } = await bootstrapAgentCoreRuntime({
    config: coreConfig,
    continuityChannelIds: Object.keys(channelsConfig.contextEnvelope.channels),
    postgresDatabaseUrl,
    pathSnapshot,
    eventBus,
    gateway,
    memoryStore: companionMemoryStore,
    episodicStore: companionEpisodicStore,
    backgroundWorkStore,
    backgroundWorkTuning: schedulerConfig.backgroundWork,
    backgroundWorkWelfare:
      schedulerConfig.backgroundWorkWelfare ?? DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG,
    contactStore: persistedContactStore,
    intentionRuntime: persistedIntentionRuntime,
    intentionProviders,
    capabilityRuntime,
    contactTrackingGate,
    satelliteRegistryConfig,
    placesRegistryConfig,
    ...(persistedHubIdentityEnrollmentStore
      ? { hubIdentityEnrollmentStore: persistedHubIdentityEnrollmentStore }
      : {}),
  });
  const {
    safeguardAuditTrail,
    lifecycleRestartSafeguard,
    externalRateLimiter,
  } = safeguardSurfaces;

  const {
    agentLoop,
    sessionStore,
    sessionManager,
    promptState,
    skillsRuntime,
    memoryStore,
    contactStore,
    coreMemoryStore,
    introspectionConsentStore,
    intentionRuntime,
    intentionAppraisalHooks,
    intentionBehavioralHooks,
    memoryExtractor,
    personaPreamble,
    observerEvalSidecar,
    appCache,
    toolConformanceRunner,
    personalProjects,
  } = coreRuntime;

  gateway.onContactAuthoritySnapshot(async ({ contactId, providerSubjectId }) => (
    await contactStore.readVerifiedDiscordContactAuthority(contactId, providerSubjectId)
  ));

  personalProjects.setActivitySink({
    recordProjectActivity: async (project) => {
      const weightedThoughtStore = persistenceRuntime.weightedThoughtStore;
      if (!weightedThoughtStore) {
        throw new Error('Personal project activity requires the durable weighted-thought store');
      }
      await recordWeightedThought(
        weightedThoughtStore,
        schedulerConfig.weightedThoughtOutreach.lifecycle,
        {
          id: `personal-project:${project.id}`,
          content: `Return to ${project.title}: ${project.nextStep}`,
          source: 'personal_project',
          thoughtClass: 'standard',
          provenance: { sourceChannelId: 'internal:free-time:project' },
        },
        Date.now(),
      );
    },
  });

  wireCompanionPresenceContext({
    agentLoop,
    presenceRuntime: companionPresenceRuntime,
    eventBus,
    sessionManager,
    placesRegistry: placesRegistryConfig,
  });

  // ── Cognition intake firewall (htm9.2): agent-side L1-only screening ──
  // Screens tool outputs at session-entry recording time so persisted context
  // (and its downstream consumers: emotion appraisal, memory extraction)
  // carries screened/labeled content. Mode 'off' wires nothing; shadow mode
  // (the default) records envelopes without altering content. The L1.5 ONNX
  // classifier stays gateway-side; the agent process runs deterministic L1
  // scanners only.
  const intakePolicy = loadIntakePolicyConfig(pathSnapshot.systemDataDir);
  const intakeQuarantineWriter = intakePolicy.mode !== 'off'
    ? createIntakeQuarantineStore(
      resolveIntakeQuarantinePath(pathSnapshot.companionDataDir),
      {
        itemTtlHours: intakePolicy.quarantine.itemTtlHours,
        maxHeldItems: intakePolicy.quarantine.maxHeldItems,
      },
    )
    : null;
  const intakeScreening = maybeCreateIntakeScreeningService({
    policy: intakePolicy,
    actor: 'agent:intake-screening',
    // Durable quarantine hold (htm9.11): agent-side quarantine decisions land
    // in the same companion-data store the gateway writes and Garden reviews.
    ...(intakeQuarantineWriter
      ? {
        quarantine: {
          hold: (input: Parameters<typeof intakeQuarantineWriter.hold>[0]) => {
            const entry = intakeQuarantineWriter.hold(input);
            emitGardenQueueChanged(eventBus, 'intake-quarantine');
            return entry;
          },
        },
      }
      : {}),
  });
  sessionManager.intakeScreening = intakeScreening;
  agentLoop.cogSecMode = intakePolicy.mode;
  if (sessionManager.intakeScreening) {
    log.info('Intake screening wired to session tool observations', {
      mode: sessionManager.intakeScreening.mode,
    });
  }

  // ── Partner Affect shadow observation foundation (docs/partner-affect.md
  // slice 1) ── Shadow-only: the bridge records accepted/suppressed Signal
  // Observations for Garden inspection and emits structural counters. It has
  // no path into prompts, appraisal, memory, scheduling, or world actions,
  // and stays fully inert unless the JSON owner file enables it with an
  // exact canonical partner binding.
  const partnerAffectShadowPolicy = loadPartnerAffectShadowConfig(pathSnapshot.systemDataDir);
  const partnerAffectShadowBridge = createPartnerAffectShadowIngestBridge({
    eventBus,
    policy: partnerAffectShadowPolicy,
    store: persistenceRuntime.partnerAffectShadowStore,
  });
  if (partnerAffectShadowBridge.active) {
    log.info('Partner affect shadow observation bridge active (shadow-only)', {
      policyRevision: partnerAffectShadowPolicy.policyRevision,
    });
  }

  sessionManager.characterName = card.data.name;
  writeStartupSessionMetadata(
    sessionManager,
    pathSnapshot.companionDataDir,
    config.sessionRestartBehavior ?? 'reuse_latest_session',
  );
  await hydrateStartupContinuity({
    memoryProvider: agentLoop.memoryProvider,
    wikiRetrieval: agentLoop.wikiRetrieval,
    sessionManager,
    wikiHydrationTuning: requireWikiStartupHydrationTuning(
      config.wikiStartupHydration,
    ),
  });

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
    compressionGuidelineEvolution,
  } = buildAgentSchedulerRuntime({
    eventBus,
    eligibilityGate,
    config,
    schedulerConfig,
    sessionManager,
    gateway,
    memoryStore,
    agentLoop,
    concernStore: intentionRuntime.concernStore,
    backupConfig,
    pathSnapshot,
    companionPresence: companionPresenceRuntime,
    contactStore,
    socialGraphProposalStore,
    socialGraphWatermarkStore,
    sharedWorldWikiCaretaker: coreRuntime.sharedWorldWikiCaretaker,
  });
  const {
    runtimeEnablement: icpRuntimeEnablement,
    sourceRuntime: icpInitiationSourceRuntime,
    weightedThoughtCandidateAdapter: icpWeightedThoughtCandidateAdapter,
    intentionCandidateAdapter: icpIntentionCandidateAdapter,
    unregisterCoLocationThoughtAdapter: unregisterIcpCoLocationThoughtAdapter,
  } = wireIcpInitiationSources({
    config: schedulerConfig.icpAutonomy,
    localCompanionId: config.companionId,
    candidateStore: persistenceRuntime.icpInitiationCandidateStore,
    peers: coreRuntime.icpAutonomyRuntime,
    gateway,
    isExternalCompanionAuthorized: () => capabilityRuntime.has('external.companion'),
    llmProvider,
    eventBus,
    pendingFollowUpStore: intentionRuntime.pendingFollowUpStore,
    concernStore: intentionRuntime.concernStore,
    presenceEnabled: companionPresenceRuntime !== null,
    contactStore,
    weightedThoughtStore: persistenceRuntime.weightedThoughtStore,
    socialDesireStore: persistenceRuntime.socialDesireStore,
    lifecycleConfig: schedulerConfig.weightedThoughtOutreach.lifecycle,
  });

  const introspectionAuditConfig = schedulerConfig.introspectionAudit
    ?? DEFAULT_INTROSPECTION_AUDIT_CONFIG;
  const introspectionAuditRuntime = new IntrospectionAuditRuntime({
    config: introspectionAuditConfig,
    consentStore: introspectionConsentStore,
    source: createTurnRecordIntrospectionSource({
      listRecentSessions: (limit, offset) => sessionManager.listRecentSessions(limit, offset).map((session) => ({
        sessionId: session.sessionId,
        sourceChannelId: sessionManager.getSessionRouteForLogicalSession(session.sessionId)?.sourceChannelId
          ?? session.channelId,
      })),
      getRecentTurnRecords: (sourceChannelId, limit, offset) => (
        sessionStore.getRecentSourceTurnRecords(sourceChannelId, limit, offset)
      ),
      isSessionRetiredOrQuarantined: sessionId => (
        sessionManager.isSessionRetiredOrQuarantined(sessionId)
      ),
      isSourceTurnRecordEligible: (sourceChannelId, ownerSessionId, turnId) => (
        sessionStore.isSourceTurnRecordEligible(sourceChannelId, ownerSessionId, turnId)
      ),
    }),
    auditor: createLLMIntrospectionAuditor(llmProvider, introspectionAuditConfig),
    reflector: createLLMCompanionLandmarkReflector(
      llmProvider,
      systemPrompt,
      introspectionAuditConfig,
    ),
    persistence: persistenceRuntime.introspectionLandmarkStore,
  });
  const introspectionValuesConsistencyRuntime = new IntrospectionValuesConsistencyRuntime({
    landmarks: persistenceRuntime.introspectionLandmarkStore,
    consentStore: introspectionConsentStore,
    claimedValues: new ValuesJournalStore(
      resolveValuesJournalPath(pathSnapshot.companionDataDir),
      { legacyFilePaths: [resolveLegacyValuesJournalPath(pathSnapshot.companionDataDir)] },
    ),
    findings: new ValuesConsistencyFindingStore(
      resolveIntrospectionValuesFindingsPath(pathSnapshot.companionDataDir),
    ),
    evaluator: createLLMValuesConsistencyEvaluator({
      llmProvider,
      companionSystemPrompt: systemPrompt,
      maxTokens: introspectionAuditConfig.reflectionMaxTokens,
    }),
  });
  registerIntrospectionAuditTask({
    scheduler,
    runtime: introspectionAuditRuntime,
    valuesConsistencyRuntime: introspectionValuesConsistencyRuntime,
    config: introspectionAuditConfig,
  });

  const moduleLoader = new ModuleLoader({
    eventBus,
    registerTool: (tool, category) => agentLoop.registerTool(tool, category),
    registryPath: moduleRegistryPath,
  });
  log.info('Split module registry path resolved', { moduleRegistryPath });

  const replConfig = buildReplConfig(config);
  // Sandboxed shell for REPL surfaces (analysis_workbench): every execution
  // routes through the gateway shell.exec RPC, so the single OS-enforced
  // bubblewrap policy path (allowlist, cwd bounds, limits, approval, audit)
  // governs REPL shell use exactly like the direct shell tool. No second
  // execution path exists in the agent process (psfn-framework-jdwd).
  const shellExecEnabled = config.shellExec?.enabled === true;
  const workbenchShellExecutionPort: Pick<SandboxExecutionPort, 'boundary' | 'shellExec'> | null =
    shellExecEnabled
      ? {
        boundary: {
          kind: 'sandbox_broker',
          isolatedFromGatewaySecrets: true,
          brokerId: 'gateway-shell-exec-rpc',
        },
        shellExec: async (command, args = [], options = {}) => (
          await gateway.shellExec(command, args, options)
        ),
      }
      : null;
  const shardParentIcpDelivery = createPolicyGovernedShardParentIcpDelivery({
    parentCompanionId: resolveCoreCompanionIdFromConfig(config),
    intakeScreening,
    agentLoop,
  });
  const shardManager = wireShardAndThinkRuntime({
    agentLoop,
    eventBus,
    llmProvider,
    sessionStore,
    embeddingService: gateway,
    memoryStore,
    sessionManager,
    config,
    parentSystemPrompt: systemPrompt,
    runtimeMode: 'gateway',
    scheduler,
    replConfig,
    shardAuditTrail: safeguardAuditTrail,
    getCapabilityTier: () => capabilityRuntime.getTier(),
    snapshotParentCapabilityGrant: () => capabilityRuntime.snapshotOwnerGrant(),
    compositionalPolicy: config.compositionalPolicy,
    moduleInstallConfirmationQueue: cardProposalQueue,
    onModuleRegistryMutation: async (mutation) => {
      await moduleLoader.applyRegistryMutation(mutation);
    },
    executionPort: workbenchShellExecutionPort,
    compressionGuidelineEvolution,
    shardParentIcpDelivery,
    shardWorkloadRegistry: gateway,
  });

  // Operator-extensible lifecycle hooks (bead vvf.2): workspace
  // HOOK.yaml definitions attach to the agent-process bus, fire-and-forget.
  // Bad hook files reject with a logged reason; startup never blocks on them.
  const operatorHookRuntime = await wireOperatorHookRuntime({
    eventBus,
    workspacePath: pathSnapshot.workspaceRoot,
  });
  log.info('Operator hook runtime wired', {
    hooksRoot: operatorHookRuntime.hookLoadResult.rootPath,
    loadedHooks: operatorHookRuntime.hookLoadResult.loaded.map(record => record.name),
    rejectedHookCount: operatorHookRuntime.hookLoadResult.rejected.length,
  });

  // Synchronous pre_tool_use hook interception (bead 7ym.3): late-bind the
  // decision gate onto the agent so the capability gate consults registered
  // sync hooks before executing any tool. Fast-paths to a no-op when no sync
  // hook is registered; decisions are recorded as redacted, content-free
  // telemetry (never argument contents).
  agentLoop.setPreToolHookGate(createPreToolHookGate({
    evaluator: operatorHookRuntime.hookRegistry,
    getCorrelation: getRequestContext,
    // Resolve the invoked tool's canonical/retired-alias equivalence class so a
    // hook policy registered against a retired or surface alias still matches
    // the canonical call (and vice-versa); throws fail-closed on malformed
    // alias metadata (816w).
    resolveAliases: resolveToolAliasMatchers,
    onDecision: (audit) => log.debug('pre_tool_use hook decision', { ...audit }),
  }));

  // Memory write/import tools — intentional memory creation
  const memoryWriter = new MemoryWriter(memoryStore, gateway, {
    memoryRetrievalPolicy: () => config.memoryRetrievalPolicy,
  });
  // htm9.3: direct memory-write tools gate at the memory_write sink (explicit
  // unscreened path until envelopes flow into tool params).
  memoryWriter.intakeSinkGateProvider = () => sessionManager.intakeSinkGate;
  // Durable tool-usage evaluator lane (psfn-framework-b0yl.5): closes the LOD
  // loop by aggregating ACTUAL per-tool invocations from the durable turn-record
  // stream (every catalog tool, per-companion) to feed presentation ordering +
  // operator-visible pin suggestions. Opt-in via scheduler.json (registers only
  // when enabled); registered here so it can use the real MemoryWriter for its
  // autonomous-action suggestion records and the session store's turn records.
  if (schedulerConfig.toolUsageEvaluator) {
    registerToolUsageEvaluatorTask({
      scheduler,
      agent: agentLoop,
      turnRecordAccess: {
        listChannelKeys: () => sessionStore.listChannels().map(channel => channel.sessionId),
        readRecentTurnRecords: (channelKey, limit) => sessionStore.getRecentTurnRecords(channelKey, limit),
      },
      getMemoryWriter: () => memoryWriter,
      config: schedulerConfig.toolUsageEvaluator,
    });
  }
  const episodicStore = companionEpisodicStore;
  // Episodic lane tuning is JSON-owned (scheduler.json episodeSynthesis /
  // sleepConsolidation / arcFormation) — no hardcoded cadences or windows.
  const MINUTE_MS = 60_000;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;
  // Topic-thread materialization telemetry (apq0): merges, legacy extractions,
  // and fail-safe oversize skips are typed events, never silence.
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
  const episodicSynthesizer = new EpisodicSynthesizer(episodicStore, sessionManager, {
    onThreadAssignment: emitThreadAssignment,
    transcriptMessageLimit: schedulerConfig.episodeSynthesis.transcriptMessageLimit,
    maxEpisodesPerRun: schedulerConfig.episodeSynthesis.maxEpisodesPerRun,
    maxPriorCandidates: schedulerConfig.episodeSynthesis.maxPriorCandidates,
    gapSplitMinutes: schedulerConfig.episodeSynthesis.gapSplitMinutes,
    maxEntriesPerEpisode: schedulerConfig.episodeSynthesis.maxEntriesPerEpisode,
    minConversationalEntries: schedulerConfig.episodeSynthesis.minConversationalEntries,
    minSingleEntryChars: schedulerConfig.episodeSynthesis.minSingleEntryChars,
    // Contextual topic cutting (E5.4): JSON-owned flag; the provider is the
    // same gateway-backed LLM port the other episodic passes use. Disabled
    // flag => deterministic cuts unchanged; enabled without a provider fails
    // closed at construction.
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
  const sleepConsolidator = new SleepCycleEpisodeConsolidator(episodicStore, sessionManager, llmProvider, {
    reviewWindowMs: schedulerConfig.sleepConsolidation.reviewWindowDays * DAY_MS,
    refinementWindowMs: schedulerConfig.sleepConsolidation.refinementWindowHours * HOUR_MS,
    adjacencyGapMs: schedulerConfig.sleepConsolidation.adjacencyGapMinutes * MINUTE_MS,
    maxRefinementsPerRun: schedulerConfig.sleepConsolidation.maxRefinementsPerRun,
    maxConsolidationsPerRun: schedulerConfig.sleepConsolidation.maxConsolidationsPerRun,
    transcriptMessageLimit: schedulerConfig.sleepConsolidation.transcriptMessageLimit,
    maxTranscriptCharsPerEpisode: schedulerConfig.sleepConsolidation.maxTranscriptCharsPerEpisode,
    personaPreamble,
    // Fail-closed consolidation failures are typed events, never silence.
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
    passIntervalMs: schedulerConfig.arcFormation.passIntervalDays * DAY_MS,
    reviewWindowMs: schedulerConfig.arcFormation.reviewWindowDays * DAY_MS,
    minConfidence: schedulerConfig.arcFormation.minConfidence,
    maxArcsPerRun: schedulerConfig.arcFormation.maxArcsPerRun,
    maxEpisodesPerRun: schedulerConfig.arcFormation.maxEpisodesPerRun,
    // Fail-closed arc-formation outcomes are typed events, never silence.
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
  const dreamMeaningPass = new DreamMeaningPass(episodicStore, agentLoop, {
    // Ground each meaning in the real turns she lived, not the auto-summarized
    // title/landmark (bead dtym). Same reader synthesis/consolidation use.
    transcriptReader: sessionManager,
    // Prioritized nightly budget (h4fp.6): rank participants by contact trust
    // so high-trust episodes land inside the capped pass first. Unknown
    // participant ids simply rank 0.
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
  // Sleeptime wiki update pass (E8.2): schema-bound background synthesis (not the
  // agent loop) with its own deterministic gate + watermark. Curates durable,
  // non-private world knowledge into the wiki after episodes/memories settle.
  const sleeptimeWikiPass = new SleeptimeWikiPass({
    llmProvider,
    wikiStore: new WikiStore(pathSnapshot.workspaceRoot),
    episodicStore,
    memoryStore,
    config: schedulerConfig.wikiPass,
    promptRegistry: promptState.registry,
    personaPreamble,
    onGateEvent: (event) => {
      eventBus.emit('memory.sleeptime_wiki.gate', event).catch((error: unknown) => {
        log.warn('Sleeptime wiki gate event emit failed', { error: String(error) });
      });
    },
  });
  intentionRuntime.behavioralPatternTracker.setPromotionHook(
    createBehavioralPatternMemoryPromotionHook(memoryWriter),
  );
  const toolMemoryStore = createSubjectAuthorizedMemoryStore(
    memoryStore,
    () => memorySubjectAccessContextFromCorrelation(getRequestContext()),
  );
  const toolMemoryWriter = new MemoryWriter(toolMemoryStore, gateway, {
    memoryRetrievalPolicy: () => config.memoryRetrievalPolicy,
  });
  toolMemoryWriter.intakeSinkGateProvider = () => sessionManager.intakeSinkGate;
  registerMemoryTools(agentLoop, {
    writer: toolMemoryWriter,
    memoryStore: toolMemoryStore,
    episodicStore,
    sessionReader: sessionStore,
    contactStore,
    // Same config authority the MemoryWriter and retrieval faculty resolve
    // from, so the action=timeline tool path honors operator-set timeline
    // knobs instead of compiled defaults (zet.2).
    memoryRetrievalPolicy: () => config.memoryRetrievalPolicy,
  });
  log.info('Context feedback runtime deferred (Phase VI): background context-scoring LLM calls disabled');

  // Git tools — parent turns stay read-only; mutation must return through shard outputs.
  registerGitTools(agentLoop, new GatewayGitOps(gatewayOps), {
    gatewayMode: true,
    access: 'read_only',
  });
  log.info('Git repository inspection tools enabled for parent agent');

  // Direct shell tool — sandboxed CLI via the gateway shell.exec policy path.
  // Gate registration on the same settings-owned enablement signal the gateway
  // policy enforces so registration and policy agree (beads e7s0 pattern);
  // the gateway DENYs shell.exec when shellExec.enabled is false, so
  // advertising the tool anyway would make every call fail. Fail-closed:
  // policy wins.
  if (shellExecEnabled) {
    registerShellTools(agentLoop, new GatewayShellOps(gateway), { gatewayMode: true });
    log.info('Sandboxed shell tool enabled (gateway shell.exec policy path)');
  } else {
    log.info('Sandboxed shell tool disabled by policy (gateway denies shell.exec)');
  }

  // Beads issue-management tools — policy-scoped gateway RPC access (no shell
  // passthrough). Gate registration on the same enablement signal the gateway
  // policy uses so registration and policy agree; the gateway DENYs beads.*
  // when disabled, so advertising the tool anyway makes it fail at every call
  // (psfn-framework-e7s0). Fail-closed: policy wins.
  const beadsToolsEnabled = resolveBeadsToolsEnabled(process.env.BEADS_TOOLS_ENABLED, {
    workspaceRoot: pathSnapshot.workspaceRoot,
    codebaseRoot: resolve('.'),
  });
  if (beadsToolsEnabled) {
    registerBeadsTools(agentLoop, new GatewayBeadsOps(gatewayOps), { gatewayMode: true });
    log.info('Beads issue-management tools enabled');
  } else {
    log.info('Beads issue-management tools disabled by policy (gateway denies beads.*)');
  }

  // World tool — perceive/list/control physical & virtual affordances via the
  // places registry and the privileged Satellite Hub world transport,
  // plus deliberate virtual navigation (`move`, vinz.26 / contract s10wm).
  // Affordance→entity resolution is agent-side against places.json (defence in depth).
  // `move` writes presence through the CompanionPresenceTurnPort seam only
  // (null flag-off ⇒ local-only move), applies its local situated effect
  // through the emanation tracker's virtual overlay, and fires the room-entry
  // system note through the session context-note lane.
  // Capability gating: perceive/list/move->world.read, control->world.control
  // (resolveWorldRequirement). Effector control is staged OFF by default
  // (WORLD_CONTROL_RUNTIME_ENABLED) and, once enabled, additionally requires a
  // primary/trusted requester — resolved from the live turn request context.
  const worldOps = new GatewayWorldOps(gatewayOps);
  registerWorldTools(agentLoop, worldOps, {
    placesRegistry: placesRegistryConfig,
    resolveSituatedPlaceId: () => agentLoop.resolveCurrentSituatedPlaceId(),
    companionPresence: companionPresenceRuntime,
    applyVirtualMove: (placeId) => agentLoop.applyDeliberateVirtualMove(placeId),
    roomEntryNoteSink: sessionManager,
    gatewayMode: true,
    resolveRequesterTrust: () => getRequestContext()?.viewerTrustLevel,
    // Human-in-the-loop provenance for control Gate 2a: self-directed/heartbeat
    // turns carry trustLevel 'primary' for scoping but no human requester, so
    // effector control must read provenance, not trust level alone.
    resolveRequesterProvenance: () => getRequestContext()?.requesterProvenance,
    // A live ShardManager channel may transport a reasoned control request to
    // the gateway's exact operator fence. This does not fabricate requester
    // trust or authorize the effect; the gateway requires a live generation.
    allowRequestScopedApprovalTransport: () =>
      getRequestContext()?.channelId?.startsWith('shard:') === true,
  });
  log.info('World tool enabled', {
    autonomousLightControl: false,
  });

  // Journal tools — durable markdown notes in the personal workspace.
  registerMarkdownJournalTools(agentLoop, pathSnapshot.workspaceRoot);

  // Validate tool wiring — catch misconfigured tools before they crash at invocation
  agentLoop.validateToolWiring('gateway', gateway, DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE);

  const moduleSummary = await moduleLoader.loadEnabledModules();
  log.info('Runtime modules initialized', moduleSummary);
  log.info('Re-validating tool wiring after module load', {
    mode: lifecycleRuntimeContract.mode,
    wiringMode: 'gateway',
    loadedModules: moduleSummary.loaded,
    failedModules: moduleSummary.failed,
  });
  agentLoop.validateToolWiring('gateway', gateway, DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE);

  // ── API backend (gateway-hosted edge) ──

  const {
    apiHost,
    apiPort,
    adminPort,
  } = resolveAgentApiSurfaceBindings(process.env);
  const apiHealthChecks = buildApiHealthChecks({
    config,
    memoryStore,
    gateway,
    scheduler,
    runtimeStatusMeta,
  }, resolveActiveHealthProbeConfig(process.env));
  // Multi-companion (W1-P2): project the discord settings that belong to THIS
  // companion. Single-account config passes through unchanged; multi-account
  // config selects this companion's own bot account entry.
  const discordChannelView = resolveDiscordCompanionView(
    channelsConfig.discord,
    resolveCoreCompanionIdFromConfig(config),
  );
  // Hydrate and subscribe before any gateway callback can execute. Prompt and
  // quota decisions must see the canonical rolling 24-hour balance even when
  // the optional Garden transport is disabled.
  const chargeLedger = new RunChargeLedger(
    resolveChargeLedgerPath(pathSnapshot.companionDataDir),
    eventBus,
  );
  if (config.multiCompanion === true) {
    if (!config.chargePolicy) {
      throw new Error('Multi-companion fleet posture requires chargePolicy');
    }
    await gateway.startFleetPostureReporting(createAgentFleetPostureProvider({
      companionId: resolveCoreCompanionIdFromConfig(config),
      chargePolicy: config.chargePolicy,
      fatigueHistory: coreRuntime.fatigueLedger,
    }));
  }
  agentLoop.setDurableChargeRecorder(
    event => chargeLedger.commitChargeEvent(event).outcome,
    event => chargeLedger.probeChargeEvent(event),
  );

  const apiBackend = new AgentApiBackend({
    agentLoop,
    eventBus,
    sessionManager,
    llmProvider,
    contactStore,
    healthChecks: apiHealthChecks,
    externalChannelProfiles: buildExternalChannelProfiles(channelsConfig),
    satelliteRegistry: satelliteRegistryConfig,
    companionId: resolveCoreCompanionIdFromConfig(config),
    shardDirectory: shardManager.shardDirectory,
    ...(config.fleetAuthVerifier
      ? {
          requestCapabilityVerifier: createRequestCapabilityVerifier(
            config.fleetAuthVerifier.requestCapabilities,
          ),
        }
      : {}),
    onStreamDelta: (requestId, text) => gateway.notifyApiStreamDelta(requestId, text),
    // htm9.9: OpenAI-compatible `file` content parts run the shared
    // file-ingest pipeline with the agent-side (L1-only) intake screening.
    documentIngest: {
      personalFilesDir: pathSnapshot.workspaceRoot,
      intakeScreening,
      // Owner-file backed ingest caps (zet.7).
      limits: resolveDocumentIngestLimits(config),
    },
  });
  gateway.onApiChatCompletion((params) => apiBackend.handleChatCompletion(params));
  gateway.onApiChatCancel((params) => apiBackend.cancelChatCompletion(params));
  gateway.onCompanionUiShardAction((params) => apiBackend.handleCompanionUiShardAction(params));
  gateway.onShardOwner((params) => Promise.resolve(apiBackend.handleShardOwner(params)));
  gateway.onApiTelemetryIngest((params) => apiBackend.handleTelemetryIngest(params));
  gateway.onApiHealth(() => apiBackend.handleHealth());
  gateway.onSatelliteResponseEligibility(async ({ canonicalContactId, channelId }) => (
    resolveSharedSatelliteFatigueEligibility({
      fatigueLedger: coreRuntime.fatigueLedger,
      localCompanionId: resolveCoreCompanionIdFromConfig(config),
      canonicalContactId,
      channelId,
    })
  ));
  gateway.onTurnPerformance(async (event) => {
    await eventBus.emit('agent.turn.performance', event);
  });

  // ── Companion event relay forwarding (w9hj.1) ──
  // Redacts tool lifecycle + generated-artifact events at emission and
  // forwards them to the gateway relay for the Satellite Hub SSE stream.
  const detachCompanionEventForwarder = attachCompanionEventForwarder({
    eventBus,
    publisher: gateway,
  });
  const detachGatewayQueueChange = gateway.onGardenQueueChanged((queue) => {
    emitGardenQueueChanged(eventBus, queue);
  });

  // ── Admin transport (optional) ──

  const outreachOutbox = createFileOutreachOutboxStore(
    resolveOutreachOutboxLedgerPath(pathSnapshot.companionDataDir),
  );

  const adminTransport = await startOptionalAdminTransportServer({
    adminPort,
    apiHost,
    apiPort,
    env: process.env,
    config,
    satelliteRegistryConfig,
    channelGroupMemory: discordChannelView.groupMemory,
    gateway,
    eventBus,
    chargeLedger,
    scheduler,
    schedulerConfig,
    icpInitiationCandidateStore: persistenceRuntime.icpInitiationCandidateStore,
    partnerAffectShadowStore: persistenceRuntime.partnerAffectShadowStore,
    icpRuntimeEnablement,
    postTurnActions,
    outreachOutbox,
    episodicStore,
    subsystemOutputRefStore: backgroundWorkStore,
    pendingContactApprovals,
    socialGraphProposals: socialGraphProposalStore,
    hubIdentityEnrollmentStore: persistedHubIdentityEnrollmentStore,
    card,
    shardManager,
    cardVersionStore,
    cardProposalQueue,
    coreRuntime: {
      memoryStore,
      sessionStore,
      sessionManager,
      contactStore,
      promptState,
      skillsRuntime,
      agentLoop,
      observerEvalSidecar,
      memoryExtractor,
      intentionRuntime,
      toolConformanceRunner,
      humanAttentionLedger: coreRuntime.humanAttentionLedger,
    },
  });
  if (adminTransport) {
    log.info('Garden admin transport listening', {
      endpoint: adminTransport.describeEndpoint(),
    });
  }

  const heartbeatChannel = discordChannelView.heartbeatChannel ?? undefined;
  const heartbeatChannelId = heartbeatChannel?.channelId;
  const shutdownTargets: AgentControlPlaneShutdownTargets = {};
  const controlPlane = buildAgentControlPlane({
    heartbeatChannelId,
    dataDir: pathSnapshot.companionDataDir,
    config,
    eventBus,
    gateway,
    unregisterGatewayDisconnect,
    stopDebugObserver,
    writeGracefulShutdownMarkers: () => {
      const markedChannels = sessionStore.markGracefulShutdownForActiveChannels();
      if (markedChannels.length > 0) {
        log.info('Wrote graceful shutdown markers', { channels: markedChannels });
      }
    },
    closeDatabase: async () => {
      partnerAffectShadowBridge.unsubscribe();
      await persistenceRuntime.contactLifecycleRecovery?.stop();
      await coreRuntime.closeWikiRuntime();
      await persistenceRuntime.icpInitiationCandidateStore?.close();
      await persistenceRuntime.socialPotStore?.close();
      await persistenceRuntime.speakingArbiterStore?.close();
      await persistenceRuntime.backgroundWorkStore.close();
      await persistenceRuntime.introspectionLandmarkStore.close();
      await persistenceRuntime.partnerAffectShadowStore.close();
    },
    scheduler,
    moduleLoader,
    memoryExtractor,
    agentLoop,
    operatorNotifier,
    lifecycleRestartSafeguard,
    externalRateLimiter,
    capabilityRuntime,
    lifecycleRuntimeContract,
    shutdownTargets,
    postTurnActions,
    ...(coreRuntime.icpAutonomyRuntime
      ? { icpAutonomyRuntime: coreRuntime.icpAutonomyRuntime }
      : {}),
    ...(icpInitiationSourceRuntime ? { icpInitiationSourceRuntime } : {}),
  });
  // Control-plane tools are registered after module loading. Validate them
  // before restored durable actions can execute so a wiring-disabled notify
  // surface is absent from the current registration-policy check.
  agentLoop.validateToolWiring('gateway', gateway, DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE);
  const { lifecycleNotifier } = controlPlane;
  let apiBackendDisposed = false;
  const disposeApiBackend = () => {
    if (apiBackendDisposed) return;
    apiBackendDisposed = true;
    apiBackend.dispose();
  };
  stopFn = async () => {
    detachCompanionEventForwarder();
    unregisterIcpCoLocationThoughtAdapter();
    detachGatewayQueueChange();
    disposeApiBackend();
    // Graceful shutdown removes our own shared presence row (crash cleanup is
    // the read-side staleness TTL — see companion-presence-runtime.ts).
    if (companionPresenceRuntime) {
      await companionPresenceRuntime.shutdown();
    }
    await controlPlane.stopFn();
  };
  shutdownTargets.adminTransport = adminTransport;
  shutdownTargets.appCache = appCache;
  shutdownTargets.chargeLedger = chargeLedger;
  if (coreRuntime.fatigueRegulationReservations) {
    shutdownTargets.fatigueRegulationReservations =
      coreRuntime.fatigueRegulationReservations;
  }
  shutdownTargets.sessionTailCache = coreRuntime.sessionTailCache;
  shutdownTargets.skillUsageTelemetry = coreRuntime.skillsRuntime;
  const gatewaySender = {
    send: (channelId: string, content: string) => gateway.discordSend(channelId, content),
  };
  // Shared outbound-reply dedupe guard (psfn-framework-mdxu): the inbound
  // Discord reply pump records every delivered reply here, and the
  // internal continuation consults it to suppress a duplicate of a
  // reply the operator already received one turn earlier.
  const outboundReplyGuard = new OutboundReplyDeduper();
  // First proactive-outreach slice: only the configured primary heartbeat DM
  // is an approved target. Contact-graph channel resolution arrives with the
  // durable outbox (1xb.2).
  const proactiveOutbound = heartbeatChannelId
    ? new ProactiveOutboundDispatcher({
      sender: gatewaySender,
      rateLimiter: externalRateLimiter,
      isApprovedPrimaryChannel: (channelId) => channelId === heartbeatChannelId,
      eventBus,
    })
    : null;
  // ── Temporal wake-up lanes (E7.1) ──
  // Morning wake + idle time-of-day refresher. Both inject explicit system
  // notes (never partner speech). The catch-up summary reuses the SHARED
  // session summarization service (summarizeRecentSessionEntries, purpose
  // 'wake_session'); outward messages ride the existing proactive-outbound
  // dispatcher and quiet-hours time gate.
  registerTemporalWakeupTasks({
    scheduler,
    sessionManager,
    config: schedulerConfig.temporalWakeup,
    quietHours: schedulerConfig.episodicProcessing,
    // Surface how the morning wake slot was resolved (E7.2): fixed, habit
    // estimate, or habit fallback with a reason. Typed event + Garden read route.
    onWakeTimingResolved: (snapshot) => {
      void eventBus.emit('scheduler.wake_timing.resolved', {
        timingMode: snapshot.timingMode,
        source: snapshot.source,
        effectiveLocalTime: snapshot.effective.localTime,
        timeZone: snapshot.timeZone,
        sampleDays: snapshot.sampleDays,
        ...(snapshot.fallbackReason ? { fallbackReason: snapshot.fallbackReason } : {}),
        ...(snapshot.window
          ? {
            windowStartLocalTime: snapshot.window.startLocalTime,
            windowEndLocalTime: snapshot.window.endLocalTime,
          }
          : {}),
      });
    },
    summarizeCatchUp: async ({ channelId, entries }) => summarizeRecentSessionEntries({
      channelId,
      entries,
      characterName: card.data.name,
      llmProvider,
      promptRegistry: promptState.registry,
      maxTokens: schedulerConfig.temporalWakeup.morningWake.catchUpSummaryMaxTokens,
      purpose: 'wake_session',
    }),
    invokeWakeTurn: async ({ note }) => {
      const response = await agentLoop.handleMessage({
        id: `reflection-temporal-wakeup-${Date.now()}`,
        channelId: 'internal:reflection:temporal-wakeup',
        channelType: 'terminal',
        authorId: 'scheduler',
        authorName: TEMPORAL_WAKEUP_MORNING_TASK_NAME,
        content: [
          'A temporal wake note was just placed in your active session:',
          '',
          note,
          '',
          'This is your morning wake turn. If you want to send your partner an',
          'outward message right now, reply with only that message. If you have',
          `nothing you want to send outward, reply with "${REFLECTION_SILENT_TOKEN}" — staying quiet is`,
          'completely fine; nothing about this wake requires an outward response.',
        ].join('\n'),
        timestamp: new Date(),
      });
      const trimmed = response.content.trim();
      const isSilentReflection = !trimmed.toLowerCase().localeCompare(
        REFLECTION_SILENT_TOKEN,
      );
      if (!trimmed || isSilentReflection) {
        return null;
      }
      return trimmed;
    },
    ...(proactiveOutbound
      ? {
        dispatchOutbound: async ({ channelId, channelType, content }: {
          channelId: string;
          channelType: ChannelType;
          content: string;
        }) => proactiveOutbound.dispatch({
          actionId: `temporal-wakeup-${Date.now()}`,
          channelId,
          channelType,
          content,
          reason: 'temporal_wakeup_morning',
        }),
      }
      : {}),
  });

  // ── Free-time lanes (E8.1) ──
  // Self-directed time: two entry lanes (quiet-hours inside the rest window;
  // idle after a long partner gap) share one bounded, budget-capped, multi-turn
  // agent-loop block on an INTERNAL channel. The ordinary default prompt stack
  // supplies identity and policy; her normal tools apply and outputs are
  // durable only. Deterministic gates run
  // before any spend; the block runs inside a 'background' charge context and
  // ends gracefully when the per-block turn/charge budget is exhausted. After a
  // block WITH activity, a "while you were away" note is placed on the partner
  // session via the shared summarizer; empty "loafed" blocks surface nothing.
  //
  // Companion free-time chooser (jp36.2.1.2): supersedes the LRU auto-select.
  // The companion picks rest / private wander / resume / create through ONE
  // cheap background call; rest ends the block with no free-time turn and
  // persists silence so she is not re-prompted this quiet period. The
  // roomChannelResolver sources its disclosure ceiling from
  // getVisibilityDisclosureCeiling (the resolver's documented port obligation),
  // and public_room retrieval is clamped to 'public' inside the resolver. v1
  // personal projects are private-only, so today's live menu is rest / private
  // wander / resume(private); the manifest-v2 room/publication binding and the
  // lane→continuity-session merge are jp36.2.4 / jp36.2.2.
  const freeTimeRoomChannelResolver = createFreeTimeRoomChannelResolver(
    (channelId) => deriveConversationScopeEnvelope({
      channelId,
      kind: 'group',
      // Fail-closed roster: a project-bound room resolved outside a live
      // conversation has no roster snapshot; the conservative envelope holds
      // until jp36.2.4 supplies the manifest-v2 room binding.
      recentSpeakerCount: 0,
    }),
    getVisibilityDisclosureCeiling,
  );
  // Map a manifest-v2 durable work context (faculties/wiki) onto the resolver's
  // structurally-identical FreeTimeWorkspaceContext (jp36.2.4 seam). Explicit
  // per-kind reconstruction keeps optional fields honest under
  // exactOptionalPropertyTypes and localizes the cross-module shape coupling.
  const toFreeTimeWorkspaceContext = (
    workContext: PersonalProjectWorkContext,
  ): FreeTimeWorkspaceContext => {
    switch (workContext.kind) {
      case 'private':
        return workContext.returnTarget
          ? { kind: 'private', returnTarget: workContext.returnTarget }
          : { kind: 'private' };
      case 'room':
        return { kind: 'room', channelId: workContext.channelId };
      case 'publication':
        return workContext.surfaceRef
          ? { kind: 'publication', mode: workContext.mode, surfaceRef: workContext.surfaceRef }
          : { kind: 'publication', mode: workContext.mode };
      default: {
        const unknown = workContext as { kind?: unknown };
        throw new Error(`unknown personal-project work-context kind: ${String(unknown.kind)}`);
      }
    }
  };
  const workContextLabel = (workContext: PersonalProjectWorkContext): string => {
    switch (workContext.kind) {
      case 'private':
        return 'private';
      case 'room':
        return 'room';
      case 'publication':
        return workContext.mode === 'public_clean' ? 'publication' : 'publication review draft';
      default:
        return 'private';
    }
  };
  const freeTimeResolver = new FreeTimeWorkspaceResolver({
    projectDirectory: (projectRef: string): FreeTimeProjectRecord | null => {
      const normalizedRef = projectRef.startsWith('project:') ? projectRef : `project:${projectRef}`;
      const match = personalProjects.listProjects().find(project => project.ref === normalizedRef);
      // Unknown ref → null so the resolver fails closed on it. A known project
      // serves its durable manifest-v2 work context (jp36.2.4); v1 manifests were
      // upgraded to a private context on read, so resume inherits without a
      // reclassification prompt (bible §10.1/§10.5).
      return match
        ? { projectRef: match.ref, workspace: toFreeTimeWorkspaceContext(match.workContext) }
        : null;
    },
    roomChannelResolver: freeTimeRoomChannelResolver,
  });
  const freeTimeRestWindowPolicy = new InMemoryRestWindowPolicy();
  const freeTimeChooser = new FreeTimeChooser({
    llmProvider,
    resolver: freeTimeResolver,
    restWindowPolicy: freeTimeRestWindowPolicy,
    listResumableProjects: (): FreeTimeProjectSummary[] => personalProjects.listProjects()
      .filter(project => project.status === 'active')
      .map(project => ({
        projectRef: project.ref,
        title: project.title,
        workContextLabel: workContextLabel(project.workContext),
        focusHint: project.nextStep,
      })),
    companionName: card.data.name,
    // Free-time chooser tunables (incl. the rest / silence-persistence window)
    // are owned by scheduler.json socialAutonomy.freeTimeChooser (jp36.8.2).
    settings: schedulerConfig.socialAutonomy.freeTimeChooser,
    ...(config.companionId ? { companionId: config.companionId } : {}),
  });
  registerFreeTimeTasks({
    scheduler,
    sessionManager,
    config: schedulerConfig.freeTime,
    restWindow: schedulerConfig.episodicProcessing,
    eventBus,
    // The whole block runs inside a 'background' charge context so per-turn LLM
    // spend accumulates against the background lane; getRunChargeSnapshot lets
    // the runner read cumulative spend before each turn for the hard cap.
    runBlock: ({ run }) => {
      const chargePolicy = config.chargePolicy;
      if (!chargePolicy) {
        // No charge policy → run with a zero reader; the turn cap still bounds.
        return run(() => 0);
      }
      return runWithChargeContext({
        chargePolicy,
        eventBus,
        lane: 'background',
        correlation: getRequestContext(),
      }, () => run(() => getRunChargeSnapshot()?.spentByLane.background ?? 0));
    },
    // One free-time turn through the ordinary agent loop on the internal
    // channel. Internal channelId => isInternalSessionId() true => the loop
    // cannot dispatch outward to a partner channel. The default identity stack
    // and her normal tools apply (no restricted reflection policy). A "silent"
    // reply ends the block; staying quiet / loafing is a valid outcome.
    invokeTurn: async ({ lane, channelId, turnIndex, content }) => {
      const response = await agentLoop.handleMessage({
        id: `free-time-${lane}-${turnIndex}-${Date.now()}`,
        channelId,
        channelType: 'terminal',
        authorId: 'scheduler',
        authorName: 'Free Time',
        content,
        timestamp: new Date(),
      });
      return { content: response.content };
    },
    // Shared summarizer, free-time lane identity: distinct purpose/originStage
    // ('free_time_return') and a freeTime-owned token budget — never borrowed
    // from the morning-wake catch-up lane.
    summarizeActivity: async ({ channelId, entries }) => summarizeRecentSessionEntries({
      channelId,
      entries,
      characterName: card.data.name,
      llmProvider,
      promptRegistry: promptState.registry,
      maxTokens: schedulerConfig.freeTime.returnNote.summaryMaxTokens,
      purpose: 'free_time_return',
    }),
    loadProjectContext: async () => (
      await personalProjects.resumeNextActiveProject()
    )?.context ?? null,
    // Companion chooser drives rest / workspace selection; rest persists silence
    // for the quiet period (fails closed to rest, never a forced workspace).
    chooseWorkspace: ({ lane, nowMs }) => freeTimeChooser.chooseWorkspace({ lane, nowMs }),
  });
  // ── Weighted-thought outreach lane (E?/1xb.2) ──
  // Internal-state-driven outreach: a weighted thought crossing threshold
  // produces an LLM nudge the companion accepts or declines; accepted nudges
  // ride the existing durable-outbox delivery path. Disabled by default
  // (scheduler.json weightedThoughtOutreach.enabled) and fail-closed on channel
  // resolution — primary heartbeat DM only until a group-continuation policy
  // approver is wired.
  if (persistenceRuntime.weightedThoughtStore) {
    registerWeightedThoughtOutreachTask({
      scheduler,
      eventBus,
      config: schedulerConfig.weightedThoughtOutreach,
      quietHours: schedulerConfig.episodicProcessing,
      store: persistenceRuntime.weightedThoughtStore,
      nudgeEvaluator: createLlmNudgeEvaluator({
        llmProvider,
        characterName: card.data.name,
      }),
      ...(icpWeightedThoughtCandidateAdapter
        ? { icpCandidateAdapter: icpWeightedThoughtCandidateAdapter }
        : {}),
      channelPolicy: {
        ...(heartbeatChannelId ? { primaryChannelId: heartbeatChannelId } : {}),
        primaryChannelType: 'discord',
      },
      // Evaluate the quiet-hours gate in the recipient's timezone (2tli).
      resolveContactTimeZone: async contactId => (
        (await contactStore.getById(contactId))?.timezone ?? null
      ),
    });
  } else if (schedulerConfig.weightedThoughtOutreach.enabled) {
    log.warn('weightedThoughtOutreach enabled but no weighted-thought store is available; lane not registered');
  }

  // ── Social-desire consent-moment lane (epic oth4, bead oth4.2) ──
  // Per-contact durable desire crossing threshold -> companion consent moment
  // (message / defer / decline — never auto-send). Accepted consents carry
  // social-desire provenance through the EXISTING outbound provenance gate,
  // durable outbox, ICP candidate broker, and ProactiveOutboundDispatcher —
  // under a tight desire-outbound rate budget. Fail closed: with
  // socialDesire.enabled false (or a missing store) nothing is wired, so the
  // gate rejects any social-desire provenance outright.
  let socialDesireOutbound: SocialDesireOutboundRuntime | undefined;
  let socialDesireHumanDeliveryPolicy: SocialDesireHumanDeliveryPolicy | undefined;
  if (schedulerConfig.socialDesire.enabled) {
    const socialDesireStore = persistenceRuntime.socialDesireStore;
    if (!socialDesireStore) {
      log.warn('socialDesire enabled but no social-desire store is available; lane not registered');
    } else {
      const socialDesireConsents = createSocialDesireConsentLedger({
        ttlMs: schedulerConfig.socialDesire.outreach.consentTtlMs,
      });
      socialDesireOutbound = createSocialDesireOutboundRuntime({
        store: socialDesireStore,
        lifecycle: schedulerConfig.socialDesire.lifecycle,
        consents: socialDesireConsents,
        budget: schedulerConfig.socialDesire.outreach.budget,
        // Budget counts durable desire-tagged sends from the outreach outbox —
        // enforcement lives at the dispatch layer and survives restart.
        countRecentSends: sinceMs => outreachOutbox.countSentSince({
          sinceMs,
          reasonPrefix: 'social_desire',
        }),
      });
      const budgetGuard = socialDesireOutbound;
      if (heartbeatChannel) {
        socialDesireHumanDeliveryPolicy = createSocialDesireHumanDeliveryPolicy({
          contacts: contactStore,
          approvedHeartbeatChannel: heartbeatChannel,
          quietHours: schedulerConfig.episodicProcessing,
        });
      }
      const icpPeers = coreRuntime.icpAutonomyRuntime;
      const localCompanionId = config.companionId;
      registerSocialDesireOutreachTask({
        scheduler,
        eventBus,
        postTurnActions,
        config: schedulerConfig.socialDesire,
        deps: {
          store: socialDesireStore,
          lifecycle: schedulerConfig.socialDesire.lifecycle,
          tierSource: createContactSocialDesireTierSource(contactStore),
          consentEvaluator: createLlmSocialDesireConsentEvaluator({
            llmProvider,
            characterName: card.data.name,
          }),
          consents: socialDesireConsents,
          maxConsentMomentsPerRun: schedulerConfig.socialDesire.outreach.maxConsentMomentsPerRun,
          quietHours: schedulerConfig.episodicProcessing,
          resolveContactTimeZone: async contactId => (
            (await contactStore.getById(contactId))?.timezone ?? null
          ),
          // Fail-closed delivery-channel policy: companion peers route to
          // their canonical companion DM (ICP candidate path); humans deliver
          // only to the primary contact's approved heartbeat DM. Anything
          // else has no channel — no consent moment, desire keeps pressure.
          resolveDeliveryChannel: async (contactId): Promise<SocialDesireDeliveryChannel | null> => {
            const contact = await contactStore.getById(contactId);
            if (!contact) return null;
            if (contact.isMachineIntelligence) {
              if (!icpPeers || !localCompanionId) return null;
              try {
                const peer = await icpPeers.resolveKnownPeer(contactId);
                return {
                  channelId: composeCompanionDmChannelId(
                    createCompanionId(localCompanionId, 'social-desire local companion'),
                    createCompanionId(peer.peerCompanionId, 'social-desire peer companion'),
                  ),
                  channelType: 'companion',
                  contactName: contact.displayName,
                  companionTarget: true,
                };
              } catch (error) {
                if (error instanceof CanonicalCompanionPeerValidationError) return null;
                throw error;
              }
            }
            if (contact.trustLevel !== 'primary' || !heartbeatChannel) return null;
            return {
              channelId: heartbeatChannel.channelId,
              channelType: heartbeatChannel.channelType,
              contactName: contact.displayName,
              companionTarget: false,
            };
          },
          isBudgetExhausted: (nowMs, reservedConsentCount) => (
            budgetGuard.isBudgetExhausted(nowMs, reservedConsentCount)
          ),
        },
      });
    }
  }

  // Journal auto-publisher (for reflections -> markdown journal).
  const journalAutoPublisher = createOptionalJournalAutoPublisher(pathSnapshot.workspaceRoot, config);

  // Group-memory observation scheduler doubles as the canonical direct-vs-group
  // scope classifier for sleeptime cadence, so it is built before the reflection
  // runtime wiring below.
  const observedGroupMemoryScheduler = new ObservedGroupMemoryScheduler({
    channelGroupMemory: discordChannelView.groupMemory,
    sessionReader: sessionStore,
    watermarkStore: new JsonGroupMemoryWatermarkStore(
      join(pathSnapshot.companionDataDir, 'group-memory-watermarks.json'),
    ),
    memoryExtractor,
    contactStore,
    companionNames: [card.data.name],
    companionAuthorIds: config.discordBotId ? [config.discordBotId] : [],
    ...(config.groupMemory ? { groupMemory: config.groupMemory } : {}),
  });

  // Deterministic passive-name participation candidate gate (bible §8.1). Reuses
  // the group-salience name detector and the scheduler's canonical
  // direct-vs-group classifier — no parallel detection paths. Runs on observed
  // group-room traffic; downstream appraisal (jp36.3.3) and the speaking arbiter
  // (jp36.5) consume the candidates it records.
  const passiveNameCandidateBuilder = new PassiveNameCandidateBuilder({
    scopeClassifier: observedGroupMemoryScheduler,
    contextReader: sessionStore,
    companionNames: [card.data.name],
    companionAuthorIds: config.discordBotId ? [config.discordBotId] : [],
    // Passive-name gate tunables are owned by scheduler.json
    // socialAutonomy.passiveNameCandidate (jp36.8.2).
    settings: schedulerConfig.socialAutonomy.passiveNameCandidate,
  });

  // Cheap, tool-less participation appraiser (bible §8.2, jp36.3.3). Consumes the
  // candidates above on the same observe path and produces the ignore/react/reply
  // ternary over datamarked room text using the shared background-model port —
  // no parallel LLM plumbing. Fails closed to `ignore`; billing (background lane)
  // is attributed to the owning companion via the call correlation.
  const participationAppraiser = new ParticipationAppraiser({
    llmProvider,
    companionName: card.data.name,
    // Appraiser bounds are owned by scheduler.json socialAutonomy.appraiser
    // (jp36.8.2).
    settings: schedulerConfig.socialAutonomy.appraiser,
    ...(config.companionId ? { companionId: config.companionId } : {}),
  });

  // ICP-over-social precedence transport (jp36.5.2.1): the arbiter's reservation
  // gate consumes LIVE ICP signals — the companion's own availability lease (via
  // the gateway-RPC broker read) and its in-flight ICP turn fence (a `pending`
  // turn reservation in the shared fatigue store) — so an in-flight ICP turn or
  // a declared busy/resting/DND yields the social turn (§8.5: ICP dominates on
  // any conflict or race). Any signal-source error propagates and the
  // reservation phase fails closed to a suppressing `gate_error`. When the ICP
  // fleet surfaces are absent (single-companion / no contacts) there is no ICP
  // authority to contend, so precedence admits.
  const speakingIcpPrecedence: IcpSocialPrecedenceResolver =
    config.companionId && coreRuntime.icpAutonomyRuntime && coreRuntime.icpTurnFenceReader
      ? createIcpSpeakingPrecedenceResolver({
        companionId: config.companionId,
        availability: coreRuntime.icpAutonomyRuntime,
        turnFence: coreRuntime.icpTurnFenceReader,
        // The ICP continuation-lane hard stop has no clean companion-scope read
        // yet: it is per-relationship, per-conversation, and needs the per-turn
        // policy limit. The shared-economy budget it guards is already enforced
        // by the reservation phase's social-pot funding gate, so a dedicated
        // continuation-exhaustion read is deferred (jp36.5.2.1 handoff). This
        // never fabricates an exhausted signal.
        continuationFatigue: { isContinuationExhausted: async () => false },
      })
      : { resolve: () => ({ icpTurnFenced: false, icpFatigueExhausted: false }) };

  // Speaking-arbiter reservation phase (bible §8.5/§12.2, §6.10, jp36.5.1.2):
  // deterministic gate that runs BEFORE the appraiser's model call. Constructed
  // only when the gateway-owned arbiter store and social pot are present (the
  // multi-companion runtime) and a charge policy funds the economy. ICP-over-
  // social precedence consumes the live ICP transport above (jp36.5.2.1); the
  // decayed room-episode pressure gate is opt-in behind the jp36.5.4
  // single-source seam and is not wired here.
  const reservationPhase = (
    config.multiCompanion === true
    && persistenceRuntime.speakingArbiterStore
    && persistenceRuntime.socialPotStore
    && config.chargePolicy
    && config.companionId
  )
    ? new SpeakingReservationPhase({
      store: persistenceRuntime.speakingArbiterStore,
      socialPot: persistenceRuntime.socialPotStore,
      companionId: config.companionId,
      icpPrecedence: speakingIcpPrecedence,
      config: {
        // Reservation-phase tunables (reservationTtlMs, minReserveDrawUnits) are
        // owned by scheduler.json socialAutonomy.reservationPhase (jp36.8.2); the
        // pot / breaker / wrap-up fields still come from the charge-policy ledger.
        ...schedulerConfig.socialAutonomy.reservationPhase,
        socialPot: config.chargePolicy.fatigue.socialPot,
        roomEpisodeCircuitBreaker:
          config.chargePolicy.fatigue.socialRegulation.roomEpisodeCircuitBreaker,
        wrapUpThreshold:
          config.chargePolicy.fatigue.socialRegulation.roomEpisodePressure.wrapUpThreshold,
      },
    })
    : undefined;

  // Speaking-arbiter egress-lease phase (bible §8.5/§12.2, §18, §20.1,
  // jp36.5.1.3): phase 2, the exclusive send-once binding at delivery. Promoting
  // a retained candidate to a REAL autonomous room reply is a new,
  // CogSec-sensitive surface, so it is gated OFF by default (the egress-lease
  // settings `enabled` flag): with it disabled the observe/appraise/reserve path
  // is unchanged and nothing is sent. The room-episode pressure gate reads the
  // ONE reconciled ledger-derived source (jp36.5.4 seam) — never the arbiter
  // store's raw pressure scalar, which stays a write-only projection.
  // Egress-lease TUNABLES (leaseTtlMs, egressDrawUnits, minReplyConfidence) are
  // owned by scheduler.json socialAutonomy.egressLease (jp36.8.2). The `enabled`
  // flag is DELIBERATELY not owner-file-exposed and stays code-pinned to the
  // fail-closed default (false): promoting an observed candidate to a real
  // autonomous send is blocked until qgqw.3 (P1), so no config path may enable
  // it. Merging the tunables over the code default preserves enabled === false.
  const egressLeaseSettings = {
    ...createDefaultEgressLeasePhaseSettings(),
    ...schedulerConfig.socialAutonomy.egressLease,
  };
  const egressLeasePhase = (
    egressLeaseSettings.enabled
    && config.multiCompanion === true
    && persistenceRuntime.speakingArbiterStore
    && persistenceRuntime.socialPotStore
    && config.chargePolicy
    && config.companionId
  )
    ? new SpeakingEgressLeasePhase({
      store: persistenceRuntime.speakingArbiterStore,
      socialPot: persistenceRuntime.socialPotStore,
      companionId: config.companionId,
      // Single reconciled room-episode pressure source: ledger-derived, decayed,
      // across every peer in the channel (caller obligation jp36.5.1 #2).
      roomPressure: {
        resolve: (ctx) => readRoomEpisodePressureFromLedger(coreRuntime.fatigueLedger, {
          localCompanionId: config.companionId as string,
          channelId: ctx.channelId,
          nowMs: ctx.nowMs,
          config: config.chargePolicy!.fatigue.socialRegulation.roomEpisodePressure,
        }),
      },
      // Consumes the granted lease to generate + deliver the reply (temporal-
      // wakeup pattern: synthetic terminal generation, then explicit send).
      // qgqw.3 hardening: the SHARED outbound-reply guard (same instance as the
      // reply pump) plus the sender's per-trigger-event fence give single
      // delivery across re-drives, and the destination room's disclosure pair
      // clamps the synthetic generation context to the room's ceiling.
      sender: createAgentLoopEgressReplySender({
        generator: agentLoop,
        delivery: gatewaySender,
        companionName: card.data.name,
        outboundReplyGuard,
        resolveDestinationDisclosure: (channelId) => classifyChannelDisclosure(channelId),
      }),
      config: {
        leaseTtlMs: egressLeaseSettings.leaseTtlMs,
        egressDrawUnits: egressLeaseSettings.egressDrawUnits,
        minReplyConfidence: egressLeaseSettings.minReplyConfidence,
        socialPot: config.chargePolicy.fatigue.socialPot,
        roomEpisodeCircuitBreaker:
          config.chargePolicy.fatigue.socialRegulation.roomEpisodeCircuitBreaker,
        wrapUpThreshold:
          config.chargePolicy.fatigue.socialRegulation.roomEpisodePressure.wrapUpThreshold,
        replyPressureUnits:
          config.chargePolicy.fatigue.socialRegulation.roomEpisodePressure.replyPressureUnits,
      },
    })
    : undefined;

  // ── Slow-poisoning drift-velocity review lane (htm9.14) ──
  // Deterministic nightly aggregation (zero LLM, zero turn latency) over the
  // per-contact valence series, memory-write rows, quarantine risk labels,
  // and retrieval recency. Findings become operator review cards on the
  // Garden Cognitive Security tab; the lane never mutates memories, trust,
  // or emotion, and the companion never sees it.
  const driftVelocityReview = intakePolicy.driftDetection.enabled
    ? {
      evidence: createDriftVelocityEvidencePort({
        contactStore,
        memoryStore,
        quarantineStore: intakePolicy.mode !== 'off'
          ? createIntakeQuarantineStore(
            resolveIntakeQuarantinePath(pathSnapshot.companionDataDir),
            {
              itemTtlHours: intakePolicy.quarantine.itemTtlHours,
              maxHeldItems: intakePolicy.quarantine.maxHeldItems,
            },
          )
          : null,
      }),
      cardStore: createDriftReviewCardStore(
        resolveDriftReviewCardsPath(pathSnapshot.companionDataDir),
      ),
      config: intakePolicy.driftDetection,
      watermarks: {
        getContactMaintenanceWatermark: (processor: string) =>
          contactStore.getContactMaintenanceWatermark(processor),
        setContactMaintenanceWatermark: (processor: string, lastRunAt: string) =>
          contactStore.setContactMaintenanceWatermark(processor, lastRunAt),
      },
    }
    : null;
  if (!driftVelocityReview) {
    log.info('Drift-velocity review lane disabled by intake-policy driftDetection.enabled');
  }

  // ── Second-arrow rumination review lane (htm9.15) ──
  // Deterministic nightly clustering (zero LLM, zero turn latency) over
  // recent memory writes' STORED embeddings, active concerns, and the
  // per-contact affect series. Findings become operator review cards (same
  // store, kind 'second_arrow') proposing consolidation of near-duplicate
  // rumination stacks; the lane never mutates memories, concerns, or emotion.
  const secondArrowEnabled = intakePolicy.driftDetection.enabled
    && intakePolicy.driftDetection.secondArrow.enabled;
  const secondArrowReview = secondArrowEnabled && memoryStore.listActiveMemoryEmbeddingsSince
    ? {
      evidence: createSecondArrowEvidencePort({
        memoryStore,
        contactStore,
        concernStore: intentionRuntime.concernStore,
      }),
      cardStore: driftVelocityReview?.cardStore
        ?? createDriftReviewCardStore(resolveDriftReviewCardsPath(pathSnapshot.companionDataDir)),
      config: intakePolicy.driftDetection.secondArrow,
      watermarks: {
        getContactMaintenanceWatermark: (processor: string) =>
          contactStore.getContactMaintenanceWatermark(processor),
        setContactMaintenanceWatermark: (processor: string, lastRunAt: string) =>
          contactStore.setContactMaintenanceWatermark(processor, lastRunAt),
      },
    }
    : null;
  if (!secondArrowReview) {
    if (secondArrowEnabled) {
      // Enabled but the store cannot serve stored embeddings: loud, never silent.
      log.error(
        'Second-arrow review lane NOT wired: memory store lacks listActiveMemoryEmbeddingsSince '
        + '(stored-embedding reads); rumination detection is disabled until the store provides it',
      );
    } else {
      log.info('Second-arrow review lane disabled by intake-policy driftDetection.secondArrow.enabled');
    }
  }

  // ── emo_sim directed-relationship advisory (oth4.6) ──
  // Read-only ADVISORY over the observer-sidecar's persisted emo_sim affect
  // model, fed into the nightly contact trust/relationship review as one more
  // signal the companion weighs. It never mutates trust or relationship state.
  // Wired only when the sidecar is active, persists observations, and exposes a
  // companion agent name; otherwise the review simply omits the signal. The
  // Postgres store here is the SAME memoized instance the sidecar writes to.
  const dyadEmosimAgentName = observerEvalSidecar.config?.adapter?.agentName?.trim();
  const dyadRelationshipAdvisoryProvider =
    observerEvalSidecar.observer
    && observerEvalSidecar.config?.persistence?.enabled === true
    && dyadEmosimAgentName
      ? createEmoSimDyadRelationshipAdvisoryProvider({
        getLatestObservation: () =>
          createPostgresObserverEvalSidecarStore(
            postgresDatabaseUrl,
            {},
            resolveConfigTenantPoolScope(config),
          ).getLatestObservation(),
      })
      : null;
  if (!dyadRelationshipAdvisoryProvider) {
    log.info('emo_sim dyad relationship advisory not wired for trust-drift review', {
      sidecarActive: Boolean(observerEvalSidecar.observer),
      persistenceEnabled: observerEvalSidecar.config?.persistence?.enabled === true,
      hasAgentName: Boolean(dyadEmosimAgentName),
    });
  }

  // Policy-driven multi-template reflection system.
  await wireReflectionRuntime(
    agentLoop,
    scheduler,
    agentLoop,
    gatewaySender,
    pathSnapshot.companionDataDir,
    heartbeatChannelId,
    {
      eventBus,
      llmProvider,
      capabilityTier: config.capabilityTier,
      compositionalPolicy: config.compositionalPolicy,
      characterPromptVariablesProvider: buildCharacterPromptVariablesProvider(cardVersionStore),
      memoryWriter,
      promptRegistry: promptState.registry,
      reflectionStore,
      sessionManager,
      emotionState,
      contactStore,
      getActiveConcerns: intentionAppraisalHooks.getActiveConcerns,
      getRecentResolvedConcerns: intentionAppraisalHooks.getRecentResolvedConcerns,
      onIntentionConcernDecision: intentionAppraisalHooks.onIntentionConcernDecision,
      onIntentionFollowUpDecision: intentionAppraisalHooks.onIntentionFollowUpDecision,
      getPendingFollowUpsForResurfacing: intentionAppraisalHooks.getPendingFollowUpsForResurfacing,
      onIntentionFollowUpActivated: intentionAppraisalHooks.onIntentionFollowUpActivated,
      onIntentionFollowUpDampened: intentionAppraisalHooks.onIntentionFollowUpDampened,
      onBehavioralPatternOutcome: intentionBehavioralHooks.onBehavioralPatternOutcome,
      pendingFollowUpStore: intentionRuntime.pendingFollowUpStore,
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
      memoryMaintenanceStore: memoryStore,
      episodicDiagnosticsStore: episodicStore,
      postTurnActions,
      backgroundMaintenance,
      episodicProcessingRestWindow: schedulerConfig.episodicProcessing,
      ...(dyadRelationshipAdvisoryProvider ? { dyadRelationshipAdvisoryProvider } : {}),
      driftVelocityReview,
      secondArrowReview,
      orientationRewriteGate: schedulerConfig.orientationRewrite,
      reflectionNoveltyGate: schedulerConfig.reflectionNovelty,
      nearTurnMemoryCadence: schedulerConfig.nearTurnMemory,
      episodeSynthesis: schedulerConfig.episodeSynthesis,
      episodicWatermarkStore: episodicStore,
      companionNames: [card.data.name],
      companionAuthorIds: config.discordBotId ? [config.discordBotId] : [],
      memoryScopeClassifier: observedGroupMemoryScheduler,
      intentionAppraisalEnabled: config.intentionAppraisalEnabled !== false,
      ...(journalAutoPublisher ? { vaultAutoPublisher: journalAutoPublisher } : {}),
    },
  );

  const trackSessionActivity = createSessionActivityTracker(
    sessionManager,
    pathSnapshot.companionDataDir,
  );

  // ── Register gateway inbound message handlers ──
  // Handles generic voice.handleMessage / voice.stream.* with legacy discord.* aliases.
  const registeredGatewayMessageHandlers = registerGatewayMessageHandlers({
    eventBus,
    gateway,
    agentLoop,
    shardManager,
    safeguardAuditTrail,
    satelliteRouting: createNoopSatelliteRoutingPort(),
    config,
    log,
    trackSessionActivity,
    observedGroupMemoryScheduler,
    passiveNameCandidateBuilder,
    participationAppraiser,
    ...(reservationPhase ? { reservationPhase } : {}),
    ...(egressLeasePhase ? { egressLeasePhase } : {}),
    outboundReplyGuard,
    companionAuthorName: card.data.name,
  });
  const unregisterIcpTargetChannelInitiationCommand = registerIcpTargetChannelInitiationCommand(
    registeredGatewayMessageHandlers.icpTargetChannelInitiator,
  );
  const stopRegisteredRuntime = stopFn;
  stopFn = async () => {
    unregisterIcpTargetChannelInitiationCommand();
    await stopRegisteredRuntime();
  };

  // Start only after every restored post-turn action kind has a handler and
  // the target-channel command is registered. Otherwise the first scheduler
  // tick can terminally discard a due durable action as `missing_handler`.
  scheduler.start();
  await eventBus.emit('system.init', {});
  await eventBus.emit('system.ready', {});

  // Send "I'm back" notification (fire-and-forget)
  lifecycleNotifier.notifyReady().catch((err) => {
    log.error('Ready notification failed', { error: String(err) });
  });

  log.info('Ready — waiting for messages');

  // ── Graceful shutdown ──

  const shutdown = createSignalShutdownHandler({
    logger: log,
    runGracefulShutdown: stopFn,
    exit: (code) => { process.exit(code); },
    forceExitTimeoutMs: parsePositiveIntEnv(
      process.env.SHUTDOWN_FORCE_EXIT_TIMEOUT_MS,
      DEFAULT_SHUTDOWN_FORCE_EXIT_TIMEOUT_MS,
    ),
  });

  installSignalHandlers(shutdown, log);

  registerProcessErrorHandlers({
    logger: log,
    requestShutdown: () => {
      void shutdown('uncaughtException').catch(() => process.exit(1));
    },
  });
}

main().catch((err) => {
  log.error('Fatal error', { error: String(err) });
  process.exit(1);
});
