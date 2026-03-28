import { createComponentLogger } from '../logger.js';
import { CharacterCardVersionStore } from '../identity/card-versioning.js';
import {
  composeSystemPromptTemplate,
} from '../identity/loader.js';
import { createSessionHmacBoundaryService } from '../session/hmac-boundary.js';
import { EmotionObserver } from '../emotion/observer.js';
import { EmotionState } from '../emotion/state.js';
import { getSharedAudioEmotionClassifier } from '../emotion/audio-classifier.js';
import type { DiscordAdapter } from '../channels/discord/adapter.js';
import { SalienceDecay } from '../memory/decay.js';
import { Scheduler } from '../scheduler/scheduler.js';
import {
  CachedActiveHealthProbe,
  resolveActiveHealthProbeConfig,
  toActiveProbeMeta,
} from '../channels/api/active-health-probe.js';
import { createApiVoiceWebSocketRuntime } from '../channels/api/voice-websocket-runtime.js';
import { AdminServer } from '../channels/admin/server.js';
import { createLocalAdminToolHealthProvider } from '../channels/admin/tool-health-provider.js';
import { ModelDiscovery } from '../llm/discovery.js';
import {
  resolveConfiguredLiteLLMApiKey,
  resolveConfiguredLiteLLMBaseUrl,
} from '../config/providers-config.js';
import { resolveBackupRuntimeConfig } from '../backup/config.js';
import { registerScheduledBackupTask } from '../backup/service.js';
import {
  runDatabaseIntegrityCheck,
  validateEmbeddingDimensions,
} from '../backup/startup-checks.js';
import { parseOptionalPositiveIntEnv } from '../utils/env.js';
import {
  DiscordLifecycleNotifier,
  writeLastActiveSession,
} from '../lifecycle/notifications.js';
import {
  RUNTIME_MODE,
} from '../lifecycle/runtime-mode.js';
import { inferSessionChannelType } from '../session/session-id.js';
import { createRestartTool, createRebuildTool } from '../tools/lifecycle.js';
import { createHttpNtfyNotifierFromEnv, createNotifyOperatorTool } from '../tools/ntfy.js';
import { MemoryWriter } from '../memory/writer.js';
import { DEFAULT_COMPANION_ID } from '../identity/companion-naming.js';
import { registerMemoryTools } from '../memory/runtime-wiring.js';
import { wireContactRuntime } from '../contacts/runtime-wiring.js';
import { wireGitRuntime } from '../git/runtime-wiring.js';
import { wireImageRuntime } from '../images/runtime-wiring.js';
import { wireSkillsRuntime } from '../skills/runtime-wiring.js';
import {
  createIntentionAppraisalHooks,
  createIntentionBehavioralPatternHooks,
  wireIntentionRuntime,
} from '../intention/runtime-wiring.js';
import { createBehavioralPatternMemoryPromotionHook } from '../intention/patterns.js';
import { createProviderRuntimeServices } from '../config/provider-runtime-factory.js';
import {
  composeIdentity,
  composeSessionRuntime,
  composeSubstrateAgent,
  wireSelfModelRuntime,
  wireCoreMemoryRuntime,
  wireMemoryRuntime,
  wireShardAndThinkRuntime,
} from '../bootstrap/composition.js';
import {
  wireFilesystemToolsRuntime,
  wirePromptRuntime,
  wireCharacterCardRuntime,
  wireStaticPromptRegistry,
  wireSettingsRuntime,
  wireSessionToolsRuntime,
  buildCharacterPromptVariablesProvider,
  buildReplConfig,
  wireHeartbeatRuntime,
} from '../bootstrap/parity.js';
import { wirePostTurnActionRuntime } from '../bootstrap/post-turn-actions.js';
import { buildExternalChannelProfiles, loadRuntimeChannelsConfig } from '../channels/config.js';
import { WyomingTcpServer } from '../channels/wyoming/server.js';
import { WyomingRuntime } from '../channels/wyoming/runtime.js';
import { createWyomingServiceRegistry } from '../channels/wyoming/services/index.js';
import { createWyomingHandleServiceAdapter } from '../channels/wyoming/services/handle.js';
import { createWyomingAsrServiceAdapter } from '../channels/wyoming/services/asr.js';
import { createWyomingTtsServiceAdapter } from '../channels/wyoming/services/tts.js';
import type { WyomingInfoData } from '../channels/wyoming/protocol.js';
import { CapabilityRuntime } from '../capabilities/runtime.js';
import {
  createEligibilityGate,
  EligibilityDeniedError,
} from '../capabilities/eligibility.js';
import { REPO_ALLOWED_PATHS } from '../security/policy-constants.js';
import { ConfirmationQueue } from '../capabilities/confirmation-queue.js';
import { ModuleLoader } from '../modules/loader.js';
import {
  resolveCharacterCardHistoryPath,
  resolveContactsDir,
  resolveMemoryJournalPath,
  resolvePostTurnActionQueuePath,
  resolveSessionsDir,
} from '../persistence/layout.js';
import { createSqliteCompanionStore } from '../persistence/sqlite-companion-store.js';
import {
  buildRuntimeChannelsConfigOverrides,
  createRuntimeVoiceSttConnector,
  createRuntimeVoiceTtsConnector,
  createEmbeddingDimensionMismatchFatalMessage,
  resolveRuntimeVoiceSttProvider,
  resolveRuntimeVoiceTtsProvider,
  type StartupConfigHydrationDiagnostics,
} from './bootstrap-helpers.js';
import { isExplicitTrue, parseCommaSeparatedEnv } from './env-parsing.js';
import { resolveStartupPreflightBundle } from './startup-preflight.js';
import {
  createStartupTextEmotionClassifier,
  warmRuntimeMlServices,
} from './ml-warmup.js';
import { createPromptGenerationFailureAlertHandler } from './operator-alerts.js';
import { resolveApiCorsAllowedOrigins } from '../channels/api/http-policy.js';
import { buildChannelAdapterFactoryManifest, loadChannelAdaptersFromManifest } from './channel-lifecycle.js';
import { emitEligibilityDecisionTelemetry } from './eligibility-telemetry.js';
import { createLocalConfirmationQueueAdminApi } from './confirmation-queue-admin-api.js';
import {
  createApiServerChannelAdapterFactoryEntry,
  createDiscordChannelAdapterFactoryEntry,
  createOpenHomeChannelAdapterFactoryEntry,
  createTelegramChannelAdapterFactoryEntry,
  getOptionalChannelAdapter,
  requireChannelAdapter,
} from '../bootstrap/channel-runtime.js';
import { createRuntimeSafeguardSurfaces } from './safeguard-surfaces.js';
export {
  buildRuntimeChannelsConfigOverrides,
  createEmbeddingDimensionMismatchFatalMessage,
};


const log = createComponentLogger('Runtime');
const COMPACTION_GUIDELINE_REVIEW_TASK_ID = 'compaction-guideline-review';

function logStartupHydrationDiagnostics(diagnostics: StartupConfigHydrationDiagnostics): void {
  if (diagnostics.modelsMigratedFromLegacySettings) {
    log.warn('Migrated legacy model settings from settings.json to models.json');
  } else if (diagnostics.modelsLegacyDriftDetected) {
    log.warn('Detected legacy model drift between settings.json and models.json; models.json is authoritative');
  }
  if (diagnostics.providersMigratedFromLegacyConfig) {
    log.warn('Migrated legacy provider endpoints into providers.json');
  } else if (diagnostics.providersLegacyDriftDetected) {
    log.warn('Detected provider endpoint drift between legacy config and providers.json; providers.json is authoritative');
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

export async function initializeSubstrateRuntime(runtime: any): Promise<void> {
  const runtimeAny = runtime as any;

  log.info('Initializing...');
  const {
    lifecycleRuntimeContract,
    runtimeStatusMeta,
    startupHydration,
  } = resolveStartupPreflightBundle(runtimeAny.config, {
    entrypoint: RUNTIME_MODE.SINGLE,
    env: process.env,
    logger: log,
  });
  const {
    pathSnapshot,
    settingsDomains,
    trustPolicyConfig,
    schedulerConfig,
  } = startupHydration;
  logStartupHydrationDiagnostics(startupHydration.diagnostics);

  log.info('Lifecycle runtime contract resolved', runtimeStatusMeta);
  log.info('Loaded trust policy configuration', {
    exactOverrideCount: Object.keys(
      trustPolicyConfig.channelClassification.visibilityOverrides.exact,
    ).length,
    prefixOverrideCount: Object.keys(
      trustPolicyConfig.channelClassification.visibilityOverrides.prefix,
    ).length,
  });
  const backupConfig = resolveBackupRuntimeConfig({
    dataDir: pathSnapshot.companionDataDir,
    defaultRootDir: pathSnapshot.runtimePathLayout.backupsDir,
  });
  runtimeAny.capabilityRuntime = new CapabilityRuntime({
    dataDir: pathSnapshot.systemDataDir,
    seedDir: process.env.CONFIG_DIR,
  });
  runtimeAny.config.capabilityTier = runtimeAny.capabilityRuntime.getTier();
  const eligibilityGate = createEligibilityGate(
    () => runtimeAny.capabilityRuntime,
    (decision) => emitEligibilityDecisionTelemetry(runtimeAny.eventBus, decision, log),
  );

  // Load identity
  const {
    card,
    systemPrompt,
  } = composeIdentity(runtimeAny.config);
  const cardVersionStore = new CharacterCardVersionStore(
    runtimeAny.config.characterCardPath,
    resolveCharacterCardHistoryPath(pathSnapshot.companionDataDir),
  );
  log.info(`Loaded character: ${card.data.name}`);
  runtimeAny.config.characterName = card.data.name;
  const promptRegistry = wireStaticPromptRegistry(pathSnapshot.companionDataDir);
  const cardProposalQueue = new ConfirmationQueue();

  // Initialize core components
  const providerRuntime = createProviderRuntimeServices({
    config: runtimeAny.config,
    llmOptions: {
      eligibilityGate,
      onBudgetBlocked: (event) => {
        runtimeAny.eventBus.emit('model.budget.blocked', event).catch((error) => {
          log.error('Failed to emit model budget blocked telemetry', {
            error: error instanceof Error ? error.message : String(error),
            provider: event.provider,
            model: event.model,
            reason: event.reason,
          });
        });
      },
    },
  });
  runtimeAny.llmClient = providerRuntime.llmClient;
  const sessionsDir = resolveSessionsDir(pathSnapshot.companionDataDir);
  const sessionHmacBoundary = createSessionHmacBoundaryService({
    env: process.env,
    credentialVault: runtimeAny.config.credentialVault,
  });
  const sessionIntegrityProvider = sessionHmacBoundary.resolveIntegrityProvider();
  if (sessionIntegrityProvider) {
    log.info('Session HMAC integrity enabled (single-process mode)');
  }
  const sessionComposition = composeSessionRuntime({
    config: runtimeAny.config,
    eventBus: runtimeAny.eventBus,
    sessionsDir,
    enableContinuity: true,
    promptRegistry,
    sessionIntegrityProvider,
  });
  runtimeAny.sessionStore = sessionComposition.sessionStore;
  runtimeAny.sessionManager = sessionComposition.sessionManager;
  runtimeAny.sessionManager.characterName = card.data.name;
  if (sessionComposition.continuityStore) {
    log.info('User continuity store enabled');
  }

  const uncleanChannels = runtimeAny.sessionStore.getUncleanShutdownChannels();
  if (uncleanChannels.length > 0) {
    log.warn('Detected unclean shutdown sessions', {
      channelCount: uncleanChannels.length,
      channels: uncleanChannels,
    });
  }
  runtimeAny.crashRecoveryQueue = runtimeAny.sessionStore.getCrashRecoveryExtractionCandidates();
  runtimeAny.seedCrashRecoveryRetryBacklog(runtimeAny.crashRecoveryQueue);
  runtimeAny.restoreLatestSessionMetadata(pathSnapshot.companionDataDir);

  // Embedding provider (selected by EMBEDDING_PROVIDER)
  const embeddingProvider = providerRuntime.embeddingProvider;
  log.info('Embedding provider initialized', {
    provider: embeddingProvider.kind,
    dims: embeddingProvider.dims,
  });

  const companionStore = createSqliteCompanionStore({
    databasePath: runtimeAny.config.databasePath,
    companionDataDir: pathSnapshot.companionDataDir,
    embeddingDims: embeddingProvider.dims,
  });
  runtimeAny.db = companionStore.db;
  runtimeAny.memoryStore = companionStore.memoryStore;
  runDatabaseIntegrityCheck(runtimeAny.db);
  log.info('SQLite integrity check passed');
  const embeddingDimensionCheck = validateEmbeddingDimensions(
    runtimeAny.db,
    embeddingProvider.dims,
  );
  const embeddingDimensionFatalMessage = createEmbeddingDimensionMismatchFatalMessage(
    embeddingDimensionCheck,
  );
  if (embeddingDimensionFatalMessage) {
    log.error('Fatal startup guard: embedding dimension mismatch', {
      configuredDims: embeddingDimensionCheck.configuredDims,
      storedDims: embeddingDimensionCheck.storedDims,
      action: 'startup_aborted',
      message: embeddingDimensionFatalMessage,
    });
    throw new Error(embeddingDimensionFatalMessage);
  }

  // Agent loop
  const textClassifier = createStartupTextEmotionClassifier({
    model: runtimeAny.config.textEmotionModel,
    cacheDir: runtimeAny.config.textEmotionCacheDir,
    dtype: runtimeAny.config.textEmotionDtype,
  });
  await warmRuntimeMlServices({
    textClassifier,
    embeddingService: embeddingProvider,
    textEmotionModel: runtimeAny.config.textEmotionModel!.trim(),
    logger: log,
  });
  const emotionObserver = new EmotionObserver({
    textClassifier,
    audioClassifier: getSharedAudioEmotionClassifier(),
  });
  const emotionState = new EmotionState();
  const operatorNotifier = createHttpNtfyNotifierFromEnv(
    process.env,
    runtimeAny.config.credentialVault,
  );
  runtimeAny.agentLoop = composeSubstrateAgent({
    eventBus: runtimeAny.eventBus,
    llmProvider: runtimeAny.llmClient,
    sessionManager: runtimeAny.sessionManager,
    systemPrompt,
    characterName: card.data.name,
    characterPromptVariablesProvider: buildCharacterPromptVariablesProvider(cardVersionStore),
    config: runtimeAny.config,
    runtimeMode: 'single',
    streamRuntimeOptions: {
      onTerminalFailure: createPromptGenerationFailureAlertHandler(operatorNotifier, card.data.name),
    },
    emotionRuntime: {
      observer: emotionObserver,
      state: emotionState,
      requireWiring: true,
    },
  });
  runtimeAny.agentLoop.scratchpadProvider = runtimeAny.memoryStore;
  runtimeAny.agentLoop.setCapabilityRuntime(runtimeAny.capabilityRuntime);
  const {
    safeguardAuditTrail,
    identityCoolingOff,
    lifecycleRestartSafeguard,
    externalRateLimiter,
  } = createRuntimeSafeguardSurfaces(pathSnapshot.companionDataDir, process.env);

  const skillsRuntime = wireSkillsRuntime(runtimeAny.agentLoop, {
    dataDir: pathSnapshot.systemDataDir,
    seedDir: process.env.CONFIG_DIR,
    repoRoot: process.cwd(),
  });
  wireFilesystemToolsRuntime(runtimeAny.agentLoop, process.cwd());
  wireImageRuntime(runtimeAny.agentLoop, runtimeAny.config);

  // Prompt stack — layered, editable system prompt
  const promptStore = wirePromptRuntime(
    runtimeAny.agentLoop,
    pathSnapshot.companionDataDir,
    composeSystemPromptTemplate(),
    {
      identityCoolingOff,
      getCapabilityTier: () => runtimeAny.capabilityRuntime.getTier(),
    },
  );
  wireCharacterCardRuntime(runtimeAny.agentLoop, cardVersionStore, {
    getCapabilityTier: () => runtimeAny.capabilityRuntime.getTier(),
    confirmationQueue: cardProposalQueue,
  });
  wireSettingsRuntime(runtimeAny.agentLoop, runtimeAny.config);
  wireSessionToolsRuntime(runtimeAny.agentLoop, runtimeAny.sessionManager, pathSnapshot.companionDataDir, runtimeAny.llmClient);
  const coreMemoryStore = wireCoreMemoryRuntime({
    agentLoop: runtimeAny.agentLoop,
    sessionManager: runtimeAny.sessionManager,
    config: runtimeAny.config,
  });

  // Contact store + tools — trust-gated privacy system
  const primaryUserId = process.env.PRIMARY_USER_ID ?? process.env.DISCORD_VOICE_USER_ID;
  const primaryTelegramUserId = (
    process.env.PRIMARY_TELEGRAM_USER_ID
    ?? process.env.TELEGRAM_PRIMARY_USER_ID
    ?? ''
  ).trim();
  const contactStore = wireContactRuntime(
    runtimeAny.agentLoop,
    runtimeAny.db,
    primaryUserId,
    {
      exportDir: resolveContactsDir(pathSnapshot.companionDataDir),
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
  const intentionRuntime = wireIntentionRuntime(runtimeAny.agentLoop, runtimeAny.db);
  wireSelfModelRuntime(runtimeAny.agentLoop);
  const intentionAppraisalHooks = createIntentionAppraisalHooks(
    intentionRuntime.concernStore,
    intentionRuntime.pendingFollowUpStore,
  );
  const intentionBehavioralHooks = createIntentionBehavioralPatternHooks(
    intentionRuntime.behavioralPatternTracker,
  );

  runtimeAny.memoryExtractor = wireMemoryRuntime({
    agentLoop: runtimeAny.agentLoop,
    llmProvider: runtimeAny.llmClient,
    sessionManager: runtimeAny.sessionManager,
    sessionStore: runtimeAny.sessionStore,
    memoryStore: runtimeAny.memoryStore,
    embeddingService: embeddingProvider,
    eventBus: runtimeAny.eventBus,
    config: runtimeAny.config,
    promptRegistry,
    contactStore,
  });

  runtimeAny.salienceDecay = new SalienceDecay(runtimeAny.memoryStore);

  // Scheduler — the companion's internal clock
  runtimeAny.scheduler = new Scheduler(runtimeAny.eventBus, {
    tickIntervalMs: schedulerConfig.tickIntervalMs,
    heartbeatIntervalMs: schedulerConfig.heartbeatIntervalMs,
  }, {
    eligibilityGate,
  });
  runtimeAny.scheduler.register({
    id: 'salience-decay',
    name: 'Memory Salience Decay',
    type: 'every',
    intervalMs: runtimeAny.config.maintenanceIntervalMs,
    handler: () => runtimeAny.salienceDecay.run(),
    eligibility: { requiredTokens: ['memory.write'] },
    state: 'idle',
  });
  runtimeAny.scheduler.register({
    id: COMPACTION_GUIDELINE_REVIEW_TASK_ID,
    name: 'Compression Guideline Review',
    type: 'every',
    intervalMs: runtimeAny.config.maintenanceIntervalMs,
    handler: async () => {
      const result = await runtimeAny.sessionManager.runPeriodicCompressionGuidelineUpdate(runtimeAny.llmClient);
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
    scheduler: runtimeAny.scheduler,
    db: runtimeAny.db,
    databasePath: runtimeAny.config.databasePath,
    sessionsDir,
    memoriesJournalPath: resolveMemoryJournalPath(pathSnapshot.companionDataDir),
    characterCardPath: runtimeAny.config.characterCardPath,
    characterCardHistoryPath: resolveCharacterCardHistoryPath(pathSnapshot.companionDataDir),
    config: backupConfig,
  });
  log.info('Scheduled backups enabled', {
    intervalMs: backupConfig.intervalMs,
    maxRotatingBackups: backupConfig.maxRotatingBackups,
    maxWeeklyBackups: backupConfig.maxWeeklyBackups,
    maxMonthlyBackups: backupConfig.maxMonthlyBackups,
    backupRootDir: backupConfig.rootDir,
    mirrorDir: backupConfig.mirrorDir || '(none)',
    verifyRestore: backupConfig.verifyRestore,
  });
  runtimeAny.scheduler.registerHeartbeat(async () => {
    const now = Date.now();
    const taskCount = runtimeAny.scheduler.taskCount;
    await runtimeAny.eventBus.emit('schedule.heartbeat', { timestamp: now, taskCount });
  });
  const postTurnActions = wirePostTurnActionRuntime({
    eventBus: runtimeAny.eventBus,
    scheduler: runtimeAny.scheduler,
    agentLoop: runtimeAny.agentLoop,
    eligibilityGate,
    persistencePath: resolvePostTurnActionQueuePath(pathSnapshot.companionDataDir),
  });
  runtimeAny.eventBus.on('agent.turn.end', ({ message, response }) => {
    const captured = runtimeAny.sessionManager.recordCompressionFailureFromResponse(
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

  log.info(`Memory system enabled (${embeddingProvider.dims}d embeddings via ${embeddingProvider.kind})`);

  // Shard manager — allows the companion to spawn parallel sub-agents
  runtimeAny.moduleLoader = new ModuleLoader({
    eventBus: runtimeAny.eventBus,
    registerTool: (tool, category) => runtimeAny.agentLoop.registerTool(tool, category),
  });

  const replConfig = buildReplConfig(runtimeAny.config);
  runtimeAny.shardManager = wireShardAndThinkRuntime({
    agentLoop: runtimeAny.agentLoop,
    eventBus: runtimeAny.eventBus,
    llmProvider: runtimeAny.llmClient,
    embeddingService: embeddingProvider,
    sessionStore: runtimeAny.sessionStore,
    memoryStore: runtimeAny.memoryStore,
    sessionManager: runtimeAny.sessionManager,
    config: runtimeAny.config,
    parentSystemPrompt: systemPrompt,
    runtimeMode: 'single',
    companionDataDir: pathSnapshot.companionDataDir,
    scheduler: runtimeAny.scheduler,
    replConfig,
    shardAuditTrail: safeguardAuditTrail,
    getCapabilityTier: () => runtimeAny.capabilityRuntime.getTier(),
    compositionalPolicy: runtimeAny.config.compositionalPolicy,
    moduleInstallConfirmationQueue: cardProposalQueue,
    onModuleRegistryMutation: async (mutation) => {
      await runtimeAny.moduleLoader?.applyRegistryMutation(mutation);
    },
  });

  // Memory write/import tools — intentional memory creation
  const memoryWriter = new MemoryWriter(runtimeAny.memoryStore, embeddingProvider);
  intentionRuntime.behavioralPatternTracker.setPromotionHook(
    createBehavioralPatternMemoryPromotionHook(memoryWriter),
  );
  registerMemoryTools(runtimeAny.agentLoop, {
    writer: memoryWriter,
    memoryStore: runtimeAny.memoryStore,
  });
  log.info('Context feedback runtime deferred (Phase VI): background context-scoring LLM calls disabled');

  // Git tools — self-modification via git
  wireGitRuntime(runtimeAny.agentLoop, {
    repoRoot: process.cwd(),
    allowedPaths: [...REPO_ALLOWED_PATHS],
  });
  log.info('Git self-modification tools enabled');

  // Vault tools — Obsidian note read/write (conditional on vault name)
  if (runtimeAny.config.obsidianVaultName) {
    const { wireVaultRuntime } = await import('./vault/runtime-wiring.js');
    wireVaultRuntime(runtimeAny.agentLoop, {
      vaultName: runtimeAny.config.obsidianVaultName,
      cliPath: runtimeAny.config.obsidianCliPath,
      timeoutMs: runtimeAny.config.obsidianTimeoutMs,
    });
    log.info('Obsidian vault tools enabled', { vault: runtimeAny.config.obsidianVaultName });
  }

  // Validate tool wiring — catch misconfigured tools before they crash at invocation
  runtimeAny.agentLoop.validateToolWiring('single');

  const moduleSummary = await runtimeAny.moduleLoader.loadEnabledModules();
  log.info('Runtime modules initialized', moduleSummary);
  log.info('Re-validating tool wiring after module load', {
    mode: lifecycleRuntimeContract.mode,
    loadedModules: moduleSummary.loaded,
    failedModules: moduleSummary.failed,
  });
  runtimeAny.agentLoop.validateToolWiring('single');

  const channelsConfig = loadRuntimeChannelsConfig(
    pathSnapshot.systemDataDir,
    process.env,
    buildRuntimeChannelsConfigOverrides(runtimeAny.config, settingsDomains.runtime),
    { credentialVault: runtimeAny.config.credentialVault },
  );

  const channelFactoryManifest = buildChannelAdapterFactoryManifest([
    createDiscordChannelAdapterFactoryEntry({
      config: runtimeAny.config,
      eventBus: runtimeAny.eventBus,
      sessionStore: runtimeAny.sessionStore,
      agentLoop: runtimeAny.agentLoop,
      eligibilityGate,
    }),
    createOpenHomeChannelAdapterFactoryEntry(),
    createTelegramChannelAdapterFactoryEntry({
      config: channelsConfig.telegram,
      eventBus: runtimeAny.eventBus,
      onMessage: (message) => runtimeAny.agentLoop.handleMessage(message),
    }),
  ]);
  await loadChannelAdaptersFromManifest(
    runtimeAny.channelRegistry,
    channelFactoryManifest,
    registry => runtimeAny.agentLoop.setChannelRegistry(registry),
    log,
    eligibilityGate,
  );
  runtimeAny.discord = requireChannelAdapter<DiscordAdapter>(runtimeAny.channelRegistry, 'discord');
  if (getOptionalChannelAdapter(runtimeAny.channelRegistry, 'telegram')) {
    log.info('Telegram adapter configured', {
      mode: channelsConfig.telegram.mode,
      allowlistSize: channelsConfig.telegram.allowedUsers.length,
    });
  }

  // Lifecycle notifier — pre-restart, ready, shutdown messages
  const heartbeatChannelId = channelsConfig.discord.heartbeatChannelId || undefined;
  runtimeAny.lifecycleNotifier = new DiscordLifecycleNotifier({
    sender: runtimeAny.discord,
    heartbeatChannelId,
    dataDir: pathSnapshot.companionDataDir,
    startTime: runtimeAny.startTime,
  });

  // Track last-active channel on every incoming message
  runtimeAny.eventBus.on('message.received', ({ message }) => {
    const sessionId = runtimeAny.sessionManager.resolveSessionChannelId(message.channelId);
    writeLastActiveSession(pathSnapshot.companionDataDir, {
      sessionId,
      channelId: message.channelId,
      channelType: inferSessionChannelType(sessionId) ?? message.channelType,
      timestamp: message.timestamp instanceof Date
        ? message.timestamp.getTime()
        : Date.now(),
    });
  });

  // Lifecycle tools — self_restart and self_rebuild
  runtimeAny.agentLoop.registerTool(createRestartTool(
    runtimeAny.lifecycleNotifier,
    () => runtimeAny.stop({
      notifyShutdown: false,
      shutdownReason: 'restart requested',
    }),
    {
      restartSafeguard: lifecycleRestartSafeguard,
      getCapabilityTier: () => runtimeAny.capabilityRuntime.getTier(),
      restartCommand: lifecycleRuntimeContract.restart.command,
      runtimeMode: lifecycleRuntimeContract.mode,
    },
  ));
  runtimeAny.agentLoop.registerTool(createRebuildTool(
    runtimeAny.lifecycleNotifier,
    () => runtimeAny.stop({
      notifyShutdown: false,
      shutdownReason: 'rebuild restart requested',
    }),
    {
      restartSafeguard: lifecycleRestartSafeguard,
      getCapabilityTier: () => runtimeAny.capabilityRuntime.getTier(),
      restartCommand: lifecycleRuntimeContract.restart.command,
      runtimeMode: lifecycleRuntimeContract.mode,
    },
  ));
  runtimeAny.agentLoop.registerTool(createNotifyOperatorTool(
    operatorNotifier,
    {
      rateLimiter: externalRateLimiter,
      defaultChannel: 'discord',
    },
  ));

  // Vault auto-publisher (for heartbeat reflections → Obsidian vault)
  let vaultAutoPublisher: import('./vault/auto-publish.js').VaultAutoPublisher | undefined;
  if (runtimeAny.config.obsidianAutoPublish && runtimeAny.config.obsidianVaultName) {
    const { VaultOps } = await import('./vault/ops.js');
    const { VaultAutoPublisher } = await import('./vault/auto-publish.js');
    const vaultOps = new VaultOps({
      vaultName: runtimeAny.config.obsidianVaultName,
      cliPath: runtimeAny.config.obsidianCliPath,
      timeoutMs: runtimeAny.config.obsidianTimeoutMs,
    });
    vaultAutoPublisher = new VaultAutoPublisher(vaultOps);
    log.info('Vault auto-publish enabled for reflections');
  }

  // Heartbeat reflections — policy-driven multi-template reflection system
  wireHeartbeatRuntime(
    runtimeAny.agentLoop,
    runtimeAny.scheduler,
    runtimeAny.agentLoop,
    runtimeAny.discord,
    pathSnapshot.companionDataDir,
    heartbeatChannelId,
    {
      eventBus: runtimeAny.eventBus,
      llmProvider: runtimeAny.llmClient,
      capabilityTier: runtimeAny.config.capabilityTier,
      compositionalPolicy: runtimeAny.config.compositionalPolicy,
      characterPromptVariablesProvider: buildCharacterPromptVariablesProvider(cardVersionStore),
      memoryWriter,
      sessionManager: runtimeAny.sessionManager,
      emotionState,
      contactStore,
      getActiveConcerns: intentionAppraisalHooks.getActiveConcerns,
      getRecentResolvedConcerns: intentionAppraisalHooks.getRecentResolvedConcerns,
      onIntentionConcernDecision: intentionAppraisalHooks.onIntentionConcernDecision,
      onIntentionFollowUpDecision: intentionAppraisalHooks.onIntentionFollowUpDecision,
      onIntentionFollowUpActivated: intentionAppraisalHooks.onIntentionFollowUpActivated,
      onBehavioralPatternOutcome: intentionBehavioralHooks.onBehavioralPatternOutcome,
      coreMemoryStore,
      postTurnActions,
      intentionAppraisalEnabled: runtimeAny.config.intentionAppraisalEnabled !== false,
      ...(vaultAutoPublisher ? { vaultAutoPublisher } : {}),
    },
  );

  // API server — OpenAI-compatible endpoints
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
      agentLoop: runtimeAny.agentLoop,
      eventBus: runtimeAny.eventBus,
      config: runtimeAny.config,
      eligibilityGate,
    });
    const activeProbeConfig = resolveActiveHealthProbeConfig(process.env);
    const llmActiveProbe = new CachedActiveHealthProbe(activeProbeConfig);
    const embeddingsActiveProbe = new CachedActiveHealthProbe(activeProbeConfig);

    const apiServerManifest = buildChannelAdapterFactoryManifest([
      createApiServerChannelAdapterFactoryEntry({
        port: apiPort,
        host: apiHost,
        agentLoop: runtimeAny.agentLoop,
        eventBus: runtimeAny.eventBus,
        sessionManager: runtimeAny.sessionManager,
        contactStore,
        apiKey: process.env.API_KEY || undefined,
        adminToken: process.env.ADMIN_TOKEN || undefined,
        allowInsecureWithoutAuth,
        corsAllowedOrigins,
        modelName: process.env.API_MODEL_NAME,
        externalChannelProfiles: buildExternalChannelProfiles(channelsConfig),
        healthChecks: {
        memory: () => {
          const stats = runtimeAny.memoryStore.getStats();
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
          const configured = Boolean(runtimeAny.config.primaryModel && runtimeAny.config.primaryProvider);
          const baseMeta = {
            provider: runtimeAny.config.primaryProvider,
            model: runtimeAny.config.primaryModel,
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
            await runtimeAny.llmClient.complete(
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
          if (!runtimeAny.discord.config.enabled) {
            return {
              status: 'degraded',
              detail: 'Discord adapter is disabled',
              meta: runtimeStatusMeta,
            };
          }
          if (!runtimeAny.discord.isConnected()) {
            return {
              status: 'degraded',
              detail: 'Discord client is not connected',
              meta: runtimeStatusMeta,
            };
          }
          return {
            status: 'healthy',
            meta: {
              accountId: runtimeAny.discord.config.accountId ?? null,
              ...runtimeStatusMeta,
            },
          };
        },
        embeddings: async () => {
          const baseMeta = {
            dims: embeddingProvider.dims,
            ...toActiveProbeMeta(activeProbeConfig),
            ...runtimeStatusMeta,
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
            void signal;
            const vector = await embeddingProvider.embed('health probe');
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
          const taskCount = runtimeAny.scheduler.taskCount;
          const hasHeartbeatTask = Boolean(runtimeAny.scheduler.getTask('heartbeat'));
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
        voiceWebSocketRuntime,
      }),
    ]);
    await loadChannelAdaptersFromManifest(
      runtimeAny.channelRegistry,
      apiServerManifest,
      registry => runtimeAny.agentLoop.setChannelRegistry(registry),
      log,
      eligibilityGate,
    );
    log.info(`API server configured on port ${apiPort}`);
  }

  // Model discovery (if LiteLLM is configured)
  const litellmBaseUrl = resolveConfiguredLiteLLMBaseUrl(runtimeAny.config);
  const modelDiscovery = litellmBaseUrl
    ? new ModelDiscovery(litellmBaseUrl, resolveConfiguredLiteLLMApiKey(runtimeAny.config), {
      openRouterModelsApiUrl: runtimeAny.config.openRouterModelsApiUrl ?? '',
    })
    : null;

  // Admin GUI — Garden management surfaces
  if (adminPort) {
    runtimeAny.adminServer = new AdminServer({
      port: adminPort,
      host: adminHost,
      token: process.env.ADMIN_TOKEN || undefined,
      apiBaseUrl: process.env.API_BASE_URL,
      apiHost,
      apiPort,
      memoryStore: runtimeAny.memoryStore,
      sessionStore: runtimeAny.sessionStore,
      sessionManager: runtimeAny.sessionManager,
      scheduler: runtimeAny.scheduler,
      shardManager: runtimeAny.shardManager,
      eventBus: runtimeAny.eventBus,
      characterCard: card,
      config: runtimeAny.config,
      embeddingService: embeddingProvider,
      modelDiscovery,
      contactStore,
      promptStore,
      promptRegistry,
      skillsRuntime,
      cardVersionStore,
      adaptiveToolsStateProvider: runtimeAny.agentLoop,
      confirmationQueueApi: createLocalConfirmationQueueAdminApi(cardProposalQueue),
      toolHealthProvider: createLocalAdminToolHealthProvider(runtimeAny.config),
    });
    await runtimeAny.adminServer.init();
    log.info(`Admin GUI configured on port ${adminPort}`);
  }

  // Wyoming voice bridge — opt-in TCP server for Home Assistant integration
  if (runtimeAny.config.wyomingEnabled) {
    const wyomingPort = runtimeAny.config.wyomingPort ?? 10400;
    const wyomingHost = runtimeAny.config.wyomingHost ?? '127.0.0.1';

    const handleAdapter = createWyomingHandleServiceAdapter({
      handleMessage: (message) => runtimeAny.agentLoop.handleMessage(message),
      eventBus: runtimeAny.eventBus,
    });

    const wyomingAdapters = [handleAdapter];

    try {
      const runtimeStt = createRuntimeVoiceSttConnector(runtimeAny.config, {
        eligibilityGate,
      });
      if (runtimeStt) {
        const { provider, connector } = runtimeStt;
        const sttConnector = connector;
        wyomingAdapters.push(createWyomingAsrServiceAdapter({ stt: sttConnector }));
        log.info('Wyoming ASR adapter enabled', { provider });
      }
    } catch (error) {
      if (!(error instanceof EligibilityDeniedError)) {
        throw error;
      }
      log.info('Wyoming ASR adapter disabled by eligibility gate', {
        provider: resolveRuntimeVoiceSttProvider(runtimeAny.config),
        error: error.message,
      });
    }

    try {
      const runtimeTts = createRuntimeVoiceTtsConnector(runtimeAny.config, {
        requireElevenLabsVoiceId: true,
        eligibilityGate,
      });
      if (runtimeTts) {
        wyomingAdapters.push(createWyomingTtsServiceAdapter({ tts: runtimeTts.connector }));
        log.info('Wyoming TTS adapter enabled', { provider: runtimeTts.provider });
      }
    } catch (error) {
      if (error instanceof EligibilityDeniedError) {
        log.info('Wyoming TTS adapter disabled by eligibility gate', {
          provider: resolveRuntimeVoiceTtsProvider(runtimeAny.config),
          error: error.message,
        });
      } else {
        log.warn('Wyoming TTS adapter could not be created', { error: String(error) });
      }
    }

    const serviceRegistry = createWyomingServiceRegistry(wyomingAdapters);

    runtimeAny.wyomingTcpServer = new WyomingTcpServer(
      { port: wyomingPort, host: wyomingHost, eventBus: runtimeAny.eventBus },
      {
        onFrame: (session, frame) => runtimeAny.wyomingRuntime!.handleFrame(session, frame),
        onSessionClose: (session) => runtimeAny.wyomingRuntime!.closeConnection(session.connectionId),
      },
    );

    runtimeAny.wyomingRuntime = new WyomingRuntime({
      info: {
        name: DEFAULT_COMPANION_ID,
        version: '1.0.0',
        description: 'Companion Substrate Framework — Wyoming voice bridge',
        services: serviceRegistry.services,
      } as WyomingInfoData,
      emitFrame: (session, frame) => runtimeAny.wyomingTcpServer!.send(session, frame),
      serviceRegistry,
      eventBus: runtimeAny.eventBus,
    });

    log.info(`Wyoming voice bridge configured on ${wyomingHost}:${wyomingPort}`);
  }

  await runtimeAny.eventBus.emit('system.init', {});
  log.info('Initialized');
}



export type { RuntimeStopOptions };
