import type Database from 'better-sqlite3';
import type {
  MemoryAdminListOptions,
  MemoryAdminListResult,
  MemoryAdminPrivacySummary,
  MemoryListOptions,
} from '../memory-store-port.js';
import { isInternalMemoryArtifact } from '../internal-artifacts.js';
import type { PurrMemory } from '../types.js';
import { isDurableMemory, isPreferenceMemory } from '../types.js';
import { mapMemoryRow } from './mappers.js';
import type { MemoryRow } from './types.js';

const adminMemoryFunctionDbs = new WeakSet<Database.Database>();

interface CountRow {
  count: number;
}

interface AdminMemoryPrivacyAggregateRow {
  active_memory_count: number;
  high_sensitivity_count: number;
  consent_gated_count: number;
  contact_linked_count: number;
  scoped_count: number;
  preference_count: number;
  durable_preference_count: number;
}

interface SensitivityCountRow {
  sensitivity: string | null;
  count: number;
}

function normalizeListLimit(
  limit: number,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(limit)));
}

function normalizeListOffset(offset: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.floor(offset));
}

function decodeStringArrayJson(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function decodeRecordJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function registerAdminMemoryQueryFunctions(db: Database.Database): void {
  if (adminMemoryFunctionDbs.has(db)) return;

  db.function('psfn_memory_is_internal_artifact', { deterministic: true }, (
    sourceRef: unknown,
    tagsJson: unknown,
  ) => {
    return isInternalMemoryArtifact({
      sourceRef: typeof sourceRef === 'string' ? sourceRef : '',
      tags: decodeStringArrayJson(tagsJson),
    }) ? 1 : 0;
  });

  db.function('psfn_memory_is_durable', { deterministic: true }, (
    retentionClass: unknown,
    tagsJson: unknown,
  ) => {
    return isDurableMemory({
      retentionClass: retentionClass === 'standard' || retentionClass === 'durable'
        ? retentionClass
        : undefined,
      tags: decodeStringArrayJson(tagsJson),
    }) ? 1 : 0;
  });

  db.function('psfn_memory_is_preference', { deterministic: true }, (
    type: unknown,
    tagsJson: unknown,
    text: unknown,
  ) => {
    return isPreferenceMemory({
      type: typeof type === 'string' ? type as PurrMemory['type'] : 'semantic',
      tags: decodeStringArrayJson(tagsJson),
      text: typeof text === 'string' ? text : undefined,
    }) ? 1 : 0;
  });

  db.function('psfn_memory_has_json_array_entries', { deterministic: true }, (value: unknown) => {
    return decodeStringArrayJson(value).length > 0 ? 1 : 0;
  });

  db.function('psfn_memory_allow_recall_false', { deterministic: true }, (value: unknown) => {
    return decodeRecordJson(value).allowRecall === false ? 1 : 0;
  });

  adminMemoryFunctionDbs.add(db);
}

function activeAdminMemoryWhereClause(): string {
  return `
    superseded_by IS NULL
    AND deleted_at IS NULL
    AND psfn_memory_is_internal_artifact(source_ref, tags) = 0
  `;
}

function buildAdminMemoryWhereClause(
  options: MemoryAdminListOptions,
  values: unknown[],
): string {
  const clauses = [activeAdminMemoryWhereClause()];
  if (options.type) {
    clauses.push('type = ?');
    values.push(options.type);
  }
  if (options.sensitivity) {
    clauses.push('sensitivity = ?');
    values.push(options.sensitivity);
  }
  if (options.retentionClass === 'durable') {
    clauses.push('psfn_memory_is_durable(retention_class, tags) = 1');
  } else if (options.retentionClass === 'standard') {
    clauses.push('psfn_memory_is_durable(retention_class, tags) = 0');
  }
  if (options.preferenceOnly) {
    clauses.push('psfn_memory_is_preference(type, tags, text) = 1');
  }
  if (options.startDate !== undefined) {
    clauses.push('extracted_at >= ?');
    values.push(options.startDate);
  }
  if (options.endDate !== undefined) {
    clauses.push('extracted_at <= ?');
    values.push(options.endDate);
  }
  return clauses.map(clause => `(${clause})`).join(' AND ');
}

function mapAdminPrivacySummary(
  row: AdminMemoryPrivacyAggregateRow | undefined,
  sensitivityRows: SensitivityCountRow[],
): MemoryAdminPrivacySummary {
  const sensitivityCounts: Record<string, number> = {};
  for (const sensitivityRow of sensitivityRows) {
    const sensitivity = sensitivityRow.sensitivity ?? 'personal';
    sensitivityCounts[sensitivity] = sensitivityRow.count;
  }
  return {
    activeMemoryCount: row?.active_memory_count ?? 0,
    highSensitivityCount: row?.high_sensitivity_count ?? 0,
    consentGatedCount: row?.consent_gated_count ?? 0,
    contactLinkedCount: row?.contact_linked_count ?? 0,
    scopedCount: row?.scoped_count ?? 0,
    preferenceCount: row?.preference_count ?? 0,
    durablePreferenceCount: row?.durable_preference_count ?? 0,
    sensitivityCounts,
  };
}

export function getAllActiveMemories(db: Database.Database, limit: number = 10_000): PurrMemory[] {
  const safeLimit = Math.max(1, Math.min(100_000, Math.floor(limit)));
  const stmt = db.prepare(`
    SELECT * FROM l2_memories WHERE superseded_by IS NULL AND deleted_at IS NULL
    LIMIT ?
  `);
  const rows = stmt.all(safeLimit) as MemoryRow[];
  return rows.map(mapMemoryRow);
}

export function listMemories(
  db: Database.Database,
  options: MemoryListOptions = {},
): PurrMemory[] {
  const offset = normalizeListOffset(options.offset ?? 0);
  const order = `
    ORDER BY
      CASE WHEN deleted_at IS NULL AND superseded_by IS NULL THEN 0 ELSE 1 END,
      extracted_at DESC,
      id DESC
  `;
  if (options.limit === undefined) {
    const rows = db.prepare(`
      SELECT *
      FROM l2_memories
      ${order}
      LIMIT -1
      OFFSET ?
    `).all(offset) as MemoryRow[];
    return rows.map(mapMemoryRow);
  }

  const limit = normalizeListLimit(options.limit, 50, 1, 500);
  const rows = db.prepare(`
    SELECT *
    FROM l2_memories
    ${order}
    LIMIT ?
    OFFSET ?
  `).all(limit, offset) as MemoryRow[];
  return rows.map(mapMemoryRow);
}

export function listActiveMemories(
  db: Database.Database,
  options: MemoryListOptions = {},
): PurrMemory[] {
  const limit = normalizeListLimit(options.limit ?? 50, 50, 1, 500);
  const offset = normalizeListOffset(options.offset ?? 0);
  const rows = db.prepare(`
    SELECT *
    FROM l2_memories
    WHERE superseded_by IS NULL AND deleted_at IS NULL
    ORDER BY extracted_at DESC, id DESC
    LIMIT ?
    OFFSET ?
  `).all(limit, offset) as MemoryRow[];
  return rows.map(mapMemoryRow);
}

export function getAdminMemoryPrivacySummary(db: Database.Database): MemoryAdminPrivacySummary {
  registerAdminMemoryQueryFunctions(db);
  const where = activeAdminMemoryWhereClause();
  const aggregate = db.prepare(`
    SELECT
      COUNT(*) AS active_memory_count,
      COALESCE(SUM(CASE WHEN sensitivity IN ('intimate', 'confidential') THEN 1 ELSE 0 END), 0) AS high_sensitivity_count,
      COALESCE(SUM(CASE WHEN psfn_memory_allow_recall_false(consent_flags) = 1 THEN 1 ELSE 0 END), 0) AS consent_gated_count,
      COALESCE(SUM(CASE WHEN contact_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS contact_linked_count,
      COALESCE(SUM(CASE
        WHEN (scope_ref_kind IS NOT NULL AND scope_ref_id IS NOT NULL)
          OR psfn_memory_has_json_array_entries(scope_tags) = 1
        THEN 1 ELSE 0 END), 0) AS scoped_count,
      COALESCE(SUM(CASE WHEN psfn_memory_is_preference(type, tags, text) = 1 THEN 1 ELSE 0 END), 0) AS preference_count,
      COALESCE(SUM(CASE
        WHEN psfn_memory_is_preference(type, tags, text) = 1
          AND psfn_memory_is_durable(retention_class, tags) = 1
        THEN 1 ELSE 0 END), 0) AS durable_preference_count
    FROM l2_memories
    WHERE ${where}
  `).get() as AdminMemoryPrivacyAggregateRow | undefined;
  const sensitivityRows = db.prepare(`
    SELECT COALESCE(sensitivity, 'personal') AS sensitivity, COUNT(*) AS count
    FROM l2_memories
    WHERE ${where}
    GROUP BY COALESCE(sensitivity, 'personal')
  `).all() as SensitivityCountRow[];
  return mapAdminPrivacySummary(aggregate, sensitivityRows);
}

export function listAdminMemories(
  db: Database.Database,
  options: MemoryAdminListOptions = {},
): MemoryAdminListResult {
  registerAdminMemoryQueryFunctions(db);
  const limit = normalizeListLimit(options.limit ?? 50, 50, 1, 500);
  const offset = normalizeListOffset(options.offset ?? 0);
  const values: unknown[] = [];
  const where = buildAdminMemoryWhereClause(options, values);
  const rows = db.prepare(`
    SELECT *
    FROM l2_memories
    WHERE ${where}
    ORDER BY extracted_at DESC, id DESC
    LIMIT ?
    OFFSET ?
  `).all(...values, limit, offset) as MemoryRow[];
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM l2_memories
    WHERE ${where}
  `).get(...values) as CountRow | undefined;
  return {
    memories: rows.map(mapMemoryRow),
    total: totalRow?.count ?? 0,
    privacySummary: getAdminMemoryPrivacySummary(db),
  };
}

export function countActiveMemories(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) as count
    FROM l2_memories
    WHERE superseded_by IS NULL AND deleted_at IS NULL
  `).get() as { count: number };
  return row.count;
}

export function getById(db: Database.Database, id: string): PurrMemory | undefined {
  const stmt = db.prepare('SELECT * FROM l2_memories WHERE id = ?');
  const row = stmt.get(id) as MemoryRow | undefined;
  return row ? mapMemoryRow(row) : undefined;
}

export function getStats(db: Database.Database): { total: number; byType: Record<string, number>; avgSalience: number } {
  const rows = db.prepare(`
    SELECT type, COUNT(*) as count, AVG(salience) as avg_sal
    FROM l2_memories WHERE superseded_by IS NULL AND deleted_at IS NULL GROUP BY type
  `).all() as Array<{ type: string; count: number; avg_sal: number }>;

  const byType: Record<string, number> = {};
  let total = 0;
  let salSum = 0;
  for (const row of rows) {
    byType[row.type] = row.count;
    total += row.count;
    salSum += row.avg_sal * row.count;
  }
  return { total, byType, avgSalience: total > 0 ? salSum / total : 0 };
}

export function getMemoriesByChannel(
  db: Database.Database,
  channelId: string,
  limit: number,
): PurrMemory[] {
  const stmt = db.prepare(`
    SELECT * FROM l2_memories
    WHERE source_ref LIKE ? AND superseded_by IS NULL AND deleted_at IS NULL
    ORDER BY extracted_at DESC
    LIMIT ?
  `);
  const rows = stmt.all(`${channelId}:%`, limit) as MemoryRow[];
  return rows.map(mapMemoryRow);
}

export function getMemoriesByContact(
  db: Database.Database,
  contactId: string,
  limit: number,
): PurrMemory[] {
  const stmt = db.prepare(`
    SELECT * FROM l2_memories
    WHERE contact_id = ? AND superseded_by IS NULL AND deleted_at IS NULL
    ORDER BY salience DESC, extracted_at DESC
    LIMIT ?
  `);
  const rows = stmt.all(contactId, limit) as MemoryRow[];
  return rows.map(mapMemoryRow);
}
