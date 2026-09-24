import { executeQuery, queryRows } from '../../../persistence/postgres.js';
import type {
  MemoryMaintenanceDiagnostics,
  MemoryMaintenanceDiagnosticsOptions,
  MemoryMaintenanceReview,
  MemoryMaintenanceReviewInput,
  MemoryMaintenanceReviewListOptions,
} from '../memory-store-port.js';
import {
  mapStoredMemoryMaintenanceReviewRow,
  normalizeMemoryMaintenanceReviewInput,
} from '../maintenance-review.js';
import type { MemoryMaintenanceReviewPgRow } from './rows.js';
import { parsePgNumber, serializeJsonValue } from './rows.js';
import { clampLimit, increment } from './utils.js';
import type { MemoryEvolutionDecisionSummary } from './memory-links.js';
import type { PostgresMemoryStoreCollaboratorContext } from './collaborator-context.js';

function fromMaintenanceReviewRow(row: MemoryMaintenanceReviewPgRow): MemoryMaintenanceReview {
  return mapStoredMemoryMaintenanceReviewRow({
    id: row.id,
    kind: row.kind,
    status: row.status,
    subjectMemoryId: row.subject_memory_id,
    candidateMemoryIdsJson: serializeJsonValue(row.candidate_memory_ids),
    stateJson: serializeJsonValue(row.state_json),
    quarantineReason: row.quarantine_reason,
    createdAt: parsePgNumber(row.created_at, 'l2_memory_maintenance_reviews.created_at'),
    updatedAt: parsePgNumber(row.updated_at, 'l2_memory_maintenance_reviews.updated_at'),
  });
}

const MAINTENANCE_REVIEW_COLUMNS = `
  id, kind, status, subject_memory_id, candidate_memory_ids, state_json,
  quarantine_reason, created_at, updated_at
`;

/**
 * Memory maintenance reviews for PostgresMemoryStore
 * (`l2_memory_maintenance_reviews`) plus the maintenance diagnostics that
 * summarize them alongside the recorded evolution decisions. Reviews are read
 * at query time (t4mia); nothing is hydrated into process memory.
 */
export class PostgresMemoryMaintenanceReviewStore {
  constructor(
    private readonly ctx: Pick<PostgresMemoryStoreCollaboratorContext, 'pool' | 'persist'>,
    private readonly evolutionDecisions: () => Promise<MemoryEvolutionDecisionSummary>,
  ) {}

  async upsertMemoryMaintenanceReview(input: MemoryMaintenanceReviewInput): Promise<MemoryMaintenanceReview> {
    const review = normalizeMemoryMaintenanceReviewInput(input);
    await this.ctx.persist(async () => {
      await executeQuery(this.ctx.pool, `
        INSERT INTO l2_memory_maintenance_reviews (
          id, kind, status, subject_memory_id, candidate_memory_ids, state_json,
          quarantine_reason, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (id) DO UPDATE SET
          kind = EXCLUDED.kind,
          status = EXCLUDED.status,
          subject_memory_id = EXCLUDED.subject_memory_id,
          candidate_memory_ids = EXCLUDED.candidate_memory_ids,
          state_json = EXCLUDED.state_json,
          quarantine_reason = EXCLUDED.quarantine_reason,
          updated_at = EXCLUDED.updated_at
      `, [
        review.id,
        review.kind,
        review.status,
        review.subjectMemoryId,
        serializeJsonValue(review.candidateMemoryIds),
        serializeJsonValue(review.state),
        review.quarantineReason ?? null,
        review.createdAt,
        review.updatedAt,
      ]);
    });
    return review;
  }

  async listMemoryMaintenanceReviews(
    options: MemoryMaintenanceReviewListOptions = {},
  ): Promise<MemoryMaintenanceReview[]> {
    const rows = await queryRows<MemoryMaintenanceReviewPgRow>(this.ctx.pool, `
      SELECT ${MAINTENANCE_REVIEW_COLUMNS}
      FROM l2_memory_maintenance_reviews
      WHERE ($1::text IS NULL OR status = $1)
        AND ($2::text IS NULL OR kind = $2)
      ORDER BY updated_at DESC, created_at DESC, id ASC
      LIMIT $3
    `, [options.status ?? null, options.kind ?? null, clampLimit(options.limit, 100, 1, 500)]);
    // A malformed stored row decodes as quarantined; it never answers a filter
    // its decoded status/kind does not match.
    return rows
      .map(fromMaintenanceReviewRow)
      .filter(review => options.status === undefined || review.status === options.status)
      .filter(review => options.kind === undefined || review.kind === options.kind);
  }

  async getMemoryMaintenanceReview(id: string): Promise<MemoryMaintenanceReview | undefined> {
    const rows = await queryRows<MemoryMaintenanceReviewPgRow>(this.ctx.pool, `
      SELECT ${MAINTENANCE_REVIEW_COLUMNS}
      FROM l2_memory_maintenance_reviews
      WHERE id = $1
    `, [id.trim()]);
    const row = rows.at(0);
    return row ? fromMaintenanceReviewRow(row) : undefined;
  }

  async getMemoryMaintenanceDiagnostics(
    options: MemoryMaintenanceDiagnosticsOptions = {},
  ): Promise<MemoryMaintenanceDiagnostics> {
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const groups = await queryRows<{ kind: string; status: string; count: unknown }>(this.ctx.pool, `
      SELECT kind, status, COUNT(*) AS count
      FROM l2_memory_maintenance_reviews
      GROUP BY kind, status
    `);
    const pendingRows = await queryRows<{ count: unknown; oldest: unknown; average: unknown }>(this.ctx.pool, `
      SELECT COUNT(*) AS count,
             MAX(GREATEST(0, $1::double precision - created_at)) AS oldest,
             AVG(GREATEST(0, $1::double precision - created_at)) AS average
      FROM l2_memory_maintenance_reviews
      WHERE status = 'pending'
    `, [now]);
    const reviewCountsByKind: Record<string, number> = {};
    const reviewCountsByStatus: Record<string, number> = {};
    let reviewCount = 0;
    for (const group of groups) {
      const count = parsePgNumber(group.count, 'l2_memory_maintenance_reviews.count');
      increment(reviewCountsByKind, group.kind, count);
      increment(reviewCountsByStatus, group.status, count);
      reviewCount += count;
    }
    const pending = pendingRows.at(0);
    const pendingReviewCount = pending ? parsePgNumber(pending.count, 'pending.count') : 0;
    const evolution = await this.evolutionDecisions();
    return {
      reviewCount,
      pendingReviewCount,
      reviewCountsByKind,
      reviewCountsByStatus,
      oldestPendingReviewAgeMs: pendingReviewCount > 0 && pending
        ? parsePgNumber(pending.oldest, 'pending.oldest')
        : 0,
      averagePendingReviewAgeMs: pendingReviewCount > 0 && pending
        ? parsePgNumber(pending.average, 'pending.average')
        : 0,
      evolutionDecisionCount: evolution.total,
      evolutionDecisionCountsByRelation: { ...evolution.byRelation },
      supersessionDecisionCount: evolution.byRelation.supersedes,
      conflictDecisionCount: evolution.byRelation.conflicts_with
        + evolution.byRelation.negates,
      ...(evolution.latestCreatedAt !== undefined && evolution.latestCreatedAt > 0
        ? { latestEvolutionDecisionAt: evolution.latestCreatedAt }
        : {}),
    };
  }
}
