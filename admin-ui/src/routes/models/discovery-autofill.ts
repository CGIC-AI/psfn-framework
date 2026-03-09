export interface DiscoveryPricingRecord {
  [key: string]: string | number | undefined;
}

export interface DiscoveryAutofillSource {
  id: string;
  description?: string;
  providerHints?: string[];
  contextLength?: number;
  maxCompletionTokens?: number;
  pricing?: DiscoveryPricingRecord;
}

export interface DiscoveryAutofillValues {
  provider?: string;
  sourceType?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputPer1MUsd?: number;
  outputPer1MUsd?: number;
}

const PER_TOKEN_TO_PER_MILLION = 1_000_000;
const LOOKUP_WRAPPER_PREFIXES = new Set(['openrouter', 'litellm', 'proxy']);
const PROVIDER_INFRA_HINTS = new Set(['proxy', 'litellm', 'router']);
const LOOKUP_DISPLAY_SEPARATORS = [' — ', ' – ', ' - ', ' | ', ' · '] as const;

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeLookupKey(value: unknown): string | undefined {
  return normalizeString(value)?.toLowerCase();
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function normalizePrice(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : (typeof value === 'string' ? Number(value.trim()) : NaN);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return numeric * PER_TOKEN_TO_PER_MILLION;
}

function providerPrefixFromModelId(modelId: string): string | undefined {
  const normalized = normalizeString(modelId);
  if (!normalized) return undefined;
  const slashIndex = normalized.indexOf('/');
  if (slashIndex > 0) {
    return normalizeString(normalized.slice(0, slashIndex));
  }
  const colonIndex = normalized.indexOf(':');
  if (colonIndex > 0) {
    return normalizeString(normalized.slice(0, colonIndex));
  }
  return undefined;
}

function normalizeProviderHint(value: unknown): string | undefined {
  const normalized = normalizeLookupKey(value);
  if (!normalized) return undefined;
  return normalized.includes('openrouter') ? 'openrouter' : normalized;
}

function normalizeProviderHints(model: DiscoveryAutofillSource): string[] {
  const hints = Array.isArray(model.providerHints)
    ? model.providerHints
    : [];
  const values = new Set<string>();
  for (const hint of hints) {
    const normalized = normalizeProviderHint(hint);
    if (normalized) values.add(normalized);
  }
  const idPrefix = normalizeProviderHint(providerPrefixFromModelId(model.id));
  if (idPrefix) values.add(idPrefix);
  return [...values];
}

function preferredProviderFromHints(providerHints: string[]): string | undefined {
  if (providerHints.includes('openrouter')) return 'openrouter';
  const provider = providerHints.find((hint) => !PROVIDER_INFRA_HINTS.has(hint));
  return provider ?? providerHints[0];
}

function expandModelIdLookupKeys(modelId: string): string[] {
  const base = normalizeLookupKey(modelId);
  if (!base) return [];
  const queue = [base];
  const keys: string[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    keys.push(candidate);

    const slashIndex = candidate.indexOf('/');
    if (slashIndex > 0) {
      const prefix = candidate.slice(0, slashIndex);
      const rest = candidate.slice(slashIndex + 1).trim();
      if (rest && LOOKUP_WRAPPER_PREFIXES.has(prefix)) {
        queue.push(rest);
      }
    }

    const colonIndex = candidate.indexOf(':');
    if (colonIndex > 0) {
      const prefix = candidate.slice(0, colonIndex);
      const rest = candidate.slice(colonIndex + 1).trim();
      if (rest && LOOKUP_WRAPPER_PREFIXES.has(prefix)) {
        queue.push(rest);
      }
    }
  }
  return keys;
}

function extractSelectionCandidates(value: string): string[] {
  const normalized = normalizeString(value);
  if (!normalized) return [];
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string | undefined) => {
    if (!candidate) return;
    const trimmed = normalizeString(candidate);
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  push(normalized);
  push(normalized.replace(/^["']|["']$/g, ''));

  for (const separator of LOOKUP_DISPLAY_SEPARATORS) {
    const index = normalized.indexOf(separator);
    if (index > 0) {
      push(normalized.slice(0, index));
    }
  }

  const parentheticalIndex = normalized.indexOf('(');
  if (parentheticalIndex > 0) {
    push(normalized.slice(0, parentheticalIndex));
  }

  const [firstToken] = normalized.split(/\s+/, 1);
  if (firstToken && (firstToken.includes('/') || firstToken.includes(':'))) {
    push(firstToken);
  }
  return candidates;
}

function selectionLookupKeys(value: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const candidate of extractSelectionCandidates(value)) {
    for (const key of expandModelIdLookupKeys(candidate)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
}

export function resolveDiscoveredModelSelection<T extends Pick<DiscoveryAutofillSource, 'id' | 'description'>>(
  rawSelection: string,
  discoveredModels: readonly T[],
): T | undefined {
  const keys = selectionLookupKeys(rawSelection);
  if (keys.length === 0) return undefined;
  const primaryKey = keys[0];
  let variantMatch: T | undefined;

  for (const model of discoveredModels) {
    const modelKeys = expandModelIdLookupKeys(model.id);
    if (modelKeys.length === 0) continue;
    if (modelKeys.includes(primaryKey)) {
      return model;
    }
    if (!variantMatch && keys.some((key) => modelKeys.includes(key))) {
      variantMatch = model;
    }
  }
  if (variantMatch) return variantMatch;

  const normalizedSelection = normalizeLookupKey(rawSelection);
  if (!normalizedSelection) return undefined;
  let descriptionMatch: T | undefined;
  for (const model of discoveredModels) {
    if (normalizeLookupKey(model.description) === normalizedSelection) {
      if (descriptionMatch) return undefined;
      descriptionMatch = model;
    }
  }
  return descriptionMatch;
}

export function deriveDiscoveryAutofill(model: DiscoveryAutofillSource): DiscoveryAutofillValues {
  const providerHints = normalizeProviderHints(model);
  const preferredProvider = preferredProviderFromHints(providerHints);
  const pricing = model.pricing ?? {};

  return {
    ...(preferredProvider ? { provider: preferredProvider, sourceType: preferredProvider } : {}),
    ...(normalizePositiveInteger(model.contextLength) !== undefined
      ? { contextWindow: normalizePositiveInteger(model.contextLength) }
      : {}),
    ...(normalizePositiveInteger(model.maxCompletionTokens) !== undefined
      ? { maxOutputTokens: normalizePositiveInteger(model.maxCompletionTokens) }
      : {}),
    ...(normalizePrice(pricing.prompt) !== undefined
      ? { inputPer1MUsd: normalizePrice(pricing.prompt) }
      : {}),
    ...(normalizePrice(pricing.completion) !== undefined
      ? { outputPer1MUsd: normalizePrice(pricing.completion) }
      : {}),
  };
}

export function buildUniqueModelId(preferredId: string, existingIds: ReadonlySet<string>): string {
  const normalizedPreferred = normalizeString(preferredId) ?? 'model';
  if (!existingIds.has(normalizedPreferred)) return normalizedPreferred;

  let suffix = 2;
  let candidate = `${normalizedPreferred}-${suffix}`;
  while (existingIds.has(candidate)) {
    suffix += 1;
    candidate = `${normalizedPreferred}-${suffix}`;
  }
  return candidate;
}
