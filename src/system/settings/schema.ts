import {
  CANONICAL_MODEL_PURPOSES,
  type CanonicalModelRegistry,
  type CanonicalModelPurpose,
  type ModelRegistryBudgetPolicy,
  type ModelRegistryEntry,
  type ModelCatalogEntry,
  type ModelContextBudgetConfig,
  type ModelRouteConfig,
  type ModelPurpose,
  type ModelRoleAssignments,
  type ModelSlot,
  type ModelSlotDefaults,
  type ModelSlotOverrides,
  DEFAULT_UI_THEME_ID,
  PROMOTED_EXTENDED_TOOL_SLOTS_MAX,
} from '../../types.js';
import { normalizeImageWorkflowSettings } from '../../images/types.js';
import {
  MEMORY_RETRIEVAL_BUDGET_PCT_RANGE,
  SESSION_HISTORY_BUDGET_PCT_RANGE,
} from '../../context-budget.js';
import { normalizeCompositionalPolicyConfig } from '../../compositional/policy.js';
import { isRecord } from '../../shared/utils/types.js';
import { isCapabilityTier } from '../capabilities/tiers.js';
import {
  normalizeSttProvider,
  normalizeTtsProvider,
  toEmbeddingProvider,
  toBoolean,
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
} from './coercion.js';
import {
  COMPACTION_THRESHOLD_PCT_RANGE,
  EXTRACTION_MODEL_SLOT_KEY,
  EXTRACTION_THRESHOLD_PCT_RANGE,
  KNOWN_MODEL_PURPOSES,
  MODEL_SLOT_KEY_PATTERN,
  MOOD_CONGRUENCE_WEIGHT_RANGE,
  PRIMARY_MODEL_SLOT_KEY,
  REMOVED_RUNTIME_SETTINGS_KEYS,
  type EditableSettings,
  type SettingsDomainSplit,
} from './contracts.js';

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

export function toPromotedToolList(value: unknown): string[] {
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
const TEXT_EMOTION_DTYPE_VALUES = [
  'auto',
  'fp32',
  'fp16',
  'q8',
  'int8',
  'uint8',
  'q4',
  'bnb4',
  'q4f16',
] as const;
const TEXT_EMOTION_DTYPE_SET = new Set<string>(TEXT_EMOTION_DTYPE_VALUES);
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

export function hasLegacyModelSettingsPayload(settings: EditableSettings): boolean {
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

function normalizeTextEmotionDtype(value: unknown): EditableSettings['textEmotionDtype'] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  if (!TEXT_EMOTION_DTYPE_SET.has(normalized)) {
    return undefined;
  }
  return normalized as EditableSettings['textEmotionDtype'];
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

  const seenIds = new Set<string>();
  const models = value.models.map((entry, index) => {
    const normalized = normalizeModelRegistryEntry(entry, `${sourcePath}.models[${index}]`);
    if (seenIds.has(normalized.id)) {
      throw new Error(`Invalid model registry at ${sourcePath}.models[${index}].id: duplicate "${normalized.id}"`);
    }
    seenIds.add(normalized.id);
    return normalized;
  });
  backfillPrimaryMemoryPurpose(models);

  const primaryPurposeCounts = new Map<CanonicalModelPurpose, number>(
    CANONICAL_MODEL_PURPOSES.map((purpose) => [purpose, 0]),
  );
  for (const model of models) {
    for (const purposeTag of model.purposes) {
      if (!purposeTag.primary) continue;
      const previous = primaryPurposeCounts.get(purposeTag.purpose) ?? 0;
      primaryPurposeCounts.set(purposeTag.purpose, previous + 1);
    }
  }

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

function backfillPrimaryMemoryPurpose(models: ModelRegistryEntry[]): void {
  if (models.some((entry) => entry.purposes.some((tag) => tag.purpose === 'memory' && tag.primary))) {
    return;
  }

  // Compatibility migration: before the dedicated memory route existed, extraction/background
  // carried this workload. Preserve loadability by projecting memory onto that primary model.
  const target = models.find((entry) => entry.purposes.some((tag) => tag.purpose === 'extraction' && tag.primary))
    ?? models.find((entry) => entry.purposes.some((tag) => tag.purpose === 'background' && tag.primary));
  if (!target) return;

  const existingMemoryIndex = target.purposes.findIndex((tag) => tag.purpose === 'memory');
  if (existingMemoryIndex >= 0) {
    target.purposes[existingMemoryIndex] = {
      ...target.purposes[existingMemoryIndex],
      primary: true,
    };
    return;
  }

  target.purposes.push({ purpose: 'memory', primary: true });
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
  const memoryModelId = primaryByPurpose.memory;
  const reasoningModelId = primaryByPurpose.reasoning;
  const longContextModelId = primaryByPurpose.longContext;
  const visionModelId = primaryByPurpose.vision;

  const chatEntry = registryById.get(chatModelId);
  const extractionEntry = registryById.get(extractionModelId);
  const backgroundEntry = registryById.get(backgroundModelId);
  const memoryEntry = registryById.get(memoryModelId);
  const reasoningEntry = registryById.get(reasoningModelId);
  const longContextEntry = registryById.get(longContextModelId);
  const visionEntry = registryById.get(visionModelId);
  if (!chatEntry || !extractionEntry || !backgroundEntry || !memoryEntry || !reasoningEntry || !longContextEntry || !visionEntry) {
    throw new Error('Invalid model registry: missing projected primary model entries');
  }

  const chatSlot = resolveModelSlotFromRegistryEntry(chatEntry, options?.defaultContextWindow);
  const extractionSlot = resolveModelSlotFromRegistryEntry(extractionEntry, options?.defaultContextWindow);
  const backgroundSlot = resolveModelSlotFromRegistryEntry(backgroundEntry, options?.defaultContextWindow);
  const memorySlot = resolveModelSlotFromRegistryEntry(memoryEntry, options?.defaultContextWindow);
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
      memory: memorySlot,
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
  if (purpose === 'background' || purpose === 'memory' || purpose === 'context' || purpose === 'extraction') {
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
    purpose === 'memory' ? assignments.extraction : undefined,
    purpose === 'memory' ? assignments.background : undefined,
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
  for (const key of REMOVED_RUNTIME_SETTINGS_KEYS) {
    delete (normalized as Record<string, unknown>)[key];
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

  const extractionThresholdPct = toIntegerInRange(
    settings.extractionThresholdPct,
    EXTRACTION_THRESHOLD_PCT_RANGE.min,
    EXTRACTION_THRESHOLD_PCT_RANGE.max,
  );
  if (extractionThresholdPct !== undefined) {
    normalized.extractionThresholdPct = extractionThresholdPct;
  } else {
    delete normalized.extractionThresholdPct;
  }

  const compactionThresholdPct = toIntegerInRange(
    settings.compactionThresholdPct,
    COMPACTION_THRESHOLD_PCT_RANGE.min,
    COMPACTION_THRESHOLD_PCT_RANGE.max,
  );
  if (compactionThresholdPct !== undefined) {
    normalized.compactionThresholdPct = compactionThresholdPct;
  } else {
    delete normalized.compactionThresholdPct;
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

  if ('openRouterModelsApiUrl' in settings) {
    normalized.openRouterModelsApiUrl = typeof settings.openRouterModelsApiUrl === 'string'
      ? settings.openRouterModelsApiUrl.trim()
      : '';
  }

  const profileSynthesisSourceMemoryLimit = toPositiveInteger(settings.profileSynthesisSourceMemoryLimit);
  const profileSynthesisMinSourceMemories = toPositiveInteger(settings.profileSynthesisMinSourceMemories);
  if (profileSynthesisMinSourceMemories !== undefined) {
    normalized.profileSynthesisMinSourceMemories = profileSynthesisMinSourceMemories;
  } else {
    delete normalized.profileSynthesisMinSourceMemories;
  }
  if (
    profileSynthesisSourceMemoryLimit !== undefined
    || profileSynthesisMinSourceMemories !== undefined
  ) {
    const effectiveSourceMemoryLimit = profileSynthesisSourceMemoryLimit !== undefined
      && profileSynthesisMinSourceMemories !== undefined
      ? Math.max(profileSynthesisSourceMemoryLimit, profileSynthesisMinSourceMemories)
      : profileSynthesisSourceMemoryLimit;
    if (effectiveSourceMemoryLimit !== undefined) {
      normalized.profileSynthesisSourceMemoryLimit = effectiveSourceMemoryLimit;
    } else {
      delete normalized.profileSynthesisSourceMemoryLimit;
    }
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

  if ('embeddingProvider' in settings) {
    const provider = toEmbeddingProvider(settings.embeddingProvider);
    if (provider) {
      normalized.embeddingProvider = provider;
    } else {
      delete normalized.embeddingProvider;
    }
  }

  if ('embeddingModel' in settings) {
    normalized.embeddingModel = typeof settings.embeddingModel === 'string'
      ? settings.embeddingModel.trim()
      : '';
  }

  if ('embeddingDims' in settings) {
    normalized.embeddingDims = toPositiveInteger(settings.embeddingDims);
  }

  if ('embeddingOllamaUrl' in settings) {
    normalized.embeddingOllamaUrl = typeof settings.embeddingOllamaUrl === 'string'
      ? settings.embeddingOllamaUrl.trim()
      : '';
  }

  if ('transformersModel' in settings) {
    normalized.transformersModel = typeof settings.transformersModel === 'string'
      ? settings.transformersModel.trim()
      : '';
  }

  if ('transformersCacheDir' in settings) {
    normalized.transformersCacheDir = typeof settings.transformersCacheDir === 'string'
      ? settings.transformersCacheDir.trim()
      : '';
  }

  if ('textEmotionModel' in settings) {
    const textEmotionModel = toNonEmptyString(settings.textEmotionModel);
    if (textEmotionModel === undefined) {
      throw new Error('textEmotionModel must be a non-empty string');
    }
    normalized.textEmotionModel = textEmotionModel;
  }

  if ('textEmotionCacheDir' in settings) {
    normalized.textEmotionCacheDir = typeof settings.textEmotionCacheDir === 'string'
      ? settings.textEmotionCacheDir.trim()
      : '';
  }

  if ('textEmotionDtype' in settings) {
    const textEmotionDtype = normalizeTextEmotionDtype(settings.textEmotionDtype);
    if (textEmotionDtype === undefined) {
      throw new Error(
        `textEmotionDtype must be one of: ${TEXT_EMOTION_DTYPE_VALUES.join(', ')}`,
      );
    }
    normalized.textEmotionDtype = textEmotionDtype;
  }

  if ('embeddingApiUrl' in settings) {
    normalized.embeddingApiUrl = typeof settings.embeddingApiUrl === 'string'
      ? settings.embeddingApiUrl.trim()
      : '';
  }

  if ('embeddingApiModel' in settings) {
    normalized.embeddingApiModel = typeof settings.embeddingApiModel === 'string'
      ? settings.embeddingApiModel.trim()
      : '';
  }

  if ('embeddingApiDims' in settings) {
    normalized.embeddingApiDims = toPositiveInteger(settings.embeddingApiDims);
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

  if ('comfyUiBaseUrl' in settings) {
    normalized.comfyUiBaseUrl = typeof settings.comfyUiBaseUrl === 'string'
      ? settings.comfyUiBaseUrl.trim()
      : '';
  }

  if ('imageWorkflows' in settings) {
    normalized.imageWorkflows = normalizeImageWorkflowSettings(settings.imageWorkflows);
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
  if ('deepgramSttEndpoint' in settings) {
    normalized.deepgramSttEndpoint =
      typeof settings.deepgramSttEndpoint === 'string' ? settings.deepgramSttEndpoint.trim() : '';
  }
  if ('deepgramListenEndpoint' in settings) {
    normalized.deepgramListenEndpoint =
      typeof settings.deepgramListenEndpoint === 'string' ? settings.deepgramListenEndpoint.trim() : '';
  }
  if ('elevenLabsModelId' in settings) {
    normalized.elevenLabsModelId =
      typeof settings.elevenLabsModelId === 'string' ? settings.elevenLabsModelId.trim() : '';
  }
  if ('elevenLabsEndpointBase' in settings) {
    normalized.elevenLabsEndpointBase =
      typeof settings.elevenLabsEndpointBase === 'string' ? settings.elevenLabsEndpointBase.trim() : '';
  }

  // Channels
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
