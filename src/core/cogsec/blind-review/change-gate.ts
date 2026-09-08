// ── Blind Reviewer deterministic new-content / change gate (yxz0z.3) ──
//
// The acceptance criterion "unchanged or undersized batches make zero model
// calls" is enforced here and nowhere else. This module is pure arithmetic over
// evidence the lane already holds: no I/O, no clock, no model. A batch that
// fails any gate is DEFERRED — its rows stay unreviewed and are re-offered on
// the next run once more evidence has accumulated — except an unchanged batch,
// which is retired: re-reviewing byte-identical evidence would only re-pay for
// an answer already on record.

import {
  blindReviewBatchDigest,
  type BlindReviewEvidenceItem,
} from './contracts.js';
import type { BlindReviewBatchConfig } from '../../../system/config/scheduler-config/blind-review.js';

/** Why a batch was not sent to a model. Every value means zero model calls. */
export type BlindReviewGateSkipReason =
  | 'no_evidence'
  | 'undersized_items'
  | 'undersized_content'
  | 'unchanged_digest';

export type BlindReviewGateDecision =
  | { review: false; reason: BlindReviewGateSkipReason; digest: string | null }
  | { review: true; digest: string; items: BlindReviewEvidenceItem[] };

/**
 * Total blinded characters a batch would put in front of a reviewer. Structural
 * rows contribute zero, so a window of purely structural evidence has to build
 * up more rows before it is worth a call — which is the intended behavior.
 */
export function blindReviewBatchBlindedChars(items: readonly BlindReviewEvidenceItem[]): number {
  return items.reduce((total, item) => total + item.blindedExcerpt.length, 0);
}

/**
 * Decide whether a batch earns one model call.
 *
 * Order matters and is deliberate: emptiness, then the two size floors, then
 * the change check. The change check is last because computing a digest over an
 * undersized batch and remembering it would let a later, larger batch that
 * happens to start with the same rows be dismissed as "unchanged".
 */
export function evaluateBlindReviewGate(input: {
  items: readonly BlindReviewEvidenceItem[];
  lastBatchDigest: string | null;
  config: BlindReviewBatchConfig;
}): BlindReviewGateDecision {
  const items = input.items.slice(0, input.config.maxItemsPerBatch);
  if (items.length === 0) {
    return { review: false, reason: 'no_evidence', digest: null };
  }
  if (items.length < input.config.minItemsPerBatch) {
    return { review: false, reason: 'undersized_items', digest: null };
  }
  if (blindReviewBatchBlindedChars(items) < input.config.minBlindedCharsPerBatch) {
    return { review: false, reason: 'undersized_content', digest: null };
  }
  const digest = blindReviewBatchDigest(items);
  if (input.lastBatchDigest !== null && digest === input.lastBatchDigest) {
    return { review: false, reason: 'unchanged_digest', digest };
  }
  return { review: true, digest, items };
}
