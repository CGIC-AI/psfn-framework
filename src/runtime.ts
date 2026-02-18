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
import { ShardManager } from './shards/manager.js';
import { createSpawnShardTool } from './shards/tools.js';
import { createThinkTool } from './repl/tools.js';
import { ApiServer } from './channels/api/server.js';
import { createApiVoiceWebSocketRuntime } from './channels/api/voice-websocket-runtime.js';
import { AdminServer } from './channels/admin/server.js';
import { ModelDiscovery } from './llm/discovery.js';
import { loadSettings, applySettings } from './settings.js';
import { DiscordLifecycleNotifier, writeLastActiveChannel } from './lifecycle/notifications.js';
import type { LifecycleNotifier } from './lifecycle/notifications.js';
import { createRestartTool, createRebuildTool } from './tools/lifecycle.js';
import { MemoryWriter } from './memory/writer.js';
import { createMemoryWriteTool, createMemoryImportTool } from './memory/tools.js';
import { wireContactRuntime } from './contacts/runtime-wiring.js';
import { wireGitRuntime } from './git/runtime-wiring.js';
import { attachTerminalDebugObserver } from './debug/terminal-observer.js';
import {
  wirePromptRuntime,
  wireStaticPromptRegistry,
  buildReplConfig,
  wireHeartbeatRuntime,
} from './bootstrap/parity.js';
import { attachVoiceObservers } from './voice/observers/index.js';

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
  private stopVoiceObservers?: () => void;
  private stopDebugObserver?: () => void;
  private startTime: number;

  constructor(config: SubstrateConfig) {
    this.config = config;
    this.eventBus = new EventBus();
    this.stopVoiceObservers = attachVoiceObservers(this.eventBus);
    this.stopDebugObserver = attachTerminalDebugObserver(this.eventBus, { scope: 'runtime' });
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
    const promptRegistry = wireStaticPromptRegistry(this.config.dataDir);

    // Initialize core components
    this.llmClient = new LLMClient(this.config);
    this.sessionStore = new SessionStore(join(this.config.dataDir, 'sessions'));
    this.sessionManager = new SessionManager(
      this.sessionStore,
      this.config,
      this.eventBus,
      promptRegistry,
    );

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

    // Prompt stack — layered, editable system prompt
    const promptStore = wirePromptRuntime(
      this.agentLoop,
      this.config.dataDir,
      systemPrompt,
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
      promptRegistry,
    );

    this.salienceDecay = new SalienceDecay(this.memoryStore);

    // Scheduler — PSFN's internal clock
    this.scheduler = new Scheduler(this.eventBus);
    this.scheduler.register({
      id: 'salience-decay',
      name: 'Memory Salience Decay',
      type: 'every',
      intervalMs: this.config.maintenanceIntervalMs,
      handler: () => this.salienceDecay.run(),
      state: 'idle',
    });
    this.scheduler.registerHeartbeat(async () => {
      const now = Date.now();
      const taskCount = this.scheduler.taskCount;
      await this.eventBus.emit('schedule.heartbeat', { timestamp: now, taskCount });
    });

    log.info(`Memory system enabled (${embeddingProvider.dims}d embeddings via Ollama)`);

    // Shard manager — allows PSFN to spawn parallel sub-agents
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
    const replConfig = buildReplConfig(this.config);
    this.agentLoop.registerTool(createThinkTool({
      llmProvider: this.llmClient,
      embeddingService: embeddingProvider,
      memoryStore: this.memoryStore,
      sessionManager: this.sessionManager,
      scheduler: this.scheduler,
      eventBus: this.eventBus,
      config: replConfig,
    }));

    // Memory write/import tools — intentional memory creation
    const memoryWriter = new MemoryWriter(this.memoryStore, embeddingProvider);
    this.agentLoop.registerTool(createMemoryWriteTool(memoryWriter));
    this.agentLoop.registerTool(createMemoryImportTool(memoryWriter));

    // Git tools — self-modification via git
    wireGitRuntime(this.agentLoop, {
      repoRoot: process.cwd(),
      allowedPaths: ['src/', 'docs/', 'psfn/'],
    });
    log.info('Git self-modification tools enabled');

    // Discord adapter — setAgent enables steering (mid-stream message injection)
    this.discord = new DiscordAdapter(this.config, this.eventBus, {
      sessionStore: this.sessionStore,
    });
    this.discord.setAgent(this.agentLoop);
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

    // Heartbeat reflections — policy-driven multi-template reflection system
    wireHeartbeatRuntime(
      this.agentLoop,
      this.scheduler,
      this.agentLoop,
      this.discord,
      this.config.dataDir,
      heartbeatChannelId,
    );

    // API server — OpenAI-compatible endpoints
    const apiPort = process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : undefined;
    if (apiPort) {
      const voiceWebSocketRuntime = createApiVoiceWebSocketRuntime({
        agentLoop: this.agentLoop,
        eventBus: this.eventBus,
        config: this.config,
      });

      this.apiServer = new ApiServer({
        port: apiPort,
        host: process.env.API_HOST || undefined,
        agentLoop: this.agentLoop,
        eventBus: this.eventBus,
        sessionManager: this.sessionManager,
        apiKey: process.env.API_KEY || undefined,
        modelName: process.env.API_MODEL_NAME,
        voiceWebSocketRuntime,
      });
      await this.apiServer.init();
      log.info(`API server configured on port ${apiPort}`);
    }

    // Model discovery (if LiteLLM is configured)
    const litellmBaseUrl = process.env.LITELLM_BASE_URL;
    const modelDiscovery = litellmBaseUrl
      ? new ModelDiscovery(litellmBaseUrl, process.env.LITELLM_API_KEY)
      : null;

    // Admin GUI — admin UI
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
        promptStore,
        promptRegistry,
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
    this.stopVoiceObservers?.();
    this.stopVoiceObservers = undefined;
    this.stopDebugObserver?.();
    this.stopDebugObserver = undefined;
    this.scheduler.stop();
    if (this.apiServer) await this.apiServer.stop();
    if (this.adminServer) await this.adminServer.stop();
    await this.discord.stop();
    this.db.close();
    log.info('Stopped');
  }
}
