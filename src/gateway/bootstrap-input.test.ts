import { describe, expect, it } from 'vitest';
import type { StartupConfigHydrationResult } from '../runtime/bootstrap-helpers.js';
import type { SubstrateConfig } from '../system/config/runtime-config-contracts.js';
import {
  buildGatewayChannelsConfigOverrides,
  resolveGatewayBootstrapInput,
} from './bootstrap-input.js';

function createStartupHydration(): StartupConfigHydrationResult {
  return {
    systemDataDir: '/system-data',
    companionDataDir: '/companion-data',
    runtimePathLayout: {
      mode: 'split',
      workspacePath: '/workspace',
    } as StartupConfigHydrationResult['runtimePathLayout'],
    settingsDomains: {
      runtime: {},
    } as StartupConfigHydrationResult['settingsDomains'],
    modelsLoadResult: {} as StartupConfigHydrationResult['modelsLoadResult'],
    providersLoadResult: {} as StartupConfigHydrationResult['providersLoadResult'],
    trustPolicyConfig: {
      channelClassification: {
        visibilityOverrides: {
          exact: {},
          prefix: {},
        },
      },
    } as StartupConfigHydrationResult['trustPolicyConfig'],
    schedulerConfig: {} as StartupConfigHydrationResult['schedulerConfig'],
    diagnostics: {
      modelsMigratedFromLegacySettings: false,
      modelsLegacyDriftDetected: false,
      providersMigratedFromLegacyConfig: false,
      providersLegacyDriftDetected: false,
      maintenanceIntervalMigration: { state: 'none' },
      capabilityTierMigration: { state: 'none' },
      removedLegacyKeys: [],
    },
  };
}

function createConfig(): SubstrateConfig {
  return {
    litellmBaseUrl: 'https://litellm.local',
    openRouterModelsApiUrl: 'https://openrouter.local/models',
    webFetchAllowHttp: false,
    webFetchAllowInternalNetwork: false,
    webFetchDomainAllowlist: ['example.com'],
    webFetchLocalCrawlerEnabled: false,
    webFetchLocalCrawlerAllowHttp: false,
    webFetchLocalCrawlerHostAllowlist: [],
    webFetchLocalCrawlerDomainAllowlist: [],
    webFetchTlsCaCertPaths: [],
    obsidianVaultName: 'vault',
    gatewayTlsRejectUnauthorized: true,
    embeddingProvider: 'api',
    embeddingApiUrl: 'https://embedding.local',
    embeddingApiModel: 'embed-model',
    embeddingApiDims: 384,
    wyomingEnabled: false,
    telegramEnabled: false,
    capabilityTier: 'nursery',
    obsidianAutoPublish: false,
    obsidianTimeoutMs: 1000,
  } as SubstrateConfig;
}

describe('resolveGatewayBootstrapInput', () => {
  it('resolves a structured gateway bootstrap contract from env and hydration', () => {
    const bootstrap = resolveGatewayBootstrapInput({
      config: createConfig(),
      env: {
        PSFN_RUNTIME_MODE: 'gateway-agent',
        GATEWAY_SOCKET: '/run/psfn/gateway.sock',
        WORKSPACE_PATH: '/workspace',
        GIT_REPO_ROOT: process.cwd(),
        MODULE_REGISTRY_PATH: 'registry/module-registry.json',
        GATEWAY_SESSION_HMAC_KEY: 'v1:test-session-secret',
        NTFY_BASE_URL: 'https://ntfy.local',
        NTFY_TOPIC: 'alerts',
        NTFY_TOKEN: 'ntfy-token',
        CONFIRMATION_EXPIRY_MS: '86400000',
        SHUTDOWN_FORCE_EXIT_TIMEOUT_MS: '12000',
        DISCORD_START_RETRY_BASE_DELAY_MS: '11',
        DISCORD_START_RETRY_MAX_DELAY_MS: '22',
        DISCORD_START_RETRY_MAX_ATTEMPTS: '3',
        EMBEDDING_API_KEY: 'embedding-secret',
        OPENAI_API_KEY: 'openai-secret',
        LITELLM_API_KEY: 'litellm-secret',
        HF_TOKEN: 'hf-token',
        HF_ACCESS_TOKEN: 'hf-access-token',
        HUGGINGFACE_HUB_TOKEN: 'hf-hub-token',
        TRANSFORMERS_HF_TOKEN: 'transformers-token',
      },
      startupHydration: createStartupHydration(),
    });

    expect(bootstrap.runtimeMode).toBe('gateway-agent');
    expect(bootstrap.socketPath).toBe('/run/psfn/gateway.sock');
    expect(bootstrap.workspacePath).toBe('/workspace');
    expect(bootstrap.workspaceRoot).toBe('/workspace');
    expect(bootstrap.gitRepoRoot).toBe(process.cwd());
    expect(bootstrap.moduleRegistryAbsolute).toBe('/workspace/registry/module-registry.json');
    expect(bootstrap.auditDbPath).toBe('/system-data/gateway-audit.db');
    expect(bootstrap.fullCodebaseReadRoot).toBeUndefined();
    expect(bootstrap.channelsConfig.telegram.enabled).toBe(false);
    expect(bootstrap.server.sessionHmacKeyring.activeVersion).toBe('v1');
    expect(bootstrap.server.wyomingShardRouting).toMatchObject({ enabled: false });
    expect(bootstrap.server.ntfy).toMatchObject({
      baseUrl: 'https://ntfy.local',
      defaultTopic: 'alerts',
      token: 'ntfy-token',
    });
    expect(bootstrap.policyConfig.workspacePath).toBe('/workspace');
    expect(bootstrap.providerEnv.OPENAI_API_KEY).toBe('openai-secret');
    expect(bootstrap.discordStartRetry).toEqual({
      baseDelayMs: 11,
      maxDelayMs: 22,
      maxAttempts: 3,
    });
    expect(bootstrap.shutdownForceExitTimeoutMs).toBe(12000);
    expect(bootstrap.diagnostics.ntfyConfigIncomplete).toBe(false);
    expect(bootstrap.diagnostics.workspacePathProvided).toBe(true);
  });

  it('preserves telegram override presence when telegramEnabled is explicitly false', () => {
    expect(
      buildGatewayChannelsConfigOverrides({
        ...createConfig(),
        telegramEnabled: false,
        telegramAuthorizedUsers: ['primary-user'],
      } as SubstrateConfig,
      {
        telegramEnabled: false,
        telegramAuthorizedUsers: ['primary-user'],
      } as StartupConfigHydrationResult['settingsDomains']['runtime']),
    ).toEqual({
      telegram: {
        enabled: false,
        allowedUsers: ['primary-user'],
      },
    });
  });
});
