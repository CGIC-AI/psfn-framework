// ── Gateway Entry Point ──
// Host-side process that holds secrets and proxies all external interactions.
// Run: npm run gateway

import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from './types.js';
import { createComponentLogger } from './logger.js';
import { LLMClient } from './llm/client.js';
import { createEmbeddingProviderFromEnv } from './memory/embedding.js';
import { DiscordAdapter } from './channels/discord/adapter.js';
import { TelegramAdapter } from './channels/telegram/adapter.js';
import {
  loadRuntimeChannelsConfig,
  type RuntimeChannelsConfigOverrides,
} from './channels/config.js';
import { EventBus } from './event-bus.js';
import { GatewayServer } from './gateway/server.js';
import { AuditStore } from './gateway/audit.js';
import {
  resolveAllowedReadPathsFromEnv,
  resolveFullCodebaseReadRootFromEnv,
  resolveTrustedModuleRegistryPathFromEnv,
} from './gateway/policy-config.js';
import {
  ensureRegistryFile,
  resolveModuleRegistryPathFromWorkspace,
} from './modules/registry.js';
import { attachTerminalDebugObserver } from './debug/terminal-observer.js';
import type { SubstrateMessage } from './types.js';
import { WyomingTcpServer } from './channels/wyoming/server.js';
import { WyomingRuntime } from './channels/wyoming/runtime.js';
import { createWyomingServiceRegistry } from './channels/wyoming/services/index.js';
import { createWyomingHandleServiceAdapter } from './channels/wyoming/services/handle.js';
import { createWyomingAsrServiceAdapter } from './channels/wyoming/services/asr.js';
import { createWyomingTtsServiceAdapter } from './channels/wyoming/services/tts.js';
import { createStreamingSttConnector } from './voice/connectors/stt/index.js';
import { createStreamingTtsConnector } from './voice/connectors/tts/index.js';
import type { WyomingInfoData } from './channels/wyoming/protocol.js';
import { CapabilityRuntime } from './capabilities/runtime.js';
import { GitOps } from './git/ops.js';
import { loadSettings, applySettings } from './settings.js';
import { loadModelsConfig } from './config/models-config.js';
import { initDatabase } from './persistence/sqlite-utils.js';
import { parsePositiveIntEnv } from './utils/env.js';
import { resolveWorkspaceRoot } from './gateway/filesystem-paths.js';
import { resolveRuntimeVoiceProviderGate } from './runtime/bootstrap-helpers.js';
import { applyGatewayTlsConfig } from './gateway/tls.js';
import type { SubstrateConfig } from './types.js';
import type { EditableSettings } from './settings.js';
import {
  startDiscordWithRetry,
  DEFAULT_DISCORD_START_RETRY_BASE_DELAY_MS,
  DEFAULT_DISCORD_START_RETRY_MAX_DELAY_MS,
  DEFAULT_DISCORD_START_RETRY_MAX_ATTEMPTS,
} from './gateway/discord-startup.js';

const log = createComponentLogger('Gateway');
const DEFAULT_SOCKET_PATH = '/run/psfn/gateway.sock';
const DEFAULT_NTFY_TIMEOUT_MS = 8_000;
const DEFAULT_NTFY_DEBOUNCE_MS = 60_000;
const DEFAULT_CONFIRMATION_EXPIRY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SHELL_EXEC_TIMEOUT_MS = 5_000;
const DEFAULT_SHELL_EXEC_MAX_TIMEOUT_MS = 30_000;
const DEFAULT_SHELL_EXEC_OUTPUT_CHARS = 20_000;
const DEFAULT_SHELL_EXEC_OUTPUT_CHARS_CAP = 100_000;

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

function parseStringListEnv(value: string | undefined): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = [...new Set(
    value
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean),
  )];
  return parsed.length > 0 ? parsed : undefined;
}

function parseBooleanEnv(value: string | undefined, fallback = false): boolean {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function resolveGatewayRuntimeMode(raw: string | undefined): string {
  const normalized = raw?.trim().toLowerCase() ?? '';
  if (!normalized) {
    throw new Error(
      'PSFN_RUNTIME_MODE is required for gateway startup. Set it to "split" or "yolo".',
    );
  }

  const allowedModes = new Set([
    'split',
    'yolo',
    'gateway',
    'gateway-agent',
    'gateway_agent',
    'gatewayagent',
    'agent',
  ]);
  if (!allowedModes.has(normalized)) {
    throw new Error(
      `Unsupported PSFN_RUNTIME_MODE "${raw}". Expected one of: split, yolo, gateway, gateway-agent.`,
    );
  }

  if (normalized === 'gateway_agent' || normalized === 'gatewayagent') {
    return 'gateway-agent';
  }
  if (normalized === 'agent') {
    return 'gateway-agent';
  }
  return normalized;
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

function buildGatewayChannelsConfigOverrides(
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

  return { telegram: telegramOverride };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const savedSettings = loadSettings(config.dataDir);
  applySettings(config, savedSettings);
  const modelsConfig = loadModelsConfig(config.dataDir, {
    defaultContextWindow: config.defaultContextWindow,
  });
  applySettings(config, modelsConfig);
  const channelsConfig = loadRuntimeChannelsConfig(
    config.dataDir,
    process.env,
    buildGatewayChannelsConfigOverrides(config, savedSettings),
  );
  const socketPath = process.env.GATEWAY_SOCKET ?? DEFAULT_SOCKET_PATH;
  const workspacePath = process.env.WORKSPACE_PATH ?? './workspace';
  const ntfyBaseUrl = process.env.NTFY_BASE_URL?.trim() || undefined;
  const ntfyTopic = process.env.NTFY_TOPIC?.trim() || undefined;
  const ntfyToken = process.env.NTFY_TOKEN?.trim() || undefined;
  const ntfyTimeoutMs = parsePositiveIntEnv(process.env.NTFY_TIMEOUT_MS, DEFAULT_NTFY_TIMEOUT_MS);
  const ntfyDebounceMs = parsePositiveIntEnv(process.env.NTFY_DEBOUNCE_MS, DEFAULT_NTFY_DEBOUNCE_MS);
  const confirmationExpiryMs = parsePositiveIntEnv(
    process.env.CONFIRMATION_EXPIRY_MS,
    DEFAULT_CONFIRMATION_EXPIRY_MS,
  );
  const confirmationOperatorDiscordChannelId = process.env.CONFIRMATION_OPERATOR_DISCORD_CHANNEL_ID?.trim() || undefined;
  const confirmationNtfyTopic = process.env.CONFIRMATION_NTFY_TOPIC?.trim() || undefined;
  const shellExecEnabled = parseBooleanEnv(process.env.SHELL_EXEC_ENABLED, false);
  const shellExecAllowlist = parseStringListEnv(process.env.SHELL_EXEC_ALLOWLIST);
  const shellExecAllowedCwd = parseStringListEnv(process.env.SHELL_EXEC_ALLOWED_CWD);
  const shellExecDefaultTimeoutMs = parsePositiveIntEnv(
    process.env.SHELL_EXEC_DEFAULT_TIMEOUT_MS,
    DEFAULT_SHELL_EXEC_TIMEOUT_MS,
  );
  const shellExecMaxTimeoutMs = parsePositiveIntEnv(
    process.env.SHELL_EXEC_MAX_TIMEOUT_MS,
    DEFAULT_SHELL_EXEC_MAX_TIMEOUT_MS,
  );
  const shellExecDefaultMaxOutputChars = parsePositiveIntEnv(
    process.env.SHELL_EXEC_DEFAULT_MAX_OUTPUT_CHARS,
    DEFAULT_SHELL_EXEC_OUTPUT_CHARS,
  );
  const shellExecMaxOutputChars = parsePositiveIntEnv(
    process.env.SHELL_EXEC_MAX_OUTPUT_CHARS,
    DEFAULT_SHELL_EXEC_OUTPUT_CHARS_CAP,
  );
  const discordStartRetryBaseDelayMs = parsePositiveIntEnv(
    process.env.DISCORD_START_RETRY_BASE_DELAY_MS,
    DEFAULT_DISCORD_START_RETRY_BASE_DELAY_MS,
  );
  const discordStartRetryMaxDelayMs = parsePositiveIntEnv(
    process.env.DISCORD_START_RETRY_MAX_DELAY_MS,
    DEFAULT_DISCORD_START_RETRY_MAX_DELAY_MS,
  );
  const discordStartRetryMaxAttempts = parsePositiveIntEnv(
    process.env.DISCORD_START_RETRY_MAX_ATTEMPTS,
    DEFAULT_DISCORD_START_RETRY_MAX_ATTEMPTS,
  );
  // ── Apply TLS config early, before any HTTPS connections ──
  applyGatewayTlsConfig({
    caPath: config.gatewayTlsCaPath,
    rejectUnauthorized: config.gatewayTlsRejectUnauthorized,
  });

  const eventBus = new EventBus();
  const stopDebugObserver = attachTerminalDebugObserver(eventBus, { scope: 'gateway' });

  log.info('Initializing...');

  // Ensure gateway socket directory exists
  mkdirSync(dirname(socketPath), { recursive: true });
  const runtimeMode = resolveGatewayRuntimeMode(process.env.PSFN_RUNTIME_MODE);
  const codebaseRoot = resolve('.');
  const workspaceRoot = resolveWorkspaceRoot(workspacePath);
  mkdirSync(workspaceRoot, { recursive: true });
  const fullCodebaseReadRoot = resolveFullCodebaseReadRootFromEnv(process.env, codebaseRoot);
  if (fullCodebaseReadRoot) {
    log.warn('YOLO runtime mode active: full-codebase fs.read is enabled', {
      runtimeMode,
      fullCodebaseReadRoot,
      workspaceWriteScope: workspaceRoot,
    });
  } else {
    log.info('Gateway runtime mode', { runtimeMode });
  }

  // Ensure the module registry file exists regardless of policy — prevents
  // ENOENT when the REPL sandbox or ModuleLoader reads it for the first time.
  const moduleRegistryAbsolute = resolveModuleRegistryPathFromWorkspace(
    workspaceRoot,
    process.env.MODULE_REGISTRY_PATH,
  );
  ensureRegistryFile(moduleRegistryAbsolute);
  const trustedModuleRegistryPath = resolveTrustedModuleRegistryPathFromEnv(process.env, workspaceRoot);

  // ── Create providers (these hold secrets / have network access) ──

  const llmClient = new LLMClient(config);

  const embeddingProvider = createEmbeddingProviderFromEnv(process.env);
  log.info('Embedding provider initialized', {
    provider: embeddingProvider.kind,
    dims: embeddingProvider.dims,
  });
  const gitOps = new GitOps({
    repoRoot: workspaceRoot,
  });

  const discord = new DiscordAdapter(config, eventBus);
  const telegram = channelsConfig.telegram.enabled
    ? new TelegramAdapter(channelsConfig.telegram, eventBus)
    : null;
  const capabilityRuntime = new CapabilityRuntime({
    dataDir: config.dataDir,
    envTier: config.capabilityTier,
  });

  // ── Audit database (separate from agent's runtime DB) ──

  const auditDbPath = process.env.AUDIT_DB_PATH ?? './data/gateway-audit.db';
  const auditDb = initDatabase(auditDbPath, { foreignKeys: false });
  const auditStore = new AuditStore(auditDb);
  log.info(`Audit log: ${auditDbPath}`);

  // ── Create gateway server ──

  const gateway = new GatewayServer({
    socketPath,
    llmProvider: llmClient,
    embeddingService: embeddingProvider,
    discordAdapter: discord,
    gitOps,
    policyConfig: {
      workspacePath: workspaceRoot,
      allowedReadPaths: resolveAllowedReadPathsFromEnv(process.env, workspaceRoot),
      ...(fullCodebaseReadRoot ? { fullCodebaseReadRoot } : {}),
      urlPolicy: {
        allowHttp: config.webFetchAllowHttp === true,
        ...(config.webFetchDomainAllowlist && config.webFetchDomainAllowlist.length > 0
          ? { domainAllowlist: config.webFetchDomainAllowlist }
          : {}),
        allowInternalNetwork: config.webFetchAllowInternalNetwork === true,
        // Deprecated: local crawler lane preserved for backward compat
        localCrawlerLane: {
          enabled: config.webFetchLocalCrawlerEnabled === true,
          allowHttp: config.webFetchLocalCrawlerAllowHttp === true,
          ...(config.webFetchLocalCrawlerHostAllowlist && config.webFetchLocalCrawlerHostAllowlist.length > 0
            ? { hostAllowlist: config.webFetchLocalCrawlerHostAllowlist }
            : {}),
          ...(config.webFetchLocalCrawlerDomainAllowlist && config.webFetchLocalCrawlerDomainAllowlist.length > 0
            ? { domainAllowlist: config.webFetchLocalCrawlerDomainAllowlist }
            : {}),
        },
      },
      ...(config.webFetchTlsCaCertPaths && config.webFetchTlsCaCertPaths.length > 0
        ? { webFetchTlsCaCertPaths: config.webFetchTlsCaCertPaths }
        : {}),
      shellExec: {
        enabled: shellExecEnabled,
        ...(shellExecAllowlist ? { allowlist: shellExecAllowlist } : {}),
        ...(shellExecAllowedCwd ? { allowedCwd: shellExecAllowedCwd } : {}),
        defaultTimeoutMs: shellExecDefaultTimeoutMs,
        maxTimeoutMs: shellExecMaxTimeoutMs,
        defaultMaxOutputChars: shellExecDefaultMaxOutputChars,
        maxOutputChars: shellExecMaxOutputChars,
      },
    },
    ntfy: ntfyBaseUrl && ntfyTopic
      ? {
        baseUrl: ntfyBaseUrl,
        defaultTopic: ntfyTopic,
        token: ntfyToken,
        timeoutMs: ntfyTimeoutMs,
        debounceWindowMs: ntfyDebounceMs,
      }
      : undefined,
    confirmation: {
      expiryMs: confirmationExpiryMs,
      operatorDiscordChannelId: confirmationOperatorDiscordChannelId,
      ntfyTopic: confirmationNtfyTopic,
    },
    capabilityTierProvider: () => capabilityRuntime.getTier(),
    auditStore,
    wyomingShardRouting: config.wyomingShardRouting,
  });

  const voiceModuleHost = new GatewayVoiceModuleHost({
    gateway,
    discord,
    eventBus,
  });
  voiceModuleHost.registerModule(createDiscordReverseRpcVoiceModule());
  await voiceModuleHost.registerAll();

  if ((ntfyBaseUrl && !ntfyTopic) || (!ntfyBaseUrl && ntfyTopic)) {
    log.warn('ntfy alerts disabled: both NTFY_BASE_URL and NTFY_TOPIC are required');
  }

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

    // ASR adapter — wired to Deepgram STT only when provider + credentials are enabled
    if (voiceProviderGate.sttEnabled && wyomingSttProvider === 'deepgram') {
      const sttConnector = createStreamingSttConnector('deepgram', {
        apiKey: config.deepgramApiKey!,
        model: config.deepgramModel,
      });
      wyomingAdapters.push(createWyomingAsrServiceAdapter({ stt: sttConnector }));
      log.info('Wyoming ASR adapter enabled (deepgram)');
    } else {
      log.info('Wyoming ASR adapter disabled', {
        provider: wyomingSttProvider,
        hasDeepgramApiKey: Boolean(config.deepgramApiKey),
      });
    }

    // TTS adapter — wired only when provider + credentials/config are enabled
    try {
      let ttsConnector;
      if (voiceProviderGate.ttsEnabled) {
        if (wyomingTtsProvider === 'echo') {
          ttsConnector = createStreamingTtsConnector('echo', {
            url: config.echoTtsUrl!,
            voice: config.echoTtsVoice!,
            preset: config.echoTtsPreset ?? 'normal',
            ...(config.echoTtsModel ? { model: config.echoTtsModel } : {}),
          });
        } else if (wyomingTtsProvider === 'elevenlabs' && config.elevenLabsVoiceId) {
          ttsConnector = createStreamingTtsConnector('elevenlabs', {
            apiKey: config.elevenLabsApiKey!,
            voiceId: config.elevenLabsVoiceId,
            modelId: config.elevenLabsModelId,
          });
        }
      }
      if (ttsConnector) {
        wyomingAdapters.push(createWyomingTtsServiceAdapter({ tts: ttsConnector }));
        log.info('Wyoming TTS adapter enabled', { provider: wyomingTtsProvider });
      } else {
        log.info('Wyoming TTS adapter disabled', {
          provider: wyomingTtsProvider,
          hasElevenLabsApiKey: Boolean(config.elevenLabsApiKey),
          hasEchoConfig: Boolean(config.echoTtsUrl && config.echoTtsVoice),
        });
      }
    } catch (error) {
      log.warn('Wyoming TTS adapter could not be created', { error: String(error) });
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
        name: 'psfn',
        version: '1.0.0',
        description: 'PSFN Substrate Framework — Wyoming voice bridge',
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
    telegram.onMessage(async (msg) => {
      const result = await gateway.requestAgentVoiceStream(msg);
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
      baseDelayMs: discordStartRetryBaseDelayMs,
      maxDelayMs: discordStartRetryMaxDelayMs,
      maxAttempts: discordStartRetryMaxAttempts,
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
      mode: channelsConfig.telegram.mode,
      allowlistSize: channelsConfig.telegram.allowedUsers.length,
    });
  }

  log.info(`Ready — listening on ${socketPath}`);
  log.info(`Workspace: ${workspaceRoot}`);

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

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = async (signal: string) => {
    if (shutdownPromise) {
      log.warn('Shutdown already in progress; ignoring additional signal', { signal });
      await shutdownPromise;
      return;
    }

    shutdownPromise = (async () => {
      log.info(`Received ${signal}, shutting down...`);
      await stop();
      process.exit(0);
    })().catch((error) => {
      log.error('Graceful shutdown failed; forcing exit', {
        signal,
        error: String(error),
      });
      process.exit(1);
    });

    await shutdownPromise;
  };

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
