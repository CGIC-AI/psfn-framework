// ── Agent Container Entry Point ──
// Runs inside a --network=none container. Connects to gateway via Unix socket.
// Run: npm run agent

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from './types.js';
import type { SubstrateMessage } from './types.js';
import { createComponentLogger } from './logger.js';
import { EventBus } from './event-bus.js';
import { loadCharacterCard, composeSystemPrompt } from './identity/loader.js';
import { SessionStore } from './session/store.js';
import { SessionManager } from './session/manager.js';
import { UserContinuityStore } from './session/continuity.js';
import { AgentLoop } from './agent-loop.js';
import { MemoryStore } from './memory/store.js';
import { MemoryRetriever } from './memory/retrieval.js';
import { MemoryExtractor } from './memory/extraction.js';
import { SalienceDecay } from './memory/decay.js';
import { Scheduler } from './scheduler/scheduler.js';
import { MEMORY_CONFIG } from './memory/types.js';
import { GatewayClient } from './gateway/client.js';
import { ShardManager } from './shards/manager.js';
import { createSpawnShardTool } from './shards/tools.js';
import { createThinkTool } from './repl/tools.js';
import { DEFAULT_REPL_CONFIG } from './repl/types.js';
import { ApiServer } from './channels/api/server.js';
import { AdminServer } from './channels/admin/server.js';
import { ModelDiscovery } from './llm/discovery.js';
import { loadSettings, applySettings } from './settings.js';
import { MemoryWriter } from './memory/writer.js';
import { createMemoryWriteTool, createMemoryImportTool } from './memory/tools.js';
import { ContactStore } from './contacts/store.js';
import { createContactSetTrustTool, createContactNoteTool, createContactLookupTool, createContactListTool } from './contacts/tools.js';
import { DiscordLifecycleNotifier, writeLastActiveChannel } from './lifecycle/notifications.js';
import type { MessageSender } from './lifecycle/notifications.js';
import { createRestartTool, createRebuildTool } from './tools/lifecycle.js';

const log = createComponentLogger('Agent');
const DEFAULT_SOCKET_PATH = '/run/psfn/gateway.sock';

async function main(): Promise<void> {
  const config = loadConfig();
  const savedSettings = loadSettings(config.dataDir);
  applySettings(config, savedSettings);
  const socketPath = process.env.GATEWAY_SOCKET ?? DEFAULT_SOCKET_PATH;
  const eventBus = new EventBus();

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

  const card = loadCharacterCard(config.characterCardPath);
  const systemPrompt = composeSystemPrompt(card);
  log.info(`Loaded character: ${card.data.name}`);

  // ── Initialize local components ──

  const sessionStore = new SessionStore(join(config.dataDir, 'sessions'));
  const sessionManager = new SessionManager(sessionStore, config);

  // User continuity store — cross-channel context carryover
  const continuityStore = new UserContinuityStore(join(config.dataDir, 'sessions'));
  sessionManager.continuityStore = continuityStore;

  const memoryStore = new MemoryStore(db, gateway.dims);

  // ── Agent loop (uses gateway as LLM provider) ──

  const agentLoop = new AgentLoop(
    eventBus,
    gateway,  // GatewayClient implements LLMProvider
    sessionManager,
    systemPrompt,
    config,
  );

  // Contact store — trust-gated privacy system
  const contactStore = new ContactStore(db, process.env.PRIMARY_USER_ID);
  agentLoop.contactStore = contactStore;

  // Wire memory system (uses gateway for embeddings + LLM extraction)
  agentLoop.memoryProvider = new MemoryRetriever(memoryStore, gateway, config);
  agentLoop.memoryExtractor = new MemoryExtractor(
    gateway,  // GatewayClient implements LLMProvider
    sessionManager,
    memoryStore,
    gateway,  // GatewayClient implements EmbeddingService
    eventBus,
    config,
  );

  const salienceDecay = new SalienceDecay(memoryStore);

  // Scheduler — Purrsephone's internal clock
  const scheduler = new Scheduler(eventBus);
  scheduler.register({
    id: 'salience-decay',
    name: 'Memory Salience Decay',
    type: 'every',
    intervalMs: MEMORY_CONFIG.maintenanceIntervalMs,
    handler: () => salienceDecay.run(),
    state: 'idle',
  });
  scheduler.registerHeartbeat(async () => {
    const now = Date.now();
    await eventBus.emit('schedule.heartbeat', { timestamp: now, taskCount: scheduler.taskCount });
  });
  scheduler.start();
  log.info(`Memory system enabled (${gateway.dims}d embeddings via gateway)`);

  // Shard manager — allows Purrsephone to spawn parallel sub-agents
  const shardManager = new ShardManager({
    eventBus,
    llmProvider: gateway,
    sessionStore,
    embeddingService: gateway,
    memoryProvider: agentLoop.memoryProvider,
    config,
    parentSystemPrompt: systemPrompt,
  });
  agentLoop.registerTool(createSpawnShardTool(shardManager));

  // Think tool — RLM+REPL sandbox for deep reasoning
  agentLoop.registerTool(createThinkTool({
    llmProvider: gateway,
    embeddingService: gateway,
    memoryStore,
    sessionManager,
    config: DEFAULT_REPL_CONFIG,
  }));

  // Memory write/import tools — intentional memory creation
  const memoryWriter = new MemoryWriter(memoryStore, gateway);
  agentLoop.registerTool(createMemoryWriteTool(memoryWriter));
  agentLoop.registerTool(createMemoryImportTool(memoryWriter));

  // Contact tools — trust level management, notes, lookup
  agentLoop.registerTool(createContactSetTrustTool(contactStore));
  agentLoop.registerTool(createContactNoteTool(contactStore));
  agentLoop.registerTool(createContactLookupTool(contactStore));
  agentLoop.registerTool(createContactListTool(contactStore));

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
    adminServer = new AdminServer({
      port: adminPort,
      host: process.env.ADMIN_HOST || undefined,
      token: process.env.ADMIN_TOKEN || undefined,
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

  const stopFn = async () => {
    await eventBus.emit('system.shutdown', {});
    scheduler.stop();
    if (apiServer) await apiServer.stop();
    if (adminServer) await adminServer.stop();
    gateway.destroy();
    db.close();
  };

  agentLoop.registerTool(createRestartTool(lifecycleNotifier, stopFn));
  agentLoop.registerTool(createRebuildTool(lifecycleNotifier, stopFn));

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
    await eventBus.emit('system.shutdown', {});
    scheduler.stop();
    if (apiServer) await apiServer.stop();
    if (adminServer) await adminServer.stop();
    gateway.destroy();
    db.close();
    log.info('Stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('Fatal error', { error: String(err) });
  process.exit(1);
});
