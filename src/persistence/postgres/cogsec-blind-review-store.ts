// ── Postgres Blind Reviewer window (bead psfn-framework-yxz0z.3) ──
//
// The durable half of the passive reviewer: a rolling, bounded window of
// already-reduced evidence, the lane's ingest/review watermarks, and the pin
// that holds evidence past retention when an alert asks an operator to look at
// it.
//
// Three properties this adapter owes the lane:
//
//   * Idempotent ingest. Evidence identity is a digest of the source ref, so a
//     re-read of the same turn is `DO NOTHING`, not a duplicate row.
//   * Restart recovery. Every decision the lane makes across runs — how far
//     ingest reached, which rows are still unreviewed, which batch digest was
//     last answered, how many retries a failing batch has spent — is a row
//     here, so a fresh process resumes rather than restarting.
//   * Pinned evidence survives retention. Deletes are constrained to
//     `pinned_case_id IS NULL` in SQL, not in TypeScript, so no caller can
//     accidentally prune the evidence under an open case.
//
// Rows are re-validated on the way out: a row whose shape no longer matches the
// contract is a load failure, not a quiet review input.

import type { Pool, QueryResultRow } from 'pg';

import {
  BLIND_REVIEW_PROCESSOR,
  emptyBlindReviewLaneState,
  type BlindReviewEvidenceItem,
  type BlindReviewGateSavings,
  type BlindReviewLaneState,
  type BlindReviewPinResult,
  type BlindReviewPruneRequest,
  type BlindReviewPruneResult,
  type BlindReviewStorePort,
} from '../../core/cogsec/blind-review/contracts.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  createPostgresPool,
  ensurePostgresSchema,
  executeQuery,
  queryOne,
  queryRows,
} from '../postgres.js';
import { POSTGRES_COGSEC_BLIND_REVIEW_MIGRATIONS } from './migrations.js';

interface EvidenceRow extends QueryResultRow {
  evidence_id: string;
  source_ref: string;
  occurred_at_ms: string | number;
  disclosure: string;
  activity_json: unknown;
  blinded_excerpt: string;
  content_digest: string;
}

interface StateRow extends QueryResultRow {
  ingested_through_ms: string | number;
  last_batch_digest: string | null;
  review_attempt: number;
  retry_not_before_ms: string | number;
  updated_at_ms: string | number;
}

interface SavingsRow extends QueryResultRow {
  model_calls_avoided: string | number;
  model_calls_avoided_at_ms: string | number;
}

interface CountRow extends QueryResultRow {
  total: string | number;
  pinned: string | number;
  unreviewed: string | number;
}

/** `pg` returns BIGINT as a string to preserve precision; these fit in a double. */
function toNumber(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Blind review store ${field} is not a finite number`);
  }
  return parsed;
}

function toNumberField(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Blind review evidence ${field} must be a non-negative number`);
  }
  return value;
}

function toActivitySignals(value: unknown): BlindReviewEvidenceItem['activity'] {
  if (!isRecord(value)) {
    throw new Error('Blind review evidence activity_json must be an object');
  }
  const toolNames = value.toolNames;
  if (!Array.isArray(toolNames) || toolNames.some(name => typeof name !== 'string')) {
    throw new Error('Blind review evidence activity.toolNames must be a string array');
  }
  return {
    toolCallCount: toNumberField(value.toolCallCount, 'activity.toolCallCount'),
    toolNames: [...toolNames] as string[],
    toolErrorCount: toNumberField(value.toolErrorCount, 'activity.toolErrorCount'),
    assistantChars: toNumberField(value.assistantChars, 'activity.assistantChars'),
    userChars: toNumberField(value.userChars, 'activity.userChars'),
    extractedMemoryCount: toNumberField(value.extractedMemoryCount, 'activity.extractedMemoryCount'),
    durationMs: toNumberField(value.durationMs, 'activity.durationMs'),
  };
}

function mapEvidenceRow(row: EvidenceRow): BlindReviewEvidenceItem {
  if (row.disclosure !== 'structural_only' && row.disclosure !== 'blinded_excerpt') {
    throw new Error(`Blind review evidence ${row.evidence_id} has an unknown disclosure class`);
  }
  return {
    evidenceId: row.evidence_id,
    sourceRef: row.source_ref,
    occurredAtMs: toNumber(row.occurred_at_ms, 'occurred_at_ms'),
    disclosure: row.disclosure,
    activity: toActivitySignals(row.activity_json),
    blindedExcerpt: row.blinded_excerpt,
    contentDigest: row.content_digest,
  };
}

export class PostgresCogSecBlindReviewStore implements BlindReviewStorePort {
  private constructor(private readonly pool: Pool, private readonly ownsPool: boolean) {}

  static async connect(
    databaseUrl: string,
    options: { schema?: string; role?: string } = {},
  ): Promise<PostgresCogSecBlindReviewStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'cogsec-blind-review',
      allowExitOnIdle: true,
      ...(options.schema ? { schema: options.schema } : {}),
      ...(options.role ? { role: options.role } : {}),
    });
    await ensurePostgresSchema(pool, POSTGRES_COGSEC_BLIND_REVIEW_MIGRATIONS);
    return new PostgresCogSecBlindReviewStore(pool, true);
  }

  /** Test/embedding entry point: the caller owns the pool lifecycle. */
  static async fromPool(pool: Pool): Promise<PostgresCogSecBlindReviewStore> {
    await ensurePostgresSchema(pool, POSTGRES_COGSEC_BLIND_REVIEW_MIGRATIONS);
    return new PostgresCogSecBlindReviewStore(pool, false);
  }

  async appendEvidence(
    items: readonly BlindReviewEvidenceItem[],
    capturedAtMs: number,
  ): Promise<number> {
    if (items.length === 0) return 0;
    let admitted = 0;
    for (const item of items) {
      const result = await executeQuery(this.pool, `
        INSERT INTO cogsec_blind_review_evidence (
          evidence_id, source_ref, occurred_at_ms, captured_at_ms,
          disclosure, activity_json, blinded_excerpt, content_digest
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
        ON CONFLICT (evidence_id) DO NOTHING
      `, [
        item.evidenceId,
        item.sourceRef,
        item.occurredAtMs,
        capturedAtMs,
        item.disclosure,
        JSON.stringify(item.activity),
        item.blindedExcerpt,
        item.contentDigest,
      ]);
      admitted += result.rowCount ?? 0;
    }
    return admitted;
  }

  async readState(): Promise<BlindReviewLaneState> {
    const row = await queryOne<StateRow>(this.pool, `
      SELECT ingested_through_ms, last_batch_digest, review_attempt,
             retry_not_before_ms, updated_at_ms
      FROM cogsec_blind_review_state
      WHERE processor = $1
    `, [BLIND_REVIEW_PROCESSOR]);
    if (!row) return emptyBlindReviewLaneState(0);
    return {
      ingestedThroughMs: toNumber(row.ingested_through_ms, 'ingested_through_ms'),
      lastBatchDigest: row.last_batch_digest,
      reviewAttempt: row.review_attempt,
      retryNotBeforeMs: toNumber(row.retry_not_before_ms, 'retry_not_before_ms'),
      updatedAtMs: toNumber(row.updated_at_ms, 'updated_at_ms'),
    };
  }

  async writeState(state: BlindReviewLaneState): Promise<void> {
    await executeQuery(this.pool, `
      INSERT INTO cogsec_blind_review_state (
        processor, ingested_through_ms, last_batch_digest,
        review_attempt, retry_not_before_ms, updated_at_ms
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (processor) DO UPDATE SET
        ingested_through_ms = EXCLUDED.ingested_through_ms,
        last_batch_digest = EXCLUDED.last_batch_digest,
        review_attempt = EXCLUDED.review_attempt,
        retry_not_before_ms = EXCLUDED.retry_not_before_ms,
        updated_at_ms = EXCLUDED.updated_at_ms
    `, [
      BLIND_REVIEW_PROCESSOR,
      state.ingestedThroughMs,
      state.lastBatchDigest,
      state.reviewAttempt,
      state.retryNotBeforeMs,
      state.updatedAtMs,
    ]);
  }

  async listUnreviewed(limit: number): Promise<BlindReviewEvidenceItem[]> {
    if (limit <= 0) return [];
    const rows = await queryRows<EvidenceRow>(this.pool, `
      SELECT evidence_id, source_ref, occurred_at_ms, disclosure,
             activity_json, blinded_excerpt, content_digest
      FROM cogsec_blind_review_evidence
      WHERE reviewed_at_ms IS NULL
      ORDER BY occurred_at_ms ASC, evidence_id ASC
      LIMIT $1
    `, [limit]);
    return rows.map(mapEvidenceRow);
  }

  async markReviewed(evidenceIds: readonly string[], reviewedAtMs: number): Promise<number> {
    if (evidenceIds.length === 0) return 0;
    const result = await executeQuery(this.pool, `
      UPDATE cogsec_blind_review_evidence
      SET reviewed_at_ms = $2
      WHERE evidence_id = ANY($1::text[]) AND reviewed_at_ms IS NULL
    `, [[...evidenceIds], reviewedAtMs]);
    return result.rowCount ?? 0;
  }

  /**
   * Pin up to the remaining ceiling, oldest evidence first, and report what the
   * ceiling refused. Refusing loudly beats silently unpinning older evidence:
   * an operator investigating an earlier case must not lose its material
   * because a later case needed room.
   */
  async pinEvidence(input: {
    evidenceIds: readonly string[];
    caseId: string;
    pinnedAtMs: number;
    maxPinnedRows: number;
  }): Promise<BlindReviewPinResult> {
    if (input.evidenceIds.length === 0) return { pinned: 0, refused: 0 };
    const existing = await queryOne<{ pinned: string | number }>(
      this.pool,
      'SELECT COUNT(*) AS pinned FROM cogsec_blind_review_evidence WHERE pinned_case_id IS NOT NULL',
    );
    const alreadyPinned = existing ? toNumber(existing.pinned, 'pinned') : 0;
    const capacity = Math.max(0, input.maxPinnedRows - alreadyPinned);
    if (capacity === 0) return { pinned: 0, refused: input.evidenceIds.length };
    const result = await executeQuery(this.pool, `
      UPDATE cogsec_blind_review_evidence
      SET pinned_case_id = $2, pinned_at_ms = $3
      WHERE evidence_id IN (
        SELECT evidence_id
        FROM cogsec_blind_review_evidence
        WHERE evidence_id = ANY($1::text[]) AND pinned_case_id IS NULL
        ORDER BY occurred_at_ms ASC, evidence_id ASC
        LIMIT $4
      )
    `, [[...input.evidenceIds], input.caseId, input.pinnedAtMs, capacity]);
    const pinned = result.rowCount ?? 0;
    return { pinned, refused: Math.max(0, input.evidenceIds.length - pinned) };
  }

  /**
   * Retention expiry, then capacity eviction. Both deletes are restricted to
   * unpinned rows in SQL. Capacity eviction removes the OLDEST unpinned rows,
   * which is what keeps the window rolling under sustained ingest instead of
   * rejecting new evidence.
   */
  async prune(request: BlindReviewPruneRequest): Promise<BlindReviewPruneResult> {
    const cutoffMs = request.nowMs - request.retentionMs;
    const expiredResult = await executeQuery(this.pool, `
      DELETE FROM cogsec_blind_review_evidence
      WHERE pinned_case_id IS NULL AND occurred_at_ms <= $1
    `, [cutoffMs]);
    const evictedResult = await executeQuery(this.pool, `
      DELETE FROM cogsec_blind_review_evidence
      WHERE evidence_id IN (
        SELECT evidence_id FROM cogsec_blind_review_evidence
        WHERE pinned_case_id IS NULL
        ORDER BY occurred_at_ms ASC, evidence_id ASC
        LIMIT GREATEST(0, (SELECT COUNT(*) FROM cogsec_blind_review_evidence) - $1)
      )
    `, [request.maxRows]);
    return {
      expired: expiredResult.rowCount ?? 0,
      evicted: evictedResult.rowCount ?? 0,
    };
  }

  async countRows(): Promise<{ total: number; pinned: number; unreviewed: number }> {
    const row = await queryOne<CountRow>(this.pool, `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE pinned_case_id IS NOT NULL) AS pinned,
        COUNT(*) FILTER (WHERE reviewed_at_ms IS NULL) AS unreviewed
      FROM cogsec_blind_review_evidence
    `);
    if (!row) return { total: 0, pinned: 0, unreviewed: 0 };
    return {
      total: toNumber(row.total, 'total'),
      pinned: toNumber(row.pinned, 'pinned'),
      unreviewed: toNumber(row.unreviewed, 'unreviewed'),
    };
  }

  /**
   * Additive, single-statement increment. The `+` happens in SQL rather than in
   * TypeScript so a cumulative total can never be rolled back to a stale value
   * a caller happened to read earlier, and the row is created on first use with
   * zeroed lane state — an untouched watermark, which is exactly what a lane
   * that has only ever gated batches out has.
   */
  async recordModelCallsAvoided(count: number, atMs: number): Promise<void> {
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error('Blind review avoided-call count must be a positive integer');
    }
    if (!Number.isInteger(atMs) || atMs < 0) {
      throw new Error('Blind review avoided-call timestamp must be a non-negative integer');
    }
    await executeQuery(this.pool, `
      INSERT INTO cogsec_blind_review_state (
        processor, ingested_through_ms, last_batch_digest,
        review_attempt, retry_not_before_ms, updated_at_ms,
        model_calls_avoided, model_calls_avoided_at_ms
      ) VALUES ($1, 0, NULL, 0, 0, 0, $2, $3)
      ON CONFLICT (processor) DO UPDATE SET
        model_calls_avoided
          = cogsec_blind_review_state.model_calls_avoided + EXCLUDED.model_calls_avoided,
        model_calls_avoided_at_ms = EXCLUDED.model_calls_avoided_at_ms
    `, [BLIND_REVIEW_PROCESSOR, count, atMs]);
  }

  async readModelCallsAvoided(): Promise<BlindReviewGateSavings> {
    const row = await queryOne<SavingsRow>(this.pool, `
      SELECT model_calls_avoided, model_calls_avoided_at_ms
      FROM cogsec_blind_review_state
      WHERE processor = $1
    `, [BLIND_REVIEW_PROCESSOR]);
    if (!row) return { modelCallsAvoided: 0, lastAvoidedAtMs: 0 };
    const savings = {
      modelCallsAvoided: toNumber(row.model_calls_avoided, 'model_calls_avoided'),
      lastAvoidedAtMs: toNumber(row.model_calls_avoided_at_ms, 'model_calls_avoided_at_ms'),
    };
    // The DDL floor is re-asserted on the way out: a row edited in the database
    // past its CHECK is a load failure, not a quiet operator statistic.
    if (savings.modelCallsAvoided < 0 || savings.lastAvoidedAtMs < 0) {
      throw new Error('Blind review gate savings must be non-negative');
    }
    return savings;
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
