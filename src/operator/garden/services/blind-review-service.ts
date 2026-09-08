// ── Garden admin service: Blind Reviewer state projection (33xah) ──
//
// yxz0z.3 landed the Blind Reviewer's FINDINGS in the CogSec event store, so
// Garden already shows what the reviewer said. What it could not show is
// whether the reviewer is working: how large the rolling window is, whether the
// deterministic change gate is currently holding batches back, whether a failed
// review is backing off, and how often a pass can actually happen. An
// observability lane whose own health is invisible is one that can be silently
// dead for a week.
//
// CONTENT-FREE, by construction and not by convention. The projection reads
// exactly two things — the durable lane state row and the window census — and
// exposes counts, timestamps, config bounds and booleans. `lastBatchDigest` is
// reduced to a boolean at this boundary: it is a hash of evidence, and a hash
// of a small population is a lookup key, not a safe number to publish.
//
// READ-ONLY, by construction: the dependency is typed as the two reader methods
// of `BlindReviewStorePort`, so this service structurally cannot append, mark,
// pin, prune or write state even if a later edit tried to.

import { emptyBlindReviewLaneState } from '../../../core/cogsec/blind-review/contracts.js';
import type { BlindReviewStorePort } from '../../../core/cogsec/blind-review/contracts.js';
import type { BlindReviewerConfig } from '../../../system/config/scheduler-config/blind-review.js';

/** Exactly the reads this projection is allowed to make. */
export type AdminBlindReviewReadPort = Pick<BlindReviewStorePort, 'readState' | 'countRows'>;

// The view sub-shapes below are deliberately NOT exported: every consumer
// reaches them through `AdminBlindReviewStateView` (or an indexed access on
// it), so exporting them would add names nothing imports.

/**
 * Why the next pass would make no model call, computed from the SAME gate order
 * `evaluateBlindReviewGate` uses over the counts this projection can see.
 *
 * `unchanged_digest` is deliberately absent: proving it needs the candidate
 * batch's own content, which this surface must not read. `eligible` therefore
 * means "clears every gate that is visible from counts alone", not "will
 * certainly call a model".
 */
type AdminBlindReviewNextPassGate = 'no_evidence' | 'undersized_items' | 'eligible';

interface AdminBlindReviewWindowView {
  /** Rows in the rolling window right now. */
  total: number;
  /** Rows pinned to an alert case, which retention may not expire. */
  pinned: number;
  /** Rows no reviewer has answered for yet. */
  unreviewed: number;
  maxRows: number;
  maxPinnedRows: number;
  retentionMs: number;
  /** True once the window is at its hard cap and evicting oldest-first. */
  atRowCeiling: boolean;
  /** True once pinning is refused; a non-zero refusal is an operator finding. */
  atPinCeiling: boolean;
}

interface AdminBlindReviewCadenceView {
  /** `scheduler.json` blindReviewer.intervalMs — the lane's own due-gate. */
  intervalMs: number;
  /** `scheduler.json` backgroundMaintenance.intervalMs — the tick that calls it. */
  backgroundMaintenanceIntervalMs: number;
  /**
   * What the operator actually gets. The lane is a due-gated handler registered
   * on the background-maintenance registry, so it can only run when that tick
   * fires: the effective cadence is the max of the two, never the smaller.
   */
  effectiveIntervalMs: number;
}

interface AdminBlindReviewGateView {
  minItemsPerBatch: number;
  maxItemsPerBatch: number;
  minBlindedCharsPerBatch: number;
  /** Model calls one pass may make, whatever the backlog. */
  maxReviewsPerRun: number;
  nextPassGate: AdminBlindReviewNextPassGate;
}

interface AdminBlindReviewRetryView {
  /** Consecutive failed attempts against the current head batch. */
  attempt: number;
  maxAttempts: number;
  /** Epoch ms before which a failed batch may not be retried; 0 when idle. */
  retryNotBeforeMs: number;
  /** True when a failed review is currently serving its backoff. */
  backingOff: boolean;
  /** True when the head batch has burned every attempt it is allowed. */
  attemptsExhausted: boolean;
}

type AdminBlindReviewStatus =
  /** `scheduler.json` says blindReviewer.enabled is false. */
  | 'disabled'
  /** Enabled, but this process composed no durable window (no database URL). */
  | 'unwired'
  /** Wired, but no pass has written lane state yet. */
  | 'never_run'
  | 'running';

export interface AdminBlindReviewStateView {
  status: AdminBlindReviewStatus;
  enabled: boolean;
  /** `occurredAtMs` of the newest ingested evidence; 0 before first ingest. */
  ingestedThroughMs: number;
  /** When the lane last wrote state; 0 before the first pass. */
  updatedAtMs: number;
  /**
   * Whether a model has ever reviewed a batch in this window. The digest ITSELF
   * is never exposed: it is a hash of the evidence a small number of turns
   * produced, which makes it a confirmation oracle rather than a statistic.
   */
  hasReviewedBatch: boolean;
  window: AdminBlindReviewWindowView;
  cadence: AdminBlindReviewCadenceView;
  gate: AdminBlindReviewGateView;
  retry: AdminBlindReviewRetryView;
}

export interface AdminBlindReviewService {
  /** One content-free snapshot of the reviewer's own state. */
  getState(nowMs?: number): Promise<AdminBlindReviewStateView>;
}

interface AdminBlindReviewServiceOptions {
  config: BlindReviewerConfig;
  /** The background-maintenance tick the lane's handler is registered on. */
  backgroundMaintenanceIntervalMs: number;
  /**
   * Null when the reviewer is enabled but composed no durable window — that is
   * `unwired`, an explicit answer, never an empty-looking healthy one.
   */
  reader?: AdminBlindReviewReadPort | null;
}

/**
 * Mirror of `evaluateBlindReviewGate`'s visible-from-counts prefix. The blinded
 * character floor is skipped on purpose: it needs the excerpts themselves, and
 * this surface reads counts. When that floor is enabled the answer is reported
 * as `eligible` and the pass may still defer — stated in the field's doc rather
 * than guessed at here.
 */
function nextPassGate(
  unreviewed: number,
  config: BlindReviewerConfig,
): AdminBlindReviewNextPassGate {
  if (unreviewed === 0) return 'no_evidence';
  if (Math.min(unreviewed, config.batch.maxItemsPerBatch) < config.batch.minItemsPerBatch) {
    return 'undersized_items';
  }
  return 'eligible';
}

/** The census a window that was never opened has. Structural, not tuning. */
const EMPTY_WINDOW_CENSUS = Object.freeze({ total: 0, pinned: 0, unreviewed: 0 });

export function createAdminBlindReviewService(
  options: AdminBlindReviewServiceOptions,
): AdminBlindReviewService {
  const { config, backgroundMaintenanceIntervalMs } = options;
  const reader = options.reader ?? null;

  const cadence = (): AdminBlindReviewCadenceView => ({
    intervalMs: config.intervalMs,
    backgroundMaintenanceIntervalMs,
    effectiveIntervalMs: Math.max(config.intervalMs, backgroundMaintenanceIntervalMs),
  });

  const emptyWindow = (): AdminBlindReviewWindowView => ({
    total: EMPTY_WINDOW_CENSUS.total,
    pinned: EMPTY_WINDOW_CENSUS.pinned,
    unreviewed: EMPTY_WINDOW_CENSUS.unreviewed,
    maxRows: config.window.maxRows,
    maxPinnedRows: config.window.maxPinnedRows,
    retentionMs: config.window.retentionMs,
    atRowCeiling: EMPTY_WINDOW_CENSUS.total >= config.window.maxRows,
    atPinCeiling: EMPTY_WINDOW_CENSUS.pinned >= config.window.maxPinnedRows,
  });

  /**
   * A reviewer that is off or unwired reports the SAME never-ran zeros the lane
   * itself would start from, taken from `emptyBlindReviewLaneState` rather than
   * restated here, so the two can never disagree about what "nothing has
   * happened yet" looks like.
   */
  const inertView = (status: AdminBlindReviewStatus): AdminBlindReviewStateView => {
    const empty = emptyBlindReviewLaneState(0);
    return {
      status,
      enabled: config.enabled,
      ingestedThroughMs: empty.ingestedThroughMs,
      updatedAtMs: empty.updatedAtMs,
      hasReviewedBatch: empty.lastBatchDigest !== null,
      window: emptyWindow(),
      cadence: cadence(),
      gate: {
        minItemsPerBatch: config.batch.minItemsPerBatch,
        maxItemsPerBatch: config.batch.maxItemsPerBatch,
        minBlindedCharsPerBatch: config.batch.minBlindedCharsPerBatch,
        maxReviewsPerRun: config.cost.maxReviewsPerRun,
        nextPassGate: nextPassGate(0, config),
      },
      retry: {
        attempt: empty.reviewAttempt,
        maxAttempts: config.retry.maxAttempts,
        retryNotBeforeMs: empty.retryNotBeforeMs,
        backingOff: false,
        attemptsExhausted: empty.reviewAttempt >= config.retry.maxAttempts,
      },
    };
  };

  return {
    getState: async (nowMs = Date.now()): Promise<AdminBlindReviewStateView> => {
      if (!config.enabled) return inertView('disabled');
      if (!reader) return inertView('unwired');

      const [state, rows] = await Promise.all([reader.readState(), reader.countRows()]);
      // `emptyBlindReviewLaneState` stamps 0 when no row exists, and a real
      // pass always stamps a clock reading, so 0 is the honest "never ran".
      const neverRan = state.updatedAtMs === 0;
      return {
        status: neverRan ? 'never_run' : 'running',
        enabled: true,
        ingestedThroughMs: state.ingestedThroughMs,
        updatedAtMs: state.updatedAtMs,
        hasReviewedBatch: state.lastBatchDigest !== null,
        window: {
          total: rows.total,
          pinned: rows.pinned,
          unreviewed: rows.unreviewed,
          maxRows: config.window.maxRows,
          maxPinnedRows: config.window.maxPinnedRows,
          retentionMs: config.window.retentionMs,
          atRowCeiling: rows.total >= config.window.maxRows,
          atPinCeiling: rows.pinned >= config.window.maxPinnedRows,
        },
        cadence: cadence(),
        gate: {
          minItemsPerBatch: config.batch.minItemsPerBatch,
          maxItemsPerBatch: config.batch.maxItemsPerBatch,
          minBlindedCharsPerBatch: config.batch.minBlindedCharsPerBatch,
          maxReviewsPerRun: config.cost.maxReviewsPerRun,
          nextPassGate: nextPassGate(rows.unreviewed, config),
        },
        retry: {
          attempt: state.reviewAttempt,
          maxAttempts: config.retry.maxAttempts,
          retryNotBeforeMs: state.retryNotBeforeMs,
          backingOff: state.retryNotBeforeMs > nowMs,
          attemptsExhausted: state.reviewAttempt >= config.retry.maxAttempts,
        },
      };
    },
  };
}
