import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ModelDiscovery } from './discovery.js';

// Mock global fetch
const mockFetch = vi.fn();

describe('ModelDiscovery', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function litellmResponse(models: Array<{ id: string }>) {
    return {
      ok: true,
      json: async () => ({ data: models }),
    };
  }

  function openRouterResponse(models: Array<{
    id: string;
    name?: string;
    description?: string;
    context_length?: number;
    top_provider?: { max_completion_tokens?: number };
    pricing?: { prompt?: string; completion?: string };
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
          { id: 'z-ai/glm-5' },
          { id: 'deepseek/deepseek-v3.2' },
        ]));
      }
      return Promise.reject(new Error('unexpected URL'));
    });

    const discovery = new ModelDiscovery('http://localhost:4000/v1');
    const models = await discovery.getAvailableModels();

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('z-ai/glm-5');
    expect(models[0].description).toBe('A great model');
    expect(models[0].contextLength).toBe(128000);
    expect(models[0].maxCompletionTokens).toBe(16384);
    expect(models[0].pricing).toEqual({ prompt: '0.001', completion: '0.002' });
    // Second model has no OpenRouter metadata
    expect(models[1].id).toBe('deepseek/deepseek-v3.2');
    expect(models[1].description).toBeUndefined();
  });

  it('uses cached results within TTL', async () => {
    mockFetch.mockResolvedValue(litellmResponse([{ id: 'test' }]));

    const discovery = new ModelDiscovery('http://localhost:4000');
    await discovery.getAvailableModels();
    await discovery.getAvailableModels();

    // fetch called twice on first call (LiteLLM + OpenRouter), not again
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('invalidateCache forces re-fetch', async () => {
    mockFetch.mockResolvedValue(litellmResponse([{ id: 'test' }]));

    const discovery = new ModelDiscovery('http://localhost:4000');
    await discovery.getAvailableModels();
    discovery.invalidateCache();
    await discovery.getAvailableModels();

    // 2 calls each time (LiteLLM + OpenRouter)
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('handles LiteLLM fetch failure gracefully', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('openrouter.ai')) {
        return Promise.resolve(openRouterResponse([]));
      }
      return Promise.reject(new Error('connection refused'));
    });

    const discovery = new ModelDiscovery('http://localhost:4000');
    const models = await discovery.getAvailableModels();
    expect(models).toEqual([]);
  });

  it('handles OpenRouter fetch failure gracefully', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/v1/models')) {
        return Promise.resolve(litellmResponse([{ id: 'model-1' }]));
      }
      return Promise.reject(new Error('network error'));
    });

    const discovery = new ModelDiscovery('http://localhost:4000');
    const models = await discovery.getAvailableModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('model-1');
    expect(models[0].description).toBeUndefined();
  });

  it('sends auth header when API key provided', async () => {
    mockFetch.mockResolvedValue(litellmResponse([]));

    const discovery = new ModelDiscovery('http://localhost:4000', 'test-key');
    await discovery.getAvailableModels();

    const litellmCall = mockFetch.mock.calls.find(
      (c: any[]) => String(c[0]).includes('/v1/models')
    );
    expect(litellmCall).toBeDefined();
    expect(litellmCall![1]?.headers?.Authorization).toBe('Bearer test-key');
  });

  it('strips trailing /v1 from base URL', async () => {
    mockFetch.mockResolvedValue(litellmResponse([]));

    const discovery = new ModelDiscovery('http://localhost:4000/v1');
    await discovery.getAvailableModels();

    const litellmCall = mockFetch.mock.calls.find(
      (c: any[]) => String(c[0]).includes('localhost')
    );
    expect(String(litellmCall![0])).toBe('http://localhost:4000/v1/models');
    // Ensure no double /v1/v1
    expect(String(litellmCall![0])).not.toContain('/v1/v1');
  });
});
