import type Database from 'better-sqlite3';
import { join } from 'node:path';
import type { SubstrateConfig, Lifecycle } from './types.js';
import { createComponentLogger } from './logger.js';
import { EventBus } from './event-bus.js';
import { CharacterCardVersionStore } from './identity/card-versioning.js';
import { LLMClient } from './llm/client.js';
import { SessionStore, type CrashRecoveryExtractionCandidate } from './session/store.js';
import { SessionManager } from './session/manager.js';
import { buildSessionHmacKeyring } from './session/journal-utils.js';
import { createKeyringIntegrityProvider } from './session/store-primitives.js';
import { SubstrateAgent } from './agent/substrate-agent.js';
import { DiscordAdapter } from './channels/discord/adapter.js';
import { TelegramAdapter } from './channels/telegram/adapter.js';
import { MemoryStore } from './memory/store.js';
import { MemoryExtractor } from './memory/extraction.js';
import { SalienceDecay } from './memory/decay.js';
import { Scheduler } from './scheduler/scheduler.js';
import { ShardManager } from './shards/manager.js';
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
import { loadSettings, applySettings, type EditableSettings } from './settings.js';
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
import { parseOptionalPositiveIntEnv } from './utils/env.js';
import {
  DiscordLifecycleNotifier,
  restoreLastActiveSession,
  writeLastActiveSession,
} from './lifecycle/notifications.js';
import type { LifecycleNotifier } from './lifecycle/notifications.js';
import { createRestartTool, createRebuildTool } from './tools/lifecycle.js';
import { createHttpNtfyNotifierFromEnv, createNotifyOperatorTool } from './tools/ntfy.js';
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
import { wireGitRuntime } from './git/runtime-wiring.js';
import { wireSkillsRuntime } from './skills/runtime-wiring.js';
import { attachTerminalDebugObserver } from './debug/terminal-observer.js';
import {
  composeIdentity,
  composeSessionRuntime,
  createEmbeddingProviderFromEnv,
  composeSubstrateAgent,
  wireMemoryRuntime,
  wireShardAndThinkRuntime,
} from './bootstrap/composition.js';
import {
  wirePromptRuntime,
  wireCharacterCardRuntime,
  wireStaticPromptRegistry,
  buildReplConfig,
  wireHeartbeatRuntime,
} from './bootstrap/parity.js';
import { attachVoiceObservers } from './voice/observers/index.js';
import { loadRuntimeChannelsConfig, type RuntimeChannelsConfigOverrides } from './channels/config.js';
import { WyomingTcpServer } from './channels/wyoming/server.js';
import { WyomingRuntime } from './channels/wyoming/runtime.js';
import { createWyomingServiceRegistry } from './channels/wyoming/services/index.js';
import { createWyomingHandleServiceAdapter } from './channels/wyoming/services/handle.js';
import { createWyomingAsrServiceAdapter } from './channels/wyoming/services/asr.js';
import { createWyomingTtsServiceAdapter } from './channels/wyoming/services/tts.js';
import { createStreamingSttConnector } from './voice/connectors/stt/index.js';
import {
  createStreamingTtsConnector,
  type StreamingTtsProvider,
} from './voice/connectors/tts/index.js';
import type { WyomingInfoData } from './channels/wyoming/protocol.js';
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
type RuntimeVoiceSttProvider = 'deepgram' | 'disabled';
type RuntimeVoiceTtsProvider = StreamingTtsProvider | 'disabled';

function resolveRuntimeVoiceSttProvider(config: SubstrateConfig): RuntimeVoiceSttProvider {
  const configured = (config as SubstrateConfig & { sttProvider?: RuntimeVoiceSttProvider }).sttProvider;
  if (configured === 'deepgram' || configured === 'disabled') return configured;
  return config.deepgramApiKey ? 'deepgram' : 'disabled';
}

function resolveRuntimeVoiceTtsProvider(config: SubstrateConfig): RuntimeVoiceTtsProvider {
  const configured = (config as SubstrateConfig & { ttsProvider?: RuntimeVoiceTtsProvider }).ttsProvider;
  if (configured === 'elevenlabs' || configured === 'echo' || configured === 'disabled') return configured;
  return 'elevenlabs';
}

export function buildRuntimeChannelsConfigOverrides(
  config: SubstrateConfig,
  settings: EditableSettings,
): RuntimeChannelsConfigOverrides {
  const telegramOverride: RuntimeChannelsConfigOverrides['telegram'] = {};

  if (Object.hasOwn(settings, 'telegramEnabled')) {
    telegramOverride.enabled = config.telegramEnabled ?? false;
  }
  if (Object.hasOwn(settings, 'telegramAuthorizedUsers')) {
    telegramOverride.allowedUsers = config.telegramAuthorizedUsers
      ? [...config.telegramAuthorizedUsers]
      : [];
  }

  if (telegramOverride.enabled === undefined && telegramOverride.allowedUsers === undefined) {
    return {};
  }

  return {
    telegram: telegramOverride,
  };
}

export class SubstrateRuntime implements Lifecycle {
  private config: SubstrateConfig;
  private eventBus: EventBus;
  private db!: Database.Database;
  private llmClient!: LLMClient;
  private sessionStore!: SessionStore;
  private sessionManager!: SessionManager;
  private memoryExtractor!: MemoryExtractor;
  private agentLoop!: SubstrateAgent;
  private discord!: DiscordAdapter;
  private memoryStore!: MemoryStore;
  private salienceDecay!: SalienceDecay;
  private scheduler!: Scheduler;
  private shardManager!: ShardManager;
  private channelRegistry = new Map<string, ChannelAdapter>();
  private capabilityRuntime!: CapabilityRuntime;
  private moduleLoader?: ModuleLoader;
  private adminServer?: AdminServer;
  private wyomingTcpServer?: WyomingTcpServer;
  private wyomingRuntime?: WyomingRuntime;
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
    const adapters = [...this.channelRegistry.values()];
    if (adapters.length === 0) return;

    const results = await Promise.allSettled(
      adapters.map(adapter => adapter.gateway.start()),
    );

    const failedAdapterIds: string[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') continue;
      const adapterId = adapters[index]?.id ?? `unknown-${index}`;
      failedAdapterIds.push(adapterId);
      log.error('Channel adapter failed to start', {
        adapterId,
        error: String(result.reason),
      });
    }

    if (failedAdapterIds.length === 0) return;

    for (const adapterId of failedAdapterIds) {
      this.channelRegistry.delete(adapterId);
    }
    this.agentLoop.setChannelRegistry(this.channelRegistry);

    const startedCount = adapters.length - failedAdapterIds.length;
    log.warn('Continuing startup with partially available channel adapters', {
      startedCount,
      failedCount: failedAdapterIds.length,
      failedAdapterIds,
    });

    if (startedCount === 0) {
      throw new Error('No channel adapters started successfully');
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

  private restoreLatestSessionMetadata(): void {
    const resolved = restoreLastActiveSession({
      dataDir: this.config.dataDir,
      computedLatestSession: this.sessionStore.getLatestSessionByTimestamp(),
      isSessionValid: (sessionId) => this.sessionStore.count(sessionId) > 0,
    });
    if (!resolved) return;

    log.info('Restored latest session metadata', {
      sessionId: resolved.sessionId,
      channelType: resolved.channelType ?? 'unknown',
      timestamp: resolved.timestamp,
    });
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
    log.info('Loaded trust policy configuration', {
      exactOverrideCount: Object.keys(
        trustPolicyConfig.channelClassification.visibilityOverrides.exact,
      ).length,
      prefixOverrideCount: Object.keys(
        trustPolicyConfig.channelClassification.visibilityOverrides.prefix,
      ).length,
    });
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

    // Open database
    this.db = initDatabase(this.config.databasePath);
    runDatabaseIntegrityCheck(this.db);
    log.info('SQLite integrity check passed');

    // Load identity
    const { card, systemPrompt } = composeIdentity(this.config);
    const cardVersionStore = new CharacterCardVersionStore(
      this.config.characterCardPath,
      join(this.config.dataDir, 'character-card-history.jsonl'),
    );
    log.info(`Loaded character: ${card.data.name}`);
    const promptRegistry = wireStaticPromptRegistry(this.config.dataDir);
    const cardProposalQueue = new ConfirmationQueue();

    // Initialize core components
    this.llmClient = new LLMClient(this.config);
    const sessionsDir = join(this.config.dataDir, 'sessions');
    const sessionHmacKeyring = buildSessionHmacKeyring({
      serializedKeys: process.env.GATEWAY_SESSION_HMAC_KEYS,
      singleKey: process.env.GATEWAY_SESSION_HMAC_KEY,
      activeVersion: process.env.GATEWAY_SESSION_HMAC_ACTIVE_VERSION,
    });
    const sessionIntegrityProvider = createKeyringIntegrityProvider(sessionHmacKeyring);
    if (sessionIntegrityProvider) {
      log.info('Session HMAC integrity enabled (single-process mode)');
    }
    const sessionComposition = composeSessionRuntime({
      config: this.config,
      eventBus: this.eventBus,
      sessionsDir,
      enableContinuity: true,
      promptRegistry,
      sessionIntegrityProvider,
    });
    this.sessionStore = sessionComposition.sessionStore;
    this.sessionManager = sessionComposition.sessionManager;
    this.sessionManager.characterName = card.data.name;
    if (sessionComposition.continuityStore) {
      log.info('User continuity store enabled');
    }

    const uncleanChannels = this.sessionStore.getUncleanShutdownChannels();
    if (uncleanChannels.length > 0) {
      log.warn('Detected unclean shutdown sessions', {
        channelCount: uncleanChannels.length,
        channels: uncleanChannels,
      });
    }
    this.crashRecoveryQueue = this.sessionStore.getCrashRecoveryExtractionCandidates();
    this.restoreLatestSessionMetadata();

    // Embedding provider (Ollama local)
    const embeddingProvider = createEmbeddingProviderFromEnv();

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
    this.agentLoop = composeSubstrateAgent({
      eventBus: this.eventBus,
      llmProvider: this.llmClient,
      sessionManager: this.sessionManager,
      systemPrompt,
      characterName: card.data.name,
      config: this.config,
    });
    this.agentLoop.scratchpadProvider = this.memoryStore;
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
    const primaryUserId = process.env.PRIMARY_USER_ID ?? process.env.DISCORD_VOICE_USER_ID;
    const primaryTelegramUserId = (
      process.env.PRIMARY_TELEGRAM_USER_ID
      ?? process.env.TELEGRAM_PRIMARY_USER_ID
      ?? ''
    ).trim();
    const contactStore = wireContactRuntime(
      this.agentLoop,
      this.db,
      primaryUserId,
      primaryTelegramUserId
        ? {
          bootstrapPrimaryIdentityLinks: [{
            channel: 'telegram',
            userId: primaryTelegramUserId,
            privacyLevel: 'private',
          }],
        }
        : {},
    );

    this.memoryExtractor = wireMemoryRuntime({
      agentLoop: this.agentLoop,
      llmProvider: this.llmClient,
      sessionManager: this.sessionManager,
      sessionStore: this.sessionStore,
      memoryStore: this.memoryStore,
      embeddingService: embeddingProvider,
      eventBus: this.eventBus,
      config: this.config,
      promptRegistry,
      contactStore,
    });

    this.salienceDecay = new SalienceDecay(this.memoryStore);

    // Scheduler — Purrsephone's internal clock
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

    log.info(`Memory system enabled (${embeddingProvider.dims}d embeddings via ${embeddingProvider.kind})`);

    // Shard manager — allows Purrsephone to spawn parallel sub-agents
    this.moduleLoader = new ModuleLoader({
      eventBus: this.eventBus,
      registerTool: (tool, category) => this.agentLoop.registerTool(tool, category),
    });

    const replConfig = buildReplConfig(this.config);
    this.shardManager = wireShardAndThinkRuntime({
      agentLoop: this.agentLoop,
      eventBus: this.eventBus,
      llmProvider: this.llmClient,
      embeddingService: embeddingProvider,
      sessionStore: this.sessionStore,
      memoryStore: this.memoryStore,
      sessionManager: this.sessionManager,
      config: this.config,
      parentSystemPrompt: systemPrompt,
      scheduler: this.scheduler,
      replConfig,
      shardAuditTrail: safeguardAuditTrail,
      getCapabilityTier: () => this.capabilityRuntime.getTier(),
      moduleInstallConfirmationQueue: cardProposalQueue,
      onModuleRegistryMutation: async (mutation) => {
        await this.moduleLoader?.applyRegistryMutation(mutation);
      },
    });

    // Memory write/import tools — intentional memory creation
    const memoryWriter = new MemoryWriter(this.memoryStore, embeddingProvider);
    this.agentLoop.registerTool(createMemoryWriteTool(memoryWriter));
    this.agentLoop.registerTool(createMemoryImportTool(memoryWriter));
    this.agentLoop.registerTool(createMemoryRedactTool(memoryWriter));
    this.agentLoop.registerTool(createMemoryDeleteTool(this.memoryStore));
    this.agentLoop.registerTool(createUndoMemoryDeleteTool(this.memoryStore));
    this.agentLoop.registerTool(createScratchpadReadTool(this.memoryStore));
    this.agentLoop.registerTool(createScratchpadWriteTool(this.memoryStore));

    // Git tools — self-modification via git
    wireGitRuntime(this.agentLoop, {
      repoRoot: process.cwd(),
      allowedPaths: ['src/', 'docs/', 'purrsephone/'],
    });
    log.info('Git self-modification tools enabled');

    // Validate tool wiring — catch misconfigured tools before they crash at invocation
    this.agentLoop.validateToolWiring('single');

    const moduleSummary = await this.moduleLoader.loadEnabledModules();
    log.info('Runtime modules initialized', moduleSummary);
    log.info('Re-validating tool wiring after module load', {
      mode: 'single',
      loadedModules: moduleSummary.loaded,
      failedModules: moduleSummary.failed,
    });
    this.agentLoop.validateToolWiring('single');

    const channelsConfig = loadRuntimeChannelsConfig(
      this.config.dataDir,
      process.env,
      buildRuntimeChannelsConfigOverrides(this.config, savedSettings),
    );

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
    const lifecycleRuntimeMode = process.env.PSFN_RUNTIME_MODE?.trim() || 'single';
    const lifecycleRestartCommand = process.env.LIFECYCLE_RESTART_COMMAND?.trim() || undefined;
    this.lifecycleNotifier = new DiscordLifecycleNotifier({
      sender: this.discord,
      heartbeatChannelId,
      dataDir: this.config.dataDir,
      startTime: this.startTime,
    });

    // Track last-active channel on every incoming message
    this.eventBus.on('message.received', ({ message }) => {
      writeLastActiveSession(this.config.dataDir, {
        sessionId: message.channelId,
        channelType: message.channelType,
        timestamp: message.timestamp instanceof Date
          ? message.timestamp.getTime()
          : Date.now(),
      });
    });

    // Lifecycle tools — self_restart and self_rebuild
    this.agentLoop.registerTool(createRestartTool(
      this.lifecycleNotifier,
      () => this.stop(),
      {
        restartSafeguard: lifecycleRestartSafeguard,
        getCapabilityTier: () => this.capabilityRuntime.getTier(),
        restartCommand: lifecycleRestartCommand,
        runtimeMode: lifecycleRuntimeMode,
      },
    ));
    this.agentLoop.registerTool(createRebuildTool(
      this.lifecycleNotifier,
      () => this.stop(),
      {
        restartSafeguard: lifecycleRestartSafeguard,
        getCapabilityTier: () => this.capabilityRuntime.getTier(),
        restartCommand: lifecycleRestartCommand,
        runtimeMode: lifecycleRuntimeMode,
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
      {
        llmProvider: this.llmClient,
        sessionManager: this.sessionManager,
        memoryWriter,
      },
    );

    // API server — OpenAI-compatible endpoints
    const apiHost = process.env.API_HOST || undefined;
    const apiPort = parseOptionalPositiveIntEnv(process.env.API_PORT);
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

    // Admin GUI — Purrsephone's Garden
    const adminPort = parseOptionalPositiveIntEnv(process.env.ADMIN_PORT);
    if (adminPort) {
      this.adminServer = new AdminServer({
        port: adminPort,
        host: process.env.ADMIN_HOST || undefined,
        token: process.env.ADMIN_TOKEN || undefined,
        apiBaseUrl: process.env.API_BASE_URL,
        apiHost,
        apiPort,
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

    // Wyoming voice bridge — opt-in TCP server for Home Assistant integration
    if (this.config.wyomingEnabled) {
      const wyomingPort = this.config.wyomingPort ?? 10400;
      const wyomingHost = this.config.wyomingHost ?? '127.0.0.1';

      const handleAdapter = createWyomingHandleServiceAdapter({
        handleMessage: (message) => this.agentLoop.handleMessage(message),
        eventBus: this.eventBus,
      });

      const wyomingAdapters = [handleAdapter];

      // ASR adapter — wired to Deepgram STT when selected and API key is available
      const wyomingSttProvider = resolveRuntimeVoiceSttProvider(this.config);
      const wyomingDeepgramKey = this.config.deepgramApiKey;
      if (wyomingSttProvider === 'deepgram' && wyomingDeepgramKey) {
        const sttConnector = createStreamingSttConnector('deepgram', {
          apiKey: wyomingDeepgramKey,
          model: this.config.deepgramModel,
        });
        wyomingAdapters.push(createWyomingAsrServiceAdapter({ stt: sttConnector }));
        log.info('Wyoming ASR adapter enabled (deepgram)');
      }

      // TTS adapter — wired to the configured TTS provider (elevenlabs or echo)
      const wyomingTtsProvider = resolveRuntimeVoiceTtsProvider(this.config);
      try {
        let ttsConnector;
        if (wyomingTtsProvider === 'echo' && this.config.echoTtsUrl && this.config.echoTtsVoice) {
          ttsConnector = createStreamingTtsConnector('echo', {
            url: this.config.echoTtsUrl,
            voice: this.config.echoTtsVoice,
            preset: this.config.echoTtsPreset ?? 'normal',
            ...(this.config.echoTtsModel ? { model: this.config.echoTtsModel } : {}),
          });
        } else if (wyomingTtsProvider === 'elevenlabs' && this.config.elevenLabsApiKey) {
          ttsConnector = createStreamingTtsConnector('elevenlabs', {
            apiKey: this.config.elevenLabsApiKey,
            voiceId: this.config.elevenLabsVoiceId ?? 'YOUR_VOICE_ID',
            modelId: this.config.elevenLabsModelId,
          });
        }
        if (ttsConnector) {
          wyomingAdapters.push(createWyomingTtsServiceAdapter({ tts: ttsConnector }));
          log.info('Wyoming TTS adapter enabled', { provider: wyomingTtsProvider });
        }
      } catch (error) {
        log.warn('Wyoming TTS adapter could not be created', { error: String(error) });
      }

      const serviceRegistry = createWyomingServiceRegistry(wyomingAdapters);

      this.wyomingTcpServer = new WyomingTcpServer(
        { port: wyomingPort, host: wyomingHost, eventBus: this.eventBus },
        {
          onFrame: (session, frame) => this.wyomingRuntime!.handleFrame(session, frame),
          onSessionClose: (session) => this.wyomingRuntime!.closeConnection(session.connectionId),
        },
      );

      this.wyomingRuntime = new WyomingRuntime({
        info: {
          name: 'purrsephone',
          version: '1.0.0',
          description: 'Purrsephone Substrate Framework — Wyoming voice bridge',
          services: serviceRegistry.services,
        } as WyomingInfoData,
        emitFrame: (session, frame) => this.wyomingTcpServer!.send(session, frame),
        serviceRegistry,
        eventBus: this.eventBus,
      });

      log.info(`Wyoming voice bridge configured on ${wyomingHost}:${wyomingPort}`);
    }

    await this.eventBus.emit('system.init', {});
    log.info('Initialized');
  }

  async start(): Promise<void> {
    log.info('Starting...');
    this.scheduler.start();
    await this.startChannels();
    if (this.adminServer) await this.adminServer.start();
    if (this.wyomingTcpServer) {
      await this.wyomingTcpServer.start();
      log.info(`Wyoming voice bridge listening on ${this.config.wyomingHost ?? '127.0.0.1'}:${this.config.wyomingPort ?? 10400}`);
    }
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
    if (this.wyomingRuntime) await this.wyomingRuntime.stop();
    if (this.wyomingTcpServer) await this.wyomingTcpServer.stop();
    if (this.adminServer) await this.adminServer.stop();
    await this.moduleLoader?.shutdown();
    await this.stopChannels();
    this.db?.close();
    log.info('Stopped');
  }
}
