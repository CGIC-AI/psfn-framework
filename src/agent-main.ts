// ── Agent Container Entry Point ──
// Runs inside a --network=none container. Connects to gateway via Unix socket.
// Run: npm run agent

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig } from './types.js';
import type {
  SubstrateConfig,
  SubstrateMessage,
} from './types.js';
import { createComponentLogger } from './logger.js';
import { EventBus } from './event-bus.js';
import { MemoryStore } from './memory/store.js';
import { SalienceDecay } from './memory/decay.js';
import { Scheduler } from './scheduler/scheduler.js';
import { GatewayClient } from './gateway/client.js';
import { DEFAULT_GATEWAY_SOCKET_PATH } from './security/policy-constants.js';
import { ApiServer } from './channels/api/server.js';
import {
  CachedActiveHealthProbe,
  resolveActiveHealthProbeConfig,
  toActiveProbeMeta,
} from './channels/api/active-health-probe.js';
import { AdminServer } from './channels/admin/server.js';
import { ModelDiscovery } from './llm/discovery.js';
import { loadSettings, saveSettings, applySettings } from './settings.js';
import { loadModelsConfig } from './config/models-config.js';
import { resolveRuntimeSchedulerConfig } from './config/scheduler-runtime.js';
import { loadTrustPolicyConfig } from './config/trust-policy-config.js';
import { setRuntimeTrustPolicy } from './trust/runtime-policy.js';
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
import {
  createMemoryWriteTool,
  createMemoryImportTool,
  createMemoryRedactTool,
  createMemoryDeleteTool,
  createUndoMemoryDeleteTool,
  createScratchpadReadTool,
  createScratchpadWriteTool,
} from './memory/tools.js';
import { wireContactRuntime } from './contacts/runtime-wiring.js';
import { registerGitTools } from './git/runtime-wiring.js';
import { GatewayGitOps } from './git/gateway-ops.js';
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
  composeIdentity,
  composeSessionRuntime,
  composeSubstrateAgent,
  wireMemoryRuntime,
  wireShardAndThinkRuntime,
} from './bootstrap/composition.js';
import {
  wirePromptRuntime,
  wireCharacterCardRuntime,
  wireStaticPromptRegistry,
  wireSettingsRuntime,
  wireSessionToolsRuntime,
  buildReplConfig,
  wireHeartbeatRuntime,
} from './bootstrap/parity.js';
import { wirePostTurnActionRuntime } from './bootstrap/post-turn-actions.js';
import { CapabilityRuntime } from './capabilities/runtime.js';
import {
  createSafeguardAuditTrail,
  createIdentityCoolingOffManagerFromEnv,
  createLifecycleRestartSafeguardFromEnv,
  createExternalCommunicationRateLimiterFromEnv,
} from './capabilities/safeguards.js';
import { ConfirmationQueue } from './capabilities/confirmation-queue.js';
import { CharacterCardVersionStore } from './identity/card-versioning.js';
import { ModuleLoader } from './modules/loader.js';
import { DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE } from './agent/tool-wiring-validator.js';
import { registerGatewayMessageHandlers } from './agent-main/gateway-message-handlers.js';
import {
  resolveContactsDir,
  resolveNotesDir,
  resolveScratchpadMirrorPath,
  resolveSessionsDir,
} from './persistence/layout.js';

const log = createComponentLogger('Agent');
const DEFAULT_SOCKET_PATH = DEFAULT_GATEWAY_SOCKET_PATH;
const DEFAULT_EXTRACTION_DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_API_REQUEST_TIMEOUT_MS = 90_000;
const NETWORK_ISOLATION_PROBE_URL = 'http://1.1.1.1/cdn-cgi/trace';
const NETWORK_ISOLATION_PROBE_TIMEOUT_MS = 2_000;

function isExplicitTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function parseCommaSeparatedEnv(value: string | undefined): string[] {
  if (!value) return [];
  const entries = value
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  return [...new Set(entries)];
}

function installPromotedToolsPersistenceHook(config: SubstrateConfig): void {
  const existingHooks = config.runtimeHooks ?? {};
  config.runtimeHooks = {
    ...existingHooks,
    persistPromotedExtendedTools: (toolNames) => {
      const current = loadSettings(config.dataDir);
      saveSettings(config.dataDir, {
        ...current,
        promotedExtendedTools: [...toolNames],
      });
    },
  };
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
  const savedSettings = loadSettings(config.dataDir);
  applySettings(config, savedSettings);
  installPromotedToolsPersistenceHook(config);
  const modelsConfig = loadModelsConfig(config.dataDir, {
    defaultContextWindow: config.defaultContextWindow,
  });
  applySettings(config, modelsConfig);
  const trustPolicyConfig = loadTrustPolicyConfig(config.dataDir, {
    seedDir: process.env.CONFIG_DIR,
  });
  setRuntimeTrustPolicy(trustPolicyConfig);
  log.info('Loaded trust policy configuration', {
    exactOverrideCount: Object.keys(
      trustPolicyConfig.channelClassification.visibilityOverrides.exact,
    ).length,
    prefixOverrideCount: Object.keys(
      trustPolicyConfig.channelClassification.visibilityOverrides.prefix,
    ).length,
  });
  const schedulerConfig = resolveRuntimeSchedulerConfig({
    dataDir: config.dataDir,
    seedDir: process.env.CONFIG_DIR,
  });
  const backupConfig = resolveBackupRuntimeConfig({
    dataDir: config.dataDir,
  });
  config.maintenanceIntervalMs = schedulerConfig.salienceDecayIntervalMs;
  const capabilityRuntime = new CapabilityRuntime({
    dataDir: config.dataDir,
    seedDir: process.env.CONFIG_DIR,
    envTier: config.capabilityTier,
  });
  config.capabilityTier = capabilityRuntime.getTier();
  const lifecycleRuntimeContract = resolveRuntimeModeContract({
    entrypoint: RUNTIME_MODE.GATEWAY_AGENT,
    runtimeModeEnv: process.env.PSFN_RUNTIME_MODE,
    restartCommandEnv: process.env.LIFECYCLE_RESTART_COMMAND,
  });
  const runtimeStatusMeta = toRuntimeStatusMetadata(lifecycleRuntimeContract);
  const socketPath = process.env.GATEWAY_SOCKET ?? DEFAULT_SOCKET_PATH;
  const eventBus = new EventBus();
  const stopDebugObserver = attachTerminalDebugObserver(eventBus, { scope: 'agent' });

  log.info('Initializing...');
  log.info('Lifecycle runtime contract resolved', runtimeStatusMeta);
  await enforceNetworkIsolationOnStartup();

  // ── Connect to gateway ──

  const embeddingDims = parsePositiveIntEnv(process.env.EMBEDDING_DIMS, 1024);

  log.info(`Connecting to gateway at ${socketPath}...`);
  const gateway = await GatewayClient.connect(socketPath, embeddingDims);
  log.info('Connected to gateway');
  let shuttingDown = false;
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
    join(config.dataDir, 'character-card-history.jsonl'),
  );
  const cardProposalQueue = new ConfirmationQueue({
    idFactory: () => `card-${randomUUID()}`,
  });
  log.info(`Loaded character: ${card.data.name}`);
  config.characterName = card.data.name;
  const promptRegistry = wireStaticPromptRegistry(config.dataDir);

  // ── Initialize local components ──

  const sessionsDir = resolveSessionsDir(config.dataDir);
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
    writeLastActiveSession(config.dataDir, startupSession);
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
    notesDir: resolveNotesDir(config.dataDir),
    scratchpadMirrorPath: resolveScratchpadMirrorPath(config.dataDir),
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

  const agentLoop = composeSubstrateAgent({
    eventBus,
    llmProvider: gateway,
    sessionManager,
    systemPrompt,
    characterName: card.data.name,
    config,
  });
  agentLoop.scratchpadProvider = memoryStore;
  agentLoop.setCapabilityRuntime(capabilityRuntime);
  const safeguardAuditTrail = createSafeguardAuditTrail(config.dataDir);
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
    dataDir: config.dataDir,
    seedDir: process.env.CONFIG_DIR,
    repoRoot: process.cwd(),
  });

  // Prompt stack — layered, editable system prompt
  const promptStore = wirePromptRuntime(agentLoop, config.dataDir, systemPrompt, {
    identityCoolingOff,
    getCapabilityTier: () => capabilityRuntime.getTier(),
  });
  wireCharacterCardRuntime(agentLoop, cardVersionStore, {
    getCapabilityTier: () => capabilityRuntime.getTier(),
    confirmationQueue: cardProposalQueue,
  });
  wireSettingsRuntime(agentLoop, config);
  wireSessionToolsRuntime(agentLoop, sessionManager, config.dataDir);

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
      exportDir: resolveContactsDir(config.dataDir),
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

  // Wire memory system (uses gateway for embeddings + LLM extraction)
  const memoryExtractor = wireMemoryRuntime({
    agentLoop,
    llmProvider: gateway,
    sessionManager,
    memoryStore,
    embeddingService: gateway,
    eventBus,
    config,
    promptRegistry,
  });

  const salienceDecay = new SalienceDecay(memoryStore);

  // Scheduler — Purrsephone's internal clock
  const scheduler = new Scheduler(eventBus, {
    tickIntervalMs: schedulerConfig.tickIntervalMs,
    heartbeatIntervalMs: schedulerConfig.heartbeatIntervalMs,
  });
  scheduler.register({
    id: 'salience-decay',
    name: 'Memory Salience Decay',
    type: 'every',
    intervalMs: config.maintenanceIntervalMs,
    handler: () => salienceDecay.run(),
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
  });
  scheduler.start();
  log.info(`Memory system enabled (${gateway.dims}d embeddings via gateway)`);

  const moduleLoader = new ModuleLoader({
    eventBus,
    registerTool: (tool, category) => agentLoop.registerTool(tool, category),
  });

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
    moduleInstallConfirmationQueue: cardProposalQueue,
    onModuleRegistryMutation: async (mutation) => {
      await moduleLoader.applyRegistryMutation(mutation);
    },
  });

  // Memory write/import tools — intentional memory creation
  const memoryWriter = new MemoryWriter(memoryStore, gateway);
  agentLoop.registerTool(createMemoryWriteTool(memoryWriter));
  agentLoop.registerTool(createMemoryImportTool(memoryWriter));
  agentLoop.registerTool(createMemoryRedactTool(memoryWriter));
  agentLoop.registerTool(createMemoryDeleteTool(memoryStore));
  agentLoop.registerTool(createUndoMemoryDeleteTool(memoryStore));
  agentLoop.registerTool(createScratchpadReadTool(memoryStore));
  agentLoop.registerTool(createScratchpadWriteTool(memoryStore));

  // Git tools — self-modification via gateway-hosted git ops
  registerGitTools(agentLoop, new GatewayGitOps(gateway), { gatewayMode: true });
  log.info('Git self-modification tools enabled');

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
  if (apiPort) {
    const allowInsecureWithoutAuth = isExplicitTrue(process.env.ALLOW_INSECURE_LOCAL_API);
    const corsAllowedOrigins = parseCommaSeparatedEnv(process.env.API_CORS_ALLOWLIST);
    const activeProbeConfig = resolveActiveHealthProbeConfig(process.env);
    const llmActiveProbe = new CachedActiveHealthProbe(activeProbeConfig);
    const embeddingsActiveProbe = new CachedActiveHealthProbe(activeProbeConfig);
    apiServer = new ApiServer({
      port: apiPort,
      host: apiHost,
      agentLoop,
      eventBus,
      sessionManager,
      contactStore,
      apiKey: process.env.API_KEY || undefined,
      allowInsecureWithoutAuth,
      corsAllowedOrigins,
      modelName: process.env.API_MODEL_NAME,
      requestTimeoutMs: parsePositiveIntEnv(
        process.env.API_REQUEST_TIMEOUT_MS,
        DEFAULT_API_REQUEST_TIMEOUT_MS,
      ),
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
            provider: config.primaryProvider ?? null,
            model: config.primaryModel ?? null,
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
    });
    await apiServer.init();
    await apiServer.start();
    log.info(`API server listening on port ${apiPort}`);
  }

  // Model discovery (if LiteLLM is configured)
  const litellmBaseUrl = process.env.LITELLM_BASE_URL;
  const modelDiscovery = litellmBaseUrl
    ? new ModelDiscovery(litellmBaseUrl, process.env.LITELLM_API_KEY)
    : null;

  // ── Admin GUI (optional) ──

  let adminServer: AdminServer | undefined;
  const adminPort = parseOptionalPositiveIntEnv(process.env.ADMIN_PORT);
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
      host: process.env.ADMIN_HOST || undefined,
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
    dataDir: config.dataDir,
    startTime,
  });

  stopFn = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    unregisterGatewayDisconnect();
    await eventBus.emit('system.shutdown', {});
    stopDebugObserver();
    scheduler.stop();
    const timeoutMs = parsePositiveIntEnv(
      process.env.EXTRACTION_DRAIN_TIMEOUT_MS,
      DEFAULT_EXTRACTION_DRAIN_TIMEOUT_MS,
    );
    const drained = await memoryExtractor.stop({ timeoutMs });
    if (!drained) {
      log.warn('Proceeding with shutdown before extraction drain completed', { timeoutMs });
    }
    if (apiServer) await apiServer.stop();
    if (adminServer) await adminServer.stop();
    gateway.destroy();
    db.close();
    log.info('Stopped');
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
    config.dataDir,
    heartbeatChannelId,
    {
      eventBus,
      llmProvider: gateway,
      memoryWriter,
      postTurnActions,
      ...(vaultAutoPublisher ? { vaultAutoPublisher } : {}),
    },
  );

  const trackSessionActivity = (message: SubstrateMessage): void => {
    const sessionId = sessionManager.resolveSessionChannelId(message.channelId);
    writeLastActiveSession(config.dataDir, {
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

  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down...`);
    await stopFn();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('Fatal error', { error: String(err) });
  process.exit(1);
});
