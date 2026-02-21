// ── Gateway Entry Point ──
// Host-side process that holds secrets and proxies all external interactions.
// Run: npm run gateway

import 'dotenv/config';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './types.js';
import { createComponentLogger } from './logger.js';
import { LLMClient } from './llm/client.js';
import { EmbeddingProvider } from './memory/embedding.js';
import { DiscordAdapter } from './channels/discord/adapter.js';
import { EventBus } from './event-bus.js';
import { GatewayServer } from './gateway/server.js';
import { AuditStore } from './gateway/audit.js';
import { attachTerminalDebugObserver } from './debug/terminal-observer.js';
import type { SubstrateMessage } from './types.js';
import { loadSettings, applySettings } from './settings.js';
import { loadModelsConfig } from './config/models-config.js';

const log = createComponentLogger('Gateway');
const DEFAULT_SOCKET_PATH = '/run/psfn/gateway.sock';
const DEFAULT_NTFY_TIMEOUT_MS = 8_000;
const DEFAULT_NTFY_DEBOUNCE_MS = 60_000;

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
  const eventBus = new EventBus();
  const stopDebugObserver = attachTerminalDebugObserver(eventBus, { scope: 'gateway' });

  log.info('Initializing...');

  // Ensure gateway socket directory exists
  mkdirSync(dirname(socketPath), { recursive: true });

  // ── Create providers (these hold secrets / have network access) ──

  const llmClient = new LLMClient(config);

  const embeddingProvider = new EmbeddingProvider({
    ollamaUrl: process.env.OLLAMA_URL,
    model: process.env.EMBEDDING_MODEL,
    dims: process.env.EMBEDDING_DIMS ? parseInt(process.env.EMBEDDING_DIMS, 10) : undefined,
  });

  const discord = new DiscordAdapter(config, eventBus);

  // ── Audit database (separate from agent's runtime DB) ──

  const auditDbPath = process.env.AUDIT_DB_PATH ?? './data/gateway-audit.db';
  mkdirSync(dirname(auditDbPath), { recursive: true });
  const auditDb = new Database(auditDbPath);
  auditDb.pragma('journal_mode = WAL');
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
      allowedReadPaths: process.env.ALLOWED_READ_PATHS?.split(':'),
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
    auditStore,
  });

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
  await discord.start();

  // Wire voice handler to use reverse RPC to agent
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

  log.info(`Ready — listening on ${socketPath}`);
  log.info(`Workspace: ${workspacePath}`);

  // ── Graceful shutdown ──

  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down...`);
    stopDebugObserver();
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
