import { describe, expect, it } from 'vitest';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { CanonicalProviderRegistry } from '../../shared/contracts/runtime.js';
import { createGatewayPrivilegedServiceRegistry } from './privileged-services.js';

function createConfig(overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  return {
    litellmBaseUrl: 'https://litellm.local',
    openRouterModelsApiUrl: 'https://openrouter.local/models',
    dataDir: '/tmp/psfn-gateway-data',
    webFetchAllowHttp: false,
    webFetchAllowInternalNetwork: false,
    webFetchDomainAllowlist: ['example.com'],
    webFetchLocalCrawlerEnabled: false,
    webFetchLocalCrawlerAllowHttp: false,
    webFetchLocalCrawlerHostAllowlist: [],
    webFetchLocalCrawlerDomainAllowlist: [],
    webFetchTlsCaCertPaths: [],
    obsidianVaultName: 'vault',
    obsidianCliPath: 'obsidian',
    obsidianTimeoutMs: 1000,
    gatewayTlsRejectUnauthorized: true,
    embeddingProvider: 'api',
    embeddingApiUrl: 'https://embedding.local',
    embeddingApiModel: 'embed-model',
    embeddingApiDims: 384,
    wyomingEnabled: false,
    telegramEnabled: false,
    capabilityTier: 'nursery',
    obsidianAutoPublish: false,
    ...overrides,
  } as SubstrateConfig;
}

function providerRegistry(providers: CanonicalProviderRegistry['providers']): CanonicalProviderRegistry {
  return { schemaVersion: 1, providers };
}

describe('createGatewayPrivilegedServiceRegistry', () => {
  it('creates gateway privileged services behind a single registry', () => {
    const registry = createGatewayPrivilegedServiceRegistry({
      config: createConfig(),
      providerEnv: {
        EMBEDDING_API_KEY: 'embedding-secret',
      },
      vaultPolicyConfig: {
        enabled: true,
      },
    });

    expect(registry.embeddingProvider.kind).toBe('api');
    expect(registry.llmClient).toBeDefined();
    expect(registry.vaultOps).toBeDefined();
  });

  it('omits vault ops when the vault policy is disabled', () => {
    const registry = createGatewayPrivilegedServiceRegistry({
      config: createConfig(),
      providerEnv: {
        EMBEDDING_API_KEY: 'embedding-secret',
      },
      vaultPolicyConfig: {
        enabled: false,
      },
    });

    expect(registry.vaultOps).toBeUndefined();
  });

  it('constructs model discovery from an OpenRouter provider without any LiteLLM URL', () => {
    const registry = createGatewayPrivilegedServiceRegistry({
      config: createConfig({
        litellmBaseUrl: undefined,
        providerRegistry: providerRegistry([
          {
            id: 'openrouter',
            type: 'openrouter',
            enabled: true,
            apiBaseUrl: 'https://openrouter.ai/api/v1',
            modelsApiUrl: 'https://openrouter.ai/api/v1/models',
          },
        ]),
      }),
      providerEnv: {},
    });

    expect(registry.modelDiscovery).toBeDefined();
  });

  it('constructs model discovery from a configured generic OpenAI-compatible router', () => {
    const registry = createGatewayPrivilegedServiceRegistry({
      config: createConfig({
        litellmBaseUrl: undefined,
        providerRegistry: providerRegistry([
          {
            id: 'shared-router',
            type: 'generic_openai',
            enabled: true,
            apiBaseUrl: 'https://router.example.test/v1',
            apiKeyRef: { kind: 'env', envName: 'SHARED_ROUTER_API_KEY' },
          },
        ]),
      }),
      providerEnv: { SHARED_ROUTER_API_KEY: 'shared-secret' },
    });

    expect(registry.modelDiscovery).toBeDefined();
  });

  it('omits model discovery when no discovery-capable provider is configured', () => {
    const registry = createGatewayPrivilegedServiceRegistry({
      config: createConfig({
        litellmBaseUrl: undefined,
        providerRegistry: providerRegistry([
          { id: 'anthropic', type: 'anthropic', enabled: true, apiBaseUrl: 'https://api.anthropic.com/v1' },
        ]),
      }),
      providerEnv: {},
    });

    expect(registry.modelDiscovery).toBeUndefined();
  });
});
