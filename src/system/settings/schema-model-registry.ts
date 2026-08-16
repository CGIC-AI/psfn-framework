import {
  CANONICAL_MODEL_PURPOSES,
  type CanonicalModelRegistry,
  type CanonicalModelPurpose,
  type ModelRegistryBudgetPolicy,
  type ModelRegistryEntry,
  type ModelApiKind,
  type ModelRegistryRoutingMetadata,
  type ModelRegistryPromptCachingPolicy,
  type PromptCacheRetention,
  type PromptCacheScope,
  type ModelCatalogEntry,
  type ModelContextBudgetConfig,
  type ModelRouteConfig,
  type ModelPurpose,
  type ModelRoleAssignments,
  type ModelSlot,
  type ModelSlotDefaults,
  type ModelSlotOverrides,
} from '../../shared/contracts/runtime.js';
import { nonEmptyStringOrUndefined } from '../../shared/utils/strings.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  toBoolean,
  toIntegerInRange,
  toPositiveInteger,
  toPositiveNumber,
  toStrictIntegerInRange,
  toStrictNumberInRange,
  toStringList,
} from './coercion.js';
import {
  EXTRACTION_MODEL_SLOT_KEY,
  KNOWN_MODEL_PURPOSES,
  MODEL_SLOT_KEY_PATTERN,
  PRIMARY_MODEL_SLOT_KEY,
  type EditableSettings,
} from './contracts.js';

const CANONICAL_MODEL_PURPOSE_SET = new Set<CanonicalModelPurpose>(CANONICAL_MODEL_PURPOSES);
const MODEL_API_KINDS = new Set<ModelApiKind>(['openai-completions', 'openai-responses']);
const MODEL_REGISTRY_THINKING_EFFORT_VALUES = new Set([
  'none',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
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
  const purposeRaw = nonEmptyStringOrUndefined(value.purpose);
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

  const accountingStartMs = value.accountingStartMs === undefined
    ? undefined
    : toStrictIntegerInRange(value.accountingStartMs, 0, Number.MAX_SAFE_INTEGER);
  if (value.accountingStartMs !== undefined && accountingStartMs === undefined) {
    throw new Error(
      `Invalid model registry at ${fieldPath}.accountingStartMs: expected non-negative safe integer`,
    );
  }

  const currencyRaw = nonEmptyStringOrUndefined(value.currency);
  if (currencyRaw && currencyRaw.toUpperCase() !== 'USD') {
    throw new Error(`Invalid model registry at ${fieldPath}.currency: only "USD" is supported`);
  }

  return {
    enabled,
    dailyUsdLimit,
    monthlyUsdLimit,
    ...(accountingStartMs !== undefined ? { accountingStartMs } : {}),
    currency: 'USD',
  };
}

const MODEL_REGISTRY_PROMPT_CACHE_RETENTIONS = new Set<PromptCacheRetention>(['none', 'short', 'long']);
const MODEL_REGISTRY_PROMPT_CACHE_SCOPES = new Set<PromptCacheScope>(['channel', 'request']);

/**
 * Registry-wide provider prompt-caching policy (E2.4). Fail-closed: `enabled`
 * must be an explicit boolean, and retention/scope must be canonical values
 * when present. When the key is absent entirely the registry defaults to
 * enabled — see `defaultModelRegistryPromptCachingPolicy`.
 */
function normalizeModelRegistryPromptCachingPolicy(
  value: unknown,
  fieldPath: string,
): ModelRegistryPromptCachingPolicy {
  if (!isRecord(value)) {
    throw new Error(`Invalid model registry at ${fieldPath}: expected object`);
  }

  const enabled = toBoolean(value.enabled);
  if (enabled === undefined) {
    throw new Error(`Invalid model registry at ${fieldPath}.enabled: expected boolean`);
  }

  let retention: PromptCacheRetention | undefined;
  if (value.retention !== undefined) {
    const retentionRaw = nonEmptyStringOrUndefined(value.retention)?.toLowerCase();
    if (!retentionRaw || !MODEL_REGISTRY_PROMPT_CACHE_RETENTIONS.has(retentionRaw as PromptCacheRetention)) {
      throw new Error(
        `Invalid model registry at ${fieldPath}.retention: expected one of ${[...MODEL_REGISTRY_PROMPT_CACHE_RETENTIONS].join(', ')}`,
      );
    }
    retention = retentionRaw as PromptCacheRetention;
  }

  let scope: PromptCacheScope | undefined;
  if (value.scope !== undefined) {
    const scopeRaw = nonEmptyStringOrUndefined(value.scope)?.toLowerCase();
    if (!scopeRaw || !MODEL_REGISTRY_PROMPT_CACHE_SCOPES.has(scopeRaw as PromptCacheScope)) {
      throw new Error(
        `Invalid model registry at ${fieldPath}.scope: expected one of ${[...MODEL_REGISTRY_PROMPT_CACHE_SCOPES].join(', ')}`,
      );
    }
    scope = scopeRaw as PromptCacheScope;
  }

  return {
    enabled,
    ...(retention ? { retention } : {}),
    ...(scope ? { scope } : {}),
  };
}

/**
 * Compatibility default for a registry with no `promptCaching` key at all.
 *
 * Prompt caching shipped after models.json was already deployed, and the seed
 * (`config/models.seed.json`, `promptCaching.enabled: true`) only reaches fresh
 * installs — an existing owner file is never rewritten by it. Treating absence
 * as "off" therefore stranded every already-deployed companion uncached until
 * someone hand-edited the file, so absence now means enabled.
 *
 * Only absence defaults: an explicit `{ "enabled": false }` still disables
 * caching, because an operator's recorded choice always beats a default.
 *
 * `retention`/`scope` are deliberately left unset so the routing defaults
 * (`short`/`channel` in `resolveGlobalPromptCachePolicy`) stay the single
 * source of truth for lifetime and session keying — and so the default can
 * never land on retention `none`, which the turn path reports as `disabled`.
 */
function defaultModelRegistryPromptCachingPolicy(): ModelRegistryPromptCachingPolicy {
  return { enabled: true };
}

function normalizeModelRegistryEntry(value: unknown, fieldPath: string): ModelRegistryEntry {
  if (!isRecord(value)) {
    throw new Error(`Invalid model registry at ${fieldPath}: expected object`);
  }

  const id = nonEmptyStringOrUndefined(value.id);
  if (!id || !MODEL_SLOT_KEY_PATTERN.test(id)) {
    throw new Error(`Invalid model registry at ${fieldPath}.id: expected non-empty key-safe string`);
  }

  const rank = toIntegerInRange(value.rank, 0, Number.MAX_SAFE_INTEGER);
  if (rank === undefined) {
    throw new Error(`Invalid model registry at ${fieldPath}.rank: expected non-negative integer`);
  }
  const enabled = value.enabled === undefined ? undefined : toBoolean(value.enabled);
  if (value.enabled !== undefined && enabled === undefined) {
    throw new Error(`Invalid model registry at ${fieldPath}.enabled: expected boolean`);
  }

  let apiKind: ModelApiKind | undefined;
  if (value.apiKind !== undefined) {
    if (typeof value.apiKind !== 'string' || !MODEL_API_KINDS.has(value.apiKind as ModelApiKind)) {
      throw new Error(
        `Invalid model registry at ${fieldPath}.apiKind: expected one of ${[...MODEL_API_KINDS].join(', ')}`,
      );
    }
    apiKind = value.apiKind as ModelApiKind;
  }

  if (!isRecord(value.identity)) {
    throw new Error(`Invalid model registry at ${fieldPath}.identity: expected object`);
  }
  const provider = nonEmptyStringOrUndefined(value.identity.provider);
  const model = nonEmptyStringOrUndefined(value.identity.model);
  if (!provider || !model) {
    throw new Error(`Invalid model registry at ${fieldPath}.identity: provider and model are required`);
  }
  if (!isRecord(value.identity.source)) {
    throw new Error(`Invalid model registry at ${fieldPath}.identity.source: expected object`);
  }
  const sourceType = nonEmptyStringOrUndefined(value.identity.source.type);
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

  if (value.capabilities !== undefined && !isRecord(value.capabilities)) {
    throw new Error(`Invalid model registry at ${fieldPath}.capabilities: expected object`);
  }
  const capabilities = isRecord(value.capabilities) ? { ...value.capabilities } : undefined;
  const tuning = isRecord(value.tuning)
    ? normalizeModelRegistryTuning({ ...value.tuning }, `${fieldPath}.tuning`)
    : undefined;
  const cost = isRecord(value.cost) ? { ...value.cost } : undefined;
  const metadata = isRecord(value.metadata) ? { ...value.metadata } : undefined;
  let routing: ModelRegistryRoutingMetadata | undefined;
  if (value.routing !== undefined) {
    if (!isRecord(value.routing)) {
      throw new Error(`Invalid model registry at ${fieldPath}.routing: expected object`);
    }
    const providerOrder = value.routing.providerOrder === undefined
      ? undefined
      : toStringList(value.routing.providerOrder);
    if (
      value.routing.providerOrder !== undefined
      && (
        !providerOrder
        || providerOrder.length === 0
        || !Array.isArray(value.routing.providerOrder)
        || providerOrder.length !== value.routing.providerOrder.length
      )
    ) {
      throw new Error(`Invalid model registry at ${fieldPath}.routing.providerOrder: expected non-empty strings`);
    }
    const zdrOnly = value.routing.zdrOnly === undefined ? undefined : toBoolean(value.routing.zdrOnly);
    if (value.routing.zdrOnly !== undefined && zdrOnly === undefined) {
      throw new Error(`Invalid model registry at ${fieldPath}.routing.zdrOnly: expected boolean`);
    }
    routing = {
      ...(providerOrder ? { providerOrder } : {}),
      ...(zdrOnly !== undefined ? { zdrOnly } : {}),
    };
  }

  const capabilityMaxTokens = toPositiveInteger(capabilities?.maxOutputTokens);
  const tuningMaxTokens = toPositiveInteger(tuning?.maxOutputTokens);
  const maxOutputTokens = tuningMaxTokens ?? capabilityMaxTokens;
  if (maxOutputTokens === undefined) {
    throw new Error(`Invalid model registry at ${fieldPath}: maxOutputTokens must be set in capabilities or tuning`);
  }

  if (capabilities?.maxOutputTokens !== undefined && capabilityMaxTokens === undefined) {
    throw new Error(`Invalid model registry at ${fieldPath}.capabilities.maxOutputTokens: expected positive integer`);
  }

  const capabilityContextWindow = toPositiveInteger(capabilities?.contextWindow);
  const tuningContextWindow = toPositiveInteger(tuning?.contextWindow);
  if (capabilities && capabilityContextWindow !== undefined) {
    capabilities.contextWindow = capabilityContextWindow;
  }
  if (capabilities?.contextWindow !== undefined && capabilityContextWindow === undefined) {
    throw new Error(`Invalid model registry at ${fieldPath}.capabilities.contextWindow: expected positive integer`);
  }
  for (const capability of ['supportsVision', 'supportsReasoning', 'supportsPromptCaching'] as const) {
    if (capabilities?.[capability] !== undefined && typeof capabilities[capability] !== 'boolean') {
      throw new Error(`Invalid model registry at ${fieldPath}.capabilities.${capability}: expected boolean`);
    }
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
    ...(enabled === false ? { enabled: false } : {}),
    rank,
    ...(apiKind ? { apiKind } : {}),
    identity: {
      provider,
      model,
      source: {
        type: sourceType,
        ...(nonEmptyStringOrUndefined(value.identity.source.label)
          ? { label: nonEmptyStringOrUndefined(value.identity.source.label) }
          : {}),
        ...(nonEmptyStringOrUndefined(value.identity.source.baseUrl)
          ? { baseUrl: nonEmptyStringOrUndefined(value.identity.source.baseUrl) }
          : {}),
        ...(isRecord(value.identity.source.metadata)
          ? { metadata: { ...value.identity.source.metadata } }
          : {}),
      },
      ...(nonEmptyStringOrUndefined(value.identity.family)
        ? { family: nonEmptyStringOrUndefined(value.identity.family) }
        : {}),
    },
    purposes,
    ...(capabilities ? { capabilities } : {}),
    ...(tuning ? { tuning } : {}),
    ...(routing ? { routing } : {}),
    ...(cost ? { cost } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function hasCompleteUsdCostMetadata(entry: ModelRegistryEntry): boolean {
  const cost = entry.cost;
  if (!cost) return false;
  const isRate = (value: unknown): boolean => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  );
  const currency = typeof cost.currency === 'string'
    ? cost.currency.trim().toUpperCase()
    : 'USD';
  return currency === 'USD'
    && isRate(cost.inputPer1MUsd)
    && isRate(cost.outputPer1MUsd)
    && isRate(cost.cacheReadPer1MUsd)
    && isRate(cost.cacheWritePer1MUsd);
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
  const promptCaching = value.promptCaching !== undefined
    ? normalizeModelRegistryPromptCachingPolicy(value.promptCaching, `${sourcePath}.promptCaching`)
    : defaultModelRegistryPromptCachingPolicy();

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

  if (budgetPolicy?.enabled) {
    const incompleteModel = models.find(model => (
      model.enabled !== false && !hasCompleteUsdCostMetadata(model)
    ));
    if (incompleteModel) {
      throw new Error(
        `Invalid model registry at ${sourcePath}: budgetPolicy.enabled requires complete USD cost rates `
        + `(inputPer1MUsd, outputPer1MUsd, cacheReadPer1MUsd, cacheWritePer1MUsd) for enabled model "${incompleteModel.id}"`,
      );
    }
  }

  const primaryPurposeCounts = new Map<CanonicalModelPurpose, number>(
    CANONICAL_MODEL_PURPOSES.map((purpose) => [purpose, 0]),
  );
  for (const model of models) {
    if (model.enabled === false) continue;
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
    // Always present: absent input is defaulted above, so the normalized
    // registry states the effective caching policy rather than implying it.
    promptCaching,
  };
}

function backfillPrimaryMemoryPurpose(models: ModelRegistryEntry[]): void {
  if (models.some((entry) => entry.enabled !== false && entry.purposes.some((tag) => tag.purpose === 'memory' && tag.primary))) {
    return;
  }

  // Compatibility migration: before the dedicated memory route existed, extraction/background
  // carried this workload. Preserve loadability by projecting memory onto that primary model.
  const target = models.find((entry) => entry.enabled !== false && entry.purposes.some((tag) => tag.purpose === 'extraction' && tag.primary))
    ?? models.find((entry) => entry.enabled !== false && entry.purposes.some((tag) => tag.purpose === 'background' && tag.primary));
  if (!target) return;

  const existingMemoryIndex = target.purposes.findIndex((tag) => tag.purpose === 'memory');
  if (existingMemoryIndex >= 0) {
    const existing = target.purposes[existingMemoryIndex];
    if (existing) {
      target.purposes[existingMemoryIndex] = { ...existing, primary: true };
    }
    return;
  }

  target.purposes.push({ purpose: 'memory', primary: true });
}

function resolvePrimaryModelIdsByPurpose(registry: CanonicalModelRegistry): Record<CanonicalModelPurpose, string> {
  const primaryByPurpose = {} as Record<CanonicalModelPurpose, string>;
  for (const model of registry.models) {
    if (model.enabled === false) continue;
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

export function projectCanonicalModelRegistry(
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
  assignments.context = primaryByPurpose.background;

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
  const description = nonEmptyStringOrUndefined(value.description);
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

    let model = nonEmptyStringOrUndefined(rawEntry.model);
    let provider = nonEmptyStringOrUndefined(rawEntry.provider);

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
    const slotKey = nonEmptyStringOrUndefined(rawSlotKey);
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

    const model = nonEmptyStringOrUndefined(candidate.model);
    const provider = nonEmptyStringOrUndefined(candidate.provider);
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
  const model = nonEmptyStringOrUndefined(slot.model);
  const provider = nonEmptyStringOrUndefined(slot.provider);
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
