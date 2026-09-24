import type { Pool } from 'pg';
import { queryRows } from '../../../persistence/postgres.js';
import type {
  MemoryAdminListOptions,
  MemoryAdminListResult,
  MemoryAdminPrivacySummary,
} from '../memory-store-port.js';
import type {
  AdminMemoryPrivacyAggregateRow,
  CountRow,
  MemoryRow,
  SensitivityCountRow,
} from './rows.js';
import { parsePgNumber, tryFromMemoryRow } from './rows.js';
import { clampLimit } from './utils.js';
import {
  ADMIN_DURABLE_MEMORY_TAGS,
  ADMIN_FAVORITE_TEXT_REGEX,
  ADMIN_PREFERENCE_MEMORY_TAGS,
  ADMIN_PREFERENCE_TEXT_REGEX,
  addPostgresQueryValue,
  activeAdminMemoryClause,
  buildPostgresAdminMemoryWhere,
  durableAdminMemoryCondition,
  mapPostgresAdminPrivacySummary,
  preferenceAdminMemoryCondition,
} from './admin.js';

/**
 * Raw (system-internal, not subject-authorized) operator admin reads over
 * `l2_memories`: a filtered, paged listing and the active-corpus privacy
 * summary. Both run as bounded SQL on the pool; the subject-authorized
 * equivalents live in subject-admin-queries.ts.
 */
export async function listPostgresAdminMemories(
  pool: Pool,
  options: MemoryAdminListOptions = {},
): Promise<MemoryAdminListResult> {
  const limit = clampLimit(options.limit, 50, 1, 500);
  const offset = clampLimit(options.offset, 0, 0, 100_000);
  const where = buildPostgresAdminMemoryWhere(options);
  const pageValues = [
    ...where.values,
    limit,
    offset,
  ];
  const limitParam = `$${where.values.length + 1}`;
  const offsetParam = `$${where.values.length + 2}`;
  const rows = await queryRows<MemoryRow>(pool, `
      SELECT
        id, text, type, importance, confidence, emotional_valence, formation_vad, emotional_texture,
        salience, salience_decay_anchor_at, source_ref, source_type, provenance_json, extracted_at, last_accessed,
        access_count, superseded_by,
        tags, scope_ref_kind, scope_ref_id, scope_ref_label, scope_tags, provenance_refs,
        retention_class, sensitivity, consent_flags, contact_id, deleted_at, deleted_by,
        delete_reason, embedding::text AS embedding
      FROM l2_memories
      WHERE ${where.sql}
      ORDER BY extracted_at DESC, id DESC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `, pageValues);
  const totalRows = await queryRows<CountRow>(pool, `
      SELECT COUNT(*) AS count
      FROM l2_memories
      WHERE ${where.sql}
    `, where.values);
  return {
    memories: rows.flatMap((row) => {
      const memory = tryFromMemoryRow(row);
      return memory ? [memory] : [];
    }),
    total: totalRows[0] ? parsePgNumber(totalRows[0].count, 'count') : 0,
    privacySummary: await queryPostgresAdminMemoryPrivacySummary(pool),
  };
}

export async function queryPostgresAdminMemoryPrivacySummary(
  pool: Pool,
): Promise<MemoryAdminPrivacySummary> {
  const values: unknown[] = [];
  const durableCondition = durableAdminMemoryCondition(
    addPostgresQueryValue(values, [...ADMIN_DURABLE_MEMORY_TAGS]),
  );
  const preferenceCondition = preferenceAdminMemoryCondition(
    addPostgresQueryValue(values, [...ADMIN_PREFERENCE_MEMORY_TAGS]),
    addPostgresQueryValue(values, ADMIN_FAVORITE_TEXT_REGEX),
    addPostgresQueryValue(values, ADMIN_PREFERENCE_TEXT_REGEX),
  );
  const activeWhere = activeAdminMemoryClause();
  const aggregateRows = await queryRows<AdminMemoryPrivacyAggregateRow>(pool, `
      SELECT
        COUNT(*) AS active_memory_count,
        COALESCE(SUM(CASE WHEN sensitivity IN ('intimate', 'confidential') THEN 1 ELSE 0 END), 0) AS high_sensitivity_count,
        COALESCE(SUM(CASE WHEN consent_flags->>'allowRecall' = 'false' THEN 1 ELSE 0 END), 0) AS consent_gated_count,
        COALESCE(SUM(CASE WHEN contact_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS contact_linked_count,
        COALESCE(SUM(CASE
          WHEN (scope_ref_kind IS NOT NULL AND scope_ref_id IS NOT NULL)
            OR (jsonb_typeof(scope_tags) = 'array' AND jsonb_array_length(scope_tags) > 0)
          THEN 1 ELSE 0 END), 0) AS scoped_count,
        COALESCE(SUM(CASE WHEN ${preferenceCondition} THEN 1 ELSE 0 END), 0) AS preference_count,
        COALESCE(SUM(CASE WHEN ${preferenceCondition} AND ${durableCondition} THEN 1 ELSE 0 END), 0) AS durable_preference_count
      FROM l2_memories
      WHERE ${activeWhere}
    `, values);
  const sensitivityRows = await queryRows<SensitivityCountRow>(pool, `
      SELECT COALESCE(sensitivity, 'personal') AS sensitivity, COUNT(*) AS count
      FROM l2_memories
      WHERE ${activeWhere}
      GROUP BY COALESCE(sensitivity, 'personal')
    `);
  return mapPostgresAdminPrivacySummary(aggregateRows[0], sensitivityRows);
}
