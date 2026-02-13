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

const log = createComponentLogger('Agent');
const DEFAULT_SOCKET_PATH = '/run/psfn/gateway.sock';

async function main(): Promise<void> {
  const config = loadConfig();
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
  const memoryStore = new MemoryStore(db, gateway.dims);

  // ── Agent loop (uses gateway as LLM provider) ──

  const agentLoop = new AgentLoop(
    eventBus,
    gateway,  // GatewayClient implements LLMProvider
    sessionManager,
    systemPrompt,
    config,
  );

  // Wire memory system (uses gateway for embeddings + LLM extraction)
  agentLoop.memoryProvider = new MemoryRetriever(memoryStore, gateway);
  agentLoop.memoryExtractor = new MemoryExtractor(
    gateway,  // GatewayClient implements LLMProvider
    sessionManager,
    memoryStore,
    gateway,  // GatewayClient implements EmbeddingService
    eventBus,
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

  // ── Listen for Discord messages from gateway ──

  gateway.onDiscordMessage(async (message: SubstrateMessage) => {
    // Deserialize Date if it came as string
    if (typeof message.timestamp === 'string') {
      message.timestamp = new Date(message.timestamp);
    }

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
  log.info('Ready — waiting for messages');

  // ── Graceful shutdown ──

  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down...`);
    await eventBus.emit('system.shutdown', {});
    scheduler.stop();
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
