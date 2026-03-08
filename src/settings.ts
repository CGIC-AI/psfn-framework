// ── Persistent Editable Settings ──
// Subset of SubstrateConfig that can be changed at runtime via admin GUI.
// Persisted to data/settings.json (runtime-owned domain fields only).
// Loaded at startup from canonical system-data JSON owners.

import { join } from 'node:path';
import {
  CANONICAL_MODEL_PURPOSES,
  type CanonicalModelRegistry,
  type CanonicalModelPurpose,
  type ModelRegistryBudgetPolicy,
  type ModelRegistryEntry,
  DEFAULT_MOOD_CONGRUENCE_WEIGHT,
  PROMOTED_EXTENDED_TOOL_SLOTS_MAX,
  type CapabilityTier,
  type CompositionalPolicyConfig,
  type ImportProcessingRouteMode,
  type ModelCatalogEntry,
  type ModelContextBudgetConfig,
  type ModelRouteConfig,
  type ModelPurpose,
  type ModelRoleAssignments,
  type SessionRestartBehavior,
  type ModelSlot,
  type ModelSlotDefaults,
  type ModelSlotOverrides,
  type SubstrateConfig,
  DEFAULT_UI_THEME_ID,
} from './types.js';
import {
  createDefaultCompositionalPolicyConfig,
  cloneCompositionalPolicyConfig,
  normalizeCompositionalPolicyConfig,
} from './compositional/policy.js';
import { createComponentLogger } from './logger.js';
import {
  MEMORY_RETRIEVAL_BUDGET_PCT_RANGE,
  resolveMemoryRetrievalBudgetPct,
  resolveSessionHistoryBudgetPct,
  SESSION_HISTORY_BUDGET_PCT_RANGE,
} from './context-budget.js';
import { loadOrSeedJson, writeJsonAtomic } from './config/load-or-seed.js';
import { isRecord } from './utils/types.js';
import { isCapabilityTier } from './capabilities/tiers.js';
import {
  normalizeSttProvider,
  normalizeTtsProvider,
  resolveRuntimeSttProvider,
  resolveRuntimeTtsProvider,
  toBoolean,
  toConfiguredSttProvider,
  toConfiguredTtsProvider,
  toImportProcessingRouteMode,
  toIntegerInRange,
  toNonEmptyString,
  toNumberInRange,
  toPositiveInteger,
  toPositiveNumber,
  toSessionRestartBehavior,
  toStrictIntegerInRange,
  toStrictNumberInRange,
  toStringList,
} from './settings/coercion.js';

export { createDefaultCompositionalPolicyConfig } from './compositional/policy.js';

const log = createComponentLogger('Settings');

export const SETTINGS_FILE_NAME = 'settings.json';
const SETTINGS_FILE = SETTINGS_FILE_NAME;
const SETTINGS_SEED_FILE = 'settings.seed.json';
const PRIMARY_MODEL_SLOT_KEY = 'primary';
const EXTRACTION_MODEL_SLOT_KEY = 'extraction';
const KNOWN_MODEL_PURPOSES: ModelPurpose[] = ['chat', 'background', 'context', 'reasoning', 'longContext', 'vision'];
export const MOOD_CONGRUENCE_WEIGHT_RANGE = {
  min: 0,
  max: 1,
} as const;

export const MODEL_SLOT_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

const MODEL_SETTINGS_KEYS: ReadonlyArray<keyof EditableSettings> = [
  'modelRegistry',
];

const LEGACY_MODEL_SETTINGS_KEYS: ReadonlyArray<keyof EditableSettings> = [
  'primaryModel',
  'primaryProvider',
  'primaryMaxTokens',
  'extractionModel',
  'extractionProvider',
  'extractionMaxTokens',
  'modelCatalog',
  'modelRoleAssignments',
  'modelRoster',
];

const NON_RUNTIME_SETTINGS_KEYS: ReadonlyArray<keyof EditableSettings> = [
  ...MODEL_SETTINGS_KEYS,
  ...LEGACY_MODEL_SETTINGS_KEYS,
  'maintenanceIntervalMs',
  'capabilityTier',
];

export interface SettingsDomainSplit {
  runtime: EditableSettings;
  models: EditableSettings;
  maintenanceIntervalMs?: number;
  capabilityTier?: CapabilityTier;
  legacyKeys: string[];
}

export const DEFAULT_MODEL_ROLE_ASSIGNMENTS: Readonly<ModelRoleAssignments> = {
  chat: PRIMARY_MODEL_SLOT_KEY,
  background: EXTRACTION_MODEL_SLOT_KEY,
  context: EXTRACTION_MODEL_SLOT_KEY,
  extraction: EXTRACTION_MODEL_SLOT_KEY,
  summary: PRIMARY_MODEL_SLOT_KEY,
  reasoning: PRIMARY_MODEL_SLOT_KEY,
  longContext: PRIMARY_MODEL_SLOT_KEY,
  vision: PRIMARY_MODEL_SLOT_KEY,
  import_processing: EXTRACTION_MODEL_SLOT_KEY,
};

export interface EditableSettings {
  modelRegistry?: CanonicalModelRegistry;
  primaryModel?: string;
  primaryProvider?: string;
  extractionModel?: string;
  extractionProvider?: string;
  primaryMaxTokens?: number;
  extractionMaxTokens?: number;
  modelCatalog?: Record<string, ModelCatalogEntry>;
  modelRoleAssignments?: ModelRoleAssignments;
  modelRoster?: Partial<Record<ModelPurpose, ModelSlot>>;
  sessionHistoryBudgetPct?: number;
  memoryRetrievalBudgetPct?: number;
  moodCongruenceWeight?: number;
  adaptiveContextBudgetsEnabled?: boolean;
  sessionMessageLimit?: number;
  sessionRestartBehavior?: SessionRestartBehavior;
  memoryRetrievalLimit?: number;
  extractionInterval?: number;
  maintenanceIntervalMs?: number;
  defaultContextWindow?: number;
  memoryBudgetPct?: number;
  extractionThresholdPct?: number;
  compactionThresholdPct?: number;
  observationMaskingWindow?: number;
  compactionEmotionalSalienceThresholdPct?: number;
  memoryExtractionMinImportance?: number;
  memoryExtractionMinConfidence?: number;
  memoryExtractionMinNovelty?: number;
  memoryExtractionEmotionalIntensityWeight?: number;
  memoryExtractionMaxWrites?: number;
  memoryExtractionTelemetryEnabled?: boolean;
  memoryRetrievalTelemetryEnabled?: boolean;
  profileSynthesisEnabled?: boolean;
  profileSynthesisRefreshIntervalMs?: number;
  profileSynthesisCooldownMs?: number;
  profileSynthesisMinWrites?: number;
  profileSynthesisMinImportance?: number;
  profileSynthesisMinConfidence?: number;
  profileSynthesisMinNovelty?: number;
  profileSynthesisSourceMemoryLimit?: number;
  profileSynthesisMinSourceMemories?: number;
  thinkMaxTokens?: number;
  thinkMaxWallTimeMs?: number;
  thinkMaxSubQueries?: number;
  retryMaxAttempts?: number;
  retryBaseDelayMs?: number;
  openRouterProviderOrder?: string[];
  importProcessingRouteMode?: ImportProcessingRouteMode;
  importProcessingStrictPolicy?: boolean;
  importProcessingLocalEndpointUrl?: string;
  importProcessingLocalModel?: string;
  compositionalPolicy?: CompositionalPolicyConfig;
  webFetchAllowHttp?: boolean;
  webFetchDomainAllowlist?: string[];
  webFetchAllowInternalNetwork?: boolean;
  /** @deprecated Use webFetchAllowInternalNetwork + webFetchDomainAllowlist instead */
  webFetchLocalCrawlerEnabled?: boolean;
  /** @deprecated Use webFetchAllowHttp instead */
  webFetchLocalCrawlerAllowHttp?: boolean;
  /** @deprecated Use webFetchDomainAllowlist instead */
  webFetchLocalCrawlerHostAllowlist?: string[];
  /** @deprecated Use webFetchDomainAllowlist instead */
  webFetchLocalCrawlerDomainAllowlist?: string[];
  webFetchTlsCaCertPaths?: string[];
  capabilityTier?: CapabilityTier;
  promotedExtendedTools?: string[];
  /** Override the base URL used by Garden Chat to reach the OpenAI-compatible API.
   *  When set, this takes priority over the `API_BASE_URL` env var and the
   *  auto-resolved URL derived from `API_HOST`/`API_PORT`. Useful when the
   *  API server is behind a reverse proxy or on a non-standard URL. */
  chatApiBaseUrl?: string;
  uiThemeId?: string;

  // Voice / TTS (non-secret config only — API keys stay in .env)
  ttsProvider?: SubstrateConfig['ttsProvider'];
  voiceId?: string;
  echoTtsUrl?: string;
  echoTtsVoice?: string;
  echoTtsPreset?: string;
  sttProvider?: SubstrateConfig['sttProvider'];
  deepgramModel?: string;

  // Channel configuration (non-secret — bot tokens stay in .env)
  discordEnabled?: boolean;
  discordHeartbeatChannel?: string;
  discordTriggerWords?: string;
  discordTriggerReactions?: string;
  discordTriggerListenWindowMs?: number;
  telegramEnabled?: boolean;
  telegramAuthorizedUsers?: string;

  // Obsidian vault
  obsidianVaultName?: string;
  obsidianCliPath?: string;
  obsidianAutoPublish?: boolean;
  obsidianTimeoutMs?: number;

  // MoA (Mixture of Agents) configuration
  moaEnabled?: boolean;
  moaReferenceModels?: string[];
  moaAggregatorModel?: string;
  moaMaxRounds?: number;
  moaMaxTokensPerRound?: number;
  moaTimeoutMs?: number;
}

export const RUNTIME_SETTINGS_KEYS = [
  'primaryModel',
  'primaryProvider',
  'primaryMaxTokens',
  'extractionModel',
  'extractionProvider',
  'extractionMaxTokens',
  'sessionHistoryBudgetPct',
  'memoryRetrievalBudgetPct',
  'moodCongruenceWeight',
  'adaptiveContextBudgetsEnabled',
  'sessionMessageLimit',
  'sessionRestartBehavior',
  'memoryRetrievalLimit',
  'extractionInterval',
  'maintenanceIntervalMs',
  'defaultContextWindow',
  'memoryBudgetPct',
  'extractionThresholdPct',
  'compactionThresholdPct',
  'observationMaskingWindow',
  'compactionEmotionalSalienceThresholdPct',
  'memoryExtractionMinImportance',
  'memoryExtractionMinConfidence',
  'memoryExtractionMinNovelty',
  'memoryExtractionEmotionalIntensityWeight',
  'memoryExtractionMaxWrites',
  'memoryExtractionTelemetryEnabled',
  'memoryRetrievalTelemetryEnabled',
  'profileSynthesisEnabled',
  'profileSynthesisRefreshIntervalMs',
  'profileSynthesisCooldownMs',
  'profileSynthesisMinWrites',
  'profileSynthesisMinImportance',
  'profileSynthesisMinConfidence',
  'profileSynthesisMinNovelty',
  'profileSynthesisSourceMemoryLimit',
  'profileSynthesisMinSourceMemories',
  'thinkMaxTokens',
  'thinkMaxWallTimeMs',
  'thinkMaxSubQueries',
  'retryMaxAttempts',
  'retryBaseDelayMs',
  'openRouterProviderOrder',
  'importProcessingRouteMode',
  'importProcessingStrictPolicy',
  'importProcessingLocalEndpointUrl',
  'importProcessingLocalModel',
  'compositionalPolicy',
  'webFetchAllowHttp',
  'webFetchDomainAllowlist',
  'webFetchAllowInternalNetwork',
  'webFetchLocalCrawlerEnabled',
  'webFetchLocalCrawlerAllowHttp',
  'webFetchLocalCrawlerHostAllowlist',
  'webFetchLocalCrawlerDomainAllowlist',
  'webFetchTlsCaCertPaths',
  'capabilityTier',
  'promotedExtendedTools',
  'chatApiBaseUrl',
  'uiThemeId',
  // Voice / TTS
  'ttsProvider',
  'voiceId',
  'echoTtsUrl',
  'echoTtsVoice',
  'echoTtsPreset',
  'sttProvider',
  'deepgramModel',
  // Channels
  'discordEnabled',
  'discordHeartbeatChannel',
  'discordTriggerWords',
  'discordTriggerReactions',
  'discordTriggerListenWindowMs',
  'telegramEnabled',
  'telegramAuthorizedUsers',
  // Obsidian vault
  'obsidianVaultName',
  'obsidianCliPath',
  'obsidianAutoPublish',
  'obsidianTimeoutMs',
  // MoA (Mixture of Agents)
  'moaEnabled',
  'moaReferenceModels',
  'moaAggregatorModel',
  'moaMaxRounds',
  'moaMaxTokensPerRound',
  'moaTimeoutMs',
] as const;

export type RuntimeSettingKey = typeof RUNTIME_SETTINGS_KEYS[number];
export type RuntimeSettingValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | CompositionalPolicyConfig;
export type RuntimeSettingsSnapshot = Record<RuntimeSettingKey, RuntimeSettingValue>;

function toPromotedToolList(value: unknown): string[] {
  return (toStringList(value) ?? []).slice(0, PROMOTED_EXTENDED_TOOL_SLOTS_MAX);
}

const CANONICAL_MODEL_PURPOSE_SET = new Set<CanonicalModelPurpose>(CANONICAL_MODEL_PURPOSES);
const MODEL_REGISTRY_THINKING_EFFORT_VALUES = new Set([
  'none',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
]);
const MODEL_REGISTRY_TEMPERATURE_RANGE = { min: 0, max: 2 } as const;
const MODEL_REGISTRY_TOP_P_RANGE = { min: 0, max: 1 } as const;
const MODEL_REGISTRY_TOP_K_RANGE = { min: 1, max: 1_000_000 } as const;
const MODEL_REGISTRY_FREQUENCY_PENALTY_RANGE = { min: -2, max: 2 } as const;
const MODEL_REGISTRY_REPETITION_PENALTY_RANGE = { min: 0, max: 2 } as const;
const MODEL_REGISTRY_THINKING_BUDGET_TOKENS_RANGE = { min: 1, max: 1_000_000 } as const;

const MODEL_REGISTRY_TOP_P_ALIASES = ['top_p'] as const;
const MODEL_REGISTRY_TOP_K_ALIASES = ['top_k'] as const;
const MODEL_REGISTRY_FREQUENCY_PENALTY_ALIASES = ['frequency_penalty'] as const;
const MODEL_REGISTRY_REPETITION_PENALTY_ALIASES = ['repetition_penalty'] as const;
const MODEL_REGISTRY_THINKING_ENABLED_ALIASES = [
  'thinking_enabled',
  'reasoningEnabled',
  'reasoning_enabled',
] as const;
const MODEL_REGISTRY_THINKING_EFFORT_ALIASES = [
  'thinking_effort',
  'reasoningEffort',
  'reasoning_effort',
] as const;
const MODEL_REGISTRY_THINKING_BUDGET_TOKENS_ALIASES = [
  'thinking_budget_tokens',
  'thinkingMaxTokens',
  'thinking_max_tokens',
  'reasoningMaxTokens',
  'reasoning_max_tokens',
] as const;

function hasLegacyModelSettingsPayload(settings: EditableSettings): boolean {
  return LEGACY_MODEL_SETTINGS_KEYS.some((key) => settings[key] !== undefined);
}

function resolveAliasedValue(
  target: Record<string, unknown>,
  canonicalKey: string,
  aliases: readonly string[],
): unknown {
  if (target[canonicalKey] !== undefined) return target[canonicalKey];
  for (const alias of aliases) {
    if (target[alias] !== undefined) return target[alias];
  }
  return undefined;
}

function removeAliases(
  target: Record<string, unknown>,
  aliases: readonly string[],
): void {
  for (const alias of aliases) {
    delete target[alias];
  }
}

function normalizeModelRegistryNumericKnob(
  tuning: Record<string, unknown>,
  fieldPath: string,
  canonicalKey: string,
  aliases: readonly string[],
  range: { min: number; max: number },
): void {
  const raw = resolveAliasedValue(tuning, canonicalKey, aliases);
  if (raw === undefined) return;
  const parsed = toStrictNumberInRange(raw, range.min, range.max);
  if (parsed === undefined) {
    throw new Error(
      `Invalid model registry at ${fieldPath}.${canonicalKey}: expected number in range ${range.min}-${range.max}`,
    );
  }
  tuning[canonicalKey] = parsed;
  removeAliases(tuning, aliases);
}

function normalizeModelRegistryIntegerKnob(
  tuning: Record<string, unknown>,
  fieldPath: string,
  canonicalKey: string,
  aliases: readonly string[],
  range: { min: number; max: number },
): void {
  const raw = resolveAliasedValue(tuning, canonicalKey, aliases);
  if (raw === undefined) return;
  const parsed = toStrictIntegerInRange(raw, range.min, range.max);
  if (parsed === undefined) {
    throw new Error(
      `Invalid model registry at ${fieldPath}.${canonicalKey}: expected integer in range ${range.min}-${range.max}`,
    );
  }
  tuning[canonicalKey] = parsed;
  removeAliases(tuning, aliases);
}

function normalizeModelRegistryThinkingSource(
  source: unknown,
  fieldPath: string,
): {
  enabled?: unknown;
  effort?: unknown;
  budgetTokens?: unknown;
} {
  if (typeof source === 'boolean') {
    return { enabled: source };
  }
  if (typeof source === 'string') {
    const asBoolean = toBoolean(source);
    if (asBoolean !== undefined) return { enabled: asBoolean };
    return { effort: source };
  }
  if (!isRecord(source)) {
    throw new Error(
      `Invalid model registry at ${fieldPath}: expected boolean, string, or object`,
    );
  }
  const enabled = source.enabled ?? source.thinkingEnabled ?? source.reasoningEnabled;
  const effort = source.effort ?? source.thinkingEffort ?? source.reasoningEffort;
  const budgetTokens = source.budgetTokens
    ?? source.budget_tokens
    ?? source.maxTokens
    ?? source.max_tokens;
  if (enabled === undefined && effort === undefined && budgetTokens === undefined) {
    throw new Error(
      `Invalid model registry at ${fieldPath}: expected at least one of enabled, effort, or budgetTokens`,
    );
  }
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
  };
}

function normalizeModelRegistryThinkingControls(
  tuning: Record<string, unknown>,
  fieldPath: string,
): void {
  let thinkingEnabledRaw: unknown;
  let thinkingEffortRaw: unknown;
  let thinkingBudgetTokensRaw: unknown;

  const compositeThinking = tuning.thinking;
  if (compositeThinking !== undefined) {
    const normalized = normalizeModelRegistryThinkingSource(compositeThinking, `${fieldPath}.thinking`);
    if (normalized.enabled !== undefined) thinkingEnabledRaw = normalized.enabled;
    if (normalized.effort !== undefined) thinkingEffortRaw = normalized.effort;
    if (normalized.budgetTokens !== undefined) thinkingBudgetTokensRaw = normalized.budgetTokens;
    delete tuning.thinking;
  }

  const compositeReasoning = tuning.reasoning;
  if (compositeReasoning !== undefined) {
    const normalized = normalizeModelRegistryThinkingSource(compositeReasoning, `${fieldPath}.reasoning`);
    if (normalized.enabled !== undefined) thinkingEnabledRaw = normalized.enabled;
    if (normalized.effort !== undefined) thinkingEffortRaw = normalized.effort;
    if (normalized.budgetTokens !== undefined) thinkingBudgetTokensRaw = normalized.budgetTokens;
    delete tuning.reasoning;
  }

  const explicitThinkingEnabled = resolveAliasedValue(
    tuning,
    'thinkingEnabled',
    MODEL_REGISTRY_THINKING_ENABLED_ALIASES,
  );
  if (explicitThinkingEnabled !== undefined) {
    thinkingEnabledRaw = explicitThinkingEnabled;
  }
  const explicitThinkingEffort = resolveAliasedValue(
    tuning,
    'thinkingEffort',
    MODEL_REGISTRY_THINKING_EFFORT_ALIASES,
  );
  if (explicitThinkingEffort !== undefined) {
    thinkingEffortRaw = explicitThinkingEffort;
  }
  const explicitThinkingBudgetTokens = resolveAliasedValue(
    tuning,
    'thinkingBudgetTokens',
    MODEL_REGISTRY_THINKING_BUDGET_TOKENS_ALIASES,
  );
  if (explicitThinkingBudgetTokens !== undefined) {
    thinkingBudgetTokensRaw = explicitThinkingBudgetTokens;
  }

  if (thinkingEnabledRaw !== undefined) {
    const normalized = toBoolean(thinkingEnabledRaw);
    if (normalized === undefined) {
      throw new Error(`Invalid model registry at ${fieldPath}.thinkingEnabled: expected boolean`);
    }
    tuning.thinkingEnabled = normalized;
  }

  if (thinkingEffortRaw !== undefined) {
    if (typeof thinkingEffortRaw !== 'string') {
      throw new Error(
        `Invalid model registry at ${fieldPath}.thinkingEffort: expected one of ${[...MODEL_REGISTRY_THINKING_EFFORT_VALUES].join(', ')}`,
      );
    }
    const normalized = thinkingEffortRaw.trim().toLowerCase();
    if (!MODEL_REGISTRY_THINKING_EFFORT_VALUES.has(normalized)) {
      throw new Error(
        `Invalid model registry at ${fieldPath}.thinkingEffort: expected one of ${[...MODEL_REGISTRY_THINKING_EFFORT_VALUES].join(', ')}`,
      );
    }
    tuning.thinkingEffort = normalized;
  }

  if (thinkingBudgetTokensRaw !== undefined) {
    const normalized = toStrictIntegerInRange(
      thinkingBudgetTokensRaw,
      MODEL_REGISTRY_THINKING_BUDGET_TOKENS_RANGE.min,
      MODEL_REGISTRY_THINKING_BUDGET_TOKENS_RANGE.max,
    );
    if (normalized === undefined) {
      throw new Error(
        `Invalid model registry at ${fieldPath}.thinkingBudgetTokens: expected integer in range ${MODEL_REGISTRY_THINKING_BUDGET_TOKENS_RANGE.min}-${MODEL_REGISTRY_THINKING_BUDGET_TOKENS_RANGE.max}`,
      );
    }
    tuning.thinkingBudgetTokens = normalized;
  }

  removeAliases(tuning, MODEL_REGISTRY_THINKING_ENABLED_ALIASES);
  removeAliases(tuning, MODEL_REGISTRY_THINKING_EFFORT_ALIASES);
  removeAliases(tuning, MODEL_REGISTRY_THINKING_BUDGET_TOKENS_ALIASES);
}

function normalizeModelRegistryTuning(
  value: Record<string, unknown>,
  fieldPath: string,
): Record<string, unknown> {
  const tuning = { ...value };
  normalizeModelRegistryNumericKnob(
    tuning,
    fieldPath,
    'temperature',
    [],
    MODEL_REGISTRY_TEMPERATURE_RANGE,
  );
  normalizeModelRegistryNumericKnob(
    tuning,
    fieldPath,
    'topP',
    MODEL_REGISTRY_TOP_P_ALIASES,
    MODEL_REGISTRY_TOP_P_RANGE,
  );
  normalizeModelRegistryIntegerKnob(
    tuning,
    fieldPath,
    'topK',
    MODEL_REGISTRY_TOP_K_ALIASES,
    MODEL_REGISTRY_TOP_K_RANGE,
  );
  normalizeModelRegistryNumericKnob(
    tuning,
    fieldPath,
    'frequencyPenalty',
    MODEL_REGISTRY_FREQUENCY_PENALTY_ALIASES,
    MODEL_REGISTRY_FREQUENCY_PENALTY_RANGE,
  );
  normalizeModelRegistryNumericKnob(
    tuning,
    fieldPath,
    'repetitionPenalty',
    MODEL_REGISTRY_REPETITION_PENALTY_ALIASES,
    MODEL_REGISTRY_REPETITION_PENALTY_RANGE,
  );
  normalizeModelRegistryThinkingControls(tuning, fieldPath);
  return tuning;
}

function normalizeModelRegistryPurposeTag(
  value: unknown,
  fieldPath: string,
): { purpose: CanonicalModelPurpose; primary: boolean } {
  if (!isRecord(value)) {
    throw new Error(`Invalid model registry at ${fieldPath}: expected object`);
  }
  const purposeRaw = toNonEmptyString(value.purpose);
  if (!purposeRaw || !CANONICAL_MODEL_PURPOSE_SET.has(purposeRaw as CanonicalModelPurpose)) {
    throw new Error(
      `Invalid model registry at ${fieldPath}.purpose: expected one of ${CANONICAL_MODEL_PURPOSES.join(', ')}`,
    );
  }
  const primary = toBoolean(value.primary);
  if (primary === undefined) {
    throw new Error(`Invalid model registry at ${fieldPath}.primary: expected boolean`);
  }
  return {
    purpose: purposeRaw as CanonicalModelPurpose,
    primary,
  };
}

function normalizeModelRegistryBudgetPolicy(
  value: unknown,
  fieldPath: string,
): ModelRegistryBudgetPolicy {
  if (!isRecord(value)) {
    throw new Error(`Invalid model registry at ${fieldPath}: expected object`);
  }

  const enabled = toBoolean(value.enabled);
  if (enabled === undefined) {
    throw new Error(`Invalid model registry at ${fieldPath}.enabled: expected boolean`);
  }

  const dailyUsdLimit = toPositiveNumber(value.dailyUsdLimit);
  if (dailyUsdLimit === undefined) {
    throw new Error(`Invalid model registry at ${fieldPath}.dailyUsdLimit: expected positive number`);
  }

  const monthlyUsdLimit = toPositiveNumber(value.monthlyUsdLimit);
  if (monthlyUsdLimit === undefined) {
    throw new Error(`Invalid model registry at ${fieldPath}.monthlyUsdLimit: expected positive number`);
  }

  if (monthlyUsdLimit < dailyUsdLimit) {
    throw new Error(`Invalid model registry at ${fieldPath}: monthlyUsdLimit must be >= dailyUsdLimit`);
  }

  const currencyRaw = toNonEmptyString(value.currency);
  if (currencyRaw && currencyRaw.toUpperCase() !== 'USD') {
    throw new Error(`Invalid model registry at ${fieldPath}.currency: only "USD" is supported`);
  }

  return {
    enabled,
    dailyUsdLimit,
    monthlyUsdLimit,
    currency: 'USD',
  };
}

function normalizeModelRegistryEntry(value: unknown, fieldPath: string): ModelRegistryEntry {
  if (!isRecord(value)) {
    throw new Error(`Invalid model registry at ${fieldPath}: expected object`);
  }

  const id = toNonEmptyString(value.id);
  if (!id || !MODEL_SLOT_KEY_PATTERN.test(id)) {
    throw new Error(`Invalid model registry at ${fieldPath}.id: expected non-empty key-safe string`);
  }

  const rank = toIntegerInRange(value.rank, 0, Number.MAX_SAFE_INTEGER);
  if (rank === undefined) {
    throw new Error(`Invalid model registry at ${fieldPath}.rank: expected non-negative integer`);
  }

  if (!isRecord(value.identity)) {
    throw new Error(`Invalid model registry at ${fieldPath}.identity: expected object`);
  }
  const provider = toNonEmptyString(value.identity.provider);
  const model = toNonEmptyString(value.identity.model);
  if (!provider || !model) {
    throw new Error(`Invalid model registry at ${fieldPath}.identity: provider and model are required`);
  }
  if (!isRecord(value.identity.source)) {
    throw new Error(`Invalid model registry at ${fieldPath}.identity.source: expected object`);
  }
  const sourceType = toNonEmptyString(value.identity.source.type);
  if (!sourceType) {
    throw new Error(`Invalid model registry at ${fieldPath}.identity.source.type: expected non-empty string`);
  }

  if (!Array.isArray(value.purposes) || value.purposes.length === 0) {
    throw new Error(`Invalid model registry at ${fieldPath}.purposes: expected non-empty array`);
  }
  const seenPurposes = new Set<CanonicalModelPurpose>();
  const purposes = value.purposes.map((entry, index) => {
    const normalized = normalizeModelRegistryPurposeTag(entry, `${fieldPath}.purposes[${index}]`);
    if (seenPurposes.has(normalized.purpose)) {
      throw new Error(
        `Invalid model registry at ${fieldPath}.purposes[${index}]: duplicate purpose "${normalized.purpose}"`,
      );
    }
    seenPurposes.add(normalized.purpose);
    return normalized;
  });

  const capabilities = isRecord(value.capabilities) ? { ...value.capabilities } : undefined;
  const tuning = isRecord(value.tuning)
    ? normalizeModelRegistryTuning({ ...value.tuning }, `${fieldPath}.tuning`)
    : undefined;
  const cost = isRecord(value.cost) ? { ...value.cost } : undefined;
  const metadata = isRecord(value.metadata) ? { ...value.metadata } : undefined;

  const capabilityMaxTokens = toPositiveInteger(capabilities?.maxOutputTokens);
  const tuningMaxTokens = toPositiveInteger(tuning?.maxOutputTokens);
  const maxOutputTokens = tuningMaxTokens ?? capabilityMaxTokens;
  if (maxOutputTokens === undefined) {
    throw new Error(`Invalid model registry at ${fieldPath}: maxOutputTokens must be set in capabilities or tuning`);
  }

  const capabilityContextWindow = toPositiveInteger(capabilities?.contextWindow);
  const tuningContextWindow = toPositiveInteger(tuning?.contextWindow);
  if (capabilities && capabilityContextWindow !== undefined) {
    capabilities.contextWindow = capabilityContextWindow;
  }
  if (capabilities && capabilityMaxTokens !== undefined) {
    capabilities.maxOutputTokens = capabilityMaxTokens;
  }
  if (tuning) {
    tuning.maxOutputTokens = maxOutputTokens;
    if (tuningContextWindow !== undefined) {
      tuning.contextWindow = tuningContextWindow;
    }
  }

  return {
    id,
    rank,
    identity: {
      provider,
      model,
      source: {
        type: sourceType,
        ...(toNonEmptyString(value.identity.source.label)
          ? { label: toNonEmptyString(value.identity.source.label) }
          : {}),
        ...(toNonEmptyString(value.identity.source.baseUrl)
          ? { baseUrl: toNonEmptyString(value.identity.source.baseUrl) }
          : {}),
        ...(isRecord(value.identity.source.metadata)
          ? { metadata: { ...value.identity.source.metadata } }
          : {}),
      },
      ...(toNonEmptyString(value.identity.family)
        ? { family: toNonEmptyString(value.identity.family) }
        : {}),
    },
    purposes,
    ...(capabilities ? { capabilities } : {}),
    ...(tuning ? { tuning } : {}),
    ...(cost ? { cost } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function normalizeCanonicalModelRegistry(
  value: unknown,
  sourcePath = 'modelRegistry',
): CanonicalModelRegistry {
  if (!isRecord(value)) {
    throw new Error(`Invalid model registry at ${sourcePath}: expected object`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`Invalid model registry at ${sourcePath}.schemaVersion: expected 1`);
  }
  if (!Array.isArray(value.models) || value.models.length === 0) {
    throw new Error(`Invalid model registry at ${sourcePath}.models: expected non-empty array`);
  }
  const budgetPolicy = value.budgetPolicy !== undefined
    ? normalizeModelRegistryBudgetPolicy(value.budgetPolicy, `${sourcePath}.budgetPolicy`)
    : undefined;

  const primaryPurposeCounts = new Map<CanonicalModelPurpose, number>(
    CANONICAL_MODEL_PURPOSES.map((purpose) => [purpose, 0]),
  );
  const seenIds = new Set<string>();
  const models = value.models.map((entry, index) => {
    const normalized = normalizeModelRegistryEntry(entry, `${sourcePath}.models[${index}]`);
    if (seenIds.has(normalized.id)) {
      throw new Error(`Invalid model registry at ${sourcePath}.models[${index}].id: duplicate "${normalized.id}"`);
    }
    seenIds.add(normalized.id);
    for (const purposeTag of normalized.purposes) {
      if (!purposeTag.primary) continue;
      const previous = primaryPurposeCounts.get(purposeTag.purpose) ?? 0;
      primaryPurposeCounts.set(purposeTag.purpose, previous + 1);
    }
    return normalized;
  });

  for (const purpose of CANONICAL_MODEL_PURPOSES) {
    const primaryCount = primaryPurposeCounts.get(purpose) ?? 0;
    if (primaryCount !== 1) {
      throw new Error(
        `Invalid model registry at ${sourcePath}: purpose "${purpose}" must have exactly one primary model`,
      );
    }
  }

  return {
    schemaVersion: 1,
    models,
    ...(budgetPolicy ? { budgetPolicy } : {}),
  };
}

function resolvePrimaryModelIdsByPurpose(registry: CanonicalModelRegistry): Record<CanonicalModelPurpose, string> {
  const primaryByPurpose = {} as Record<CanonicalModelPurpose, string>;
  for (const model of registry.models) {
    for (const purposeTag of model.purposes) {
      if (!purposeTag.primary) continue;
      primaryByPurpose[purposeTag.purpose] = model.id;
    }
  }
  return primaryByPurpose;
}

function resolveModelSlotFromRegistryEntry(
  entry: ModelRegistryEntry,
  fallbackContextWindow?: number,
): ModelSlot {
  const maxTokens = toPositiveInteger(entry.tuning?.maxOutputTokens)
    ?? toPositiveInteger(entry.capabilities?.maxOutputTokens);
  if (maxTokens === undefined) {
    throw new Error(`Invalid model registry model "${entry.id}": missing maxOutputTokens`);
  }
  const contextWindow = toPositiveInteger(entry.tuning?.contextWindow)
    ?? toPositiveInteger(entry.capabilities?.contextWindow)
    ?? fallbackContextWindow;
  const capabilityContextBudget = sanitizeModelContextBudget(
    isRecord(entry.capabilities) ? entry.capabilities.contextBudget : undefined,
  );
  const tuningContextBudget = sanitizeModelContextBudget(
    isRecord(entry.tuning) ? entry.tuning.contextBudget : undefined,
  );
  return {
    model: entry.identity.model,
    provider: entry.identity.provider,
    maxTokens,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(tuningContextBudget ?? capabilityContextBudget
      ? { contextBudget: tuningContextBudget ?? capabilityContextBudget }
      : {}),
  };
}

function projectCanonicalModelRegistry(
  registry: CanonicalModelRegistry,
  options?: { defaultContextWindow?: number },
): EditableSettings {
  const catalog: Record<string, ModelCatalogEntry> = {};
  for (const model of registry.models) {
    const defaults: ModelSlotDefaults = {};
    const overrides: ModelSlotOverrides = {};
    const defaultMaxTokens = toPositiveInteger(model.capabilities?.maxOutputTokens);
    const defaultContextWindow = toPositiveInteger(model.capabilities?.contextWindow);
    const overrideMaxTokens = toPositiveInteger(model.tuning?.maxOutputTokens);
    const overrideContextWindow = toPositiveInteger(model.tuning?.contextWindow);
    const defaultContextBudget = sanitizeModelContextBudget(
      isRecord(model.capabilities) ? model.capabilities.contextBudget : undefined,
    );
    const overrideContextBudget = sanitizeModelContextBudget(
      isRecord(model.tuning) ? model.tuning.contextBudget : undefined,
    );
    if (defaultMaxTokens !== undefined) defaults.maxTokens = defaultMaxTokens;
    if (defaultContextWindow !== undefined) defaults.contextWindow = defaultContextWindow;
    if (defaultContextBudget !== undefined) defaults.contextBudget = defaultContextBudget;
    if (overrideMaxTokens !== undefined) overrides.maxTokens = overrideMaxTokens;
    if (overrideContextWindow !== undefined) overrides.contextWindow = overrideContextWindow;
    if (overrideContextBudget !== undefined) overrides.contextBudget = overrideContextBudget;
    catalog[model.id] = {
      model: model.identity.model,
      provider: model.identity.provider,
      ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    };
  }

  const primaryByPurpose = resolvePrimaryModelIdsByPurpose(registry);
  const assignments: ModelRoleAssignments = { ...primaryByPurpose };
  assignments.context = assignments.background;

  const registryById = new Map<string, ModelRegistryEntry>(registry.models.map((entry) => [entry.id, entry]));
  const chatModelId = primaryByPurpose.chat;
  const extractionModelId = primaryByPurpose.extraction;
  const backgroundModelId = primaryByPurpose.background;
  const reasoningModelId = primaryByPurpose.reasoning;
  const longContextModelId = primaryByPurpose.longContext;
  const visionModelId = primaryByPurpose.vision;

  const chatEntry = registryById.get(chatModelId);
  const extractionEntry = registryById.get(extractionModelId);
  const backgroundEntry = registryById.get(backgroundModelId);
  const reasoningEntry = registryById.get(reasoningModelId);
  const longContextEntry = registryById.get(longContextModelId);
  const visionEntry = registryById.get(visionModelId);
  if (!chatEntry || !extractionEntry || !backgroundEntry || !reasoningEntry || !longContextEntry || !visionEntry) {
    throw new Error('Invalid model registry: missing projected primary model entries');
  }

  const chatSlot = resolveModelSlotFromRegistryEntry(chatEntry, options?.defaultContextWindow);
  const extractionSlot = resolveModelSlotFromRegistryEntry(extractionEntry, options?.defaultContextWindow);
  const backgroundSlot = resolveModelSlotFromRegistryEntry(backgroundEntry, options?.defaultContextWindow);
  const reasoningSlot = resolveModelSlotFromRegistryEntry(reasoningEntry, options?.defaultContextWindow);
  const longContextSlot = resolveModelSlotFromRegistryEntry(longContextEntry, options?.defaultContextWindow);
  const visionSlot = resolveModelSlotFromRegistryEntry(visionEntry, options?.defaultContextWindow);

  return {
    modelRegistry: registry,
    modelCatalog: catalog,
    modelRoleAssignments: assignments,
    modelRoster: {
      chat: chatSlot,
      background: backgroundSlot,
      context: backgroundSlot,
      reasoning: reasoningSlot,
      longContext: longContextSlot,
      vision: visionSlot,
    },
    primaryModel: chatSlot.model,
    primaryProvider: chatSlot.provider,
    primaryMaxTokens: chatSlot.maxTokens,
    extractionModel: extractionSlot.model,
    extractionProvider: extractionSlot.provider,
    extractionMaxTokens: extractionSlot.maxTokens,
  };
}

function sanitizeModelContextBudget(value: unknown): ModelContextBudgetConfig | undefined {
  if (!isRecord(value)) return undefined;
  const sessionHistoryMinTokens = toPositiveInteger(value.sessionHistoryMinTokens);
  const memoryRetrievalMinTokens = toPositiveInteger(value.memoryRetrievalMinTokens);
  if (sessionHistoryMinTokens === undefined && memoryRetrievalMinTokens === undefined) {
    return undefined;
  }
  return {
    ...(sessionHistoryMinTokens !== undefined ? { sessionHistoryMinTokens } : {}),
    ...(memoryRetrievalMinTokens !== undefined ? { memoryRetrievalMinTokens } : {}),
  };
}

function sanitizeModelSlotDefaults(value: unknown): ModelSlotDefaults | undefined {
  if (!isRecord(value)) return undefined;
  const maxTokens = toPositiveInteger(value.maxTokens);
  const contextWindow = toPositiveInteger(value.contextWindow);
  const contextBudget = sanitizeModelContextBudget(value.contextBudget);
  const description = toNonEmptyString(value.description);
  if (maxTokens === undefined && contextWindow === undefined && contextBudget === undefined && description === undefined) {
    return undefined;
  }
  return {
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextBudget !== undefined ? { contextBudget } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

function sanitizeModelSlotOverrides(value: unknown): ModelSlotOverrides | undefined {
  if (!isRecord(value)) return undefined;
  const maxTokens = toPositiveInteger(value.maxTokens);
  const contextWindow = toPositiveInteger(value.contextWindow);
  const contextBudget = sanitizeModelContextBudget(value.contextBudget);
  if (maxTokens === undefined && contextWindow === undefined && contextBudget === undefined) {
    return undefined;
  }
  return {
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextBudget !== undefined ? { contextBudget } : {}),
  };
}

function sanitizeModelRouteConfig(value: unknown): ModelRouteConfig | undefined {
  if (!isRecord(value) || !('providerOrder' in value)) return undefined;
  return {
    providerOrder: toStringList(value.providerOrder) ?? [],
  };
}

function cloneModelRouteConfig(value: ModelRouteConfig | undefined): ModelRouteConfig | undefined {
  if (!value || !('providerOrder' in value)) return undefined;
  return {
    providerOrder: [...(value.providerOrder ?? [])],
  };
}

function _sanitizeModelCatalog(value: unknown): Record<string, ModelCatalogEntry> {
  if (!isRecord(value)) return {};
  const catalog: Record<string, ModelCatalogEntry> = {};
  for (const [rawSlotKey, rawEntry] of Object.entries(value)) {
    const slotKey = rawSlotKey.trim();
    if (!slotKey || !MODEL_SLOT_KEY_PATTERN.test(slotKey) || !isRecord(rawEntry)) continue;

    let model = toNonEmptyString(rawEntry.model);
    let provider = toNonEmptyString(rawEntry.provider);

    // Accept "openrouter/<model-id>" shorthand and normalize to canonical
    // provider + model fields so settings PATCH round-trips do not drift.
    if (model && (!provider || provider.length === 0) && model.toLowerCase().startsWith('openrouter/')) {
      const normalizedModel = model.slice('openrouter/'.length).trim();
      if (normalizedModel) {
        model = normalizedModel;
        provider = 'openrouter';
      }
    } else if (model && provider?.toLowerCase() === 'openrouter' && model.toLowerCase().startsWith('openrouter/')) {
      const normalizedModel = model.slice('openrouter/'.length).trim();
      if (normalizedModel) {
        model = normalizedModel;
      }
    }

    if (!model || !provider) continue;

    const defaults = sanitizeModelSlotDefaults(rawEntry.defaults);
    const overrides = sanitizeModelSlotOverrides(rawEntry.overrides);
    const routing = sanitizeModelRouteConfig(rawEntry.routing);

    catalog[slotKey] = {
      model,
      provider,
      ...(defaults ? { defaults } : {}),
      ...(overrides ? { overrides } : {}),
      ...(routing ? { routing } : {}),
    };
  }
  return catalog;
}

function _sanitizeModelRoleAssignments(value: unknown): ModelRoleAssignments {
  if (!isRecord(value)) return {};
  const assignments: ModelRoleAssignments = {};
  for (const [rawPurpose, rawSlotKey] of Object.entries(value)) {
    const purpose = rawPurpose.trim();
    const slotKey = toNonEmptyString(rawSlotKey);
    if (!purpose || !slotKey || !MODEL_SLOT_KEY_PATTERN.test(slotKey)) continue;
    assignments[purpose] = slotKey;
  }
  return assignments;
}

function _sanitizeModelRoster(value: unknown): Partial<Record<ModelPurpose, ModelSlot>> {
  if (!isRecord(value)) return {};
  const roster: Partial<Record<ModelPurpose, ModelSlot>> = {};

  for (const purpose of KNOWN_MODEL_PURPOSES) {
    const candidate = value[purpose];
    if (!isRecord(candidate)) continue;

    const model = toNonEmptyString(candidate.model);
    const provider = toNonEmptyString(candidate.provider);
    const maxTokens = toPositiveInteger(candidate.maxTokens);
    const contextWindow = toPositiveInteger(candidate.contextWindow);
    const contextBudget = sanitizeModelContextBudget(candidate.contextBudget);
    const routing = sanitizeModelRouteConfig(candidate.routing);
    if (!model || !provider || maxTokens === undefined) continue;

    roster[purpose] = {
      model,
      provider,
      maxTokens,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(contextBudget !== undefined ? { contextBudget } : {}),
      ...(routing ? { routing } : {}),
    };
  }

  return roster;
}

function _mergeCatalogSlot(
  catalog: Record<string, ModelCatalogEntry>,
  slotKey: string,
  slot: {
    model?: string;
    provider?: string;
    maxTokens?: number;
    contextWindow?: number;
    contextBudget?: ModelContextBudgetConfig;
    routing?: ModelRouteConfig;
  },
): void {
  const model = toNonEmptyString(slot.model);
  const provider = toNonEmptyString(slot.provider);
  if (!model || !provider || !MODEL_SLOT_KEY_PATTERN.test(slotKey)) return;

  const existing = catalog[slotKey];
  const merged: ModelCatalogEntry = {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record index may be undefined at runtime
    ...(existing ?? {}),
    model,
    provider,
  };

  const overrides: ModelSlotOverrides = {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record index may be undefined at runtime
    ...(existing?.overrides ?? {}),
  };
  if (slot.maxTokens !== undefined) overrides.maxTokens = slot.maxTokens;
  if (slot.contextWindow !== undefined) overrides.contextWindow = slot.contextWindow;
  if (slot.contextBudget !== undefined) overrides.contextBudget = slot.contextBudget;
  merged.overrides = Object.keys(overrides).length > 0 ? overrides : undefined;
  if (slot.routing !== undefined) {
    merged.routing = cloneModelRouteConfig(slot.routing);
  }

  catalog[slotKey] = merged;
}

function defaultSlotKeyForPurpose(purpose: string): string {
  if (purpose === 'background' || purpose === 'context' || purpose === 'extraction') {
    return EXTRACTION_MODEL_SLOT_KEY;
  }
  if (purpose === 'chat' || purpose === 'summary' || purpose === 'reasoning' || purpose === 'longContext') {
    return PRIMARY_MODEL_SLOT_KEY;
  }
  return purpose;
}

function resolveCatalogSlotKey(
  catalog: Record<string, ModelCatalogEntry>,
  assignments: ModelRoleAssignments,
  purpose: string,
  fallbackSlotKey?: string,
): string | undefined {
  const candidates = [
    assignments[purpose],
    purpose === 'context' ? assignments.background : undefined,
    purpose === 'context' ? assignments.extraction : undefined,
    purpose === 'background' ? assignments.extraction : undefined,
    purpose === 'extraction' ? assignments.background : undefined,
    fallbackSlotKey,
    defaultSlotKeyForPurpose(purpose),
    assignments.chat,
    PRIMARY_MODEL_SLOT_KEY,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record index may be undefined at runtime
    if (catalog[candidate]) return candidate;
  }

  const firstCatalogSlot = Object.keys(catalog)[0];
  return firstCatalogSlot;
}

function modelSlotFromCatalogEntry(
  entry: ModelCatalogEntry,
  fallback: { maxTokens?: number; contextWindow?: number; contextBudget?: ModelContextBudgetConfig },
): ModelSlot | undefined {
  const maxTokens = entry.overrides?.maxTokens
    ?? entry.defaults?.maxTokens
    ?? fallback.maxTokens;
  if (maxTokens === undefined) return undefined;

  const contextWindow = entry.overrides?.contextWindow
    ?? entry.defaults?.contextWindow
    ?? fallback.contextWindow;
  const contextBudget = entry.overrides?.contextBudget
    ?? entry.defaults?.contextBudget
    ?? fallback.contextBudget;

  return {
    model: entry.model,
    provider: entry.provider,
    maxTokens,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextBudget !== undefined ? { contextBudget } : {}),
    ...(entry.routing !== undefined ? { routing: cloneModelRouteConfig(entry.routing) } : {}),
  };
}

function _resolvePurposeSlot(
  catalog: Record<string, ModelCatalogEntry>,
  assignments: ModelRoleAssignments,
  purpose: string,
  fallback: { maxTokens?: number; contextWindow?: number; contextBudget?: ModelContextBudgetConfig },
  fallbackSlotKey?: string,
): ModelSlot | undefined {
  const slotKey = resolveCatalogSlotKey(catalog, assignments, purpose, fallbackSlotKey);
  if (!slotKey) return undefined;
  const entry = catalog[slotKey];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record<string,T> hides runtime undefined
  if (!entry) return undefined;
  return modelSlotFromCatalogEntry(entry, fallback);
}

function normalizeContextControlSettings(settings: EditableSettings): EditableSettings {
  const normalized: EditableSettings = { ...settings };

  const sessionLimit = toIntegerInRange(settings.sessionMessageLimit, 5, 200);
  if (sessionLimit !== undefined) {
    normalized.sessionMessageLimit = sessionLimit;
  } else {
    delete normalized.sessionMessageLimit;
  }

  const retrievalLimit = toIntegerInRange(settings.memoryRetrievalLimit, 1, 50);
  if (retrievalLimit !== undefined) {
    normalized.memoryRetrievalLimit = retrievalLimit;
  } else {
    delete normalized.memoryRetrievalLimit;
  }

  const sessionBudgetPct = toIntegerInRange(
    settings.sessionHistoryBudgetPct,
    SESSION_HISTORY_BUDGET_PCT_RANGE.min,
    SESSION_HISTORY_BUDGET_PCT_RANGE.max,
  );
  if (sessionBudgetPct !== undefined) {
    normalized.sessionHistoryBudgetPct = sessionBudgetPct;
  } else {
    delete normalized.sessionHistoryBudgetPct;
  }

  const retrievalBudgetPct = toIntegerInRange(
    settings.memoryRetrievalBudgetPct,
    MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.min,
    MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.max,
  );
  if (retrievalBudgetPct !== undefined) {
    normalized.memoryRetrievalBudgetPct = retrievalBudgetPct;
  } else {
    delete normalized.memoryRetrievalBudgetPct;
  }

  const moodCongruenceWeight = toNumberInRange(
    settings.moodCongruenceWeight,
    MOOD_CONGRUENCE_WEIGHT_RANGE.min,
    MOOD_CONGRUENCE_WEIGHT_RANGE.max,
  );
  if (moodCongruenceWeight !== undefined) {
    normalized.moodCongruenceWeight = moodCongruenceWeight;
  } else {
    delete normalized.moodCongruenceWeight;
  }

  if ('adaptiveContextBudgetsEnabled' in settings) {
    const adaptiveContextBudgetsEnabled = toBoolean(settings.adaptiveContextBudgetsEnabled);
    if (adaptiveContextBudgetsEnabled !== undefined) {
      normalized.adaptiveContextBudgetsEnabled = adaptiveContextBudgetsEnabled;
    } else {
      delete normalized.adaptiveContextBudgetsEnabled;
    }
  }

  const emotionalSalienceThresholdPct = toIntegerInRange(
    settings.compactionEmotionalSalienceThresholdPct,
    0,
    100,
  );
  if (emotionalSalienceThresholdPct !== undefined) {
    normalized.compactionEmotionalSalienceThresholdPct = emotionalSalienceThresholdPct;
  } else {
    delete normalized.compactionEmotionalSalienceThresholdPct;
  }

  const observationMaskingWindow = toIntegerInRange(
    settings.observationMaskingWindow,
    0,
    200,
  );
  if (observationMaskingWindow !== undefined) {
    normalized.observationMaskingWindow = observationMaskingWindow;
  } else {
    delete normalized.observationMaskingWindow;
  }

  if ('openRouterProviderOrder' in settings) {
    normalized.openRouterProviderOrder = toStringList(settings.openRouterProviderOrder) ?? [];
  }

  if ('importProcessingRouteMode' in settings) {
    normalized.importProcessingRouteMode = toImportProcessingRouteMode(settings.importProcessingRouteMode);
  }

  if ('importProcessingStrictPolicy' in settings) {
    normalized.importProcessingStrictPolicy = toBoolean(settings.importProcessingStrictPolicy) ?? false;
  }

  if ('importProcessingLocalEndpointUrl' in settings) {
    normalized.importProcessingLocalEndpointUrl =
      typeof settings.importProcessingLocalEndpointUrl === 'string'
        ? settings.importProcessingLocalEndpointUrl.trim()
        : '';
  }

  if ('importProcessingLocalModel' in settings) {
    normalized.importProcessingLocalModel =
      typeof settings.importProcessingLocalModel === 'string'
        ? settings.importProcessingLocalModel.trim()
        : '';
  }

  if ('compositionalPolicy' in settings) {
    normalized.compositionalPolicy = normalizeCompositionalPolicyConfig(settings.compositionalPolicy);
  }

  if ('webFetchAllowHttp' in settings) {
    normalized.webFetchAllowHttp = toBoolean(settings.webFetchAllowHttp) ?? false;
  }

  if ('webFetchDomainAllowlist' in settings) {
    normalized.webFetchDomainAllowlist = toStringList(settings.webFetchDomainAllowlist) ?? [];
  }

  if ('webFetchAllowInternalNetwork' in settings) {
    normalized.webFetchAllowInternalNetwork = toBoolean(settings.webFetchAllowInternalNetwork) ?? false;
  }

  if ('webFetchLocalCrawlerEnabled' in settings) {
    normalized.webFetchLocalCrawlerEnabled = toBoolean(settings.webFetchLocalCrawlerEnabled) ?? false;
  }

  if ('webFetchLocalCrawlerAllowHttp' in settings) {
    normalized.webFetchLocalCrawlerAllowHttp = toBoolean(settings.webFetchLocalCrawlerAllowHttp) ?? false;
  }

  if ('webFetchLocalCrawlerHostAllowlist' in settings) {
    normalized.webFetchLocalCrawlerHostAllowlist =
      toStringList(settings.webFetchLocalCrawlerHostAllowlist) ?? [];
  }

  if ('webFetchLocalCrawlerDomainAllowlist' in settings) {
    normalized.webFetchLocalCrawlerDomainAllowlist =
      toStringList(settings.webFetchLocalCrawlerDomainAllowlist) ?? [];
  }

  if ('webFetchTlsCaCertPaths' in settings) {
    normalized.webFetchTlsCaCertPaths = toStringList(settings.webFetchTlsCaCertPaths) ?? [];
  }

  if ('capabilityTier' in settings) {
    const tier = settings.capabilityTier;
    if (tier !== undefined && isCapabilityTier(tier)) {
      normalized.capabilityTier = tier;
    } else {
      delete normalized.capabilityTier;
    }
  }

  if ('promotedExtendedTools' in settings) {
    normalized.promotedExtendedTools = toPromotedToolList(settings.promotedExtendedTools);
  }

  if ('sessionRestartBehavior' in settings) {
    const behavior = toSessionRestartBehavior(settings.sessionRestartBehavior);
    if (behavior) {
      normalized.sessionRestartBehavior = behavior;
    } else {
      delete normalized.sessionRestartBehavior;
    }
  }

  if ('chatApiBaseUrl' in settings) {
    normalized.chatApiBaseUrl = typeof settings.chatApiBaseUrl === 'string'
      ? settings.chatApiBaseUrl.trim()
      : '';
  }

  if ('uiThemeId' in settings) {
    normalized.uiThemeId = toNonEmptyString(settings.uiThemeId) ?? DEFAULT_UI_THEME_ID;
  }

  // Voice / TTS
  if ('ttsProvider' in settings) {
    const provider = normalizeTtsProvider(settings.ttsProvider);
    if (provider !== undefined) {
      normalized.ttsProvider = provider;
    } else {
      delete normalized.ttsProvider;
    }
  }
  if ('voiceId' in settings) {
    normalized.voiceId = typeof settings.voiceId === 'string' ? settings.voiceId.trim() : '';
  }
  if ('echoTtsUrl' in settings) {
    normalized.echoTtsUrl = typeof settings.echoTtsUrl === 'string' ? settings.echoTtsUrl.trim() : '';
  }
  if ('echoTtsVoice' in settings) {
    normalized.echoTtsVoice = typeof settings.echoTtsVoice === 'string' ? settings.echoTtsVoice.trim() : '';
  }
  if ('echoTtsPreset' in settings) {
    normalized.echoTtsPreset = typeof settings.echoTtsPreset === 'string' ? settings.echoTtsPreset.trim() : '';
  }
  if ('sttProvider' in settings) {
    const provider = normalizeSttProvider(settings.sttProvider);
    if (provider !== undefined) {
      normalized.sttProvider = provider;
    } else {
      delete normalized.sttProvider;
    }
  }
  if ('deepgramModel' in settings) {
    normalized.deepgramModel = typeof settings.deepgramModel === 'string' ? settings.deepgramModel.trim() : '';
  }

  // Channels
  if ('discordEnabled' in settings) {
    normalized.discordEnabled = toBoolean(settings.discordEnabled) ?? false;
  }
  if ('discordHeartbeatChannel' in settings) {
    const trimmed = typeof settings.discordHeartbeatChannel === 'string' ? settings.discordHeartbeatChannel.trim() : '';
    normalized.discordHeartbeatChannel = trimmed || undefined;
  }
  if ('discordTriggerWords' in settings) {
    const trimmed = typeof settings.discordTriggerWords === 'string' ? settings.discordTriggerWords.trim() : '';
    normalized.discordTriggerWords = trimmed || undefined;
  }
  if ('discordTriggerReactions' in settings) {
    const trimmed = typeof settings.discordTriggerReactions === 'string' ? settings.discordTriggerReactions.trim() : '';
    normalized.discordTriggerReactions = trimmed || undefined;
  }
  if ('discordTriggerListenWindowMs' in settings) {
    normalized.discordTriggerListenWindowMs = toIntegerInRange(
      settings.discordTriggerListenWindowMs,
      10_000,
      600_000,
    );
  }
  if ('telegramEnabled' in settings) {
    normalized.telegramEnabled = toBoolean(settings.telegramEnabled) ?? false;
  }
  if ('telegramAuthorizedUsers' in settings) {
    const trimmed = typeof settings.telegramAuthorizedUsers === 'string' ? settings.telegramAuthorizedUsers.trim() : '';
    normalized.telegramAuthorizedUsers = trimmed || undefined;
  }

  // Obsidian vault
  if ('obsidianVaultName' in settings) {
    normalized.obsidianVaultName = toNonEmptyString(settings.obsidianVaultName);
  }
  if ('obsidianCliPath' in settings) {
    normalized.obsidianCliPath = toNonEmptyString(settings.obsidianCliPath) ?? 'obsidian';
  }
  if ('obsidianAutoPublish' in settings) {
    normalized.obsidianAutoPublish = toBoolean(settings.obsidianAutoPublish) ?? false;
  }
  if ('obsidianTimeoutMs' in settings) {
    normalized.obsidianTimeoutMs = toIntegerInRange(settings.obsidianTimeoutMs, 1000, 30000);
  }

  // MoA (Mixture of Agents)
  if ('moaEnabled' in settings) {
    normalized.moaEnabled = toBoolean(settings.moaEnabled) ?? false;
  }
  if ('moaReferenceModels' in settings) {
    normalized.moaReferenceModels = toStringList(settings.moaReferenceModels) ?? [];
  }
  if ('moaAggregatorModel' in settings) {
    const trimmed = typeof settings.moaAggregatorModel === 'string' ? settings.moaAggregatorModel.trim() : '';
    normalized.moaAggregatorModel = trimmed || undefined;
  }

  return normalized;
}

export function hasModelSettings(settings: EditableSettings): boolean {
  return settings.modelRegistry !== undefined;
}

export function extractModelSettings(settings: EditableSettings): EditableSettings {
  return settings.modelRegistry !== undefined
    ? { modelRegistry: settings.modelRegistry }
    : {};
}

export function splitSettingsByDomain(settings: EditableSettings): SettingsDomainSplit {
  const runtime: EditableSettings = { ...settings };
  for (const key of NON_RUNTIME_SETTINGS_KEYS) {
    delete runtime[key];
  }

  const legacyKeys: string[] = [];
  for (const key of NON_RUNTIME_SETTINGS_KEYS) {
    if (settings[key] !== undefined) {
      legacyKeys.push(key);
    }
  }

  return {
    runtime,
    models: extractModelSettings(settings),
    ...(settings.maintenanceIntervalMs !== undefined
      ? { maintenanceIntervalMs: settings.maintenanceIntervalMs }
      : {}),
    ...(settings.capabilityTier !== undefined
      ? { capabilityTier: settings.capabilityTier }
      : {}),
    legacyKeys,
  };
}

export function toRuntimeOwnedSettings(settings: EditableSettings): EditableSettings {
  return splitSettingsByDomain(settings).runtime;
}

export function normalizeEditableSettings(
  settings: EditableSettings,
  options?: { defaultContextWindow?: number },
): EditableSettings {
  const normalizedInput = normalizeContextControlSettings(settings);

  const hasLegacyModelInputs = hasLegacyModelSettingsPayload(normalizedInput);
  if (!hasModelSettings(normalizedInput)) {
    if (hasLegacyModelInputs) {
      throw new Error(
        'Legacy model settings are not accepted in this slice; provide models.modelRegistry payloads only',
      );
    }
    return { ...normalizedInput };
  }

  if (hasLegacyModelInputs) {
    throw new Error(
      'Model settings cannot mix modelRegistry with legacy primary/extraction/slot payloads',
    );
  }

  const normalizedRegistry = normalizeCanonicalModelRegistry(normalizedInput.modelRegistry, 'settings.modelRegistry');
  const projected = projectCanonicalModelRegistry(normalizedRegistry, options);
  const normalized: EditableSettings = {
    ...normalizedInput,
    ...projected,
    modelRegistry: normalizedRegistry,
  };
  return normalized;
}

function mergeModelSettingsWithConfig(config: SubstrateConfig, settings: EditableSettings): EditableSettings {
  return {
    ...(settings.modelRegistry !== undefined
      ? { modelRegistry: settings.modelRegistry }
      : {}),
    ...(settings.modelRegistry === undefined && config.modelRegistry !== undefined
      ? { modelRegistry: config.modelRegistry }
      : {}),
  };
}

export function isRuntimeSettingKey(value: string): value is RuntimeSettingKey {
  return (RUNTIME_SETTINGS_KEYS as readonly string[]).includes(value);
}

export function getRuntimeSettingsSnapshot(config: SubstrateConfig): RuntimeSettingsSnapshot {
  const sessionBudgetPct = resolveSessionHistoryBudgetPct(config);
  const retrievalBudgetPct = resolveMemoryRetrievalBudgetPct(config);

  return {
    primaryModel: config.primaryModel,
    primaryProvider: config.primaryProvider,
    primaryMaxTokens: config.primaryMaxTokens,
    extractionModel: config.extractionModel,
    extractionProvider: config.extractionProvider,
    extractionMaxTokens: config.extractionMaxTokens,
    sessionHistoryBudgetPct: sessionBudgetPct,
    memoryRetrievalBudgetPct: retrievalBudgetPct,
    moodCongruenceWeight: config.moodCongruenceWeight ?? DEFAULT_MOOD_CONGRUENCE_WEIGHT,
    adaptiveContextBudgetsEnabled: config.adaptiveContextBudgetsEnabled ?? false,
    sessionMessageLimit: config.sessionMessageLimit ?? null,
    sessionRestartBehavior: config.sessionRestartBehavior ?? 'reuse_latest_session',
    memoryRetrievalLimit: config.memoryRetrievalLimit ?? null,
    extractionInterval: config.extractionInterval,
    maintenanceIntervalMs: config.maintenanceIntervalMs,
    defaultContextWindow: config.defaultContextWindow,
    memoryBudgetPct: config.memoryBudgetPct,
    extractionThresholdPct: config.extractionThresholdPct,
    compactionThresholdPct: config.compactionThresholdPct,
    observationMaskingWindow: config.observationMaskingWindow ?? 10,
    compactionEmotionalSalienceThresholdPct: config.compactionEmotionalSalienceThresholdPct ?? 75,
    memoryExtractionMinImportance: config.memoryExtractionMinImportance ?? null,
    memoryExtractionMinConfidence: config.memoryExtractionMinConfidence ?? null,
    memoryExtractionMinNovelty: config.memoryExtractionMinNovelty ?? null,
    memoryExtractionEmotionalIntensityWeight: config.memoryExtractionEmotionalIntensityWeight ?? null,
    memoryExtractionMaxWrites: config.memoryExtractionMaxWrites ?? null,
    memoryExtractionTelemetryEnabled: config.memoryExtractionTelemetryEnabled ?? true,
    memoryRetrievalTelemetryEnabled: config.memoryRetrievalTelemetryEnabled ?? true,
    profileSynthesisEnabled: config.profileSynthesisEnabled ?? true,
    profileSynthesisRefreshIntervalMs: config.profileSynthesisRefreshIntervalMs ?? null,
    profileSynthesisCooldownMs: config.profileSynthesisCooldownMs ?? null,
    profileSynthesisMinWrites: config.profileSynthesisMinWrites ?? null,
    profileSynthesisMinImportance: config.profileSynthesisMinImportance ?? null,
    profileSynthesisMinConfidence: config.profileSynthesisMinConfidence ?? null,
    profileSynthesisMinNovelty: config.profileSynthesisMinNovelty ?? null,
    profileSynthesisSourceMemoryLimit: config.profileSynthesisSourceMemoryLimit ?? null,
    profileSynthesisMinSourceMemories: config.profileSynthesisMinSourceMemories ?? null,
    thinkMaxTokens: config.thinkMaxTokens ?? null,
    thinkMaxWallTimeMs: config.thinkMaxWallTimeMs ?? null,
    thinkMaxSubQueries: config.thinkMaxSubQueries ?? null,
    retryMaxAttempts: config.retryMaxAttempts ?? null,
    retryBaseDelayMs: config.retryBaseDelayMs ?? null,
    openRouterProviderOrder: config.openRouterProviderOrder ?? [],
    importProcessingRouteMode: config.importProcessingRouteMode ?? 'background',
    importProcessingStrictPolicy: config.importProcessingStrictPolicy ?? false,
    importProcessingLocalEndpointUrl: config.importProcessingLocalEndpointUrl ?? null,
    importProcessingLocalModel: config.importProcessingLocalModel ?? null,
    compositionalPolicy: cloneCompositionalPolicyConfig(
      config.compositionalPolicy ?? createDefaultCompositionalPolicyConfig(),
    ),
    webFetchAllowHttp: config.webFetchAllowHttp ?? false,
    webFetchDomainAllowlist: config.webFetchDomainAllowlist ?? [],
    webFetchAllowInternalNetwork: config.webFetchAllowInternalNetwork
      ?? config.webFetchLocalCrawlerEnabled
      ?? false,
    webFetchLocalCrawlerEnabled: config.webFetchLocalCrawlerEnabled ?? false,
    webFetchLocalCrawlerAllowHttp: config.webFetchLocalCrawlerAllowHttp ?? false,
    webFetchLocalCrawlerHostAllowlist: config.webFetchLocalCrawlerHostAllowlist ?? [],
    webFetchLocalCrawlerDomainAllowlist: config.webFetchLocalCrawlerDomainAllowlist ?? [],
    webFetchTlsCaCertPaths: config.webFetchTlsCaCertPaths ?? [],
    capabilityTier: config.capabilityTier ?? 'nursery',
    promotedExtendedTools: config.promotedExtendedTools ?? [],
    chatApiBaseUrl: (config as SubstrateConfig & { chatApiBaseUrl?: string }).chatApiBaseUrl ?? null,
    uiThemeId: toNonEmptyString(config.uiThemeId) ?? DEFAULT_UI_THEME_ID,
    // Voice / TTS
    ttsProvider: resolveRuntimeTtsProvider(config),
    voiceId: config.elevenLabsVoiceId ?? '',
    echoTtsUrl: config.echoTtsUrl ?? '',
    echoTtsVoice: config.echoTtsVoice ?? '',
    echoTtsPreset: config.echoTtsPreset ?? '',
    sttProvider: resolveRuntimeSttProvider(config),
    deepgramModel: config.deepgramModel ?? 'nova-3',
    // Channels
    discordEnabled: Boolean(config.discordToken),
    discordHeartbeatChannel: null,
    discordTriggerWords: config.discordTriggerWords?.join(', ') ?? null,
    discordTriggerReactions: config.discordTriggerReactions?.join(', ') ?? '👆',
    discordTriggerListenWindowMs: config.discordTriggerListenWindowMs ?? 120_000,
    telegramEnabled: config.telegramEnabled ?? false,
    telegramAuthorizedUsers: config.telegramAuthorizedUsers?.join(', ') ?? null,
    // Obsidian vault
    obsidianVaultName: config.obsidianVaultName ?? null,
    obsidianCliPath: config.obsidianCliPath ?? 'obsidian',
    obsidianAutoPublish: config.obsidianAutoPublish ?? false,
    obsidianTimeoutMs: config.obsidianTimeoutMs ?? 10000,
    // MoA (Mixture of Agents)
    moaEnabled: config.moaEnabled ?? false,
    moaReferenceModels: config.moaReferenceModels ?? [],
    moaAggregatorModel: config.moaAggregatorModel ?? null,
    moaMaxRounds: config.moaMaxRounds ?? null,
    moaMaxTokensPerRound: config.moaMaxTokensPerRound ?? null,
    moaTimeoutMs: config.moaTimeoutMs ?? null,
  };
}

/** Load saved settings from data/settings.json, seeding from config/settings.seed.json when missing/corrupt. */
export function loadSettings(
  dataDir: string,
  options?: { seedDir?: string },
): EditableSettings {
  const path = join(dataDir, SETTINGS_FILE);
  const seedDir = options?.seedDir ?? process.env.CONFIG_DIR ?? './config';
  const seedPath = join(seedDir, SETTINGS_SEED_FILE);

  const loaded = loadOrSeedJson({
    dataPath: path,
    seedPath,
    validate: (raw, sourcePath) => {
      if (!isRecord(raw)) {
        throw new Error(`Invalid settings file format at ${sourcePath}`);
      }
      return normalizeEditableSettings(raw as EditableSettings);
    },
  });

  log.info('Loaded saved settings');
  return loaded;
}

/** Atomic write: write to .tmp then rename. */
export function saveSettings(dataDir: string, settings: EditableSettings): void {
  const path = join(dataDir, SETTINGS_FILE);
  const normalized = normalizeEditableSettings(settings);
  const split = splitSettingsByDomain(normalized);
  writeJsonAtomic(path, split.runtime);
  if (split.legacyKeys.length > 0) {
    log.warn('Dropped non-runtime keys while saving settings.json', {
      keys: split.legacyKeys,
    });
  }
  log.info('Saved settings');
}

/** Mutate config in place with defined settings values. */
export function applySettings(config: SubstrateConfig, settings: EditableSettings): void {
  if (settings.sessionHistoryBudgetPct !== undefined) {
    config.sessionHistoryBudgetPct = settings.sessionHistoryBudgetPct;
  }
  if (settings.memoryRetrievalBudgetPct !== undefined) {
    config.memoryRetrievalBudgetPct = settings.memoryRetrievalBudgetPct;
  }
  if (settings.moodCongruenceWeight !== undefined) {
    config.moodCongruenceWeight = settings.moodCongruenceWeight;
  }
  if (settings.adaptiveContextBudgetsEnabled !== undefined) {
    config.adaptiveContextBudgetsEnabled = settings.adaptiveContextBudgetsEnabled;
  }
  if (settings.sessionMessageLimit !== undefined) config.sessionMessageLimit = settings.sessionMessageLimit;
  if ('sessionRestartBehavior' in settings) {
    const behavior = settings.sessionRestartBehavior;
    config.sessionRestartBehavior = behavior === 'new_session' ? 'new_session' : 'reuse_latest_session';
  }
  if (settings.memoryRetrievalLimit !== undefined) config.memoryRetrievalLimit = settings.memoryRetrievalLimit;
  if (settings.extractionInterval !== undefined) config.extractionInterval = settings.extractionInterval;
  if (settings.observationMaskingWindow !== undefined) {
    config.observationMaskingWindow = settings.observationMaskingWindow;
  }
  if (settings.compactionEmotionalSalienceThresholdPct !== undefined) {
    config.compactionEmotionalSalienceThresholdPct = settings.compactionEmotionalSalienceThresholdPct;
  }
  if (settings.memoryExtractionMinImportance !== undefined) {
    config.memoryExtractionMinImportance = settings.memoryExtractionMinImportance;
  }
  if (settings.memoryExtractionMinConfidence !== undefined) {
    config.memoryExtractionMinConfidence = settings.memoryExtractionMinConfidence;
  }
  if (settings.memoryExtractionMinNovelty !== undefined) {
    config.memoryExtractionMinNovelty = settings.memoryExtractionMinNovelty;
  }
  if (settings.memoryExtractionEmotionalIntensityWeight !== undefined) {
    config.memoryExtractionEmotionalIntensityWeight = settings.memoryExtractionEmotionalIntensityWeight;
  }
  if (settings.memoryExtractionMaxWrites !== undefined) {
    config.memoryExtractionMaxWrites = settings.memoryExtractionMaxWrites;
  }
  if (settings.memoryExtractionTelemetryEnabled !== undefined) {
    config.memoryExtractionTelemetryEnabled = settings.memoryExtractionTelemetryEnabled;
  }
  if (settings.memoryRetrievalTelemetryEnabled !== undefined) {
    config.memoryRetrievalTelemetryEnabled = settings.memoryRetrievalTelemetryEnabled;
  }
  if (settings.profileSynthesisEnabled !== undefined) {
    config.profileSynthesisEnabled = settings.profileSynthesisEnabled;
  }
  if (settings.profileSynthesisRefreshIntervalMs !== undefined) {
    config.profileSynthesisRefreshIntervalMs = settings.profileSynthesisRefreshIntervalMs;
  }
  if (settings.profileSynthesisCooldownMs !== undefined) {
    config.profileSynthesisCooldownMs = settings.profileSynthesisCooldownMs;
  }
  if (settings.profileSynthesisMinWrites !== undefined) {
    config.profileSynthesisMinWrites = settings.profileSynthesisMinWrites;
  }
  if (settings.profileSynthesisMinImportance !== undefined) {
    config.profileSynthesisMinImportance = settings.profileSynthesisMinImportance;
  }
  if (settings.profileSynthesisMinConfidence !== undefined) {
    config.profileSynthesisMinConfidence = settings.profileSynthesisMinConfidence;
  }
  if (settings.profileSynthesisMinNovelty !== undefined) {
    config.profileSynthesisMinNovelty = settings.profileSynthesisMinNovelty;
  }
  if (settings.profileSynthesisSourceMemoryLimit !== undefined) {
    config.profileSynthesisSourceMemoryLimit = settings.profileSynthesisSourceMemoryLimit;
  }
  if (settings.profileSynthesisMinSourceMemories !== undefined) {
    config.profileSynthesisMinSourceMemories = settings.profileSynthesisMinSourceMemories;
  }
  if (settings.thinkMaxTokens !== undefined) config.thinkMaxTokens = settings.thinkMaxTokens;
  if (settings.thinkMaxWallTimeMs !== undefined) config.thinkMaxWallTimeMs = settings.thinkMaxWallTimeMs;
  if (settings.thinkMaxSubQueries !== undefined) config.thinkMaxSubQueries = settings.thinkMaxSubQueries;
  if (settings.retryMaxAttempts !== undefined) config.retryMaxAttempts = settings.retryMaxAttempts;
  if (settings.retryBaseDelayMs !== undefined) config.retryBaseDelayMs = settings.retryBaseDelayMs;
  if ('openRouterProviderOrder' in settings) {
    config.openRouterProviderOrder = settings.openRouterProviderOrder && settings.openRouterProviderOrder.length > 0
      ? [...settings.openRouterProviderOrder]
      : undefined;
  }
  if ('importProcessingRouteMode' in settings) {
    config.importProcessingRouteMode = settings.importProcessingRouteMode ?? 'background';
  }
  if ('importProcessingStrictPolicy' in settings) {
    config.importProcessingStrictPolicy = settings.importProcessingStrictPolicy ?? false;
  }
  if ('importProcessingLocalEndpointUrl' in settings) {
    const trimmed = settings.importProcessingLocalEndpointUrl?.trim() ?? '';
    config.importProcessingLocalEndpointUrl = trimmed || undefined;
  }
  if ('importProcessingLocalModel' in settings) {
    const trimmed = settings.importProcessingLocalModel?.trim() ?? '';
    config.importProcessingLocalModel = trimmed || undefined;
  }
  if ('compositionalPolicy' in settings) {
    config.compositionalPolicy = cloneCompositionalPolicyConfig(settings.compositionalPolicy);
  }
  if ('webFetchAllowHttp' in settings) {
    config.webFetchAllowHttp = settings.webFetchAllowHttp ?? false;
  }
  if ('webFetchDomainAllowlist' in settings) {
    config.webFetchDomainAllowlist = settings.webFetchDomainAllowlist && settings.webFetchDomainAllowlist.length > 0
      ? [...settings.webFetchDomainAllowlist]
      : undefined;
  }
  if ('webFetchAllowInternalNetwork' in settings) {
    config.webFetchAllowInternalNetwork = settings.webFetchAllowInternalNetwork ?? false;
  }
  if ('webFetchLocalCrawlerEnabled' in settings) {
    config.webFetchLocalCrawlerEnabled = settings.webFetchLocalCrawlerEnabled ?? false;
  }
  if ('webFetchLocalCrawlerAllowHttp' in settings) {
    config.webFetchLocalCrawlerAllowHttp = settings.webFetchLocalCrawlerAllowHttp ?? false;
  }
  if ('webFetchLocalCrawlerHostAllowlist' in settings) {
    config.webFetchLocalCrawlerHostAllowlist =
      settings.webFetchLocalCrawlerHostAllowlist && settings.webFetchLocalCrawlerHostAllowlist.length > 0
        ? [...settings.webFetchLocalCrawlerHostAllowlist]
        : undefined;
  }
  if ('webFetchLocalCrawlerDomainAllowlist' in settings) {
    config.webFetchLocalCrawlerDomainAllowlist =
      settings.webFetchLocalCrawlerDomainAllowlist && settings.webFetchLocalCrawlerDomainAllowlist.length > 0
        ? [...settings.webFetchLocalCrawlerDomainAllowlist]
        : undefined;
  }
  if ('webFetchTlsCaCertPaths' in settings) {
    config.webFetchTlsCaCertPaths = settings.webFetchTlsCaCertPaths && settings.webFetchTlsCaCertPaths.length > 0
      ? [...settings.webFetchTlsCaCertPaths]
      : undefined;
  }

  if (settings.capabilityTier !== undefined && isCapabilityTier(settings.capabilityTier)) {
    config.capabilityTier = settings.capabilityTier;
  }
  if ('promotedExtendedTools' in settings) {
    config.promotedExtendedTools = toPromotedToolList(settings.promotedExtendedTools);
  }
  if ('chatApiBaseUrl' in settings) {
    const trimmed = settings.chatApiBaseUrl?.trim() ?? '';
    (config as SubstrateConfig & { chatApiBaseUrl?: string }).chatApiBaseUrl = trimmed || undefined;
  }
  if ('uiThemeId' in settings) {
    const trimmedThemeId = settings.uiThemeId?.trim() ?? '';
    config.uiThemeId = trimmedThemeId || DEFAULT_UI_THEME_ID;
  }

  // Voice / TTS
  if ('ttsProvider' in settings) {
    config.ttsProvider = normalizeTtsProvider(settings.ttsProvider);
  }
  if ('voiceId' in settings) {
    const trimmed = settings.voiceId?.trim() ?? '';
    config.elevenLabsVoiceId = trimmed || undefined;
  }
  if ('echoTtsUrl' in settings) {
    const trimmed = settings.echoTtsUrl?.trim() ?? '';
    config.echoTtsUrl = trimmed || undefined;
  }
  if ('echoTtsVoice' in settings) {
    const trimmed = settings.echoTtsVoice?.trim() ?? '';
    config.echoTtsVoice = trimmed || undefined;
  }
  if ('echoTtsPreset' in settings) {
    const trimmed = settings.echoTtsPreset?.trim() ?? '';
    config.echoTtsPreset = trimmed || undefined;
  }
  if ('sttProvider' in settings) {
    config.sttProvider = normalizeSttProvider(settings.sttProvider);
  }
  if ('deepgramModel' in settings) {
    const trimmed = settings.deepgramModel?.trim() ?? '';
    config.deepgramModel = trimmed || undefined;
  }

  // Channels
  if ('discordTriggerWords' in settings) {
    const csv = settings.discordTriggerWords?.trim() ?? '';
    config.discordTriggerWords = csv
      ? [...new Set(csv.split(',').map(s => s.trim()).filter(Boolean))]
      : [];
  }
  if ('discordTriggerReactions' in settings) {
    const csv = settings.discordTriggerReactions?.trim() ?? '';
    const reactions = csv
      ? [...new Set(csv.split(',').map(s => s.trim()).filter(Boolean))]
      : [];
    config.discordTriggerReactions = reactions.length > 0 ? reactions : ['👆'];
  }
  if ('discordTriggerListenWindowMs' in settings) {
    config.discordTriggerListenWindowMs = settings.discordTriggerListenWindowMs ?? 120_000;
  }
  if ('telegramEnabled' in settings) {
    config.telegramEnabled = settings.telegramEnabled ?? false;
  }
  if ('telegramAuthorizedUsers' in settings) {
    const csv = settings.telegramAuthorizedUsers?.trim() ?? '';
    config.telegramAuthorizedUsers = csv
      ? [...new Set(csv.split(',').map(s => s.trim()).filter(Boolean))]
      : undefined;
  }

  // Obsidian vault
  if ('obsidianVaultName' in settings) {
    config.obsidianVaultName = settings.obsidianVaultName?.trim() || undefined;
  }
  if ('obsidianCliPath' in settings) {
    config.obsidianCliPath = settings.obsidianCliPath?.trim() || undefined;
  }
  if ('obsidianAutoPublish' in settings) {
    config.obsidianAutoPublish = settings.obsidianAutoPublish ?? false;
  }
  if ('obsidianTimeoutMs' in settings) {
    config.obsidianTimeoutMs = settings.obsidianTimeoutMs;
  }

  // MoA (Mixture of Agents)
  if ('moaEnabled' in settings) {
    config.moaEnabled = settings.moaEnabled ?? false;
  }
  if ('moaReferenceModels' in settings) {
    config.moaReferenceModels = settings.moaReferenceModels && settings.moaReferenceModels.length > 0
      ? [...settings.moaReferenceModels]
      : undefined;
  }
  if ('moaAggregatorModel' in settings) {
    const trimmed = settings.moaAggregatorModel?.trim() ?? '';
    config.moaAggregatorModel = trimmed || undefined;
  }
  if (settings.moaMaxRounds !== undefined) config.moaMaxRounds = settings.moaMaxRounds;
  if (settings.moaMaxTokensPerRound !== undefined) config.moaMaxTokensPerRound = settings.moaMaxTokensPerRound;
  if (settings.moaTimeoutMs !== undefined) config.moaTimeoutMs = settings.moaTimeoutMs;

  if (hasLegacyModelSettingsPayload(settings) && settings.modelRegistry === undefined) {
    throw new Error('Legacy model settings payloads are unsupported; use modelRegistry');
  }

  const shouldSyncModels = hasModelSettings(settings)
    || config.modelRegistry !== undefined;

  if (!shouldSyncModels) return;

  const merged = mergeModelSettingsWithConfig(config, settings);
  const normalized = normalizeEditableSettings(merged, {
    defaultContextWindow: config.defaultContextWindow,
  });

  if (normalized.primaryModel !== undefined) config.primaryModel = normalized.primaryModel;
  if (normalized.primaryProvider !== undefined) config.primaryProvider = normalized.primaryProvider;
  if (normalized.primaryMaxTokens !== undefined) config.primaryMaxTokens = normalized.primaryMaxTokens;

  if (normalized.extractionModel !== undefined) config.extractionModel = normalized.extractionModel;
  if (normalized.extractionProvider !== undefined) config.extractionProvider = normalized.extractionProvider;
  if (normalized.extractionMaxTokens !== undefined) config.extractionMaxTokens = normalized.extractionMaxTokens;

  if (normalized.modelRegistry !== undefined) config.modelRegistry = normalized.modelRegistry;
  if (normalized.modelRoster !== undefined) config.modelRoster = normalized.modelRoster;
  if (normalized.modelCatalog !== undefined) config.modelCatalog = normalized.modelCatalog;
  if (normalized.modelRoleAssignments !== undefined) {
    config.modelRoleAssignments = normalized.modelRoleAssignments;
  }
}

/** Validation ranges for settings values. */
export const SETTINGS_VALIDATION = {
  primaryMaxTokens: { min: 256, max: 1_000_000 },
  extractionMaxTokens: { min: 256, max: 1_000_000 },
  sessionHistoryBudgetPct: {
    min: SESSION_HISTORY_BUDGET_PCT_RANGE.min,
    max: SESSION_HISTORY_BUDGET_PCT_RANGE.max,
  },
  memoryRetrievalBudgetPct: {
    min: MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.min,
    max: MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.max,
  },
  sessionMessageLimit: { min: 5, max: 200 },
  memoryRetrievalLimit: { min: 1, max: 50 },
  extractionInterval: { min: 1, max: 50 },
  observationMaskingWindow: { min: 0, max: 200 },
  compactionEmotionalSalienceThresholdPct: { min: 0, max: 100 },
  thinkMaxTokens: { min: 1000, max: 1000000 },
  thinkMaxWallTimeMs: { min: 5000, max: 600000 },
  thinkMaxSubQueries: { min: 1, max: 100 },
  retryMaxAttempts: { min: 0, max: 10 },
  retryBaseDelayMs: { min: 500, max: 30000 },
  discordTriggerListenWindowMs: { min: 10_000, max: 600_000 },
  obsidianTimeoutMs: { min: 1000, max: 30000 },
  moaMaxRounds: { min: 1, max: 10 },
  moaMaxTokensPerRound: { min: 256, max: 1_000_000 },
  moaTimeoutMs: { min: 5000, max: 600_000 },
} as const;

/** Validate and parse form data into EditableSettings. Returns [settings, errors]. */
export function parseSettingsForm(params: URLSearchParams): [EditableSettings, string[]] {
  const settings: EditableSettings = {};
  const errors: string[] = [];
  const parseCsvList = (value: string): string[] => [...new Set(
    value
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean),
  )];

  const openRouterProviderOrderRaw = params.get('openRouterProviderOrder');
  if (openRouterProviderOrderRaw !== null) {
    settings.openRouterProviderOrder = parseCsvList(openRouterProviderOrderRaw);
  }

  const importProcessingRouteModeRaw = params.get('importProcessingRouteMode');
  if (importProcessingRouteModeRaw !== null) {
    const mode = toImportProcessingRouteMode(importProcessingRouteModeRaw);
    if (!mode) {
      errors.push('importProcessingRouteMode must be one of: background, openrouter_zdr, local_endpoint');
    } else {
      settings.importProcessingRouteMode = mode;
    }
  }

  const importProcessingStrictPolicyRaw = params.get('importProcessingStrictPolicy');
  if (importProcessingStrictPolicyRaw !== null) {
    const strictPolicy = toBoolean(importProcessingStrictPolicyRaw);
    if (strictPolicy === undefined) {
      errors.push('importProcessingStrictPolicy must be true or false');
    } else {
      settings.importProcessingStrictPolicy = strictPolicy;
    }
  }

  const adaptiveContextBudgetsEnabledRaw = params.get('adaptiveContextBudgetsEnabled');
  if (adaptiveContextBudgetsEnabledRaw !== null) {
    const enabled = toBoolean(adaptiveContextBudgetsEnabledRaw);
    if (enabled === undefined) {
      errors.push('adaptiveContextBudgetsEnabled must be true or false');
    } else {
      settings.adaptiveContextBudgetsEnabled = enabled;
    }
  }

  const moodCongruenceWeightRaw = params.get('moodCongruenceWeight');
  if (moodCongruenceWeightRaw !== null && moodCongruenceWeightRaw !== '') {
    const parsed = Number.parseFloat(moodCongruenceWeightRaw);
    if (
      !Number.isFinite(parsed)
      || parsed < MOOD_CONGRUENCE_WEIGHT_RANGE.min
      || parsed > MOOD_CONGRUENCE_WEIGHT_RANGE.max
    ) {
      errors.push(
        `moodCongruenceWeight must be ${MOOD_CONGRUENCE_WEIGHT_RANGE.min}-${MOOD_CONGRUENCE_WEIGHT_RANGE.max}`,
      );
    } else {
      settings.moodCongruenceWeight = parsed;
    }
  }

  const importProcessingLocalEndpointUrlRaw = params.get('importProcessingLocalEndpointUrl');
  if (importProcessingLocalEndpointUrlRaw !== null) {
    const endpointUrl = importProcessingLocalEndpointUrlRaw.trim();
    settings.importProcessingLocalEndpointUrl = endpointUrl;
    if (endpointUrl) {
      try {
        const parsed = new URL(endpointUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          errors.push('importProcessingLocalEndpointUrl must use http or https');
        }
      } catch {
        errors.push('importProcessingLocalEndpointUrl must be a valid URL');
      }
    }
  }

  const importProcessingLocalModelRaw = params.get('importProcessingLocalModel');
  if (importProcessingLocalModelRaw !== null) {
    settings.importProcessingLocalModel = importProcessingLocalModelRaw.trim();
  }

  const webFetchAllowHttpRaw = params.get('webFetchAllowHttp');
  if (webFetchAllowHttpRaw !== null) {
    const allowHttp = toBoolean(webFetchAllowHttpRaw);
    if (allowHttp === undefined) {
      errors.push('webFetchAllowHttp must be true or false');
    } else {
      settings.webFetchAllowHttp = allowHttp;
    }
  }

  const webFetchDomainAllowlistRaw = params.get('webFetchDomainAllowlist');
  if (webFetchDomainAllowlistRaw !== null) {
    settings.webFetchDomainAllowlist = parseCsvList(webFetchDomainAllowlistRaw);
  }

  const webFetchAllowInternalNetworkRaw = params.get('webFetchAllowInternalNetwork');
  if (webFetchAllowInternalNetworkRaw !== null) {
    const allow = toBoolean(webFetchAllowInternalNetworkRaw);
    if (allow === undefined) {
      errors.push('webFetchAllowInternalNetwork must be true or false');
    } else {
      settings.webFetchAllowInternalNetwork = allow;
    }
  }

  const webFetchLocalCrawlerEnabledRaw = params.get('webFetchLocalCrawlerEnabled');
  if (webFetchLocalCrawlerEnabledRaw !== null) {
    const enabled = toBoolean(webFetchLocalCrawlerEnabledRaw);
    if (enabled === undefined) {
      errors.push('webFetchLocalCrawlerEnabled must be true or false');
    } else {
      settings.webFetchLocalCrawlerEnabled = enabled;
    }
  }

  const webFetchLocalCrawlerAllowHttpRaw = params.get('webFetchLocalCrawlerAllowHttp');
  if (webFetchLocalCrawlerAllowHttpRaw !== null) {
    const allowHttp = toBoolean(webFetchLocalCrawlerAllowHttpRaw);
    if (allowHttp === undefined) {
      errors.push('webFetchLocalCrawlerAllowHttp must be true or false');
    } else {
      settings.webFetchLocalCrawlerAllowHttp = allowHttp;
    }
  }

  const webFetchLocalCrawlerHostAllowlistRaw = params.get('webFetchLocalCrawlerHostAllowlist');
  if (webFetchLocalCrawlerHostAllowlistRaw !== null) {
    settings.webFetchLocalCrawlerHostAllowlist = parseCsvList(webFetchLocalCrawlerHostAllowlistRaw);
  }

  const webFetchLocalCrawlerDomainAllowlistRaw = params.get('webFetchLocalCrawlerDomainAllowlist');
  if (webFetchLocalCrawlerDomainAllowlistRaw !== null) {
    settings.webFetchLocalCrawlerDomainAllowlist = parseCsvList(webFetchLocalCrawlerDomainAllowlistRaw);
  }

  const webFetchTlsCaCertPathsRaw = params.get('webFetchTlsCaCertPaths');
  if (webFetchTlsCaCertPathsRaw !== null) {
    settings.webFetchTlsCaCertPaths = parseCsvList(webFetchTlsCaCertPathsRaw);
  }

  const chatApiBaseUrlRaw = params.get('chatApiBaseUrl');
  if (chatApiBaseUrlRaw !== null) {
    const endpointUrl = chatApiBaseUrlRaw.trim();
    settings.chatApiBaseUrl = endpointUrl;
    if (endpointUrl) {
      try {
        const parsed = new URL(endpointUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          errors.push('chatApiBaseUrl must use http or https');
        }
      } catch {
        errors.push('chatApiBaseUrl must be a valid URL');
      }
    }
  }

  const uiThemeIdRaw = params.get('uiThemeId');
  if (uiThemeIdRaw !== null) {
    settings.uiThemeId = uiThemeIdRaw.trim() || DEFAULT_UI_THEME_ID;
  }

  const capabilityTierRaw = params.get('capabilityTier');
  if (capabilityTierRaw !== null) {
    const tier = capabilityTierRaw.trim();
    if (!isCapabilityTier(tier)) {
      errors.push('capabilityTier must be one of: nursery, apprentice, autonomous, custom');
    } else {
      settings.capabilityTier = tier;
    }
  }

  const promotedExtendedToolsRaw = params.get('promotedExtendedTools');
  if (promotedExtendedToolsRaw !== null) {
    settings.promotedExtendedTools = parseCsvList(promotedExtendedToolsRaw)
      .slice(0, PROMOTED_EXTENDED_TOOL_SLOTS_MAX);
  }

  const sessionRestartBehaviorRaw = params.get('sessionRestartBehavior');
  if (sessionRestartBehaviorRaw !== null) {
    const behavior = toSessionRestartBehavior(sessionRestartBehaviorRaw);
    if (!behavior) {
      errors.push('sessionRestartBehavior must be one of: reuse_latest_session, new_session');
    } else {
      settings.sessionRestartBehavior = behavior;
    }
  }

  // Voice / TTS
  const ttsProviderRaw = params.get('ttsProvider');
  if (ttsProviderRaw !== null) {
    const provider = toConfiguredTtsProvider(ttsProviderRaw);
    if (!provider) {
      errors.push('ttsProvider must be "disabled" or a registered TTS provider id');
    } else {
      settings.ttsProvider = provider;
    }
  }

  const voiceIdRaw = params.get('voiceId');
  if (voiceIdRaw !== null) {
    settings.voiceId = voiceIdRaw.trim();
  }

  const echoTtsUrlRaw = params.get('echoTtsUrl');
  if (echoTtsUrlRaw !== null) {
    settings.echoTtsUrl = echoTtsUrlRaw.trim();
  }

  const echoTtsVoiceRaw = params.get('echoTtsVoice');
  if (echoTtsVoiceRaw !== null) {
    settings.echoTtsVoice = echoTtsVoiceRaw.trim();
  }

  const echoTtsPresetRaw = params.get('echoTtsPreset');
  if (echoTtsPresetRaw !== null) {
    settings.echoTtsPreset = echoTtsPresetRaw.trim();
  }

  const sttProviderRaw = params.get('sttProvider');
  if (sttProviderRaw !== null) {
    const provider = toConfiguredSttProvider(sttProviderRaw);
    if (!provider) {
      errors.push('sttProvider must be "disabled" or a registered STT provider id');
    } else {
      settings.sttProvider = provider;
    }
  }

  const deepgramModelRaw = params.get('deepgramModel');
  if (deepgramModelRaw !== null) {
    settings.deepgramModel = deepgramModelRaw.trim();
  }

  // Channels
  const discordEnabledRaw = params.get('discordEnabled');
  if (discordEnabledRaw !== null) {
    const enabled = toBoolean(discordEnabledRaw);
    if (enabled === undefined) {
      errors.push('discordEnabled must be true or false');
    } else {
      settings.discordEnabled = enabled;
    }
  }

  const discordHeartbeatChannelRaw = params.get('discordHeartbeatChannel');
  if (discordHeartbeatChannelRaw !== null) {
    settings.discordHeartbeatChannel = discordHeartbeatChannelRaw.trim();
  }

  const discordTriggerWordsRaw = params.get('discordTriggerWords');
  if (discordTriggerWordsRaw !== null) {
    settings.discordTriggerWords = discordTriggerWordsRaw.trim();
  }

  const discordTriggerReactionsRaw = params.get('discordTriggerReactions');
  if (discordTriggerReactionsRaw !== null) {
    settings.discordTriggerReactions = discordTriggerReactionsRaw.trim();
  }

  const telegramEnabledRaw = params.get('telegramEnabled');
  if (telegramEnabledRaw !== null) {
    const enabled = toBoolean(telegramEnabledRaw);
    if (enabled === undefined) {
      errors.push('telegramEnabled must be true or false');
    } else {
      settings.telegramEnabled = enabled;
    }
  }

  const telegramAuthorizedUsersRaw = params.get('telegramAuthorizedUsers');
  if (telegramAuthorizedUsersRaw !== null) {
    settings.telegramAuthorizedUsers = telegramAuthorizedUsersRaw.trim();
  }

  // Obsidian vault
  const obsidianVaultNameRaw = params.get('obsidianVaultName');
  if (obsidianVaultNameRaw !== null) {
    settings.obsidianVaultName = obsidianVaultNameRaw.trim() || undefined;
  }

  const obsidianCliPathRaw = params.get('obsidianCliPath');
  if (obsidianCliPathRaw !== null) {
    settings.obsidianCliPath = obsidianCliPathRaw.trim() || 'obsidian';
  }

  const obsidianAutoPublishRaw = params.get('obsidianAutoPublish');
  if (obsidianAutoPublishRaw !== null) {
    const enabled = toBoolean(obsidianAutoPublishRaw);
    if (enabled === undefined) {
      errors.push('obsidianAutoPublish must be true or false');
    } else {
      settings.obsidianAutoPublish = enabled;
    }
  }

  // obsidianTimeoutMs is handled by SETTINGS_VALIDATION numeric loop

  // MoA (Mixture of Agents)
  const moaEnabledRaw = params.get('moaEnabled');
  if (moaEnabledRaw !== null) {
    const enabled = toBoolean(moaEnabledRaw);
    if (enabled === undefined) {
      errors.push('moaEnabled must be true or false');
    } else {
      settings.moaEnabled = enabled;
    }
  }

  const moaReferenceModelsRaw = params.get('moaReferenceModels');
  if (moaReferenceModelsRaw !== null) {
    settings.moaReferenceModels = parseCsvList(moaReferenceModelsRaw);
  }

  const moaAggregatorModelRaw = params.get('moaAggregatorModel');
  if (moaAggregatorModelRaw !== null) {
    settings.moaAggregatorModel = moaAggregatorModelRaw.trim();
  }

  // Numeric fields
  for (const [field, range] of Object.entries(SETTINGS_VALIDATION)) {
    const raw = params.get(field);
    if (raw === null || raw === '') continue;
    const val = Number.parseInt(raw, 10);
    if (Number.isNaN(val) || val < range.min || val > range.max) {
      errors.push(`${field} must be ${range.min}-${range.max}`);
    } else {
      (settings as Record<string, number>)[field] = val;
    }
  }

  const modelRegistryJson = params.get('modelRegistryJson')?.trim();
  if (modelRegistryJson) {
    try {
      settings.modelRegistry = normalizeCanonicalModelRegistry(
        JSON.parse(modelRegistryJson),
        'modelRegistryJson',
      );
    } catch {
      errors.push('modelRegistryJson must be valid canonical model registry JSON');
    }
  }

  if (settings.importProcessingRouteMode === 'local_endpoint') {
    if (!settings.importProcessingLocalEndpointUrl) {
      errors.push('importProcessingLocalEndpointUrl is required when importProcessingRouteMode=local_endpoint');
    }
    if (!settings.importProcessingLocalModel) {
      errors.push('importProcessingLocalModel is required when importProcessingRouteMode=local_endpoint');
    }
  }

  if (settings.webFetchLocalCrawlerEnabled) {
    const hasHostAllowlist = (settings.webFetchLocalCrawlerHostAllowlist?.length ?? 0) > 0;
    const hasDomainAllowlist = (settings.webFetchLocalCrawlerDomainAllowlist?.length ?? 0) > 0;
    if (!hasHostAllowlist && !hasDomainAllowlist) {
      errors.push('webFetchLocalCrawlerEnabled requires host/domain allowlist');
    }
  }

  if (errors.length > 0) {
    return [settings, errors];
  }

  try {
    return [normalizeEditableSettings(settings), errors];
  } catch (error) {
    return [settings, [...errors, error instanceof Error ? error.message : 'Invalid settings payload']];
  }
}
