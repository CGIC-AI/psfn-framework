// Test-only fixtures for the Blind Reviewer lane (bead psfn-framework-yxz0z.3).
//
// Shared between the unit tests and the real-Postgres integration test so both
// exercise the same evidence shapes and the same config overlay. Nothing here
// is imported by production code.

import {
  blindReviewContentDigest,
  blindReviewEvidenceId,
  blindReviewSourceRef,
  emptyBlindReviewLaneState,
  type BlindReviewEvidenceItem,
  type BlindReviewLaneState,
  type BlindReviewStorePort,
} from './contracts.js';
import { DEFAULT_BLIND_REVIEWER_CONFIG } from '../../../system/config/scheduler-config/blind-review.js';
import type { BlindReviewerConfig } from '../../../system/config/scheduler-config/blind-review.js';

export const TEST_BLIND_REVIEW_CHANNEL = 'discord:channel:blind-review-fixture';

export function blindReviewTestConfig(
  overrides: {
    root?: Partial<Omit<BlindReviewerConfig, 'batch' | 'window' | 'cost' | 'retry'>>;
    batch?: Partial<BlindReviewerConfig['batch']>;
    window?: Partial<BlindReviewerConfig['window']>;
    cost?: Partial<BlindReviewerConfig['cost']>;
    retry?: Partial<BlindReviewerConfig['retry']>;
  } = {},
): BlindReviewerConfig {
  return {
    ...DEFAULT_BLIND_REVIEWER_CONFIG,
    enabled: true,
    ...overrides.root,
    batch: { ...DEFAULT_BLIND_REVIEWER_CONFIG.batch, ...overrides.batch },
    window: { ...DEFAULT_BLIND_REVIEWER_CONFIG.window, ...overrides.window },
    cost: { ...DEFAULT_BLIND_REVIEWER_CONFIG.cost, ...overrides.cost },
    retry: { ...DEFAULT_BLIND_REVIEWER_CONFIG.retry, ...overrides.retry },
  };
}

/** One deterministic evidence row. `seed` varies both identity and content. */
export function blindReviewTestEvidence(
  seed: number,
  overrides: { occurredAtMs?: number; blindedExcerpt?: string; toolCallCount?: number } = {},
): BlindReviewEvidenceItem {
  const sourceRef = blindReviewSourceRef(TEST_BLIND_REVIEW_CHANNEL, `turn-${seed}`);
  const blindedExcerpt = overrides.blindedExcerpt ?? '';
  const activity = {
    toolCallCount: overrides.toolCallCount ?? seed % 4,
    toolNames: ['memory_search', 'web_fetch'].slice(0, 1 + (seed % 2)),
    toolErrorCount: seed % 2,
    assistantChars: 120 + seed,
    userChars: 40 + seed,
    extractedMemoryCount: seed % 3,
    durationMs: 1_000 + seed,
  };
  const disclosure = blindedExcerpt.length > 0 ? 'blinded_excerpt' as const : 'structural_only' as const;
  return {
    evidenceId: blindReviewEvidenceId(sourceRef),
    sourceRef,
    occurredAtMs: overrides.occurredAtMs ?? 1_700_000_000_000 + seed * 1_000,
    disclosure,
    activity,
    blindedExcerpt,
    contentDigest: blindReviewContentDigest({ disclosure, activity, blindedExcerpt }),
  };
}

export function blindReviewTestEvidenceRange(
  count: number,
  from = 1,
): BlindReviewEvidenceItem[] {
  return Array.from({ length: count }, (_, index) => blindReviewTestEvidence(from + index));
}

/**
 * In-memory `BlindReviewStorePort` with the same ordering, idempotence,
 * pinning and retention semantics as the Postgres adapter. It lets the lane's
 * control flow be proven without a container; the Postgres integration test
 * proves the adapter itself against the same expectations.
 */
export class InMemoryBlindReviewStore implements BlindReviewStorePort {
  private readonly rows = new Map<string, {
    item: BlindReviewEvidenceItem;
    reviewedAtMs: number | null;
    pinnedCaseId: string | null;
  }>();

  private state: BlindReviewLaneState = emptyBlindReviewLaneState(0);

  async appendEvidence(items: readonly BlindReviewEvidenceItem[]): Promise<number> {
    let admitted = 0;
    for (const item of items) {
      if (this.rows.has(item.evidenceId)) continue;
      this.rows.set(item.evidenceId, { item, reviewedAtMs: null, pinnedCaseId: null });
      admitted += 1;
    }
    return admitted;
  }

  async readState(): Promise<BlindReviewLaneState> {
    return { ...this.state };
  }

  async writeState(state: BlindReviewLaneState): Promise<void> {
    this.state = { ...state };
  }

  private ordered(): { item: BlindReviewEvidenceItem; reviewedAtMs: number | null; pinnedCaseId: string | null }[] {
    return [...this.rows.values()].sort((left, right) => (
      left.item.occurredAtMs - right.item.occurredAtMs
      || left.item.evidenceId.localeCompare(right.item.evidenceId)
    ));
  }

  async listUnreviewed(limit: number): Promise<BlindReviewEvidenceItem[]> {
    return this.ordered()
      .filter(row => row.reviewedAtMs === null)
      .slice(0, Math.max(0, limit))
      .map(row => row.item);
  }

  async markReviewed(evidenceIds: readonly string[], reviewedAtMs: number): Promise<number> {
    let marked = 0;
    for (const id of evidenceIds) {
      const row = this.rows.get(id);
      if (!row || row.reviewedAtMs !== null) continue;
      row.reviewedAtMs = reviewedAtMs;
      marked += 1;
    }
    return marked;
  }

  async pinEvidence(input: {
    evidenceIds: readonly string[];
    caseId: string;
    pinnedAtMs: number;
    maxPinnedRows: number;
  }): Promise<{ pinned: number; refused: number }> {
    const alreadyPinned = [...this.rows.values()].filter(row => row.pinnedCaseId !== null).length;
    let capacity = Math.max(0, input.maxPinnedRows - alreadyPinned);
    let pinned = 0;
    for (const id of input.evidenceIds) {
      if (capacity === 0) break;
      const row = this.rows.get(id);
      if (!row || row.pinnedCaseId !== null) continue;
      row.pinnedCaseId = input.caseId;
      capacity -= 1;
      pinned += 1;
    }
    return { pinned, refused: Math.max(0, input.evidenceIds.length - pinned) };
  }

  async prune(request: { nowMs: number; retentionMs: number; maxRows: number }): Promise<{
    expired: number;
    evicted: number;
  }> {
    const cutoffMs = request.nowMs - request.retentionMs;
    let expired = 0;
    for (const row of this.ordered()) {
      if (row.pinnedCaseId !== null || row.item.occurredAtMs > cutoffMs) continue;
      this.rows.delete(row.item.evidenceId);
      expired += 1;
    }
    let evicted = 0;
    for (const row of this.ordered()) {
      if (this.rows.size <= request.maxRows) break;
      if (row.pinnedCaseId !== null) continue;
      this.rows.delete(row.item.evidenceId);
      evicted += 1;
    }
    return { expired, evicted };
  }

  async countRows(): Promise<{ total: number; pinned: number; unreviewed: number }> {
    const rows = [...this.rows.values()];
    return {
      total: rows.length,
      pinned: rows.filter(row => row.pinnedCaseId !== null).length,
      unreviewed: rows.filter(row => row.reviewedAtMs === null).length,
    };
  }

  async close(): Promise<void> {}

  /** Test-only read: which case an evidence row is pinned to, if any. */
  pinnedCaseIdFor(evidenceId: string): string | null {
    return this.rows.get(evidenceId)?.pinnedCaseId ?? null;
  }
}
