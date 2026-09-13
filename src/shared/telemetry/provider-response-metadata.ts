import type { LLMProviderResponseMetadata } from '../contracts/runtime.js';
import { sanitizeDiagnosticText } from '../diagnostics/redaction.js';
import { isRecord } from '../utils/types.js';
import type { ReconciledProviderCostEvidence } from './provider-cost-evidence.js';

export interface CapturedProviderEvidence extends ReconciledProviderCostEvidence {
  providerResponse?: LLMProviderResponseMetadata;
}

/** Keep only bounded response identifiers/labels, never a response body or header. */
export function extractProviderResponseMetadata(value: unknown): LLMProviderResponseMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const metadata: LLMProviderResponseMetadata = {};
  for (const [key, raw] of [
    ['responseId', value.id],
    ['servingProvider', value.provider],
  ] as const) {
    if (raw === undefined || raw === null) continue;
    if (
      typeof raw === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:/() -]*$/u.test(raw)
      && (key !== 'responseId' || !raw.includes(' '))
      && sanitizeDiagnosticText(raw) === raw
    ) {
      metadata[key] = raw;
    } else {
      (metadata.conflicts ??= []).push(key);
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function mergeProviderResponseMetadata(
  ...observations: Array<LLMProviderResponseMetadata | undefined>
): LLMProviderResponseMetadata | undefined {
  const merged: LLMProviderResponseMetadata = {};
  const conflicts = new Set<NonNullable<LLMProviderResponseMetadata['conflicts']>[number]>();
  for (const observation of observations) {
    for (const field of observation?.conflicts ?? []) conflicts.add(field);
    for (const field of ['responseId', 'servingProvider'] as const) {
      const value = observation?.[field];
      if (value === undefined) continue;
      if (merged[field] !== undefined && merged[field] !== value) conflicts.add(field);
      merged[field] = value;
    }
  }
  for (const field of conflicts) delete merged[field];
  if (conflicts.size > 0) merged.conflicts = [...conflicts].sort();
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function providerResponseLogMetadata(metadata: LLMProviderResponseMetadata | undefined): {
  providerResponseId?: string;
  servingProvider?: string;
  providerResponseConflict?: boolean;
} {
  return {
    ...(metadata?.responseId ? { providerResponseId: metadata.responseId } : {}),
    ...(metadata?.servingProvider ? { servingProvider: metadata.servingProvider } : {}),
    ...(metadata?.conflicts?.length ? { providerResponseConflict: true } : {}),
  };
}
