import { describe, expect, it } from 'vitest';

import { evaluateBlindReviewGate } from './change-gate.js';
import { blindReviewBatchDigest } from './contracts.js';
import {
  blindReviewTestConfig,
  blindReviewTestEvidence,
  blindReviewTestEvidenceRange,
} from './blind-review.test-support.js';

const config = blindReviewTestConfig({
  batch: { maxItemsPerBatch: 4, minItemsPerBatch: 2, minBlindedCharsPerBatch: 0 },
}).batch;

describe('blind review change gate', () => {
  it('refuses an empty window', () => {
    expect(evaluateBlindReviewGate({ items: [], lastBatchDigest: null, config }))
      .toEqual({ review: false, reason: 'no_evidence', digest: null });
  });

  it('refuses a batch below the item floor', () => {
    const decision = evaluateBlindReviewGate({
      items: blindReviewTestEvidenceRange(1),
      lastBatchDigest: null,
      config,
    });
    expect(decision).toEqual({ review: false, reason: 'undersized_items', digest: null });
  });

  it('refuses a batch below an enabled blinded-character floor', () => {
    const decision = evaluateBlindReviewGate({
      items: blindReviewTestEvidenceRange(3),
      lastBatchDigest: null,
      config: { ...config, minBlindedCharsPerBatch: 100 },
    });
    expect(decision).toEqual({ review: false, reason: 'undersized_content', digest: null });
  });

  it('admits a structural-only batch when the character floor is disabled', () => {
    const items = blindReviewTestEvidenceRange(3);
    const decision = evaluateBlindReviewGate({ items, lastBatchDigest: null, config });
    expect(decision.review).toBe(true);
    expect(decision).toMatchObject({ digest: blindReviewBatchDigest(items) });
  });

  it('counts blinded excerpt characters toward an enabled floor', () => {
    const items = [
      blindReviewTestEvidence(1, { blindedExcerpt: 'a'.repeat(60) }),
      blindReviewTestEvidence(2, { blindedExcerpt: 'b'.repeat(60) }),
    ];
    const decision = evaluateBlindReviewGate({
      items,
      lastBatchDigest: null,
      config: { ...config, minBlindedCharsPerBatch: 100 },
    });
    expect(decision.review).toBe(true);
  });

  it('refuses a batch whose digest was already reviewed', () => {
    const items = blindReviewTestEvidenceRange(3);
    const digest = blindReviewBatchDigest(items);
    expect(evaluateBlindReviewGate({ items, lastBatchDigest: digest, config }))
      .toEqual({ review: false, reason: 'unchanged_digest', digest });
  });

  it('truncates an oversized batch to the per-batch ceiling before digesting', () => {
    const items = blindReviewTestEvidenceRange(10);
    const decision = evaluateBlindReviewGate({ items, lastBatchDigest: null, config });
    expect(decision.review).toBe(true);
    if (!decision.review) return;
    expect(decision.items).toHaveLength(config.maxItemsPerBatch);
    expect(decision.digest).toBe(blindReviewBatchDigest(items.slice(0, config.maxItemsPerBatch)));
  });

  it('checks size floors before the change check so an undersized digest is never remembered', () => {
    // A one-row batch whose digest happens to match must still report the size
    // failure: remembering an undersized digest would let a later, larger batch
    // that starts with the same row be dismissed as unchanged.
    const items = blindReviewTestEvidenceRange(1);
    const decision = evaluateBlindReviewGate({
      items,
      lastBatchDigest: blindReviewBatchDigest(items),
      config,
    });
    expect(decision).toEqual({ review: false, reason: 'undersized_items', digest: null });
  });
});
