import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { SessionEntry } from '../../core/session/types.js';
import {
  detectDurableMemoryParticipantPlaceholders,
  normalizeDurableMemoryText,
  resolveExtractionParticipantNames,
  type DurableMemoryParticipantPlaceholderDetection,
  type DurableMemoryTextHygieneRejectionReason,
  type ExtractionParticipantNames,
} from '../../faculties/memory/extraction/naming.js';
import {
  normalizeMemoryProvenance,
  normalizeMemorySourceType,
  type MemoryProvenance,
  type MemorySourceType,
} from '../../faculties/memory/types.js';
import { queryRows } from '../postgres.js';

const DEFAULT_REPAIR_LIMIT = 500;
const MAX_REPAIR_LIMIT = 10_000;
const DEFAULT_SOURCE_REF = 'source:repair|operation:memory_participant_name_backfill';
const DEFAULT_SOURCE_TYPE: MemorySourceType = 'tool_write';
const DEFAULT_REASON = 'memory_participant_name_backfill';

const SQL_CANDIDATE_PREDICATE = `
  lower(text) LIKE '%{{%'
  OR lower(text) LIKE '%the user%'
  OR lower(text) LIKE '%primary user%'
  OR lower(text) LIKE '%user''s%'
  OR lower(text) LIKE '%the companion%'
  OR lower(text) LIKE '%companion%'
  OR lower(text) LIKE '%the assistant%'
  OR lower(text) LIKE '%assistant%'
`;

export type MemoryParticipantNameRepairRefusalReason =
  | 'missing_user_name'
  | 'missing_companion_name'
  | DurableMemoryTextHygieneRejectionReason;

export interface MemoryParticipantNameRepairRecord {
  id: string;
  text: string;
  supersededBy?: string | null;
  deletedAt?: number | null;
}

export interface ResolveMemoryParticipantNameRepairNamesParams {
  entries?: readonly SessionEntry[];
  canonicalContactName?: string;
  companionName?: string;
}

export interface MemoryParticipantNameRepairOptions extends ResolveMemoryParticipantNameRepairNamesParams {
  dryRun?: boolean;
  includeArchived?: boolean;
  limit?: number;
  now?: number;
  sourceRef?: string;
  sourceType?: MemorySourceType;
  provenance?: MemoryProvenance;
  createPatchEventId?: () => string;
}

export interface MemoryParticipantNameRepairUpdate {
  memoryId: string;
  beforeText: string;
  afterText: string;
  placeholders: DurableMemoryParticipantPlaceholderDetection;
}

export interface MemoryParticipantNameRepairRefusal {
  memoryId: string;
  text: string;
  reasons: MemoryParticipantNameRepairRefusalReason[];
  placeholders: DurableMemoryParticipantPlaceholderDetection;
}

export interface MemoryParticipantNameRepairPlan {
  names: ExtractionParticipantNames;
  scanned: number;
  candidates: number;
  unchanged: number;
  updates: MemoryParticipantNameRepairUpdate[];
  refused: MemoryParticipantNameRepairRefusal[];
  refusalCounts: Record<MemoryParticipantNameRepairRefusalReason, number>;
}

export interface MemoryParticipantNameRepairReport extends MemoryParticipantNameRepairPlan {
  dryRun: boolean;
  limit: number;
  includeArchived: boolean;
  plannedUpdates: number;
  updated: number;
  sourceRef: string;
  sourceType: MemorySourceType;
}

export interface MemoryParticipantNameRepairApplyContext {
  includeArchived: boolean;
  now: number;
  sourceRef: string;
  sourceType: MemorySourceType;
  provenance: MemoryProvenance;
  createPatchEventId: () => string;
}

export interface MemoryParticipantNameRepairStore {
  listCandidateMemories(params: {
    includeArchived: boolean;
    limit: number;
  }): Promise<MemoryParticipantNameRepairRecord[]>;
  applyParticipantNameRepair(
    updates: readonly MemoryParticipantNameRepairUpdate[],
    context: MemoryParticipantNameRepairApplyContext,
  ): Promise<number>;
}

interface SqliteMemoryParticipantNameRepairRow {
  id: string;
  text: string;
  superseded_by: string | null;
  deleted_at: number | null;
}

interface PostgresMemoryParticipantNameRepairRow extends QueryResultRow {
  id: string;
  text: string;
  superseded_by: string | null;
  deleted_at: number | string | null;
}

function normalizeRepairLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_REPAIR_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('memory participant name repair limit must be a positive integer');
  }
  if (limit > MAX_REPAIR_LIMIT) {
    throw new Error(`memory participant name repair limit must be <= ${MAX_REPAIR_LIMIT}`);
  }
  return limit;
}

function normalizeRepairSourceRef(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized || DEFAULT_SOURCE_REF;
}

function normalizeRepairProvenance(value: MemoryProvenance | undefined): MemoryProvenance {
  return normalizeMemoryProvenance(value ?? {
    actor: 'operator',
    reason: DEFAULT_REASON,
  }) ?? {};
}

function summarizeRefusals(
  refused: readonly MemoryParticipantNameRepairRefusal[],
): Record<MemoryParticipantNameRepairRefusalReason, number> {
  const counts: Partial<Record<MemoryParticipantNameRepairRefusalReason, number>> = {};
  for (const refusal of refused) {
    for (const reason of refusal.reasons) {
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
  }
  return counts as Record<MemoryParticipantNameRepairRefusalReason, number>;
}

function parseOptionalDeletedAt(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function refusalReasonsForPlaceholders(
  placeholders: DurableMemoryParticipantPlaceholderDetection,
  names: ExtractionParticipantNames,
): MemoryParticipantNameRepairRefusalReason[] {
  const reasons: MemoryParticipantNameRepairRefusalReason[] = [];
  if (placeholders.user && !names.userName) {
    reasons.push('missing_user_name');
  }
  if (placeholders.companion && !names.companionName) {
    reasons.push('missing_companion_name');
  }
  return reasons;
}

function createPatchEventParams(
  update: MemoryParticipantNameRepairUpdate,
  context: MemoryParticipantNameRepairApplyContext,
): {
  id: string;
  memoryId: string;
  sourceRef: string;
  sourceType: MemorySourceType;
  provenanceJson: string;
  reason: string;
  patchJson: string;
  previousJson: string;
  nextJson: string;
  createdAt: number;
} {
  return {
    id: context.createPatchEventId(),
    memoryId: update.memoryId,
    sourceRef: context.sourceRef,
    sourceType: context.sourceType,
    provenanceJson: JSON.stringify(normalizeRepairProvenance(context.provenance)),
    reason: DEFAULT_REASON,
    patchJson: JSON.stringify({ text: update.afterText }),
    previousJson: JSON.stringify({ text: update.beforeText }),
    nextJson: JSON.stringify({ text: update.afterText }),
    createdAt: context.now,
  };
}

export function resolveMemoryParticipantNameRepairNames(
  params: ResolveMemoryParticipantNameRepairNamesParams,
): ExtractionParticipantNames {
  return resolveExtractionParticipantNames({
    entries: params.entries ?? [],
    canonicalContactName: params.canonicalContactName,
    companionName: params.companionName,
  });
}

export function planMemoryParticipantNameRepair(
  records: readonly MemoryParticipantNameRepairRecord[],
  params: ResolveMemoryParticipantNameRepairNamesParams,
): MemoryParticipantNameRepairPlan {
  const names = resolveMemoryParticipantNameRepairNames(params);
  const updates: MemoryParticipantNameRepairUpdate[] = [];
  const refused: MemoryParticipantNameRepairRefusal[] = [];
  let candidates = 0;
  let unchanged = 0;

  for (const record of records) {
    const placeholders = detectDurableMemoryParticipantPlaceholders(record.text);
    if (!placeholders.hasAny) continue;
    candidates += 1;

    const missingNameReasons = refusalReasonsForPlaceholders(placeholders, names);
    if (missingNameReasons.length > 0) {
      refused.push({
        memoryId: record.id,
        text: record.text,
        reasons: missingNameReasons,
        placeholders,
      });
      continue;
    }

    const normalized = normalizeDurableMemoryText(record.text, names);
    if (!normalized.accepted) {
      refused.push({
        memoryId: record.id,
        text: record.text,
        reasons: [normalized.reason],
        placeholders,
      });
      continue;
    }
    if (!normalized.changed) {
      unchanged += 1;
      continue;
    }

    updates.push({
      memoryId: record.id,
      beforeText: record.text,
      afterText: normalized.text,
      placeholders,
    });
  }

  return {
    names,
    scanned: records.length,
    candidates,
    unchanged,
    updates,
    refused,
    refusalCounts: summarizeRefusals(refused),
  };
}

export async function runMemoryParticipantNameRepair(
  store: MemoryParticipantNameRepairStore,
  options: MemoryParticipantNameRepairOptions,
): Promise<MemoryParticipantNameRepairReport> {
  const dryRun = options.dryRun !== false;
  const includeArchived = options.includeArchived === true;
  const limit = normalizeRepairLimit(options.limit);
  const sourceRef = normalizeRepairSourceRef(options.sourceRef);
  const sourceType = normalizeMemorySourceType(options.sourceType, DEFAULT_SOURCE_TYPE);
  const provenance = normalizeRepairProvenance(options.provenance);
  const now = options.now ?? Date.now();
  const createPatchEventId = options.createPatchEventId ?? randomUUID;

  const records = await store.listCandidateMemories({ includeArchived, limit });
  const plan = planMemoryParticipantNameRepair(records, options);
  const updated = dryRun || plan.updates.length === 0
    ? 0
    : await store.applyParticipantNameRepair(plan.updates, {
      includeArchived,
      now,
      sourceRef,
      sourceType,
      provenance,
      createPatchEventId,
    });

  return {
    ...plan,
    dryRun,
    limit,
    includeArchived,
    plannedUpdates: plan.updates.length,
    updated,
    sourceRef,
    sourceType,
  };
}

export function createSqliteMemoryParticipantNameRepairStore(
  db: Database.Database,
): MemoryParticipantNameRepairStore {
  return {
    async listCandidateMemories({ includeArchived, limit }) {
      const archivedClause = includeArchived
        ? '1 = 1'
        : 'superseded_by IS NULL AND deleted_at IS NULL';
      const rows = db.prepare(`
        SELECT id, text, superseded_by, deleted_at
        FROM l2_memories
        WHERE (${archivedClause})
          AND (${SQL_CANDIDATE_PREDICATE})
        ORDER BY extracted_at DESC, id DESC
        LIMIT ?
      `).all(limit) as SqliteMemoryParticipantNameRepairRow[];
      return rows.map(row => ({
        id: row.id,
        text: row.text,
        supersededBy: row.superseded_by,
        deletedAt: row.deleted_at,
      }));
    },

    async applyParticipantNameRepair(updates, context) {
      if (updates.length === 0) return 0;
      const archivedClause = context.includeArchived
        ? ''
        : ' AND superseded_by IS NULL AND deleted_at IS NULL';
      const updateStmt = db.prepare(`
        UPDATE l2_memories
        SET text = ?
        WHERE id = ?
          AND text = ?
          ${archivedClause}
      `);
      const insertPatchEvent = db.prepare(`
        INSERT INTO l2_memory_patch_events (
          id, memory_id, source_ref, source_type, provenance_json, reason,
          patch_json, previous_json, next_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const transaction = db.transaction((planned: readonly MemoryParticipantNameRepairUpdate[]) => {
        let updated = 0;
        for (const update of planned) {
          const result = updateStmt.run(update.afterText, update.memoryId, update.beforeText);
          if (result.changes !== 1) continue;
          const event = createPatchEventParams(update, context);
          insertPatchEvent.run(
            event.id,
            event.memoryId,
            event.sourceRef,
            event.sourceType,
            event.provenanceJson,
            event.reason,
            event.patchJson,
            event.previousJson,
            event.nextJson,
            event.createdAt,
          );
          updated += 1;
        }
        return updated;
      });
      return transaction(updates);
    },
  };
}

export async function repairSqliteMemoryParticipantNames(
  db: Database.Database,
  options: MemoryParticipantNameRepairOptions,
): Promise<MemoryParticipantNameRepairReport> {
  return await runMemoryParticipantNameRepair(
    createSqliteMemoryParticipantNameRepairStore(db),
    options,
  );
}

export function createPostgresMemoryParticipantNameRepairStore(
  pool: Pool,
): MemoryParticipantNameRepairStore {
  return {
    async listCandidateMemories({ includeArchived, limit }) {
      const archivedClause = includeArchived
        ? 'TRUE'
        : 'superseded_by IS NULL AND deleted_at IS NULL';
      const rows = await queryRows<PostgresMemoryParticipantNameRepairRow>(pool, `
        SELECT id, text, superseded_by, deleted_at
        FROM l2_memories
        WHERE (${archivedClause})
          AND (${SQL_CANDIDATE_PREDICATE})
        ORDER BY extracted_at DESC, id DESC
        LIMIT $1
      `, [limit]);
      return rows.map(row => ({
        id: row.id,
        text: row.text,
        supersededBy: row.superseded_by,
        deletedAt: parseOptionalDeletedAt(row.deleted_at),
      }));
    },

    async applyParticipantNameRepair(updates, context) {
      if (updates.length === 0) return 0;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const updated = await applyPostgresParticipantNameRepairs(client, updates, context);
        await client.query('COMMIT');
        return updated;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function applyPostgresParticipantNameRepairs(
  client: PoolClient,
  updates: readonly MemoryParticipantNameRepairUpdate[],
  context: MemoryParticipantNameRepairApplyContext,
): Promise<number> {
  const archivedClause = context.includeArchived
    ? ''
    : 'AND superseded_by IS NULL AND deleted_at IS NULL';
  let updated = 0;

  for (const update of updates) {
    const result = await client.query(`
      UPDATE l2_memories
      SET text = $1
      WHERE id = $2
        AND text = $3
        ${archivedClause}
      RETURNING id
    `, [update.afterText, update.memoryId, update.beforeText]);
    if (result.rowCount !== 1) continue;

    const event = createPatchEventParams(update, context);
    await client.query(`
      INSERT INTO l2_memory_patch_events (
        id, memory_id, source_ref, source_type, provenance_json, reason,
        patch_json, previous_json, next_json, created_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)
    `, [
      event.id,
      event.memoryId,
      event.sourceRef,
      event.sourceType,
      event.provenanceJson,
      event.reason,
      event.patchJson,
      event.previousJson,
      event.nextJson,
      event.createdAt,
    ]);
    updated += 1;
  }

  return updated;
}

export async function repairPostgresMemoryParticipantNames(
  pool: Pool,
  options: MemoryParticipantNameRepairOptions,
): Promise<MemoryParticipantNameRepairReport> {
  return await runMemoryParticipantNameRepair(
    createPostgresMemoryParticipantNameRepairStore(pool),
    options,
  );
}
