// ── Blind Reviewer lane: continuous, passive, off the hot path (yxz0z.3) ──
//
// One `runOnce()` pass is: ingest → prune → gate → (maybe) review → alert.
//
// What this lane deliberately CANNOT do is as important as what it does. It has
// no reference to the agent loop, no post-turn action, no gateway handle and no
// return value a caller could act on: there is no code path from a review
// result to a withhold, hold, cancel, rewrite or block. All three CogSec modes
// feed the same pass, and the mode is read once, to stamp provenance.
//
// Failure is CONTAINED but never silent. A reviewer that is slow, throwing, or
// unavailable is logged at error, counted in the run result, and recorded as a
// durable retry attempt with owner-file backoff; it does not fail the pass,
// because a broken reviewer must not take the rest of maintenance down with it,
// and it does not disappear, because after `retry.maxAttempts` the batch is
// abandoned with a loud error rather than retried forever. Ingest and store
// failures DO propagate: those mean the window itself is unsound.

import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { evaluateBlindReviewGate, type BlindReviewGateSkipReason } from './change-gate.js';
import {
  BLIND_REVIEW_ACTOR,
  BLIND_REVIEW_CHANNEL_ID,
  type BlindReviewEvidenceItem,
  type BlindReviewEvidenceSourcePort,
  type BlindReviewFinding,
  type BlindReviewStorePort,
  type BlindReviewerPort,
} from './contracts.js';
import type { BlindReviewerConfig } from '../../../system/config/scheduler-config/blind-review.js';
import { COGSEC_EVENT_SAFE_TEXT_MAX_CHARS } from '../intake/screening-envelope-policy.js';
import type { CogSecEventStore, CogSecSeverity } from '../events.js';
import type { CogSecMode } from '../../../shared/contracts/cogsec-mode.js';

const log = createComponentLogger('CogSecBlindReview');

/** CogSec case-id charset is `[A-Za-z0-9_-]`; the digest is already hex. */
const CASE_ID_DIGEST_CHARS = 32;
/**
 * Alert summaries are bounded by the CogSec event store's own safe-text
 * ceiling, derived rather than restated so the two can never drift apart.
 */
const MAX_ALERT_SUMMARY_CHARS = COGSEC_EVENT_SAFE_TEXT_MAX_CHARS;

/** Concern levels are ordered; only these three can alert. `none` never does. */
const ALERT_SEVERITY_BY_CONCERN: Readonly<Record<'low' | 'medium' | 'high', CogSecSeverity>> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

export type BlindReviewBatchOutcome =
  | { kind: 'skipped'; reason: BlindReviewGateSkipReason }
  | { kind: 'clean' }
  | { kind: 'alerted'; caseId: string; pinned: number }
  // The deterministic case id already exists: this exact batch was reported by
  // an earlier run. Not clean, and not a second alert.
  | { kind: 'duplicate'; caseId: string }
  | { kind: 'failed'; error: string };

export interface BlindReviewRunResult {
  /** CogSec mode the pass observed. Provenance only; behavior does not vary. */
  mode: CogSecMode;
  ingested: number;
  expired: number;
  evicted: number;
  /** Model calls this pass made. Zero whenever every batch was gated out. */
  modelCalls: number;
  batches: BlindReviewBatchOutcome[];
  window: { total: number; pinned: number; unreviewed: number };
}

export interface BlindReviewLaneOptions {
  config: BlindReviewerConfig;
  store: BlindReviewStorePort;
  source: BlindReviewEvidenceSourcePort;
  reviewer: BlindReviewerPort;
  /** Read once per pass. All three modes feed this one lane. */
  readMode: () => CogSecMode;
  /**
   * Provider, not instance: `cogsec-events.json` is written concurrently by the
   * gateway and Garden, so a fresh store per alert keeps the stale-clobber
   * window to the single write (same idiom as the incident observers).
   */
  cogSecEvents: () => Pick<CogSecEventStore, 'createEvent'>;
  now?: () => number;
}

function caseIdForBatch(digest: string): string {
  return `cogsec_blindreview_${digest.slice(0, CASE_ID_DIGEST_CHARS)}`;
}

/** Exponential backoff bounded by the owner file on both ends. */
function retryDelayMs(attempt: number, config: BlindReviewerConfig): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = config.retry.baseDelayMs * 2 ** exponent;
  return Math.min(config.retry.maxDelayMs, raw);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Run `tasks` with at most `limit` in flight. `maxWorkers` is an owner-file
 * bound on how much of the model budget one pass may spend concurrently, so it
 * has to actually gate concurrency rather than being decorative.
 */
async function withBoundedConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const task = tasks[index];
      if (!task) return;
      results[index] = await task();
    }
  });
  await Promise.all(workers);
  return results;
}

export class BlindReviewLane {
  private readonly options: BlindReviewLaneOptions;

  private readonly now: () => number;

  constructor(options: BlindReviewLaneOptions) {
    if (!options.config.enabled) {
      throw new Error('BlindReviewLane must not be constructed while blindReviewer.enabled is false');
    }
    this.options = options;
    this.now = options.now ?? (() => Date.now());
  }

  async runOnce(): Promise<BlindReviewRunResult> {
    const { config, store } = this.options;
    const mode = this.options.readMode();
    const startedAtMs = this.now();
    const state = await store.readState();

    const ingested = await this.ingest(state.ingestedThroughMs, startedAtMs);
    const pruned = await store.prune({
      nowMs: this.now(),
      retentionMs: config.window.retentionMs,
      maxRows: config.window.maxRows,
    });

    const batches: BlindReviewBatchOutcome[] = [];
    let modelCalls = 0;
    const backoffActive = state.retryNotBeforeMs > this.now();
    if (!backoffActive) {
      const reviewed = await this.reviewPending(mode, state.lastBatchDigest);
      batches.push(...reviewed.outcomes);
      modelCalls = reviewed.modelCalls;
      await this.settleState(state.ingestedThroughMs, ingested, reviewed);
    } else {
      log.info('Blind review pass deferred by retry backoff', {
        retryNotBeforeMs: state.retryNotBeforeMs,
        reviewAttempt: state.reviewAttempt,
      });
      await this.persistIngestWatermark(state, ingested);
    }

    const window = await store.countRows();
    return {
      mode,
      ingested: ingested.admitted,
      expired: pruned.expired,
      evicted: pruned.evicted,
      modelCalls,
      batches,
      window,
    };
  }

  /**
   * Pull already-durable evidence forward from the watermark. Bounded by
   * `maxIngestPerRun`, so a burst of activity bounds the lane's work rather
   * than the lane bounding the turn that produced it.
   */
  private async ingest(
    sinceMs: number,
    capturedAtMs: number,
  ): Promise<{ admitted: number; throughMs: number }> {
    const { config, source, store } = this.options;
    const items = await source.listEvidence({
      sinceMs,
      limit: config.maxIngestPerRun,
      maxBlindedCharsPerItem: config.batch.maxBlindedCharsPerItem,
    });
    if (items.length === 0) return { admitted: 0, throughMs: sinceMs };
    const admitted = await store.appendEvidence(items, capturedAtMs);
    const throughMs = items.reduce((newest, item) => Math.max(newest, item.occurredAtMs), sinceMs);
    return { admitted, throughMs };
  }

  private async reviewPending(
    mode: CogSecMode,
    lastBatchDigest: string | null,
  ): Promise<{
      outcomes: BlindReviewBatchOutcome[];
      modelCalls: number;
      lastReviewedDigest: string | null;
      failed: boolean;
    }> {
    const { config, store } = this.options;
    const pending = await store.listUnreviewed(
      config.cost.maxReviewsPerRun * config.batch.maxItemsPerBatch,
    );
    const candidateBatches = chunk(pending, config.batch.maxItemsPerBatch)
      .slice(0, config.cost.maxReviewsPerRun);
    if (candidateBatches.length === 0) {
      return {
        outcomes: [{ kind: 'skipped', reason: 'no_evidence' }],
        modelCalls: 0,
        lastReviewedDigest: null,
        failed: false,
      };
    }

    // Gate first, for every batch, before any model work is scheduled: an
    // unchanged or undersized batch must cost zero model calls.
    const admitted: { digest: string; items: BlindReviewEvidenceItem[] }[] = [];
    const outcomes: BlindReviewBatchOutcome[] = [];
    for (const batch of candidateBatches) {
      const decision = evaluateBlindReviewGate({
        items: batch,
        lastBatchDigest,
        config: config.batch,
      });
      if (!decision.review) {
        outcomes.push({ kind: 'skipped', reason: decision.reason });
        if (decision.reason === 'unchanged_digest') {
          // Byte-identical evidence already has an answer on record. Retire the
          // rows so the head advances instead of re-offering them forever.
          await store.markReviewed(batch.map(item => item.evidenceId), this.now());
        }
        continue;
      }
      admitted.push({ digest: decision.digest, items: decision.items });
    }
    if (admitted.length === 0) {
      return { outcomes, modelCalls: 0, lastReviewedDigest: null, failed: false };
    }

    const results = await withBoundedConcurrency(
      admitted.map(batch => async () => this.reviewBatch(mode, batch.digest, batch.items)),
      config.maxWorkers,
    );
    outcomes.push(...results);
    const failed = results.some(result => result.kind === 'failed');
    const lastAdmitted = admitted[admitted.length - 1];
    return {
      outcomes,
      modelCalls: admitted.length,
      lastReviewedDigest: failed || !lastAdmitted ? null : lastAdmitted.digest,
      failed,
    };
  }

  private async reviewBatch(
    mode: CogSecMode,
    digest: string,
    items: BlindReviewEvidenceItem[],
  ): Promise<BlindReviewBatchOutcome> {
    const { config, reviewer, store } = this.options;
    let finding: BlindReviewFinding;
    try {
      finding = await reviewer.review({
        mode,
        items,
        maxOutputTokens: config.cost.maxOutputTokens,
        deadlineMs: config.cost.deadlineMs,
        costCeilingUsd: config.cost.costCeilingUsd,
      });
    } catch (error) {
      const message = toErrorMessage(error);
      log.error('Blind review batch failed; evidence stays in the window for retry', {
        batchSize: items.length,
        error: message,
      });
      return { kind: 'failed', error: message };
    }
    const evidenceIds = items.map(item => item.evidenceId);
    await store.markReviewed(evidenceIds, this.now());
    const alerts = finding.concernLevel !== 'none'
      && finding.confidence >= config.alertMinConfidence;
    if (!alerts) return { kind: 'clean' };
    return this.raiseAlert(mode, digest, items, finding);
  }

  /**
   * Raise the operator alert and pin its evidence.
   *
   * Pinning happens only here: ordinary evidence ages out on the retention
   * clock, and only evidence an alert asks an operator to investigate is held
   * past it. Order matters — the case exists before its evidence is pinned to
   * it, so a crash in between leaves a case whose evidence expires normally
   * rather than pinned rows with no case to justify them.
   */
  private async raiseAlert(
    mode: CogSecMode,
    digest: string,
    items: BlindReviewEvidenceItem[],
    finding: BlindReviewFinding,
  ): Promise<BlindReviewBatchOutcome> {
    const caseId = caseIdForBatch(digest);
    const severity = ALERT_SEVERITY_BY_CONCERN[finding.concernLevel === 'none' ? 'low' : finding.concernLevel];
    const provenanceRefs = items.map(item => item.sourceRef);
    const created = this.createAlertEvent({
      caseId,
      severity,
      mode,
      finding,
      itemCount: items.length,
      provenanceRefs,
    });
    if (created === 'duplicate') return { kind: 'duplicate', caseId };
    if (created === 'failed') return { kind: 'failed', error: `alert ${caseId} could not be recorded` };
    const pin = await this.options.store.pinEvidence({
      evidenceIds: items.map(item => item.evidenceId),
      caseId,
      pinnedAtMs: this.now(),
      maxPinnedRows: this.options.config.window.maxPinnedRows,
    });
    if (pin.refused > 0) {
      log.error('Blind review pin ceiling reached; some alert evidence can still expire', {
        caseId,
        pinned: pin.pinned,
        refused: pin.refused,
        maxPinnedRows: this.options.config.window.maxPinnedRows,
      });
    }
    log.info('Blind review raised an operator alert', {
      caseId,
      severity,
      mode,
      evidenceRows: items.length,
      pinned: pin.pinned,
    });
    return { kind: 'alerted', caseId, pinned: pin.pinned };
  }

  /**
   * Write the case. `actions: []` is load-bearing: a Blind Reviewer alert is an
   * observation, so it never carries a seal/tombstone/revoke action and never
   * reflects a block or hold.
   *
   * The reviewer's own wording can trip the CogSec safe-text blocklist (it may
   * legitimately name an exploit-shaped pattern). Losing a security alert over
   * its wording would be the wrong failure, so a rejected summary is replaced
   * by a lane-authored, content-free one and the rejection is logged.
   */
  private createAlertEvent(input: {
    caseId: string;
    severity: CogSecSeverity;
    mode: CogSecMode;
    finding: BlindReviewFinding;
    itemCount: number;
    provenanceRefs: string[];
  }): 'created' | 'duplicate' | 'failed' {
    const prefix = `Blind review: ${input.finding.concernLevel} concern over `
      + `${input.itemCount} bounded evidence rows in ${input.mode} mode `
      + `(confidence ${input.finding.confidence.toFixed(2)}).`;
    const withFinding = `${prefix} ${input.finding.safeSummary}`.slice(0, MAX_ALERT_SUMMARY_CHARS);
    const create = (safeAgentSummary: string): void => {
      this.options.cogSecEvents().createEvent({
        caseId: input.caseId,
        type: 'blind_review',
        severity: input.severity,
        status: 'open',
        sourceChannelId: BLIND_REVIEW_CHANNEL_ID,
        actor: BLIND_REVIEW_ACTOR,
        actions: [],
        safeAgentSummary,
        sealedForensicPayloadRefs: input.provenanceRefs,
      });
    };
    try {
      create(withFinding);
      return 'created';
    } catch (error) {
      const message = toErrorMessage(error);
      if (message.includes('already exists')) {
        log.info('Blind review case already recorded for this batch', { caseId: input.caseId });
        return 'duplicate';
      }
      log.error('Blind review summary rejected by CogSec safe text; alerting without it', {
        caseId: input.caseId,
        error: message,
      });
    }
    try {
      create(prefix.slice(0, MAX_ALERT_SUMMARY_CHARS));
      return 'created';
    } catch (error) {
      log.error('Blind review alert could not be recorded', {
        caseId: input.caseId,
        error: toErrorMessage(error),
      });
      return 'failed';
    }
  }

  private async persistIngestWatermark(
    state: { ingestedThroughMs: number },
    ingested: { throughMs: number },
  ): Promise<void> {
    if (ingested.throughMs <= state.ingestedThroughMs) return;
    const current = await this.options.store.readState();
    await this.options.store.writeState({
      ...current,
      ingestedThroughMs: ingested.throughMs,
      updatedAtMs: this.now(),
    });
  }

  /**
   * Persist the pass: the ingest watermark always, plus either a cleared retry
   * budget or the next backoff. After `retry.maxAttempts` the head batch is
   * abandoned — its rows are retired with a loud error so a permanently broken
   * reviewer cannot wedge the window.
   */
  private async settleState(
    previousThroughMs: number,
    ingested: { throughMs: number },
    reviewed: { lastReviewedDigest: string | null; failed: boolean },
  ): Promise<void> {
    const { config, store } = this.options;
    const current = await store.readState();
    const nowMs = this.now();
    const base = {
      ...current,
      ingestedThroughMs: Math.max(previousThroughMs, ingested.throughMs, current.ingestedThroughMs),
      updatedAtMs: nowMs,
    };
    if (!reviewed.failed) {
      await store.writeState({
        ...base,
        ...(reviewed.lastReviewedDigest ? { lastBatchDigest: reviewed.lastReviewedDigest } : {}),
        reviewAttempt: 0,
        retryNotBeforeMs: 0,
      });
      return;
    }
    const attempt = current.reviewAttempt + 1;
    if (attempt >= config.retry.maxAttempts) {
      const abandoned = await store.listUnreviewed(config.batch.maxItemsPerBatch);
      await store.markReviewed(abandoned.map(item => item.evidenceId), nowMs);
      log.error('Blind review abandoned a batch after exhausting its owner-file retry budget', {
        attempts: attempt,
        maxAttempts: config.retry.maxAttempts,
        abandonedRows: abandoned.length,
      });
      await store.writeState({ ...base, reviewAttempt: 0, retryNotBeforeMs: 0 });
      return;
    }
    await store.writeState({
      ...base,
      reviewAttempt: attempt,
      retryNotBeforeMs: nowMs + retryDelayMs(attempt, config),
    });
  }
}
