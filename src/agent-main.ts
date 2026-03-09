// ── Agent Container Entry Point ──
// Runs inside a --network=none container. Connects to gateway via Unix socket.
// Run: npm run agent

import { randomUUID } from 'node:crypto';
import { loadConfig } from './types.js';
import type {
  SubstrateMessage,
} from './types.js';
import { createComponentLogger } from './logger.js';
import { EventBus } from './event-bus.js';
import { MemoryStore } from './memory/store.js';
import { EmotionObserver } from './emotion/observer.js';
import { EmotionState } from './emotion/state.js';
import { getSharedAudioEmotionClassifier } from './emotion/audio-classifier.js';
import { SalienceDecay } from './memory/decay.js';
import { Scheduler } from './scheduler/scheduler.js';
import { GatewayClient } from './gateway/client.js';
import { DEFAULT_GATEWAY_SOCKET_PATH } from './security/policy-constants.js';
import type { ApiServer } from './channels/api/server.js';
import { createApiVoiceWebSocketRuntime } from './channels/api/voice-websocket-runtime.js';
import {
  CachedActiveHealthProbe,
  resolveActiveHealthProbeConfig,
  toActiveProbeMeta,
} from './channels/api/active-health-probe.js';
import { AdminServer } from './channels/admin/server.js';
import { ModelDiscovery } from './llm/discovery.js';
import { getIgnoredJsonBackedConfigEnvKeys } from './config/legacy-env.js';
import { resolveBackupRuntimeConfig } from './backup/config.js';
import { registerScheduledBackupTask } from './backup/service.js';
import {
  createEmbeddingDimensionMismatchWarning,
  runDatabaseIntegrityCheck,
  validateEmbeddingDimensions,
} from './backup/startup-checks.js';
import { initDatabase } from './persistence/sqlite-utils.js';
import { parseOptionalPositiveIntEnv, parsePositiveIntEnv } from './utils/env.js';
import { MemoryWriter } from './memory/writer.js';
import { registerMemoryTools } from './memory/runtime-wiring.js';
import { wireContactRuntime } from './contacts/runtime-wiring.js';
import { registerGitTools } from './git/runtime-wiring.js';
import { GatewayGitOps } from './git/gateway-ops.js';
import { registerBeadsTools } from './beads/runtime-wiring.js';
import { GatewayBeadsOps } from './beads/gateway-ops.js';
import { registerFilesystemTools } from './filesystem/runtime-wiring.js';
import { GatewayFilesystemOps } from './filesystem/gateway-ops.js';
import {
  DiscordLifecycleNotifier,
  writeLastActiveSession,
} from './lifecycle/notifications.js';
import type { MessageSender } from './lifecycle/notifications.js';
import {
  RUNTIME_MODE,
  resolveRuntimeModeContract,
  toRuntimeStatusMetadata,
} from './lifecycle/runtime-mode.js';
import { inferSessionChannelType } from './session/session-id.js';
import { createRestartTool, createRebuildTool } from './tools/lifecycle.js';
import { createGatewayNtfyNotifier, createNotifyOperatorTool } from './tools/ntfy.js';
import { attachTerminalDebugObserver } from './debug/terminal-observer.js';
import { wireSkillsRuntime } from './skills/runtime-wiring.js';
import {
  createIntentionAppraisalHooks,
  createIntentionBehavioralPatternHooks,
  wireIntentionRuntime,
} from './intention/runtime-wiring.js';
import { createBehavioralPatternMemoryPromotionHook } from './intention/patterns.js';
import {
  composeIdentity,
  composeSessionRuntime,
  composeSubstrateAgent,
  wireSelfModelRuntime,
  wireCoreMemoryRuntime,
  wireMemoryRuntime,
  wireShardAndThinkRuntime,
} from './bootstrap/composition.js';
import {
  wirePromptRuntime,
  wireCharacterCardRuntime,
  wireStaticPromptRegistry,
  wireSettingsRuntime,
  wireSessionToolsRuntime,
  buildCharacterPromptVariablesProvider,
  buildReplConfig,
  wireHeartbeatRuntime,
} from './bootstrap/parity.js';
import { wirePostTurnActionRuntime } from './bootstrap/post-turn-actions.js';
import { CapabilityRuntime } from './capabilities/runtime.js';
import {
  createEligibilityGate,
} from './capabilities/eligibility.js';
import {
  createSafeguardAuditTrail,
  createIdentityCoolingOffManagerFromEnv,
  createLifecycleRestartSafeguardFromEnv,
  createExternalCommunicationRateLimiterFromEnv,
} from './capabilities/safeguards.js';
import { ConfirmationQueue } from './capabilities/confirmation-queue.js';
import { CharacterCardVersionStore } from './identity/card-versioning.js';
import {
  composeSystemPromptTemplate,
} from './identity/loader.js';
import { ModuleLoader } from './modules/loader.js';
import {
  ensureRegistryFile,
  resolveModuleRegistryPathFromWorkspace,
} from './modules/registry.js';
import type { ChannelAdapter } from './channels/types.js';
import {
  createApiServerChannelAdapterFactoryEntry,
  requireChannelAdapter,
} from './bootstrap/channel-runtime.js';
import {
  buildChannelAdapterFactoryManifest,
  loadChannelAdaptersFromManifest,
} from './runtime/channel-lifecycle.js';
import { DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE } from './agent/tool-wiring-validator.js';
import { registerGatewayMessageHandlers } from './agent-main/gateway-message-handlers.js';
import { createGatewayBackedDiscoveryFetch } from './agent-main/discovery-gateway-fetch.js';
import { resolveWorkspaceRoot } from './gateway/filesystem-paths.js';
import {
  resolveCharacterCardHistoryPath,
  resolveContactsDir,
  resolveNotesDir,
  resolveScratchpadMirrorPath,
  resolveSessionsDir,
} from './persistence/layout.js';
import {
  hydrateCanonicalStartupConfig,
  type StartupConfigHydrationDiagnostics,
} from './runtime/bootstrap-helpers.js';
import { isExplicitTrue, parseCommaSeparatedEnv } from './runtime/env-parsing.js';
import {
  createStartupTextEmotionClassifier,
  warmRuntimeMlServices,
} from './runtime/ml-warmup.js';
import { resolveApiCorsAllowedOrigins } from './channels/api/http-policy.js';
import { emitEligibilityDecisionTelemetry } from './runtime/eligibility-telemetry.js';
import { runShutdownStep as runShutdownStepWithRetry } from './runtime/shutdown-helpers.js';
import { createSignalShutdownHandler } from './runtime/signal-shutdown.js';

const log = createComponentLogger('Agent');
const DEFAULT_SOCKET_PATH = DEFAULT_GATEWAY_SOCKET_PATH;
const DEFAULT_EXTRACTION_DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_API_REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_SHUTDOWN_FORCE_EXIT_TIMEOUT_MS = 15_000;
const DISABLED_VOICE_WEBSOCKET_PATH = '/v1/voice/ws-disabled';
const NETWORK_ISOLATION_PROBE_URL = 'http://1.1.1.1/cdn-cgi/trace';
const NETWORK_ISOLATION_PROBE_TIMEOUT_MS = 2_000;
const COMPACTION_GUIDELINE_REVIEW_TASK_ID = 'compaction-guideline-review';

function logStartupHydrationDiagnostics(diagnostics: StartupConfigHydrationDiagnostics): void {
  if (diagnostics.modelsMigratedFromLegacySettings) {
    log.warn('Migrated legacy model settings from settings.json to models.json');
  } else if (diagnostics.modelsLegacyDriftDetected) {
    log.warn('Detected legacy model drift between settings.json and models.json; models.json is authoritative');
  }

  if (diagnostics.maintenanceIntervalMigration.state === 'migrated') {
    log.warn('Migrated legacy maintenanceIntervalMs from settings.json to scheduler.json', {
      maintenanceIntervalMs:
        diagnostics.maintenanceIntervalMigration.storedValue
        ?? diagnostics.maintenanceIntervalMigration.settingsValue,
    });
  } else if (diagnostics.maintenanceIntervalMigration.state === 'drift_detected') {
    log.warn('Detected scheduler drift between settings.json and scheduler.json; scheduler.json is authoritative', {
      settingsMaintenanceIntervalMs: diagnostics.maintenanceIntervalMigration.settingsValue,
      schedulerMaintenanceIntervalMs: diagnostics.maintenanceIntervalMigration.storedValue,
    });
  } else if (diagnostics.maintenanceIntervalMigration.state === 'error') {
    log.warn('Failed to migrate legacy maintenanceIntervalMs from settings.json', {
      error: diagnostics.maintenanceIntervalMigration.error ?? 'unknown',
    });
  }

  if (diagnostics.capabilityTierMigration.state === 'migrated') {
    log.warn('Migrated legacy capabilityTier from settings.json to capability-tier.json', {
      capabilityTier:
        diagnostics.capabilityTierMigration.storedValue
        ?? diagnostics.capabilityTierMigration.settingsValue,
    });
  } else if (diagnostics.capabilityTierMigration.state === 'drift_detected') {
    log.warn('Detected capability tier drift between settings.json and capability-tier.json; capability-tier.json is authoritative', {
      settingsCapabilityTier: diagnostics.capabilityTierMigration.settingsValue,
      capabilityTier: diagnostics.capabilityTierMigration.storedValue,
    });
  } else if (diagnostics.capabilityTierMigration.state === 'error') {
    log.warn('Failed to migrate legacy capabilityTier from settings.json', {
      error: diagnostics.capabilityTierMigration.error ?? 'unknown',
    });
  }

  if (diagnostics.removedLegacyKeys.length > 0) {
    if (diagnostics.settingsRewriteError) {
      log.warn('Failed to rewrite settings.json without legacy cross-domain keys', {
        keys: diagnostics.removedLegacyKeys,
        error: diagnostics.settingsRewriteError,
      });
    } else {
      log.warn('Removed legacy cross-domain keys from settings.json', {
        keys: diagnostics.removedLegacyKeys,
      });
    }
  }
}

async function runShutdownStep(
  step: string,
  action: () => void | Promise<void>,
  maxAttempts = 2,
): Promise<void> {
  await runShutdownStepWithRetry(step, action, log, maxAttempts);
}

async function enforceNetworkIsolationOnStartup(): Promise<void> {
  const requireIsolation = isExplicitTrue(process.env.REQUIRE_NETWORK_ISOLATION);
  const timeoutMs = parsePositiveIntEnv(
    process.env.NETWORK_ISOLATION_PROBE_TIMEOUT_MS,
    NETWORK_ISOLATION_PROBE_TIMEOUT_MS,
  );
  const probeResult = await fetch(NETWORK_ISOLATION_PROBE_URL, {
    method: 'HEAD',
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  }).then(
    (response) => ({ reachable: true as const, status: response.status }),
    () => ({ reachable: false as const, status: null }),
  );

  if (!probeResult.reachable) {
    return;
  }

  const error = new Error(
    `Outbound network access is reachable from the agent container ` +
    `(probe=${NETWORK_ISOLATION_PROBE_URL}, status=${probeResult.status}).`,
  );
  log.error(`CRITICAL: ${error.message}`, {
    requireNetworkIsolation: requireIsolation,
  });

  if (requireIsolation) {
    throw error;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const ignoredMutableEnvKeys = getIgnoredJsonBackedConfigEnvKeys(process.env);
  if (ignoredMutableEnvKeys.length > 0) {
    log.warn('Ignoring JSON-owned config env vars; move runtime config into system-data JSON files and keep .env for secrets/bootstrap wiring only', {
      keys: ignoredMutableEnvKeys,
    });
  }
  const startupHydration = hydrateCanonicalStartupConfig(config, {
    env: process.env,
  });
  const {
    systemDataDir,
    companionDataDir,
    runtimePathLayout,
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
  const backupConfig = resolveBackupRuntimeConfig({
    dataDir: companionDataDir,
    defaultRootDir: runtimePathLayout.backupsDir,
  });
  const capabilityRuntime = new CapabilityRuntime({
    dataDir: systemDataDir,
    seedDir: process.env.CONFIG_DIR,
  });
  config.capabilityTier = capabilityRuntime.getTier();
  const eligibilityGate = createEligibilityGate(
    () => capabilityRuntime,
    (decision) => emitEligibilityDecisionTelemetry(eventBus, decision, log),
  );
  const lifecycleRuntimeContract = resolveRuntimeModeContract({
    entrypoint: RUNTIME_MODE.GATEWAY_AGENT,
    runtimeModeEnv: process.env.PSFN_RUNTIME_MODE,
    restartCommandEnv: process.env.LIFECYCLE_RESTART_COMMAND,
  });
  const runtimeStatusMeta = toRuntimeStatusMetadata(lifecycleRuntimeContract);
  const socketPath = process.env.GATEWAY_SOCKET ?? DEFAULT_SOCKET_PATH;
  const workspacePathEnv = process.env.WORKSPACE_PATH;
  const workspacePath = runtimePathLayout.workspacePath;
  const workspaceRoot = resolveWorkspaceRoot(workspacePath);
  if (!workspacePathEnv) {
    log.warn('WORKSPACE_PATH not set, defaulting to runtime layout workspace path', {
      mode: runtimePathLayout.mode,
      workspacePath,
      resolved: workspaceRoot,
    });
  }
  const moduleRegistryPath = resolveModuleRegistryPathFromWorkspace(
    workspaceRoot,
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
  let stopPromise: Promise<void> | null = null;
  let stopFn: () => Promise<void> = async () => {};
  const unregisterGatewayDisconnect = gateway.onDisconnect(async (event) => {
    if (shuttingDown) return;
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

  // ── Local SQLite database (sessions + memory) ──

  const db = initDatabase(config.databasePath);
  runDatabaseIntegrityCheck(db);
  log.info('SQLite integrity check passed');

  // ── Load identity (mounted read-only in container) ──

  const {
    card,
    systemPrompt,
    initializedCard,
    migratedLegacyBootstrap,
  } = composeIdentity(config);
  if (initializedCard) {
    log.warn('Character card file was missing and has been initialized with defaults', {
      characterCardPath: config.characterCardPath,
    });
  }
  if (migratedLegacyBootstrap) {
    log.warn('Legacy bootstrap character card was migrated to neutral starter defaults', {
      characterCardPath: config.characterCardPath,
    });
  }
  const cardVersionStore = new CharacterCardVersionStore(
    config.characterCardPath,
    resolveCharacterCardHistoryPath(companionDataDir),
  );
  const cardProposalQueue = new ConfirmationQueue({
    idFactory: () => `card-${randomUUID()}`,
  });
  log.info(`Loaded character: ${card.data.name}`);
  config.characterName = card.data.name;
  const promptRegistry = wireStaticPromptRegistry(companionDataDir);

  // ── Initialize local components ──

  const sessionsDir = resolveSessionsDir(companionDataDir);
  const sessionComposition = composeSessionRuntime({
    config,
    eventBus,
    sessionsDir,
    enableContinuity: true,
    promptRegistry,
    sessionIntegrityProvider: gateway.createSessionIntegrityProvider(),
  });
  const { sessionStore, sessionManager } = sessionComposition;
  sessionManager.characterName = card.data.name;
  const restartBehavior = config.sessionRestartBehavior ?? 'reuse_latest_session';
  const startupSession = sessionManager.resolveStartupSessionMetadata(restartBehavior);
  if (startupSession) {
    writeLastActiveSession(companionDataDir, startupSession);
    if (restartBehavior === 'new_session') {
      log.info('Initialized fresh startup session metadata', {
        sessionId: startupSession.sessionId,
        channelType: startupSession.channelType ?? 'unknown',
        timestamp: startupSession.timestamp,
      });
    } else {
      log.info('Restored latest session metadata', {
        sessionId: startupSession.sessionId,
        channelType: startupSession.channelType ?? 'unknown',
        timestamp: startupSession.timestamp,
      });
    }
  }

  const memoryStore = new MemoryStore(db, gateway.dims, {
    notesDir: resolveNotesDir(companionDataDir),
    scratchpadMirrorPath: resolveScratchpadMirrorPath(companionDataDir),
  });
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

  // ── Agent loop (uses gateway as LLM provider) ──

  const textClassifier = createStartupTextEmotionClassifier({
    model: config.textEmotionModel,
    cacheDir: config.textEmotionCacheDir,
    dtype: config.textEmotionDtype,
  });
  await warmRuntimeMlServices({
    textClassifier,
    embeddingService: gateway,
    textEmotionModel: config.textEmotionModel!.trim(),
    logger: log,
  });
  const emotionObserver = new EmotionObserver({
    textClassifier,
    audioClassifier: getSharedAudioEmotionClassifier(),
  });
  const emotionState = new EmotionState();
  const agentLoop = composeSubstrateAgent({
    eventBus,
    llmProvider: gateway,
    sessionManager,
    systemPrompt,
    characterName: card.data.name,
    characterPromptVariablesProvider: buildCharacterPromptVariablesProvider(cardVersionStore),
    config,
    emotionRuntime: {
      observer: emotionObserver,
      state: emotionState,
      requireWiring: true,
    },
  });
  agentLoop.scratchpadProvider = memoryStore;
  agentLoop.setCapabilityRuntime(capabilityRuntime);
  const safeguardAuditTrail = createSafeguardAuditTrail(companionDataDir);
  const identityCoolingOff = createIdentityCoolingOffManagerFromEnv(process.env, {
    auditTrail: safeguardAuditTrail,
  });
  const lifecycleRestartSafeguard = createLifecycleRestartSafeguardFromEnv(process.env, {
    auditTrail: safeguardAuditTrail,
  });
  const externalRateLimiter = createExternalCommunicationRateLimiterFromEnv(process.env, {
    auditTrail: safeguardAuditTrail,
  });

  const skillsRuntime = wireSkillsRuntime(agentLoop, {
    dataDir: systemDataDir,
    seedDir: process.env.CONFIG_DIR,
    repoRoot: process.cwd(),
  });
  registerFilesystemTools(agentLoop, new GatewayFilesystemOps(gateway), { gatewayMode: true });

  // Prompt stack — layered, editable system prompt
  const promptStore = wirePromptRuntime(agentLoop, companionDataDir, composeSystemPromptTemplate(), {
    identityCoolingOff,
    getCapabilityTier: () => capabilityRuntime.getTier(),
  });
  wireCharacterCardRuntime(agentLoop, cardVersionStore, {
    getCapabilityTier: () => capabilityRuntime.getTier(),
    confirmationQueue: cardProposalQueue,
  });
  wireSettingsRuntime(agentLoop, config);
  wireSessionToolsRuntime(agentLoop, sessionManager, companionDataDir, gateway);
  const coreMemoryStore = wireCoreMemoryRuntime({
    agentLoop,
    sessionManager,
    config,
  });

  // Contact store + tools — trust-gated privacy system
  const primaryUserId = process.env.PRIMARY_USER_ID ?? process.env.DISCORD_VOICE_USER_ID;
  const primaryTelegramUserId = (
    process.env.PRIMARY_TELEGRAM_USER_ID
    ?? process.env.TELEGRAM_PRIMARY_USER_ID
    ?? ''
  ).trim();
  const contactStore = wireContactRuntime(
    agentLoop,
    db,
    primaryUserId,
    {
      exportDir: resolveContactsDir(companionDataDir),
      ...(primaryTelegramUserId
        ? {
          bootstrapPrimaryIdentityLinks: [{
            channel: 'telegram',
            userId: primaryTelegramUserId,
            privacyLevel: 'private',
          }],
        }
      : {}),
  },
);
  const intentionRuntime = wireIntentionRuntime(agentLoop, db);
  wireSelfModelRuntime(agentLoop);
  const intentionAppraisalHooks = createIntentionAppraisalHooks(intentionRuntime.concernStore);
  const intentionBehavioralHooks = createIntentionBehavioralPatternHooks(
    intentionRuntime.behavioralPatternTracker,
  );

  // Wire memory system (uses gateway for embeddings + LLM extraction)
  const memoryExtractor = wireMemoryRuntime({
    agentLoop,
    llmProvider: gateway,
    sessionManager,
    sessionStore,
    memoryStore,
    embeddingService: gateway,
    eventBus,
    config,
    promptRegistry,
    contactStore,
  });

  const salienceDecay = new SalienceDecay(memoryStore);

  // Scheduler — the companion's internal clock
  const scheduler = new Scheduler(eventBus, {
    tickIntervalMs: schedulerConfig.tickIntervalMs,
    heartbeatIntervalMs: schedulerConfig.heartbeatIntervalMs,
  }, {
    eligibilityGate,
  });
  scheduler.register({
    id: 'salience-decay',
    name: 'Memory Salience Decay',
    type: 'every',
    intervalMs: config.maintenanceIntervalMs,
    handler: () => salienceDecay.run(),
    eligibility: { requiredTokens: ['memory.write'] },
    state: 'idle',
  });
  scheduler.register({
    id: COMPACTION_GUIDELINE_REVIEW_TASK_ID,
    name: 'Compression Guideline Review',
    type: 'every',
    intervalMs: config.maintenanceIntervalMs,
    handler: async () => {
      const result = await sessionManager.runPeriodicCompressionGuidelineUpdate(gateway);
      if (result.status === 'updated') {
        log.info('Compression guideline updated from failure log review', {
          version: result.version,
          reviewedFailureCount: result.reviewedFailureCount,
        });
        return;
      }
      log.debug('Compression guideline review skipped', {
        reason: result.reason,
        reviewedFailureCount: result.reviewedFailureCount,
      });
    },
    eligibility: { requiredTokens: ['memory.write'] },
    state: 'idle',
  });
  registerScheduledBackupTask({
    scheduler,
    db,
    databasePath: config.databasePath,
    sessionsDir,
    config: backupConfig,
  });
  log.info('Scheduled backups enabled', {
    intervalMs: backupConfig.intervalMs,
    retentionCount: backupConfig.retentionCount,
    backupRootDir: backupConfig.rootDir,
  });
  scheduler.registerHeartbeat(async () => {
    const now = Date.now();
    await eventBus.emit('schedule.heartbeat', { timestamp: now, taskCount: scheduler.taskCount });
  });
  const postTurnActions = wirePostTurnActionRuntime({
    eventBus,
    scheduler,
    agentLoop,
    eligibilityGate,
  });
  eventBus.on('agent.turn.end', ({ message, response }) => {
    const captured = sessionManager.recordCompressionFailureFromResponse(
      message.channelId,
      message.id,
      response.content,
    );
    if (!captured) return;
    log.info('Captured compression failure signal for guideline evolution', {
      channelId: message.channelId,
      sourceMessageId: message.id,
    });
  });
  scheduler.start();
  log.info(`Memory system enabled (${gateway.dims}d embeddings via gateway)`);

  const moduleLoader = new ModuleLoader({
    eventBus,
    registerTool: (tool, category) => agentLoop.registerTool(tool, category),
    registryPath: moduleRegistryPath,
  });
  log.info('Split module registry path resolved', { moduleRegistryPath });

  const replConfig = buildReplConfig(config);
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
    scheduler,
    replConfig,
    shardAuditTrail: safeguardAuditTrail,
    getCapabilityTier: () => capabilityRuntime.getTier(),
    compositionalPolicy: config.compositionalPolicy,
    moduleInstallConfirmationQueue: cardProposalQueue,
    onModuleRegistryMutation: async (mutation) => {
      await moduleLoader.applyRegistryMutation(mutation);
    },
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
  if (config.obsidianVaultName) {
    const { GatewayVaultOps } = await import('./vault/gateway-ops.js');
    const { registerVaultTools } = await import('./vault/runtime-wiring.js');
    const vaultOps = new GatewayVaultOps(gateway, {
      vaultName: config.obsidianVaultName,
      cliPath: config.obsidianCliPath,
      timeoutMs: config.obsidianTimeoutMs,
    });
    registerVaultTools(agentLoop, vaultOps, { gatewayMode: true });
    log.info('Obsidian vault tools enabled', { vault: config.obsidianVaultName });
  }

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

  let apiServer: ApiServer | undefined;
  const apiHost = process.env.API_HOST || undefined;
  const apiPort = parseOptionalPositiveIntEnv(process.env.API_PORT);
  const adminHost = process.env.ADMIN_HOST || undefined;
  const adminPort = parseOptionalPositiveIntEnv(process.env.ADMIN_PORT);
  if (apiPort) {
    const allowInsecureWithoutAuth = isExplicitTrue(process.env.ALLOW_INSECURE_LOCAL_API);
    const corsAllowedOrigins = resolveApiCorsAllowedOrigins({
      explicitAllowlist: parseCommaSeparatedEnv(process.env.API_CORS_ALLOWLIST),
      adminHost,
      adminPort,
    });
    const voiceWebSocketRuntime = createApiVoiceWebSocketRuntime({
      agentLoop,
      eventBus,
      config,
      eligibilityGate,
    });
    const voiceWebSocketPath = voiceWebSocketRuntime
      ? undefined
      : DISABLED_VOICE_WEBSOCKET_PATH;
    if (!voiceWebSocketRuntime) {
      log.info('API voice websocket runtime gated off: STT/TTS runtime is not fully wired');
    }
    const activeProbeConfig = resolveActiveHealthProbeConfig(process.env);
    const llmActiveProbe = new CachedActiveHealthProbe(activeProbeConfig);
    const embeddingsActiveProbe = new CachedActiveHealthProbe(activeProbeConfig);
    const apiChannelRegistry = new Map<string, ChannelAdapter>();
    const apiChannelManifest = buildChannelAdapterFactoryManifest([
      createApiServerChannelAdapterFactoryEntry({
        port: apiPort,
        host: apiHost,
        agentLoop,
        eventBus,
        sessionManager,
        contactStore,
        apiKey: process.env.API_KEY || undefined,
        adminToken: process.env.ADMIN_TOKEN || undefined,
        allowInsecureWithoutAuth,
        corsAllowedOrigins,
        modelName: process.env.API_MODEL_NAME,
        requestTimeoutMs: parsePositiveIntEnv(
          process.env.API_REQUEST_TIMEOUT_MS,
          DEFAULT_API_REQUEST_TIMEOUT_MS,
        ),
        voiceWebSocketPath,
        voiceWebSocketRuntime,
        healthChecks: {
        memory: () => {
          const stats = memoryStore.getStats();
          return {
            status: 'healthy',
            meta: {
              total: stats.total,
              avgSalience: Number(stats.avgSalience.toFixed(4)),
              ...runtimeStatusMeta,
            },
          };
        },
        llm: async () => {
          const configured = Boolean(config.primaryModel && config.primaryProvider);
          const baseMeta = {
            provider: config.primaryProvider,
            model: config.primaryModel,
            ...toActiveProbeMeta(activeProbeConfig),
            ...runtimeStatusMeta,
          };

          if (!configured) {
            return {
              status: 'degraded',
              detail: 'Primary model/provider is not configured',
              meta: baseMeta,
            };
          }

          if (!activeProbeConfig.enabled) {
            return {
              status: 'healthy',
              meta: baseMeta,
            };
          }

          const probeResult = await llmActiveProbe.run(async (signal) => {
            await gateway.complete(
              {
                systemPrompt: 'You are a health check. Respond with exactly: OK',
                messages: [{ role: 'user', content: 'health probe' }],
              },
              'reasoning',
              { signal },
            );
          });
          const meta = {
            ...baseMeta,
            ...toActiveProbeMeta(activeProbeConfig, probeResult),
          };

          if (!probeResult.ok) {
            return {
              status: 'degraded',
              detail: probeResult.reason ?? 'LLM connectivity probe failed',
              meta,
            };
          }

          return {
            status: 'healthy',
            meta,
          };
        },
        discord: () => ({
          status: 'degraded',
          detail: 'Discord transport runs outside the agent container',
          meta: runtimeStatusMeta,
        }),
        embeddings: async () => {
          const baseMeta = {
            dims: gateway.dims,
            ...toActiveProbeMeta(activeProbeConfig),
            ...runtimeStatusMeta,
          };
          if (!Number.isFinite(gateway.dims) || gateway.dims <= 0) {
            return {
              status: 'degraded',
              detail: 'Embedding dimensions are invalid',
              meta: baseMeta,
            };
          }

          if (!activeProbeConfig.enabled) {
            return {
              status: 'healthy',
              meta: baseMeta,
            };
          }

          const probeResult = await embeddingsActiveProbe.run(async (signal) => {
            const vector = await gateway.embed('health probe', { signal });
            if (vector.length !== gateway.dims) {
              throw new Error(
                `Embedding probe dimension mismatch: expected ${gateway.dims}, got ${vector.length}`,
              );
            }
          });
          const meta = {
            ...baseMeta,
            ...toActiveProbeMeta(activeProbeConfig, probeResult),
          };

          if (!probeResult.ok) {
            return {
              status: 'degraded',
              detail: probeResult.reason ?? 'Embeddings connectivity probe failed',
              meta,
            };
          }

          return {
            status: 'healthy',
            meta,
          };
        },
        scheduler: () => {
          const taskCount = scheduler.taskCount;
          const hasHeartbeatTask = Boolean(scheduler.getTask('heartbeat'));
          if (!hasHeartbeatTask) {
            return {
              status: 'degraded',
              detail: 'Heartbeat task is not registered',
              meta: { taskCount, ...runtimeStatusMeta },
            };
          }
          return {
            status: 'healthy',
            meta: { taskCount, ...runtimeStatusMeta },
          };
        },
        },
      }),
    ]);
    await loadChannelAdaptersFromManifest(
      apiChannelRegistry,
      apiChannelManifest,
      () => undefined,
      log,
      eligibilityGate,
    );
    apiServer = requireChannelAdapter<ApiServer>(apiChannelRegistry, 'api');
    await apiServer.start();
    log.info(`API server listening on port ${apiPort}`);
  }

  // Model discovery (if LiteLLM is configured)
  const litellmBaseUrl = process.env.LITELLM_BASE_URL;
  const modelDiscovery = litellmBaseUrl
    ? new ModelDiscovery(litellmBaseUrl, process.env.LITELLM_API_KEY, {
      openRouterModelsApiUrl: config.openRouterModelsApiUrl ?? '',
      fetchFn: createGatewayBackedDiscoveryFetch(gateway),
      allowDirectNetworkEgress: false,
    })
    : null;

  // ── Admin GUI (optional) ──

  let adminServer: AdminServer | undefined;
  if (adminPort) {
    const adminToken = process.env.ADMIN_TOKEN || undefined;
    const allowInsecureWithoutToken = isExplicitTrue(process.env.ADMIN_ALLOW_INSECURE);
    const confirmationQueueApi = {
      listConfirmationQueue: async () => {
        const [gatewayList, localEntries] = await Promise.all([
          gateway.listConfirmationQueue(),
          Promise.resolve(cardProposalQueue.listPending()),
        ]);
        return {
          entries: [...localEntries, ...gatewayList.entries]
            .sort((a, b) => a.requestedAt - b.requestedAt),
        };
      },
      resolveConfirmationQueue: async (params: { id: string; decision: 'approve' | 'deny' | 'modify'; modifiedParams?: Record<string, unknown> }) => {
        if (cardProposalQueue.getPending(params.id)) {
          return cardProposalQueue.resolve(params);
        }
        return gateway.resolveConfirmationQueue(params);
      },
    };
    adminServer = new AdminServer({
      port: adminPort,
      host: adminHost,
      token: adminToken,
      allowInsecureWithoutToken,
      apiBaseUrl: process.env.API_BASE_URL,
      apiHost,
      apiPort,
      memoryStore,
      sessionStore,
      sessionManager,
      scheduler,
      shardManager,
      eventBus,
      characterCard: card,
      config,
      embeddingService: gateway,
      modelDiscovery,
      contactStore,
      promptStore,
      promptRegistry,
      skillsRuntime,
      confirmationQueueApi,
      cardVersionStore,
      adaptiveToolsStateProvider: agentLoop,
    });
    await adminServer.init();
    await adminServer.start();
    log.info(`Admin GUI listening on port ${adminPort}`);
  }

  // ── Lifecycle notifier + tools ──

  const startTime = Date.now();
  const heartbeatChannelId = process.env.DISCORD_HEARTBEAT_CHANNEL;
  const gatewaySender: MessageSender = {
    send: (channelId, content) => gateway.discordSend(channelId, content),
  };
  const lifecycleNotifier = new DiscordLifecycleNotifier({
    sender: gatewaySender,
    heartbeatChannelId,
    dataDir: companionDataDir,
    startTime,
  });

  stopFn = async () => {
    if (stopPromise) {
      await stopPromise;
      return;
    }

    shuttingDown = true;
    stopPromise = (async () => {
      await runShutdownStep('unregister gateway disconnect hook', () => unregisterGatewayDisconnect());
      await runShutdownStep('emit system.shutdown event', () => eventBus.emit('system.shutdown', {}));
      await runShutdownStep('stop debug observer', () => stopDebugObserver());
      await runShutdownStep('stop scheduler', () => scheduler.stop());

      const timeoutMs = parsePositiveIntEnv(
        process.env.EXTRACTION_DRAIN_TIMEOUT_MS,
        DEFAULT_EXTRACTION_DRAIN_TIMEOUT_MS,
      );
      await runShutdownStep('drain memory extractor', async () => {
        const drained = await memoryExtractor.stop({ timeoutMs });
        if (!drained) {
          log.warn('Proceeding with shutdown before extraction drain completed', { timeoutMs });
        }
      });

      await runShutdownStep('write graceful shutdown markers', () => {
        const markedChannels = sessionStore.markGracefulShutdownForActiveChannels();
        if (markedChannels.length > 0) {
          log.info('Wrote graceful shutdown markers', { channels: markedChannels });
        }
      });
      await runShutdownStep('shutdown module loader', () => moduleLoader.shutdown());
      await runShutdownStep('stop API server', () => apiServer?.stop());
      await runShutdownStep('stop admin server', () => adminServer?.stop());
      await runShutdownStep('destroy gateway client', () => gateway.destroy());
      await runShutdownStep('close database', () => {
        db.close();
      });
      log.info('Stopped');
    })();

    await stopPromise;
  };

  agentLoop.registerTool(createRestartTool(
    lifecycleNotifier,
    stopFn,
    {
      restartSafeguard: lifecycleRestartSafeguard,
      getCapabilityTier: () => capabilityRuntime.getTier(),
      restartCommand: lifecycleRuntimeContract.restart.command,
      runtimeMode: lifecycleRuntimeContract.mode,
    },
  ));
  agentLoop.registerTool(createRebuildTool(
    lifecycleNotifier,
    stopFn,
    {
      restartSafeguard: lifecycleRestartSafeguard,
      getCapabilityTier: () => capabilityRuntime.getTier(),
      restartCommand: lifecycleRuntimeContract.restart.command,
      runtimeMode: lifecycleRuntimeContract.mode,
    },
  ));
  agentLoop.registerTool(createNotifyOperatorTool(
    createGatewayNtfyNotifier(gateway),
    {
      rateLimiter: externalRateLimiter,
      defaultChannel: 'discord',
    },
  ));

  // Vault auto-publisher (for heartbeat reflections → Obsidian vault)
  let vaultAutoPublisher: import('./vault/auto-publish.js').VaultAutoPublisher | undefined;
  if (config.obsidianAutoPublish && config.obsidianVaultName) {
    const { GatewayVaultOps } = await import('./vault/gateway-ops.js');
    const { VaultAutoPublisher } = await import('./vault/auto-publish.js');
    const vaultOps = new GatewayVaultOps(gateway, {
      vaultName: config.obsidianVaultName,
      cliPath: config.obsidianCliPath,
      timeoutMs: config.obsidianTimeoutMs,
    });
    vaultAutoPublisher = new VaultAutoPublisher(vaultOps);
    log.info('Vault auto-publish enabled for reflections');
  }

  // Heartbeat reflections — policy-driven multi-template reflection system
  wireHeartbeatRuntime(
    agentLoop,
    scheduler,
    agentLoop,
    gatewaySender,
    companionDataDir,
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
      onIntentionConcernDecision: intentionAppraisalHooks.onIntentionConcernDecision,
      onBehavioralPatternOutcome: intentionBehavioralHooks.onBehavioralPatternOutcome,
      coreMemoryStore,
      postTurnActions,
      ...(vaultAutoPublisher ? { vaultAutoPublisher } : {}),
    },
  );

  const trackSessionActivity = (message: SubstrateMessage): void => {
    const sessionId = sessionManager.resolveSessionChannelId(message.channelId);
    writeLastActiveSession(companionDataDir, {
      sessionId,
      channelType: inferSessionChannelType(sessionId) ?? message.channelType,
      timestamp: message.timestamp instanceof Date
        ? message.timestamp.getTime()
        : Date.now(),
    });
  };

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
