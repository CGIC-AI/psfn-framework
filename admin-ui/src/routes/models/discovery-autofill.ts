export interface DiscoveryPricingRecord {
  [key: string]: string | number | undefined;
}

export interface DiscoveryAutofillSource {
  id: string;
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

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
  const [prefix] = modelId.split('/');
  return normalizeString(prefix);
}

function normalizeProviderHints(model: DiscoveryAutofillSource): string[] {
  const hints = Array.isArray(model.providerHints)
    ? model.providerHints
    : [];
  const values = new Set<string>();
  for (const hint of hints) {
    const normalized = normalizeString(hint)?.toLowerCase();
    if (normalized) values.add(normalized);
  }
  const idPrefix = providerPrefixFromModelId(model.id)?.toLowerCase();
  if (idPrefix) values.add(idPrefix);
  return [...values];
}

export function deriveDiscoveryAutofill(model: DiscoveryAutofillSource): DiscoveryAutofillValues {
  const providerHints = normalizeProviderHints(model);
  const preferredProvider = providerHints.includes('openrouter')
    ? 'openrouter'
    : providerHints[0];
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
