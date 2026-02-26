// ── Gateway Entry Point ──
// Host-side process that holds secrets and proxies all external interactions.
// Run: npm run gateway

import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './types.js';
import { createComponentLogger } from './logger.js';
import { LLMClient } from './llm/client.js';
import { createEmbeddingProviderFromEnv } from './memory/embedding.js';
import { DiscordAdapter } from './channels/discord/adapter.js';
import { EventBus } from './event-bus.js';
import { GatewayServer } from './gateway/server.js';
import { AuditStore } from './gateway/audit.js';
import { resolveAllowedReadPathsFromEnv } from './gateway/policy-config.js';
import { attachTerminalDebugObserver } from './debug/terminal-observer.js';
import type { SubstrateMessage } from './types.js';
import { CapabilityRuntime } from './capabilities/runtime.js';
import { loadSettings, applySettings } from './settings.js';
import { loadModelsConfig } from './config/models-config.js';
import { initDatabase } from './persistence/sqlite-utils.js';
import { parsePositiveIntEnv } from './utils/env.js';

const log = createComponentLogger('Gateway');
const DEFAULT_SOCKET_PATH = '/run/psfn/gateway.sock';
const DEFAULT_NTFY_TIMEOUT_MS = 8_000;
const DEFAULT_NTFY_DEBOUNCE_MS = 60_000;
const DEFAULT_CONFIRMATION_EXPIRY_MS = 24 * 60 * 60 * 1000;

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
  const eventBus = new EventBus();
  const stopDebugObserver = attachTerminalDebugObserver(eventBus, { scope: 'gateway' });

  log.info('Initializing...');

  // Ensure gateway socket directory exists
  mkdirSync(dirname(socketPath), { recursive: true });

  // ── Create providers (these hold secrets / have network access) ──

  const llmClient = new LLMClient(config);

  const embeddingProvider = createEmbeddingProviderFromEnv(process.env);

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
    policyConfig: {
      workspacePath,
      allowedReadPaths: resolveAllowedReadPathsFromEnv(process.env, workspacePath),
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
  await discord.start();

  log.info(`Ready — listening on ${socketPath}`);
  log.info(`Workspace: ${workspacePath}`);

  // ── Graceful shutdown ──

  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down...`);
    stopDebugObserver();
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
