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
  registerTemporalWakeupLane,
} from './startup/temporal-wakeup-lane.js';
import {
  registerFreeTimeLane,
} from './startup/free-time-lane.js';
import {
  registerSocialDesireLane,
} from './startup/social-desire-lane.js';
import {
  wireSpeakingArbiterLane,
} from './startup/speaking-arbiter-lane.js';
import {
  wireDriftReviewLanes,
} from './startup/drift-review-lanes.js';
import {
  registerIntrospectionLane,
} from './startup/introspection-lane.js';
import {
  registerWeightedThoughtOutreachLane,
} from './startup/weighted-thought-outreach-lane.js';
import { trustOrd } from '../../system/trust/types.js';
import { recordWeightedThought } from '../../core/intention/weighted-thought-store-port.js';
import { RunChargeLedger } from '../../shared/telemetry/charge-ledger.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
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
  resolveChargeLedgerPath,
  resolveIntakeQuarantinePath,
  resolveOutreachOutboxLedgerPath,
  resolvePendingContactApprovalsPath,
  resolveSocialGraphProposalsPath,
  resolveSocialGraphBuilderWatermarkPath,
} from '../../persistence/layout.js';
import { createFilePendingContactApprovalStore } from '../../core/contacts/pending-contact-approvals.js';
import {
  createFileSocialGraphProposalStore,
  createFileSocialGraphBuilderWatermarkStore,
} from '../../faculties/memory/social-graph/proposals.js';
import { createContactTrackingGate } from '../../core/contacts/tracking-gate.js';
import { rehydratePersistedInternalState } from '../../core/self-model/internal-state-persistence.js';
import { ModuleLoader } from '../../system/modules/loader.js';
import { DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE } from '../../core/agent/tool-wiring-validator.js';
import { registerGatewayMessageHandlers } from './gateway-message-handlers.js';
import { registerIcpTargetChannelInitiationCommand } from './icp-target-channel-command.js';
import { OutboundReplyDeduper } from '../../system/lifecycle/outbound-reply-dedupe.js';
import { resolveGatewayConnectFailureExitCode } from './gateway-connect-failure.js';
import { createGatewayDisconnectRecovery } from './gateway-disconnect-recovery.js';
import { ObservedGroupMemoryScheduler } from '../../faculties/memory/extraction/group-observed-scheduler.js';
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
import { emitGardenQueueChanged } from '../../shared/garden-queue-change.js';
import { enforceNetworkIsolationOnStartup } from './startup-guards.js';
import {
  DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG,
} from '../../system/config/scheduler-config.js';
import { registerToolUsageEvaluatorTask } from '../../core/agent/tool-surface/usage-evaluator-scheduler-lane.js';
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
import { resolveOperatorAlertSinkConfiguration } from '../../shared/contracts/operator-alerting.js';

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
  const operatorAlerting = resolveOperatorAlertSinkConfiguration({
    ntfyConfigured: Boolean(
      process.env.NTFY_BASE_URL?.trim() && process.env.NTFY_TOPIC?.trim(),
    ),
    telegramEnabled: channelsConfig.telegram.enabled,
    telegramChatId: channelsConfig.telegram.operatorChatId,
  });
  if (operatorAlerting.status === 'unconfigured') {
    log.error('OPERATOR ALERTING IS UNCONFIGURED', {
      warning: operatorAlerting.warning,
      configuredSinks: operatorAlerting.configuredSinks,
    });
  }

  log.info('Initializing...');
  log.info('Lifecycle runtime contract resolved', runtimeStatusMeta);
  await enforceNetworkIsolationOnStartup();
  const shutdownForceExitTimeoutMs = parsePositiveIntEnv(
    process.env.SHUTDOWN_FORCE_EXIT_TIMEOUT_MS,
    DEFAULT_SHUTDOWN_FORCE_EXIT_TIMEOUT_MS,
  );

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
  let stopFn: () => Promise<void> = async () => {};
  let withdrawReadiness = (): void => undefined;
  const gatewayDisconnectRecovery = createGatewayDisconnectRecovery({
    logger: log,
    withdrawReadiness: () => withdrawReadiness(),
    runGracefulShutdown: () => stopFn(),
    exit: code => process.exit(code),
    restartExitCode: resolveGatewayConnectFailureExitCode(lifecycleRuntimeContract.restart),
    forceExitTimeoutMs: shutdownForceExitTimeoutMs,
  });
  const unregisterGatewayDisconnect = gateway.onDisconnect(gatewayDisconnectRecovery);

  // Self-report companion identity before any other traffic. Multi-companion
  // gateways reject unidentified agents fail-closed; a failure here is fatal.
  await gateway.identifyAsAgent();
  const llmProvider = createLLMProviderPort(gateway);
  const gatewayOps = createGatewayOpsPortFromClient(gateway);
  log.info('Connected to gateway', {
    ...(config.companionId ? { companionId: config.companionId } : {}),
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
      await gateway.notifyOperator({
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
          // hrmrq.85: personalProjectId is LIVE provenance — the outreach
          // resolver routes it to the primary channel and the outbound gate
          // re-verifies the project is still resumable at dispatch time.
          provenance: {
            sourceChannelId: 'internal:free-time:project',
            personalProjectId: project.id,
          },
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
        onExpired: ({ entry, expiredAtMs, reason }) => {
          void eventBus.emit('intake.quarantine.expired', {
            envelopeId: entry.id,
            ...(entry.sourceChannelId ? { sourceChannelId: entry.sourceChannelId } : {}),
            heldAtMs: entry.heldAtMs,
            expiredAtMs,
            reason,
          }).catch((error: unknown) => {
            log.error('Failed to emit intake quarantine expiry alert event', {
              envelopeId: entry.id,
              error: String(error),
            });
          });
        },
      },
    )
    : null;
  const intakeScreening = maybeCreateIntakeScreeningService({
    policy: intakePolicy,
    actor: 'agent:intake-screening',
    onFailClosed: (event) => {
      void eventBus.emit('intake.screening.fail_closed', event).catch((error: unknown) => {
        log.error('Failed to emit fail-closed intake screening alert event', {
          stage: event.stage,
          error: String(error),
        });
      });
    },
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
    unregisterFeltImpulseAdapter: unregisterIcpFeltImpulseAdapter,
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
    // hrmrq.34 (D4): affect-driven felt-impulse initiation targets canonical
    // sibling peers via the agent-facing autonomy runtime's directory.
    ...(coreRuntime.icpAutonomyRuntime
      ? { peerDirectory: coreRuntime.icpAutonomyRuntime }
      : {}),
    lifecycleConfig: schedulerConfig.weightedThoughtOutreach.lifecycle,
  });

  // ── Introspection audit runtime (Laws 28-30): extracted to
  // startup/introspection-lane.ts (charter 12.1 split).
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
    fileRead: gatewayOps.filesystem.read,
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
        readRecentTurnRecords: (channelKey, limit) => (
          sessionStore.getRecentTurnRecordUsage(channelKey, limit)
        ),
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
    operatorAlerting,
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
    withdrawReadiness = () => adminTransport.withdrawReadiness();
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
    unregisterIcpFeltImpulseAdapter();
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
  // ── Temporal wake-up lanes (E7.1): morning wake + idle refresher, extracted
  // to startup/temporal-wakeup-lane.ts (charter 12.1 split).
  registerTemporalWakeupLane({
    scheduler,
    sessionManager,
    config: schedulerConfig.temporalWakeup,
    quietHours: schedulerConfig.episodicProcessing,
    eventBus,
    agentLoop,
    llmProvider,
    promptRegistry: promptState.registry,
    proactiveOutbound,
    companionName: card.data.name,
  });

  // ── Free-time lanes (E8.1): self-directed time, extracted to
  // startup/free-time-lane.ts (charter 12.1 split).
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
    personalProjects,
  });
  // ── Weighted-thought outreach lane (E?/1xb.2) + Law 27 contradiction
  // dampening: extracted to startup/weighted-thought-outreach-lane.ts.
  registerWeightedThoughtOutreachLane({
    scheduler,
    schedulerConfig,
    eventBus,
    log,
    weightedThoughtStore: persistenceRuntime.weightedThoughtStore,
    llmProvider,
    companionName: card.data.name,
    heartbeatChannelId,
    contactStore,
    concernStore: intentionRuntime.concernStore,
    icpWeightedThoughtCandidateAdapter,
  });

  // ── Social-desire consent-moment lane (epic oth4, bead oth4.2): extracted
  // to startup/social-desire-lane.ts (charter 12.1 split).
  const { socialDesireOutbound, socialDesireHumanDeliveryPolicy } = registerSocialDesireLane({
    schedulerConfig,
    scheduler,
    postTurnActions,
    eventBus,
    log,
    socialDesireStore: persistenceRuntime.socialDesireStore,
    outreachOutbox,
    heartbeatChannel,
    contactStore,
    icpPeers: coreRuntime.icpAutonomyRuntime,
    localCompanionId: config.companionId,
    llmProvider,
    companionName: card.data.name,
    // hrmrq.85: compose the accumulation writer into the post-turn
    // emotion-appraisal path — the lane's single production producer.
    attachFeltSignalWriter: (writer) => {
      agentLoop.socialDesireFeltSignals = writer;
    },
  });

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

  // ── Social participation + speaking-arbiter wiring (bible §8, jp36):
  // extracted to startup/speaking-arbiter-lane.ts (charter 12.1 split).
  const {
    passiveNameCandidateBuilder,
    participationAppraiser,
    reservationPhase,
    egressLeasePhase,
  } = wireSpeakingArbiterLane({
    config,
    schedulerConfig,
    llmProvider,
    agentLoop,
    companionName: card.data.name,
    observedGroupMemoryScheduler,
    sessionStore,
    persistenceRuntime,
    coreRuntime,
    gatewaySender,
    outboundReplyGuard,
  });

  // ── Drift review lanes (htm9.14/htm9.15) + emo_sim dyad advisory (oth4.6):
  // extracted to startup/drift-review-lanes.ts (charter 12.1 split).
  const { driftVelocityReview, secondArrowReview, dyadRelationshipAdvisoryProvider } =
    wireDriftReviewLanes({
      intakePolicy,
      contactStore,
      memoryStore,
      concernStore: intentionRuntime.concernStore,
      companionDataDir: pathSnapshot.companionDataDir,
      observerEvalSidecar,
      postgresDatabaseUrl,
      config,
      log,
    });

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
      // hrmrq.85: live personal-project provenance verification for
      // weighted-thought outreach — the project must still exist and be
      // resumable (active/paused) at dispatch time.
      verifyPersonalProjectLive: async (projectId: string) => {
        try {
          const project = personalProjects.getProject(projectId);
          return project.status === 'active' || project.status === 'paused';
        } catch (error) {
          // A vanished project is stale provenance, not a runtime fault; any
          // other failure (corrupt manifest, store error) propagates so the
          // gate's caller records a real failure instead of a silent block.
          if (error instanceof Error && error.message.includes('personal project not found')) {
            return false;
          }
          throw error;
        }
      },
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
  // Identification happens before the runtime is composed. Publish readiness
  // only after every inbound notification handler is installed so the gateway
  // can replay deploy-window traffic without racing startup registration.
  await gateway.declareRuntimeReady();
  adminTransport?.markRuntimeReady();

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
    forceExitTimeoutMs: shutdownForceExitTimeoutMs,
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
