// ── Agent Container Entry Point ──
// Runs inside a --network=none container. Connects to gateway via Unix socket.
// Run: npx tsx src/app/agent/main.ts

import { ensureActiveTimezone } from '../../shared/time/active-timezone.js';
import { loadConfig } from '../../system/config/load-config.js';
import { createComponentLogger } from '../../shared/logger.js';
import { EventBus } from '../../shared/event-bus.js';
import { GatewayClient } from '../../boundary/gateway/client.js';
import { DEFAULT_GATEWAY_SOCKET_PATH } from '../../system/security/policy-constants.js';
import { resolveBackupRuntimeConfig } from '../../persistence/backups/config.js';
import {
  createEmbeddingDimensionMismatchWarning,
  runDatabaseIntegrityCheck,
  validateEmbeddingDimensions,
} from '../../persistence/backups/startup-checks.js';
import { parsePositiveIntEnv } from '../../shared/utils/env.js';
import { MemoryWriter } from '../../faculties/memory/writer.js';
import { registerMemoryTools } from '../../faculties/memory/runtime-wiring.js';
import { registerGitTools } from '../../boundary/integrations/git/runtime-wiring.js';
import { GatewayGitOps } from '../../boundary/integrations/git/gateway-ops.js';
import { registerBeadsTools } from '../../boundary/integrations/beads/runtime-wiring.js';
import { GatewayBeadsOps } from '../../boundary/integrations/beads/gateway-ops.js';
import {
  RUNTIME_MODE,
} from '../../system/lifecycle/runtime-mode.js';
import { attachTerminalDebugObserver } from '../startup/support/terminal-observer.js';
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
import { createSqliteCompanionStore } from '../../persistence/sqlite-companion-store.js';
import { CapabilityRuntime } from '../../system/capabilities/runtime.js';
import {
  createEligibilityGate,
} from '../../system/capabilities/eligibility.js';
import { ModuleLoader } from '../../system/modules/loader.js';
import {
  ensureRegistryFile,
  resolveModuleRegistryPathFromWorkspace,
} from '../../system/modules/registry.js';
import {
  loadRuntimeChannelsConfig,
} from '../../channels/backplane/config.js';
import { DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE } from '../../core/agent/tool-wiring-validator.js';
import { registerGatewayMessageHandlers } from './gateway-message-handlers.js';
import {
  buildRuntimeChannelsConfigOverrides,
} from '../startup/support/bootstrap-helpers.js';
import { resolveStartupPreflightBundle } from '../startup/support/startup-preflight.js';
import { emitEligibilityDecisionTelemetry } from '../startup/support/eligibility-telemetry.js';
import { createSignalShutdownHandler } from '../startup/support/signal-shutdown.js';
import { buildAgentControlPlane } from './control-plane.js';
import type { AgentControlPlaneShutdownTargets } from './control-plane.js';
import { createSandboxBrokerExecutionPort } from '../../boundary/sandbox/sandbox-execution-broker.js';
import {
  bootstrapAgentCoreRuntime,
} from './core-bootstrap.js';
import {
  startOptionalApiServer,
  resolveAgentApiSurfaceBindings,
} from './api-surface.js';
import { startOptionalAdminServer } from './admin-surface.js';
import {
  buildAgentSchedulerRuntime,
} from './scheduler-runtime.js';
import {
  createSessionActivityTracker,
  writeStartupSessionMetadata,
} from './session-activity.js';
import {
  enforceNetworkIsolationOnStartup,
  logStartupHydrationDiagnostics,
} from './startup-guards.js';
import {
  createOptionalVaultAutoPublisher,
  registerOptionalVaultTools,
} from './vault-runtime.js';
import { sanitizeCoreSubstrateConfig } from '../../system/config/runtime-config-contracts.js';

const log = createComponentLogger('Agent');
ensureActiveTimezone();
const DEFAULT_SOCKET_PATH = DEFAULT_GATEWAY_SOCKET_PATH;
const DEFAULT_SHUTDOWN_FORCE_EXIT_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const coreConfig = sanitizeCoreSubstrateConfig(config);
  const {
    lifecycleRuntimeContract,
    runtimeStatusMeta,
    startupHydration,
  } = resolveStartupPreflightBundle(config, {
    entrypoint: RUNTIME_MODE.GATEWAY_AGENT,
    env: process.env,
    logger: log,
  });
  const {
    pathSnapshot,
    trustPolicyConfig,
    schedulerConfig,
  } = startupHydration;
  logStartupHydrationDiagnostics(startupHydration.diagnostics);

  log.info('Loaded trust policy configuration', {
    exactOverrideCount: Object.keys(
      trustPolicyConfig.channelClassification.visibilityOverrides.exact,
    ).length,
    prefixOverrideCount: Object.keys(
      trustPolicyConfig.channelClassification.visibilityOverrides.prefix,
    ).length,
  });
  const channelsConfig = loadRuntimeChannelsConfig(
    pathSnapshot.systemDataDir,
    process.env,
    buildRuntimeChannelsConfigOverrides(config, startupHydration.settingsDomains.runtime),
    { credentialVault: config.credentialVault },
  );
  const backupConfig = resolveBackupRuntimeConfig({
    dataDir: pathSnapshot.companionDataDir,
    defaultRootDir: pathSnapshot.runtimePathLayout.backupsDir,
  });
  const capabilityRuntime = new CapabilityRuntime({
    dataDir: pathSnapshot.systemDataDir,
    seedDir: process.env.CONFIG_DIR,
  });
  config.capabilityTier = capabilityRuntime.getTier();
  const eligibilityGate = createEligibilityGate(
    () => capabilityRuntime,
    (decision) => emitEligibilityDecisionTelemetry(eventBus, decision, log),
  );
  const socketPath = process.env.GATEWAY_SOCKET ?? DEFAULT_SOCKET_PATH;
  if (!process.env.WORKSPACE_PATH) {
    log.warn('WORKSPACE_PATH not set, defaulting to runtime layout workspace path', {
      mode: pathSnapshot.runtimePathLayout.mode,
      workspacePath: pathSnapshot.workspacePath,
      resolved: pathSnapshot.workspaceRoot,
    });
  }
  const moduleRegistryPath = resolveModuleRegistryPathFromWorkspace(
    pathSnapshot.workspaceRoot,
    process.env.MODULE_REGISTRY_PATH,
  );
  ensureRegistryFile(moduleRegistryPath);
  const eventBus = new EventBus();
  const stopDebugObserver = attachTerminalDebugObserver(eventBus, { scope: 'agent' });

  log.info('Initializing...');
  log.info('Lifecycle runtime contract resolved', runtimeStatusMeta);
  await enforceNetworkIsolationOnStartup();

  // ── Connect to gateway ──

  const embeddingDims = config.embeddingDims ?? 1024;

  log.info(`Connecting to gateway at ${socketPath}...`);
  const gateway = await GatewayClient.connect(socketPath, embeddingDims);
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

  const companionStore = createSqliteCompanionStore({
    databasePath: config.databasePath,
    companionDataDir: pathSnapshot.companionDataDir,
    embeddingDims,
  });
  const { db, memoryStore: companionMemoryStore } = companionStore;
  runDatabaseIntegrityCheck(db);
  log.info('SQLite integrity check passed');

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
    promptRegistry,
    promptStore,
    skillsRuntime,
    memoryStore,
    contactStore,
    coreMemoryStore,
    intentionRuntime,
    intentionAppraisalHooks,
    intentionBehavioralHooks,
    memoryExtractor,
  } = coreRuntime;

  sessionManager.characterName = card.data.name;
  writeStartupSessionMetadata(
    sessionManager,
    pathSnapshot.companionDataDir,
    config.sessionRestartBehavior ?? 'reuse_latest_session',
  );

  const embeddingDimensionCheck = validateEmbeddingDimensions(db, gateway.dims);
  const embeddingDimensionWarning = createEmbeddingDimensionMismatchWarning(
    embeddingDimensionCheck,
  );
  if (embeddingDimensionWarning) {
    log.warn(embeddingDimensionWarning.message, {
      configuredDims: embeddingDimensionWarning.configuredDims,
      storedDims: embeddingDimensionWarning.storedDims,
      recommendation: embeddingDimensionWarning.recommendation,
    });
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
    llmProvider: gateway,
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
  intentionRuntime.behavioralPatternTracker.setPromotionHook(
    createBehavioralPatternMemoryPromotionHook(memoryWriter),
  );
  registerMemoryTools(agentLoop, {
    writer: memoryWriter,
    memoryStore,
  });
  log.info('Context feedback runtime deferred (Phase VI): background context-scoring LLM calls disabled');

  // Git tools — self-modification via gateway-hosted git ops
  registerGitTools(agentLoop, new GatewayGitOps(gateway), { gatewayMode: true });
  log.info('Git self-modification tools enabled');

  // Beads issue-management tools — policy-scoped gateway RPC access (no shell passthrough)
  registerBeadsTools(agentLoop, new GatewayBeadsOps(gateway), { gatewayMode: true });
  log.info('Beads issue-management tools enabled');

  // Vault tools — Obsidian note read/write via gateway shell.exec
  await registerOptionalVaultTools(agentLoop, gateway, config);

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

  // ── API server (optional) ──

  const {
    apiHost,
    apiPort,
    adminHost,
    adminPort,
  } = resolveAgentApiSurfaceBindings(process.env);
  const apiServer = await startOptionalApiServer({
    apiHost,
    apiPort,
    adminHost,
    adminPort,
    config,
    env: process.env,
    channelsConfig,
    agentLoop,
    eventBus,
    eligibilityGate,
    sessionManager,
    contactStore,
    memoryStore,
    gateway,
    scheduler,
    runtimeStatusMeta,
  });

  // ── Admin GUI (optional) ──

  const adminServer = await startOptionalAdminServer({
    adminHost,
    adminPort,
    apiHost,
    apiPort,
    env: process.env,
    config,
    gateway,
    eventBus,
    scheduler,
    card,
    shardManager,
    cardVersionStore,
    cardProposalQueue,
    coreRuntime: {
      memoryStore,
      sessionStore,
      sessionManager,
      contactStore,
      promptStore,
      promptRegistry,
      skillsRuntime,
      agentLoop,
    },
  });
  if (adminServer) {
    log.info(`Admin GUI listening on port ${adminPort}`);
  }

  const heartbeatChannelId = channelsConfig.discord.heartbeatChannelId || undefined;
  const shutdownTargets: AgentControlPlaneShutdownTargets = {};
  const controlPlane = buildAgentControlPlane({
    heartbeatChannelId,
    dataDir: pathSnapshot.companionDataDir,
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
    closeDatabase: () => {
      db.close();
    },
    scheduler,
    moduleLoader,
    memoryExtractor,
    agentLoop,
    operatorNotifier,
    lifecycleRestartSafeguard,
    externalRateLimiter,
    capabilityRuntime,
    lifecycleRuntimeContract: lifecycleRuntimeContract as { mode: typeof lifecycleRuntimeContract.mode; restart: { command: string } },
    shutdownTargets,
  });
  const { lifecycleNotifier } = controlPlane;
  stopFn = controlPlane.stopFn;
  shutdownTargets.apiServer = apiServer;
  shutdownTargets.adminServer = adminServer;
  const gatewaySender = {
    send: (channelId: string, content: string) => gateway.discordSend(channelId, content),
  };

  // Vault auto-publisher (for heartbeat reflections → Obsidian vault)
  const vaultAutoPublisher = await createOptionalVaultAutoPublisher(gateway, config);

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
      llmProvider: gateway,
      capabilityTier: config.capabilityTier,
      compositionalPolicy: config.compositionalPolicy,
      characterPromptVariablesProvider: buildCharacterPromptVariablesProvider(cardVersionStore),
      memoryWriter,
      sessionManager,
      emotionState,
      contactStore,
      getActiveConcerns: intentionAppraisalHooks.getActiveConcerns,
      getRecentResolvedConcerns: intentionAppraisalHooks.getRecentResolvedConcerns,
      onIntentionConcernDecision: intentionAppraisalHooks.onIntentionConcernDecision,
      onIntentionFollowUpDecision: intentionAppraisalHooks.onIntentionFollowUpDecision,
      onIntentionFollowUpActivated: intentionAppraisalHooks.onIntentionFollowUpActivated,
      onBehavioralPatternOutcome: intentionBehavioralHooks.onBehavioralPatternOutcome,
      coreMemoryStore,
      postTurnActions,
      intentionAppraisalEnabled: config.intentionAppraisalEnabled !== false,
      ...(vaultAutoPublisher ? { vaultAutoPublisher } : {}),
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
