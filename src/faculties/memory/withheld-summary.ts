import type { PolicyReasonTag } from '../../system/trust/policy.js';

export type MemoryWithheldReasonTag =
  | 'contact_scope.high_intimacy'
  | Exclude<PolicyReasonTag, 'operator.approval_override' | 'default.within_bounds'>;

export type MemoryWithheldReasonCounts = Partial<Record<MemoryWithheldReasonTag, number>>;
export type MemoryWithheldRelevanceBand = 'high' | 'medium' | 'low';
export type MemoryWithheldRelevanceBandCounts = Partial<Record<MemoryWithheldRelevanceBand, number>>;

export interface MemoryWithheldSummary {
  totalCount: number;
  reasonCounts: MemoryWithheldReasonCounts;
  relevanceBands?: MemoryWithheldRelevanceBandCounts;
}

const MEMORY_WITHHELD_REASON_ORDER: readonly MemoryWithheldReasonTag[] = [
  'contact_scope.high_intimacy',
  'boundary.withhold',
  'boundary.consent_required',
  'consent.allow_recall_denied',
  'trust.ceiling_exceeded',
  'visibility.channel_restricted',
];

const MEMORY_WITHHELD_REASON_LABELS: Record<MemoryWithheldReasonTag, string> = {
  'contact_scope.high_intimacy': 'high-intimacy contact scope',
  'boundary.withhold': 'explicit non-disclosure boundary',
  'boundary.consent_required': 'explicit consent requirement',
  'consent.allow_recall_denied': 'stored recall denial',
  'trust.ceiling_exceeded': 'trust ceiling',
  'visibility.channel_restricted': 'channel visibility restriction',
};

const MEMORY_WITHHELD_RELEVANCE_BAND_ORDER: readonly MemoryWithheldRelevanceBand[] = [
  'high',
  'medium',
  'low',
];

const MEMORY_WITHHELD_RELEVANCE_BAND_LABELS: Record<MemoryWithheldRelevanceBand, string> = {
  high: 'high-match',
  medium: 'medium-match',
  low: 'low-match',
};

export function createEmptyMemoryWithheldSummary(): MemoryWithheldSummary {
  return {
    totalCount: 0,
    reasonCounts: {},
    relevanceBands: {},
  };
}

export function incrementMemoryWithheldReason(
  summary: MemoryWithheldSummary,
  reason: MemoryWithheldReasonTag,
): void {
  summary.totalCount += 1;
  summary.reasonCounts[reason] = (summary.reasonCounts[reason] ?? 0) + 1;
}

export function incrementMemoryWithheldRelevanceBand(
  summary: MemoryWithheldSummary,
  relevanceBand: MemoryWithheldRelevanceBand | undefined,
): void {
  if (!relevanceBand) return;
  summary.relevanceBands ??= {};
  summary.relevanceBands[relevanceBand] = (summary.relevanceBands[relevanceBand] ?? 0) + 1;
}

export function resolveMemoryWithheldRelevanceBand(
  similarity: number | undefined,
): MemoryWithheldRelevanceBand | undefined {
  if (similarity === undefined || !Number.isFinite(similarity)) return undefined;
  if (similarity >= 0.8) return 'high';
  if (similarity >= 0.5) return 'medium';
  return 'low';
}

export function cloneMemoryWithheldSummary(
  summary?: MemoryWithheldSummary,
): MemoryWithheldSummary | undefined {
  if (!summary) return undefined;
  return {
    totalCount: summary.totalCount,
    reasonCounts: { ...summary.reasonCounts },
    ...(summary.relevanceBands ? { relevanceBands: { ...summary.relevanceBands } } : {}),
  };
}

export function serializeMemoryWithheldSummary(summary?: MemoryWithheldSummary): string {
  if (!summary || summary.totalCount <= 0) return 'none';
  const orderedPairs = MEMORY_WITHHELD_REASON_ORDER
    .map((reason) => {
      const count = summary.reasonCounts[reason];
      return count && count > 0 ? `${reason}:${count}` : null;
    })
    .filter((value): value is string => value !== null);
  const relevancePairs = listMemoryWithheldRelevanceBandEntries(summary.relevanceBands ?? {})
    .map(({ band, count }) => `${band}:${count}`);
  return `${summary.totalCount}|${orderedPairs.join(',')}|${relevancePairs.join(',')}`;
}

export function formatMemoryWithheldReasonLabel(reason: MemoryWithheldReasonTag): string {
  return MEMORY_WITHHELD_REASON_LABELS[reason];
}

export function formatMemoryWithheldRelevanceBandLabel(band: MemoryWithheldRelevanceBand): string {
  return MEMORY_WITHHELD_RELEVANCE_BAND_LABELS[band];
}

export function listMemoryWithheldReasonEntries(
  reasonCounts: MemoryWithheldReasonCounts,
): Array<{ reason: MemoryWithheldReasonTag; count: number }> {
  return MEMORY_WITHHELD_REASON_ORDER
    .map((reason) => ({ reason, count: reasonCounts[reason] ?? 0 }))
    .filter(({ count }) => count > 0);
}

export function listMemoryWithheldRelevanceBandEntries(
  relevanceBands: MemoryWithheldRelevanceBandCounts,
): Array<{ band: MemoryWithheldRelevanceBand; count: number }> {
  return MEMORY_WITHHELD_RELEVANCE_BAND_ORDER
    .map((band) => ({ band, count: relevanceBands[band] ?? 0 }))
    .filter(({ count }) => count > 0);
}
