// ── Gateway Entry Point ──
// Host-side process that holds secrets and proxies all external interactions.
// Run: npm run gateway

import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from './types.js';
import { createComponentLogger } from './logger.js';
import { LLMClient } from './llm/client.js';
import { createEmbeddingProviderFromConfig } from './memory/embedding.js';
import type { DiscordAdapter } from './channels/discord/adapter.js';
import type { TelegramAdapter } from './channels/telegram/adapter.js';
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
} from './gateway/policy-config.js';
import {
  ensureRegistryFile,
  resolveModuleRegistryPathFromWorkspace,
} from './modules/registry.js';
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
import { resolveGitRepoRoot } from './git/repo-root.js';
import { initDatabase } from './persistence/sqlite-utils.js';
import {
  parseBooleanEnv as parseEnvBoolean,
  parseEnvList,
  parsePositiveIntEnv,
} from './utils/env.js';
import { resolveWorkspaceRoot } from './gateway/filesystem-paths.js';
import {
  createRuntimeVoiceSttConnector,
  createRuntimeVoiceTtsConnector,
  hydrateCanonicalStartupConfig,
  resolveRuntimeVoiceProviderGate,
  type StartupConfigHydrationDiagnostics,
} from './runtime/bootstrap-helpers.js';
import { getIgnoredJsonBackedConfigEnvKeys } from './config/legacy-env.js';
import { applyGatewayTlsConfig } from './gateway/tls.js';
import type { SubstrateConfig } from './types.js';
import type { EditableSettings } from './settings.js';
import type { BeadsAction } from './gateway/protocol.js';
import type { VaultPolicyAction } from './gateway/policy.js';
import { VaultOps } from './vault/ops.js';
import {
  startDiscordWithRetry,
  DEFAULT_DISCORD_START_RETRY_BASE_DELAY_MS,
  DEFAULT_DISCORD_START_RETRY_MAX_DELAY_MS,
  DEFAULT_DISCORD_START_RETRY_MAX_ATTEMPTS,
} from './gateway/discord-startup.js';
import {
  createDiscordChannelAdapterFactoryEntry,
  createTelegramChannelAdapterFactoryEntry,
  getOptionalChannelAdapter,
  requireChannelAdapter,
} from './bootstrap/channel-runtime.js';
import {
  buildChannelAdapterFactoryManifest,
  loadChannelAdaptersFromManifest,
} from './runtime/channel-lifecycle.js';

const log = createComponentLogger('Gateway');
const DEFAULT_SOCKET_PATH = '/run/psfn/gateway.sock';
const DEFAULT_NTFY_TIMEOUT_MS = 8_000;
const DEFAULT_NTFY_DEBOUNCE_MS = 60_000;
const DEFAULT_CONFIRMATION_EXPIRY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SHELL_EXEC_TIMEOUT_MS = 5_000;
const DEFAULT_SHELL_EXEC_MAX_TIMEOUT_MS = 30_000;
const DEFAULT_SHELL_EXEC_OUTPUT_CHARS = 20_000;
const DEFAULT_SHELL_EXEC_OUTPUT_CHARS_CAP = 100_000;
const ALL_BEADS_ACTIONS: readonly BeadsAction[] = [
  'ready',
  'show',
  'create',
  'update',
  'close',
  'sync',
];
const ALL_VAULT_ACTIONS: readonly VaultPolicyAction[] = [
  'write',
  'read',
  'search',
  'daily',
];

function logStartupHydrationDiagnostics(diagnostics: StartupConfigHydrationDiagnostics): void {
  if (diagnostics.modelsMigratedFromLegacySettings) {
    log.warn('Migrated legacy model settings from settings.json to models.json');
  } else if (diagnostics.modelsLegacyDriftDetected) {
    log.warn('Detected legacy model drift between settings.json and models.json; models.json is authoritative');
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

function parseBooleanEnvWithFallback(value: string | undefined, fallback = false): boolean {
  const parsed = parseEnvBoolean(value);
  return parsed === undefined ? fallback : parsed;
}

function parseBeadsActionsEnv(value: string | undefined): BeadsAction[] | undefined {
  const parsed = parseEnvList(value, { separators: [','] });
  if (!parsed) {
    return value === undefined ? undefined : [];
  }

  const valid = new Set(ALL_BEADS_ACTIONS);
  const actions: BeadsAction[] = [];
  for (const entry of parsed) {
    const normalized = entry.toLowerCase();
    if (valid.has(normalized as BeadsAction)) {
      actions.push(normalized as BeadsAction);
    }
  }
  return actions;
}

function parseVaultActionsEnv(value: string | undefined): VaultPolicyAction[] | undefined {
  const parsed = parseEnvList(value, { separators: [','] });
  if (!parsed) {
    return value === undefined ? undefined : [];
  }

  const valid = new Set(ALL_VAULT_ACTIONS);
  const actions: VaultPolicyAction[] = [];
  for (const entry of parsed) {
    const normalized = entry.toLowerCase();
    if (valid.has(normalized as VaultPolicyAction)) {
      actions.push(normalized as VaultPolicyAction);
    }
  }
  return actions;
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
  const ignoredMutableEnvKeys = getIgnoredJsonBackedConfigEnvKeys(process.env);
  if (ignoredMutableEnvKeys.length > 0) {
    log.warn('Ignoring JSON-owned config env vars; move runtime config into system-data JSON files and keep .env for secrets/bootstrap wiring only', {
      keys: ignoredMutableEnvKeys,
    });
  }
  const startupHydration = hydrateCanonicalStartupConfig(config, {
    env: process.env,
  });
  const {
    systemDataDir,
    companionDataDir,
    runtimePathLayout,
    settingsDomains,
    trustPolicyConfig,
  } = startupHydration;
  logStartupHydrationDiagnostics(startupHydration.diagnostics);
  log.info('Loaded trust policy configuration', {
    exactOverrideCount: Object.keys(
      trustPolicyConfig.channelClassification.visibilityOverrides.exact,
    ).length,
    prefixOverrideCount: Object.keys(
      trustPolicyConfig.channelClassification.visibilityOverrides.prefix,
    ).length,
  });
  const channelsConfig = loadRuntimeChannelsConfig(
    systemDataDir,
    process.env,
    buildGatewayChannelsConfigOverrides(config, settingsDomains.runtime),
  );
  const socketPath = process.env.GATEWAY_SOCKET ?? DEFAULT_SOCKET_PATH;
  const workspacePathEnv = process.env.WORKSPACE_PATH;
  const workspacePath = runtimePathLayout.workspacePath;
  if (!workspacePathEnv) {
    log.warn('WORKSPACE_PATH not set, defaulting to runtime layout workspace path', {
      mode: runtimePathLayout.mode,
      workspacePath,
    });
  }
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
  const shellExecEnabled = parseBooleanEnvWithFallback(process.env.SHELL_EXEC_ENABLED, false);
  const shellExecAllowlist = parseEnvList(process.env.SHELL_EXEC_ALLOWLIST, { separators: [','] });
  const shellExecAllowedCwd = parseEnvList(process.env.SHELL_EXEC_ALLOWED_CWD, { separators: [','] });
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
  const beadsToolsEnabled = parseBooleanEnvWithFallback(process.env.BEADS_TOOLS_ENABLED, false);
  const beadsAllowActions = parseBeadsActionsEnv(process.env.BEADS_ALLOW_ACTIONS)
    ?? (beadsToolsEnabled ? [...ALL_BEADS_ACTIONS] : undefined);
  const vaultToolsEnabled = parseBooleanEnvWithFallback(
    process.env.VAULT_TOOLS_ENABLED,
    Boolean(config.obsidianVaultName),
  );
  const vaultAllowActions = parseVaultActionsEnv(process.env.VAULT_ALLOW_ACTIONS)
    ?? (vaultToolsEnabled ? [...ALL_VAULT_ACTIONS] : undefined);
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
  if (systemDataDir !== companionDataDir) {
    log.info('Configured split persistence roots', {
      systemDataDir,
      companionDataDir,
    });
  }

  // Ensure gateway socket directory exists
  mkdirSync(dirname(socketPath), { recursive: true });
  const runtimeMode = resolveGatewayRuntimeMode(process.env.PSFN_RUNTIME_MODE);
  const codebaseRoot = resolve('.');
  const workspaceRoot = resolveWorkspaceRoot(workspacePath);
  const gitRepoRoot = resolveGitRepoRoot({
    codebaseRoot,
    configuredGitRepoRoot: process.env.GIT_REPO_ROOT,
  });
  mkdirSync(workspaceRoot, { recursive: true });
  if (workspaceRoot !== gitRepoRoot) {
    log.info('Gateway workspace and git roots diverge', {
      workspaceRoot,
      gitRepoRoot,
    });
  }
  if (vaultToolsEnabled && !config.obsidianVaultName) {
    throw new Error(
      'VAULT_TOOLS_ENABLED is true but obsidianVaultName is not configured in settings.',
    );
  }
  const vaultOps = vaultToolsEnabled
    ? new VaultOps({
      vaultName: config.obsidianVaultName!,
      ...(config.obsidianCliPath ? { cliPath: config.obsidianCliPath } : {}),
      ...(typeof config.obsidianTimeoutMs === 'number'
        ? { timeoutMs: config.obsidianTimeoutMs }
        : {}),
    })
    : undefined;
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

  // ── Create providers (these hold secrets / have network access) ──
  const embeddingProvider = createEmbeddingProviderFromConfig(config, process.env);
  log.info('Embedding provider initialized', {
    provider: embeddingProvider.kind,
    dims: embeddingProvider.dims,
  });
  const gitOps = new GitOps({
    repoRoot: gitRepoRoot,
  });
  const capabilityRuntime = new CapabilityRuntime({
    dataDir: systemDataDir,
  });
  const eligibilityGate = createEligibilityGate(
    () => capabilityRuntime,
    (decision) => emitEligibilityDecision(eventBus, decision),
  );
  const llmClient = new LLMClient(config, {
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
  });

  const gatewayChannelRegistry = new Map<string, ChannelAdapter>();
  const gatewayChannelManifest = buildChannelAdapterFactoryManifest([
    createDiscordChannelAdapterFactoryEntry({
      config,
      eventBus,
      eligibilityGate,
    }),
    createTelegramChannelAdapterFactoryEntry({
      config: channelsConfig.telegram,
      eventBus,
    }),
  ]);
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

  const auditDbPath = process.env.AUDIT_DB_PATH ?? join(systemDataDir, 'gateway-audit.db');
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
      beads: {
        enabled: beadsToolsEnabled,
        ...(beadsAllowActions ? { allowActions: beadsAllowActions } : {}),
      },
      vault: {
        enabled: vaultToolsEnabled,
        ...(vaultAllowActions ? { allowActions: vaultAllowActions } : {}),
        ...(vaultOps ? { ops: vaultOps } : {}),
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
