import type { LLMUsageCostDetails } from '../contracts/runtime.js';
import { isRecord } from '../utils/types.js';

const COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const;
const COST_COMPONENT_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
const MAX_PROVIDER_COST_EVIDENCE_SOURCES = 128;

export interface ProviderCostEvidenceConflict {
  fields: string[];
}

export interface ReconciledProviderCostEvidence {
  providerCost?: LLMUsageCostDetails;
  providerCostEvidence: Record<string, LLMUsageCostDetails>;
  providerCostEvidenceConflict?: ProviderCostEvidenceConflict;
}

export type ProviderCostUsageEvidence = Partial<Record<
  typeof COST_COMPONENT_FIELDS[number],
  number
>>;

function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000_000_000) / 1_000_000_000_000;
}

function normalizeEvidenceCost(
  source: string,
  cost: LLMUsageCostDetails,
  conflicts: Set<string>,
): LLMUsageCostDetails | undefined {
  const normalized: LLMUsageCostDetails = {};
  let hasMoney = false;
  for (const field of COST_FIELDS) {
    const value = cost[field];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      conflicts.add(`${source}.${field}`);
      continue;
    }
    normalized[field] = roundUsd(value);
    hasMoney = true;
  }
  if (!hasMoney) return undefined;
  const currency = cost.currency?.trim().toUpperCase() || 'USD';
  normalized.currency = currency;
  if (currency !== 'USD') conflicts.add('currency');
  return normalized;
}

/**
 * Reconcile independent provider-cost observations without source precedence.
 * Any disagreement quarantines the canonical cost while retaining only the
 * bounded normalized cost fields from each named source.
 */
export function reconcileProviderCostEvidence(
  sources: Record<string, LLMUsageCostDetails | undefined>,
  usage?: ProviderCostUsageEvidence,
): ReconciledProviderCostEvidence {
  const entries = Object.entries(sources).filter((entry): entry is [string, LLMUsageCostDetails] => (
    entry[1] !== undefined
  ));
  if (entries.length > MAX_PROVIDER_COST_EVIDENCE_SOURCES) {
    throw new Error(`Provider cost evidence exceeds ${MAX_PROVIDER_COST_EVIDENCE_SOURCES} sources`);
  }

  const conflicts = new Set<string>();
  const evidence: Record<string, LLMUsageCostDetails> = {};
  const merged: LLMUsageCostDetails = {};
  for (const [source, cost] of entries) {
    const normalized = normalizeEvidenceCost(source, cost, conflicts);
    if (!normalized) continue;
    evidence[source] = normalized;
    for (const field of COST_FIELDS) {
      const value = normalized[field];
      if (value === undefined) continue;
      const existing = merged[field];
      if (existing !== undefined && roundUsd(existing) !== roundUsd(value)) {
        conflicts.add(field);
        continue;
      }
      merged[field] = value;
    }
    const existingCurrency = merged.currency;
    if (existingCurrency && existingCurrency !== normalized.currency) {
      conflicts.add('currency');
    } else {
      merged.currency = normalized.currency;
    }
  }

  const componentValues = COST_COMPONENT_FIELDS
    .map(field => merged[field])
    .filter((value): value is number => value !== undefined);
  if (merged.total !== undefined && componentValues.length > 0) {
    const componentTotal = roundUsd(componentValues.reduce((total, value) => total + value, 0));
    const allComponentsAllocated = COST_COMPONENT_FIELDS.every(
      field => merged[field] !== undefined || usage?.[field] === 0,
    );
    if (componentTotal > merged.total || (allComponentsAllocated && componentTotal !== merged.total)) {
      conflicts.add('total');
    }
  }

  if (conflicts.size > 0) {
    return {
      providerCostEvidence: evidence,
      providerCostEvidenceConflict: { fields: [...conflicts].sort() },
    };
  }
  return {
    providerCostEvidence: evidence,
    ...(Object.keys(evidence).length > 0 ? { providerCost: merged } : {}),
  };
}

/**
 * Preserve conflict markers discovered before cost observations are combined.
 * A conflict anywhere in the observation chain quarantines the canonical cost.
 */
export function mergeProviderCostEvidenceConflicts(
  reconciliation: ReconciledProviderCostEvidence,
  ...additionalConflicts: Array<ProviderCostEvidenceConflict | undefined>
): ReconciledProviderCostEvidence {
  const conflicts = new Set(reconciliation.providerCostEvidenceConflict?.fields ?? []);
  for (const conflict of additionalConflicts) {
    for (const field of conflict?.fields ?? []) conflicts.add(field);
  }
  if (conflicts.size === 0) return reconciliation;
  return {
    providerCostEvidence: reconciliation.providerCostEvidence,
    providerCostEvidenceConflict: { fields: [...conflicts].sort() },
  };
}

export function hasProviderCostEvidenceConflict(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const conflict = raw.providerCostEvidenceConflict;
  return isRecord(conflict)
    && Array.isArray(conflict.fields)
    && conflict.fields.length > 0;
}
