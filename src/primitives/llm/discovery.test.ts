import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GatewayModelDiscovery, ModelDiscovery } from './discovery.js';

// Mock global fetch
const mockFetch = vi.fn();
const OPENROUTER_MODELS_API_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_ZDR_ENDPOINTS_API_URL = 'https://openrouter.ai/api/v1/endpoints/zdr';

describe('ModelDiscovery', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createDiscovery(
    litellmBaseUrl: string,
    litellmApiKey?: string,
    options: Partial<ConstructorParameters<typeof ModelDiscovery>[2]> = {},
  ): ModelDiscovery {
    return new ModelDiscovery(litellmBaseUrl, litellmApiKey, {
      openRouterModelsApiUrl: OPENROUTER_MODELS_API_URL,
      ...options,
    });
  }

  function litellmResponse(models: Array<{
    id: string;
    litellm_provider?: string;
    owned_by?: string;
    model_info?: { providers?: string[] };
  }>) {
    return {
      ok: true,
      json: async () => ({ data: models }),
    };
  }

  function openRouterResponse(models: Array<{
    id: string;
    canonical_slug?: string;
    name?: string;
    description?: string;
    context_length?: number;
    modalities?: string[] | null;
    architecture?: {
      modality?: string | null;
      input_modalities?: string[];
      output_modalities?: string[];
    };
    supported_parameters?: string[];
    top_provider?: { context_length?: number; max_completion_tokens?: number };
    pricing?: Record<string, string | undefined>;
  }>) {
    return {
      ok: true,
      json: async () => ({ data: models }),
    };
  }

  function openRouterZdrResponse(endpoints: Array<{
    model_id?: string;
    provider_name?: string;
    tag?: string;
  }>) {
    return {
      ok: true,
      json: async () => ({ data: endpoints }),
    };
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    return { promise, resolve, reject };
  }

  function fetchCallCount(url: string): number {
    return mockFetch.mock.calls.filter(([calledUrl]) => String(calledUrl) === url).length;
  }

  it('uses OpenRouter models as the authoritative discovery list and enriches with LiteLLM hints', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === OPENROUTER_ZDR_ENDPOINTS_API_URL) {
        return Promise.resolve(openRouterZdrResponse([]));
      }
      if (url === OPENROUTER_MODELS_API_URL) {
        return Promise.resolve(openRouterResponse([
          {
            id: 'z-ai/glm-5',
            name: 'GLM-5',
            description: 'A great model',
            architecture: { output_modalities: ['text'] },
            context_length: 128000,
            top_provider: { max_completion_tokens: 16384 },
            pricing: { prompt: '0.001', completion: '0.002' },
          },
          {
            id: 'anthropic/claude-sonnet-4.6',
            name: 'Claude Sonnet 4.6',
            architecture: { output_modalities: ['text'] },
            context_length: 200000,
          },
        ]));
      }
      if (url.includes('localhost')) {
        return Promise.resolve(litellmResponse([
          { id: 'z-ai/glm-5', litellm_provider: 'openrouter' },
          { id: 'proxy-only/model' },
        ]));
      }
      return Promise.reject(new Error('unexpected URL'));
    });

    const discovery = createDiscovery('http://localhost:4000/v1');
    const models = await discovery.getAvailableModels();

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('z-ai/glm-5');
    expect(models[0].description).toBe('A great model');
    expect(models[0].contextLength).toBe(128000);
    expect(models[0].maxCompletionTokens).toBe(16384);
    expect(models[0].providerHints).toContain('openrouter');
    expect(models[0].providerHints).toContain('z-ai');
    expect(models[0].pricing).toEqual({ prompt: '0.001', completion: '0.002' });
    expect(models[1].id).toBe('anthropic/claude-sonnet-4.6');
    expect(models[1].description).toBe('Claude Sonnet 4.6');
    expect(models[1].providerHints).toContain('openrouter');
    expect(models[1].providerHints).toContain('anthropic');
  });

  it('matches OpenRouter metadata when LiteLLM ids include wrapper prefixes', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('openrouter.ai')) {
        return Promise.resolve(openRouterResponse([
          {
            id: 'z-ai/glm-5',
            canonical_slug: 'z-ai/glm-5',
            description: 'GLM-5 via OpenRouter',
            architecture: { output_modalities: ['text'] },
            top_provider: { context_length: 262_144, max_completion_tokens: 32_768 },
            pricing: { prompt: '0.0000008', completion: '0.0000032' },
          },
        ]));
      }
      return Promise.resolve(litellmResponse([
        {
          id: 'openrouter/z-ai/glm-5',
          litellm_provider: 'openrouter',
        },
      ]));
    });

    const discovery = createDiscovery('http://localhost:4000/v1');
    const models = await discovery.getAvailableModels();

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('z-ai/glm-5');
    expect(models[0].description).toBe('GLM-5 via OpenRouter');
    expect(models[0].contextLength).toBe(262_144);
    expect(models[0].maxCompletionTokens).toBe(32_768);
    expect(models[0].pricing).toEqual({ prompt: '0.0000008', completion: '0.0000032' });
    expect(models[0].providerHints).toContain('openrouter');
    expect(models[0].providerHints).toContain('z-ai');
  });

  it('maps OpenRouter modality/reasoning metadata into discovery capability flags', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('openrouter.ai')) {
        return Promise.resolve(openRouterResponse([
          {
            id: 'google/gemini-3.1-flash-lite-preview',
            architecture: {
              modality: 'text+image->text',
              input_modalities: ['text', 'image'],
              output_modalities: ['text'],
            },
            supported_parameters: ['reasoning', 'max_tokens'],
            top_provider: { context_length: 1_048_576, max_completion_tokens: 65_536 },
            pricing: { prompt: '0.00000025', completion: '0.0000015' },
          },
        ]));
      }
      return Promise.resolve(litellmResponse([
        {
          id: 'openrouter/google/gemini-3.1-flash-lite-preview',
          litellm_provider: 'openrouter',
        },
      ]));
    });

    const discovery = createDiscovery('http://localhost:4000/v1');
    const models = await discovery.getAvailableModels();

    expect(models).toHaveLength(1);
    expect(models[0].supportsVision).toBe(true);
    expect(models[0].supportsReasoning).toBe(true);
  });

  it('filters OpenRouter discovery to the supported text model catalog', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === OPENROUTER_ZDR_ENDPOINTS_API_URL) {
        return Promise.resolve(openRouterZdrResponse([]));
      }
      if (url === OPENROUTER_MODELS_API_URL) {
        return Promise.resolve(openRouterResponse([
          {
            id: 'text-only/model',
            architecture: {
              modality: 'text->text',
              input_modalities: ['text'],
              output_modalities: ['text'],
            },
          },
          {
            id: 'vision-text/model',
            architecture: {
              modality: 'text+image->text',
              input_modalities: ['text', 'image'],
              output_modalities: ['text'],
            },
          },
          {
            id: 'file-text/model',
            architecture: {
              modality: 'text+file->text',
              input_modalities: ['text', 'file'],
              output_modalities: ['text'],
            },
          },
          {
            id: 'image-file-text/model',
            architecture: {
              modality: 'text+image+file->text',
              input_modalities: ['text', 'image', 'file'],
              output_modalities: ['text'],
            },
          },
          {
            id: 'video-text/model',
            architecture: {
              modality: 'text+image+video->text',
              input_modalities: ['text', 'image', 'video'],
              output_modalities: ['text'],
            },
          },
          {
            id: 'text-image-output/model',
            architecture: {
              modality: 'text+image->text+image',
              input_modalities: ['text', 'image'],
              output_modalities: ['text', 'image'],
            },
          },
        ]));
      }
      return Promise.resolve(litellmResponse([]));
    });

    const discovery = createDiscovery('http://localhost:4000/v1');
    const models = await discovery.getAvailableModels();

    expect(models.map(model => model.id)).toEqual([
      'text-only/model',
      'vision-text/model',
      'file-text/model',
    ]);
  });

  it('maps OpenRouter ZDR endpoint metadata onto discovered models', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === OPENROUTER_ZDR_ENDPOINTS_API_URL) {
        return Promise.resolve(openRouterZdrResponse([
          {
            model_id: 'google/gemini-3.1-flash-lite',
            provider_name: 'Google',
            tag: 'google-vertex/us',
          },
          {
            model_id: 'google/gemini-3.1-flash-lite',
            provider_name: 'Google',
            tag: 'google-vertex/eu',
          },
        ]));
      }
      if (url === OPENROUTER_MODELS_API_URL) {
        return Promise.resolve(openRouterResponse([
          {
            id: 'google/gemini-3.1-flash-lite',
            description: 'Gemini Flash Lite',
            architecture: { output_modalities: ['text'] },
          },
        ]));
      }
      return Promise.resolve(litellmResponse([
        {
          id: 'openrouter/google/gemini-3.1-flash-lite',
          litellm_provider: 'openrouter',
        },
      ]));
    });

    const discovery = createDiscovery('http://localhost:4000/v1');
    const models = await discovery.getAvailableModels();

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('google/gemini-3.1-flash-lite');
    expect(models[0].zdrAvailable).toBe(true);
    expect(models[0].zdrEndpointCount).toBe(2);
    expect(models[0].zdrProviderTags).toEqual(['google-vertex/us', 'google-vertex/eu']);
    expect(models[0].zdrProviderNames).toEqual(['Google']);
  });

  it('prefers top_provider context length and preserves pricing keys', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('openrouter.ai')) {
        return Promise.resolve(openRouterResponse([
          {
            id: 'meta/provider',
            architecture: { output_modalities: ['text'] },
            context_length: 64_000,
            top_provider: { context_length: 131_072, max_completion_tokens: 4096 },
            pricing: {
              prompt: '0.0001',
              completion: '0.0002',
              request: '0.001',
            },
          },
        ]));
      }
      return Promise.resolve(litellmResponse([
        {
          id: 'meta/provider',
          model_info: { providers: ['openrouter', 'proxy'] },
        },
      ]));
    });

    const discovery = createDiscovery('http://localhost:4000/v1');
    const models = await discovery.getAvailableModels();
    expect(models).toHaveLength(1);
    expect(models[0].contextLength).toBe(131_072);
    expect(models[0].maxCompletionTokens).toBe(4096);
    expect(models[0].pricing).toEqual({
      prompt: '0.0001',
      completion: '0.0002',
      request: '0.001',
    });
    expect(models[0].providerHints).toEqual(['openrouter', 'proxy', 'meta']);
  });

  it('uses cached results within TTL', async () => {
    mockFetch.mockResolvedValue(litellmResponse([{ id: 'test' }]));

    const discovery = createDiscovery('http://localhost:4000');
    await discovery.getAvailableModels();
    await discovery.getAvailableModels();

    // fetch called three times on first call (LiteLLM + OpenRouter metadata + ZDR), not again
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('invalidateCache forces re-fetch', async () => {
    mockFetch.mockResolvedValue(litellmResponse([{ id: 'test' }]));

    const discovery = createDiscovery('http://localhost:4000');
    await discovery.getAvailableModels();
    discovery.invalidateCache();
    await discovery.getAvailableModels();

    // 3 calls each time (LiteLLM + OpenRouter metadata + ZDR)
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it('coalesces concurrent cache misses across upstream discovery fetches', async () => {
    const litellmModelsUrl = 'http://localhost:4000/v1/models';
    const litellmFetch = deferred<ReturnType<typeof litellmResponse>>();
    const openRouterFetch = deferred<ReturnType<typeof openRouterResponse>>();
    const openRouterZdrFetch = deferred<ReturnType<typeof openRouterZdrResponse>>();
    mockFetch.mockImplementation((url: string) => {
      if (url === litellmModelsUrl) return litellmFetch.promise;
      if (url === OPENROUTER_MODELS_API_URL) return openRouterFetch.promise;
      if (url === OPENROUTER_ZDR_ENDPOINTS_API_URL) return openRouterZdrFetch.promise;
      return Promise.reject(new Error(`unexpected URL ${url}`));
    });

    const discovery = createDiscovery('http://localhost:4000');
    const first = discovery.getAvailableModels();
    const second = discovery.getAvailableModels();
    await Promise.resolve();

    expect(fetchCallCount(litellmModelsUrl)).toBe(1);
    expect(fetchCallCount(OPENROUTER_MODELS_API_URL)).toBe(1);
    expect(fetchCallCount(OPENROUTER_ZDR_ENDPOINTS_API_URL)).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    litellmFetch.resolve(litellmResponse([
      { id: 'coalesced/model', litellm_provider: 'openrouter' },
    ]));
    openRouterFetch.resolve(openRouterResponse([
      { id: 'coalesced/model', architecture: { output_modalities: ['text'] } },
    ]));
    openRouterZdrFetch.resolve(openRouterZdrResponse([]));

    const [firstModels, secondModels] = await Promise.all([first, second]);
    expect(firstModels.map(model => model.id)).toEqual(['coalesced/model']);
    expect(secondModels).toEqual(firstModels);

    await discovery.getAvailableModels();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('clears failed in-flight fetches before future attempts retry', async () => {
    let openRouterAttempts = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url === 'http://localhost:4000/v1/models') {
        return Promise.resolve(litellmResponse([
          { id: 'retry/model', litellm_provider: 'openrouter' },
        ]));
      }
      if (url === OPENROUTER_ZDR_ENDPOINTS_API_URL) {
        return Promise.resolve(openRouterZdrResponse([]));
      }
      if (url === OPENROUTER_MODELS_API_URL) {
        openRouterAttempts += 1;
        if (openRouterAttempts === 1) {
          return Promise.reject(new Error('temporary OpenRouter failure'));
        }
        return Promise.resolve(openRouterResponse([
          { id: 'retry/model', architecture: { output_modalities: ['text'] } },
        ]));
      }
      return Promise.reject(new Error(`unexpected URL ${url}`));
    });

    const discovery = createDiscovery('http://localhost:4000');
    const first = discovery.getAvailableModels();
    const second = discovery.getAvailableModels();

    await expect(Promise.all([first, second])).rejects.toThrow('temporary OpenRouter failure');
    expect(openRouterAttempts).toBe(1);

    const models = await discovery.getAvailableModels();
    expect(models.map(model => model.id)).toEqual(['retry/model']);
    expect(openRouterAttempts).toBe(2);
  });

  it('keeps provider and endpoint coalescing keys isolated', async () => {
    const sharedModelsUrl = 'https://openrouter.ai/api/v1/models';
    const zdrUrl = 'https://openrouter.ai/api/v1/endpoints/zdr';
    let sharedModelsCalls = 0;
    let zdrCalls = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url === sharedModelsUrl) {
        sharedModelsCalls += 1;
        if (sharedModelsCalls === 1) {
          return Promise.resolve(litellmResponse([
            { id: 'litellm-only/model', litellm_provider: 'proxy' },
          ]));
        }
        return Promise.resolve(openRouterResponse([
          { id: 'openrouter-only/model', architecture: { output_modalities: ['text'] } },
        ]));
      }
      if (url === zdrUrl) {
        zdrCalls += 1;
        return Promise.resolve(openRouterZdrResponse([
          {
            model_id: 'openrouter-only/model',
            provider_name: 'OpenRouter',
            tag: 'zdr',
          },
        ]));
      }
      return Promise.reject(new Error(`unexpected URL ${url}`));
    });

    const discovery = createDiscovery('https://openrouter.ai/api', undefined, {
      openRouterModelsApiUrl: sharedModelsUrl,
    });

    const [firstModels, secondModels] = await Promise.all([
      discovery.getAvailableModels(),
      discovery.getAvailableModels(),
    ]);

    expect(sharedModelsCalls).toBe(2);
    expect(zdrCalls).toBe(1);
    expect(firstModels.map(model => model.id)).toEqual(['openrouter-only/model']);
    expect(firstModels[0].zdrAvailable).toBe(true);
    expect(secondModels).toEqual(firstModels);
  });

  it('uses OpenRouter models when LiteLLM enrichment fails', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === OPENROUTER_ZDR_ENDPOINTS_API_URL) {
        return Promise.resolve(openRouterZdrResponse([]));
      }
      if (url === OPENROUTER_MODELS_API_URL) {
        return Promise.resolve(openRouterResponse([
          { id: 'model-1', architecture: { output_modalities: ['text'] } },
        ]));
      }
      return Promise.reject(new Error('connection refused'));
    });

    const discovery = createDiscovery('http://localhost:4000');
    const models = await discovery.getAvailableModels();

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('model-1');
    expect(models[0].providerHints).toEqual(['openrouter', 'model-1']);
  });

  it('fails closed when OpenRouter metadata fetch fails', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === 'http://localhost:4000/v1/models') {
        return Promise.resolve(litellmResponse([{ id: 'model-1' }]));
      }
      if (url === OPENROUTER_ZDR_ENDPOINTS_API_URL) {
        return Promise.resolve(openRouterZdrResponse([]));
      }
      return Promise.reject(new Error('network error'));
    });

    const discovery = createDiscovery('http://localhost:4000');
    await expect(discovery.getAvailableModels()).rejects.toThrow('network error');
  });

  it('sends auth header when API key provided', async () => {
    mockFetch.mockResolvedValue(litellmResponse([]));

    const discovery = createDiscovery('http://localhost:4000', 'test-key');
    await discovery.getAvailableModels();

    const litellmCall = mockFetch.mock.calls.find(
      (c: any[]) => String(c[0]).includes('/v1/models')
    );
    expect(litellmCall).toBeDefined();
    expect(litellmCall![1]?.headers?.Authorization).toBe('Bearer test-key');
  });

  it('strips trailing /v1 from base URL', async () => {
    mockFetch.mockResolvedValue(litellmResponse([]));

    const discovery = createDiscovery('http://localhost:4000/v1');
    await discovery.getAvailableModels();

    const litellmCall = mockFetch.mock.calls.find(
      (c: any[]) => String(c[0]).includes('localhost')
    );
    expect(String(litellmCall![0])).toBe('http://localhost:4000/v1/models');
    // Ensure no double /v1/v1
    expect(String(litellmCall![0])).not.toContain('/v1/v1');
  });

  it('fetches OpenRouter metadata from the configured URL', async () => {
    const configuredOpenRouterUrl = 'https://metadata.example.test/custom/models';
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/v1/models')) {
        return Promise.resolve(litellmResponse([{ id: 'model-1' }]));
      }
      if (url === configuredOpenRouterUrl) {
        return Promise.resolve(openRouterResponse([]));
      }
      if (url === 'https://metadata.example.test/api/v1/endpoints/zdr') {
        return Promise.resolve(openRouterZdrResponse([]));
      }
      return Promise.reject(new Error(`unexpected URL ${url}`));
    });

    const discovery = createDiscovery('http://localhost:4000', undefined, {
      openRouterModelsApiUrl: configuredOpenRouterUrl,
    });
    await discovery.getAvailableModels();

    expect(mockFetch).toHaveBeenCalledWith(configuredOpenRouterUrl);
    expect(mockFetch).toHaveBeenCalledWith('https://metadata.example.test/api/v1/endpoints/zdr');
  });

  it('fails closed when openRouterModelsApiUrl is missing', () => {
    expect(() => new ModelDiscovery('http://localhost:4000', undefined, {
      openRouterModelsApiUrl: '   ',
    })).toThrow('Model discovery requires openRouterModelsApiUrl');
  });

  it('fails closed when direct network is disabled and no gateway fetch is injected', async () => {
    mockFetch.mockResolvedValue(litellmResponse([{ id: 'test' }]));

    const discovery = createDiscovery('http://localhost:4000', undefined, {
      allowDirectNetworkEgress: false,
    });
    await expect(discovery.getAvailableModels()).rejects.toThrow(
      'Direct network egress is disabled; model discovery requires gateway-backed fetch wiring.',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uses injected fetch when direct network is disabled', async () => {
    const injectedFetch = vi.fn(async (url: string | URL) => {
      const target = String(url);
      if (target.includes('/v1/models')) {
        return litellmResponse([{ id: 'model-1', litellm_provider: 'openrouter' }]);
      }
      if (target.includes('/endpoints/zdr')) {
        return openRouterZdrResponse([]);
      }
      if (target.includes('openrouter.ai')) {
        return openRouterResponse([{
          id: 'model-1',
          canonical_slug: 'openrouter/model-1',
          description: 'ok',
        }]);
      }
      throw new Error('unexpected URL');
    });

    const discovery = createDiscovery('http://localhost:4000', undefined, {
      allowDirectNetworkEgress: false,
      fetchFn: injectedFetch as unknown as typeof fetch,
    });
    const models = await discovery.getAvailableModels();

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('model-1');
    expect(injectedFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('awaits gateway invalidation before the next discovery fetch', async () => {
    let invalidateReleased = false;
    let releaseInvalidate: (() => void) | null = null;
    const transport = {
      getAvailableModels: vi.fn(async () => [{ id: invalidateReleased ? 'fresh' : 'stale' }]),
      invalidateModelDiscoveryCache: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          releaseInvalidate = () => {
            invalidateReleased = true;
            resolve();
          };
        });
      }),
    };

    const discovery = new GatewayModelDiscovery(transport);
    discovery.invalidateCache();
    const pendingModels = discovery.getAvailableModels();

    expect(transport.getAvailableModels).not.toHaveBeenCalled();
    releaseInvalidate?.();

    await expect(pendingModels).resolves.toEqual([{ id: 'fresh' }]);
    expect(transport.invalidateModelDiscoveryCache).toHaveBeenCalledTimes(1);
    expect(transport.getAvailableModels).toHaveBeenCalledTimes(1);
  });
});
