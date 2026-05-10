import { describe, expect, it } from 'vitest';
import {
  createEmptyProviderEntry,
  normalizeProviderRegistry,
  normalizeProvidersRuntimeConfig,
  parseProviderRegistryJson,
  providerEnvNameIsValid,
  providerIdIsValid,
  providerIsEnabled,
  providerSupportsModelsApi,
} from './registry';

describe('provider registry helpers', () => {
  it('normalizes providers runtime config from admin settings payloads', () => {
    const normalized = normalizeProvidersRuntimeConfig({
      registry: {
        schemaVersion: 1,
        providers: [
          {
            id: 'OpenRouter',
            type: 'openrouter',
            enabled: true,
            apiBaseUrl: 'https://openrouter.ai/api/v1',
            modelsApiUrl: 'https://openrouter.ai/api/v1/models',
          },
        ],
      },
    });

    expect(normalized.registry.providers).toEqual([
      expect.objectContaining({
        id: 'openrouter',
        type: 'openrouter',
        enabled: true,
      }),
    ]);
  });

  it('deduplicates conflicting provider ids', () => {
    const normalized = normalizeProviderRegistry({
      schemaVersion: 1,
      providers: [
        { id: 'proxy', type: 'openai', enabled: true },
        { id: 'proxy', type: 'mistral', enabled: true },
      ],
    });

    expect(normalized.providers.map((entry) => entry.id)).toEqual(['proxy', 'proxy-2']);
  });

  it('treats current provider owner files without legacy enabled flags as active', () => {
    const normalized = parseProviderRegistryJson(JSON.stringify({
      schemaVersion: 1,
      providers: [
        {
          id: 'OpenRouter',
          type: 'openrouter',
          apiBaseUrl: 'https://openrouter.ai/api/v1',
          modelsApiUrl: 'https://openrouter.ai/api/v1/models',
        },
      ],
    }));

    expect(normalized.providers).toHaveLength(1);
    expect(normalized.providers[0]).toEqual(expect.objectContaining({
      id: 'openrouter',
      type: 'openrouter',
      enabled: true,
    }));
    expect(providerIsEnabled(normalized.providers[0]!)).toBe(true);
    expect(providerIsEnabled({ enabled: false })).toBe(false);
  });

  it('creates a stable empty provider template', () => {
    expect(createEmptyProviderEntry(2)).toEqual({
      id: 'provider-3',
      type: 'openai',
      enabled: true,
    });
  });

  it('exposes provider-specific validation helpers', () => {
    expect(providerSupportsModelsApi('openrouter')).toBe(true);
    expect(providerSupportsModelsApi('openai')).toBe(false);
    expect(providerIdIsValid('openrouter-prod')).toBe(true);
    expect(providerIdIsValid('bad id')).toBe(false);
    expect(providerEnvNameIsValid('OPENROUTER_API_KEY')).toBe(true);
    expect(providerEnvNameIsValid('openrouter_api_key')).toBe(false);
  });
});
