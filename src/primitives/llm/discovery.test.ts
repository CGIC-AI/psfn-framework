import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GatewayModelDiscovery, ModelDiscovery } from './discovery.js';

// Mock global fetch
const mockFetch = vi.fn();
const OPENROUTER_MODELS_API_URL = 'https://openrouter.ai/api/v1/models';

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

  it('fetches and merges models from LiteLLM + OpenRouter', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('openrouter.ai')) {
        return Promise.resolve(openRouterResponse([
          {
            id: 'z-ai/glm-5',
            name: 'GLM-5',
            description: 'A great model',
            context_length: 128000,
            top_provider: { max_completion_tokens: 16384 },
            pricing: { prompt: '0.001', completion: '0.002' },
          },
        ]));
      }
      if (url.includes('localhost')) {
        return Promise.resolve(litellmResponse([
          { id: 'z-ai/glm-5', litellm_provider: 'openrouter' },
          { id: 'deepseek/deepseek-v3.2' },
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
    // Second model has no OpenRouter metadata
    expect(models[1].id).toBe('deepseek/deepseek-v3.2');
    expect(models[1].description).toBeUndefined();
  });

  it('matches OpenRouter metadata when LiteLLM ids include wrapper prefixes', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('openrouter.ai')) {
        return Promise.resolve(openRouterResponse([
          {
            id: 'z-ai/glm-5',
            canonical_slug: 'z-ai/glm-5',
            description: 'GLM-5 via OpenRouter',
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
    expect(models[0].id).toBe('openrouter/z-ai/glm-5');
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
              modality: 'text+image+file+audio+video->text',
              input_modalities: ['text', 'image', 'video'],
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

  it('prefers top_provider context length and preserves pricing keys', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('openrouter.ai')) {
        return Promise.resolve(openRouterResponse([
          {
            id: 'meta/provider',
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

    // fetch called twice on first call (LiteLLM + OpenRouter), not again
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('invalidateCache forces re-fetch', async () => {
    mockFetch.mockResolvedValue(litellmResponse([{ id: 'test' }]));

    const discovery = createDiscovery('http://localhost:4000');
    await discovery.getAvailableModels();
    discovery.invalidateCache();
    await discovery.getAvailableModels();

    // 2 calls each time (LiteLLM + OpenRouter)
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('fails closed when LiteLLM fetch fails', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('openrouter.ai')) {
        return Promise.resolve(openRouterResponse([]));
      }
      return Promise.reject(new Error('connection refused'));
    });

    const discovery = createDiscovery('http://localhost:4000');
    await expect(discovery.getAvailableModels()).rejects.toThrow('connection refused');
  });

  it('handles OpenRouter fetch failure gracefully', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/v1/models')) {
        return Promise.resolve(litellmResponse([{ id: 'model-1' }]));
      }
      return Promise.reject(new Error('network error'));
    });

    const discovery = createDiscovery('http://localhost:4000');
    const models = await discovery.getAvailableModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('model-1');
    expect(models[0].description).toBeUndefined();
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
      return Promise.reject(new Error(`unexpected URL ${url}`));
    });

    const discovery = createDiscovery('http://localhost:4000', undefined, {
      openRouterModelsApiUrl: configuredOpenRouterUrl,
    });
    await discovery.getAvailableModels();

    expect(mockFetch).toHaveBeenCalledWith(configuredOpenRouterUrl);
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
    expect(injectedFetch).toHaveBeenCalledTimes(2);
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
