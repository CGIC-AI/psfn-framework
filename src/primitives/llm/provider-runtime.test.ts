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

  it('returns undefined for an unknown provider', async () => {
    const runtime = new PiProviderRuntime(createModels());

    await expect(runtime.getAuth('missing-provider')).resolves.toBeUndefined();
  });
});
