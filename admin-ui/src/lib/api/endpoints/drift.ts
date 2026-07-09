// Cognitive Security drift review endpoints (htm9.14): batched review cards
// the nightly slow-poisoning drift-velocity lane raises, with the operator
// acknowledge/dismiss decision. Cards are evidence only — resolving one never
// mutates memories, trust, or emotion.

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
