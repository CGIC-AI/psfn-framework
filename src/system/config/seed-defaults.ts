import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ShardToolsetConfig, WyomingShardRoutingConfig } from './runtime-config-contracts.js';
import { assertPositiveInteger } from './validators.js';

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
  sessionMirrorEnabled: boolean;
  sessionMirrorMaxChars: number;
  sessionMirrorActiveWindowMs: number;
  sessionMirrorChannelOverrides: Record<string, boolean>;
  continuityMessageLimit: number;
  analysisWorkbenchMaxTokens: number;
  analysisWorkbenchMaxWallTimeMs: number;
  analysisWorkbenchMaxSubQueries: number;
  voiceEnabled: boolean;
  voiceTargetGuildId: string;
  voiceTargetUserId: string;
  voiceReadyCueText: string;
  wyomingShardRouting: WyomingShardRoutingConfig;
  shardToolsets: ShardToolsetConfig;
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
  return assertPositiveInteger(value, fieldPath, {
    min: 1,
    message: ({ fieldLabel }) => `${fieldLabel} must be a positive integer`,
  });
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

function asString(value: unknown, fieldPath: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldPath} must be a string`);
  }
  return value.trim();
}

function asEmbeddingProvider(value: unknown, fieldPath: string): EmbeddingProviderSeedValue {
  const provider = asNonEmptyString(value, fieldPath).toLowerCase();
  if (provider === 'ollama' || provider === 'transformers' || provider === 'api') {
    return provider;
  }
  throw new Error(`${fieldPath} must be one of: ollama, transformers, api`);
}

function asBoolean(value: unknown, fieldPath: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldPath} must be a boolean`);
  }
  return value;
}

function asBooleanMap(value: unknown, fieldPath: string): Record<string, boolean> {
  const root = asRecord(value, fieldPath);
  const parsed: Record<string, boolean> = {};
  for (const [rawKey, rawValue] of Object.entries(root)) {
    const key = rawKey.trim();
    if (!key) {
      continue;
    }
    if (typeof rawValue !== 'boolean') {
      throw new Error(`${fieldPath}.${rawKey} must be a boolean`);
    }
    parsed[key] = rawValue;
  }
  return parsed;
}

function asWyomingShardRoutingConfig(value: unknown, fieldPath: string): WyomingShardRoutingConfig {
  const root = asRecord(value, fieldPath);
  const enabled = root.enabled === undefined ? false : asBoolean(root.enabled, `${fieldPath}.enabled`);

  const parseAllowlist = (name: 'siteAllowlist' | 'satelliteAllowlist'): string[] | undefined => {
    const raw = root[name];
    if (raw === undefined) {
      return undefined;
    }
    const entries = asArray(raw, `${fieldPath}.${name}`);
    const parsed = entries.map((entry, index) => asString(entry, `${fieldPath}.${name}[${index}]`)).filter(Boolean);
    return parsed.length > 0 ? parsed : [];
  };

  const siteAllowlist = parseAllowlist('siteAllowlist');
  const satelliteAllowlist = parseAllowlist('satelliteAllowlist');

  return {
    enabled,
    ...(siteAllowlist ? { siteAllowlist } : {}),
    ...(satelliteAllowlist ? { satelliteAllowlist } : {}),
  };
}

function asShardToolsetConfig(value: unknown, fieldPath: string): ShardToolsetConfig {
  const root = asRecord(value, fieldPath);
  const parsed: ShardToolsetConfig = {};
  for (const tier of ['nursery', 'apprentice', 'autonomous', 'custom'] as const) {
    const raw = root[tier];
    if (raw === undefined) continue;
    const entries = asArray(raw, `${fieldPath}.${tier}`);
    const toolNames = entries.map((entry, index) => asString(entry, `${fieldPath}.${tier}[${index}]`)).filter(Boolean);
    if (toolNames.length > 0) {
      parsed[tier] = toolNames;
    } else {
      parsed[tier] = [];
    }
  }
  return parsed;
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
    sessionMirrorEnabled: asBoolean(root.sessionMirrorEnabled, `${settingsSeedPath}.sessionMirrorEnabled`),
    sessionMirrorMaxChars: asPositiveInteger(root.sessionMirrorMaxChars, `${settingsSeedPath}.sessionMirrorMaxChars`),
    sessionMirrorActiveWindowMs: asPositiveInteger(
      root.sessionMirrorActiveWindowMs,
      `${settingsSeedPath}.sessionMirrorActiveWindowMs`,
    ),
    sessionMirrorChannelOverrides: asBooleanMap(
      root.sessionMirrorChannelOverrides,
      `${settingsSeedPath}.sessionMirrorChannelOverrides`,
    ),
    continuityMessageLimit: asPositiveInteger(
      root.continuityMessageLimit,
      `${settingsSeedPath}.continuityMessageLimit`,
    ),
    analysisWorkbenchMaxTokens: asPositiveInteger(root.analysisWorkbenchMaxTokens, `${settingsSeedPath}.analysisWorkbenchMaxTokens`),
    analysisWorkbenchMaxWallTimeMs: asPositiveInteger(root.analysisWorkbenchMaxWallTimeMs, `${settingsSeedPath}.analysisWorkbenchMaxWallTimeMs`),
    analysisWorkbenchMaxSubQueries: asPositiveInteger(root.analysisWorkbenchMaxSubQueries, `${settingsSeedPath}.analysisWorkbenchMaxSubQueries`),
    voiceEnabled: asBoolean(root.voiceEnabled, `${settingsSeedPath}.voiceEnabled`),
    voiceTargetGuildId: asString(root.voiceTargetGuildId, `${settingsSeedPath}.voiceTargetGuildId`),
    voiceTargetUserId: asString(root.voiceTargetUserId, `${settingsSeedPath}.voiceTargetUserId`),
    voiceReadyCueText: asString(root.voiceReadyCueText, `${settingsSeedPath}.voiceReadyCueText`),
    wyomingShardRouting: asWyomingShardRoutingConfig(
      root.wyomingShardRouting,
      `${settingsSeedPath}.wyomingShardRouting`,
    ),
    shardToolsets: asShardToolsetConfig(root.shardToolsets, `${settingsSeedPath}.shardToolsets`),
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
