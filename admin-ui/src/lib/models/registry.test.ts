import { describe, expect, it } from 'vitest';
import {
  CANONICAL_PURPOSES,
  parseModelRegistryJson,
} from './registry';

describe('model registry helpers', () => {
  it('normalizes current canonical models.json owner-file payloads for the Garden roster', () => {
    const registry = parseModelRegistryJson(JSON.stringify({
      schemaVersion: 1,
      models: [
        {
          id: 'extraction',
          rank: 20,
          identity: {
            provider: 'openrouter',
            model: 'deepseek/deepseek-v3.2',
            source: { type: 'openrouter' },
          },
          purposes: [
            { purpose: 'background', primary: true },
            { purpose: 'memory', primary: true },
            { purpose: 'extraction', primary: true },
            { purpose: 'import_processing', primary: true },
          ],
          capabilities: { maxOutputTokens: 8192, contextWindow: 128000 },
          tuning: { maxOutputTokens: 8192 },
        },
        {
          id: 'primary',
          rank: 30,
          identity: {
            provider: 'openrouter',
            model: 'z-ai/glm-5',
            source: { type: 'openrouter' },
          },
          purposes: [
            { purpose: 'chat', primary: true },
            { purpose: 'summary', primary: true },
            { purpose: 'reasoning', primary: true },
            { purpose: 'longContext', primary: true },
            { purpose: 'vision', primary: true },
            { purpose: 'moa', primary: true },
          ],
          routing: { providerOrder: ['OpenRouter', 'openrouter', ''] },
          capabilities: { maxOutputTokens: 16384, contextWindow: 128000 },
          tuning: { maxOutputTokens: 16384 },
        },
      ],
    }));

    expect(registry.models.map(model => model.id)).toEqual(['primary', 'extraction']);
    expect(registry.models[0]?.identity).toEqual(expect.objectContaining({
      provider: 'openrouter',
      model: 'z-ai/glm-5',
    }));
    expect(registry.models[0]?.routing?.providerOrder).toEqual(['openrouter']);
    expect(
      registry.models.flatMap(model => model.purposes)
        .filter(tag => tag.primary)
        .map(tag => tag.purpose)
        .sort(),
    ).toEqual([...CANONICAL_PURPOSES].sort());
  });

  it('accepts the backend ModelsRuntimeConfig wrapper as well as raw owner-file JSON', () => {
    const registry = parseModelRegistryJson(JSON.stringify({
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'primary',
            rank: 10,
            identity: {
              provider: 'openrouter',
              model: 'z-ai/glm-5',
              source: { type: 'openrouter' },
            },
            purposes: [
              { purpose: 'chat', primary: true },
            ],
            capabilities: { maxOutputTokens: 16384 },
          },
        ],
      },
    }));

    expect(registry.models).toHaveLength(1);
    expect(registry.models[0]?.id).toBe('primary');
  });
});
