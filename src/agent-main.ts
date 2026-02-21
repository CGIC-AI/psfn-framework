// ── Agent Container Entry Point ──
// Runs inside a --network=none container. Connects to gateway via Unix socket.
// Run: npm run agent

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
import { AdminServer } from './channels/admin/server.js';
import { ModelDiscovery } from './llm/discovery.js';
import { loadSettings, applySettings } from './settings.js';
import { loadModelsConfig } from './config/models-config.js';
import { MemoryWriter } from './memory/writer.js';
import { createMemoryWriteTool, createMemoryImportTool } from './memory/tools.js';
import { wireContactRuntime } from './contacts/runtime-wiring.js';
import { registerGitTools } from './git/runtime-wiring.js';
import { GatewayGitOps } from './git/gateway-ops.js';
import { DiscordLifecycleNotifier, writeLastActiveChannel } from './lifecycle/notifications.js';
import type { MessageSender } from './lifecycle/notifications.js';
import { createRestartTool, createRebuildTool } from './tools/lifecycle.js';
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
  wireStaticPromptRegistry,
  wireSettingsRuntime,
  buildReplConfig,
  wireHeartbeatRuntime,
} from './bootstrap/parity.js';

const log = createComponentLogger('Agent');
const DEFAULT_SOCKET_PATH = DEFAULT_GATEWAY_SOCKET_PATH;
const DEFAULT_EXTRACTION_DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_API_REQUEST_TIMEOUT_MS = 90_000;

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isExplicitTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

async function main(): Promise<void> {
  const config = loadConfig();
  const savedSettings = loadSettings(config.dataDir);
  applySettings(config, savedSettings);
  const modelsConfig = loadModelsConfig(config.dataDir, {
    defaultContextWindow: config.defaultContextWindow,
  });
  applySettings(config, modelsConfig);
  const socketPath = process.env.GATEWAY_SOCKET ?? DEFAULT_SOCKET_PATH;
  const eventBus = new EventBus();
  const stopDebugObserver = attachTerminalDebugObserver(eventBus, { scope: 'agent' });

  log.info('Initializing...');

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

  // ── Load identity (mounted read-only in container) ──

  const { card, systemPrompt } = composeIdentity(config);
  log.info(`Loaded character: ${card.data.name}`);
  const promptRegistry = wireStaticPromptRegistry(config.dataDir);

  // ── Initialize local components ──

  const sessionComposition = composeSessionRuntime({
    config,
    eventBus,
    enableContinuity: true,
    promptRegistry,
  });
  const { sessionStore, sessionManager } = sessionComposition;

  const memoryStore = new MemoryStore(db, gateway.dims);

  // ── Agent loop (uses gateway as LLM provider) ──

  const agentLoop = composeAgentLoop({
    eventBus,
    llmProvider: gateway,
    sessionManager,
    systemPrompt,
    characterName: card.data.name,
    config,
  });

  const skillsRuntime = wireSkillsRuntime(agentLoop, {
    dataDir: config.dataDir,
    seedDir: process.env.CONFIG_DIR,
    repoRoot: process.cwd(),
  });

  // Prompt stack — layered, editable system prompt
  const promptStore = wirePromptRuntime(agentLoop, config.dataDir, systemPrompt);
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
  const scheduler = new Scheduler(eventBus);
  scheduler.register({
    id: 'salience-decay',
    name: 'Memory Salience Decay',
    type: 'every',
    intervalMs: config.maintenanceIntervalMs,
    handler: () => salienceDecay.run(),
    state: 'idle',
  });
  scheduler.registerHeartbeat(async () => {
    const now = Date.now();
    await eventBus.emit('schedule.heartbeat', { timestamp: now, taskCount: scheduler.taskCount });
  });
  scheduler.start();
  log.info(`Memory system enabled (${gateway.dims}d embeddings via gateway)`);

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
  });

  // Memory write/import tools — intentional memory creation
  const memoryWriter = new MemoryWriter(memoryStore, gateway);
  agentLoop.registerTool(createMemoryWriteTool(memoryWriter));
  agentLoop.registerTool(createMemoryImportTool(memoryWriter));

  // Git tools — self-modification via gateway-hosted git ops
  registerGitTools(agentLoop, new GatewayGitOps(gateway));
  log.info('Git self-modification tools enabled');

  // ── API server (optional) ──

  let apiServer: ApiServer | undefined;
  const apiPort = process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : undefined;
  if (apiPort) {
    apiServer = new ApiServer({
      port: apiPort,
      host: process.env.API_HOST || undefined,
      agentLoop,
      eventBus,
      sessionManager,
      apiKey: process.env.API_KEY || undefined,
      modelName: process.env.API_MODEL_NAME,
      requestTimeoutMs: parsePositiveIntEnv(
        process.env.API_REQUEST_TIMEOUT_MS,
        DEFAULT_API_REQUEST_TIMEOUT_MS,
      ),
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
    adminServer = new AdminServer({
      port: adminPort,
      host: process.env.ADMIN_HOST || undefined,
      token: adminToken,
      allowInsecureWithoutToken,
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

  agentLoop.registerTool(createRestartTool(lifecycleNotifier, stopFn));
  agentLoop.registerTool(createRebuildTool(lifecycleNotifier, stopFn));

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
