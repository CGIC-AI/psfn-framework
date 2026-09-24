import { randomUUID } from 'node:crypto';
import type { MemoryJournal } from '../journal.js';
import type {
  MemoryDeleteVersion,
  MemorySoftDeleteOptions,
  MemorySubjectAuthorizedDelete,
  MemorySubjectAuthorizedRestore,
  MemoryUndoSoftDeleteOptions,
} from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';
import { parseMemorySubjectQueryAuthorization } from '../../../shared/contracts/memory-subject.js';
import type { MemoryDeleteVersionRow, MemoryRow } from './rows.js';
import {
  decodeEmbedding,
  parseOptionalPgNumber,
  parsePgNumber,
  serializeJsonValue,
  tryFromMemoryRow,
  validateEmbeddingDimensions,
} from './rows.js';
import { buildMemorySubjectAuthorizationPredicate } from './subject-policy.js';
import { MEMORY_SUBJECT_SELECT_COLUMNS } from './subject-queries.js';
import type { PostgresMemoryDeletionProposalStore } from './deletion-proposals.js';
import type { PostgresMemoryStoreCollaboratorContext } from './collaborator-context.js';
import type { PostgresL2ReadModel } from './l2-read-model.js';

const DELETE_VERSION_COLUMNS = `
  delete_id, proposal_id, memory_id, snapshot_json, deleted_at, deleted_by, delete_reason, restored_at, restored_by
`;

function fromDeleteVersionRow(row: MemoryDeleteVersionRow): MemoryDeleteVersion {
  return {
    deleteId: row.delete_id,
    ...(row.proposal_id ? { proposalId: row.proposal_id } : {}),
    memoryId: row.memory_id,
    snapshot: typeof row.snapshot_json === 'object' && row.snapshot_json !== null
      ? (row.snapshot_json as PurrMemory)
      : JSON.parse(String(row.snapshot_json)) as PurrMemory,
    deletedAt: parsePgNumber(row.deleted_at, 'deleted_at'),
    deletedBy: row.deleted_by ?? 'unknown',
    deleteReason: row.delete_reason ?? undefined,
    restoredAt: parseOptionalPgNumber(row.restored_at, 'restored_at'),
    restoredBy: row.restored_by ?? undefined,
  };
}

/**
 * Soft delete, restore, and delete-version history for PostgresMemoryStore
 * (`l2_memory_delete_versions`). Every delete/restore re-upserts the classified
 * memory row inside one memory-store transaction, preserving the stored vector.
 * Delete versions are read at query time by primary key on the active
 * transaction client (t4mia), so the database ROLLBACK is their only
 * transactional authority and no version history is held in process memory.
 */
export class PostgresMemoryDeletionStore {

  constructor(
    private readonly ctx: Pick<
      PostgresMemoryStoreCollaboratorContext,
      | 'pool'
      | 'embeddingDims'
      | 'queryWrite'
      | 'runInTransaction'
      | 'persistClassifiedMemoryRow'
      | 'markSalienceMaintenanceChanged'
      | 'markRetrievalCorpusChanged'
    >,
    private readonly reads: Pick<PostgresL2ReadModel, 'getById'>,
    private readonly journal: MemoryJournal | null,
    private readonly markProposalRestored: PostgresMemoryDeletionProposalStore['markRestored'],
  ) {}

  /** One delete version by id, read on the active transaction client when inside one. */
  private async readVersion(deleteId: string): Promise<MemoryDeleteVersion | undefined> {
    const rows = await this.ctx.queryWrite<MemoryDeleteVersionRow>(
      `SELECT ${DELETE_VERSION_COLUMNS} FROM l2_memory_delete_versions WHERE delete_id = $1`,
      [deleteId],
    );
    const row = rows.at(0);
    return row ? fromDeleteVersionRow(row) : undefined;
  }

  /**
   * Reads a single memory's stored embedding on demand (a27w.1). Replaces the
   * former hydrated `embeddings` map for the re-upsert paths (soft delete /
   * restore) that must preserve the persisted vector. Runs on the active
   * transaction client when inside one and takes a row lock so a concurrent
   * write cannot swap the vector between this read and the re-upsert. A NULL /
   * absent embedding yields undefined; a present-but-undecodable vector fails
   * closed, matching the old hydration contract.
   */
  private async fetchStoredEmbedding(
    id: string,
    operation: string,
  ): Promise<Float32Array | undefined> {
    const rows = await this.ctx.queryWrite<{ embedding: string | null }>(
      'SELECT id, embedding::text AS embedding FROM l2_memories WHERE id = $1 FOR UPDATE',
      [id],
    );
    const raw = rows.at(0)?.embedding;
    if (!raw) return undefined;
    const embedding = decodeEmbedding(raw);
    if (!embedding) {
      throw new Error(`PostgreSQL memory schema returned an unreadable pgvector embedding for memory ${id}`);
    }
    validateEmbeddingDimensions(embedding, this.ctx.embeddingDims, operation);
    return embedding;
  }

  async upsertDeleteVersion(deleteVersion: MemoryDeleteVersion): Promise<void> {
    await this.ctx.queryWrite(`
      INSERT INTO l2_memory_delete_versions (
        delete_id, proposal_id, memory_id, snapshot_json, deleted_at, deleted_by, delete_reason, restored_at, restored_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (delete_id) DO UPDATE SET
        proposal_id = EXCLUDED.proposal_id,
        snapshot_json = EXCLUDED.snapshot_json,
        deleted_at = EXCLUDED.deleted_at,
        deleted_by = EXCLUDED.deleted_by,
        delete_reason = EXCLUDED.delete_reason,
        restored_at = EXCLUDED.restored_at,
        restored_by = EXCLUDED.restored_by
    `, [
      deleteVersion.deleteId,
      deleteVersion.proposalId ?? null,
      deleteVersion.memoryId,
      serializeJsonValue(deleteVersion.snapshot),
      deleteVersion.deletedAt,
      deleteVersion.deletedBy,
      deleteVersion.deleteReason ?? null,
      deleteVersion.restoredAt ?? null,
      deleteVersion.restoredBy ?? null,
    ]);
  }

  async softDeleteAuthorizedMemorySubject(
    input: MemorySubjectAuthorizedDelete,
  ): Promise<MemoryDeleteVersion | null> {
    const authorization = parseMemorySubjectQueryAuthorization(input.authorization);
    if (authorization.action !== 'update') {
      throw new Error('Memory subject authorization action does not permit delete');
    }
    const memoryId = input.memoryId.trim();
    if (!memoryId) return null;
    const version = await this.ctx.runInTransaction(async () => {
      const predicate = buildMemorySubjectAuthorizationPredicate(authorization, {
        memoryAlias: 'memory',
        firstParameter: 2,
      });
      const rows = await this.ctx.queryWrite<MemoryRow>(`
        SELECT ${MEMORY_SUBJECT_SELECT_COLUMNS}
        FROM l2_memories memory
        WHERE memory.id = $1
          AND memory.superseded_by IS NULL
          AND memory.deleted_at IS NULL
          AND ${predicate.sql}
        FOR UPDATE
      `, [memoryId, ...predicate.values]);
      const row = rows.at(0);
      if (!row) return null;
      const memory = tryFromMemoryRow(row);
      if (!memory) return null;
      const embedding = decodeEmbedding(row.embedding);
      if (embedding) validateEmbeddingDimensions(embedding, this.ctx.embeddingDims, 'authorized delete');
      const deleteId = input.options?.deleteId ?? randomUUID();
      const deletedAt = input.options?.deletedAt ?? Date.now();
      const deletedBy = input.options?.deletedBy?.trim() || 'agent';
      const deleteReason = input.options?.reason?.trim();
      const nextVersion: MemoryDeleteVersion = {
        deleteId,
        ...(input.options?.proposalId ? { proposalId: input.options.proposalId } : {}),
        memoryId,
        snapshot: memory,
        deletedAt,
        deletedBy,
        ...(deleteReason ? { deleteReason } : {}),
      };
      await this.upsertDeleteVersion(nextVersion);
      const deletedMemory = { ...memory, deletedAt, deletedBy, deleteReason };
      await this.ctx.persistClassifiedMemoryRow(deletedMemory, embedding);
      return nextVersion;
    });
    if (!version) return null;
    this.ctx.markSalienceMaintenanceChanged();
    this.ctx.markRetrievalCorpusChanged();
    this.journal?.onSoftDelete(version);
    return version;
  }

  async undoAuthorizedMemorySubjectDelete(
    input: MemorySubjectAuthorizedRestore,
  ): Promise<MemoryDeleteVersion | null> {
    const authorization = parseMemorySubjectQueryAuthorization(input.authorization);
    if (authorization.action !== 'update') {
      throw new Error('Memory subject authorization action does not permit restore');
    }
    const deleteId = input.deleteId.trim();
    const version = await this.readVersion(deleteId);
    if (!version || version.restoredAt !== undefined) return null;
    const nextVersion = await this.ctx.runInTransaction(async () => {
      const predicate = buildMemorySubjectAuthorizationPredicate(authorization, {
        memoryAlias: 'memory',
        firstParameter: 2,
      });
      const rows = await this.ctx.queryWrite<MemoryRow>(`
        SELECT ${MEMORY_SUBJECT_SELECT_COLUMNS}
        FROM l2_memories memory
        WHERE memory.id = $1
          AND memory.deleted_at IS NOT NULL
          AND ${predicate.sql}
        FOR UPDATE
      `, [version.memoryId, ...predicate.values]);
      const row = rows.at(0);
      if (!row) return null;
      const current = tryFromMemoryRow(row);
      if (!current) return null;
      const embedding = decodeEmbedding(row.embedding);
      if (embedding) validateEmbeddingDimensions(embedding, this.ctx.embeddingDims, 'authorized restore');
      const restoredAt = input.options?.restoredAt ?? Date.now();
      const restoredBy = input.options?.restoredBy?.trim() || 'agent';
      const restored = {
        ...current,
        deletedAt: undefined,
        deletedBy: undefined,
        deleteReason: undefined,
      };
      const restoredVersion = { ...version, restoredAt, restoredBy };
      await this.upsertDeleteVersion(restoredVersion);
      await this.ctx.persistClassifiedMemoryRow(restored, embedding);
      if (version.proposalId) {
        await this.markProposalRestored({
          proposalId: version.proposalId,
          deleteId,
          restoredAt,
          restoredBy,
          actorRole: input.options?.actorRole,
        });
      }
      return restoredVersion;
    });
    if (!nextVersion) return null;
    this.ctx.markSalienceMaintenanceChanged();
    this.ctx.markRetrievalCorpusChanged();
    this.journal?.onRestore(nextVersion);
    return nextVersion;
  }

  async softDeleteMemory(id: string, options: MemorySoftDeleteOptions = {}): Promise<MemoryDeleteVersion | null> {
    const memory = await this.reads.getById(id);
    if (!memory || memory.deletedAt) return null;
    const deleteId = options.deleteId ?? randomUUID();
    const deletedAt = options.deletedAt ?? Date.now();
    const deletedBy = options.deletedBy?.trim() || 'agent';
    const deleteReason = options.reason?.trim();
    const version: MemoryDeleteVersion = {
      deleteId,
      ...(options.proposalId ? { proposalId: options.proposalId } : {}),
      memoryId: id,
      snapshot: memory,
      deletedAt,
      deletedBy,
      ...(deleteReason ? { deleteReason } : {}),
    };
    await this.ctx.runInTransaction(async () => {
      // a27w.1: read the stored vector under a row lock instead of a hydrated
      // map so the re-upsert preserves it (passing undefined would NULL it).
      const embedding = await this.fetchStoredEmbedding(id, 'soft delete');
      await this.upsertDeleteVersion(version);
      await this.ctx.persistClassifiedMemoryRow(
        { ...memory, deletedAt, deletedBy, deleteReason },
        embedding,
      );
    });
    this.ctx.markSalienceMaintenanceChanged();
    this.ctx.markRetrievalCorpusChanged();
    this.journal?.onSoftDelete(version);
    return version;
  }

  async undoSoftDelete(deleteId: string, options: MemoryUndoSoftDeleteOptions = {}): Promise<MemoryDeleteVersion | null> {
    const version = await this.readVersion(deleteId);
    if (!version) return null;
    const current = await this.reads.getById(version.memoryId);
    if (!current) return null;
    const restoredAt = options.restoredAt ?? Date.now();
    const restoredBy = options.restoredBy?.trim() || 'agent';
    const restored = { ...current, deletedAt: undefined, deletedBy: undefined, deleteReason: undefined };
    const nextVersion = { ...version, restoredAt, restoredBy };
    await this.ctx.runInTransaction(async () => {
      // a27w.1: preserve the persisted vector by reading it under a row lock
      // rather than from a hydrated map.
      const embedding = await this.fetchStoredEmbedding(version.memoryId, 'undo soft delete');
      await this.upsertDeleteVersion(nextVersion);
      await this.ctx.persistClassifiedMemoryRow(restored, embedding);
      if (version.proposalId) {
        await this.markProposalRestored({
          proposalId: version.proposalId,
          deleteId,
          restoredAt,
          restoredBy,
          actorRole: options.actorRole,
        });
      }
    });
    this.ctx.markSalienceMaintenanceChanged();
    this.ctx.markRetrievalCorpusChanged();
    this.journal?.onRestore(nextVersion);
    return nextVersion;
  }

  async getDeleteVersion(deleteId: string): Promise<MemoryDeleteVersion | undefined> {
    return await this.readVersion(deleteId);
  }

  async bulkDelete(ids: string[]): Promise<number> {
    let count = 0;
    for (const id of ids) {
      const deleted = await this.softDeleteMemory(id, { deletedBy: 'admin:bulk', reason: 'bulk delete' });
      if (deleted) count += 1;
    }
    return count;
  }
}
