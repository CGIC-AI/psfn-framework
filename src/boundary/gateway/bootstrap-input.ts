import { resolve } from 'node:path';
import type { SubstrateConfig, WyomingShardRoutingConfig } from '../../system/config/runtime-config-contracts.js';
import type { CanonicalProviderRegistry } from '../../shared/contracts/runtime.js';
import { getIgnoredJsonBackedConfigEnvKeys } from '../../system/config/legacy-env.js';
import {
  assertDiscordAccountTokensConfigured,
  assertMulticaTokenConfigured,
  loadRuntimeChannelsConfig,
  type RuntimeChannelsConfig,
  type RuntimeChannelsConfigOverrides,
} from '../../channels/backplane/config.js';
import {
  resolveAllowedReadPathsFromEnv,
  resolveFullCodebaseReadRootFromEnv,
  type GatewayPolicyEnv,
} from './policy-config.js';
import { resolveWorkspaceRoot } from './filesystem-paths.js';
import { HOOKS_DIRECTORY_NAME } from './hook-loader.js';
import { resolveGitRepoRoot } from '../integrations/git/repo-root.js';
import {
  resolveBeadsActionsForCaller,
  resolveBeadsToolsEnabled,
} from '../integrations/beads/enablement.js';
import { resolveModuleRegistryPathFromWorkspace } from '../../system/modules/registry.js';
import { parsePositiveIntEnv } from '../../shared/utils/env.js';
import { createDefaultShellExecSettings } from '../../system/config/shell-exec-config.js';
import {
  buildProviderCredentialEnv,
  resolveOptionalCredentialReference,
  resolveOptionalEnvCredential,
} from '../custody/credential-vault.js';
import { requireGatewaySessionHmacKeyring } from './session-hmac-env.js';
import { loadPlacesRegistryConfig } from '../../channels/backplane/places-registry.js';
import { setRuntimeChannelEnvelopeLabels } from '../../system/trust/runtime-channel-labels.js';
import { setRuntimeChannelClassificationEpochs } from '../../system/trust/runtime-classification-epochs.js';
import {
  buildRuntimeChannelsConfigOverrides,
  type StartupConfigHydrationResult,
} from '../../app/startup/support/bootstrap-helpers.js';
import type { PolicyConfig, WebBackendPolicy } from './policy.js';
import type { GatewayNtfyConfig } from './ntfy-notifier.js';
import type { SessionHmacKeyring } from '../../persistence/journals/journal-utils.js';
import {
  resolveCompanionStateDir,
  resolvePersonalSkillsDir,
} from '../../persistence/layout.js';
import { DEFAULT_DISCORD_START_RETRY_BASE_DELAY_MS,
  DEFAULT_DISCORD_START_RETRY_MAX_DELAY_MS,
  DEFAULT_DISCORD_START_RETRY_MAX_ATTEMPTS,
} from './discord-startup.js';
import {
  resolveGatewayRpcEndpointFromEnv,
  type GatewayRpcEndpoint,
} from './transport.js';
import {
  resolveGatewayMultiCompanionConfig,
  type GatewayMultiCompanionConfig,
} from './multi-companion.js';
import { resolveGatewayCredentialPresence } from './credential-presence.js';
import { deriveGenericOpenAiModelsApiUrl } from '../../primitives/llm/discovery.js';
import type { GatewayCredentialPresenceResult } from './protocol.js';
import type { SatelliteRegistryConfig } from '../../shared/contracts/satellite-registry.js';
import {
  ALL_VAULT_ACTIONS,
  parseVaultActionsEnv,
  resolveVaultToolsEnabled,
} from '../integrations/vault/enablement.js';

const DEFAULT_SOCKET_PATH = '/run/psfn/gateway.sock';
const DEFAULT_NTFY_TIMEOUT_MS = 8_000;
const DEFAULT_NTFY_DEBOUNCE_MS = 60_000;
const DEFAULT_CONFIRMATION_EXPIRY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SHUTDOWN_FORCE_EXIT_TIMEOUT_MS = 15_000;

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
  multiCompanion: GatewayMultiCompanionConfig;
  credentialPresence: GatewayCredentialPresenceResult;
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
  gatewayRpcEndpoint: GatewayRpcEndpoint;
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
  satelliteRegistryConfig: SatelliteRegistryConfig;
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

function resolveDiscoveryLaneConfig(input: {
  providerRegistry: CanonicalProviderRegistry | undefined;
  openRouterModelsApiUrl: string | undefined;
}): { enabled: true; allowHttp: boolean; urlAllowlist: string[] } | undefined {
  const urls: string[] = [];

  const openRouterUrl = normalizeConfiguredHttpUrl(input.openRouterModelsApiUrl);
  if (openRouterUrl) {
    urls.push(openRouterUrl);
  }

  for (const provider of input.providerRegistry?.providers ?? []) {
    if (!provider.enabled) continue;
    if (provider.type !== 'generic_openai') continue;
    const modelsApiUrl = provider.modelsApiUrl?.trim()
      ?? deriveGenericOpenAiModelsApiUrl(provider.apiBaseUrl);
    const normalized = normalizeConfiguredHttpUrl(modelsApiUrl);
    if (normalized) {
      urls.push(normalized);
    }
  }

  const urlAllowlist = [...new Set(urls)];
  if (urlAllowlist.length === 0) {
    return undefined;
  }

  return {
    enabled: true,
    allowHttp: urlAllowlist.some(url => url.startsWith('http://')),
    urlAllowlist,
  };
}

// Resolve the explicit web backend (bead htm9.10). When the
// OpenRouter web tools are enabled in providers.json, the gateway resolves the
// OpenRouter base URL + API key here (the gateway is the secret holder) and
// fails closed if any required piece is missing — there is no silent fallback
// to the self-hosted lane. When not enabled, the self-hosted path is selected.
function resolveWebBackendPolicy(
  config: SubstrateConfig,
  env: GatewayBootstrapOptions['env'],
): WebBackendPolicy {
  const webTools = config.openRouterWebTools;
  if (!webTools?.enabled) {
    return { kind: 'self_hosted' };
  }

  const apiBaseUrl = config.openRouterApiBaseUrl?.trim();
  if (!apiBaseUrl) {
    throw new Error(
      'OpenRouter web backend is enabled (providers.json openrouter.metadata.webTools) '
      + 'but no OpenRouter apiBaseUrl is configured on the openrouter provider.',
    );
  }
  if (!config.openRouterApiKeyRef) {
    throw new Error(
      'OpenRouter web backend is enabled but the openrouter provider has no apiKeyRef; '
      + 'the gateway cannot resolve an OpenRouter API key for web search/fetch.',
    );
  }
  const apiKey = resolveOptionalCredentialReference(
    config.credentialVault,
    config.openRouterApiKeyRef,
    env,
  );
  if (!apiKey) {
    throw new Error(
      'OpenRouter web backend is enabled but the OpenRouter API key '
      + `(${config.openRouterApiKeyRef.envName}) is not resolvable.`,
    );
  }
  if (!webTools.model) {
    throw new Error(
      'OpenRouter web backend is enabled but metadata.webTools.model is missing.',
    );
  }

  return {
    kind: 'openrouter',
    openRouter: { apiBaseUrl, apiKey, model: webTools.model },
  };
}

function buildGatewayPolicyConfig(
  config: SubstrateConfig,
  env: GatewayBootstrapOptions['env'],
  workspaceRoot: string,
  codebaseRoot: string,
  systemDataDir: string,
  companionDataDir: string,
): PolicyConfig {
  const fullCodebaseReadRoot = resolveFullCodebaseReadRootFromEnv(env, codebaseRoot);
  const discoveryLaneConfig = resolveDiscoveryLaneConfig({
    providerRegistry: config.providerRegistry,
    openRouterModelsApiUrl: config.openRouterModelsApiUrl,
  });
  // Internal runtime derivation (never operator-configurable): the read-only
  // repository copy the sandbox may mount at /repo is the deployment's
  // repository checkout. Absence with mountRepositoryReadOnly=true fails
  // closed at shell.exec time.
  const repositoryMountSource = env.PSFN_REPOSITORY_DIR?.trim() || undefined;
  const shellExecPolicy = {
    ...(config.shellExec ?? createDefaultShellExecSettings()),
    ...(repositoryMountSource ? { repositoryMountSource } : {}),
    systemDataRoot: systemDataDir,
    companionDataRoot: companionDataDir,
  };
  const beadsToolsEnabled = resolveBeadsToolsEnabled(env.BEADS_TOOLS_ENABLED, {
    workspaceRoot,
    codebaseRoot,
  });
  const beadsAllowActions = beadsToolsEnabled
    ? resolveBeadsActionsForCaller(env.BEADS_ALLOW_ACTIONS, 'companion')
    : undefined;
  const vaultToolsEnabled = resolveVaultToolsEnabled(env.VAULT_TOOLS_ENABLED);
  const vaultAllowActions = parseVaultActionsEnv(env.VAULT_ALLOW_ACTIONS)
    ?? (vaultToolsEnabled ? [...ALL_VAULT_ACTIONS] : undefined);

  return {
    workspacePath: workspaceRoot,
    allowedReadPaths: resolveAllowedReadPathsFromEnv(env, workspaceRoot),
    protectedWritePaths: [
      resolve(resolveCompanionStateDir(config.companionDataDir ?? workspaceRoot)),
      resolve(config.characterCardPath),
      resolve(resolvePersonalSkillsDir(workspaceRoot)),
      // Fence the operator hook root: the hook loader dynamically imports
      // handler modules from <workspaceRoot>/hooks at startup, so a model-driven
      // fs.write/fs.edit into it would be arbitrary code execution in the
      // cognition process on the next restart. Reuse the loader's constant so
      // the fence can never drift from the directory the loader executes.
      resolve(workspaceRoot, HOOKS_DIRECTORY_NAME),
    ],
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
    webBackend: resolveWebBackendPolicy(config, env),
    shellExec: shellExecPolicy,
    beads: {
      enabled: beadsToolsEnabled,
      ...(beadsAllowActions ? { allowActions: beadsAllowActions } : {}),
    },
    homeAssistant: {
      enabled: config.homeAssistantEnabled === true,
      ...(env.SATELLITE_HUB_CONTROL_BASE_URL?.trim()
        ? { hubBaseUrl: env.SATELLITE_HUB_CONTROL_BASE_URL.trim() }
        : {}),
      autonomousControlEnabled: config.capabilityTier === 'autonomous',
      placesRegistry: loadPlacesRegistryConfig(systemDataDir),
      tokenConfigured: Boolean(resolveOptionalEnvCredential(
        config.credentialVault,
        'SATELLITE_HUB_CONTROL_TOKEN',
        env,
      )),
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
  const { config, env, startupHydration, satelliteRegistryConfig } = options;
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
  const wyomingShardRouting = config.wyomingShardRouting ?? { enabled: false };
  const auditDbPath = env.AUDIT_DB_PATH ?? resolve(systemDataDir, 'gateway-audit.db');
  const providerEnv = buildProviderCredentialEnv(config, env);
  const gatewayRpcEndpoint = resolveGatewayRpcEndpointFromEnv(env, DEFAULT_SOCKET_PATH);
  const channelsConfig = loadRuntimeChannelsConfig(
    systemDataDir,
    env,
    buildGatewayChannelsConfigOverrides(config, settingsDomains.runtime),
    { credentialVault: config.credentialVault },
  );
  // W1-P2: the gateway is the secret holder — every configured discord bot
  // account must have resolved its token from env, or startup stops here.
  assertDiscordAccountTokensConfigured(channelsConfig.discord);
  assertMulticaTokenConfigured(channelsConfig.multica);
  // E3.2: publish channel-owned Context Envelope labels so gateway-side
  // classification consumers see the same precedence as the agent process.
  setRuntimeChannelEnvelopeLabels(channelsConfig.contextEnvelope.channels);
  // jp36.6.4: publish the persisted classification-epoch records so gateway-side
  // disclosure enforcement sees the same demotion boundaries as the agent process.
  setRuntimeChannelClassificationEpochs(channelsConfig.contextEnvelope.classificationEpochs);

  const ntfyConfigIncomplete = Boolean(
    (ntfyBaseUrl && !ntfyTopic) || (!ntfyBaseUrl && ntfyTopic),
  );
  const ntfy = ntfyBaseUrl && ntfyTopic
    ? {
      baseUrl: ntfyBaseUrl,
      defaultTopic: ntfyTopic,
      token: ntfyToken,
      timeoutMs: ntfyTimeoutMs,
      debounceWindowMs: ntfyDebounceMs,
    }
    : undefined;

  return {
    diagnostics: {
      ignoredMutableEnvKeys,
      workspacePathProvided,
      ntfyConfigIncomplete,
    },
    runtimeMode,
    socketPath: gatewayRpcEndpoint.kind === 'unix'
      ? gatewayRpcEndpoint.socketPath
      : env.GATEWAY_SOCKET ?? DEFAULT_SOCKET_PATH,
    gatewayRpcEndpoint,
    workspacePath,
    workspaceRoot,
    codebaseRoot,
    gitRepoRoot,
    moduleRegistryAbsolute,
    auditDbPath,
    fullCodebaseReadRoot: resolveFullCodebaseReadRootFromEnv(env, codebaseRoot),
    channelsConfig,
    policyConfig: buildGatewayPolicyConfig(
      config,
      env,
      workspaceRoot,
      codebaseRoot,
      startupHydration.systemDataDir,
      startupHydration.companionDataDir,
    ),
    server: {
      sessionHmacKeyring,
      wyomingShardRouting,
      multiCompanion: resolveGatewayMultiCompanionConfig(
        config,
        channelsConfig,
        satelliteRegistryConfig,
      ),
      credentialPresence: resolveGatewayCredentialPresence({
        config,
        channelsConfig,
        env,
      }),
      ...(ntfy ? { ntfy } : {}),
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
