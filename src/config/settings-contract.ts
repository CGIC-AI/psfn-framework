import { CAPABILITY_TIER_VALUES } from '../capabilities/tiers.js';
import {
  RUNTIME_SETTINGS_KEYS,
  SETTINGS_FILE_NAME,
  SETTINGS_VALIDATION,
} from '../settings.js';
import { CAPABILITY_TIER_FILE_NAME } from './capability-tier-config.js';
import { MODELS_FILE_NAME } from './models-config.js';
import { SCHEDULER_FILE_NAME } from './scheduler-config.js';
import { SKILLS_FILE_NAME } from './skills-config.js';
import { TRUST_POLICY_FILE_NAME } from './trust-policy-config.js';

export const IMPORT_PROCESSING_ROUTE_MODE_VALUES = [
  'background',
  'openrouter_zdr',
  'local_endpoint',
] as const;

export const SESSION_RESTART_BEHAVIOR_VALUES = [
  'reuse_latest_session',
  'new_session',
] as const;

export type SettingsSubsystemId =
  | 'runtime'
  | 'models'
  | 'scheduler'
  | 'capabilities'
  | 'skills'
  | 'trustPolicy';

export type SettingsFieldType =
  | 'string'
  | 'boolean'
  | 'integer'
  | 'number'
  | 'string_array'
  | 'enum'
  | 'object';

export interface SettingsContractSubsystem {
  id: SettingsSubsystemId;
  ownerFile: string;
  mode: 'structured' | 'raw_only';
}

export interface SettingsContractField {
  key: string;
  ownerSubsystem: SettingsSubsystemId;
  ownerFile: string;
  type: SettingsFieldType;
  minimum?: number;
  maximum?: number;
  enumValues?: string[];
  deprecated?: boolean;
}

export interface SettingsContractData {
  schemaVersion: 1;
  subsystems: Record<SettingsSubsystemId, SettingsContractSubsystem>;
  fields: Record<string, SettingsContractField>;
}

export const SETTINGS_SUBSYSTEMS: Record<SettingsSubsystemId, SettingsContractSubsystem> = {
  runtime: {
    id: 'runtime',
    ownerFile: SETTINGS_FILE_NAME,
    mode: 'structured',
  },
  models: {
    id: 'models',
    ownerFile: MODELS_FILE_NAME,
    mode: 'structured',
  },
  scheduler: {
    id: 'scheduler',
    ownerFile: SCHEDULER_FILE_NAME,
    mode: 'structured',
  },
  capabilities: {
    id: 'capabilities',
    ownerFile: CAPABILITY_TIER_FILE_NAME,
    mode: 'structured',
  },
  skills: {
    id: 'skills',
    ownerFile: SKILLS_FILE_NAME,
    mode: 'raw_only',
  },
  trustPolicy: {
    id: 'trustPolicy',
    ownerFile: TRUST_POLICY_FILE_NAME,
    mode: 'raw_only',
  },
};

export const SETTINGS_OWNER_FILE_BY_FIELD = new Map<string, string>([
  // Canonical model settings are owned by models.json (registry-backed).
  ['primaryModel', MODELS_FILE_NAME],
  ['primaryProvider', MODELS_FILE_NAME],
  ['primaryMaxTokens', MODELS_FILE_NAME],
  ['extractionModel', MODELS_FILE_NAME],
  ['extractionProvider', MODELS_FILE_NAME],
  ['extractionMaxTokens', MODELS_FILE_NAME],
  ['modelCatalog', MODELS_FILE_NAME],
  ['modelRoleAssignments', MODELS_FILE_NAME],
  ['modelRoster', MODELS_FILE_NAME],
  ['maintenanceIntervalMs', SCHEDULER_FILE_NAME],
  ['capabilityTier', CAPABILITY_TIER_FILE_NAME],
  ['customTokens', CAPABILITY_TIER_FILE_NAME],
]);

const SETTINGS_OWNER_SUBSYSTEM_BY_FIELD = new Map<string, SettingsSubsystemId>([
  ['primaryModel', 'models'],
  ['primaryProvider', 'models'],
  ['primaryMaxTokens', 'models'],
  ['extractionModel', 'models'],
  ['extractionProvider', 'models'],
  ['extractionMaxTokens', 'models'],
  ['modelCatalog', 'models'],
  ['modelRoleAssignments', 'models'],
  ['modelRoster', 'models'],
  ['maintenanceIntervalMs', 'scheduler'],
  ['capabilityTier', 'capabilities'],
  ['customTokens', 'capabilities'],
]);

export const SETTINGS_BOOLEAN_FIELDS = new Set<string>([
  'adaptiveContextBudgetsEnabled',
  'importProcessingStrictPolicy',
  'webFetchAllowHttp',
  'webFetchAllowInternalNetwork',
  'webFetchLocalCrawlerEnabled',
  'webFetchLocalCrawlerAllowHttp',
  'telegramEnabled',
  'obsidianAutoPublish',
  'moaEnabled',
  'memoryExtractionTelemetryEnabled',
  'memoryRetrievalTelemetryEnabled',
  'profileSynthesisEnabled',
]);

export const SETTINGS_STRING_ARRAY_FIELDS = new Set<string>([
  'openRouterProviderOrder',
  'webFetchDomainAllowlist',
  'webFetchLocalCrawlerHostAllowlist',
  'webFetchLocalCrawlerDomainAllowlist',
  'webFetchTlsCaCertPaths',
  'promotedExtendedTools',
  'moaReferenceModels',
  'customTokens',
]);

const SETTINGS_INTEGER_FIELDS = new Set<string>([
  'primaryMaxTokens',
  'extractionMaxTokens',
  'sessionHistoryBudgetPct',
  'memoryRetrievalBudgetPct',
  'extractionInterval',
  'maintenanceIntervalMs',
  'extractionThresholdPct',
  'compactionThresholdPct',
  'observationMaskingWindow',
  'compactionEmotionalSalienceThresholdPct',
  'memoryExtractionMaxWrites',
  'profileSynthesisRefreshIntervalMs',
  'profileSynthesisCooldownMs',
  'profileSynthesisMinWrites',
  'profileSynthesisSourceMemoryLimit',
  'profileSynthesisMinSourceMemories',
  'thinkMaxTokens',
  'thinkMaxWallTimeMs',
  'thinkMaxSubQueries',
  'retryMaxAttempts',
  'retryBaseDelayMs',
  'embeddingDims',
  'embeddingApiDims',
  'discordTriggerListenWindowMs',
  'obsidianTimeoutMs',
  'moaMaxRounds',
  'moaMaxTokensPerRound',
  'moaTimeoutMs',
]);

const SETTINGS_NUMBER_FIELDS = new Set<string>([
  'memoryExtractionMinImportance',
  'memoryExtractionMinConfidence',
  'memoryExtractionMinNovelty',
  'moodCongruenceWeight',
  'memoryExtractionEmotionalIntensityWeight',
  'profileSynthesisMinImportance',
  'profileSynthesisMinConfidence',
  'profileSynthesisMinNovelty',
]);

const SETTINGS_OBJECT_FIELDS = new Set<string>([
  'compositionalPolicy',
  'modelCatalog',
  'modelRoleAssignments',
  'modelRoster',
]);

const DEPRECATED_SETTINGS_FIELDS = new Set<string>([
  // Canonical model registry is models.json-backed; these are compatibility projections.
  'primaryModel',
  'primaryProvider',
  'primaryMaxTokens',
  'extractionModel',
  'extractionProvider',
  'extractionMaxTokens',
  'modelRoleAssignments',
  'modelRoster',
  'webFetchLocalCrawlerEnabled',
  'webFetchLocalCrawlerAllowHttp',
  'webFetchLocalCrawlerHostAllowlist',
  'webFetchLocalCrawlerDomainAllowlist',
]);

const STRUCTURED_SETTINGS_FIELD_KEYS = [...new Set<string>([
  ...RUNTIME_SETTINGS_KEYS,
  ...SETTINGS_OWNER_FILE_BY_FIELD.keys(),
])].sort();

const BASE_ENUM_VALUES_BY_FIELD = new Map<string, readonly string[]>([
  ['importProcessingRouteMode', IMPORT_PROCESSING_ROUTE_MODE_VALUES],
  ['sessionRestartBehavior', SESSION_RESTART_BEHAVIOR_VALUES],
  ['capabilityTier', CAPABILITY_TIER_VALUES],
  ['embeddingProvider', ['ollama', 'transformers', 'api']],
  ['textEmotionDtype', ['auto', 'fp32', 'fp16', 'q8', 'int8', 'uint8', 'q4', 'bnb4', 'q4f16']],
]);

const EXTRA_NUMERIC_RANGES = new Map<string, { min?: number; max?: number }>([
  ['maintenanceIntervalMs', { min: 1_000 }],
  ['moodCongruenceWeight', { min: 0, max: 1 }],
  ['memoryExtractionEmotionalIntensityWeight', { min: 0, max: 1 }],
]);

function resolveFieldType(field: string): SettingsFieldType {
  if (SETTINGS_BOOLEAN_FIELDS.has(field)) return 'boolean';
  if (SETTINGS_STRING_ARRAY_FIELDS.has(field)) return 'string_array';
  if (SETTINGS_OBJECT_FIELDS.has(field)) return 'object';
  if (SETTINGS_INTEGER_FIELDS.has(field)) return 'integer';
  if (SETTINGS_NUMBER_FIELDS.has(field)) return 'number';
  if (BASE_ENUM_VALUES_BY_FIELD.has(field) || field === 'sttProvider' || field === 'ttsProvider') return 'enum';
  return 'string';
}

function resolveFieldRange(field: string): { min?: number; max?: number } | undefined {
  const validationRange = (SETTINGS_VALIDATION as Partial<Record<string, { min: number; max: number }>>)[field];
  if (validationRange) {
    return {
      min: validationRange.min,
      max: validationRange.max,
    };
  }
  return EXTRA_NUMERIC_RANGES.get(field);
}

function resolveEnumValues(
  field: string,
  options: {
    sttProviderIds?: readonly string[];
    ttsProviderIds?: readonly string[];
  },
): string[] | undefined {
  if (field === 'sttProvider') {
    return ['disabled', ...new Set(options.sttProviderIds ?? [])].sort();
  }
  if (field === 'ttsProvider') {
    return ['disabled', ...new Set(options.ttsProviderIds ?? [])].sort();
  }
  const values = BASE_ENUM_VALUES_BY_FIELD.get(field);
  return values ? [...values] : undefined;
}

export function buildSettingsContractData(options: {
  sttProviderIds?: readonly string[];
  ttsProviderIds?: readonly string[];
} = {}): SettingsContractData {
  const fields: Record<string, SettingsContractField> = {};

  for (const key of STRUCTURED_SETTINGS_FIELD_KEYS) {
    const ownerSubsystem = SETTINGS_OWNER_SUBSYSTEM_BY_FIELD.get(key) ?? 'runtime';
    const ownerFile = SETTINGS_OWNER_FILE_BY_FIELD.get(key) ?? SETTINGS_FILE_NAME;
    const field: SettingsContractField = {
      key,
      ownerSubsystem,
      ownerFile,
      type: resolveFieldType(key),
    };
    const range = resolveFieldRange(key);
    if (range?.min !== undefined) field.minimum = range.min;
    if (range?.max !== undefined) field.maximum = range.max;
    const enumValues = resolveEnumValues(key, options);
    if (enumValues) field.enumValues = enumValues;
    if (DEPRECATED_SETTINGS_FIELDS.has(key)) field.deprecated = true;
    fields[key] = field;
  }

  return {
    schemaVersion: 1,
    subsystems: SETTINGS_SUBSYSTEMS,
    fields,
  };
}
