import { executeQuery, queryRows } from '../../../persistence/postgres.js';
import type {
  MemoryEvolutionLink,
  MemoryEvolutionRelation,
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
import { serializeJsonValue } from './rows.js';
import { clampLimit, increment } from './utils.js';
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/**
 * Memory maintenance reviews for PostgresMemoryStore
 * (`l2_memory_maintenance_reviews`) plus the maintenance diagnostics that
 * summarize them alongside the recorded evolution decisions.
 */
export class PostgresMemoryMaintenanceReviewStore {
  private readonly maintenanceReviews = new Map<string, MemoryMaintenanceReview>();

  constructor(
    private readonly ctx: Pick<PostgresMemoryStoreCollaboratorContext, 'pool' | 'persist'>,
    private readonly evolutionLinks: () => ReadonlyMap<string, MemoryEvolutionLink>,
  ) {}

  async hydrate(): Promise<void> {
    const maintenanceReviewRows = await queryRows<MemoryMaintenanceReviewPgRow>(this.ctx.pool, `
      SELECT
        id, kind, status, subject_memory_id, candidate_memory_ids, state_json,
        quarantine_reason, created_at, updated_at
      FROM l2_memory_maintenance_reviews
    `);
    for (const row of maintenanceReviewRows) {
      const review = fromMaintenanceReviewRow(row);
      this.maintenanceReviews.set(review.id, review);
    }
  }

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
    this.maintenanceReviews.set(review.id, review);
    return review;
  }

  async listMemoryMaintenanceReviews(
    options: MemoryMaintenanceReviewListOptions = {},
  ): Promise<MemoryMaintenanceReview[]> {
    return Array.from(this.maintenanceReviews.values())
      .filter(review => options.status === undefined || review.status === options.status)
      .filter(review => options.kind === undefined || review.kind === options.kind)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
      .slice(0, clampLimit(options.limit, 100, 1, 500));
  }

  async getMemoryMaintenanceReview(id: string): Promise<MemoryMaintenanceReview | undefined> {
    return this.maintenanceReviews.get(id.trim());
  }

  async getMemoryMaintenanceDiagnostics(
    options: MemoryMaintenanceDiagnosticsOptions = {},
  ): Promise<MemoryMaintenanceDiagnostics> {
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const reviewCountsByKind: Record<string, number> = {};
    const reviewCountsByStatus: Record<string, number> = {};
    const pendingReviewAges: number[] = [];
    for (const review of this.maintenanceReviews.values()) {
      increment(reviewCountsByKind, review.kind);
      increment(reviewCountsByStatus, review.status);
      if (review.status === 'pending') {
        pendingReviewAges.push(Math.max(0, now - review.createdAt));
      }
    }

    const memoryEvolutionLinks = this.evolutionLinks();
    const evolutionDecisionCountsByRelation: Record<MemoryEvolutionRelation, number> = {
      supersedes: 0,
      updates: 0,
      negates: 0,
      conflicts_with: 0,
    };
    let latestEvolutionDecisionAt: number | undefined;
    for (const link of memoryEvolutionLinks.values()) {
      evolutionDecisionCountsByRelation[link.relation] += 1;
      latestEvolutionDecisionAt = Math.max(latestEvolutionDecisionAt ?? 0, link.createdAt);
    }

    const pendingAgeTotal = pendingReviewAges.reduce((sum, age) => sum + age, 0);
    return {
      reviewCount: this.maintenanceReviews.size,
      pendingReviewCount: pendingReviewAges.length,
      reviewCountsByKind,
      reviewCountsByStatus,
      oldestPendingReviewAgeMs: pendingReviewAges.length > 0 ? Math.max(...pendingReviewAges) : 0,
      averagePendingReviewAgeMs: pendingReviewAges.length > 0
        ? pendingAgeTotal / pendingReviewAges.length
        : 0,
      evolutionDecisionCount: memoryEvolutionLinks.size,
      evolutionDecisionCountsByRelation,
      supersessionDecisionCount: evolutionDecisionCountsByRelation.supersedes,
      conflictDecisionCount: evolutionDecisionCountsByRelation.conflicts_with
        + evolutionDecisionCountsByRelation.negates,
      ...(latestEvolutionDecisionAt !== undefined && latestEvolutionDecisionAt > 0
        ? { latestEvolutionDecisionAt }
        : {}),
    };
  }
}
