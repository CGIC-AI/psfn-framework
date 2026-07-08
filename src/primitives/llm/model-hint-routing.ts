import type {
  LLMModelHint,
  ModelRegistryEntry,
  ModelThinkingEffort,
} from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toFiniteNumber } from './client-response-helpers.js';
import {
  findRegistryEntryByModelId,
  normalizeModelIdForProvider,
} from './model-budget.js';
import {
  applyGlobalPromptCachePolicy,
  resolveGlobalPromptCachePolicy,
  resolveRoutingCandidates,
  type RoutingCandidate,
  type RoutingPurpose,
} from './routing.js';

const log = createComponentLogger('LLMClient');

export type LLMCompletionModelHint = LLMModelHint;

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

export function normalizeModelHint(
  modelHint: LLMCompletionModelHint | undefined,
): LLMCompletionModelHint | null {
  if (!modelHint) return null;
  const rawModel = modelHint.model?.trim();
  const provider = modelHint.provider?.trim().toLowerCase();
  const maxTokens = toPositiveInteger(modelHint.maxTokens);
  const contextWindow = toPositiveInteger(modelHint.contextWindow);
  const thinkingEnabled = typeof modelHint.thinkingEnabled === 'boolean'
    ? modelHint.thinkingEnabled
    : undefined;
  const thinkingEffort = toThinkingEffort(modelHint.thinkingEffort);
  const temperature = toFiniteNumber(modelHint.temperature);
  const topP = toUnitInterval(modelHint.topP);
  const topK = toPositiveInteger(modelHint.topK);
  const frequencyPenalty = toFiniteNumber(modelHint.frequencyPenalty);
  const repetitionPenalty = toFiniteNumber(modelHint.repetitionPenalty);
  const pin = modelHint.pin === true ? true : undefined;
  if (
    !rawModel
    && !provider
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
    return null;
  }
  return {
    ...(rawModel ? { model: rawModel } : {}),
    ...(provider ? { provider } : {}),
    ...(pin ? { pin } : {}),
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
): RoutingCandidate | null {
  const baseCandidate = fallbackCandidates.at(0);
  if (baseCandidate === undefined) return null;
  const hintedModel = modelHint.model?.trim();
  const qualified = hintedModel ? parseProviderQualifiedHint(hintedModel) : null;

  let provider = modelHint.provider ?? qualified?.provider ?? baseCandidate.provider;
  let model = qualified?.model ?? hintedModel ?? baseCandidate.model;
  const registryEntry = findRegistryModelEntry(config, provider, model);
  // The hinted model's own catalog output cap beats the base candidate's:
  // inheriting a roster default above the target model's maximum is a guaranteed
  // 400 from the provider.
  const registryMaxTokens = toPositiveInteger(registryEntry?.tuning?.maxOutputTokens)
    ?? toPositiveInteger(registryEntry?.capabilities?.maxOutputTokens);
  const registryContextWindow = toPositiveInteger(registryEntry?.tuning?.contextWindow)
    ?? toPositiveInteger(registryEntry?.capabilities?.contextWindow);
  let maxTokens = modelHint.maxTokens ?? registryMaxTokens ?? baseCandidate.maxTokens;
  const contextWindow = modelHint.contextWindow ?? registryContextWindow ?? baseCandidate.contextWindow;
  const thinkingEnabled = modelHint.thinkingEnabled ?? baseCandidate.thinkingEnabled;
  const thinkingEffort = modelHint.thinkingEffort ?? baseCandidate.thinkingEffort;
  const temperature = modelHint.temperature ?? baseCandidate.temperature;
  const topP = modelHint.topP ?? baseCandidate.topP;
  const topK = modelHint.topK ?? baseCandidate.topK;
  const frequencyPenalty = modelHint.frequencyPenalty ?? baseCandidate.frequencyPenalty;
  const repetitionPenalty = modelHint.repetitionPenalty ?? baseCandidate.repetitionPenalty;
  const supportsVision = typeof registryEntry?.capabilities?.supportsVision === 'boolean'
    ? registryEntry.capabilities.supportsVision
    : baseCandidate.supportsVision;
  const supportsReasoning = typeof registryEntry?.capabilities?.supportsReasoning === 'boolean'
    ? registryEntry.capabilities.supportsReasoning
    : baseCandidate.supportsReasoning;

  if (!provider || !model) return null;
  provider = provider.trim().toLowerCase();
  model = model.trim();
  if (!provider || !model) return null;

  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    maxTokens = config.primaryMaxTokens;
  }
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return null;

  const hinted: RoutingCandidate = {
    provider,
    model,
    maxTokens: Math.floor(maxTokens),
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
  if (!normalizedHint) return candidates;
  ensureNonLegacyModelHint(config, normalizedHint, candidates);

  const hintedCandidate = resolveModelHintCandidate(config, normalizedHint, candidates);
  if (!hintedCandidate) return candidates;

  log.debug('Applying completion model hint', {
    purpose,
    requestedModel: normalizedHint.model ?? null,
    requestedProvider: normalizedHint.provider ?? null,
    pin: normalizedHint.pin ?? false,
    routedModel: hintedCandidate.model,
    routedProvider: hintedCandidate.provider,
  });

  if (normalizedHint.pin === true) {
    return [hintedCandidate];
  }

  return dedupeCandidates([hintedCandidate, ...candidates]);
}

function toPositiveInteger(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric <= 0) return undefined;
  return Math.floor(numeric);
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
