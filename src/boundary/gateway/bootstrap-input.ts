import { resolve } from 'node:path';
import type { SubstrateConfig, WyomingShardRoutingConfig } from '../../system/config/runtime-config-contracts.js';
import { getIgnoredJsonBackedConfigEnvKeys } from '../../system/config/legacy-env.js';
import {
  loadRuntimeChannelsConfig,
  type RuntimeChannelsConfig,
  type RuntimeChannelsConfigOverrides,
} from '../../channels/config.js';
import {
  resolveAllowedReadPathsFromEnv,
  resolveFullCodebaseReadRootFromEnv,
  type GatewayPolicyEnv,
} from './policy-config.js';
import { resolveWorkspaceRoot } from './filesystem-paths.js';
import { resolveGitRepoRoot } from '../../git/repo-root.js';
import { resolveModuleRegistryPathFromWorkspace } from '../../modules/registry.js';
import { parseBooleanEnv, parseEnvList, parsePositiveIntEnv } from '../../shared/utils/env.js';
import { buildShellExecPolicyConfig } from '../sandbox/execution/shell-policy-config.js';
import {
  buildProviderCredentialEnv,
  resolveOptionalEnvCredential,
} from '../custody/credential-vault.js';
import { requireGatewaySessionHmacKeyring } from './session-hmac-env.js';
import { parseWyomingShardRoutingConfigEnv } from '../../system/config/load-config.js';
import {
  buildRuntimeChannelsConfigOverrides,
  type StartupConfigHydrationResult,
} from '../../app/startup/support/bootstrap-helpers.js';
import type { PolicyConfig } from './policy.js';
import type { GatewayNtfyConfig } from './ntfy-notifier.js';
import type { SessionHmacKeyring } from '../../session/journal-utils.js';
import { DEFAULT_DISCORD_START_RETRY_BASE_DELAY_MS,
  DEFAULT_DISCORD_START_RETRY_MAX_DELAY_MS,
  DEFAULT_DISCORD_START_RETRY_MAX_ATTEMPTS,
} from './discord-startup.js';

const DEFAULT_SOCKET_PATH = '/run/psfn/gateway.sock';
const DEFAULT_NTFY_TIMEOUT_MS = 8_000;
const DEFAULT_NTFY_DEBOUNCE_MS = 60_000;
const DEFAULT_CONFIRMATION_EXPIRY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SHUTDOWN_FORCE_EXIT_TIMEOUT_MS = 15_000;
const ALL_BEADS_ACTIONS = ['ready', 'show', 'create', 'update', 'close', 'sync'] as const;
const ALL_VAULT_ACTIONS = ['write', 'read', 'search', 'daily'] as const;

export type GatewayRuntimeMode =
  | 'split'
  | 'yolo'
  | 'gateway'
  | 'gateway-agent';

export interface GatewayBootstrapDiagnostics {
  ignoredMutableEnvKeys: string[];
  workspacePathProvided: boolean;
  ntfyConfigIncomplete: boolean;
}

export interface GatewayBootstrapServerInput {
  sessionHmacKeyring: SessionHmacKeyring;
  wyomingShardRouting: WyomingShardRoutingConfig;
  ntfy?: GatewayNtfyConfig;
  confirmation: {
    expiryMs: number;
    operatorDiscordChannelId?: string;
    ntfyTopic?: string;
  };
}

export interface GatewayBootstrapInput {
  diagnostics: GatewayBootstrapDiagnostics;
  runtimeMode: GatewayRuntimeMode;
  socketPath: string;
  workspacePath: string;
  workspaceRoot: string;
  codebaseRoot: string;
  gitRepoRoot: string;
  moduleRegistryAbsolute: string;
  auditDbPath: string;
  fullCodebaseReadRoot?: string;
  channelsConfig: RuntimeChannelsConfig;
  policyConfig: PolicyConfig;
  server: GatewayBootstrapServerInput;
  providerEnv: NodeJS.ProcessEnv;
  discordStartRetry: {
    baseDelayMs: number;
    maxDelayMs: number;
    maxAttempts: number;
  };
  shutdownForceExitTimeoutMs: number;
}

interface GatewayBootstrapOptions {
  config: SubstrateConfig;
  env: GatewayPolicyEnv & NodeJS.ProcessEnv;
  startupHydration: StartupConfigHydrationResult;
}

function parseBooleanEnvWithFallback(value: string | undefined, fallback = false): boolean {
  const parsed = parseBooleanEnv(value);
  return parsed === undefined ? fallback : parsed;
}

function resolveGatewayRuntimeMode(raw: string | undefined): GatewayRuntimeMode {
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
  return normalized as GatewayRuntimeMode;
}

function normalizeConfiguredHttpUrl(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if ((parsed.protocol === 'http:' && parsed.port === '80')
      || (parsed.protocol === 'https:' && parsed.port === '443')) {
      parsed.port = '';
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function resolveLiteLLMDiscoveryModelsUrl(rawBaseUrl: string | undefined): string | null {
  const normalizedBaseUrl = normalizeConfiguredHttpUrl(rawBaseUrl);
  if (!normalizedBaseUrl) return null;

  const parsed = new URL(normalizedBaseUrl);
  const basePath = parsed.pathname
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');
  parsed.pathname = `${basePath}/v1/models`.replace(/\/{2,}/g, '/');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function resolveDiscoveryLaneConfig(input: {
  litellmBaseUrl: string | undefined;
  openRouterModelsApiUrl: string | undefined;
}): { enabled: true; allowHttp: boolean; urlAllowlist: string[] } | undefined {
  const litellmModelsUrl = resolveLiteLLMDiscoveryModelsUrl(input.litellmBaseUrl);
  if (!litellmModelsUrl) {
    return undefined;
  }

  const openRouterUrl = normalizeConfiguredHttpUrl(input.openRouterModelsApiUrl);
  const urlAllowlist = [...new Set(
    [litellmModelsUrl, openRouterUrl]
      .filter((value): value is string => Boolean(value)),
  )];
  if (urlAllowlist.length === 0) {
    return undefined;
  }

  return {
    enabled: true,
    allowHttp: urlAllowlist.some(url => url.startsWith('http://')),
    urlAllowlist,
  };
}

function parseBeadsActionsEnv(value: string | undefined): Array<(typeof ALL_BEADS_ACTIONS)[number]> | undefined {
  const parsed = parseEnvList(value, { separators: [','] });
  if (!parsed) {
    return value === undefined ? undefined : [];
  }

  const valid = new Set(ALL_BEADS_ACTIONS);
  const actions: Array<(typeof ALL_BEADS_ACTIONS)[number]> = [];
  for (const entry of parsed) {
    const normalized = entry.toLowerCase();
    if (valid.has(normalized as (typeof ALL_BEADS_ACTIONS)[number])) {
      actions.push(normalized as (typeof ALL_BEADS_ACTIONS)[number]);
    }
  }
  return actions;
}

function parseVaultActionsEnv(value: string | undefined): Array<(typeof ALL_VAULT_ACTIONS)[number]> | undefined {
  const parsed = parseEnvList(value, { separators: [','] });
  if (!parsed) {
    return value === undefined ? undefined : [];
  }

  const valid = new Set(ALL_VAULT_ACTIONS);
  const actions: Array<(typeof ALL_VAULT_ACTIONS)[number]> = [];
  for (const entry of parsed) {
    const normalized = entry.toLowerCase();
    if (valid.has(normalized as (typeof ALL_VAULT_ACTIONS)[number])) {
      actions.push(normalized as (typeof ALL_VAULT_ACTIONS)[number]);
    }
  }
  return actions;
}

function buildGatewayPolicyConfig(
  config: SubstrateConfig,
  env: GatewayBootstrapOptions['env'],
  workspaceRoot: string,
  codebaseRoot: string,
): PolicyConfig {
  const fullCodebaseReadRoot = resolveFullCodebaseReadRootFromEnv(env, codebaseRoot);
  const discoveryLaneConfig = resolveDiscoveryLaneConfig({
    litellmBaseUrl: config.litellmBaseUrl ?? undefined,
    openRouterModelsApiUrl: config.openRouterModelsApiUrl,
  });
  const shellExecPolicy = buildShellExecPolicyConfig(env);
  const beadsToolsEnabled = parseBooleanEnvWithFallback(env.BEADS_TOOLS_ENABLED, false);
  const beadsAllowActions = parseBeadsActionsEnv(env.BEADS_ALLOW_ACTIONS)
    ?? (beadsToolsEnabled ? [...ALL_BEADS_ACTIONS] : undefined);
  const vaultToolsEnabled = parseBooleanEnvWithFallback(
    env.VAULT_TOOLS_ENABLED,
    Boolean(config.obsidianVaultName),
  );
  const vaultAllowActions = parseVaultActionsEnv(env.VAULT_ALLOW_ACTIONS)
    ?? (vaultToolsEnabled ? [...ALL_VAULT_ACTIONS] : undefined);

  return {
    workspacePath: workspaceRoot,
    allowedReadPaths: resolveAllowedReadPathsFromEnv(env, workspaceRoot),
    ...(fullCodebaseReadRoot ? { fullCodebaseReadRoot } : {}),
    urlPolicy: {
      allowHttp: config.webFetchAllowHttp === true,
      ...(config.webFetchDomainAllowlist && config.webFetchDomainAllowlist.length > 0
        ? { domainAllowlist: config.webFetchDomainAllowlist }
        : {}),
      allowInternalNetwork: config.webFetchAllowInternalNetwork === true,
      ...(discoveryLaneConfig ? { discoveryLane: discoveryLaneConfig } : {}),
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
    shellExec: shellExecPolicy,
    beads: {
      enabled: beadsToolsEnabled,
      ...(beadsAllowActions ? { allowActions: beadsAllowActions } : {}),
    },
    vault: {
      enabled: vaultToolsEnabled,
      ...(vaultAllowActions ? { allowActions: vaultAllowActions } : {}),
    },
  };
}

export function buildGatewayChannelsConfigOverrides(
  config: SubstrateConfig,
  runtimeSettings: StartupConfigHydrationResult['settingsDomains']['runtime'] | undefined,
): RuntimeChannelsConfigOverrides {
  return buildRuntimeChannelsConfigOverrides(config, runtimeSettings ?? {});
}

export function resolveGatewayBootstrapInput(
  options: GatewayBootstrapOptions,
): GatewayBootstrapInput {
  const { config, env, startupHydration } = options;
  const { systemDataDir, runtimePathLayout, settingsDomains } = startupHydration;
  const workspacePath = runtimePathLayout.workspacePath;
  const workspaceRoot = resolveWorkspaceRoot(workspacePath);
  const codebaseRoot = resolve('.');
  const gitRepoRoot = resolveGitRepoRoot({
    codebaseRoot,
    configuredGitRepoRoot: env.GIT_REPO_ROOT,
  });
  const moduleRegistryAbsolute = resolveModuleRegistryPathFromWorkspace(
    workspaceRoot,
    env.MODULE_REGISTRY_PATH,
  );
  const ignoredMutableEnvKeys = getIgnoredJsonBackedConfigEnvKeys(env);
  const runtimeMode = resolveGatewayRuntimeMode(env.PSFN_RUNTIME_MODE);
  const ntfyBaseUrl = env.NTFY_BASE_URL?.trim() || undefined;
  const ntfyTopic = env.NTFY_TOPIC?.trim() || undefined;
  const ntfyToken = resolveOptionalEnvCredential(config.credentialVault, 'NTFY_TOKEN', env);
  const ntfyTimeoutMs = parsePositiveIntEnv(env.NTFY_TIMEOUT_MS, DEFAULT_NTFY_TIMEOUT_MS);
  const ntfyDebounceMs = parsePositiveIntEnv(env.NTFY_DEBOUNCE_MS, DEFAULT_NTFY_DEBOUNCE_MS);
  const confirmationExpiryMs = parsePositiveIntEnv(
    env.CONFIRMATION_EXPIRY_MS,
    DEFAULT_CONFIRMATION_EXPIRY_MS,
  );
  const confirmationOperatorDiscordChannelId = env.CONFIRMATION_OPERATOR_DISCORD_CHANNEL_ID?.trim() || undefined;
  const confirmationNtfyTopic = env.CONFIRMATION_NTFY_TOPIC?.trim() || undefined;
  const workspacePathProvided = Boolean(env.WORKSPACE_PATH?.trim());
  const sessionHmacKeyring = requireGatewaySessionHmacKeyring(env);
  const wyomingShardRouting = parseWyomingShardRoutingConfigEnv(env);
  const auditDbPath = env.AUDIT_DB_PATH ?? resolve(systemDataDir, 'gateway-audit.db');
  const providerEnv = buildProviderCredentialEnv(config, env);
  const channelsConfig = loadRuntimeChannelsConfig(
    systemDataDir,
    env,
    buildGatewayChannelsConfigOverrides(config, settingsDomains.runtime),
    { credentialVault: config.credentialVault },
  );

  const ntfyConfigured = Boolean(ntfyBaseUrl && ntfyTopic);
  const ntfyConfigIncomplete = Boolean(
    (ntfyBaseUrl && !ntfyTopic) || (!ntfyBaseUrl && ntfyTopic),
  );

  return {
    diagnostics: {
      ignoredMutableEnvKeys,
      workspacePathProvided,
      ntfyConfigIncomplete,
    },
    runtimeMode,
    socketPath: env.GATEWAY_SOCKET ?? DEFAULT_SOCKET_PATH,
    workspacePath,
    workspaceRoot,
    codebaseRoot,
    gitRepoRoot,
    moduleRegistryAbsolute,
    auditDbPath,
    fullCodebaseReadRoot: resolveFullCodebaseReadRootFromEnv(env, codebaseRoot),
    channelsConfig,
    policyConfig: buildGatewayPolicyConfig(config, env, workspaceRoot, codebaseRoot),
    server: {
      sessionHmacKeyring,
      wyomingShardRouting,
      ...(ntfyConfigured
        ? {
          ntfy: {
            baseUrl: ntfyBaseUrl,
            defaultTopic: ntfyTopic,
            token: ntfyToken,
            timeoutMs: ntfyTimeoutMs,
            debounceWindowMs: ntfyDebounceMs,
          },
        }
        : {}),
      confirmation: {
        expiryMs: confirmationExpiryMs,
        operatorDiscordChannelId: confirmationOperatorDiscordChannelId,
        ntfyTopic: confirmationNtfyTopic,
      },
    },
    providerEnv,
    discordStartRetry: {
      baseDelayMs: parsePositiveIntEnv(
        env.DISCORD_START_RETRY_BASE_DELAY_MS,
        DEFAULT_DISCORD_START_RETRY_BASE_DELAY_MS,
      ),
      maxDelayMs: parsePositiveIntEnv(
        env.DISCORD_START_RETRY_MAX_DELAY_MS,
        DEFAULT_DISCORD_START_RETRY_MAX_DELAY_MS,
      ),
      maxAttempts: parsePositiveIntEnv(
        env.DISCORD_START_RETRY_MAX_ATTEMPTS,
        DEFAULT_DISCORD_START_RETRY_MAX_ATTEMPTS,
      ),
    },
    shutdownForceExitTimeoutMs: parsePositiveIntEnv(
      env.SHUTDOWN_FORCE_EXIT_TIMEOUT_MS,
      DEFAULT_SHUTDOWN_FORCE_EXIT_TIMEOUT_MS,
    ),
  };
}
