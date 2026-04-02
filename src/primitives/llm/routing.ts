import type {
  CanonicalModelPurpose,
  ImportProcessingRouteMode,
  ModelRegistryCostMetadata,
  ModelRegistryEntry,
  ModelRegistryPurposeTag,
  ModelThinkingEffort,
  PromptCacheRetention,
  PromptCacheScope,
  PromptCacheStrategy,
} from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';

export type RoutingPurpose = CanonicalModelPurpose | 'context';
export type ImportPolicyRejectionReason = 'strict_requires_openrouter_zdr';

export interface RoutingCandidate {
  model: string;
  provider: string;
  maxTokens: number;
  contextWindow?: number;
  thinkingEnabled?: boolean;
  thinkingEffort?: ModelThinkingEffort;
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  repetitionPenalty?: number;
  promptCacheStrategy?: PromptCacheStrategy;
  promptCacheRetention?: PromptCacheRetention;
  promptCacheScope?: PromptCacheScope;
  slotKey?: string;
  requestBaseUrl?: string;
  requestApiKeyEnv?: string;
  openRouterProviderOrder?: string[];
  openRouterZdrOnly?: boolean;
  importRouteMode?: ImportProcessingRouteMode;
}

export interface ImportPolicyAuditRecord {
  purpose: RoutingPurpose;
  strictPolicyEnabled: boolean;
  configuredRouteMode: ImportProcessingRouteMode;
  selectedRouteMode: ImportProcessingRouteMode;
  provider: string;
  model: string;
  openRouterZdrOnly: boolean;
  requestBaseUrl?: string;
}

export interface ImportPolicyEvaluation {
  allowed: boolean;
  reason?: ImportPolicyRejectionReason;
  audit: ImportPolicyAuditRecord;
}

interface SelectorCandidate {
  candidate: RoutingCandidate;
  primary: boolean;
  rank: number;
  maxTokens: number;
  contextWindow: number;
  estimatedCost: number | null;
}

interface ScoredSelectorCandidate extends SelectorCandidate {
  capabilityScore: number;
  costScore: number;
}

function uniquePush(
  target: RoutingCandidate[],
  candidate: RoutingCandidate | undefined,
  seen: Set<string>,
): void {
  if (!candidate) return;
  const key = [
    candidate.provider,
    candidate.model,
    String(candidate.maxTokens),
    String(candidate.contextWindow ?? ''),
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
    candidate.requestBaseUrl ?? '',
    candidate.requestApiKeyEnv ?? '',
    candidate.openRouterZdrOnly ? 'zdr' : '',
    candidate.openRouterProviderOrder?.join(',') ?? '',
    candidate.importRouteMode ?? '',
  ].join('::');

  if (seen.has(key)) return;
  seen.add(key);
  target.push(candidate);
}

function toPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function toUnitInterval(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric < 0 || numeric > 1) return undefined;
  return numeric;
}

function toPositiveInteger(value: unknown): number | undefined {
  const numeric = toPositiveNumber(value);
  if (numeric === undefined) return undefined;
  return Math.floor(numeric);
}

function resolveThinkingEffort(value: unknown): ModelThinkingEffort | undefined {
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

const PROMPT_CACHE_STRATEGIES: ReadonlySet<PromptCacheStrategy> = new Set(['openai_responses']);
const PROMPT_CACHE_RETENTIONS: ReadonlySet<PromptCacheRetention> = new Set(['none', 'short', 'long']);
const PROMPT_CACHE_SCOPES: ReadonlySet<PromptCacheScope> = new Set(['channel', 'request']);

function resolvePromptCacheStrategy(value: unknown, fieldPath: string): PromptCacheStrategy | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Invalid model registry model "${fieldPath}": promptCacheStrategy must be a string`);
  }
  const normalized = value.trim().toLowerCase();
  if (!PROMPT_CACHE_STRATEGIES.has(normalized as PromptCacheStrategy)) {
    throw new Error(`Invalid model registry model "${fieldPath}": promptCacheStrategy must be one of ${[...PROMPT_CACHE_STRATEGIES].join(', ')}`);
  }
  return normalized as PromptCacheStrategy;
}

function resolvePromptCacheRetention(value: unknown, fieldPath: string): PromptCacheRetention | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Invalid model registry model "${fieldPath}": promptCacheRetention must be a string`);
  }
  const normalized = value.trim().toLowerCase();
  if (!PROMPT_CACHE_RETENTIONS.has(normalized as PromptCacheRetention)) {
    throw new Error(`Invalid model registry model "${fieldPath}": promptCacheRetention must be one of ${[...PROMPT_CACHE_RETENTIONS].join(', ')}`);
  }
  return normalized as PromptCacheRetention;
}

function resolvePromptCacheScope(value: unknown, fieldPath: string): PromptCacheScope | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Invalid model registry model "${fieldPath}": promptCacheScope must be a string`);
  }
  const normalized = value.trim().toLowerCase();
  if (!PROMPT_CACHE_SCOPES.has(normalized as PromptCacheScope)) {
    throw new Error(`Invalid model registry model "${fieldPath}": promptCacheScope must be one of ${[...PROMPT_CACHE_SCOPES].join(', ')}`);
  }
  return normalized as PromptCacheScope;
}

function resolvePromptCacheConfig(entry: ModelRegistryEntry): Pick<
  RoutingCandidate,
  'promptCacheStrategy' | 'promptCacheRetention' | 'promptCacheScope'
> {
  const capabilities = entry.capabilities;
  const tuning = entry.tuning;
  const fieldPath = entry.id;
  const supportsPromptCachingRaw = capabilities?.supportsPromptCaching;
  if (supportsPromptCachingRaw !== undefined && typeof supportsPromptCachingRaw !== 'boolean') {
    throw new Error(`Invalid model registry model "${fieldPath}": supportsPromptCaching must be a boolean`);
  }

  const promptCacheStrategy = resolvePromptCacheStrategy(capabilities?.promptCacheStrategy, fieldPath);
  const promptCacheRetention = resolvePromptCacheRetention(tuning?.promptCacheRetention, fieldPath);
  const promptCacheScope = resolvePromptCacheScope(tuning?.promptCacheScope, fieldPath);

  if (supportsPromptCachingRaw === true) {
    if (!promptCacheStrategy) {
      throw new Error(`Invalid model registry model "${fieldPath}": promptCacheStrategy is required when supportsPromptCaching is true`);
    }
    return {
      promptCacheStrategy,
      promptCacheRetention: promptCacheRetention ?? 'short',
      promptCacheScope: promptCacheScope ?? 'channel',
    };
  }

  if (supportsPromptCachingRaw === false) {
    if (promptCacheStrategy || promptCacheRetention || promptCacheScope) {
      throw new Error(`Invalid model registry model "${fieldPath}": prompt cache tuning requires supportsPromptCaching to be true`);
    }
    return {};
  }

  if (promptCacheStrategy || promptCacheRetention || promptCacheScope) {
    throw new Error(`Invalid model registry model "${fieldPath}": prompt cache tuning requires supportsPromptCaching to be set`);
  }

  return {};
}

function resolveCandidateTuning(entry: ModelRegistryEntry): Pick<
  RoutingCandidate,
  'thinkingEnabled'
  | 'thinkingEffort'
  | 'temperature'
  | 'topP'
  | 'topK'
  | 'frequencyPenalty'
  | 'repetitionPenalty'
  | 'promptCacheStrategy'
  | 'promptCacheRetention'
  | 'promptCacheScope'
> {
  const tuning = entry.tuning;
  const promptCaching = resolvePromptCacheConfig(entry);
  if (!tuning) return promptCaching;
  const thinkingEnabled = typeof tuning.thinkingEnabled === 'boolean'
    ? tuning.thinkingEnabled
    : undefined;
  const thinkingEffort = resolveThinkingEffort(tuning.thinkingEffort);
  const temperature = toFiniteNumber(tuning.temperature);
  const topP = toUnitInterval(tuning.topP);
  const topK = toPositiveInteger(tuning.topK);
  const frequencyPenalty = toFiniteNumber(tuning.frequencyPenalty);
  const repetitionPenalty = toFiniteNumber(tuning.repetitionPenalty);

  return {
    ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}),
    ...(thinkingEffort ? { thinkingEffort } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(frequencyPenalty !== undefined ? { frequencyPenalty } : {}),
    ...(repetitionPenalty !== undefined ? { repetitionPenalty } : {}),
    ...promptCaching,
  };
}

function resolveMaxTokens(entry: ModelRegistryEntry): number | undefined {
  return toPositiveNumber(entry.tuning?.maxOutputTokens)
    ?? toPositiveNumber(entry.tuning?.maxTokens)
    ?? toPositiveNumber(entry.capabilities?.maxOutputTokens);
}

function resolveContextWindow(entry: ModelRegistryEntry, defaultContextWindow: number): number | undefined {
  return toPositiveNumber(entry.tuning?.contextWindow)
    ?? toPositiveNumber(entry.capabilities?.contextWindow)
    ?? toPositiveNumber(defaultContextWindow);
}

function resolvePurposeTag(
  entry: ModelRegistryEntry,
  purpose: CanonicalModelPurpose,
): ModelRegistryPurposeTag | undefined {
  return entry.purposes.find(tag => tag.purpose === purpose);
}

function estimateCost(cost: ModelRegistryCostMetadata | undefined): number | null {
  const inputCost = toPositiveNumber(cost?.inputPer1MUsd);
  const outputCost = toPositiveNumber(cost?.outputPer1MUsd);
  if (inputCost === undefined && outputCost === undefined) return null;
  const normalizedInput = inputCost ?? outputCost ?? 0;
  const normalizedOutput = outputCost ?? inputCost ?? 0;
  return normalizedInput + normalizedOutput;
}

function candidateFromRegistryEntry(
  config: SubstrateConfig,
  entry: ModelRegistryEntry,
  purpose: CanonicalModelPurpose,
): SelectorCandidate | null {
  const purposeTag = resolvePurposeTag(entry, purpose);
  if (!purposeTag) return null;

  const provider = entry.identity.provider.trim().toLowerCase();
  const model = entry.identity.model.trim();
  if (!provider || !model) return null;

  const maxTokens = resolveMaxTokens(entry);
  if (maxTokens === undefined) return null;

  const contextWindow = resolveContextWindow(entry, config.defaultContextWindow) ?? 0;
  const tuning = resolveCandidateTuning(entry);
  return {
    candidate: withOpenRouterPreferences({
      slotKey: entry.id,
      provider,
      model,
      maxTokens,
      ...(contextWindow > 0 ? { contextWindow } : {}),
      ...tuning,
    }, config),
    primary: purposeTag.primary === true,
    rank: Number.isFinite(entry.rank) ? Math.floor(entry.rank) : Number.MAX_SAFE_INTEGER,
    maxTokens,
    contextWindow,
    estimatedCost: estimateCost(entry.cost),
  };
}

function resolveCanonicalPurposeChain(purpose: RoutingPurpose): CanonicalModelPurpose[] {
  if (purpose === 'context') {
    return ['longContext', 'background', 'chat'];
  }
  return [purpose];
}

function capabilityWeightsForPurpose(
  purpose: CanonicalModelPurpose,
): { contextWindow: number; maxTokens: number } {
  if (purpose === 'longContext') {
    return { contextWindow: 0.8, maxTokens: 0.2 };
  }
  if (purpose === 'background' || purpose === 'memory' || purpose === 'extraction' || purpose === 'import_processing') {
    return { contextWindow: 0.35, maxTokens: 0.65 };
  }
  return { contextWindow: 0.5, maxTokens: 0.5 };
}

function scoreCandidates(
  purpose: CanonicalModelPurpose,
  candidates: SelectorCandidate[],
): ScoredSelectorCandidate[] {
  if (candidates.length === 0) return [];

  const capabilityWeights = capabilityWeightsForPurpose(purpose);
  const maxContextWindow = Math.max(...candidates.map(candidate => candidate.contextWindow));
  const maxTokens = Math.max(...candidates.map(candidate => candidate.maxTokens));

  const explicitCosts = candidates
    .map(candidate => candidate.estimatedCost)
    .filter((value): value is number => value !== null);

  const syntheticMissingCost = explicitCosts.length > 0
    ? Math.max(...explicitCosts) * 1.5
    : 1;

  const resolvedCosts = candidates.map((candidate) => candidate.estimatedCost ?? syntheticMissingCost);
  const minCost = Math.min(...resolvedCosts);
  const maxCost = Math.max(...resolvedCosts);

  return candidates.map((candidate, index) => {
    const normalizedContextWindow = maxContextWindow > 0
      ? candidate.contextWindow / maxContextWindow
      : 0;
    const normalizedMaxTokens = maxTokens > 0
      ? candidate.maxTokens / maxTokens
      : 0;
    const capabilityScore = (normalizedContextWindow * capabilityWeights.contextWindow)
      + (normalizedMaxTokens * capabilityWeights.maxTokens);

    const costValue = resolvedCosts[index];
    const costScore = maxCost > minCost
      ? (maxCost - costValue) / (maxCost - minCost)
      : 1;

    return {
      ...candidate,
      capabilityScore,
      costScore,
    };
  });
}

function compareScoredCandidates(a: ScoredSelectorCandidate, b: ScoredSelectorCandidate): number {
  if (a.primary !== b.primary) {
    return a.primary ? -1 : 1;
  }

  if (a.rank !== b.rank) {
    // Lower rank means higher operator preference.
    return a.rank - b.rank;
  }

  if (a.capabilityScore !== b.capabilityScore) {
    return b.capabilityScore - a.capabilityScore;
  }

  if (a.costScore !== b.costScore) {
    return b.costScore - a.costScore;
  }

  const aKey = [
    a.candidate.slotKey ?? '',
    a.candidate.provider,
    a.candidate.model,
  ].join('::');
  const bKey = [
    b.candidate.slotKey ?? '',
    b.candidate.provider,
    b.candidate.model,
  ].join('::');
  return aKey.localeCompare(bKey);
}

function withOpenRouterPreferences(
  candidate: RoutingCandidate,
  config: SubstrateConfig,
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

function selectCandidatesForPurpose(
  config: SubstrateConfig,
  purpose: CanonicalModelPurpose,
): RoutingCandidate[] {
  const registryModels = config.modelRegistry?.models ?? [];
  if (registryModels.length === 0) {
    return [];
  }

  const rawCandidates = registryModels
    .map(entry => candidateFromRegistryEntry(config, entry, purpose))
    .filter((candidate): candidate is SelectorCandidate => candidate !== null);

  const scoredCandidates = scoreCandidates(purpose, rawCandidates);
  scoredCandidates.sort(compareScoredCandidates);
  return scoredCandidates.map(entry => entry.candidate);
}

function buildStandardCandidates(
  config: SubstrateConfig,
  purpose: Exclude<RoutingPurpose, 'import_processing'>,
): RoutingCandidate[] {
  const candidates: RoutingCandidate[] = [];
  const seen = new Set<string>();

  for (const canonicalPurpose of resolveCanonicalPurposeChain(purpose)) {
    const purposeCandidates = selectCandidatesForPurpose(config, canonicalPurpose);
    for (const candidate of purposeCandidates) {
      uniquePush(candidates, candidate, seen);
    }
  }

  return candidates;
}

function resolveImportRouteMode(config: SubstrateConfig): ImportProcessingRouteMode {
  return config.importProcessingRouteMode ?? 'background';
}

function resolveLocalImportCandidate(
  config: SubstrateConfig,
  fallbackMaxTokens: number,
): RoutingCandidate | undefined {
  const endpointUrl = config.importProcessingLocalEndpointUrl?.trim();
  const model = config.importProcessingLocalModel?.trim();
  if (!endpointUrl || !model) return undefined;
  if (!Number.isFinite(fallbackMaxTokens) || fallbackMaxTokens <= 0) return undefined;

  return {
    model,
    provider: 'local_endpoint',
    maxTokens: fallbackMaxTokens,
    requestBaseUrl: endpointUrl,
    requestApiKeyEnv: 'IMPORT_PROCESSING_LOCAL_API_KEY',
    importRouteMode: 'local_endpoint',
  };
}

function resolveImportRoutingCandidates(config: SubstrateConfig): RoutingCandidate[] {
  const routeMode = resolveImportRouteMode(config);
  const importCandidates = selectCandidatesForPurpose(config, 'import_processing');

  if (routeMode === 'openrouter_zdr') {
    return importCandidates
      .filter(candidate => candidate.provider === 'openrouter')
      .map(candidate => ({
        ...candidate,
        openRouterZdrOnly: true,
        importRouteMode: 'openrouter_zdr' as const,
      }));
  }

  if (routeMode === 'local_endpoint') {
    const fallbackMaxTokens = importCandidates[0]?.maxTokens ?? config.extractionMaxTokens;
    const localCandidate = resolveLocalImportCandidate(config, fallbackMaxTokens);
    return localCandidate ? [localCandidate] : [];
  }

  return importCandidates.map(candidate => ({
    ...candidate,
    importRouteMode: 'background' as const,
  }));
}

export function evaluateImportPolicy(
  config: SubstrateConfig,
  purpose: RoutingPurpose,
  candidate: RoutingCandidate,
): ImportPolicyEvaluation {
  const configuredRouteMode = resolveImportRouteMode(config);
  const selectedRouteMode = candidate.importRouteMode ?? configuredRouteMode;
  const strictPolicyEnabled = config.importProcessingStrictPolicy === true;
  const openRouterZdrOnly = candidate.provider === 'openrouter' && candidate.openRouterZdrOnly === true;

  const audit: ImportPolicyAuditRecord = {
    purpose,
    strictPolicyEnabled,
    configuredRouteMode,
    selectedRouteMode,
    provider: candidate.provider,
    model: candidate.model,
    openRouterZdrOnly,
    ...(candidate.requestBaseUrl ? { requestBaseUrl: candidate.requestBaseUrl } : {}),
  };

  if (purpose !== 'import_processing' || !strictPolicyEnabled) {
    return { allowed: true, audit };
  }

  if (!openRouterZdrOnly) {
    return {
      allowed: false,
      reason: 'strict_requires_openrouter_zdr',
      audit,
    };
  }

  return { allowed: true, audit };
}

export function resolveRoutingCandidates(
  config: SubstrateConfig,
  purpose: RoutingPurpose,
): RoutingCandidate[] {
  if (purpose === 'import_processing') {
    return resolveImportRoutingCandidates(config);
  }

  return buildStandardCandidates(config, purpose);
}
