// ── Pure provider cost-evidence extraction (psfn-framework-kbdvl.1) ──
//
// Stateless header and body cost-evidence parsers shared by core embedding
// providers and the gateway fetch-capture layer.

import type { LLMUsageCostDetails } from '../contracts/runtime.js';
import {
  mergeProviderCostEvidenceConflicts,
  reconcileProviderCostEvidence,
  type ReconciledProviderCostEvidence,
} from './provider-cost-evidence.js';
import { isRecord } from '../utils/types.js';

const COST_HEADER_NAMES = [
  'x-litellm-response-cost',
  'llm_provider-x-litellm-response-cost',
  'llm-provider-x-litellm-response-cost',
  'x-litellm-provider-response-cost',
  'x-litellm-model-response-cost',
] as const;

function parseNonNegativeCost(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : (typeof value === 'string' ? Number(value.trim().replace(/^\$/, '')) : NaN);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

export function extractGatewayProviderCostEvidenceFromHeaders(
  headers: Headers,
): ReconciledProviderCostEvidence {
  const sources: Record<string, LLMUsageCostDetails> = {};
  const conflicts = new Set<string>();
  for (const name of COST_HEADER_NAMES) {
    const rawCost = headers.get(name);
    if (rawCost === null) continue;
    const cost = parseNonNegativeCost(rawCost);
    if (cost !== undefined) {
      sources[`header.${name}`] = { total: cost, currency: 'USD' };
    } else {
      conflicts.add(`header.${name}`);
    }
  }
  return mergeProviderCostEvidenceConflicts(
    reconcileProviderCostEvidence(sources),
    conflicts.size > 0 ? { fields: [...conflicts] } : undefined,
  );
}

export function extractGatewayProviderCostFromHeaders(headers: Headers): LLMUsageCostDetails | undefined {
  return extractGatewayProviderCostEvidenceFromHeaders(headers).providerCost;
}

function recordCostObservation(
  sources: Record<string, LLMUsageCostDetails>,
  conflicts: Set<string>,
  source: string,
  field: keyof Pick<LLMUsageCostDetails, 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'total'>,
  value: unknown,
  currency = 'USD',
): void {
  if (value === undefined) return;
  const cost = parseNonNegativeCost(value);
  if (cost !== undefined) {
    sources[source] = { [field]: cost, currency };
  } else {
    conflicts.add(source);
  }
}

function recordCostDetailObservations(
  sources: Record<string, LLMUsageCostDetails>,
  conflicts: Set<string>,
  prefix: string,
  details: Record<string, unknown> | undefined,
): void {
  if (!details) return;
  const currency = typeof details.currency === 'string' && details.currency.trim().length > 0
    ? details.currency.trim().toUpperCase()
    : 'USD';
  const fields = [
    ['input', 'input'],
    ['input_cost', 'input'],
    ['prompt_cost', 'input'],
    ['output', 'output'],
    ['output_cost', 'output'],
    ['completion_cost', 'output'],
    ['cacheRead', 'cacheRead'],
    ['cache_read_cost', 'cacheRead'],
    ['cached_input_cost', 'cacheRead'],
    ['cacheWrite', 'cacheWrite'],
    ['cache_write_cost', 'cacheWrite'],
    ['cache_creation_cost', 'cacheWrite'],
    ['upstream_inference_cost', 'total'],
    ['total', 'total'],
    ['total_cost', 'total'],
  ] as const;
  for (const [key, field] of fields) {
    recordCostObservation(sources, conflicts, `${prefix}.${key}`, field, details[key], currency);
  }
}

function recordCostValue(
  sources: Record<string, LLMUsageCostDetails>,
  conflicts: Set<string>,
  prefix: string,
  value: unknown,
): void {
  if (isRecord(value)) {
    recordCostDetailObservations(sources, conflicts, prefix, value);
    return;
  }
  recordCostObservation(sources, conflicts, prefix, 'total', value);
}

export function extractGatewayProviderCostEvidence(
  value: unknown,
  prefix = 'body',
): ReconciledProviderCostEvidence {
  const record = isRecord(value) ? value : undefined;
  if (!record) {
    if (value === undefined || value === null) return reconcileProviderCostEvidence({});
    const total = parseNonNegativeCost(value);
    return mergeProviderCostEvidenceConflicts(
      reconcileProviderCostEvidence(total === undefined
        ? {}
        : { [`${prefix}.value`]: { total, currency: 'USD' } }),
      total === undefined ? { fields: [`${prefix}.value`] } : undefined,
    );
  }
  const usage = isRecord(record.usage) ? record.usage : undefined;
  const usageCostDetails = isRecord(usage?.cost_details) ? usage.cost_details : undefined;
  const costDetails = isRecord(record.cost_details) ? record.cost_details : undefined;
  const sources: Record<string, LLMUsageCostDetails> = {};
  const conflicts = new Set<string>();
  recordCostValue(sources, conflicts, `${prefix}.usage.cost`, usage?.cost);
  recordCostDetailObservations(sources, conflicts, `${prefix}.usage.cost_details`, usageCostDetails);
  recordCostDetailObservations(sources, conflicts, `${prefix}.cost_details`, costDetails);
  recordCostValue(sources, conflicts, `${prefix}.cost`, record.cost);
  return mergeProviderCostEvidenceConflicts(
    reconcileProviderCostEvidence(sources),
    conflicts.size > 0 ? { fields: [...conflicts] } : undefined,
  );
}

export function extractGatewayProviderCost(value: unknown): LLMUsageCostDetails | undefined {
  return extractGatewayProviderCostEvidence(value).providerCost;
}
