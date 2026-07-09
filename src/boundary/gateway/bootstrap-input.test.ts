import { describe, expect, it } from 'vitest';
import type { StartupConfigHydrationResult } from '../../app/startup/support/bootstrap-helpers.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
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
      legacySettingsKeys: [],
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
    characterCardPath: '/workspace/companion-data/companion.json',
    companionDataDir: '/companion-data',
    wyomingEnabled: false,
    telegramEnabled: false,
    capabilityTier: 'nursery',
    obsidianAutoPublish: false,
    obsidianTimeoutMs: 1000,
    wyomingShardRouting: {
      enabled: true,
      siteAllowlist: ['site-a'],
    },
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
        BEADS_TOOLS_ENABLED: 'true',
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
        WYOMING_SHARD_DELEGATION_ENABLED: 'false',
        WYOMING_SHARD_DELEGATION_SITE_ALLOWLIST: 'env-site',
      },
      startupHydration: createStartupHydration(),
    });

    expect(bootstrap.runtimeMode).toBe('gateway-agent');
    expect(bootstrap.socketPath).toBe('/run/psfn/gateway.sock');
    expect(bootstrap.gatewayRpcEndpoint).toEqual({
      kind: 'unix',
      socketPath: '/run/psfn/gateway.sock',
    });
    expect(bootstrap.workspacePath).toBe('/workspace');
    expect(bootstrap.workspaceRoot).toBe('/workspace');
    expect(bootstrap.gitRepoRoot).toBe(process.cwd());
    expect(bootstrap.moduleRegistryAbsolute).toBe('/workspace/registry/module-registry.json');
    expect(bootstrap.auditDbPath).toBe('/system-data/gateway-audit.db');
    expect(bootstrap.fullCodebaseReadRoot).toBeUndefined();
    expect(bootstrap.channelsConfig.telegram.enabled).toBe(false);
    expect(bootstrap.server.sessionHmacKeyring.activeVersion).toBe('v1');
    expect(bootstrap.server.wyomingShardRouting).toMatchObject({
      enabled: true,
      siteAllowlist: ['site-a'],
    });
    expect(bootstrap.server.ntfy).toMatchObject({
      baseUrl: 'https://ntfy.local',
      defaultTopic: 'alerts',
      token: 'ntfy-token',
    });
    expect(bootstrap.policyConfig.workspacePath).toBe('/workspace');
    expect(bootstrap.policyConfig.beads).toEqual({
      enabled: true,
      allowActions: ['ready', 'show', 'create', 'update', 'close', 'sync'],
    });
    expect(bootstrap.policyConfig.vault).toEqual({
      enabled: false,
    });
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

  it('resolves the multi-companion flag into the gateway server bootstrap contract', () => {
    const baseEnv = {
      PSFN_RUNTIME_MODE: 'gateway-agent',
      GATEWAY_SOCKET: '/run/psfn/gateway.sock',
      WORKSPACE_PATH: '/workspace',
      GIT_REPO_ROOT: process.cwd(),
      GATEWAY_SESSION_HMAC_KEY: 'v1:test-session-secret',
    };

    const flagOff = resolveGatewayBootstrapInput({
      config: createConfig(),
      env: { ...baseEnv },
      startupHydration: createStartupHydration(),
    });
    expect(flagOff.server.multiCompanion).toEqual({
      enabled: false,
      fleetCompanionIds: [],
      channelRouting: {},
      discordAccounts: {},
    });

    const flagOn = resolveGatewayBootstrapInput({
      config: {
        ...createConfig(),
        multiCompanion: true,
        companionFleet: {
          persistenceRoot: '/runtime',
          companions: [{
            companionId: 'comp-a',
            companionDataDir: '/runtime/comp-a',
            characterCardPath: '/runtime/comp-a/companion.json',
            postgresSchema: 'companion_a',
          }],
        },
      },
      env: { ...baseEnv },
      startupHydration: createStartupHydration(),
    });
    expect(flagOn.server.multiCompanion).toEqual({
      enabled: true,
      fleetCompanionIds: ['comp-a'],
      channelRouting: {},
      discordAccounts: {},
    });
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

  it('honors an explicit BEADS_TOOLS_ENABLED=false override', () => {
    const bootstrap = resolveGatewayBootstrapInput({
      config: createConfig(),
      env: {
        PSFN_RUNTIME_MODE: 'split',
        WORKSPACE_PATH: '/workspace',
        GATEWAY_SESSION_HMAC_KEY: 'v1:test-session-secret',
        BEADS_TOOLS_ENABLED: 'false',
      },
      startupHydration: createStartupHydration(),
    });

    expect(bootstrap.policyConfig.beads).toEqual({
      enabled: false,
    });
  });

  it('parses explicit WSS gateway RPC endpoint configuration', () => {
    const bootstrap = resolveGatewayBootstrapInput({
      config: createConfig(),
      env: {
        PSFN_RUNTIME_MODE: 'split',
        WORKSPACE_PATH: '/workspace',
        GATEWAY_SESSION_HMAC_KEY: 'v1:test-session-secret',
        GATEWAY_RPC_ENDPOINT: 'wss://gateway-rpc.local:10054/rpc',
        GATEWAY_RPC_TLS_CA_PATH: '/certs/ca.pem',
        GATEWAY_RPC_TLS_CERT_PATH: '/certs/gateway.pem',
        GATEWAY_RPC_TLS_KEY_PATH: '/certs/gateway-key.pem',
        GATEWAY_RPC_TLS_EXPECTED_PEER_SPIFFE_URI: 'spiffe://cluster.local/psfn/agent/test-companion',
      },
      startupHydration: createStartupHydration(),
    });

    expect(bootstrap.gatewayRpcEndpoint).toEqual({
      kind: 'wss',
      url: 'wss://gateway-rpc.local:10054/rpc',
      host: 'gateway-rpc.local',
      port: 10054,
      path: '/rpc',
      tls: {
        caPath: '/certs/ca.pem',
        certPath: '/certs/gateway.pem',
        keyPath: '/certs/gateway-key.pem',
        expectedPeerSpiffeUri: 'spiffe://cluster.local/psfn/agent/test-companion',
      },
    });
  });

  it('rejects WSS gateway RPC selection without TLS file configuration', () => {
    expect(() => resolveGatewayBootstrapInput({
      config: createConfig(),
      env: {
        PSFN_RUNTIME_MODE: 'split',
        WORKSPACE_PATH: '/workspace',
        GATEWAY_SESSION_HMAC_KEY: 'v1:test-session-secret',
        GATEWAY_RPC_ENDPOINT: 'wss://gateway-rpc.local:10054/rpc',
      },
      startupHydration: createStartupHydration(),
    })).toThrow(/GATEWAY_RPC_ENDPOINT=wss requires GATEWAY_RPC_TLS_CA_PATH/);
  });

  it('only enables legacy vault tools when explicitly requested', () => {
    const bootstrap = resolveGatewayBootstrapInput({
      config: createConfig(),
      env: {
        PSFN_RUNTIME_MODE: 'split',
        WORKSPACE_PATH: '/workspace',
        GATEWAY_SESSION_HMAC_KEY: 'v1:test-session-secret',
        VAULT_TOOLS_ENABLED: 'true',
        VAULT_ALLOW_ACTIONS: 'read,search',
      },
      startupHydration: createStartupHydration(),
    });

    expect(bootstrap.policyConfig.vault).toEqual({
      enabled: true,
      allowActions: ['read', 'search'],
    });
  });
});
