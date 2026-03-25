import type {
  CanonicalProviderRegistry,
  CanonicalProviderType,
  ProviderRegistryEntry,
  ProvidersRuntimeConfig,
} from '$lib/types';

export const PROVIDER_TYPES = [
  'litellm_proxy',
  'openrouter',
  'openai',
  'anthropic',
  'google',
  'mistral',
  'generic_openai',
] as const satisfies readonly CanonicalProviderType[];

export const PROVIDER_TYPE_LABELS: Record<CanonicalProviderType, string> = {
  litellm_proxy: 'LiteLLM Proxy',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  mistral: 'Mistral',
  generic_openai: 'Generic OpenAI',
};

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeProviderType(value: unknown): CanonicalProviderType {
  const normalized = toOptionalString(value)?.toLowerCase();
  if (!normalized || !PROVIDER_TYPES.includes(normalized as CanonicalProviderType)) {
    return 'openai';
  }
  return normalized as CanonicalProviderType;
}

function normalizeProviderEntry(value: unknown, index: number): ProviderRegistryEntry {
  const raw = isRecord(value) ? value : {};
  const fallbackId = `provider-${index + 1}`;
  const id = toOptionalString(raw.id)?.toLowerCase() ?? fallbackId;
  const normalizedId = PROVIDER_ID_PATTERN.test(id) ? id : fallbackId;
  const type = normalizeProviderType(raw.type);
  return {
    id: normalizedId,
    type,
    enabled: raw.enabled !== false,
    ...(toOptionalString(raw.label) ? { label: toOptionalString(raw.label) } : {}),
    ...(toOptionalString(raw.apiBaseUrl) ? { apiBaseUrl: toOptionalString(raw.apiBaseUrl) } : {}),
    ...(toOptionalString(raw.modelsApiUrl) ? { modelsApiUrl: toOptionalString(raw.modelsApiUrl) } : {}),
    ...(toOptionalString(raw.apiKeyEnv) ? { apiKeyEnv: toOptionalString(raw.apiKeyEnv) } : {}),
    ...(isRecord(raw.metadata) ? { metadata: { ...raw.metadata } } : {}),
  };
}

export function normalizeProviderRegistry(value: unknown): CanonicalProviderRegistry {
  const raw = isRecord(value) ? value : {};
  const providersRaw = Array.isArray(raw.providers) ? raw.providers : [];
  const seenIds = new Set<string>();
  const providers: ProviderRegistryEntry[] = [];

  for (const [index, entry] of providersRaw.entries()) {
    const normalized = normalizeProviderEntry(entry, index);
    let candidateId = normalized.id;
    let suffix = 2;
    while (seenIds.has(candidateId)) {
      candidateId = `${normalized.id}-${suffix}`;
      suffix += 1;
    }
    seenIds.add(candidateId);
    providers.push(candidateId === normalized.id ? normalized : { ...normalized, id: candidateId });
  }

  return {
    schemaVersion: 1,
    providers,
  };
}

export function normalizeProvidersRuntimeConfig(value: unknown): ProvidersRuntimeConfig {
  const raw = isRecord(value) ? value : {};
  return {
    registry: normalizeProviderRegistry(isRecord(raw.registry) ? raw.registry : raw),
    ...(toOptionalString(raw.litellmBaseUrl) ? { litellmBaseUrl: toOptionalString(raw.litellmBaseUrl) } : {}),
    ...(toOptionalString(raw.litellmApiKeyEnv) ? { litellmApiKeyEnv: toOptionalString(raw.litellmApiKeyEnv) } : {}),
    ...(toOptionalString(raw.openRouterApiBaseUrl) ? { openRouterApiBaseUrl: toOptionalString(raw.openRouterApiBaseUrl) } : {}),
    ...(toOptionalString(raw.openRouterModelsApiUrl) ? { openRouterModelsApiUrl: toOptionalString(raw.openRouterModelsApiUrl) } : {}),
    ...(toOptionalString(raw.openRouterApiKeyEnv) ? { openRouterApiKeyEnv: toOptionalString(raw.openRouterApiKeyEnv) } : {}),
  };
}

export function createEmptyProviderEntry(index: number): ProviderRegistryEntry {
  return {
    id: `provider-${index + 1}`,
    type: 'openai',
    enabled: true,
  };
}

export function providerSupportsModelsApi(type: CanonicalProviderType): boolean {
  return type === 'openrouter';
}

export function providerRequiresApiBaseUrl(type: CanonicalProviderType): boolean {
  return PROVIDER_TYPES.includes(type);
}

export function providerEnvNameIsValid(value: string): boolean {
  return ENV_NAME_PATTERN.test(value.trim());
}

export function providerIdIsValid(value: string): boolean {
  return PROVIDER_ID_PATTERN.test(value.trim());
}
