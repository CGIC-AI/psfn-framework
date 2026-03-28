import { describe, expect, it } from 'vitest';
import type { SubstrateConfig } from '../types.js';
import { createGatewayPrivilegedServiceRegistry } from './privileged-services.js';

function createConfig(): SubstrateConfig {
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
  } as SubstrateConfig;
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
});
