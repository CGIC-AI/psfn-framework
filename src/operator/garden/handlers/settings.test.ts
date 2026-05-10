import { describe, expect, it, vi } from 'vitest';
import type { DiscoveredModel } from '../../../primitives/llm/discovery.js';
import { AdminSettingsHandlers } from './settings.js';

function createHandler(modelDiscovery?: {
  getAvailableModels: () => Promise<DiscoveredModel[]>;
  invalidateCache: () => void;
}) {
  const legacy = {
    modelDiscovery: modelDiscovery ?? null,
  } as any;
  return new AdminSettingsHandlers(legacy);
}

describe('AdminSettingsHandlers model discovery endpoints', () => {
  it('returns discovered model metadata via modelListJson', async () => {
    const modelDiscovery = {
      getAvailableModels: vi.fn(async () => [
        {
          id: 'z-ai/glm-5',
          providerHints: ['openrouter', 'z-ai'],
          contextLength: 128_000,
          maxCompletionTokens: 16_384,
          pricing: { prompt: '0.000001', completion: '0.000004' },
        },
      ]),
      invalidateCache: vi.fn(),
    };
    const handler = createHandler(modelDiscovery);

    const result = await handler.modelListJson();
    expect(modelDiscovery.getAvailableModels).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result)).toEqual([
      {
        id: 'z-ai/glm-5',
        providerHints: ['openrouter', 'z-ai'],
        contextLength: 128_000,
        maxCompletionTokens: 16_384,
        pricing: { prompt: '0.000001', completion: '0.000004' },
      },
    ]);
  });

  it('fails closed when discovery backend is unavailable', async () => {
    const handler = createHandler(undefined);
    await expect(handler.modelListJson()).rejects.toThrow('Model discovery backend unavailable');
    await expect(handler.refreshModels()).rejects.toThrow('Model discovery backend unavailable');
  });

  it('invalidates discovery cache before refresh fetch', async () => {
    const modelDiscovery = {
      getAvailableModels: vi.fn(async () => [{ id: 'openai/gpt-4.1-mini' }]),
      invalidateCache: vi.fn(),
    };
    const handler = createHandler(modelDiscovery);

    const refreshed = await handler.refreshModels();
    expect(modelDiscovery.invalidateCache).toHaveBeenCalledTimes(1);
    expect(modelDiscovery.getAvailableModels).toHaveBeenCalledTimes(1);
    expect(modelDiscovery.invalidateCache.mock.invocationCallOrder[0]).toBeLessThan(
      modelDiscovery.getAvailableModels.mock.invocationCallOrder[0],
    );
    expect(JSON.parse(refreshed)).toEqual([{ id: 'openai/gpt-4.1-mini' }]);
  });
});
