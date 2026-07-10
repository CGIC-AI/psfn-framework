// Cognitive Security drift review endpoints (htm9.14, htm9.15): batched
// review cards the nightly drift lanes raise (per-contact slow poisoning and
// second-arrow rumination stacks), with the operator decision. Acknowledge
// and dismiss never mutate memories, trust, or emotion; approving a
// second-arrow card's consolidation ('consolidated') applies its proposed
// supersession server-side through the existing memory machinery (audited,
// never deletion).

import { apiGet, apiPost } from '$lib/api/client';
import type { DriftReviewCard, DriftReviewCardResolution } from '$lib/types';

export interface DriftReviewListData {
  cards: DriftReviewCard[];
  openCount: number;
}

export interface DriftReviewCardData {
  card: DriftReviewCard;
}

export interface DriftReviewResolveResult {
  ok: boolean;
  card: DriftReviewCard;
  /** Present after an approved second-arrow consolidation: the superseded ids. */
  consolidatedMemoryIds?: string[];
}

/** All drift review cards (open first, newest first). */
export function getDriftReviews(): Promise<DriftReviewListData> {
  return apiGet<DriftReviewListData>('/api/admin/intake/drift-reviews');
}

export function getDriftReviewCard(id: string): Promise<DriftReviewCardData> {
  return apiGet<DriftReviewCardData>(
    `/api/admin/intake/drift-reviews/${encodeURIComponent(id)}`,
  );
}

/** Records the operator decision on an open card (audited server-side). */
export function resolveDriftReviewCard(
  id: string,
  input: { resolution: DriftReviewCardResolution; note?: string },
): Promise<DriftReviewResolveResult> {
  return apiPost<DriftReviewResolveResult>(
    `/api/admin/intake/drift-reviews/${encodeURIComponent(id)}/resolve`,
    input,
  );
}
