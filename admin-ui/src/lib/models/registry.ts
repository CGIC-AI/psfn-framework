import { isRecord } from '../../../../src/shared/utils/types.js';
export { isRecord };
export type CanonicalModelPurpose =
  | 'chat'
  | 'background'
  | 'memory'
  | 'extraction'
  | 'summary'
  | 'reasoning'
  | 'import_processing'
  | 'longContext'
  | 'vision'
  | 'moa';

export interface ModelRegistryPurposeTag {
  purpose: CanonicalModelPurpose;
  primary: boolean;
}

export interface ModelRegistrySourceMetadata extends Record<string, unknown> {
  type: string;
  label?: string;
  baseUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface ModelRegistryIdentityMetadata extends Record<string, unknown> {
  provider: string;
  model: string;
  source: ModelRegistrySourceMetadata;
  family?: string;
}

export interface ModelRegistryEntry extends Record<string, unknown> {
  id: string;
  rank: number;
  identity: ModelRegistryIdentityMetadata;
  purposes: ModelRegistryPurposeTag[];
  routing?: {
    providerOrder?: string[];
  };
  capabilities?: Record<string, unknown>;
  tuning?: Record<string, unknown>;
  cost?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ModelRegistryBudgetPolicy {
  enabled: boolean;
  dailyUsdLimit: number;
  monthlyUsdLimit: number;
  currency: 'USD';
}

export interface CanonicalModelRegistry {
  schemaVersion: 1;
  models: ModelRegistryEntry[];
  budgetPolicy?: ModelRegistryBudgetPolicy;
}

export const DEFAULT_BUDGET_POLICY: ModelRegistryBudgetPolicy = {
  enabled: false,
  dailyUsdLimit: 5,
  monthlyUsdLimit: 100,
  currency: 'USD',
};

export const CANONICAL_PURPOSES = [
  'chat',
  'background',
  'memory',
  'extraction',
  'summary',
  'reasoning',
  'import_processing',
  'longContext',
  'vision',
  'moa',
] as const satisfies readonly CanonicalModelPurpose[];

export const PURPOSE_LABELS: Record<CanonicalModelPurpose, string> = {
  chat: 'chat',
  background: 'background',
  memory: 'memory',
  extraction: 'extraction',
  summary: 'summary',
  reasoning: 'reasoning',
  import_processing: 'import',
  longContext: 'longCtx',
  vision: 'vision',
  moa: 'moa',
};

export function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

export function normalizeRouting(value: unknown): { providerOrder?: string[] } | undefined {
  if (!isRecord(value) || !Array.isArray(value.providerOrder)) return undefined;
  const providerOrder = value.providerOrder
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim().toLowerCase())
    .filter((entry, index, array) => entry.length > 0 && array.indexOf(entry) === index);
  return providerOrder.length > 0 ? { providerOrder } : undefined;
}

export function normalizeBudgetPolicy(value: unknown): ModelRegistryBudgetPolicy {
  if (!isRecord(value)) {
    return { ...DEFAULT_BUDGET_POLICY };
  }

  const enabled = value.enabled === true;
  const dailyUsdLimit = toFiniteNumber(value.dailyUsdLimit);
  const monthlyUsdLimit = toFiniteNumber(value.monthlyUsdLimit);
  const normalizedDaily = dailyUsdLimit !== undefined && dailyUsdLimit > 0
    ? dailyUsdLimit
    : DEFAULT_BUDGET_POLICY.dailyUsdLimit;
  const normalizedMonthly = monthlyUsdLimit !== undefined && monthlyUsdLimit > 0
    ? monthlyUsdLimit
    : DEFAULT_BUDGET_POLICY.monthlyUsdLimit;

  return {
    enabled,
    dailyUsdLimit: normalizedDaily,
    monthlyUsdLimit: normalizedMonthly,
    currency: 'USD',
  };
}

export function normalizePurposes(value: unknown): ModelRegistryPurposeTag[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<CanonicalModelPurpose>();
  const normalized: ModelRegistryPurposeTag[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const purpose = entry.purpose;
    if (typeof purpose !== 'string') continue;
    if (!CANONICAL_PURPOSES.includes(purpose as CanonicalModelPurpose)) continue;
    const normalizedPurpose = purpose as CanonicalModelPurpose;
    if (seen.has(normalizedPurpose)) continue;
    seen.add(normalizedPurpose);
    normalized.push({
      purpose: normalizedPurpose,
      primary: entry.primary === true,
    });
  }
  return normalized;
}

export function normalizeModelEntry(value: unknown, index: number): ModelRegistryEntry {
  const raw = isRecord(value) ? value : {};
  const identityRaw = isRecord(raw.identity) ? raw.identity : {};
  const sourceRaw = isRecord(identityRaw.source) ? identityRaw.source : {};
  const baseId = toNonEmptyString(raw.id) ?? `model-${index + 1}`;
  const rank = toFiniteNumber(raw.rank);
  const provider = toNonEmptyString(identityRaw.provider) ?? '';
  const model = toNonEmptyString(identityRaw.model) ?? '';
  const sourceType = toNonEmptyString(sourceRaw.type) ?? '';
  const purposes = normalizePurposes(raw.purposes);
  return {
    ...raw,
    id: baseId,
    rank: rank !== undefined ? Math.max(0, Math.round(rank)) : Math.max(0, (index + 1) * 10),
    identity: {
      ...identityRaw,
      provider,
      model,
      source: {
        ...sourceRaw,
        type: sourceType,
        ...(toNonEmptyString(sourceRaw.label) ? { label: toNonEmptyString(sourceRaw.label) } : {}),
        ...(toNonEmptyString(sourceRaw.baseUrl) ? { baseUrl: toNonEmptyString(sourceRaw.baseUrl) } : {}),
        ...(isRecord(sourceRaw.metadata) ? { metadata: { ...sourceRaw.metadata } } : {}),
      },
      ...(toNonEmptyString(identityRaw.family) ? { family: toNonEmptyString(identityRaw.family) } : {}),
    },
    purposes,
    ...(normalizeRouting(raw.routing) ? { routing: normalizeRouting(raw.routing) } : {}),
    ...(isRecord(raw.capabilities) ? { capabilities: { ...raw.capabilities } } : {}),
    ...(isRecord(raw.tuning) ? { tuning: { ...raw.tuning } } : {}),
    ...(isRecord(raw.cost) ? { cost: { ...raw.cost } } : {}),
    ...(isRecord(raw.metadata) ? { metadata: { ...raw.metadata } } : {}),
  };
}

function unwrapModelRegistryPayload(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.schemaVersion === 1 && Array.isArray(value.models)) return value;
  if (isRecord(value.modelRegistry)) return value.modelRegistry;
  return value;
}

export function normalizeModelRegistryPayload(value: unknown): CanonicalModelRegistry {
  const parsed = unwrapModelRegistryPayload(value);
  if (!isRecord(parsed)) {
    throw new Error('models.json must be a JSON object');
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error('models.json schemaVersion must be 1');
  }
  if (!Array.isArray(parsed.models)) {
    throw new Error('models.json.models must be an array');
  }
  const normalized = parsed.models.map((entry, index) => normalizeModelEntry(entry, index));
  const normalizedBudgetPolicy = normalizeBudgetPolicy(parsed.budgetPolicy);
  return {
    schemaVersion: 1,
    models: normalized.sort((a, b) => b.rank - a.rank),
    budgetPolicy: normalizedBudgetPolicy,
  };
}

export function parseModelRegistryJson(rawJson: string): CanonicalModelRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('models.json is not valid JSON');
  }
  return normalizeModelRegistryPayload(parsed);
}
