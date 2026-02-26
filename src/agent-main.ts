// ── Agent Container Entry Point ──
// Runs inside a --network=none container. Connects to gateway via Unix socket.
// Run: npm run agent

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from './types.js';
import type { SubstrateMessage } from './types.js';
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
import { loadSettings, applySettings } from './settings.js';
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
import { MemoryWriter } from './memory/writer.js';
import {
  createMemoryWriteTool,
  createMemoryImportTool,
  createMemoryDeleteTool,
  createUndoMemoryDeleteTool,
} from './memory/tools.js';
import { wireContactRuntime } from './contacts/runtime-wiring.js';
import { registerGitTools } from './git/runtime-wiring.js';
import { GatewayGitOps } from './git/gateway-ops.js';
import { DiscordLifecycleNotifier, writeLastActiveChannel } from './lifecycle/notifications.js';
import type { MessageSender } from './lifecycle/notifications.js';
import { createRestartTool, createRebuildTool } from './tools/lifecycle.js';
import { createGatewayNtfyNotifier, createNotifyOperatorTool } from './tools/ntfy.js';
import { attachTerminalDebugObserver } from './debug/terminal-observer.js';
import { wireSkillsRuntime } from './skills/runtime-wiring.js';
import {
  composeIdentity,
  composeSessionRuntime,
  composeAgentLoop,
  wireMemoryRuntime,
  wireShardAndThinkRuntime,
} from './bootstrap/composition.js';
import {
  wirePromptRuntime,
  wireCharacterCardRuntime,
  wireStaticPromptRegistry,
  wireSettingsRuntime,
  buildReplConfig,
  wireHeartbeatRuntime,
} from './bootstrap/parity.js';
import { resolveAdminChatApiBaseUrl } from './channels/admin/chat/api-base-url.js';
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

const log = createComponentLogger('Agent');
const DEFAULT_SOCKET_PATH = DEFAULT_GATEWAY_SOCKET_PATH;
const DEFAULT_EXTRACTION_DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_API_REQUEST_TIMEOUT_MS = 90_000;
const NETWORK_ISOLATION_PROBE_URL = 'http://1.1.1.1/cdn-cgi/trace';
const NETWORK_ISOLATION_PROBE_TIMEOUT_MS = 2_000;

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isExplicitTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
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
  const modelsConfig = loadModelsConfig(config.dataDir, {
    defaultContextWindow: config.defaultContextWindow,
  });
  applySettings(config, modelsConfig);
  const trustPolicyConfig = loadTrustPolicyConfig(config.dataDir, {
    seedDir: process.env.CONFIG_DIR,
  });
  setRuntimeTrustPolicy(trustPolicyConfig);
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
  const socketPath = process.env.GATEWAY_SOCKET ?? DEFAULT_SOCKET_PATH;
  const eventBus = new EventBus();
  const stopDebugObserver = attachTerminalDebugObserver(eventBus, { scope: 'agent' });

  log.info('Initializing...');
  await enforceNetworkIsolationOnStartup();

  // ── Connect to gateway ──

  const embeddingDims = process.env.EMBEDDING_DIMS
    ? parseInt(process.env.EMBEDDING_DIMS, 10)
    : 1024;

  log.info(`Connecting to gateway at ${socketPath}...`);
  const gateway = await GatewayClient.connect(socketPath, embeddingDims);
  log.info('Connected to gateway');

  // ── Local SQLite database (sessions + memory) ──

  mkdirSync(dirname(config.databasePath), { recursive: true });
  const db = new Database(config.databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runDatabaseIntegrityCheck(db);
  log.info('SQLite integrity check passed');

  // ── Load identity (mounted read-only in container) ──

  const { card, systemPrompt } = composeIdentity(config);
  const cardVersionStore = new CharacterCardVersionStore(
    config.characterCardPath,
    join(config.dataDir, 'character-card-history.jsonl'),
  );
  const cardProposalQueue = new ConfirmationQueue({
    idFactory: () => `card-${randomUUID()}`,
  });
  log.info(`Loaded character: ${card.data.name}`);
  const promptRegistry = wireStaticPromptRegistry(config.dataDir);

  // ── Initialize local components ──

  const sessionsDir = join(config.dataDir, 'sessions');
  const sessionComposition = composeSessionRuntime({
    config,
    eventBus,
    sessionsDir,
    enableContinuity: true,
    promptRegistry,
    sessionIntegrityProvider: gateway.createSessionIntegrityProvider(),
  });
  const { sessionStore, sessionManager } = sessionComposition;

  const memoryStore = new MemoryStore(db, gateway.dims);
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

  const agentLoop = composeAgentLoop({
    eventBus,
    llmProvider: gateway,
    sessionManager,
    systemPrompt,
    characterName: card.data.name,
    config,
  });
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

  // Contact store + tools — trust-gated privacy system
  const contactStore = wireContactRuntime(
    agentLoop,
    db,
    process.env.PRIMARY_USER_ID ?? process.env.DISCORD_VOICE_USER_ID,
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
  agentLoop.registerTool(createMemoryDeleteTool(memoryStore));
  agentLoop.registerTool(createUndoMemoryDeleteTool(memoryStore));

  // Git tools — self-modification via gateway-hosted git ops
  registerGitTools(agentLoop, new GatewayGitOps(gateway));
  log.info('Git self-modification tools enabled');

  const moduleSummary = await moduleLoader.loadEnabledModules();
  log.info('Runtime modules initialized', moduleSummary);

  // ── API server (optional) ──

  let apiServer: ApiServer | undefined;
  const apiHost = process.env.API_HOST || undefined;
  const apiPort = process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : undefined;
  const adminChatApiBaseUrl = resolveAdminChatApiBaseUrl({
    explicitApiBaseUrl: process.env.API_BASE_URL,
    apiHost,
    apiPort,
  });
  if (apiPort) {
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
            },
          };
        },
        llm: async () => {
          const configured = Boolean(config.primaryModel && config.primaryProvider);
          const baseMeta = {
            provider: config.primaryProvider ?? null,
            model: config.primaryModel ?? null,
            ...toActiveProbeMeta(activeProbeConfig),
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
        }),
        embeddings: async () => {
          const baseMeta = {
            dims: gateway.dims,
            ...toActiveProbeMeta(activeProbeConfig),
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
              meta: { taskCount },
            };
          }
          return {
            status: 'healthy',
            meta: { taskCount },
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
  const adminPort = process.env.ADMIN_PORT ? parseInt(process.env.ADMIN_PORT, 10) : undefined;
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
      apiBaseUrl: adminChatApiBaseUrl,
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

  let shuttingDown = false;
  const stopFn = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
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
    },
  ));
  agentLoop.registerTool(createRebuildTool(
    lifecycleNotifier,
    stopFn,
    {
      restartSafeguard: lifecycleRestartSafeguard,
      getCapabilityTier: () => capabilityRuntime.getTier(),
    },
  ));
  agentLoop.registerTool(createNotifyOperatorTool(
    createGatewayNtfyNotifier(gateway),
    {
      rateLimiter: externalRateLimiter,
      defaultChannel: 'discord',
    },
  ));

  // Heartbeat reflections — policy-driven multi-template reflection system
  wireHeartbeatRuntime(
    agentLoop,
    scheduler,
    agentLoop,
    gatewaySender,
    config.dataDir,
    heartbeatChannelId,
  );

  // ── Register reverse RPC handler for voice messages from gateway ──

  gateway.onHandleMessage(async (message: SubstrateMessage) => {
    writeLastActiveChannel(config.dataDir, message.channelId);
    log.info(`Voice message from ${message.authorName}: ${message.content.slice(0, 50)}...`);
    return agentLoop.handleMessage(message);
    // Note: no discord.send() — gateway voice runtime handles TTS directly
  });

  // ── Listen for Discord messages from gateway ──

  gateway.onDiscordMessage(async (message: SubstrateMessage) => {
    // Deserialize Date if it came as string
    if (typeof message.timestamp === 'string') {
      message.timestamp = new Date(message.timestamp);
    }

    // Track last-active channel for lifecycle notifications
    writeLastActiveChannel(config.dataDir, message.channelId);

    log.info(`Message from ${message.authorName}: ${message.content.slice(0, 50)}...`);

    try {
      const response = await agentLoop.handleMessage(message);

      // Send response back through gateway → Discord
      await gateway.discordSend(message.channelId, response.content);
    } catch (err) {
      log.error('Error handling message', { error: String(err) });
      try {
        await gateway.discordSend(message.channelId, 'Something went wrong. Please try again.');
      } catch { /* ignore send errors */ }
    }
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
