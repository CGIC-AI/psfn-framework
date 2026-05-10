import type Database from 'better-sqlite3';
import type {
  MemoryMaintenanceReview,
  MemoryMaintenanceReviewInput,
  MemoryMaintenanceReviewListOptions,
} from '../memory-store-port.js';
import {
  mapStoredMemoryMaintenanceReviewRow,
  normalizeMemoryMaintenanceReviewInput,
} from '../maintenance-review.js';
import type { MemoryMaintenanceReviewRow } from './types.js';

function clampReviewLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 100;
  return Math.max(1, Math.min(500, Math.floor(limit)));
}

function mapRow(row: MemoryMaintenanceReviewRow): MemoryMaintenanceReview {
  return mapStoredMemoryMaintenanceReviewRow({
    id: row.id,
    kind: row.kind,
    status: row.status,
    subjectMemoryId: row.subject_memory_id,
    candidateMemoryIdsJson: row.candidate_memory_ids,
    stateJson: row.state_json,
    quarantineReason: row.quarantine_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function upsertMemoryMaintenanceReview(
  db: Database.Database,
  input: MemoryMaintenanceReviewInput,
): MemoryMaintenanceReview {
  const review = normalizeMemoryMaintenanceReviewInput(input);
  db.prepare(`
    INSERT INTO l2_memory_maintenance_reviews (
      id, kind, status, subject_memory_id, candidate_memory_ids, state_json,
      quarantine_reason, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      status = excluded.status,
      subject_memory_id = excluded.subject_memory_id,
      candidate_memory_ids = excluded.candidate_memory_ids,
      state_json = excluded.state_json,
      quarantine_reason = excluded.quarantine_reason,
      updated_at = excluded.updated_at
  `).run(
    review.id,
    review.kind,
    review.status,
    review.subjectMemoryId,
    JSON.stringify(review.candidateMemoryIds),
    JSON.stringify(review.state),
    review.quarantineReason ?? null,
    review.createdAt,
    review.updatedAt,
  );
  return review;
}

export function listMemoryMaintenanceReviews(
  db: Database.Database,
  options: MemoryMaintenanceReviewListOptions = {},
): MemoryMaintenanceReview[] {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (options.status) {
    clauses.push('status = ?');
    values.push(options.status);
  }
  if (options.kind) {
    clauses.push('kind = ?');
    values.push(options.kind);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(clampReviewLimit(options.limit));
  const rows = db.prepare(`
    SELECT *
    FROM l2_memory_maintenance_reviews
    ${where}
    ORDER BY updated_at DESC, created_at DESC, id DESC
    LIMIT ?
  `).all(...values) as MemoryMaintenanceReviewRow[];
  return rows.map(mapRow);
}

export function getMemoryMaintenanceReview(
  db: Database.Database,
  id: string,
): MemoryMaintenanceReview | undefined {
  const normalized = id.trim();
  if (!normalized) return undefined;
  const row = db.prepare(`
    SELECT *
    FROM l2_memory_maintenance_reviews
    WHERE id = ?
    LIMIT 1
  `).get(normalized) as MemoryMaintenanceReviewRow | undefined;
  return row ? mapRow(row) : undefined;
}
