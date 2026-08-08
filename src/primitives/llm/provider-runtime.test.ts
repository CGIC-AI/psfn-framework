import { afterEach, describe, expect, it } from 'vitest';
import {
  createModels,
  createProvider,
  envApiKeyAuth,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { PiProviderRuntime } from './provider-runtime.js';

const TEST_API_KEY_ENV = 'PSFN_PROVIDER_RUNTIME_TEST_KEY';

afterEach(() => {
  delete process.env[TEST_API_KEY_ENV];
});

describe('PiProviderRuntime auth', () => {
  it('delegates provider auth resolution to the owned Models collection', async () => {
    process.env[TEST_API_KEY_ENV] = 'provider-secret';
    const models = createModels();
    models.setProvider(createProvider({
      id: 'test-provider',
      auth: { apiKey: envApiKeyAuth('Test provider API key', [TEST_API_KEY_ENV]) },
      models: [],
      api: openAICompletionsApi(),
    }));

    const runtime = new PiProviderRuntime(models);

    await expect(runtime.getAuth('test-provider')).resolves.toMatchObject({
      auth: { apiKey: 'provider-secret' },
      source: TEST_API_KEY_ENV,
    });
  });

  it('builds reviewed configured models into an ordinary OpenAI-compatible provider', async () => {
    process.env[TEST_API_KEY_ENV] = 'router-secret';
    const runtime = new PiProviderRuntime(createModels(), {
      providerRegistry: {
        schemaVersion: 1,
        providers: [{
          id: 'shared-router',
          type: 'generic_openai',
          enabled: true,
          label: 'Shared router',
          apiBaseUrl: 'https://router.example.test/v1',
          apiKeyRef: { kind: 'env', envName: TEST_API_KEY_ENV },
        }],
      },
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'tool-reliable-exacto',
            rank: 1,
            apiKind: 'openai-responses',
            identity: {
              provider: 'shared-router',
              model: 'exacto/test-model',
              source: { type: 'configured' },
            },
            purposes: [{ purpose: 'chat', primary: true }],
            capabilities: {
              maxOutputTokens: 8192,
              contextWindow: 128_000,
              supportsReasoning: true,
            },
            cost: { inputPer1MUsd: 1, outputPer1MUsd: 2 },
          },
          {
            id: 'fast-nitro',
            rank: 2,
            apiKind: 'openai-completions',
            identity: {
              provider: 'shared-router',
              model: 'nitro/test-model',
              source: { type: 'configured' },
            },
            purposes: [{ purpose: 'chat', primary: false }],
            capabilities: {
              maxOutputTokens: 4096,
              contextWindow: 64_000,
              supportsReasoning: true,
            },
            tuning: { thinkingEnabled: false },
          },
        ],
      },
    });

    expect(runtime.getModels('shared-router')).toEqual([
      expect.objectContaining({
        id: 'exacto/test-model',
        provider: 'shared-router',
        api: 'openai-responses',
        baseUrl: 'https://router.example.test/v1',
        reasoning: true,
        cost: expect.objectContaining({ input: 1, output: 2 }),
      }),
      expect.objectContaining({
        id: 'nitro/test-model',
        provider: 'shared-router',
        api: 'openai-completions',
        reasoning: false,
      }),
    ]);
    await expect(runtime.getAuth('shared-router')).resolves.toMatchObject({
      auth: { apiKey: 'router-secret' },
      source: TEST_API_KEY_ENV,
    });
  });

  it('returns undefined for an unknown provider', async () => {
    const runtime = new PiProviderRuntime(createModels());

    await expect(runtime.getAuth('missing-provider')).resolves.toBeUndefined();
  });
});
