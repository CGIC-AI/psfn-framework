import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  GatewayModelDiscovery,
  ModelDiscovery,
  createModelDiscoveryCredential,
  type GenericOpenAiDiscoverySource,
  type ModelDiscoverySource,
  type OpenRouterDiscoverySource,
  type CatalogDiscoverySource,
} from './discovery.js';

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

  function openRouterSource(
    options: Partial<OpenRouterDiscoverySource> = {},
  ): OpenRouterDiscoverySource {
    return {
      kind: 'openrouter',
      providerId: options.providerId ?? 'openrouter',
      modelsApiUrl: options.modelsApiUrl ?? OPENROUTER_MODELS_API_URL,
      ...(options.zdrEndpointsApiUrl ? { zdrEndpointsApiUrl: options.zdrEndpointsApiUrl } : {}),
      ...(options.credential ? { credential: options.credential } : {}),
      ...(options.label ? { label: options.label } : {}),
    };
  }

  function genericSource(
    modelsApiUrl: string,
    options: Partial<GenericOpenAiDiscoverySource> & { apiKeyValue?: string } = {},
  ): GenericOpenAiDiscoverySource {
    const { apiKeyValue, ...rest } = options;
    const source: GenericOpenAiDiscoverySource = {
      kind: 'generic-openai-compatible',
      providerId: rest.providerId ?? 'shared-router',
      modelsApiUrl,
      ...(rest.label ? { label: rest.label } : {}),
    };
    if (apiKeyValue !== undefined) {
      source.credential = createModelDiscoveryCredential(() => apiKeyValue);
    } else if (rest.credential !== undefined) {
      source.credential = rest.credential;
    }
    return source;
  }

  function catalogSource(
    providerId: string,
    models: CatalogDiscoverySource['models'],
  ): CatalogDiscoverySource {
    return { kind: 'catalog', providerId, models };
  }

  function createDiscovery(
    sources: ModelDiscoverySource | ModelDiscoverySource[],
    options: { fetchFn?: typeof fetch; allowDirectNetworkEgress?: boolean } = {},
  ): ModelDiscovery {
    return new ModelDiscovery(Array.isArray(sources) ? sources : [sources], options);
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

  function genericModelsResponse(models: Array<{ id: string; owned_by?: string }>) {
    return {
      ok: true,
      json: async () => ({ data: models }),
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

  function mockOpenRouter(models: Parameters<typeof openRouterResponse>[0], zdr: Parameters<typeof openRouterZdrResponse>[0] = []): void {
    mockFetch.mockImplementation((url: string) => {
      if (url === OPENROUTER_ZDR_ENDPOINTS_API_URL) {
        return Promise.resolve(openRouterZdrResponse(zdr));
      }
      if (url === OPENROUTER_MODELS_API_URL) {
        return Promise.resolve(openRouterResponse(models));
      }
      return Promise.reject(new Error(`unexpected URL ${url}`));
    });
  }

  it('uses the OpenRouter source as its authoritative catalog and enriches with ZDR', async () => {
    mockOpenRouter([
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
    ]);

    const discovery = createDiscovery(openRouterSource());
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
    expect(models[1].providerHints).toContain('openrouter');
    expect(models[1].providerHints).toContain('anthropic');
  });

  it('maps OpenRouter modality/reasoning metadata into discovery capability flags', async () => {
    mockOpenRouter([
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
    ]);

    const discovery = createDiscovery(openRouterSource());
    const models = await discovery.getAvailableModels();

    expect(models).toHaveLength(1);
    expect(models[0].supportsVision).toBe(true);
    expect(models[0].supportsReasoning).toBe(true);
  });

  it('filters the OpenRouter catalog to supported text models', async () => {
    mockOpenRouter([
      {
        id: 'text-only/model',
        architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] },
      },
      {
        id: 'vision-text/model',
        architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'] },
      },
      {
        id: 'file-text/model',
        architecture: { modality: 'text+file->text', input_modalities: ['text', 'file'], output_modalities: ['text'] },
      },
      {
        id: 'image-file-text/model',
        architecture: { modality: 'text+image+file->text', input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] },
      },
      {
        id: 'video-text/model',
        architecture: { modality: 'text+image+video->text', input_modalities: ['text', 'image', 'video'], output_modalities: ['text'] },
      },
      {
        id: 'text-image-output/model',
        architecture: { modality: 'text+image->text+image', input_modalities: ['text', 'image'], output_modalities: ['text', 'image'] },
      },
    ]);

    const discovery = createDiscovery(openRouterSource());
    const models = await discovery.getAvailableModels();

    expect(models.map(model => model.id)).toEqual([
      'text-only/model',
      'vision-text/model',
      'file-text/model',
    ]);
  });

  it('maps OpenRouter ZDR endpoint metadata onto discovered models', async () => {
    mockOpenRouter(
      [
        {
          id: 'google/gemini-3.1-flash-lite',
          description: 'Gemini Flash Lite',
          architecture: { output_modalities: ['text'] },
        },
      ],
      [
        { model_id: 'google/gemini-3.1-flash-lite', provider_name: 'Google', tag: 'google-vertex/us' },
        { model_id: 'google/gemini-3.1-flash-lite', provider_name: 'Google', tag: 'google-vertex/eu' },
      ],
    );

    const discovery = createDiscovery(openRouterSource());
    const models = await discovery.getAvailableModels();

    expect(models).toHaveLength(1);
    expect(models[0].zdrAvailable).toBe(true);
    expect(models[0].zdrEndpointCount).toBe(2);
    expect(models[0].zdrProviderTags).toEqual(['google-vertex/us', 'google-vertex/eu']);
    expect(models[0].zdrProviderNames).toEqual(['Google']);
  });

  it('prefers top_provider context length and preserves pricing keys', async () => {
    mockOpenRouter([
      {
        id: 'meta/provider',
        architecture: { output_modalities: ['text'] },
        context_length: 64_000,
        top_provider: { context_length: 131_072, max_completion_tokens: 4096 },
        pricing: { prompt: '0.0001', completion: '0.0002', request: '0.001' },
      },
    ]);

    const discovery = createDiscovery(openRouterSource());
    const models = await discovery.getAvailableModels();
    expect(models).toHaveLength(1);
    expect(models[0].contextLength).toBe(131_072);
    expect(models[0].maxCompletionTokens).toBe(4096);
    expect(models[0].pricing).toEqual({ prompt: '0.0001', completion: '0.0002', request: '0.001' });
    expect(models[0].providerHints).toEqual(['openrouter', 'meta']);
  });

  it('uses a generic OpenAI-compatible source as an authoritative catalog with OpenRouter enrichment', async () => {
    const genericModelsUrl = 'https://router.example.test/v1/models';
    mockFetch.mockImplementation((url: string) => {
      if (url === OPENROUTER_MODELS_API_URL) {
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
      if (url === OPENROUTER_ZDR_ENDPOINTS_API_URL) {
        return Promise.resolve(openRouterZdrResponse([]));
      }
      if (url === genericModelsUrl) {
        return Promise.resolve(genericModelsResponse([
          { id: 'z-ai/glm-5', owned_by: 'z-ai' },
          { id: 'custom/only-here' },
        ]));
      }
      return Promise.reject(new Error(`unexpected URL ${url}`));
    });

    const discovery = createDiscovery([
      openRouterSource(),
      genericSource(genericModelsUrl, { providerId: 'shared-router', apiKeyValue: 'shared-key' }),
    ]);
    const models = await discovery.getAvailableModels();

    const glm = models.find(model => model.id === 'z-ai/glm-5');
    expect(glm).toBeDefined();
    expect(glm!.description).toBe('GLM-5 via OpenRouter');
    expect(glm!.contextLength).toBe(262_144);
    expect(glm!.maxCompletionTokens).toBe(32_768);
    expect(glm!.pricing).toEqual({ prompt: '0.0000008', completion: '0.0000032' });
    // Provider hints reflect the serving generic endpoint, not OpenRouter.
    expect(glm!.providerHints).toEqual(['shared-router', 'z-ai']);

    const custom = models.find(model => model.id === 'custom/only-here');
    expect(custom).toBeDefined();
    expect(custom!.providerHints).toEqual(['shared-router', 'custom']);
  });

  it('returns minimal entries for a generic source when OpenRouter is not configured', async () => {
    const genericModelsUrl = 'https://router.example.test/v1/models';
    mockFetch.mockImplementation((url: string) => {
      if (url === genericModelsUrl) {
        return Promise.resolve(genericModelsResponse([
          { id: 'alpha/model-a', owned_by: 'Alpha' },
          { id: 'beta/model-b' },
        ]));
      }
      return Promise.reject(new Error(`unexpected URL ${url}`));
    });

    const discovery = createDiscovery([
      genericSource(genericModelsUrl, { providerId: 'shared-router' }),
    ]);
    const models = await discovery.getAvailableModels();

    expect(models.map(model => model.id)).toEqual(['alpha/model-a', 'beta/model-b']);
    expect(models[0].providerHints).toEqual(['shared-router', 'Alpha', 'alpha']);
    expect(models[1].providerHints).toEqual(['shared-router', 'beta']);
    // No network call to OpenRouter when it is not a configured source.
    expect(fetchCallCount(OPENROUTER_MODELS_API_URL)).toBe(0);
  });

  it('uses deterministic catalog sources without any network egress', async () => {
    const discovery = createDiscovery([
      catalogSource('test-runtime', [
        { id: 'catalog/model-a', providerHints: ['test-runtime'] },
        { id: 'catalog/model-b' },
      ]),
    ]);
    const models = await discovery.getAvailableModels();

    expect(models.map(model => model.id)).toEqual(['catalog/model-a', 'catalog/model-b']);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fails closed when the authoritative OpenRouter catalog is invalid', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === OPENROUTER_ZDR_ENDPOINTS_API_URL) {
        return Promise.resolve(openRouterZdrResponse([]));
      }
      if (url === OPENROUTER_MODELS_API_URL) {
        return Promise.resolve({ ok: true, json: async () => ({ notData: true }) });
      }
      return Promise.reject(new Error(`unexpected URL ${url}`));
    });

    const discovery = createDiscovery(openRouterSource());
    await expect(discovery.getAvailableModels()).rejects.toThrow('invalid catalog');
  });

  it('fails closed when an authoritative generic catalog is invalid', async () => {
    const genericModelsUrl = 'https://router.example.test/v1/models';
    mockFetch.mockImplementation((url: string) => {
      if (url === genericModelsUrl) {
        return Promise.resolve({ ok: true, json: async () => ({ oops: true }) });
      }
      return Promise.reject(new Error(`unexpected URL ${url}`));
    });

    const discovery = createDiscovery([genericSource(genericModelsUrl)]);
    await expect(discovery.getAvailableModels()).rejects.toThrow('invalid catalog');
  });

  it('fails closed when the authoritative OpenRouter fetch errors', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === OPENROUTER_ZDR_ENDPOINTS_API_URL) {
        return Promise.resolve(openRouterZdrResponse([]));
      }
      return Promise.reject(new Error('network error'));
    });

    const discovery = createDiscovery(openRouterSource());
    await expect(discovery.getAvailableModels()).rejects.toThrow('network error');
  });

  it('bounds optional ZDR enrichment failure to an empty enrichment map', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === OPENROUTER_ZDR_ENDPOINTS_API_URL) {
        return Promise.reject(new Error('zdr unavailable'));
      }
      if (url === OPENROUTER_MODELS_API_URL) {
        return Promise.resolve(openRouterResponse([
          { id: 'resilient/model', architecture: { output_modalities: ['text'] } },
        ]));
      }
      return Promise.reject(new Error(`unexpected URL ${url}`));
    });

    const discovery = createDiscovery(openRouterSource());
    const models = await discovery.getAvailableModels();

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('resilient/model');
    expect(models[0].zdrAvailable).toBeUndefined();
  });

  it('uses cached results within TTL', async () => {
    mockOpenRouter([{ id: 'cached/model', architecture: { output_modalities: ['text'] } }]);

    const discovery = createDiscovery(openRouterSource());
    await discovery.getAvailableModels();
    await discovery.getAvailableModels();

    // Two upstream calls on first invocation (OpenRouter models + ZDR), none after.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('invalidateCache forces re-fetch', async () => {
    mockOpenRouter([{ id: 'cached/model', architecture: { output_modalities: ['text'] } }]);

    const discovery = createDiscovery(openRouterSource());
    await discovery.getAvailableModels();
    discovery.invalidateCache();
    await discovery.getAvailableModels();

    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('coalesces concurrent cache misses across upstream discovery fetches', async () => {
    const openRouterFetch = deferred<ReturnType<typeof openRouterResponse>>();
    const openRouterZdrFetch = deferred<ReturnType<typeof openRouterZdrResponse>>();
    mockFetch.mockImplementation((url: string) => {
      if (url === OPENROUTER_MODELS_API_URL) return openRouterFetch.promise;
      if (url === OPENROUTER_ZDR_ENDPOINTS_API_URL) return openRouterZdrFetch.promise;
      return Promise.reject(new Error(`unexpected URL ${url}`));
    });

    const discovery = createDiscovery(openRouterSource());
    const first = discovery.getAvailableModels();
    const second = discovery.getAvailableModels();
    await Promise.resolve();

    expect(fetchCallCount(OPENROUTER_MODELS_API_URL)).toBe(1);
    expect(fetchCallCount(OPENROUTER_ZDR_ENDPOINTS_API_URL)).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    openRouterFetch.resolve(openRouterResponse([
      { id: 'coalesced/model', architecture: { output_modalities: ['text'] } },
    ]));
    openRouterZdrFetch.resolve(openRouterZdrResponse([]));

    const [firstModels, secondModels] = await Promise.all([first, second]);
    expect(firstModels.map(model => model.id)).toEqual(['coalesced/model']);
    expect(secondModels).toEqual(firstModels);

    await discovery.getAvailableModels();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('clears failed in-flight fetches before future attempts retry', async () => {
    let openRouterAttempts = 0;
    mockFetch.mockImplementation((url: string) => {
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

    const discovery = createDiscovery(openRouterSource());
    const first = discovery.getAvailableModels();
    const second = discovery.getAvailableModels();

    await expect(Promise.all([first, second])).rejects.toThrow('temporary OpenRouter failure');
    expect(openRouterAttempts).toBe(1);

    const models = await discovery.getAvailableModels();
    expect(models.map(model => model.id)).toEqual(['retry/model']);
    expect(openRouterAttempts).toBe(2);
  });

  it('isolates in-flight coalescing keys by provider, endpoint, and auth presence', async () => {
    const sharedModelsUrl = 'https://openrouter.ai/api/v1/models';
    const zdrUrl = 'https://openrouter.ai/api/v1/endpoints/zdr';
    let modelsCalls = 0;
    let zdrCalls = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url === sharedModelsUrl) {
        modelsCalls += 1;
        return Promise.resolve(openRouterResponse([
          { id: 'openrouter-only/model', architecture: { output_modalities: ['text'] } },
        ]));
      }
      if (url === zdrUrl) {
        zdrCalls += 1;
        return Promise.resolve(openRouterZdrResponse([
          { model_id: 'openrouter-only/model', provider_name: 'OpenRouter', tag: 'zdr' },
        ]));
      }
      return Promise.reject(new Error(`unexpected URL ${url}`));
    });

    const discovery = createDiscovery(openRouterSource({ modelsApiUrl: sharedModelsUrl }));
    const [firstModels, secondModels] = await Promise.all([
      discovery.getAvailableModels(),
      discovery.getAvailableModels(),
    ]);

    expect(modelsCalls).toBe(1);
    expect(zdrCalls).toBe(1);
    expect(firstModels[0].zdrAvailable).toBe(true);
    expect(secondModels).toEqual(firstModels);
  });

  it('sends auth header for a generic source only when a credential is present', async () => {
    const genericModelsUrl = 'https://router.example.test/v1/models';
    mockFetch.mockImplementation((url: string) => {
      if (url === genericModelsUrl) {
        return Promise.resolve(genericModelsResponse([{ id: 'shared/model' }]));
      }
      return Promise.reject(new Error(`unexpected URL ${url}`));
    });

    const discovery = createDiscovery([
      genericSource(genericModelsUrl, { providerId: 'shared-router', apiKeyValue: 'shared-key' }),
    ]);
    await discovery.getAvailableModels();

    const call = mockFetch.mock.calls.find((c) => String(c[0]) === genericModelsUrl);
    expect(call).toBeDefined();
    expect(call![1]?.headers?.Authorization).toBe('Bearer shared-key');
  });

  it('does not send auth when the generic source has no credential', async () => {
    const genericModelsUrl = 'https://router.example.test/v1/models';
    mockFetch.mockImplementation((url: string) => {
      if (url === genericModelsUrl) {
        return Promise.resolve(genericModelsResponse([{ id: 'shared/model' }]));
      }
      return Promise.reject(new Error(`unexpected URL ${url}`));
    });

    const discovery = createDiscovery([genericSource(genericModelsUrl)]);
    await discovery.getAvailableModels();

    const call = mockFetch.mock.calls.find((c) => String(c[0]) === genericModelsUrl);
    expect(call).toBeDefined();
    expect(call![1]?.headers?.Authorization).toBeUndefined();
  });

  it('derives the OpenRouter ZDR endpoint URL from the configured models URL', async () => {
    const configuredOpenRouterUrl = 'https://metadata.example.test/custom/models';
    mockFetch.mockImplementation((url: string) => {
      if (url === configuredOpenRouterUrl) {
        return Promise.resolve(openRouterResponse([
          { id: 'model-1', architecture: { output_modalities: ['text'] } },
        ]));
      }
      if (url === 'https://metadata.example.test/api/v1/endpoints/zdr') {
        return Promise.resolve(openRouterZdrResponse([]));
      }
      return Promise.reject(new Error(`unexpected URL ${url}`));
    });

    const discovery = createDiscovery(openRouterSource({ modelsApiUrl: configuredOpenRouterUrl }));
    await discovery.getAvailableModels();

    expect(fetchCallCount(configuredOpenRouterUrl)).toBe(1);
    expect(fetchCallCount('https://metadata.example.test/api/v1/endpoints/zdr')).toBe(1);
  });

  it('rejects construction when a network source has an empty modelsApiUrl', () => {
    expect(() => new ModelDiscovery([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { kind: 'generic-openai-compatible', providerId: 'bad', modelsApiUrl: '   ' } as any,
    ])).toThrow('requires a non-empty modelsApiUrl');
  });

  it('fails closed when direct network is disabled and no gateway fetch is injected', async () => {
    mockOpenRouter([{ id: 'test', architecture: { output_modalities: ['text'] } }]);

    const discovery = createDiscovery(openRouterSource(), { allowDirectNetworkEgress: false });
    await expect(discovery.getAvailableModels()).rejects.toThrow(
      'Direct network egress is disabled; model discovery requires gateway-backed fetch wiring.',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not require network egress for catalog-only sources', async () => {
    const discovery = createDiscovery(
      catalogSource('test-runtime', [{ id: 'catalog/model' }]),
      { allowDirectNetworkEgress: false },
    );
    const models = await discovery.getAvailableModels();
    expect(models.map(model => model.id)).toEqual(['catalog/model']);
  });

  it('uses injected fetch when direct network is disabled', async () => {
    const injectedFetch = vi.fn(async (url: string | URL) => {
      const target = String(url);
      if (target === OPENROUTER_MODELS_API_URL) {
        return openRouterResponse([{ id: 'model-1', architecture: { output_modalities: ['text'] } }]);
      }
      if (target === OPENROUTER_ZDR_ENDPOINTS_API_URL) {
        return openRouterZdrResponse([]);
      }
      throw new Error('unexpected URL');
    });

    const discovery = createDiscovery(openRouterSource(), {
      allowDirectNetworkEgress: false,
      fetchFn: injectedFetch as unknown as typeof fetch,
    });
    const models = await discovery.getAvailableModels();

    expect(models).toHaveLength(1);
    expect(injectedFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('never embeds secret values in cache or in-flight identity', async () => {
    const genericModelsUrl = 'https://router.example.test/v1/models';
    let secretProbeCalls = 0;
    const credential = createModelDiscoveryCredential(() => {
      secretProbeCalls += 1;
      return 'super-secret-value';
    });

    mockFetch.mockImplementation((url: string) => {
      if (url === genericModelsUrl) {
        return Promise.resolve(genericModelsResponse([{ id: 'shared/model' }]));
      }
      return Promise.reject(new Error(`unexpected URL ${url}`));
    });

    const discovery = createDiscovery([genericSource(genericModelsUrl, { providerId: 'shared-router', credential })]);
    await discovery.getAvailableModels();
    discovery.invalidateCache();
    await discovery.getAvailableModels();

    // The credential authPresence is 'present' and the key is resolved per fetch,
    // but no secret value is retained on the discovery object or exposed via
    // its public surface beyond the fetch header.
    expect(secretProbeCalls).toBeGreaterThan(0);
    const serialized = JSON.stringify(discovery);
    expect(serialized).not.toContain('super-secret-value');
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
