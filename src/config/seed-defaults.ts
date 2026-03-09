import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MODELS_SEED_FILE_NAME = 'models.seed.json';
export const SETTINGS_SEED_FILE_NAME = 'settings.seed.json';

type EmbeddingProviderSeedValue = 'ollama' | 'transformers' | 'api';
type TextEmotionDtypeSeedValue =
  | 'auto'
  | 'fp32'
  | 'fp16'
  | 'q8'
  | 'int8'
  | 'uint8'
  | 'q4'
  | 'bnb4'
  | 'q4f16';

interface SeedModelDefaults {
  provider: string;
  model: string;
  maxOutputTokens: number;
  contextWindow: number;
}

export interface ModelSeedDefaults {
  primary: SeedModelDefaults;
  extraction: SeedModelDefaults;
}

export interface RuntimeSettingsSeedDefaults {
  deepgramModel: string;
  deepgramSttEndpoint: string;
  deepgramListenEndpoint: string;
  elevenLabsModelId: string;
  elevenLabsEndpointBase: string;
  openRouterModelsApiUrl: string;
  embeddingProvider: EmbeddingProviderSeedValue;
  embeddingModel: string;
  embeddingDims: number;
  embeddingOllamaUrl: string;
  transformersModel: string;
  textEmotionModel: string;
  textEmotionCacheDir?: string;
  textEmotionDtype: TextEmotionDtypeSeedValue;
  embeddingApiModel: string;
  embeddingApiDims: number;
}

interface SeedDefaultsCacheEntry {
  models: ModelSeedDefaults;
  runtime: RuntimeSettingsSeedDefaults;
}

const seedDefaultsCache = new Map<string, SeedDefaultsCacheEntry>();

function readJsonFile(path: string): unknown {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw);
}

function asRecord(value: unknown, fieldPath: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldPath} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, fieldPath: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldPath} must be an array`);
  }
  return value;
}

function asNonEmptyString(value: unknown, fieldPath: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldPath} must be a non-empty string`);
  }
  return value.trim();
}

function asPositiveInteger(value: unknown, fieldPath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`${fieldPath} must be a positive integer`);
  }
  return value;
}

function asOptionalString(value: unknown, fieldPath: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${fieldPath} must be a string`);
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function asEmbeddingProvider(value: unknown, fieldPath: string): EmbeddingProviderSeedValue {
  const provider = asNonEmptyString(value, fieldPath).toLowerCase();
  if (provider === 'ollama' || provider === 'transformers' || provider === 'api') {
    return provider;
  }
  throw new Error(`${fieldPath} must be one of: ollama, transformers, api`);
}

function asTextEmotionDtype(value: unknown, fieldPath: string): TextEmotionDtypeSeedValue {
  const dtype = asNonEmptyString(value, fieldPath).toLowerCase();
  if (
    dtype === 'auto'
    || dtype === 'fp32'
    || dtype === 'fp16'
    || dtype === 'q8'
    || dtype === 'int8'
    || dtype === 'uint8'
    || dtype === 'q4'
    || dtype === 'bnb4'
    || dtype === 'q4f16'
  ) {
    return dtype;
  }
  throw new Error(
    `${fieldPath} must be one of: auto, fp32, fp16, q8, int8, uint8, q4, bnb4, q4f16`,
  );
}

function parseModelDefaults(seedDir: string): ModelSeedDefaults {
  const modelsSeedPath = join(seedDir, MODELS_SEED_FILE_NAME);
  const root = asRecord(readJsonFile(modelsSeedPath), modelsSeedPath);
  const models = asArray(root.models, `${modelsSeedPath}.models`);

  const parseSlot = (slotId: 'primary' | 'extraction'): SeedModelDefaults => {
    const rawEntry = models.find((entry) => {
      const record = asRecord(entry, `${modelsSeedPath}.models[*]`);
      return record.id === slotId;
    });
    if (!rawEntry) {
      throw new Error(`${modelsSeedPath}.models must include "${slotId}"`);
    }

    const entry = asRecord(rawEntry, `${modelsSeedPath}.models["${slotId}"]`);
    const identity = asRecord(entry.identity, `${modelsSeedPath}.models["${slotId}"].identity`);
    const capabilities = asRecord(entry.capabilities, `${modelsSeedPath}.models["${slotId}"].capabilities`);

    return {
      provider: asNonEmptyString(identity.provider, `${modelsSeedPath}.models["${slotId}"].identity.provider`),
      model: asNonEmptyString(identity.model, `${modelsSeedPath}.models["${slotId}"].identity.model`),
      maxOutputTokens: asPositiveInteger(
        capabilities.maxOutputTokens,
        `${modelsSeedPath}.models["${slotId}"].capabilities.maxOutputTokens`,
      ),
      contextWindow: asPositiveInteger(
        capabilities.contextWindow,
        `${modelsSeedPath}.models["${slotId}"].capabilities.contextWindow`,
      ),
    };
  };

  return {
    primary: parseSlot('primary'),
    extraction: parseSlot('extraction'),
  };
}

function parseRuntimeSettingsDefaults(seedDir: string): RuntimeSettingsSeedDefaults {
  const settingsSeedPath = join(seedDir, SETTINGS_SEED_FILE_NAME);
  const root = asRecord(readJsonFile(settingsSeedPath), settingsSeedPath);

  return {
    deepgramModel: asNonEmptyString(root.deepgramModel, `${settingsSeedPath}.deepgramModel`),
    deepgramSttEndpoint: asNonEmptyString(root.deepgramSttEndpoint, `${settingsSeedPath}.deepgramSttEndpoint`),
    deepgramListenEndpoint: asNonEmptyString(root.deepgramListenEndpoint, `${settingsSeedPath}.deepgramListenEndpoint`),
    elevenLabsModelId: asNonEmptyString(root.elevenLabsModelId, `${settingsSeedPath}.elevenLabsModelId`),
    elevenLabsEndpointBase: asNonEmptyString(root.elevenLabsEndpointBase, `${settingsSeedPath}.elevenLabsEndpointBase`),
    openRouterModelsApiUrl: asNonEmptyString(root.openRouterModelsApiUrl, `${settingsSeedPath}.openRouterModelsApiUrl`),
    embeddingProvider: asEmbeddingProvider(root.embeddingProvider, `${settingsSeedPath}.embeddingProvider`),
    embeddingModel: asNonEmptyString(root.embeddingModel, `${settingsSeedPath}.embeddingModel`),
    embeddingDims: asPositiveInteger(root.embeddingDims, `${settingsSeedPath}.embeddingDims`),
    embeddingOllamaUrl: asNonEmptyString(root.embeddingOllamaUrl, `${settingsSeedPath}.embeddingOllamaUrl`),
    transformersModel: asNonEmptyString(root.transformersModel, `${settingsSeedPath}.transformersModel`),
    textEmotionModel: asNonEmptyString(root.textEmotionModel, `${settingsSeedPath}.textEmotionModel`),
    textEmotionCacheDir: asOptionalString(root.textEmotionCacheDir, `${settingsSeedPath}.textEmotionCacheDir`),
    textEmotionDtype: asTextEmotionDtype(root.textEmotionDtype, `${settingsSeedPath}.textEmotionDtype`),
    embeddingApiModel: asNonEmptyString(root.embeddingApiModel, `${settingsSeedPath}.embeddingApiModel`),
    embeddingApiDims: asPositiveInteger(root.embeddingApiDims, `${settingsSeedPath}.embeddingApiDims`),
  };
}

function resolveSeedDir(seedDir?: string): string {
  const resolved = (seedDir ?? process.env.CONFIG_DIR ?? './config').trim();
  if (!resolved) {
    throw new Error('Config seed directory is required');
  }
  return resolved;
}

function loadSeedDefaults(seedDir?: string): SeedDefaultsCacheEntry {
  const resolvedSeedDir = resolveSeedDir(seedDir);
  const cached = seedDefaultsCache.get(resolvedSeedDir);
  if (cached) {
    return cached;
  }

  const loaded = {
    models: parseModelDefaults(resolvedSeedDir),
    runtime: parseRuntimeSettingsDefaults(resolvedSeedDir),
  } satisfies SeedDefaultsCacheEntry;
  seedDefaultsCache.set(resolvedSeedDir, loaded);
  return loaded;
}

export function loadModelSeedDefaults(seedDir?: string): ModelSeedDefaults {
  return loadSeedDefaults(seedDir).models;
}

export function loadRuntimeSettingsSeedDefaults(seedDir?: string): RuntimeSettingsSeedDefaults {
  return loadSeedDefaults(seedDir).runtime;
}
