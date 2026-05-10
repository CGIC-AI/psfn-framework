import { join } from 'node:path';
import type { CanonicalProviderRegistry, CanonicalProviderType, ProviderRegistryEntry } from '../../shared/contracts/runtime.js';
import type { CredentialReference } from '../../boundary/custody/credential-vault.js';
import type { SubstrateConfig } from './runtime-config-contracts.js';
import {
  envCredential,
  resolveOptionalCredentialReference,
} from '../../boundary/custody/credential-vault.js';
import { loadRequiredJson } from './load-or-seed.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';

export const PROVIDERS_FILE_NAME = 'providers.json';
export const PROVIDERS_SEED_FILE_NAME = 'providers.seed.json';

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const KNOWN_PROVIDER_TYPES = new Set<CanonicalProviderType>([
  'litellm_proxy',
  'openrouter',
  'openai',
  'anthropic',
  'google',
  'mistral',
  'generic_openai',
]);

export interface ProvidersRuntimeConfig {
  registry: CanonicalProviderRegistry;
  litellmBaseUrl?: string;
  litellmApiKeyRef?: CredentialReference;
  openRouterApiBaseUrl?: string;
  openRouterModelsApiUrl?: string;
  openRouterApiKeyRef?: CredentialReference;
}

interface ProvidersConfigLoadOptions {
  seedDir?: string;
}

export interface ProvidersLoadResult {
  config: ProvidersRuntimeConfig;
}

export interface ConfiguredModelRoutingProxy {
  type: 'litellm_proxy';
  baseUrl: string;
  apiKeyEnv: string;
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeHttpUrl(value: string | undefined, field: string): string | undefined {
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid providers config: ${field} must be a valid http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid providers config: ${field} must use http or https`);
  }
  parsed.hash = '';
  return parsed.toString();
}

function normalizeApiKeyEnv(value: unknown, field: string): string | undefined {
  const normalized = toNonEmptyString(value);
  if (!normalized) return undefined;
  if (!ENV_NAME_PATTERN.test(normalized)) {
    throw new Error(`Invalid providers config: ${field} must be an uppercase env var name`);
  }
  return normalized;
}

function normalizeCredentialReference(
  value: unknown,
  field: string,
): CredentialReference | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Invalid providers config: ${field} must be an object`);
  }
  if (value.kind !== 'env') {
    throw new Error(`Invalid providers config: ${field}.kind must be "env"`);
  }
  const envName = normalizeApiKeyEnv(value.envName, `${field}.envName`);
  if (!envName) {
    throw new Error(`Invalid providers config: ${field}.envName must be an uppercase env var name`);
  }
  return envCredential(envName);
}

function normalizeProviderType(value: unknown, field: string): CanonicalProviderType {
  const normalized = toNonEmptyString(value)?.toLowerCase() as CanonicalProviderType | undefined;
  if (!normalized || !KNOWN_PROVIDER_TYPES.has(normalized)) {
    throw new Error(
      `Invalid providers config: ${field} must be one of ${[...KNOWN_PROVIDER_TYPES].join(', ')}`,
    );
  }
  return normalized;
}

function normalizeProviderEntry(raw: unknown, field: string): ProviderRegistryEntry {
  if (!isRecord(raw)) {
    throw new Error(`Invalid providers config: ${field} must be an object`);
  }

  const id = toNonEmptyString(raw.id)?.toLowerCase();
  if (!id || !PROVIDER_ID_PATTERN.test(id)) {
    throw new Error(`Invalid providers config: ${field}.id must be a non-empty key-safe string`);
  }
  if (typeof raw.enabled !== 'boolean') {
    throw new Error(`Invalid providers config: ${field}.enabled must be a boolean`);
  }

  const type = normalizeProviderType(raw.type, `${field}.type`);
  const label = toNonEmptyString(raw.label);
  const apiBaseUrl = normalizeHttpUrl(toNonEmptyString(raw.apiBaseUrl), `${field}.apiBaseUrl`);
  const modelsApiUrl = normalizeHttpUrl(toNonEmptyString(raw.modelsApiUrl), `${field}.modelsApiUrl`);
  if ('apiKeyEnv' in raw) {
    throw new Error(`Invalid providers config: ${field}.apiKeyEnv is not supported; use ${field}.apiKeyRef`);
  }
  const apiKeyRef = normalizeCredentialReference(raw.apiKeyRef, `${field}.apiKeyRef`);

  if (type === 'litellm_proxy' && !apiBaseUrl) {
    throw new Error(`Invalid providers config: ${field}.apiBaseUrl is required for litellm_proxy`);
  }
  if (type === 'openrouter') {
    if (!apiBaseUrl) {
      throw new Error(`Invalid providers config: ${field}.apiBaseUrl is required for openrouter`);
    }
    if (!modelsApiUrl) {
      throw new Error(`Invalid providers config: ${field}.modelsApiUrl is required for openrouter`);
    }
  }
  if (
    (type === 'openai' || type === 'anthropic' || type === 'google' || type === 'mistral' || type === 'generic_openai')
    && !apiBaseUrl
  ) {
    throw new Error(`Invalid providers config: ${field}.apiBaseUrl is required for ${type}`);
  }

  return {
    id,
    type,
    enabled: raw.enabled,
    ...(label ? { label } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(modelsApiUrl ? { modelsApiUrl } : {}),
    ...(apiKeyRef ? { apiKeyRef } : {}),
    ...(isRecord(raw.metadata) ? { metadata: { ...raw.metadata } } : {}),
  };
}

export function normalizeCanonicalProviderRegistry(
  raw: unknown,
  sourcePath = 'providers',
): CanonicalProviderRegistry {
  if (!isRecord(raw)) {
    throw new Error(`Invalid providers config at ${sourcePath}: expected object`);
  }
  if (raw.schemaVersion !== 1) {
    throw new Error(`Invalid providers config at ${sourcePath}.schemaVersion: expected 1`);
  }
  if (!Array.isArray(raw.providers) || raw.providers.length === 0) {
    throw new Error(`Invalid providers config at ${sourcePath}.providers: expected non-empty array`);
  }

  const seenIds = new Set<string>();
  const enabledTypeCounts = new Map<CanonicalProviderType, number>();
  const providers = raw.providers.map((entry, index) => {
    const normalized = normalizeProviderEntry(entry, `${sourcePath}.providers[${index}]`);
    if (seenIds.has(normalized.id)) {
      throw new Error(`Invalid providers config at ${sourcePath}.providers[${index}].id: duplicate "${normalized.id}"`);
    }
    seenIds.add(normalized.id);
    if (normalized.enabled) {
      enabledTypeCounts.set(normalized.type, (enabledTypeCounts.get(normalized.type) ?? 0) + 1);
    }
    return normalized;
  });

  for (const singletonType of ['litellm_proxy', 'openrouter'] as const) {
    if ((enabledTypeCounts.get(singletonType) ?? 0) > 1) {
      throw new Error(`Invalid providers config at ${sourcePath}: only one enabled ${singletonType} provider is supported`);
    }
  }

  return {
    schemaVersion: 1,
    providers,
  };
}

function projectProvidersRuntimeConfig(registry: CanonicalProviderRegistry): ProvidersRuntimeConfig {
  const litellm = registry.providers.find((entry) => entry.enabled && entry.type === 'litellm_proxy');
  const openrouter = registry.providers.find((entry) => entry.enabled && entry.type === 'openrouter');
  return {
    registry,
    ...(litellm?.apiBaseUrl ? { litellmBaseUrl: litellm.apiBaseUrl } : {}),
    ...(litellm?.apiKeyRef ? { litellmApiKeyRef: litellm.apiKeyRef } : {}),
    ...(openrouter?.apiBaseUrl ? { openRouterApiBaseUrl: openrouter.apiBaseUrl } : {}),
    ...(openrouter?.modelsApiUrl ? { openRouterModelsApiUrl: openrouter.modelsApiUrl } : {}),
    ...(openrouter?.apiKeyRef ? { openRouterApiKeyRef: openrouter.apiKeyRef } : {}),
  };
}

function writeProvidersRegistry(dataDir: string, registry: CanonicalProviderRegistry): void {
  writeJsonAtomic(join(dataDir, PROVIDERS_FILE_NAME), registry);
}

export function loadProvidersConfig(
  dataDir: string,
  options: ProvidersConfigLoadOptions = {},
): ProvidersRuntimeConfig {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  const registry = loadRequiredJson({
    dataPath: join(dataDir, PROVIDERS_FILE_NAME),
    examplePath: join(seedDir, PROVIDERS_SEED_FILE_NAME),
    validate: normalizeCanonicalProviderRegistry,
  });
  return projectProvidersRuntimeConfig(registry);
}

export function loadStartupProvidersConfig(
  dataDir: string,
  options: ProvidersConfigLoadOptions = {},
): ProvidersLoadResult {
  const loaded = loadProvidersConfig(dataDir, options);
  return {
    config: loaded,
  };
}

export function saveProvidersConfig(
  dataDir: string,
  nextConfig: unknown,
): ProvidersRuntimeConfig {
  const registry = normalizeCanonicalProviderRegistry(nextConfig, PROVIDERS_FILE_NAME);
  writeProvidersRegistry(dataDir, registry);
  return projectProvidersRuntimeConfig(registry);
}

export function applyProvidersRuntimeConfig(
  config: SubstrateConfig,
  providers: ProvidersRuntimeConfig,
): void {
  config.providerRegistry = providers.registry;
  config.litellmBaseUrl = providers.litellmBaseUrl;
  config.litellmApiKeyRef = providers.litellmApiKeyRef;
  config.openRouterApiBaseUrl = providers.openRouterApiBaseUrl;
  config.openRouterApiKeyRef = providers.openRouterApiKeyRef;
  if (providers.openRouterModelsApiUrl) {
    config.openRouterModelsApiUrl = providers.openRouterModelsApiUrl;
  }
}

export function resolveConfiguredLiteLLMBaseUrl(config: SubstrateConfig): string | null {
  const configured = toNonEmptyString(config.litellmBaseUrl);
  if (configured) return configured;
  return toNonEmptyString(process.env.LITELLM_BASE_URL) ?? null;
}

export function resolveConfiguredLiteLLMApiKeyReference(
  config: Pick<SubstrateConfig, 'litellmApiKeyRef'>,
): CredentialReference {
  return config.litellmApiKeyRef ?? envCredential('LITELLM_API_KEY');
}

export function resolveConfiguredLiteLLMApiKey(
  config: Pick<SubstrateConfig, 'credentialVault' | 'litellmApiKeyRef'>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveOptionalCredentialReference(
    config.credentialVault,
    resolveConfiguredLiteLLMApiKeyReference(config),
    env,
  );
}

/**
 * Resolve the configured provider-routing proxy without making upper layers
 * depend on LiteLLM as a conceptual default.
 */
export function resolveConfiguredModelRoutingProxy(
  config: SubstrateConfig,
): ConfiguredModelRoutingProxy | null {
  const baseUrl = resolveConfiguredLiteLLMBaseUrl(config);
  if (!baseUrl) return null;
  return {
    type: 'litellm_proxy',
    baseUrl,
    apiKeyEnv: resolveConfiguredLiteLLMApiKeyEnv(config),
  };
}
