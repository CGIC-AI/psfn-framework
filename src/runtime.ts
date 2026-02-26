import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SubstrateConfig, Lifecycle } from './types.js';
import { createComponentLogger } from './logger.js';
import { EventBus } from './event-bus.js';
import { composeSystemPrompt } from './identity/loader.js';
import { CharacterCardVersionStore } from './identity/card-versioning.js';
import { LLMClient } from './llm/client.js';
import { SessionStore, type CrashRecoveryExtractionCandidate } from './session/store.js';
import { SessionManager } from './session/manager.js';
import { UserContinuityStore } from './session/continuity.js';
import { AgentLoop } from './agent-loop.js';
import { DiscordAdapter } from './channels/discord/adapter.js';
import { TelegramAdapter } from './channels/telegram/adapter.js';
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
import {
  CachedActiveHealthProbe,
  resolveActiveHealthProbeConfig,
  toActiveProbeMeta,
} from './channels/api/active-health-probe.js';
import type { ChannelAdapter } from './channels/types.js';
import { createApiVoiceWebSocketRuntime } from './channels/api/voice-websocket-runtime.js';
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
import { DiscordLifecycleNotifier, writeLastActiveChannel } from './lifecycle/notifications.js';
import type { LifecycleNotifier } from './lifecycle/notifications.js';
import { createRestartTool, createRebuildTool } from './tools/lifecycle.js';
import { createHttpNtfyNotifierFromEnv, createNotifyOperatorTool } from './tools/ntfy.js';
import { MemoryWriter } from './memory/writer.js';
import {
  createMemoryWriteTool,
  createMemoryImportTool,
  createMemoryDeleteTool,
  createUndoMemoryDeleteTool,
} from './memory/tools.js';
import { wireContactRuntime } from './contacts/runtime-wiring.js';
import { wireGitRuntime } from './git/runtime-wiring.js';
import { wireSkillsRuntime } from './skills/runtime-wiring.js';
import { attachTerminalDebugObserver } from './debug/terminal-observer.js';
import {
  wirePromptRuntime,
  wireCharacterCardRuntime,
  wireStaticPromptRegistry,
  buildReplConfig,
  wireHeartbeatRuntime,
} from './bootstrap/parity.js';
import { attachVoiceObservers } from './voice/observers/index.js';
import { loadRuntimeChannelsConfig } from './channels/config.js';
import { resolveAdminChatApiBaseUrl } from './channels/admin/chat/api-base-url.js';
import { CapabilityRuntime } from './capabilities/runtime.js';
import {
  createSafeguardAuditTrail,
  createIdentityCoolingOffManagerFromEnv,
  createLifecycleRestartSafeguardFromEnv,
  createExternalCommunicationRateLimiterFromEnv,
} from './capabilities/safeguards.js';
import { ConfirmationQueue } from './capabilities/confirmation-queue.js';
import { ModuleLoader } from './modules/loader.js';

const log = createComponentLogger('Runtime');
const DEFAULT_EXTRACTION_DRAIN_TIMEOUT_MS = 10_000;

export class SubstrateRuntime implements Lifecycle {
  private config: SubstrateConfig;
  private eventBus: EventBus;
  private db!: Database.Database;
  private llmClient!: LLMClient;
  private sessionStore!: SessionStore;
  private sessionManager!: SessionManager;
  private memoryExtractor!: MemoryExtractor;
  private agentLoop!: AgentLoop;
  private discord!: DiscordAdapter;
  private memoryStore!: MemoryStore;
  private salienceDecay!: SalienceDecay;
  private scheduler!: Scheduler;
  private shardManager!: ShardManager;
  private channelRegistry = new Map<string, ChannelAdapter>();
  private capabilityRuntime!: CapabilityRuntime;
  private moduleLoader?: ModuleLoader;
  private adminServer?: AdminServer;
  private lifecycleNotifier?: LifecycleNotifier;
  private stopVoiceObservers?: () => void;
  private stopDebugObserver?: () => void;
  private crashRecoveryQueue: CrashRecoveryExtractionCandidate[] = [];
  private stopping = false;
  private startTime: number;

  constructor(config: SubstrateConfig) {
    this.config = config;
    this.eventBus = new EventBus();
    this.stopVoiceObservers = attachVoiceObservers(this.eventBus);
    this.stopDebugObserver = attachTerminalDebugObserver(this.eventBus, { scope: 'runtime' });
    this.startTime = Date.now();
  }

  private registerChannelAdapter(adapter: ChannelAdapter): void {
    this.channelRegistry.set(adapter.id, adapter);
    this.agentLoop.setChannelRegistry(this.channelRegistry);
  }

  private async startChannels(): Promise<void> {
    for (const adapter of this.channelRegistry.values()) {
      await adapter.gateway.start();
    }
  }

  private async stopChannels(): Promise<void> {
    const adapters = [...this.channelRegistry.values()].reverse();
    for (const adapter of adapters) {
      await adapter.gateway.stop();
    }
  }

  private resolveExtractionDrainTimeoutMs(): number {
    const raw = process.env.EXTRACTION_DRAIN_TIMEOUT_MS;
    if (!raw) return DEFAULT_EXTRACTION_DRAIN_TIMEOUT_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_EXTRACTION_DRAIN_TIMEOUT_MS;
    }
    return parsed;
  }

  private queueCrashRecoveryExtractions(): void {
    if (this.crashRecoveryQueue.length === 0) return;

    const queued = this.crashRecoveryQueue;
    this.crashRecoveryQueue = [];
    const pendingEntryCount = queued.reduce(
      (total, candidate) => total + candidate.unextractedEntries.length,
      0,
    );
    log.info('Queueing crash recovery extraction', {
      channelCount: queued.length,
      pendingEntryCount,
    });

    for (const candidate of queued) {
      this.memoryExtractor.queueRetroactiveExtraction(
        candidate.channelId,
        candidate.unextractedEntries,
      ).catch((error) => {
        log.error('Crash recovery extraction queue failed', {
          channelId: candidate.channelId,
          error: String(error),
        });
      });
    }
  }

  async init(): Promise<void> {
    log.info('Initializing...');

    // Load persisted settings and apply over env defaults
    const savedSettings = loadSettings(this.config.dataDir);
    applySettings(this.config, savedSettings);
    const modelsConfig = loadModelsConfig(this.config.dataDir, {
      defaultContextWindow: this.config.defaultContextWindow,
    });
    applySettings(this.config, modelsConfig);
    const trustPolicyConfig = loadTrustPolicyConfig(this.config.dataDir, {
      seedDir: process.env.CONFIG_DIR,
    });
    setRuntimeTrustPolicy(trustPolicyConfig);
    const schedulerConfig = resolveRuntimeSchedulerConfig({
      dataDir: this.config.dataDir,
      seedDir: process.env.CONFIG_DIR,
    });
    const backupConfig = resolveBackupRuntimeConfig({
      dataDir: this.config.dataDir,
    });
    this.config.maintenanceIntervalMs = schedulerConfig.salienceDecayIntervalMs;
    this.capabilityRuntime = new CapabilityRuntime({
      dataDir: this.config.dataDir,
      seedDir: process.env.CONFIG_DIR,
      envTier: this.config.capabilityTier,
    });
    this.config.capabilityTier = this.capabilityRuntime.getTier();

    // Ensure data directory exists
    mkdirSync(dirname(this.config.databasePath), { recursive: true });

    // Open database
    this.db = new Database(this.config.databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    runDatabaseIntegrityCheck(this.db);
    log.info('SQLite integrity check passed');

    // Load identity
    const cardVersionStore = new CharacterCardVersionStore(
      this.config.characterCardPath,
      join(this.config.dataDir, 'character-card-history.jsonl'),
    );
    const card = cardVersionStore.getCurrent().card;
    const systemPrompt = composeSystemPrompt(card);
    log.info(`Loaded character: ${card.data.name}`);
    const promptRegistry = wireStaticPromptRegistry(this.config.dataDir);
    const cardProposalQueue = new ConfirmationQueue();

    // Initialize core components
    this.llmClient = new LLMClient(this.config);
    const sessionsDir = join(this.config.dataDir, 'sessions');
    this.sessionStore = new SessionStore(sessionsDir);
    this.sessionManager = new SessionManager(
      this.sessionStore,
      this.config,
      this.eventBus,
      promptRegistry,
    );

    // User continuity store — cross-channel context carryover
    const continuityStore = new UserContinuityStore(sessionsDir);
    this.sessionManager.continuityStore = continuityStore;
    log.info('User continuity store enabled');

    const uncleanChannels = this.sessionStore.getUncleanShutdownChannels();
    if (uncleanChannels.length > 0) {
      log.warn('Detected unclean shutdown sessions', {
        channelCount: uncleanChannels.length,
        channels: uncleanChannels,
      });
    }
    this.crashRecoveryQueue = this.sessionStore.getCrashRecoveryExtractionCandidates();

    // Embedding provider (Ollama local)
    const embeddingProvider = new EmbeddingProvider({
      ollamaUrl: process.env.OLLAMA_URL,
      model: process.env.EMBEDDING_MODEL,
      dims: process.env.EMBEDDING_DIMS ? parseInt(process.env.EMBEDDING_DIMS, 10) : undefined,
    });

    this.memoryStore = new MemoryStore(this.db, embeddingProvider.dims);
    const embeddingDimensionCheck = validateEmbeddingDimensions(
      this.db,
      embeddingProvider.dims,
    );
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

    // Agent loop
    this.agentLoop = new AgentLoop(
      this.eventBus,
      this.llmClient,
      this.sessionManager,
      systemPrompt,
      this.config,
      { characterName: card.data.name },
    );
    this.agentLoop.setCapabilityRuntime(this.capabilityRuntime);
    const safeguardAuditTrail = createSafeguardAuditTrail(this.config.dataDir);
    const identityCoolingOff = createIdentityCoolingOffManagerFromEnv(process.env, {
      auditTrail: safeguardAuditTrail,
    });
    const lifecycleRestartSafeguard = createLifecycleRestartSafeguardFromEnv(process.env, {
      auditTrail: safeguardAuditTrail,
    });
    const externalRateLimiter = createExternalCommunicationRateLimiterFromEnv(process.env, {
      auditTrail: safeguardAuditTrail,
    });

    const skillsRuntime = wireSkillsRuntime(this.agentLoop, {
      dataDir: this.config.dataDir,
      seedDir: process.env.CONFIG_DIR,
      repoRoot: process.cwd(),
    });

    // Prompt stack — layered, editable system prompt
    const promptStore = wirePromptRuntime(
      this.agentLoop,
      this.config.dataDir,
      systemPrompt,
      {
        identityCoolingOff,
        getCapabilityTier: () => this.capabilityRuntime.getTier(),
      },
    );
    wireCharacterCardRuntime(this.agentLoop, cardVersionStore, {
      getCapabilityTier: () => this.capabilityRuntime.getTier(),
      confirmationQueue: cardProposalQueue,
    });

    // Contact store + tools — trust-gated privacy system
    const contactStore = wireContactRuntime(
      this.agentLoop,
      this.db,
      process.env.PRIMARY_USER_ID ?? process.env.DISCORD_VOICE_USER_ID,
    );

    this.agentLoop.memoryProvider = new MemoryRetriever(
      this.memoryStore,
      embeddingProvider,
      this.config,
      this.eventBus,
      contactStore,
    );

    this.memoryExtractor = new MemoryExtractor(
      this.llmClient,
      this.sessionManager,
      this.memoryStore,
      embeddingProvider,
      this.eventBus,
      this.config,
      promptRegistry,
      this.sessionStore,
      contactStore,
    );
    this.agentLoop.memoryExtractor = this.memoryExtractor;
    this.sessionManager.setPreCompactionExtractionHandler(async ({
      channelId,
      entries,
      canonicalContactId,
    }) => {
      await this.memoryExtractor.queueCompactionExtraction(
        channelId,
        entries,
        canonicalContactId,
      );
    });

    this.salienceDecay = new SalienceDecay(this.memoryStore);

    // Scheduler — PSFN's internal clock
    this.scheduler = new Scheduler(this.eventBus, {
      tickIntervalMs: schedulerConfig.tickIntervalMs,
      heartbeatIntervalMs: schedulerConfig.heartbeatIntervalMs,
    });
    this.scheduler.register({
      id: 'salience-decay',
      name: 'Memory Salience Decay',
      type: 'every',
      intervalMs: this.config.maintenanceIntervalMs,
      handler: () => this.salienceDecay.run(),
      state: 'idle',
    });
    registerScheduledBackupTask({
      scheduler: this.scheduler,
      db: this.db,
      databasePath: this.config.databasePath,
      sessionsDir,
      config: backupConfig,
    });
    log.info('Scheduled backups enabled', {
      intervalMs: backupConfig.intervalMs,
      retentionCount: backupConfig.retentionCount,
      backupRootDir: backupConfig.rootDir,
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
      toolCatalogProvider: () => this.agentLoop.getToolCatalog(),
      auditTrail: safeguardAuditTrail,
    });
    this.agentLoop.registerTool(createSpawnShardTool(this.shardManager));
    this.moduleLoader = new ModuleLoader({
      eventBus: this.eventBus,
      registerTool: (tool, category) => this.agentLoop.registerTool(tool, category),
    });

    // Think tool — RLM+REPL sandbox for deep reasoning
    const replConfig = buildReplConfig(this.config);
    this.agentLoop.registerTool(createThinkTool({
      llmProvider: this.llmClient,
      embeddingService: embeddingProvider,
      memoryStore: this.memoryStore,
      sessionManager: this.sessionManager,
      scheduler: this.scheduler,
      eventBus: this.eventBus,
      getCapabilityTier: () => this.capabilityRuntime.getTier(),
      moduleInstallConfirmationQueue: cardProposalQueue,
      onModuleRegistryMutation: async (mutation) => {
        await this.moduleLoader?.applyRegistryMutation(mutation);
      },
      config: replConfig,
    }));

    // Memory write/import tools — intentional memory creation
    const memoryWriter = new MemoryWriter(this.memoryStore, embeddingProvider);
    this.agentLoop.registerTool(createMemoryWriteTool(memoryWriter));
    this.agentLoop.registerTool(createMemoryImportTool(memoryWriter));
    this.agentLoop.registerTool(createMemoryDeleteTool(this.memoryStore));
    this.agentLoop.registerTool(createUndoMemoryDeleteTool(this.memoryStore));

    // Git tools — self-modification via git
    wireGitRuntime(this.agentLoop, {
      repoRoot: process.cwd(),
      allowedPaths: ['src/', 'docs/', 'psfn/'],
    });
    log.info('Git self-modification tools enabled');

    const moduleSummary = await this.moduleLoader.loadEnabledModules();
    log.info('Runtime modules initialized', moduleSummary);

    const channelsConfig = loadRuntimeChannelsConfig(this.config.dataDir);

    // Discord adapter — setAgent enables steering (mid-stream message injection)
    this.discord = new DiscordAdapter(this.config, this.eventBus, {
      sessionStore: this.sessionStore,
    });
    this.discord.setAgent(this.agentLoop);
    await this.discord.init();
    this.registerChannelAdapter(this.discord);

    if (channelsConfig.telegram.enabled) {
      const telegram = new TelegramAdapter(channelsConfig.telegram, this.eventBus);
      telegram.onMessage((message) => this.agentLoop.handleMessage(message));
      await telegram.init();
      this.registerChannelAdapter(telegram);
      log.info('Telegram adapter configured', {
        mode: channelsConfig.telegram.mode,
        allowlistSize: channelsConfig.telegram.allowedUsers.length,
      });
    }

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
      {
        restartSafeguard: lifecycleRestartSafeguard,
        getCapabilityTier: () => this.capabilityRuntime.getTier(),
      },
    ));
    this.agentLoop.registerTool(createRebuildTool(
      this.lifecycleNotifier,
      () => this.stop(),
      {
        restartSafeguard: lifecycleRestartSafeguard,
        getCapabilityTier: () => this.capabilityRuntime.getTier(),
      },
    ));
    this.agentLoop.registerTool(createNotifyOperatorTool(
      createHttpNtfyNotifierFromEnv(),
      {
        rateLimiter: externalRateLimiter,
        defaultChannel: 'discord',
      },
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
    const apiHost = process.env.API_HOST || undefined;
    const apiPort = process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : undefined;
    const adminChatApiBaseUrl = resolveAdminChatApiBaseUrl({
      explicitApiBaseUrl: process.env.API_BASE_URL,
      apiHost,
      apiPort,
    });
    if (apiPort) {
      const voiceWebSocketRuntime = createApiVoiceWebSocketRuntime({
        agentLoop: this.agentLoop,
        eventBus: this.eventBus,
        config: this.config,
      });
      const activeProbeConfig = resolveActiveHealthProbeConfig(process.env);
      const llmActiveProbe = new CachedActiveHealthProbe(activeProbeConfig);
      const embeddingsActiveProbe = new CachedActiveHealthProbe(activeProbeConfig);

      const apiServer = new ApiServer({
        port: apiPort,
        host: apiHost,
        agentLoop: this.agentLoop,
        eventBus: this.eventBus,
        sessionManager: this.sessionManager,
        contactStore,
        apiKey: process.env.API_KEY || undefined,
        modelName: process.env.API_MODEL_NAME,
        healthChecks: {
          memory: () => {
            const stats = this.memoryStore.getStats();
            return {
              status: 'healthy',
              meta: {
                total: stats.total,
                avgSalience: Number(stats.avgSalience.toFixed(4)),
              },
            };
          },
          llm: async () => {
            const configured = Boolean(this.config.primaryModel && this.config.primaryProvider);
            const baseMeta = {
              provider: this.config.primaryProvider ?? null,
              model: this.config.primaryModel ?? null,
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
              await this.llmClient.complete(
                {
                  systemPrompt: 'You are a health check. Respond with exactly: OK',
                  messages: [{ role: 'user', content: 'health probe' }],
                },
                'reasoning',
                { signal, disableRetry: true },
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
          discord: () => {
            if (!this.discord.config.enabled) {
              return {
                status: 'degraded',
                detail: 'Discord adapter is disabled',
              };
            }
            if (!this.discord.isConnected()) {
              return {
                status: 'degraded',
                detail: 'Discord client is not connected',
              };
            }
            return {
              status: 'healthy',
              meta: {
                accountId: this.discord.config.accountId ?? null,
              },
            };
          },
          embeddings: async () => {
            const baseMeta = {
              dims: embeddingProvider.dims,
              ...toActiveProbeMeta(activeProbeConfig),
            };
            if (!Number.isFinite(embeddingProvider.dims) || embeddingProvider.dims <= 0) {
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
              const vector = await embeddingProvider.embed('health probe', { signal });
              if (vector.length !== embeddingProvider.dims) {
                throw new Error(
                  `Embedding probe dimension mismatch: expected ${embeddingProvider.dims}, got ${vector.length}`,
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
            const taskCount = this.scheduler.taskCount;
            const hasHeartbeatTask = Boolean(this.scheduler.getTask('heartbeat'));
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
        voiceWebSocketRuntime,
      });
      await apiServer.init();
      this.registerChannelAdapter(apiServer);
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
        apiBaseUrl: adminChatApiBaseUrl,
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
        skillsRuntime,
        cardVersionStore,
        confirmationQueueApi: {
          listConfirmationQueue: async () => ({ entries: cardProposalQueue.listPending() }),
          resolveConfirmationQueue: (params) => cardProposalQueue.resolve(params),
        },
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
    await this.startChannels();
    if (this.adminServer) await this.adminServer.start();
    this.queueCrashRecoveryExtractions();
    await this.eventBus.emit('system.ready', {});

    // Send "I'm back" notification (fire-and-forget — don't block startup)
    this.lifecycleNotifier?.notifyReady().catch((err) => {
      log.error('Ready notification failed', { error: String(err) });
    });

    log.info('Ready');
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    log.info('Shutting down...');
    await this.eventBus.emit('system.shutdown', {});
    this.stopVoiceObservers?.();
    this.stopVoiceObservers = undefined;
    this.stopDebugObserver?.();
    this.stopDebugObserver = undefined;
    this.scheduler?.stop();
    const timeoutMs = this.resolveExtractionDrainTimeoutMs();
    const drained = await this.memoryExtractor?.stop({ timeoutMs });
    if (drained === false) {
      log.warn('Proceeding with shutdown before extraction drain completed', { timeoutMs });
    }
    const markedChannels = this.sessionStore?.markGracefulShutdownForActiveChannels();
    if ((markedChannels?.length ?? 0) > 0) {
      log.info('Wrote graceful shutdown markers', { channels: markedChannels });
    }
    if (this.adminServer) await this.adminServer.stop();
    await this.moduleLoader?.shutdown();
    await this.stopChannels();
    this.db?.close();
    log.info('Stopped');
  }
}
