// ── Agent Container Entry Point ──
// Runs inside a --network=none container. Connects to gateway via Unix socket.
// Run: npx tsx src/app/agent/main.ts

import { ensureActiveTimezone } from '../../shared/time/active-timezone.js';
import { createComponentLogger } from '../../shared/logger.js';
import { GatewayClient } from '../../boundary/gateway/client.js';
import { parsePositiveIntEnv } from '../../shared/utils/env.js';
import { MemoryWriter } from '../../faculties/memory/writer.js';
import { EpisodicSynthesizer } from '../../faculties/memory/episodic/index.js';
import { SleepCycleEpisodeConsolidator } from '../../faculties/memory/episodic/sleep-consolidation.js';
import { EpisodeArcWeaver } from '../../faculties/memory/episodic/arc-formation.js';
import { DreamMeaningPass } from '../../faculties/memory/episodic/dream-meaning-pass.js';
import { ProactiveOutboundDispatcher } from '../../core/intention/proactive-outbound.js';
import { registerMemoryTools } from '../../faculties/memory/runtime-wiring.js';
import { registerGitTools } from '../../boundary/integrations/git/runtime-wiring.js';
import { GatewayGitOps } from '../../boundary/integrations/git/gateway-ops.js';
import { registerBeadsTools } from '../../boundary/integrations/beads/runtime-wiring.js';
import { GatewayBeadsOps } from '../../boundary/integrations/beads/gateway-ops.js';
import { createBehavioralPatternMemoryPromotionHook } from '../../core/intention/patterns.js';
import {
  wireShardAndThinkRuntime,
} from '../startup/composition/composition.js';
import { buildShellExecPolicyConfig } from '../../boundary/sandbox/execution/shell-policy-config.js';
import {
  buildCharacterPromptVariablesProvider,
  buildReplConfig,
  wireHeartbeatRuntime,
} from '../startup/composition/parity.js';
import { createAgentPersistenceRuntime } from '../../persistence/runtime-factory.js';
import { rehydratePersistedInternalState } from '../../core/self-model/internal-state-persistence.js';
import { ModuleLoader } from '../../system/modules/loader.js';
import { DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE } from '../../core/agent/tool-wiring-validator.js';
import { registerGatewayMessageHandlers } from './gateway-message-handlers.js';
import { createWyomingSatelliteRoutingPort } from '../../../satellites/wyoming/host/routing.js';
import { createSignalShutdownHandler } from '../startup/support/signal-shutdown.js';
import { buildAgentControlPlane } from './control-plane.js';
import type { AgentControlPlaneShutdownTargets } from './control-plane.js';
import { createSandboxBrokerExecutionPort } from '../../boundary/sandbox/sandbox-execution-broker.js';
import { createLLMProviderPort } from '../../core/agent/contracts.js';
import { createGatewayOpsPortFromClient } from '../../boundary/gateway/gateway-ops-port.js';
import {
  bootstrapAgentCoreRuntime,
} from './core-bootstrap.js';
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
import { enforceNetworkIsolationOnStartup } from './startup-guards.js';
import {
  createOptionalJournalAutoPublisher,
  registerMarkdownJournalTools,
} from './journal-runtime.js';
import { prepareAgentStartupContext } from './startup-context.js';
import { AgentApiBackend } from '../../channels/api/agent-backend.js';
import { resolveActiveHealthProbeConfig } from '../../channels/api/active-health-probe.js';
import { buildExternalChannelProfiles } from '../../channels/backplane/config.js';

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
    backupConfig,
    capabilityRuntime,
    eligibilityGate,
    socketPath,
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

  log.info(`Connecting to gateway at ${socketPath}...`);
  const gateway = await GatewayClient.connect(socketPath, embeddingDims);
  const llmProvider = createLLMProviderPort(gateway);
  const gatewayOps = createGatewayOpsPortFromClient(gateway);
  log.info('Connected to gateway');
  let shuttingDown = false;
  let stopFn: () => Promise<void> = async () => {};
  const unregisterGatewayDisconnect = gateway.onDisconnect(async (event) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.error('Gateway connection lost; shutting down agent process', {
      source: event.source,
      error: event.error?.message,
    });
    try {
      await stopFn();
    } finally {
      process.exit(1);
    }
  });

  const persistenceRuntime = await createAgentPersistenceRuntime({
    config,
    pathSnapshot,
    embeddingDims,
    primaryUserId,
  });
  const {
    backend: persistenceBackend,
    db,
    memoryStore: companionMemoryStore,
    episodicStore: companionEpisodicStore,
    reflectionStore,
    contactStore: persistedContactStore,
    intentionRuntime: persistedIntentionRuntime,
    intentionProviders,
  } = persistenceRuntime;
  log.info('PostgreSQL persistence backend selected; skipping SQLite startup checks', {
    persistenceBackend,
  });

  // ── Load identity (mounted read-only in container) ──

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
    pathSnapshot,
    eventBus,
    gateway,
    db,
    memoryStore: companionMemoryStore,
    episodicStore: companionEpisodicStore,
    contactStore: persistedContactStore,
    intentionRuntime: persistedIntentionRuntime,
    intentionProviders,
    capabilityRuntime,
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
    intentionRuntime,
    intentionAppraisalHooks,
    intentionBehavioralHooks,
    memoryExtractor,
    observerEvalSidecar,
  } = coreRuntime;

  sessionManager.characterName = card.data.name;
  writeStartupSessionMetadata(
    sessionManager,
    pathSnapshot.companionDataDir,
    config.sessionRestartBehavior ?? 'reuse_latest_session',
  );

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

  const { scheduler, postTurnActions } = buildAgentSchedulerRuntime({
    eventBus,
    eligibilityGate,
    config,
    schedulerConfig,
    sessionManager,
    gateway,
    memoryStore,
    agentLoop,
    db,
    backupConfig,
    pathSnapshot,
  });

  const moduleLoader = new ModuleLoader({
    eventBus,
    registerTool: (tool, category) => agentLoop.registerTool(tool, category),
    registryPath: moduleRegistryPath,
  });
  log.info('Split module registry path resolved', { moduleRegistryPath });

  const replConfig = buildReplConfig(config);
  const sandboxExecutionPort = createSandboxBrokerExecutionPort({
    workspacePath: pathSnapshot.workspaceRoot,
    policy: buildShellExecPolicyConfig(process.env),
    brokerId: 'agent-process',
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
    compositionalPolicy: config.compositionalPolicy,
    moduleInstallConfirmationQueue: cardProposalQueue,
    onModuleRegistryMutation: async (mutation) => {
      await moduleLoader.applyRegistryMutation(mutation);
    },
    executionPort: sandboxExecutionPort,
  });

  // Memory write/import tools — intentional memory creation
  const memoryWriter = new MemoryWriter(memoryStore, gateway);
  const episodicStore = companionEpisodicStore;
  const episodicSynthesizer = new EpisodicSynthesizer(episodicStore, sessionManager);
  const sleepConsolidator = new SleepCycleEpisodeConsolidator(episodicStore, sessionManager, llmProvider);
  const arcWeaver = new EpisodeArcWeaver(episodicStore, llmProvider);
  const dreamMeaningPass = new DreamMeaningPass(episodicStore, agentLoop);
  intentionRuntime.behavioralPatternTracker.setPromotionHook(
    createBehavioralPatternMemoryPromotionHook(memoryWriter),
  );
  registerMemoryTools(agentLoop, {
    writer: memoryWriter,
    memoryStore,
  });
  log.info('Context feedback runtime deferred (Phase VI): background context-scoring LLM calls disabled');

  // Git tools — parent turns stay read-only; mutation must return through shard outputs.
  registerGitTools(agentLoop, new GatewayGitOps(gatewayOps), {
    gatewayMode: true,
    access: 'read_only',
  });
  log.info('Git repository inspection tools enabled for parent agent');

  // Beads issue-management tools — policy-scoped gateway RPC access (no shell passthrough)
  registerBeadsTools(agentLoop, new GatewayBeadsOps(gatewayOps), { gatewayMode: true });
  log.info('Beads issue-management tools enabled');

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
  const apiBackend = new AgentApiBackend({
    agentLoop,
    eventBus,
    sessionManager,
    llmProvider,
    contactStore,
    healthChecks: apiHealthChecks,
    externalChannelProfiles: buildExternalChannelProfiles(channelsConfig),
    satelliteRegistry: satelliteRegistryConfig,
    onStreamDelta: (requestId, text) => gateway.notifyApiStreamDelta(requestId, text),
  });
  gateway.onApiChatCompletion((params) => apiBackend.handleChatCompletion(params));
  gateway.onApiChatCancel((params) => apiBackend.cancelChatCompletion(params));
  gateway.onApiTelemetryIngest((params) => apiBackend.handleTelemetryIngest(params));
  gateway.onApiHealth(() => apiBackend.handleHealth());

  // ── Admin transport (optional) ──

  const adminTransport = await startOptionalAdminTransportServer({
    adminPort,
    apiHost,
    apiPort,
    env: process.env,
    config,
    satelliteRegistryConfig,
    gateway,
    eventBus,
    scheduler,
    postTurnActions,
    episodicStore,
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
    },
  });
  if (adminTransport) {
    log.info('Garden admin transport listening', {
      adminPort,
    });
  }

  const heartbeatChannelId = channelsConfig.discord.heartbeatChannelId || undefined;
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
    closeDatabase: () => {},
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
  });
  const { lifecycleNotifier } = controlPlane;
  let apiBackendDisposed = false;
  const disposeApiBackend = () => {
    if (apiBackendDisposed) return;
    apiBackendDisposed = true;
    apiBackend.dispose();
  };
  stopFn = async () => {
    disposeApiBackend();
    await controlPlane.stopFn();
  };
  shutdownTargets.adminTransport = adminTransport;
  const gatewaySender = {
    send: (channelId: string, content: string) => gateway.discordSend(channelId, content),
  };
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

  // Journal auto-publisher (for heartbeat reflections -> markdown journal)
  const journalAutoPublisher = createOptionalJournalAutoPublisher(pathSnapshot.workspaceRoot, config);

  // Heartbeat reflections — policy-driven multi-template reflection system
  wireHeartbeatRuntime(
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
      reflectionStore,
      sessionManager,
      emotionState,
      contactStore,
      getActiveConcerns: intentionAppraisalHooks.getActiveConcerns,
      getRecentResolvedConcerns: intentionAppraisalHooks.getRecentResolvedConcerns,
      onIntentionConcernDecision: intentionAppraisalHooks.onIntentionConcernDecision,
      onIntentionFollowUpDecision: intentionAppraisalHooks.onIntentionFollowUpDecision,
      onIntentionFollowUpActivated: intentionAppraisalHooks.onIntentionFollowUpActivated,
      onBehavioralPatternOutcome: intentionBehavioralHooks.onBehavioralPatternOutcome,
      pendingFollowUpStore: intentionRuntime.pendingFollowUpStore,
      coreMemoryStore,
      episodicSynthesizer,
      sleepConsolidator,
      arcWeaver,
      dreamMeaningPass,
      proactiveOutbound,
      memoryMaintenanceStore: memoryStore,
      episodicDiagnosticsStore: episodicStore,
      postTurnActions,
      episodicProcessingRestWindow: schedulerConfig.episodicProcessing,
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
  registerGatewayMessageHandlers({
    gateway,
    agentLoop,
    shardManager,
    safeguardAuditTrail,
    satelliteRouting: createWyomingSatelliteRoutingPort(),
    config,
    log,
    trackSessionActivity,
  });

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

  process.on('SIGINT', () => {
    void shutdown('SIGINT').catch((error) => {
      log.error('Unhandled SIGINT shutdown error', { error: String(error) });
      process.exit(1);
    });
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM').catch((error) => {
      log.error('Unhandled SIGTERM shutdown error', { error: String(error) });
      process.exit(1);
    });
  });
}

main().catch((err) => {
  log.error('Fatal error', { error: String(err) });
  process.exit(1);
});
