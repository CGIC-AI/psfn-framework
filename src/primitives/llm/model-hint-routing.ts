import type {
  LLMModelHint,
  ModelPurposeSelection,
  ModelRegistryEntry,
  ModelThinkingEffort,
} from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toFlooredPositiveInteger } from '../../shared/utils/numeric.js';
import { toFiniteNumber } from './client-response-helpers.js';
import { resolveCompletionTokenBudget } from './completion-budget.js';
import {
  findRegistryEntryByModelId,
  normalizeModelIdForProvider,
} from './model-budget.js';
import {
  applyGlobalPromptCachePolicy,
  resolveCandidateTuning,
  resolveGlobalPromptCachePolicy,
  resolveRoutingCandidateForRegistryEntry,
  resolveRoutingCandidates,
  type RoutingCandidate,
  type RoutingPurpose,
  VisionPurposeResolvedNonVisionModelError,
} from './routing.js';

const log = createComponentLogger('LLMClient');

export type LLMCompletionModelHint = LLMModelHint;

export interface ModelHintNormalizationOptions {
  emptyResult?: 'null' | 'undefined';
  preserveFalsePin?: boolean;
}

export const OPTIONAL_MODEL_HINT_NORMALIZATION = {
  emptyResult: 'undefined',
  preserveFalsePin: true,
} as const satisfies ModelHintNormalizationOptions;

export class LegacyModelHintError extends Error {
  readonly code = 'legacy_model_hint_unsupported';
  readonly modelHint: string;

  constructor(modelHint: string) {
    super(
      `Legacy slot-key model hints are unsupported: "${modelHint}". ` +
      'Use provider-qualified model id (provider:model) or provide model + provider explicitly.',
    );
    this.name = 'LegacyModelHintError';
    this.modelHint = modelHint;
  }
}

/**
 * 23pp: a per-companion model selection referenced a slot key that is not an
 * enabled models.json registry entry. Fail closed — the call is rejected with
 * the valid slot ids rather than silently substituting another model.
 */
export class UnknownModelSelectionSlotError extends Error {
  readonly code = 'unknown_model_selection_slot';
  readonly slotKey: string;

  constructor(slotKey: string, validSlotKeys: readonly string[]) {
    super(
      `Model selection slot "${slotKey}" is not an enabled models.json registry entry. `
      + `Valid slot keys: ${validSlotKeys.length > 0 ? validSlotKeys.join(', ') : '(none — models.json registry is empty)'}. `
      + 'Fix the modelPurposeSelection setting (settings.json or the companion settings.overlay.json) '
      + 'or add the model to the models.json registry.',
    );
    this.name = 'UnknownModelSelectionSlotError';
    this.slotKey = slotKey;
  }
}

/**
 * Resolve which selected slot key applies to a routing purpose. The `context`
 * routing lane has no direct selection key: it follows its purpose chain
 * (longContext, then background) so a companion's background/long-context
 * selection leads context work without leaking the chat selection into it.
 */
export function resolveModelSelectionSlotForPurpose(
  selection: ModelPurposeSelection | undefined,
  purpose: RoutingPurpose,
): string | undefined {
  if (!selection) return undefined;
  if (purpose === 'context') {
    return selection.longContext ?? selection.background;
  }
  return selection[purpose];
}

/**
 * Resolve a selection slot key to its enabled models.json registry entry.
 * Fail closed: unknown or disabled slot keys throw
 * {@link UnknownModelSelectionSlotError} with the valid ids.
 */
export function resolveEnabledRegistryEntryBySlotKey(
  config: SubstrateConfig,
  slotKey: string,
): ModelRegistryEntry {
  const registryModels = config.modelRegistry?.models ?? [];
  const entry = registryModels.find(
    (candidate) => candidate.enabled !== false && candidate.id === slotKey,
  );
  if (!entry) {
    throw new UnknownModelSelectionSlotError(
      slotKey,
      registryModels.filter((candidate) => candidate.enabled !== false).map((candidate) => candidate.id),
    );
  }
  return entry;
}

export function normalizeModelHint(
  modelHint: LLMCompletionModelHint | undefined,
): LLMCompletionModelHint | null;
export function normalizeModelHint(
  modelHint: LLMCompletionModelHint | undefined,
  options: ModelHintNormalizationOptions & { emptyResult: 'undefined' },
): LLMCompletionModelHint | undefined;
export function normalizeModelHint(
  modelHint: LLMCompletionModelHint | undefined,
  options: ModelHintNormalizationOptions = {},
): LLMCompletionModelHint | null | undefined {
  const emptyResult = options.emptyResult === 'undefined' ? undefined : null;
  if (!modelHint) return emptyResult;
  const rawModel = modelHint.model?.trim();
  const provider = modelHint.provider?.trim().toLowerCase();
  const slotKey = modelHint.slotKey?.trim();
  const maxTokens = toFlooredPositiveInteger(modelHint.maxTokens);
  const contextWindow = toFlooredPositiveInteger(modelHint.contextWindow);
  const thinkingEnabled = typeof modelHint.thinkingEnabled === 'boolean'
    ? modelHint.thinkingEnabled
    : undefined;
  const thinkingEffort = toThinkingEffort(modelHint.thinkingEffort);
  const temperature = toFiniteNumber(modelHint.temperature);
  const topP = toUnitInterval(modelHint.topP);
  const topK = toFlooredPositiveInteger(modelHint.topK);
  const frequencyPenalty = toFiniteNumber(modelHint.frequencyPenalty);
  const repetitionPenalty = toFiniteNumber(modelHint.repetitionPenalty);
  const pin = modelHint.pin === true || (options.preserveFalsePin && modelHint.pin === false)
    ? modelHint.pin
    : undefined;
  if (
    !rawModel
    && !provider
    && !slotKey
    && pin === undefined
    && maxTokens === undefined
    && contextWindow === undefined
    && thinkingEnabled === undefined
    && thinkingEffort === undefined
    && temperature === undefined
    && topP === undefined
    && topK === undefined
    && frequencyPenalty === undefined
    && repetitionPenalty === undefined
  ) {
    return emptyResult;
  }
  return {
    ...(rawModel ? { model: rawModel } : {}),
    ...(provider ? { provider } : {}),
    ...(slotKey ? { slotKey } : {}),
    ...(pin !== undefined ? { pin } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}),
    ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(frequencyPenalty !== undefined ? { frequencyPenalty } : {}),
    ...(repetitionPenalty !== undefined ? { repetitionPenalty } : {}),
  };
}

export function mergeModelHints(
  contextHint: LLMCompletionModelHint | undefined,
  optionHint: LLMCompletionModelHint | undefined,
): LLMCompletionModelHint | undefined {
  const normalizedContext = normalizeModelHint(contextHint);
  const normalizedOption = normalizeModelHint(optionHint);
  if (!normalizedContext && !normalizedOption) return undefined;
  return {
    ...(normalizedContext ?? {}),
    ...(normalizedOption ?? {}),
  };
}

function parseProviderQualifiedHint(value: string): { provider: string; model: string } | null {
  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0) return null;
  const provider = value.slice(0, separatorIndex).trim().toLowerCase();
  const model = value.slice(separatorIndex + 1).trim();
  if (!provider || !model || provider.includes('/')) return null;
  return { provider, model };
}

function withOpenRouterPreferences(
  config: SubstrateConfig,
  candidate: RoutingCandidate,
): RoutingCandidate {
  if (candidate.provider !== 'openrouter') return candidate;
  if (candidate.openRouterProviderOrder !== undefined) return candidate;
  const providerOrder = config.openRouterProviderOrder?.filter(Boolean) ?? [];
  if (providerOrder.length === 0) return candidate;
  return {
    ...candidate,
    openRouterProviderOrder: [...providerOrder],
  };
}

function candidateKey(candidate: RoutingCandidate): string {
  return [
    candidate.provider,
    candidate.model,
    String(candidate.maxTokens),
    String(candidate.contextWindow ?? ''),
    String(candidate.supportsVision ?? ''),
    String(candidate.supportsReasoning ?? ''),
    String(candidate.thinkingEnabled ?? ''),
    candidate.thinkingEffort ?? '',
    String(candidate.temperature ?? ''),
    String(candidate.topP ?? ''),
    String(candidate.topK ?? ''),
    String(candidate.frequencyPenalty ?? ''),
    String(candidate.repetitionPenalty ?? ''),
    candidate.promptCacheStrategy ?? '',
    candidate.promptCacheRetention ?? '',
    candidate.promptCacheScope ?? '',
    candidate.promptCacheEnabled ? 'cache_enabled' : '',
    candidate.requestBaseUrl ?? '',
    candidate.requestApiKeyEnv ?? '',
    candidate.openRouterZdrOnly ? 'zdr' : '',
    candidate.openRouterProviderOrder?.join(',') ?? '',
    candidate.importRouteMode ?? '',
  ].join('::');
}

function dedupeCandidates(candidates: RoutingCandidate[]): RoutingCandidate[] {
  const deduped: RoutingCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function resolveModelHintCandidate(
  config: SubstrateConfig,
  modelHint: LLMCompletionModelHint,
  fallbackCandidates: RoutingCandidate[],
  exactSelection?: {
    entry: ModelRegistryEntry;
    candidate: RoutingCandidate;
  },
): RoutingCandidate | null {
  const baseCandidate = exactSelection?.candidate ?? fallbackCandidates.at(0);
  if (baseCandidate === undefined) return null;
  const hintedModel = modelHint.model?.trim();
  const qualified = hintedModel ? parseProviderQualifiedHint(hintedModel) : null;

  let provider = modelHint.provider ?? qualified?.provider ?? baseCandidate.provider;
  let model = qualified?.model ?? hintedModel ?? baseCandidate.model;
  const registryEntry = exactSelection?.entry
    ?? findRegistryModelEntry(config, provider, model);
  // The hinted model's own catalog output cap beats the base candidate's:
  // inheriting a roster default above the target model's maximum is a guaranteed
  // 400 from the provider.
  const registryTuningMaxTokens = toFlooredPositiveInteger(
    registryEntry?.tuning?.maxOutputTokens,
  );
  const registryCapabilityMaxTokens = toFlooredPositiveInteger(
    registryEntry?.capabilities?.maxOutputTokens,
  );
  const registryContextWindow = toFlooredPositiveInteger(registryEntry?.tuning?.contextWindow)
    ?? toFlooredPositiveInteger(registryEntry?.capabilities?.contextWindow);
  const maxTokens = resolveCompletionTokenBudget({
    requestedMaxTokens: modelHint.maxTokens,
    configuredMaxOutputTokens: registryTuningMaxTokens,
    capabilityMaxOutputTokens: registryCapabilityMaxTokens,
    fallbackMaxTokens: baseCandidate.maxTokens,
  }) ?? config.primaryMaxTokens;
  const contextWindow = modelHint.contextWindow ?? registryContextWindow ?? baseCandidate.contextWindow;
  // Per-model tuning must come from the matched registry entry, not the lane's
  // primary base candidate: a provider+model hint otherwise inherits an
  // unrelated model's thinking/sampling knobs (conformance gap surfaced by the
  // same-runtime traffic-class harness). modelHint still wins; baseCandidate is
  // the final fallback for unregistered explicit overrides.
  const registryTuning = registryEntry ? resolveCandidateTuning(registryEntry) : {};
  const thinkingEnabled = modelHint.thinkingEnabled ?? registryTuning.thinkingEnabled ?? baseCandidate.thinkingEnabled;
  const thinkingEffort = modelHint.thinkingEffort ?? registryTuning.thinkingEffort ?? baseCandidate.thinkingEffort;
  const temperature = modelHint.temperature ?? registryTuning.temperature ?? baseCandidate.temperature;
  const topP = modelHint.topP ?? registryTuning.topP ?? baseCandidate.topP;
  const topK = modelHint.topK ?? registryTuning.topK ?? baseCandidate.topK;
  const frequencyPenalty = modelHint.frequencyPenalty ?? registryTuning.frequencyPenalty ?? baseCandidate.frequencyPenalty;
  const repetitionPenalty = modelHint.repetitionPenalty ?? registryTuning.repetitionPenalty ?? baseCandidate.repetitionPenalty;
  const hasExplicitIdentityHint = hintedModel !== undefined || modelHint.provider !== undefined;
  const supportsVision = typeof registryEntry?.capabilities?.supportsVision === 'boolean'
    ? registryEntry.capabilities.supportsVision
    : hasExplicitIdentityHint
      ? undefined
      : baseCandidate.supportsVision;
  const supportsReasoning = typeof registryEntry?.capabilities?.supportsReasoning === 'boolean'
    ? registryEntry.capabilities.supportsReasoning
    : baseCandidate.supportsReasoning;

  if (!provider || !model) return null;
  provider = provider.trim().toLowerCase();
  model = model.trim();
  if (!provider || !model) return null;

  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return null;

  const hinted: RoutingCandidate = {
    ...(baseCandidate.slotKey ? { slotKey: baseCandidate.slotKey } : {}),
    provider,
    model,
    maxTokens: Math.floor(maxTokens),
    // The hinted candidate must inherit the matched registry entry's wire API
    // kind: an explicit provider+model override otherwise silently dispatches
    // an openai-responses model through the openai-completions default
    // (conformance gap surfaced by the same-runtime traffic-class harness).
    ...(registryEntry?.apiKind
      ? { apiKind: registryEntry.apiKind }
      : (baseCandidate.apiKind ? { apiKind: baseCandidate.apiKind } : {})),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(supportsVision !== undefined ? { supportsVision } : {}),
    ...(supportsReasoning !== undefined ? { supportsReasoning } : {}),
    ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}),
    ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(frequencyPenalty !== undefined ? { frequencyPenalty } : {}),
    ...(repetitionPenalty !== undefined ? { repetitionPenalty } : {}),
  };

  if (baseCandidate.provider === provider) {
    if (baseCandidate.requestBaseUrl) hinted.requestBaseUrl = baseCandidate.requestBaseUrl;
    if (baseCandidate.requestApiKeyEnv) hinted.requestApiKeyEnv = baseCandidate.requestApiKeyEnv;
    if (baseCandidate.promptCacheStrategy) hinted.promptCacheStrategy = baseCandidate.promptCacheStrategy;
    if (baseCandidate.promptCacheRetention) hinted.promptCacheRetention = baseCandidate.promptCacheRetention;
    if (baseCandidate.promptCacheScope) hinted.promptCacheScope = baseCandidate.promptCacheScope;
    if (baseCandidate.openRouterZdrOnly) hinted.openRouterZdrOnly = true;
    if (baseCandidate.importRouteMode) hinted.importRouteMode = baseCandidate.importRouteMode;
  }

  // The registry-wide promptCaching policy is model-agnostic: hinted
  // candidates engage it exactly like roster-resolved candidates.
  return applyGlobalPromptCachePolicy(
    withOpenRouterPreferences(config, hinted),
    resolveGlobalPromptCachePolicy(config),
  );
}

function findRegistryModelEntry(
  config: SubstrateConfig,
  provider: string,
  model: string,
): ModelRegistryEntry | undefined {
  const registryModels = config.modelRegistry?.models ?? [];
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = normalizeModelIdForProvider(normalizedProvider, model);

  const directMatch = registryModels.find((entry) => (
    entry.identity.provider.trim().toLowerCase() === normalizedProvider
    && normalizeModelIdForProvider(entry.identity.provider, entry.identity.model) === normalizedModel
  ));
  if (directMatch) {
    return directMatch;
  }

  return findRegistryEntryByModelId(config, normalizedModel);
}

function modelHintTargetsRegistryEntry(
  modelHint: LLMCompletionModelHint,
  entry: ModelRegistryEntry,
): boolean {
  const hintedModel = modelHint.model?.trim();
  if (!hintedModel) return false;
  const qualified = parseProviderQualifiedHint(hintedModel);
  const provider = (modelHint.provider ?? qualified?.provider)?.trim().toLowerCase();
  const model = qualified?.model ?? hintedModel;
  const entryProvider = entry.identity.provider.trim().toLowerCase();
  return provider === entryProvider
    && normalizeModelIdForProvider(provider, model)
      === normalizeModelIdForProvider(entryProvider, entry.identity.model);
}

function ensureNonLegacyModelHint(
  config: SubstrateConfig,
  modelHint: LLMCompletionModelHint,
  fallbackCandidates: RoutingCandidate[],
): void {
  const hintedModel = modelHint.model?.trim();
  if (!hintedModel) return;
  if (modelHint.provider) return;
  if (parseProviderQualifiedHint(hintedModel)) return;

  const slotKeys = new Set<string>();
  for (const candidate of fallbackCandidates) {
    if (candidate.slotKey) slotKeys.add(candidate.slotKey);
  }
  for (const entry of config.modelRegistry?.models ?? []) {
    slotKeys.add(entry.id);
  }
  if (slotKeys.has(hintedModel)) {
    throw new LegacyModelHintError(hintedModel);
  }
}

export function resolveCandidates(
  config: SubstrateConfig,
  purpose: RoutingPurpose,
  modelHint: LLMCompletionModelHint | undefined,
): RoutingCandidate[] {
  const candidates = resolveRoutingCandidates(config, purpose);
  const normalizedHint = normalizeModelHint(modelHint);

  // 23pp per-companion model selection: an explicit hint slot key (transported
  // from the companion's agent) or this process's own configured selection
  // resolves fail-closed against the models.json registry. The selected model
  // LEADS the purpose's routing chain (transient-error fallbacks preserved);
  // explicit model/provider hint fields still take precedence.
  //
  // Multi-companion isolation (23pp remediation): a multi-companion gateway
  // serves MANY companions from ONE config, and whatever modelPurposeSelection
  // that config hydrated is one companion's character config — substituting it
  // for a sibling's un-slotted call would silently route the wrong model. In
  // multiCompanion mode the wire slotKey is therefore the ONLY selection
  // source; calls without one get registry-primary routing, byte-identical to
  // pre-selection behavior. Embedded/single-companion processes (config IS the
  // companion's) keep the config-level fallback.
  const configSelectionSlotKey = config.multiCompanion === true
    ? undefined
    : resolveModelSelectionSlotForPurpose(config.modelPurposeSelection, purpose);
  const selectionSlotKey = normalizedHint?.slotKey ?? configSelectionSlotKey;
  let effectiveHint = normalizedHint;
  let exactSelection: {
    entry: ModelRegistryEntry;
    candidate: RoutingCandidate;
  } | undefined;
  if (selectionSlotKey !== undefined) {
    const selectedEntry = resolveEnabledRegistryEntryBySlotKey(config, selectionSlotKey);
    const localImportRoute = purpose === 'import_processing'
      && config.importProcessingRouteMode === 'local_endpoint';
    if (localImportRoute) {
      // The local import endpoint/model are global infrastructure. Validate the
      // companion-supplied slot above, then remove only that selection hint so
      // it cannot redirect private imports to a remote registry provider.
      const { slotKey: _ignoredSelection, ...explicitHint } = effectiveHint ?? {};
      effectiveHint = normalizeModelHint(explicitHint);
    } else {
      let selectedCandidate = resolveRoutingCandidateForRegistryEntry(config, selectedEntry);
      if (!selectedCandidate) {
        throw new UnknownModelSelectionSlotError(
          selectionSlotKey,
          (config.modelRegistry?.models ?? [])
            .filter((entry) => resolveRoutingCandidateForRegistryEntry(config, entry) !== null)
            .map((entry) => entry.id),
        );
      }
      if (purpose === 'import_processing') {
        const importRouteMode = config.importProcessingRouteMode ?? 'background';
        selectedCandidate = {
          ...selectedCandidate,
          importRouteMode,
          ...(importRouteMode === 'openrouter_zdr' && selectedCandidate.provider === 'openrouter'
            ? { openRouterZdrOnly: true }
            : {}),
        };
      }
      if (!effectiveHint?.model) {
        exactSelection = {
          entry: selectedEntry,
          candidate: selectedCandidate,
        };
        effectiveHint = {
          ...(effectiveHint ?? {}),
          model: selectedEntry.identity.model,
          provider: selectedEntry.identity.provider.trim().toLowerCase(),
        };
      } else if (modelHintTargetsRegistryEntry(effectiveHint, selectedEntry)) {
        // The agent-side stream adapter pins the already-resolved model and
        // transports its slot identity. Preserve the exact slot so gateway
        // fallback logs and usage attribution name the companion selection.
        exactSelection = {
          entry: selectedEntry,
          candidate: selectedCandidate,
        };
      }
    }
  }

  if (!effectiveHint) return candidates;
  ensureNonLegacyModelHint(config, effectiveHint, candidates);

  const hintedCandidate = resolveModelHintCandidate(
    config,
    effectiveHint,
    candidates,
    exactSelection,
  );
  if (!hintedCandidate) return candidates;
  if (purpose === 'vision' && hintedCandidate.supportsVision !== true) {
    throw new VisionPurposeResolvedNonVisionModelError(hintedCandidate);
  }

  log.debug('Applying completion model hint', {
    purpose,
    requestedModel: effectiveHint.model ?? null,
    requestedProvider: effectiveHint.provider ?? null,
    selectionSlotKey: selectionSlotKey ?? null,
    pin: effectiveHint.pin ?? false,
    routedModel: hintedCandidate.model,
    routedProvider: hintedCandidate.provider,
  });

  if (effectiveHint.pin === true) {
    return [hintedCandidate];
  }

  return dedupeCandidates([hintedCandidate, ...candidates]);
}

function toUnitInterval(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric < 0 || numeric > 1) return undefined;
  return numeric;
}

function toThinkingEffort(value: unknown): ModelThinkingEffort | undefined {
  switch (value) {
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value;
    default:
      return undefined;
  }
}
