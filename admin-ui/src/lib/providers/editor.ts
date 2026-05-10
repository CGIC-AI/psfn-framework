import type {
  CanonicalProviderRegistry,
  CanonicalProviderType,
  ProviderRegistryEntry,
} from '$lib/types';
import {
  createEmptyProviderEntry,
  PROVIDER_TYPE_LABELS,
  PROVIDER_TYPES,
  providerEnvNameIsValid,
  providerIdIsValid,
  providerIsEnabled,
  providerSupportsModelsApi,
} from './registry';

export type ProviderEditableField = 'id' | 'label' | 'apiBaseUrl' | 'modelsApiUrl' | 'apiKeyRef';

function cloneProviderEntry(entry: ProviderRegistryEntry): ProviderRegistryEntry {
  return {
    ...entry,
    ...(entry.metadata ? { metadata: { ...entry.metadata } } : {}),
  };
}

export function cloneProviderRegistry(registry: CanonicalProviderRegistry): CanonicalProviderRegistry {
  return {
    schemaVersion: 1,
    providers: registry.providers.map((entry) => cloneProviderEntry(entry)),
  };
}

export function serializeProviderRegistry(registry: CanonicalProviderRegistry): string {
  return JSON.stringify(registry, null, 2);
}

export function providerRegistryIsDirty(
  registry: CanonicalProviderRegistry,
  initialJson: string,
): boolean {
  return serializeProviderRegistry(registry) !== initialJson;
}

export function providerTypeSummary(type: CanonicalProviderType): string {
  if (type === 'openrouter') return 'Model discovery + routed OpenRouter traffic';
  if (type === 'litellm_proxy') return 'Proxy-backed provider routing';
  if (type === 'generic_openai') return 'OpenAI-compatible backend';
  return `${PROVIDER_TYPE_LABELS[type]} direct backend`;
}

export function providerRuntimeRole(entry: ProviderRegistryEntry): string[] {
  const roles: string[] = [];
  if (entry.type === 'openrouter') {
    roles.push('import routing');
    roles.push('catalog discovery');
  }
  if (entry.type === 'litellm_proxy') {
    roles.push('proxy routing');
  }
  if (!providerIsEnabled(entry)) {
    roles.push('disabled');
  }
  return roles.length > 0 ? roles : ['direct backend'];
}

export function updateProviderEntry(
  registry: CanonicalProviderRegistry,
  index: number,
  updater: (entry: ProviderRegistryEntry) => ProviderRegistryEntry,
): CanonicalProviderRegistry {
  return {
    ...registry,
    providers: registry.providers.map((entry, entryIndex) => (
      entryIndex === index ? updater(cloneProviderEntry(entry)) : entry
    )),
  };
}

export function appendProviderEntry(registry: CanonicalProviderRegistry): CanonicalProviderRegistry {
  return {
    ...registry,
    providers: [...registry.providers, createEmptyProviderEntry(registry.providers.length)],
  };
}

export function removeProviderEntry(
  registry: CanonicalProviderRegistry,
  index: number,
): CanonicalProviderRegistry {
  return {
    ...registry,
    providers: registry.providers.filter((_, entryIndex) => entryIndex !== index),
  };
}

export function setProviderType(
  registry: CanonicalProviderRegistry,
  index: number,
  value: string,
): CanonicalProviderRegistry {
  return updateProviderEntry(registry, index, (entry) => {
    const nextType = (PROVIDER_TYPES.includes(value as CanonicalProviderType)
      ? value
      : 'openai') as CanonicalProviderType;
    const nextEntry: ProviderRegistryEntry = {
      ...entry,
      type: nextType,
    };
    if (!providerSupportsModelsApi(nextType)) {
      delete nextEntry.modelsApiUrl;
    }
    return nextEntry;
  });
}

export function setProviderField(
  registry: CanonicalProviderRegistry,
  index: number,
  field: ProviderEditableField,
  value: string,
): CanonicalProviderRegistry {
  return updateProviderEntry(registry, index, (entry) => {
    const trimmed = value.trim();
    if (field === 'id') {
      return {
        ...entry,
        id: trimmed.toLowerCase(),
      };
    }
    if (field === 'apiKeyRef') {
      if (trimmed.length === 0) {
        const nextEntry = { ...entry };
        delete nextEntry.apiKeyRef;
        return nextEntry;
      }
      return {
        ...entry,
        apiKeyRef: {
          kind: 'env',
          envName: trimmed,
        },
      };
    }
    if (trimmed.length === 0) {
      const nextEntry = { ...entry };
      delete nextEntry[field];
      return nextEntry;
    }
    return {
      ...entry,
      [field]: trimmed,
    };
  });
}

export function validateProviderRegistry(registry: CanonicalProviderRegistry): string[] {
  const errors: string[] = [];
  const seenIds = new Set<string>();
  let enabledOpenRouterCount = 0;
  let enabledLiteLLMCount = 0;

  for (const [index, entry] of registry.providers.entries()) {
    const label = entry.id || `provider #${index + 1}`;
    if (!providerIdIsValid(entry.id)) {
      errors.push(`${label}: id must use only letters, numbers, dot, underscore, or hyphen.`);
    }
    if (seenIds.has(entry.id)) {
      errors.push(`${label}: duplicate provider id.`);
    }
    seenIds.add(entry.id);
    if (entry.apiKeyRef?.kind === 'env' && !providerEnvNameIsValid(entry.apiKeyRef.envName)) {
      errors.push(`${label}: apiKeyRef.envName must be an uppercase environment variable name.`);
    }
    if (!entry.apiBaseUrl?.trim()) {
      errors.push(`${label}: apiBaseUrl is required for ${entry.type}.`);
    }
    if (entry.type === 'openrouter' && !entry.modelsApiUrl?.trim()) {
      errors.push(`${label}: modelsApiUrl is required for openrouter.`);
    }
    if (providerIsEnabled(entry) && entry.type === 'openrouter') {
      enabledOpenRouterCount += 1;
    }
    if (providerIsEnabled(entry) && entry.type === 'litellm_proxy') {
      enabledLiteLLMCount += 1;
    }
  }

  if (enabledOpenRouterCount > 1) {
    errors.push('Only one enabled OpenRouter provider is supported.');
  }
  if (enabledLiteLLMCount > 1) {
    errors.push('Only one enabled LiteLLM proxy provider is supported.');
  }

  return errors;
}
