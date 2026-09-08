// ── Blind Reviewer lane policy (bead psfn-framework-yxz0z.3) ──
//
// Every bound the continuous passive Blind Reviewer applies lives here and
// reaches it from `scheduler.json`: the review window size and retention, the
// deterministic batch gates that decide whether a model is called at all, the
// per-run model-call ceiling and cost/deadline caps, worker concurrency, and
// the retry schedule. The lane itself owns no tuning literal.
//
// The block is validated as a whole because the values are not independent: a
// batch floor above the batch ceiling could never fire, a retention window
// shorter than one lane interval would expire evidence before it was ever
// reviewed, and a retry backoff whose maximum is below its base is a
// misconfiguration rather than a clamp. Those cross-checks fail the owner file
// closed at load instead of producing a reviewer that silently never runs.

import { isRecord } from '../../../shared/utils/types.js';
import { assertNoUnknownKeys } from '../validators.js';
import {
  toBoolean,
  toInterval,
  toNumberAtLeast,
  toNonNegativeInteger,
  toPositiveInteger,
  toUnitFactor,
} from './primitives.js';

/**
 * Deterministic new-content / change gates. A batch that fails any of these
 * makes ZERO model calls — the acceptance criterion for "unchanged or
 * undersized batches make zero model calls" is enforced here, in cheap
 * arithmetic over already-captured evidence, never by the reviewer model.
 */
export interface BlindReviewBatchConfig {
  /** Evidence rows admitted into one review batch. */
  maxItemsPerBatch: number;
  /** Rows below this count are undersized: the batch is deferred, not reviewed. */
  minItemsPerBatch: number;
  /**
   * Optional SECOND floor on total blinded characters. Most turns are private
   * and yield structural-only rows carrying no text, and a batch of those is
   * legitimate review material — anomalous tool-call shape is exactly what this
   * lane looks for. So this defaults to 0 (disabled) and `minItemsPerBatch`
   * carries the undersized gate; raise it only in a deployment whose evidence
   * really is text-bearing, and never so high that structural batches starve.
   */
  minBlindedCharsPerBatch: number;
  /** Per-item blinded excerpt ceiling; evidence is truncated to it at capture. */
  maxBlindedCharsPerItem: number;
  /** Tool identifiers retained per evidence row. Names only, never arguments. */
  maxToolNamesPerItem: number;
}

/** Rolling bounded review window and its retention. */
interface BlindReviewWindowConfig {
  /** Hard row cap on the rolling window. Oldest unpinned rows are evicted first. */
  maxRows: number;
  /** Age past which an UNPINNED row expires. Pinned rows survive expiry. */
  retentionMs: number;
  /** Hard cap on rows pinned for investigation, so pinning cannot grow forever. */
  maxPinnedRows: number;
}

/** Model-call cost ceilings for one lane run. */
interface BlindReviewCostConfig {
  /** Model calls one run may make. Bounds spend even when evidence floods in. */
  maxReviewsPerRun: number;
  /** Output-token ceiling for one review call. */
  maxOutputTokens: number;
  /** Wall-clock deadline for one review call. */
  deadlineMs: number;
  /** Spend ceiling for one review call, in USD. */
  costCeilingUsd: number;
}

/** Bounded retry schedule for a failed review. */
interface BlindReviewRetryConfig {
  /** Attempts for one batch before it is abandoned and its rows released. */
  maxAttempts: number;
  /** First backoff delay. */
  baseDelayMs: number;
  /** Backoff ceiling. Must be at least `baseDelayMs`. */
  maxDelayMs: number;
}

export interface BlindReviewerConfig {
  enabled: boolean;
  /** Lane cadence. The lane is a poller: it never sits on the turn path. */
  intervalMs: number;
  /**
   * Concurrent review workers. One keeps a companion's evidence strictly
   * ordered; raising it overlaps independent batches at proportional cost.
   */
  maxWorkers: number;
  /**
   * Evidence rows one run may capture from the source before it stops. This is
   * the backpressure bound: the source is polled, never pushed, so a burst of
   * activity bounds the lane's work instead of the lane bounding the turn.
   */
  maxIngestPerRun: number;
  /** Recent sessions one ingest pass scans. Bounds the read, not the window. */
  recentSessionLimit: number;
  /** Confidence at or above which a finding becomes an operator alert. */
  alertMinConfidence: number;
  batch: BlindReviewBatchConfig;
  window: BlindReviewWindowConfig;
  cost: BlindReviewCostConfig;
  retry: BlindReviewRetryConfig;
}

export const DEFAULT_BLIND_REVIEWER_CONFIG: BlindReviewerConfig = {
  enabled: false,
  intervalMs: 3_600_000,
  maxWorkers: 1,
  maxIngestPerRun: 64,
  recentSessionLimit: 16,
  alertMinConfidence: 0.7,
  batch: {
    maxItemsPerBatch: 24,
    minItemsPerBatch: 4,
    minBlindedCharsPerBatch: 0,
    maxBlindedCharsPerItem: 1_200,
    maxToolNamesPerItem: 12,
  },
  window: {
    maxRows: 2_000,
    retentionMs: 604_800_000,
    maxPinnedRows: 200,
  },
  cost: {
    maxReviewsPerRun: 2,
    maxOutputTokens: 400,
    deadlineMs: 60_000,
    costCeilingUsd: 0.25,
  },
  retry: {
    maxAttempts: 3,
    baseDelayMs: 30_000,
    maxDelayMs: 900_000,
  },
};

function validateBatch(raw: unknown, sourcePath: string): BlindReviewBatchConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: blindReviewer.batch must be an object`);
  }
  assertNoUnknownKeys(
    raw,
    [
      'maxItemsPerBatch',
      'minItemsPerBatch',
      'minBlindedCharsPerBatch',
      'maxBlindedCharsPerItem',
      'maxToolNamesPerItem',
    ],
    `${sourcePath}.blindReviewer.batch`,
    { errorPrefix: 'Invalid scheduler config' },
  );
  const batch: BlindReviewBatchConfig = {
    maxItemsPerBatch: toPositiveInteger(
      raw.maxItemsPerBatch,
      'blindReviewer.batch.maxItemsPerBatch',
      1,
    ),
    minItemsPerBatch: toPositiveInteger(
      raw.minItemsPerBatch,
      'blindReviewer.batch.minItemsPerBatch',
      1,
    ),
    minBlindedCharsPerBatch: toNonNegativeInteger(
      raw.minBlindedCharsPerBatch,
      'blindReviewer.batch.minBlindedCharsPerBatch',
    ),
    maxBlindedCharsPerItem: toPositiveInteger(
      raw.maxBlindedCharsPerItem,
      'blindReviewer.batch.maxBlindedCharsPerItem',
      64,
    ),
    maxToolNamesPerItem: toPositiveInteger(
      raw.maxToolNamesPerItem,
      'blindReviewer.batch.maxToolNamesPerItem',
      1,
    ),
  };
  if (batch.minItemsPerBatch > batch.maxItemsPerBatch) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: blindReviewer.batch.minItemsPerBatch `
      + `(${batch.minItemsPerBatch}) must not exceed blindReviewer.batch.maxItemsPerBatch `
      + `(${batch.maxItemsPerBatch}); otherwise no batch could ever reach the review floor`,
    );
  }
  return batch;
}

function validateWindow(
  raw: unknown,
  sourcePath: string,
  batch: BlindReviewBatchConfig,
  intervalMs: number,
): BlindReviewWindowConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: blindReviewer.window must be an object`);
  }
  assertNoUnknownKeys(
    raw,
    ['maxRows', 'retentionMs', 'maxPinnedRows'],
    `${sourcePath}.blindReviewer.window`,
    { errorPrefix: 'Invalid scheduler config' },
  );
  const window: BlindReviewWindowConfig = {
    maxRows: toPositiveInteger(raw.maxRows, 'blindReviewer.window.maxRows', 1),
    retentionMs: toInterval(raw.retentionMs, 'blindReviewer.window.retentionMs'),
    maxPinnedRows: toPositiveInteger(raw.maxPinnedRows, 'blindReviewer.window.maxPinnedRows', 1),
  };
  if (window.maxRows < batch.maxItemsPerBatch) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: blindReviewer.window.maxRows (${window.maxRows}) `
      + `must be at least blindReviewer.batch.maxItemsPerBatch (${batch.maxItemsPerBatch}); `
      + 'otherwise the window evicts rows the very batch that admitted them still needs',
    );
  }
  if (window.maxPinnedRows > window.maxRows) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: blindReviewer.window.maxPinnedRows `
      + `(${window.maxPinnedRows}) must not exceed blindReviewer.window.maxRows (${window.maxRows})`,
    );
  }
  if (window.retentionMs <= intervalMs) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: blindReviewer.window.retentionMs `
      + `(${window.retentionMs}) must exceed blindReviewer.intervalMs (${intervalMs}); `
      + 'otherwise evidence expires before the next run can ever review it',
    );
  }
  return window;
}

function validateCost(raw: unknown, sourcePath: string): BlindReviewCostConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: blindReviewer.cost must be an object`);
  }
  assertNoUnknownKeys(
    raw,
    ['maxReviewsPerRun', 'maxOutputTokens', 'deadlineMs', 'costCeilingUsd'],
    `${sourcePath}.blindReviewer.cost`,
    { errorPrefix: 'Invalid scheduler config' },
  );
  return {
    maxReviewsPerRun: toPositiveInteger(raw.maxReviewsPerRun, 'blindReviewer.cost.maxReviewsPerRun', 1),
    maxOutputTokens: toPositiveInteger(raw.maxOutputTokens, 'blindReviewer.cost.maxOutputTokens', 64),
    deadlineMs: toInterval(raw.deadlineMs, 'blindReviewer.cost.deadlineMs'),
    costCeilingUsd: toNumberAtLeast(raw.costCeilingUsd, 'blindReviewer.cost.costCeilingUsd', 0),
  };
}

function validateRetry(raw: unknown, sourcePath: string): BlindReviewRetryConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: blindReviewer.retry must be an object`);
  }
  assertNoUnknownKeys(
    raw,
    ['maxAttempts', 'baseDelayMs', 'maxDelayMs'],
    `${sourcePath}.blindReviewer.retry`,
    { errorPrefix: 'Invalid scheduler config' },
  );
  const retry: BlindReviewRetryConfig = {
    maxAttempts: toPositiveInteger(raw.maxAttempts, 'blindReviewer.retry.maxAttempts', 1),
    baseDelayMs: toInterval(raw.baseDelayMs, 'blindReviewer.retry.baseDelayMs'),
    maxDelayMs: toInterval(raw.maxDelayMs, 'blindReviewer.retry.maxDelayMs'),
  };
  if (retry.maxDelayMs < retry.baseDelayMs) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: blindReviewer.retry.maxDelayMs `
      + `(${retry.maxDelayMs}) must be greater than or equal to blindReviewer.retry.baseDelayMs `
      + `(${retry.baseDelayMs})`,
    );
  }
  return retry;
}

export function validateBlindReviewerConfig(
  value: unknown,
  sourcePath: string,
): BlindReviewerConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: blindReviewer must be an object`);
  }
  assertNoUnknownKeys(
    value,
    [
      'enabled',
      'intervalMs',
      'maxWorkers',
      'maxIngestPerRun',
      'recentSessionLimit',
      'alertMinConfidence',
      'batch',
      'window',
      'cost',
      'retry',
    ],
    `${sourcePath}.blindReviewer`,
    { errorPrefix: 'Invalid scheduler config' },
  );
  const intervalMs = toInterval(value.intervalMs, 'blindReviewer.intervalMs');
  const batch = validateBatch(value.batch, sourcePath);
  const maxIngestPerRun = toPositiveInteger(
    value.maxIngestPerRun,
    'blindReviewer.maxIngestPerRun',
    1,
  );
  if (maxIngestPerRun < batch.minItemsPerBatch) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: blindReviewer.maxIngestPerRun (${maxIngestPerRun}) `
      + `must be at least blindReviewer.batch.minItemsPerBatch (${batch.minItemsPerBatch}); `
      + 'otherwise a single run can never admit enough evidence to clear the review floor',
    );
  }
  return {
    enabled: toBoolean(value.enabled, 'blindReviewer.enabled'),
    intervalMs,
    maxWorkers: toPositiveInteger(value.maxWorkers, 'blindReviewer.maxWorkers', 1),
    maxIngestPerRun,
    recentSessionLimit: toPositiveInteger(
      value.recentSessionLimit,
      'blindReviewer.recentSessionLimit',
      1,
    ),
    alertMinConfidence: toUnitFactor(value.alertMinConfidence, 'blindReviewer.alertMinConfidence'),
    batch,
    window: validateWindow(value.window, sourcePath, batch, intervalMs),
    cost: validateCost(value.cost, sourcePath),
    retry: validateRetry(value.retry, sourcePath),
  };
}
