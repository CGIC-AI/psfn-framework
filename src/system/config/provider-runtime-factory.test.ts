import { describe, expect, it } from 'vitest';
import type { SubstrateConfig } from './runtime-config-contracts.js';
import { LLMClient } from '../../primitives/llm/client.js';
import { createProviderRuntimeServices } from './provider-runtime-factory.js';

function makeConfig(): SubstrateConfig {
  return {
    primaryModel: 'openrouter/z-ai/glm-5',
    primaryProvider: 'openrouter',
    extractionModel: 'openrouter/deepseek/deepseek-v3.2',
    extractionProvider: 'openrouter',
    primaryMaxTokens: 4096,
    extractionMaxTokens: 2048,
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir: '/tmp/psfn-provider-runtime-test',
    databasePath: '/tmp/psfn-provider-runtime-test/companion.db',
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {
      chat: {
        model: 'openrouter/z-ai/glm-5',
        provider: 'openrouter',
        maxTokens: 4096,
        contextWindow: 128_000,
      },
      background: {
        model: 'openrouter/deepseek/deepseek-v3.2',
        provider: 'openrouter',
        maxTokens: 2048,
      },
    },
    embeddingProvider: 'api',
    embeddingApiUrl: 'https://embedding.example.test/v1/embeddings',
    embeddingApiModel: 'text-embedding-3-small',
    embeddingApiDims: 1536,
    litellmBaseUrl: 'https://litellm.example.test/v1',
  } as SubstrateConfig;
}

describe('createProviderRuntimeServices', () => {
  it('builds the runtime-facing llm and embedding provider bundle explicitly', () => {
    const services = createProviderRuntimeServices({
      config: makeConfig(),
      providerEnv: {
        OPENAI_API_KEY: 'provider-secret',
      },
    });

    expect(services.llmClient).toBeInstanceOf(LLMClient);
    expect(services.embeddingProvider.kind).toBe('api');
    expect(services.embeddingProvider.dims).toBe(1536);
  });
});
