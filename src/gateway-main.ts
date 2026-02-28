// ── Gateway Entry Point ──
// Host-side process that holds secrets and proxies all external interactions.
// Run: npm run gateway

import 'dotenv/config';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './types.js';
import { createComponentLogger } from './logger.js';
import { LLMClient } from './llm/client.js';
import { createEmbeddingProviderFromEnv } from './memory/embedding.js';
import { DiscordAdapter } from './channels/discord/adapter.js';
import { EventBus } from './event-bus.js';
import { GatewayServer } from './gateway/server.js';
import { AuditStore } from './gateway/audit.js';
import {
  resolveAllowedReadPathsFromEnv,
  resolveTrustedModuleRegistryPathFromEnv,
} from './gateway/policy-config.js';
import { attachTerminalDebugObserver } from './debug/terminal-observer.js';
import type { SubstrateMessage } from './types.js';
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
import { GitOps } from './git/ops.js';
import { loadSettings, applySettings } from './settings.js';
import { loadModelsConfig } from './config/models-config.js';
import { initDatabase } from './persistence/sqlite-utils.js';
import { parsePositiveIntEnv } from './utils/env.js';
import { resolveWorkspaceRoot } from './gateway/filesystem-paths.js';

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

async function main(): Promise<void> {
  const config = loadConfig();
  const savedSettings = loadSettings(config.dataDir);
  applySettings(config, savedSettings);
  const modelsConfig = loadModelsConfig(config.dataDir, {
    defaultContextWindow: config.defaultContextWindow,
  });
  applySettings(config, modelsConfig);
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
  const eventBus = new EventBus();
  const stopDebugObserver = attachTerminalDebugObserver(eventBus, { scope: 'gateway' });

  log.info('Initializing...');

  // Ensure gateway socket directory exists
  mkdirSync(dirname(socketPath), { recursive: true });
  const workspaceRoot = resolveWorkspaceRoot(workspacePath);
  mkdirSync(workspaceRoot, { recursive: true });

  const trustedModuleRegistryPath = resolveTrustedModuleRegistryPathFromEnv(process.env, workspaceRoot);
  if (trustedModuleRegistryPath && !existsSync(trustedModuleRegistryPath)) {
    mkdirSync(dirname(trustedModuleRegistryPath), { recursive: true });
    writeFileSync(trustedModuleRegistryPath, '[]\n', 'utf-8');
  }

  // ── Create providers (these hold secrets / have network access) ──

  const llmClient = new LLMClient(config);

  const embeddingProvider = createEmbeddingProviderFromEnv(process.env);
  const gitOps = new GitOps({
    repoRoot: workspaceRoot,
  });

  const discord = new DiscordAdapter(config, eventBus);
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

    // ASR adapter — wired to Deepgram STT when API key is available
    const wyomingDeepgramKey = config.deepgramApiKey;
    if (wyomingDeepgramKey) {
      const sttConnector = createStreamingSttConnector('deepgram', {
        apiKey: wyomingDeepgramKey,
        model: config.deepgramModel,
      });
      wyomingAdapters.push(createWyomingAsrServiceAdapter({ stt: sttConnector }));
      log.info('Wyoming ASR adapter enabled (deepgram)');
    }

    // TTS adapter — wired to the configured TTS provider (elevenlabs or echo)
    const wyomingTtsProvider: StreamingTtsProvider = config.ttsProvider ?? 'elevenlabs';
    try {
      let ttsConnector;
      if (wyomingTtsProvider === 'echo' && config.echoTtsUrl && config.echoTtsVoice) {
        ttsConnector = createStreamingTtsConnector('echo', {
          url: config.echoTtsUrl,
          voice: config.echoTtsVoice,
          preset: config.echoTtsPreset ?? 'normal',
          ...(config.echoTtsModel ? { model: config.echoTtsModel } : {}),
        });
      } else if (config.elevenLabsApiKey) {
        ttsConnector = createStreamingTtsConnector('elevenlabs', {
          apiKey: config.elevenLabsApiKey,
          voiceId: config.elevenLabsVoiceId ?? 'YOUR_VOICE_ID',
          modelId: config.elevenLabsModelId,
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

  // ── Start everything ──

  await discord.init();
  gateway.start();
  await voiceModuleHost.startAll();
  if (wyomingTcpServer) {
    await wyomingTcpServer.start();
    log.info(`Wyoming voice bridge listening on ${config.wyomingHost ?? '127.0.0.1'}:${config.wyomingPort ?? 10400}`);
  }
  await discord.start();

  log.info(`Ready — listening on ${socketPath}`);
  log.info(`Workspace: ${workspaceRoot}`);

  // ── Graceful shutdown ──

  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down...`);
    stopDebugObserver();
    if (wyomingRuntime) await wyomingRuntime.stop();
    if (wyomingTcpServer) await wyomingTcpServer.stop();
    await voiceModuleHost.stopAll();
    await gateway.stop();
    await discord.stop();
    auditDb.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
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
