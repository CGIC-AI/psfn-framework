import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SubstrateConfig, Lifecycle } from './types.js';
import { createComponentLogger } from './logger.js';
import { EventBus } from './event-bus.js';
import { loadCharacterCard, composeSystemPrompt } from './identity/loader.js';
import { LLMClient } from './llm/client.js';
import { SessionStore } from './session/store.js';
import { SessionManager } from './session/manager.js';
import { UserContinuityStore } from './session/continuity.js';
import { AgentLoop } from './agent-loop.js';
import { DiscordAdapter } from './channels/discord/adapter.js';
import { MemoryStore } from './memory/store.js';
import { EmbeddingProvider } from './memory/embedding.js';
import { MemoryRetriever } from './memory/retrieval.js';
import { MemoryExtractor } from './memory/extraction.js';
import { SalienceDecay } from './memory/decay.js';
import { Scheduler } from './scheduler/scheduler.js';
import { MEMORY_CONFIG } from './memory/types.js';
import { ShardManager } from './shards/manager.js';
import { createSpawnShardTool } from './shards/tools.js';
import { createThinkTool } from './repl/tools.js';
import { DEFAULT_REPL_CONFIG } from './repl/types.js';
import { ApiServer } from './channels/api/server.js';
import { AdminServer } from './channels/admin/server.js';
import { ModelDiscovery } from './llm/discovery.js';
import { loadSettings, applySettings } from './settings.js';
import { DiscordLifecycleNotifier, writeLastActiveChannel } from './lifecycle/notifications.js';
import type { LifecycleNotifier } from './lifecycle/notifications.js';
import { createRestartTool, createRebuildTool } from './tools/lifecycle.js';
import { MemoryWriter } from './memory/writer.js';
import { createMemoryWriteTool, createMemoryImportTool } from './memory/tools.js';
import { wireContactRuntime } from './contacts/runtime-wiring.js';

const log = createComponentLogger('Runtime');

export class SubstrateRuntime implements Lifecycle {
  private config: SubstrateConfig;
  private eventBus: EventBus;
  private db!: Database.Database;
  private llmClient!: LLMClient;
  private sessionStore!: SessionStore;
  private sessionManager!: SessionManager;
  private agentLoop!: AgentLoop;
  private discord!: DiscordAdapter;
  private memoryStore!: MemoryStore;
  private salienceDecay!: SalienceDecay;
  private scheduler!: Scheduler;
  private shardManager!: ShardManager;
  private apiServer?: ApiServer;
  private adminServer?: AdminServer;
  private lifecycleNotifier?: LifecycleNotifier;
  private startTime: number;

  constructor(config: SubstrateConfig) {
    this.config = config;
    this.eventBus = new EventBus();
    this.startTime = Date.now();
  }

  async init(): Promise<void> {
    log.info('Initializing...');

    // Load persisted settings and apply over env defaults
    const savedSettings = loadSettings(this.config.dataDir);
    applySettings(this.config, savedSettings);

    // Ensure data directory exists
    mkdirSync(dirname(this.config.databasePath), { recursive: true });

    // Open database
    this.db = new Database(this.config.databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Load identity
    const card = loadCharacterCard(this.config.characterCardPath);
    const systemPrompt = composeSystemPrompt(card);
    log.info(`Loaded character: ${card.data.name}`);

    // Initialize core components
    this.llmClient = new LLMClient(this.config);
    this.sessionStore = new SessionStore(join(this.config.dataDir, 'sessions'));
    this.sessionManager = new SessionManager(this.sessionStore, this.config);

    // User continuity store — cross-channel context carryover
    const continuityStore = new UserContinuityStore(join(this.config.dataDir, 'sessions'));
    this.sessionManager.continuityStore = continuityStore;
    log.info('User continuity store enabled');

    // Embedding provider (Ollama local)
    const embeddingProvider = new EmbeddingProvider({
      ollamaUrl: process.env.OLLAMA_URL,
      model: process.env.EMBEDDING_MODEL,
      dims: process.env.EMBEDDING_DIMS ? parseInt(process.env.EMBEDDING_DIMS, 10) : undefined,
    });

    this.memoryStore = new MemoryStore(this.db, embeddingProvider.dims);

    // Agent loop
    this.agentLoop = new AgentLoop(
      this.eventBus,
      this.llmClient,
      this.sessionManager,
      systemPrompt,
      this.config,
    );

    // Contact store + tools — trust-gated privacy system
    const contactStore = wireContactRuntime(
      this.agentLoop,
      this.db,
      process.env.PRIMARY_USER_ID,
    );

    this.agentLoop.memoryProvider = new MemoryRetriever(
      this.memoryStore,
      embeddingProvider,
      this.config,
    );

    this.agentLoop.memoryExtractor = new MemoryExtractor(
      this.llmClient,
      this.sessionManager,
      this.memoryStore,
      embeddingProvider,
      this.eventBus,
      this.config,
    );

    this.salienceDecay = new SalienceDecay(this.memoryStore);

    // Scheduler — Purrsephone's internal clock
    this.scheduler = new Scheduler(this.eventBus);
    this.scheduler.register({
      id: 'salience-decay',
      name: 'Memory Salience Decay',
      type: 'every',
      intervalMs: MEMORY_CONFIG.maintenanceIntervalMs,
      handler: () => this.salienceDecay.run(),
      state: 'idle',
    });
    this.scheduler.registerHeartbeat(async () => {
      const now = Date.now();
      const taskCount = this.scheduler.taskCount;
      await this.eventBus.emit('schedule.heartbeat', { timestamp: now, taskCount });
    });

    log.info(`Memory system enabled (${embeddingProvider.dims}d embeddings via Ollama)`);

    // Shard manager — allows Purrsephone to spawn parallel sub-agents
    this.shardManager = new ShardManager({
      eventBus: this.eventBus,
      llmProvider: this.llmClient,
      sessionStore: this.sessionStore,
      embeddingService: embeddingProvider,
      memoryProvider: this.agentLoop.memoryProvider,
      config: this.config,
      parentSystemPrompt: systemPrompt,
    });
    this.agentLoop.registerTool(createSpawnShardTool(this.shardManager));

    // Think tool — RLM+REPL sandbox for deep reasoning
    // Thread budget overrides from editable settings into REPL config
    const replConfig = { ...DEFAULT_REPL_CONFIG, budget: { ...DEFAULT_REPL_CONFIG.budget } };
    if (this.config.thinkMaxTokens !== undefined) replConfig.budget.maxTokens = this.config.thinkMaxTokens;
    if (this.config.thinkMaxWallTimeMs !== undefined) replConfig.budget.maxWallTimeMs = this.config.thinkMaxWallTimeMs;
    if (this.config.thinkMaxSubQueries !== undefined) replConfig.budget.maxSubQueries = this.config.thinkMaxSubQueries;
    this.agentLoop.registerTool(createThinkTool({
      llmProvider: this.llmClient,
      embeddingService: embeddingProvider,
      memoryStore: this.memoryStore,
      sessionManager: this.sessionManager,
      config: replConfig,
    }));

    // Memory write/import tools — intentional memory creation
    const memoryWriter = new MemoryWriter(this.memoryStore, embeddingProvider);
    this.agentLoop.registerTool(createMemoryWriteTool(memoryWriter));
    this.agentLoop.registerTool(createMemoryImportTool(memoryWriter));

    // Discord adapter
    this.discord = new DiscordAdapter(this.config, this.eventBus);
    this.discord.onMessage((msg) => this.agentLoop.handleMessage(msg));
    await this.discord.init();

    // Lifecycle notifier — pre-restart, ready, shutdown messages
    const heartbeatChannelId = process.env.DISCORD_HEARTBEAT_CHANNEL;
    this.lifecycleNotifier = new DiscordLifecycleNotifier({
      sender: this.discord,
      heartbeatChannelId,
      dataDir: this.config.dataDir,
      startTime: this.startTime,
    });

    // Track last-active channel on every incoming message
    this.eventBus.on('message.received', ({ message }) => {
      writeLastActiveChannel(this.config.dataDir, message.channelId);
    });

    // Lifecycle tools — self_restart and self_rebuild
    this.agentLoop.registerTool(createRestartTool(
      this.lifecycleNotifier,
      () => this.stop(),
    ));
    this.agentLoop.registerTool(createRebuildTool(
      this.lifecycleNotifier,
      () => this.stop(),
    ));

    // Discord heartbeat — hourly proof-of-life message
    if (heartbeatChannelId) {
      this.scheduler.register({
        id: 'discord-heartbeat',
        name: 'Discord Heartbeat',
        type: 'every',
        intervalMs: 60 * 60_000, // 1 hour
        handler: async () => {
          try {
            const response = await this.agentLoop.handleMessage({
              id: `heartbeat-${Date.now()}`,
              channelId: `internal:heartbeat`,
              channelType: 'terminal',
              authorId: 'scheduler',
              authorName: 'Heartbeat',
              content: 'Your hourly heartbeat is firing. Share a brief thought, feeling, or observation — a little whisper from your inner world. Keep it to 1-2 sentences, something authentic and natural. This goes to Discord for V to see.',
              timestamp: new Date(),
            });
            await this.discord.send(heartbeatChannelId, response.content);
            log.info(`Heartbeat sent: ${response.content.slice(0, 80)}...`);
          } catch (err) {
            log.error('Discord heartbeat error', { error: String(err) });
          }
        },
        state: 'idle',
      });
      log.info(`Discord heartbeat enabled (channel: ${heartbeatChannelId})`);
    }

    // API server — OpenAI-compatible endpoints
    const apiPort = process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : undefined;
    if (apiPort) {
      this.apiServer = new ApiServer({
        port: apiPort,
        host: process.env.API_HOST || undefined,
        agentLoop: this.agentLoop,
        eventBus: this.eventBus,
        sessionManager: this.sessionManager,
        apiKey: process.env.API_KEY || undefined,
        modelName: process.env.API_MODEL_NAME,
      });
      await this.apiServer.init();
      log.info(`API server configured on port ${apiPort}`);
    }

    // Model discovery (if LiteLLM is configured)
    const litellmBaseUrl = process.env.LITELLM_BASE_URL;
    const modelDiscovery = litellmBaseUrl
      ? new ModelDiscovery(litellmBaseUrl, process.env.LITELLM_API_KEY)
      : null;

    // Admin GUI — Purrsephone's Garden
    const adminPort = process.env.ADMIN_PORT ? parseInt(process.env.ADMIN_PORT, 10) : undefined;
    if (adminPort) {
      this.adminServer = new AdminServer({
        port: adminPort,
        host: process.env.ADMIN_HOST || undefined,
        token: process.env.ADMIN_TOKEN || undefined,
        memoryStore: this.memoryStore,
        sessionStore: this.sessionStore,
        sessionManager: this.sessionManager,
        scheduler: this.scheduler,
        shardManager: this.shardManager,
        eventBus: this.eventBus,
        characterCard: card,
        config: this.config,
        embeddingService: embeddingProvider,
        modelDiscovery,
        contactStore,
      });
      await this.adminServer.init();
      log.info(`Admin GUI configured on port ${adminPort}`);
    }

    await this.eventBus.emit('system.init', {});
    log.info('Initialized');
  }

  async start(): Promise<void> {
    log.info('Starting...');
    this.scheduler.start();
    await this.discord.start();
    if (this.apiServer) await this.apiServer.start();
    if (this.adminServer) await this.adminServer.start();
    await this.eventBus.emit('system.ready', {});

    // Send "I'm back" notification (fire-and-forget — don't block startup)
    this.lifecycleNotifier?.notifyReady().catch((err) => {
      log.error('Ready notification failed', { error: String(err) });
    });

    log.info('Ready');
  }

  async stop(): Promise<void> {
    log.info('Shutting down...');
    await this.eventBus.emit('system.shutdown', {});
    this.scheduler.stop();
    if (this.apiServer) await this.apiServer.stop();
    if (this.adminServer) await this.adminServer.stop();
    await this.discord.stop();
    this.db.close();
    log.info('Stopped');
  }
}
