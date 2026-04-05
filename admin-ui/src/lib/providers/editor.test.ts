import { describe, expect, it } from 'vitest';
import type { CanonicalProviderRegistry } from '$lib/types';
import {
  appendProviderEntry,
  cloneProviderRegistry,
  providerRegistryIsDirty,
  providerRuntimeRole,
  providerTypeSummary,
  removeProviderEntry,
  serializeProviderRegistry,
  setProviderField,
  setProviderType,
  updateProviderEntry,
  validateProviderRegistry,
} from './editor';

describe('provider editor helpers', () => {
  it('clones registry state for local editing and dirty checks', () => {
    const registry: CanonicalProviderRegistry = {
      schemaVersion: 1,
      providers: [
        {
          id: 'openrouter',
          type: 'openrouter',
          enabled: true,
          apiBaseUrl: 'https://openrouter.ai/api/v1',
          modelsApiUrl: 'https://openrouter.ai/api/v1/models',
          metadata: { note: 'keep' },
        },
      ],
    };

    const cloned = cloneProviderRegistry(registry);
    expect(cloned).toEqual(registry);
    expect(cloned).not.toBe(registry);
    expect(cloned.providers[0]).not.toBe(registry.providers[0]);
    expect(cloned.providers[0]?.metadata).not.toBe(registry.providers[0]?.metadata);
    expect(providerRegistryIsDirty(cloned, serializeProviderRegistry(registry))).toBe(false);
  });

  it('updates provider entries through shared mutations', () => {
    let registry: CanonicalProviderRegistry = {
      schemaVersion: 1,
      providers: [
        {
          id: 'proxy',
          type: 'openai',
          enabled: true,
          apiBaseUrl: 'https://example.com/v1',
        },
      ],
    };

    registry = appendProviderEntry(registry);
    expect(registry.providers).toHaveLength(2);

    registry = setProviderField(registry, 0, 'id', 'OpenRouter');
    registry = setProviderField(registry, 0, 'apiKeyRef', 'OPENROUTER_API_KEY');
    registry = setProviderType(registry, 0, 'openrouter');
    registry = setProviderField(registry, 0, 'modelsApiUrl', 'https://openrouter.ai/api/v1/models');
    registry = updateProviderEntry(registry, 1, (entry) => ({ ...entry, enabled: false }));

    expect(registry.providers[0]).toEqual(
      expect.objectContaining({
        id: 'openrouter',
        type: 'openrouter',
        apiKeyRef: { kind: 'env', envName: 'OPENROUTER_API_KEY' },
      }),
    );
    expect(registry.providers[1]?.enabled).toBe(false);

    registry = removeProviderEntry(registry, 1);
    expect(registry.providers).toHaveLength(1);
  });

  it('validates shared provider registry constraints in one place', () => {
    const errors = validateProviderRegistry({
      schemaVersion: 1,
      providers: [
        {
          id: 'bad id',
          type: 'openrouter',
          enabled: true,
          apiBaseUrl: 'https://openrouter.ai/api/v1',
        },
        {
          id: 'openrouter',
          type: 'openrouter',
          enabled: true,
          apiBaseUrl: 'https://openrouter.ai/api/v1',
          modelsApiUrl: 'https://openrouter.ai/api/v1/models',
          apiKeyRef: { kind: 'env', envName: 'openrouter_api_key' },
        },
      ],
    });

    expect(errors).toEqual([
      'bad id: id must use only letters, numbers, dot, underscore, or hyphen.',
      'bad id: modelsApiUrl is required for openrouter.',
      'openrouter: apiKeyRef.envName must be an uppercase environment variable name.',
      'Only one enabled OpenRouter provider is supported.',
    ]);
  });

  it('exposes stable provider summaries and runtime roles', () => {
    expect(providerTypeSummary('generic_openai')).toBe('OpenAI-compatible backend');
    expect(providerRuntimeRole({
      id: 'proxy',
      type: 'litellm_proxy',
      enabled: false,
    })).toEqual(['proxy routing', 'disabled']);
  });
});
