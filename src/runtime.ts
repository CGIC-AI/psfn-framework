import type Database from 'better-sqlite3';
import type { SubstrateConfig, Lifecycle } from './types.js';
import { createComponentLogger } from './logger.js';
import { EventBus } from './event-bus.js';
import { CharacterCardVersionStore } from './identity/card-versioning.js';
import {
  composeSystemPromptTemplate,
} from './identity/loader.js';
import { LLMClient } from './llm/client.js';
import { SessionStore, type CrashRecoveryExtractionCandidate } from './session/store.js';
import { SessionManager } from './session/manager.js';
import { buildSessionHmacKeyring } from './session/journal-utils.js';
import { createKeyringIntegrityProvider } from './session/store-primitives.js';
import { SubstrateAgent } from './agent/substrate-agent.js';
import { EmotionObserver } from './emotion/observer.js';
import { EmotionState } from './emotion/state.js';
import { getSharedAudioEmotionClassifier } from './emotion/audio-classifier.js';
import type { DiscordAdapter } from './channels/discord/adapter.js';
import { MemoryStore } from './memory/store.js';
import { MemoryJournal } from './memory/journal.js';
import { MemoryExtractor } from './memory/extraction.js';
import { SalienceDecay } from './memory/decay.js';
import { Scheduler } from './scheduler/scheduler.js';
import { ShardManager } from './shards/manager.js';
import { SubagentFaculty } from './subagents/faculty.js';
import {
  CachedActiveHealthProbe,
  resolveActiveHealthProbeConfig,
  toActiveProbeMeta,
} from './channels/api/active-health-probe.js';
import type {
  ChannelAdapter,
} from './channels/types.js';
import { createApiVoiceWebSocketRuntime } from './channels/api/voice-websocket-runtime.js';
import { AdminServer } from './channels/admin/server.js';
import { createLocalAdminToolHealthProvider } from './channels/admin/tool-health-provider.js';
import { ModelDiscovery } from './llm/discovery.js';
import { getIgnoredJsonBackedConfigEnvKeys } from './config/legacy-env.js';
import {
  resolveConfiguredLiteLLMApiKeyEnv,
  resolveConfiguredLiteLLMBaseUrl,
} from './config/providers-config.js';
import { resolveBackupRuntimeConfig } from './backup/config.js';
import { registerScheduledBackupTask } from './backup/service.js';
import {
  runDatabaseIntegrityCheck,
  validateEmbeddingDimensions,
} from './backup/startup-checks.js';
import { initDatabase } from './persistence/sqlite-utils.js';
import { parseOptionalPositiveIntEnv } from './utils/env.js';
import {
  DiscordLifecycleNotifier,
  writeLastActiveSession,
} from './lifecycle/notifications.js';
import type { LifecycleNotifier } from './lifecycle/notifications.js';
import {
  RUNTIME_MODE,
  resolveRuntimeModeContract,
  toRuntimeStatusMetadata,
} from './lifecycle/runtime-mode.js';
import { inferSessionChannelType } from './session/session-id.js';
import { createRestartTool, createRebuildTool } from './tools/lifecycle.js';
import { createHttpNtfyNotifierFromEnv, createNotifyOperatorTool } from './tools/ntfy.js';
import { MemoryWriter } from './memory/writer.js';
import { DEFAULT_COMPANION_ID } from './identity/companion-naming.js';
import { registerMemoryTools } from './memory/runtime-wiring.js';
import { wireContactRuntime } from './contacts/runtime-wiring.js';
import { wireGitRuntime } from './git/runtime-wiring.js';
import { wireImageRuntime } from './images/runtime-wiring.js';
import { wireSkillsRuntime } from './skills/runtime-wiring.js';
import {
  createIntentionAppraisalHooks,
  createIntentionBehavioralPatternHooks,
  wireIntentionRuntime,
} from './intention/runtime-wiring.js';
import { createBehavioralPatternMemoryPromotionHook } from './intention/patterns.js';
import { attachTerminalDebugObserver } from './debug/terminal-observer.js';
import {
  composeIdentity,
  composeSessionRuntime,
  createEmbeddingProviderFromConfig,
  composeSubstrateAgent,
  wireSelfModelRuntime,
  wireCoreMemoryRuntime,
  wireMemoryRuntime,
  wireShardAndThinkRuntime,
} from './bootstrap/composition.js';
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
} from './bootstrap/parity.js';
import { wirePostTurnActionRuntime } from './bootstrap/post-turn-actions.js';
import { attachVoiceObservers } from './voice/observers/index.js';
import { buildExternalChannelProfiles, loadRuntimeChannelsConfig } from './channels/config.js';
import { WyomingTcpServer } from './channels/wyoming/server.js';
import { WyomingRuntime } from './channels/wyoming/runtime.js';
import { createWyomingServiceRegistry } from './channels/wyoming/services/index.js';
import { createWyomingHandleServiceAdapter } from './channels/wyoming/services/handle.js';
import { createWyomingAsrServiceAdapter } from './channels/wyoming/services/asr.js';
import { createWyomingTtsServiceAdapter } from './channels/wyoming/services/tts.js';
import type { WyomingInfoData } from './channels/wyoming/protocol.js';
import { CapabilityRuntime } from './capabilities/runtime.js';
import {
  createEligibilityGate,
  EligibilityDeniedError,
} from './capabilities/eligibility.js';
import { REPO_ALLOWED_PATHS } from './security/policy-constants.js';
import {
  createSafeguardAuditTrail,
  createIdentityCoolingOffManagerFromEnv,
  createLifecycleRestartSafeguardFromEnv,
  createExternalCommunicationRateLimiterFromEnv,
} from './capabilities/safeguards.js';
import { ConfirmationQueue } from './capabilities/confirmation-queue.js';
import { ModuleLoader } from './modules/loader.js';
import {
  resolveCharacterCardHistoryPath,
  resolveConfiguredCompanionDataDir,
  resolveContactsDir,
  resolveMemoryJournalPath,
  resolveNotesDir,
  resolvePostTurnActionQueuePath,
  resolveScratchpadMirrorPath,
  resolveSessionsDir,
} from './persistence/layout.js';
import {
  buildRuntimeChannelsConfigOverrides,
  createRuntimeVoiceSttConnector,
  createRuntimeVoiceTtsConnector,
  createEmbeddingDimensionMismatchFatalMessage,
  hydrateCanonicalStartupConfig,
  resolveRuntimeVoiceSttProvider,
  resolveRuntimeVoiceTtsProvider,
  type StartupConfigHydrationDiagnostics,
} from './runtime/bootstrap-helpers.js';
import {
  isExplicitTrue,
  parseCommaSeparatedEnv,
  parseExtractionDrainTimeoutMs,
} from './runtime/env-parsing.js';
import {
  createStartupTextEmotionClassifier,
  warmRuntimeMlServices,
} from './runtime/ml-warmup.js';
import { createPromptGenerationFailureAlertHandler } from './runtime/operator-alerts.js';
import { resolveApiCorsAllowedOrigins } from './channels/api/http-policy.js';
import {
  buildChannelAdapterFactoryManifest,
  loadChannelAdaptersFromManifest,
  startChannelAdapters,
  stopChannelAdapters,
} from './runtime/channel-lifecycle.js';
import { emitEligibilityDecisionTelemetry } from './runtime/eligibility-telemetry.js';
import { runShutdownStep as runShutdownStepWithRetry } from './runtime/shutdown-helpers.js';
import {
  createApiServerChannelAdapterFactoryEntry,
  createDiscordChannelAdapterFactoryEntry,
  createOpenHomeChannelAdapterFactoryEntry,
  createTelegramChannelAdapterFactoryEntry,
  getOptionalChannelAdapter,
  requireChannelAdapter,
} from './bootstrap/channel-runtime.js';
export {
  buildRuntimeChannelsConfigOverrides,
  createEmbeddingDimensionMismatchFatalMessage,
};

const log = createComponentLogger('Runtime');
const DEFAULT_EXTRACTION_DRAIN_TIMEOUT_MS = 10_000;
const COMPACTION_GUIDELINE_REVIEW_TASK_ID = 'compaction-guideline-review';

interface RuntimeStopOptions {
  notifyShutdown?: boolean;
  shutdownReason?: string;
}

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
  private subagentFaculty!: SubagentFaculty;
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
  private crashRecoveryRetryBacklog = new Map<string, CrashRecoveryExtractionCandidate>();
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private startTime: number;

  constructor(config: SubstrateConfig) {
    this.config = config;
    this.eventBus = new EventBus();
    this.stopVoiceObservers = attachVoiceObservers(this.eventBus);
    this.stopDebugObserver = attachTerminalDebugObserver(this.eventBus, { scope: 'runtime' });
    this.startTime = Date.now();
  }

  private async startChannels(): Promise<void> {
    await startChannelAdapters(
      this.channelRegistry,
      registry => this.agentLoop.setChannelRegistry(registry),
      log,
    );
  }

  private async stopChannels(): Promise<void> {
    await stopChannelAdapters(this.channelRegistry);
  }

  private seedCrashRecoveryRetryBacklog(candidates: CrashRecoveryExtractionCandidate[]): void {
    this.crashRecoveryRetryBacklog.clear();
    for (const candidate of candidates) {
      this.crashRecoveryRetryBacklog.set(candidate.channelId, candidate);
    }
  }

  private refreshCrashRecoveryRetryBacklog(channelId: string): boolean {
    const sessionStore = this.sessionStore;
    if (typeof sessionStore.getCrashRecoveryExtractionCandidates !== 'function') {
      return this.crashRecoveryRetryBacklog.has(channelId);
    }

    const candidate = sessionStore
      .getCrashRecoveryExtractionCandidates()
      .find(item => item.channelId === channelId);
    if (candidate) {
      this.crashRecoveryRetryBacklog.set(channelId, candidate);
      return true;
    }

    this.crashRecoveryRetryBacklog.delete(channelId);
    return false;
  }

  private resolveUnresolvedCrashRecoveryChannels(): Set<string> {
    const sessionStore = this.sessionStore;
    if (typeof sessionStore.getCrashRecoveryExtractionCandidates !== 'function') {
      return new Set(this.crashRecoveryRetryBacklog.keys());
    }

    const unresolvedCandidates = sessionStore.getCrashRecoveryExtractionCandidates();
    const unresolvedChannelIds = new Set(unresolvedCandidates.map(candidate => candidate.channelId));

    for (const candidate of unresolvedCandidates) {
      this.crashRecoveryRetryBacklog.set(candidate.channelId, candidate);
    }
    for (const channelId of [...this.crashRecoveryRetryBacklog.keys()]) {
      if (!unresolvedChannelIds.has(channelId)) {
        this.crashRecoveryRetryBacklog.delete(channelId);
      }
    }

    return unresolvedChannelIds;
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
      this.crashRecoveryRetryBacklog.set(candidate.channelId, candidate);
      void this.memoryExtractor.queueRetroactiveExtraction(
        candidate.channelId,
        candidate.unextractedEntries,
      )
        .catch((error) => {
          log.error('Crash recovery extraction queue failed', {
            channelId: candidate.channelId,
            error: String(error),
          });
        })
        .finally(() => {
          let unresolved = false;
          try {
            unresolved = this.refreshCrashRecoveryRetryBacklog(candidate.channelId);
          } catch (error) {
            log.error('Crash recovery retry bookkeeping failed', {
              channelId: candidate.channelId,
              error: String(error),
            });
            return;
          }
          if (!unresolved) return;

          const pending = this.crashRecoveryRetryBacklog.get(candidate.channelId);
          log.warn('Crash recovery extraction remains unresolved; retry deferred to next startup', {
            channelId: candidate.channelId,
            pendingEntryCount: pending?.unextractedEntries.length
              ?? candidate.unextractedEntries.length,
          });
        });
    }
  }

  private restoreLatestSessionMetadata(): void {
    const companionDataDir = resolveConfiguredCompanionDataDir(this.config);
    const behavior = this.config.sessionRestartBehavior ?? 'reuse_latest_session';
    const resolved = this.sessionManager.resolveStartupSessionMetadata(behavior);
    if (!resolved) return;

    writeLastActiveSession(companionDataDir, resolved);
    if (behavior === 'new_session') {
      log.info('Initialized fresh startup session metadata', {
        sessionId: resolved.sessionId,
        channelType: resolved.channelType ?? 'unknown',
        timestamp: resolved.timestamp,
      });
      return;
    }

    log.info('Restored latest session metadata', {
      sessionId: resolved.sessionId,
      channelType: resolved.channelType ?? 'unknown',
      timestamp: resolved.timestamp,
    });
  }

  async init(): Promise<void> {
    log.info('Initializing...');
    const ignoredMutableEnvKeys = getIgnoredJsonBackedConfigEnvKeys(process.env);
    if (ignoredMutableEnvKeys.length > 0) {
      log.warn('Ignoring JSON-owned config env vars; move runtime config into system-data JSON files and keep .env for secrets/bootstrap wiring only', {
        keys: ignoredMutableEnvKeys,
      });
    }

    const startupHydration = hydrateCanonicalStartupConfig(this.config, {
      env: process.env,
    });
    const {
      systemDataDir,
      companionDataDir,
      runtimePathLayout,
      settingsDomains,
      trustPolicyConfig,
      schedulerConfig,
    } = startupHydration;
    logStartupHydrationDiagnostics(startupHydration.diagnostics);

    const lifecycleRuntimeContract = resolveRuntimeModeContract({
      entrypoint: RUNTIME_MODE.SINGLE,
      runtimeModeEnv: process.env.PSFN_RUNTIME_MODE,
      restartCommandEnv: process.env.LIFECYCLE_RESTART_COMMAND,
    });
    const runtimeStatusMeta = toRuntimeStatusMetadata(lifecycleRuntimeContract);
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
      dataDir: companionDataDir,
      defaultRootDir: runtimePathLayout.backupsDir,
    });
    this.capabilityRuntime = new CapabilityRuntime({
      dataDir: systemDataDir,
      seedDir: process.env.CONFIG_DIR,
    });
    this.config.capabilityTier = this.capabilityRuntime.getTier();
    const eligibilityGate = createEligibilityGate(
      () => this.capabilityRuntime,
      (decision) => emitEligibilityDecisionTelemetry(this.eventBus, decision, log),
    );

    // Open database
    this.db = initDatabase(this.config.databasePath);
    runDatabaseIntegrityCheck(this.db);
    log.info('SQLite integrity check passed');

    // Load identity
    const {
      card,
      systemPrompt,
    } = composeIdentity(this.config);
    const cardVersionStore = new CharacterCardVersionStore(
      this.config.characterCardPath,
      resolveCharacterCardHistoryPath(companionDataDir),
    );
    log.info(`Loaded character: ${card.data.name}`);
    this.config.characterName = card.data.name;
    const promptRegistry = wireStaticPromptRegistry(companionDataDir);
    const cardProposalQueue = new ConfirmationQueue();

    // Initialize core components
    this.llmClient = new LLMClient(this.config, {
      eligibilityGate,
      onBudgetBlocked: (event) => {
        this.eventBus.emit('model.budget.blocked', event).catch((error) => {
          log.error('Failed to emit model budget blocked telemetry', {
            error: error instanceof Error ? error.message : String(error),
            provider: event.provider,
            model: event.model,
            reason: event.reason,
          });
        });
      },
    });
    const sessionsDir = resolveSessionsDir(companionDataDir);
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
    this.seedCrashRecoveryRetryBacklog(this.crashRecoveryQueue);
    this.restoreLatestSessionMetadata();

    // Embedding provider (selected by EMBEDDING_PROVIDER)
    const embeddingProvider = createEmbeddingProviderFromConfig(this.config);
    log.info('Embedding provider initialized', {
      provider: embeddingProvider.kind,
      dims: embeddingProvider.dims,
    });

    const notesDir = resolveNotesDir(companionDataDir);
    this.memoryStore = new MemoryStore(this.db, embeddingProvider.dims, {
      notesDir,
      scratchpadMirrorPath: resolveScratchpadMirrorPath(companionDataDir),
      journal: new MemoryJournal(resolveMemoryJournalPath(companionDataDir)),
    });
    const embeddingDimensionCheck = validateEmbeddingDimensions(
      this.db,
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
      model: this.config.textEmotionModel,
      cacheDir: this.config.textEmotionCacheDir,
      dtype: this.config.textEmotionDtype,
    });
    await warmRuntimeMlServices({
      textClassifier,
      embeddingService: embeddingProvider,
      textEmotionModel: this.config.textEmotionModel!.trim(),
      logger: log,
    });
    const emotionObserver = new EmotionObserver({
      textClassifier,
      audioClassifier: getSharedAudioEmotionClassifier(),
    });
    const emotionState = new EmotionState();
    const operatorNotifier = createHttpNtfyNotifierFromEnv();
    this.agentLoop = composeSubstrateAgent({
      eventBus: this.eventBus,
      llmProvider: this.llmClient,
      sessionManager: this.sessionManager,
      systemPrompt,
      characterName: card.data.name,
      characterPromptVariablesProvider: buildCharacterPromptVariablesProvider(cardVersionStore),
      config: this.config,
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
    this.agentLoop.scratchpadProvider = this.memoryStore;
    this.agentLoop.setCapabilityRuntime(this.capabilityRuntime);
    const safeguardAuditTrail = createSafeguardAuditTrail(companionDataDir);
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
      dataDir: systemDataDir,
      seedDir: process.env.CONFIG_DIR,
      repoRoot: process.cwd(),
    });
    wireFilesystemToolsRuntime(this.agentLoop, process.cwd());
    wireImageRuntime(this.agentLoop, this.config);

    // Prompt stack — layered, editable system prompt
    const promptStore = wirePromptRuntime(
      this.agentLoop,
      companionDataDir,
      composeSystemPromptTemplate(),
      {
        identityCoolingOff,
        getCapabilityTier: () => this.capabilityRuntime.getTier(),
      },
    );
    wireCharacterCardRuntime(this.agentLoop, cardVersionStore, {
      getCapabilityTier: () => this.capabilityRuntime.getTier(),
      confirmationQueue: cardProposalQueue,
    });
    wireSettingsRuntime(this.agentLoop, this.config);
    wireSessionToolsRuntime(this.agentLoop, this.sessionManager, companionDataDir, this.llmClient);
    const coreMemoryStore = wireCoreMemoryRuntime({
      agentLoop: this.agentLoop,
      sessionManager: this.sessionManager,
      config: this.config,
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
      {
        exportDir: resolveContactsDir(companionDataDir),
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
    const intentionRuntime = wireIntentionRuntime(this.agentLoop, this.db);
    wireSelfModelRuntime(this.agentLoop);
    const intentionAppraisalHooks = createIntentionAppraisalHooks(
      intentionRuntime.concernStore,
      intentionRuntime.pendingFollowUpStore,
      intentionRuntime.careReminderStore,
    );
    const intentionBehavioralHooks = createIntentionBehavioralPatternHooks(
      intentionRuntime.behavioralPatternTracker,
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

    // Scheduler — the companion's internal clock
    this.scheduler = new Scheduler(this.eventBus, {
      tickIntervalMs: schedulerConfig.tickIntervalMs,
      heartbeatIntervalMs: schedulerConfig.heartbeatIntervalMs,
    }, {
      eligibilityGate,
    });
    this.scheduler.register({
      id: 'salience-decay',
      name: 'Memory Salience Decay',
      type: 'every',
      intervalMs: this.config.maintenanceIntervalMs,
      handler: () => this.salienceDecay.run(),
      eligibility: { requiredTokens: ['memory.write'] },
      state: 'idle',
    });
    this.scheduler.register({
      id: COMPACTION_GUIDELINE_REVIEW_TASK_ID,
      name: 'Compression Guideline Review',
      type: 'every',
      intervalMs: this.config.maintenanceIntervalMs,
      handler: async () => {
        const result = await this.sessionManager.runPeriodicCompressionGuidelineUpdate(this.llmClient);
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
      scheduler: this.scheduler,
      db: this.db,
      databasePath: this.config.databasePath,
      sessionsDir,
      memoriesJournalPath: resolveMemoryJournalPath(companionDataDir),
      characterCardPath: this.config.characterCardPath,
      characterCardHistoryPath: resolveCharacterCardHistoryPath(companionDataDir),
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
    this.scheduler.registerHeartbeat(async () => {
      const now = Date.now();
      const taskCount = this.scheduler.taskCount;
      await this.eventBus.emit('schedule.heartbeat', { timestamp: now, taskCount });
    });
    const postTurnActions = wirePostTurnActionRuntime({
      eventBus: this.eventBus,
      scheduler: this.scheduler,
      agentLoop: this.agentLoop,
      eligibilityGate,
      persistencePath: resolvePostTurnActionQueuePath(companionDataDir),
    });
    this.eventBus.on('agent.turn.end', ({ message, response }) => {
      const captured = this.sessionManager.recordCompressionFailureFromResponse(
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
      runtimeMode: 'single',
      companionDataDir,
      scheduler: this.scheduler,
      replConfig,
      shardAuditTrail: safeguardAuditTrail,
      getCapabilityTier: () => this.capabilityRuntime.getTier(),
      compositionalPolicy: this.config.compositionalPolicy,
      moduleInstallConfirmationQueue: cardProposalQueue,
      onModuleRegistryMutation: async (mutation) => {
        await this.moduleLoader?.applyRegistryMutation(mutation);
      },
      onSubagentFacultyReady: (faculty) => {
        this.subagentFaculty = faculty;
      },
    });

    // Memory write/import tools — intentional memory creation
    const memoryWriter = new MemoryWriter(this.memoryStore, embeddingProvider);
    intentionRuntime.behavioralPatternTracker.setPromotionHook(
      createBehavioralPatternMemoryPromotionHook(memoryWriter),
    );
    registerMemoryTools(this.agentLoop, {
      writer: memoryWriter,
      memoryStore: this.memoryStore,
    });
    log.info('Context feedback runtime deferred (Phase VI): background context-scoring LLM calls disabled');

    // Git tools — self-modification via git
    wireGitRuntime(this.agentLoop, {
      repoRoot: process.cwd(),
      allowedPaths: [...REPO_ALLOWED_PATHS],
    });
    log.info('Git self-modification tools enabled');

    // Vault tools — Obsidian note read/write (conditional on vault name)
    if (this.config.obsidianVaultName) {
      const { wireVaultRuntime } = await import('./vault/runtime-wiring.js');
      wireVaultRuntime(this.agentLoop, {
        vaultName: this.config.obsidianVaultName,
        cliPath: this.config.obsidianCliPath,
        timeoutMs: this.config.obsidianTimeoutMs,
      });
      log.info('Obsidian vault tools enabled', { vault: this.config.obsidianVaultName });
    }

    // Validate tool wiring — catch misconfigured tools before they crash at invocation
    this.agentLoop.validateToolWiring('single');

    const moduleSummary = await this.moduleLoader.loadEnabledModules();
    log.info('Runtime modules initialized', moduleSummary);
    log.info('Re-validating tool wiring after module load', {
      mode: lifecycleRuntimeContract.mode,
      loadedModules: moduleSummary.loaded,
      failedModules: moduleSummary.failed,
    });
    this.agentLoop.validateToolWiring('single');

    const channelsConfig = loadRuntimeChannelsConfig(
      systemDataDir,
      process.env,
      buildRuntimeChannelsConfigOverrides(this.config, settingsDomains.runtime),
    );

    const channelFactoryManifest = buildChannelAdapterFactoryManifest([
      createDiscordChannelAdapterFactoryEntry({
        config: this.config,
        eventBus: this.eventBus,
        sessionStore: this.sessionStore,
        agentLoop: this.agentLoop,
        eligibilityGate,
      }),
      createOpenHomeChannelAdapterFactoryEntry(),
      createTelegramChannelAdapterFactoryEntry({
        config: channelsConfig.telegram,
        eventBus: this.eventBus,
        onMessage: (message) => this.agentLoop.handleMessage(message),
      }),
    ]);
    await loadChannelAdaptersFromManifest(
      this.channelRegistry,
      channelFactoryManifest,
      registry => this.agentLoop.setChannelRegistry(registry),
      log,
      eligibilityGate,
    );
    this.discord = requireChannelAdapter<DiscordAdapter>(this.channelRegistry, 'discord');
    if (getOptionalChannelAdapter(this.channelRegistry, 'telegram')) {
      log.info('Telegram adapter configured', {
        mode: channelsConfig.telegram.mode,
        allowlistSize: channelsConfig.telegram.allowedUsers.length,
      });
    }

    // Lifecycle notifier — pre-restart, ready, shutdown messages
    const heartbeatChannelId = channelsConfig.discord.heartbeatChannelId || undefined;
    this.lifecycleNotifier = new DiscordLifecycleNotifier({
      sender: this.discord,
      heartbeatChannelId,
      dataDir: companionDataDir,
      startTime: this.startTime,
    });

    // Track last-active channel on every incoming message
    this.eventBus.on('message.received', ({ message }) => {
      const sessionId = this.sessionManager.resolveSessionChannelId(message.channelId);
      writeLastActiveSession(companionDataDir, {
        sessionId,
        channelId: message.channelId,
        channelType: inferSessionChannelType(sessionId) ?? message.channelType,
        timestamp: message.timestamp instanceof Date
          ? message.timestamp.getTime()
          : Date.now(),
      });
    });

    // Lifecycle tools — self_restart and self_rebuild
    this.agentLoop.registerTool(createRestartTool(
      this.lifecycleNotifier,
      () => this.stop({
        notifyShutdown: false,
        shutdownReason: 'restart requested',
      }),
      {
        restartSafeguard: lifecycleRestartSafeguard,
        getCapabilityTier: () => this.capabilityRuntime.getTier(),
        restartCommand: lifecycleRuntimeContract.restart.command,
        runtimeMode: lifecycleRuntimeContract.mode,
      },
    ));
    this.agentLoop.registerTool(createRebuildTool(
      this.lifecycleNotifier,
      () => this.stop({
        notifyShutdown: false,
        shutdownReason: 'rebuild restart requested',
      }),
      {
        restartSafeguard: lifecycleRestartSafeguard,
        getCapabilityTier: () => this.capabilityRuntime.getTier(),
        restartCommand: lifecycleRuntimeContract.restart.command,
        runtimeMode: lifecycleRuntimeContract.mode,
      },
    ));
    this.agentLoop.registerTool(createNotifyOperatorTool(
      operatorNotifier,
      {
        rateLimiter: externalRateLimiter,
        defaultChannel: 'discord',
      },
    ));

    // Vault auto-publisher (for heartbeat reflections → Obsidian vault)
    let vaultAutoPublisher: import('./vault/auto-publish.js').VaultAutoPublisher | undefined;
    if (this.config.obsidianAutoPublish && this.config.obsidianVaultName) {
      const { VaultOps } = await import('./vault/ops.js');
      const { VaultAutoPublisher } = await import('./vault/auto-publish.js');
      const vaultOps = new VaultOps({
        vaultName: this.config.obsidianVaultName,
        cliPath: this.config.obsidianCliPath,
        timeoutMs: this.config.obsidianTimeoutMs,
      });
      vaultAutoPublisher = new VaultAutoPublisher(vaultOps);
      log.info('Vault auto-publish enabled for reflections');
    }

    // Heartbeat reflections — policy-driven multi-template reflection system
    wireHeartbeatRuntime(
      this.agentLoop,
      this.scheduler,
      this.agentLoop,
      this.discord,
      companionDataDir,
      heartbeatChannelId,
      {
        eventBus: this.eventBus,
        llmProvider: this.llmClient,
        capabilityTier: this.config.capabilityTier,
        compositionalPolicy: this.config.compositionalPolicy,
        characterPromptVariablesProvider: buildCharacterPromptVariablesProvider(cardVersionStore),
        memoryWriter,
        sessionManager: this.sessionManager,
        emotionState,
        contactStore,
        getActiveConcerns: intentionAppraisalHooks.getActiveConcerns,
        getRecentResolvedConcerns: intentionAppraisalHooks.getRecentResolvedConcerns,
        onIntentionConcernDecision: intentionAppraisalHooks.onIntentionConcernDecision,
        onIntentionFollowUpDecision: intentionAppraisalHooks.onIntentionFollowUpDecision,
        onIntentionFollowUpActivated: intentionAppraisalHooks.onIntentionFollowUpActivated,
        onIntentionReminderDecision: intentionAppraisalHooks.onIntentionReminderDecision,
        onIntentionReminderTriggered: intentionAppraisalHooks.onIntentionReminderTriggered,
        onBehavioralPatternOutcome: intentionBehavioralHooks.onBehavioralPatternOutcome,
        coreMemoryStore,
        postTurnActions,
        intentionAppraisalEnabled: this.config.intentionAppraisalEnabled !== false,
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
        agentLoop: this.agentLoop,
        eventBus: this.eventBus,
        config: this.config,
        eligibilityGate,
      });
      const activeProbeConfig = resolveActiveHealthProbeConfig(process.env);
      const llmActiveProbe = new CachedActiveHealthProbe(activeProbeConfig);
      const embeddingsActiveProbe = new CachedActiveHealthProbe(activeProbeConfig);

      const apiServerManifest = buildChannelAdapterFactoryManifest([
        createApiServerChannelAdapterFactoryEntry({
          port: apiPort,
          host: apiHost,
          agentLoop: this.agentLoop,
          eventBus: this.eventBus,
          sessionManager: this.sessionManager,
          contactStore,
          apiKey: process.env.API_KEY || undefined,
          adminToken: process.env.ADMIN_TOKEN || undefined,
          allowInsecureWithoutAuth,
          corsAllowedOrigins,
          modelName: process.env.API_MODEL_NAME,
          externalChannelProfiles: buildExternalChannelProfiles(channelsConfig),
          healthChecks: {
          memory: () => {
            const stats = this.memoryStore.getStats();
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
            const configured = Boolean(this.config.primaryModel && this.config.primaryProvider);
            const baseMeta = {
              provider: this.config.primaryProvider,
              model: this.config.primaryModel,
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
                meta: runtimeStatusMeta,
              };
            }
            if (!this.discord.isConnected()) {
              return {
                status: 'degraded',
                detail: 'Discord client is not connected',
                meta: runtimeStatusMeta,
              };
            }
            return {
              status: 'healthy',
              meta: {
                accountId: this.discord.config.accountId ?? null,
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
            const taskCount = this.scheduler.taskCount;
            const hasHeartbeatTask = Boolean(this.scheduler.getTask('heartbeat'));
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
        this.channelRegistry,
        apiServerManifest,
        registry => this.agentLoop.setChannelRegistry(registry),
        log,
        eligibilityGate,
      );
      log.info(`API server configured on port ${apiPort}`);
    }

    // Model discovery (if LiteLLM is configured)
    const litellmBaseUrl = resolveConfiguredLiteLLMBaseUrl(this.config);
    const modelDiscovery = litellmBaseUrl
      ? new ModelDiscovery(litellmBaseUrl, process.env[resolveConfiguredLiteLLMApiKeyEnv(this.config)] ?? undefined, {
        openRouterModelsApiUrl: this.config.openRouterModelsApiUrl ?? '',
      })
      : null;

    // Admin GUI — Garden management surfaces
    if (adminPort) {
      this.adminServer = new AdminServer({
        port: adminPort,
        host: adminHost,
        token: process.env.ADMIN_TOKEN || undefined,
        apiBaseUrl: process.env.API_BASE_URL,
        apiHost,
        apiPort,
        memoryStore: this.memoryStore,
        sessionStore: this.sessionStore,
        sessionManager: this.sessionManager,
        scheduler: this.scheduler,
        shardManager: this.shardManager,
        subagentFaculty: this.subagentFaculty,
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
        adaptiveToolsStateProvider: this.agentLoop,
        confirmationQueueApi: {
          listConfirmationQueue: async () => ({ entries: cardProposalQueue.listPending() }),
          resolveConfirmationQueue: (params) => cardProposalQueue.resolve(params),
        },
        toolHealthProvider: createLocalAdminToolHealthProvider(this.config),
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

      try {
        const runtimeStt = createRuntimeVoiceSttConnector(this.config, {
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
          provider: resolveRuntimeVoiceSttProvider(this.config),
          error: error.message,
        });
      }

      try {
        const runtimeTts = createRuntimeVoiceTtsConnector(this.config, {
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
            provider: resolveRuntimeVoiceTtsProvider(this.config),
            error: error.message,
          });
        } else {
          log.warn('Wyoming TTS adapter could not be created', { error: String(error) });
        }
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
          name: DEFAULT_COMPANION_ID,
          version: '1.0.0',
          description: 'Companion Substrate Framework — Wyoming voice bridge',
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

  async stop(options: RuntimeStopOptions = {}): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }

    this.stopPromise = this.stopInternal(options);
    await this.stopPromise;
  }

  private async stopInternal(options: RuntimeStopOptions): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    const shutdownReason = options.shutdownReason?.trim();
    log.info('Shutting down...');
    if (options.notifyShutdown ?? true) {
      await this.runShutdownStep('send graceful shutdown notification', () => this.lifecycleNotifier?.notifyShutdown(
        shutdownReason && shutdownReason.length > 0 ? shutdownReason : undefined,
      ));
    }
    await this.runShutdownStep('emit system.shutdown event', () => this.eventBus.emit('system.shutdown', {}));
    await this.runShutdownStep('stop voice observers', () => {
      this.stopVoiceObservers?.();
      this.stopVoiceObservers = undefined;
    });
    await this.runShutdownStep('stop debug observer', () => {
      this.stopDebugObserver?.();
      this.stopDebugObserver = undefined;
    });
    await this.runShutdownStep('stop scheduler', () => this.scheduler.stop());

    const timeoutMs = parseExtractionDrainTimeoutMs(
      process.env,
      DEFAULT_EXTRACTION_DRAIN_TIMEOUT_MS,
    );
    await this.runShutdownStep('drain memory extractor', async () => {
      const drained = await this.memoryExtractor.stop({ timeoutMs });
      if (drained === false) {
        log.warn('Proceeding with shutdown before extraction drain completed', { timeoutMs });
      }
    });

    const unresolvedCrashRecoveryChannels = this.resolveUnresolvedCrashRecoveryChannels();
    if (unresolvedCrashRecoveryChannels.size > 0) {
      log.warn('Skipping graceful markers for channels with unresolved extraction backlog', {
        channels: [...unresolvedCrashRecoveryChannels],
      });
    }

    await this.runShutdownStep('write graceful shutdown markers', () => {
      const markedChannels = this.sessionStore.markGracefulShutdownForActiveChannels(
        Date.now(),
        { skipChannels: unresolvedCrashRecoveryChannels },
      );
      if (markedChannels.length > 0) {
        log.info('Wrote graceful shutdown markers', { channels: markedChannels });
      }
    });
    await this.runShutdownStep('stop Wyoming runtime', () => this.wyomingRuntime?.stop());
    await this.runShutdownStep('stop Wyoming TCP server', () => this.wyomingTcpServer?.stop());
    await this.runShutdownStep('stop admin server', () => this.adminServer?.stop());
    await this.runShutdownStep('shutdown modules', () => this.moduleLoader?.shutdown());
    await this.runShutdownStep('stop channel adapters', () => this.stopChannels());
    await this.runShutdownStep('close database', () => {
      this.db.close();
    });
    log.info('Stopped');
  }

  private async runShutdownStep(
    step: string,
    action: () => void | Promise<void>,
    maxAttempts = 2,
  ): Promise<void> {
    await runShutdownStepWithRetry(step, action, log, maxAttempts);
  }
}
