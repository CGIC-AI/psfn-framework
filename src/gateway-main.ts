// ── Gateway Entry Point ──
// Host-side process that holds secrets and proxies all external interactions.
// Run: npm run gateway

import 'dotenv/config';
import { ensureActiveTimezone } from './time/active-timezone.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './types.js';
import { createComponentLogger } from './logger.js';
import type { DiscordAdapter } from './channels/discord/adapter.js';
import type { TelegramAdapter } from './channels/telegram/adapter.js';
import { EventBus } from './event-bus.js';
import { GatewayServer } from './gateway/server.js';
import { AuditStore } from './gateway/audit.js';
import { ensureRegistryFile } from './modules/registry.js';
import { attachTerminalDebugObserver } from './debug/terminal-observer.js';
import { DEFAULT_COMPANION_ID } from './identity/companion-naming.js';
import type { SubstrateMessage } from './types.js';
import { WyomingTcpServer } from './channels/wyoming/server.js';
import { WyomingRuntime } from './channels/wyoming/runtime.js';
import { createWyomingServiceRegistry } from './channels/wyoming/services/index.js';
import { createWyomingHandleServiceAdapter } from './channels/wyoming/services/handle.js';
import { createWyomingAsrServiceAdapter } from './channels/wyoming/services/asr.js';
import { createWyomingTtsServiceAdapter } from './channels/wyoming/services/tts.js';
import type { ChannelAdapter } from './channels/types.js';
import type { WyomingInfoData } from './channels/wyoming/protocol.js';
import { CapabilityRuntime } from './capabilities/runtime.js';
import {
  createEligibilityGate,
  EligibilityDeniedError,
  type EligibilityDecision,
} from './capabilities/eligibility.js';
import { GitOps } from './git/ops.js';
import { initDatabase } from './persistence/sqlite-utils.js';
import { resolveGatewayBootstrapInput } from './gateway/bootstrap-input.js';
import {
  createRuntimeVoiceSttConnector,
  createRuntimeVoiceTtsConnector,
  resolveRuntimeVoiceProviderGate,
  type StartupConfigHydrationDiagnostics,
} from './runtime/bootstrap-helpers.js';
import { RUNTIME_MODE } from './lifecycle/runtime-mode.js';
import { applyGatewayTlsConfig } from './gateway/tls.js';
import { startDiscordWithRetry } from './gateway/discord-startup.js';
import { createGatewayPrivilegedServiceRegistry } from './gateway/privileged-services.js';
import { resolveStartupPreflightBundle } from './runtime/startup-preflight.js';
import {
  createDiscordChannelAdapterFactoryEntry,
  createOpenHomeChannelAdapterFactoryEntry,
  createTelegramChannelAdapterFactoryEntry,
  getOptionalChannelAdapter,
  requireChannelAdapter,
} from './bootstrap/channel-runtime.js';
import {
  buildChannelAdapterFactoryManifest,
  loadChannelAdaptersFromManifest,
} from './runtime/channel-lifecycle.js';
import { createSignalShutdownHandler } from './runtime/signal-shutdown.js';

const log = createComponentLogger('Gateway');

ensureActiveTimezone();

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

function emitEligibilityDecision(eventBus: EventBus, decision: EligibilityDecision): void {
  eventBus.emit('capability.eligibility', {
    operationKind: decision.operation.kind,
    operationRef: JSON.stringify(decision.operation),
    allowed: decision.allowed,
    reasonCode: decision.reasonCode,
    tier: decision.tier,
    requiredTokens: decision.requiredTokens,
    missingTokens: decision.missingTokens,
    ...(decision.minimumTier ? { minimumTier: decision.minimumTier } : {}),
    timestamp: Date.now(),
  }).catch((error) => {
    log.warn('Failed to emit capability eligibility telemetry', { error: String(error) });
  });
}

interface GatewayVoiceModuleContext {
  gateway: GatewayServer;
  discord: DiscordAdapter;
  eventBus: EventBus;
}

interface GatewayVoiceModule {
  id: string;
  register?(context: GatewayVoiceModuleContext): void | Promise<void>;
  start?(context: GatewayVoiceModuleContext): void | Promise<void>;
  stop?(context: GatewayVoiceModuleContext): void | Promise<void>;
}

class GatewayVoiceModuleHost {
  private readonly modules: GatewayVoiceModule[] = [];
  private readonly context: GatewayVoiceModuleContext;

  constructor(context: GatewayVoiceModuleContext) {
    this.context = context;
  }

  registerModule(module: GatewayVoiceModule): void {
    this.modules.push(module);
  }

  async registerAll(): Promise<void> {
    for (const module of this.modules) {
      await module.register?.(this.context);
    }
  }

  async startAll(): Promise<void> {
    for (const module of this.modules) {
      await module.start?.(this.context);
    }
  }

  async stopAll(): Promise<void> {
    for (const module of [...this.modules].reverse()) {
      await module.stop?.(this.context);
    }
  }
}

function createDiscordReverseRpcVoiceModule(): GatewayVoiceModule {
  return {
    id: 'discord-reverse-rpc-voice',
    register: ({ gateway, discord }) => {
      discord.setVoiceHandler(async (message) => {
        const result = await gateway.requestAgentVoiceStream(message);
        return {
          content: result.content,
          channelId: result.channelId,
          metadata: {
            model: result.model,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: result.durationMs,
          },
        };
      });
    },
  };
}

async function runShutdownStep(
  step: string,
  action: () => void | Promise<void>,
  maxAttempts = 2,
): Promise<void> {
  const attempts = Math.max(1, Math.floor(maxAttempts));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await action();
      if (attempt > 1) {
        log.info('Shutdown step recovered after retry', {
          step,
          attempt,
          maxAttempts: attempts,
        });
      }
      return;
    } catch (error) {
      if (attempt < attempts) {
        log.warn('Shutdown step failed; retrying', {
          step,
          attempt,
          maxAttempts: attempts,
          error: String(error),
        });
        continue;
      }
      log.error('Shutdown step failed; continuing shutdown', {
        step,
        attempt,
        maxAttempts: attempts,
        error: String(error),
      });
    }
  }
}

async function main(): Promise<void> {
  const env = process.env;
  const config = loadConfig();
  const {
    startupHydration,
  } = resolveStartupPreflightBundle(config, {
    entrypoint: RUNTIME_MODE.GATEWAY_AGENT,
    env,
    logger: log,
  });
  logStartupHydrationDiagnostics(startupHydration.diagnostics);
  const bootstrap = resolveGatewayBootstrapInput({
    config,
    env,
    startupHydration,
  });
  log.info('Loaded trust policy configuration', {
    exactOverrideCount: Object.keys(
      startupHydration.trustPolicyConfig.channelClassification.visibilityOverrides.exact,
    ).length,
    prefixOverrideCount: Object.keys(
      startupHydration.trustPolicyConfig.channelClassification.visibilityOverrides.prefix,
    ).length,
  });
  if (!bootstrap.diagnostics.workspacePathProvided) {
    log.warn('WORKSPACE_PATH not set, defaulting to runtime layout workspace path', {
      workspacePath: bootstrap.workspacePath,
    });
  }
  // ── Apply TLS config early, before any HTTPS connections ──
  applyGatewayTlsConfig({
    caPath: config.gatewayTlsCaPath,
    rejectUnauthorized: config.gatewayTlsRejectUnauthorized,
  });

  const eventBus = new EventBus();
  const stopDebugObserver = attachTerminalDebugObserver(eventBus, { scope: 'gateway' });

  log.info('Initializing...');
  if (startupHydration.systemDataDir !== startupHydration.companionDataDir) {
    log.info('Configured split persistence roots', {
      systemDataDir: startupHydration.systemDataDir,
      companionDataDir: startupHydration.companionDataDir,
    });
  }

  // Ensure gateway socket directory exists
  mkdirSync(dirname(bootstrap.socketPath), { recursive: true });
  mkdirSync(bootstrap.workspaceRoot, { recursive: true });
  if (bootstrap.workspaceRoot !== bootstrap.gitRepoRoot) {
    log.info('Gateway workspace and git roots diverge', {
      workspaceRoot: bootstrap.workspaceRoot,
      gitRepoRoot: bootstrap.gitRepoRoot,
    });
  }
  if (bootstrap.server.ntfy) {
    log.info('Gateway ntfy notifier configured', {
      baseUrl: bootstrap.server.ntfy.baseUrl,
      defaultTopic: bootstrap.server.ntfy.defaultTopic,
    });
  } else if (bootstrap.diagnostics.ntfyConfigIncomplete) {
    log.warn('ntfy alerts disabled: both NTFY_BASE_URL and NTFY_TOPIC are required');
  }
  if (bootstrap.fullCodebaseReadRoot) {
    log.warn('YOLO runtime mode active: full-codebase fs.read is enabled', {
      runtimeMode: bootstrap.runtimeMode,
      fullCodebaseReadRoot: bootstrap.fullCodebaseReadRoot,
      workspaceWriteScope: bootstrap.workspaceRoot,
    });
  } else {
    log.info('Gateway runtime mode', { runtimeMode: bootstrap.runtimeMode });
  }

  // Ensure the module registry file exists regardless of policy — prevents
  // ENOENT when the REPL sandbox or ModuleLoader reads it for the first time.
  ensureRegistryFile(bootstrap.moduleRegistryAbsolute);

  // ── Create providers (these hold secrets / have network access) ──
  const gitOps = new GitOps({
    repoRoot: bootstrap.gitRepoRoot,
  });
  const capabilityRuntime = new CapabilityRuntime({
    dataDir: startupHydration.systemDataDir,
  });
  const eligibilityGate = createEligibilityGate(
    () => capabilityRuntime,
    (decision) => emitEligibilityDecision(eventBus, decision),
  );

  const gatewayChannelRegistry = new Map<string, ChannelAdapter>();
  const gatewayChannelManifest = buildChannelAdapterFactoryManifest([
    createDiscordChannelAdapterFactoryEntry({
      config,
      eventBus,
      eligibilityGate,
    }),
    createOpenHomeChannelAdapterFactoryEntry(),
    createTelegramChannelAdapterFactoryEntry({
      config: bootstrap.channelsConfig.telegram,
      eventBus,
    }),
  ]);
  const privilegedServices = createGatewayPrivilegedServiceRegistry({
    config,
    providerEnv: bootstrap.providerEnv,
    llmOptions: {
      eligibilityGate,
      onBudgetBlocked: (event) => {
        eventBus.emit('model.budget.blocked', event).catch((error) => {
          log.error('Failed to emit model budget blocked telemetry', {
            error: error instanceof Error ? error.message : String(error),
            provider: event.provider,
            model: event.model,
            reason: event.reason,
          });
        });
      },
    },
    vaultPolicyConfig: bootstrap.policyConfig.vault,
  });
  log.info('Embedding provider initialized', {
    provider: privilegedServices.embeddingProvider.kind,
    dims: privilegedServices.embeddingProvider.dims,
  });
  await loadChannelAdaptersFromManifest(
    gatewayChannelRegistry,
    gatewayChannelManifest,
    () => undefined,
    log,
    eligibilityGate,
  );
  const discord = requireChannelAdapter<DiscordAdapter>(gatewayChannelRegistry, 'discord');
  const telegram = getOptionalChannelAdapter<TelegramAdapter>(gatewayChannelRegistry, 'telegram');

  // ── Audit database (separate from agent's runtime DB) ──

  const auditDb = initDatabase(bootstrap.auditDbPath, { foreignKeys: false });
  const auditStore = new AuditStore(auditDb);
  log.info(`Audit log: ${bootstrap.auditDbPath}`);

  // ── Create gateway server ──

  const gateway = new GatewayServer({
    socketPath: bootstrap.socketPath,
    llmProvider: privilegedServices.llmClient,
    embeddingService: privilegedServices.embeddingProvider,
    discordAdapter: discord,
    gitOps,
    imageConfig: config,
    policyConfig: {
      ...bootstrap.policyConfig,
      ...(privilegedServices.vaultOps
        ? {
            vault: {
              ...bootstrap.policyConfig.vault,
              ops: privilegedServices.vaultOps,
            },
          }
        : {}),
    },
    ntfy: bootstrap.server.ntfy,
    confirmation: bootstrap.server.confirmation,
    capabilityTierProvider: () => capabilityRuntime.getTier(),
    auditStore,
    sessionHmacKeyring: bootstrap.server.sessionHmacKeyring,
    wyomingShardRouting: bootstrap.server.wyomingShardRouting,
  });

  const voiceModuleHost = new GatewayVoiceModuleHost({
    gateway,
    discord,
    eventBus,
  });
  voiceModuleHost.registerModule(createDiscordReverseRpcVoiceModule());
  await voiceModuleHost.registerAll();

  // ── Wyoming voice bridge (opt-in) ──

  let wyomingTcpServer: WyomingTcpServer | undefined;
  let wyomingRuntime: WyomingRuntime | undefined;

  if (config.wyomingEnabled) {
    const wyomingPort = config.wyomingPort ?? 10400;
    const wyomingHost = config.wyomingHost ?? '127.0.0.1';

    const handleAdapter = createWyomingHandleServiceAdapter({
      handleMessage: async (message) => {
        const result = await gateway.requestAgentVoiceStream(message);
        return {
          content: result.content,
          channelId: result.channelId,
          metadata: {
            model: result.model,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: result.durationMs,
          },
        };
      },
      eventBus,
    });

    const wyomingAdapters = [handleAdapter];
    const voiceProviderGate = resolveRuntimeVoiceProviderGate(config);
    const wyomingSttProvider = voiceProviderGate.sttProvider;
    const wyomingTtsProvider = voiceProviderGate.ttsProvider;

    if (voiceProviderGate.sttEnabled) {
      try {
        const runtimeStt = createRuntimeVoiceSttConnector(config, {
          eligibilityGate,
        });
        if (!runtimeStt) {
          log.info('Wyoming ASR adapter disabled', {
            provider: wyomingSttProvider,
            reason: 'eligibility_or_runtime_binding_unavailable',
          });
        } else {
          wyomingAdapters.push(createWyomingAsrServiceAdapter({ stt: runtimeStt.connector }));
          log.info('Wyoming ASR adapter enabled', { provider: runtimeStt.provider });
        }
      } catch (error) {
        if (!(error instanceof EligibilityDeniedError)) {
          throw error;
        }
        log.info('Wyoming ASR adapter disabled by eligibility gate', {
          provider: wyomingSttProvider,
          error: error.message,
        });
      }
    } else {
      log.info('Wyoming ASR adapter disabled', {
        provider: wyomingSttProvider,
        hasDeepgramApiKey: Boolean(config.deepgramApiKey),
      });
    }

    // TTS adapter — wired only when provider + credentials/config are enabled
    try {
      if (voiceProviderGate.ttsEnabled) {
        const runtimeTts = createRuntimeVoiceTtsConnector(config, {
          requireElevenLabsVoiceId: true,
          eligibilityGate,
        });
        if (!runtimeTts) {
          throw new Error(`Expected runtime TTS connector for provider "${wyomingTtsProvider}"`);
        }
        wyomingAdapters.push(createWyomingTtsServiceAdapter({ tts: runtimeTts.connector }));
        log.info('Wyoming TTS adapter enabled', { provider: runtimeTts.provider });
      } else {
        log.info('Wyoming TTS adapter disabled', {
          provider: wyomingTtsProvider,
          hasElevenLabsApiKey: Boolean(config.elevenLabsApiKey),
          hasEchoConfig: Boolean(config.echoTtsUrl && config.echoTtsVoice),
        });
      }
    } catch (error) {
      if (error instanceof EligibilityDeniedError) {
        log.info('Wyoming TTS adapter disabled by eligibility gate', {
          provider: wyomingTtsProvider,
          error: error.message,
        });
      } else {
        log.warn('Wyoming TTS adapter could not be created', { error: String(error) });
      }
    }

    const serviceRegistry = createWyomingServiceRegistry(wyomingAdapters);

    wyomingTcpServer = new WyomingTcpServer(
      { port: wyomingPort, host: wyomingHost, eventBus },
      {
        onFrame: (session, frame) => wyomingRuntime!.handleFrame(session, frame),
        onSessionClose: (session) => wyomingRuntime!.closeConnection(session.connectionId),
      },
    );

    wyomingRuntime = new WyomingRuntime({
      info: {
        name: DEFAULT_COMPANION_ID,
        version: '1.0.0',
        description: 'Companion Substrate Framework — Wyoming voice bridge',
        services: serviceRegistry.services,
      } as WyomingInfoData,
      emitFrame: (session, frame) => wyomingTcpServer!.send(session, frame),
      serviceRegistry,
      eventBus,
    });

    log.info(`Wyoming voice bridge configured on ${wyomingHost}:${wyomingPort}`);
  }

  // ── Wire Discord → Agent notifications ──

  discord.onMessage(async (msg) => {
    // Forward incoming Discord messages to connected agents as notifications
    gateway.notifyAll('discord.message', {
      message: serializeMessage(msg),
    });
    // Return a placeholder — the real response comes back via discord.send RPC
    return { content: '', channelId: msg.channelId, metadata: { model: '', inputTokens: 0, outputTokens: 0, durationMs: 0 } };
  });

  if (telegram) {
    if (typeof telegram.onMessage !== 'function') {
      throw new Error('Telegram adapter is missing onMessage bootstrap hook');
    }
    telegram.onMessage(async (msg) => {
      const result = await gateway.requestAgentVoiceStream(msg);
      return {
        content: result.content,
        channelId: result.channelId,
        ...(result.attachments ? { attachments: result.attachments } : {}),
        metadata: {
          model: result.model,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: result.durationMs,
        },
      };
    });
  }

  // ── Start everything ──

  if (telegram) {
    await telegram.init();
  }
  await discord.init();
  gateway.start();
  await voiceModuleHost.startAll();
  if (wyomingTcpServer) {
    await wyomingTcpServer.start();
    log.info(`Wyoming voice bridge listening on ${config.wyomingHost ?? '127.0.0.1'}:${config.wyomingPort ?? 10400}`);
  }
  let discordStartAttempts = 0;
  await startDiscordWithRetry(
    async () => {
      discordStartAttempts += 1;
      await discord.start();
    },
    {
      baseDelayMs: bootstrap.discordStartRetry.baseDelayMs,
      maxDelayMs: bootstrap.discordStartRetry.maxDelayMs,
      maxAttempts: bootstrap.discordStartRetry.maxAttempts,
      onRetry: ({ attempt, delayMs, maxAttempts, error }) => {
        const rawCode = (error as Error & { code?: unknown }).code;
        const code = typeof rawCode === 'string' ? rawCode : undefined;
        log.warn('Discord startup failed; retrying', {
          attempt,
          ...(maxAttempts > 0 ? { maxAttempts } : { maxAttempts: 'unbounded' }),
          delayMs,
          ...(code ? { code } : {}),
          error: error.message,
        });
      },
    },
  );
  if (discordStartAttempts > 1) {
    log.info('Discord startup recovered after retries', { attempts: discordStartAttempts });
  }
  if (telegram) {
    await telegram.start();
    log.info('Telegram gateway bridge enabled', {
      mode: bootstrap.channelsConfig.telegram.mode,
      allowlistSize: bootstrap.channelsConfig.telegram.allowedUsers.length,
    });
  }

  log.info(`Ready — listening on ${bootstrap.socketPath}`);
  log.info(`Workspace: ${bootstrap.workspaceRoot}`);

  // ── Graceful shutdown ──

  let stopPromise: Promise<void> | null = null;
  const stop = async (): Promise<void> => {
    if (stopPromise) {
      await stopPromise;
      return;
    }

    stopPromise = (async () => {
      await runShutdownStep('stop debug observer', () => stopDebugObserver());
      await runShutdownStep('stop Wyoming runtime', () => wyomingRuntime?.stop());
      await runShutdownStep('stop Wyoming TCP server', () => wyomingTcpServer?.stop());
      await runShutdownStep('stop voice modules', () => voiceModuleHost.stopAll());
      await runShutdownStep('stop gateway server', () => gateway.stop());
      await runShutdownStep('stop Telegram adapter', () => telegram?.stop());
      await runShutdownStep('stop Discord adapter', () => discord.stop());
      await runShutdownStep('close audit database', () => {
        auditDb.close();
      });
    })();

    await stopPromise;
  };

  const shutdown = createSignalShutdownHandler({
    logger: log,
    runGracefulShutdown: stop,
    exit: (code) => { process.exit(code); },
    forceExitTimeoutMs: bootstrap.shutdownForceExitTimeoutMs,
  });

  process.on('SIGINT', () => {
    void shutdown('SIGINT').catch((error) => {
      log.error('Unhandled SIGINT shutdown error', { error: String(error) });
      process.exit(1);
    });
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM').catch((error) => {
      log.error('Unhandled SIGTERM shutdown error', { error: String(error) });
      process.exit(1);
    });
  });
}

// Serialize SubstrateMessage for JSON transport (Date → ISO string)
function serializeMessage(msg: SubstrateMessage): Record<string, unknown> {
  return {
    ...msg,
    timestamp: msg.timestamp instanceof Date ? msg.timestamp.toISOString() : msg.timestamp,
  };
}

main().catch((err) => {
  log.error('Fatal error', { error: String(err) });
  process.exit(1);
});
