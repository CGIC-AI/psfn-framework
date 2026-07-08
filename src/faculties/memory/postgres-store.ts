import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import {
  createPostgresPool,
  ensurePostgresSchema,
  executeQuery,
  queryRows,
} from '../../persistence/postgres.js';
import { createComponentLogger } from '../../shared/logger.js';
import {
  POSTGRES_MEMORY_MIGRATIONS,
} from '../../persistence/postgres/migrations.js';
import type { MemoryJournal } from './journal.js';
import type {
  ContactProfileArtifact,
  MemoryAbstractionLink,
  MemoryAbstractionLinkInput,
  MemoryAdminListOptions,
  MemoryAdminListResult,
  MemoryAdminPrivacySummary,
  MemoryBulkUpdatePatch,
  MemoryDeleteVersion,
  MemoryEvolutionLink,
  MemoryEvolutionLinkInput,
  MemoryEvolutionRelation,
  MemoryMaintenanceDiagnostics,
  MemoryMaintenanceDiagnosticsOptions,
  MemoryListOptions,
  MemoryLink,
  MemoryMaintenanceReview,
  MemoryMaintenanceReviewInput,
  MemoryMaintenanceReviewListOptions,
  MemorySalienceUpdate,
  MemorySoftDeleteOptions,
  MemoryStorePort,
  MemoryStoreStats,
  MemoryStoreUpdatePatch,
  MemoryPatchEvent,
  MemoryUndoSoftDeleteOptions,
  ScratchpadAddResult,
  ScratchpadEntry,
  ScratchpadEntryCreateOptions,
  ScratchpadEntryReplaceOptions,
  MemoryWriteCommit,
} from './memory-store-port.js';
import { normalizeMemorySalienceUpdates } from './memory-store-port.js';
import {
  applyRetentionClassTags,
  normalizeMemoryProvenance,
  normalizeMemoryScopeQuery,
  normalizeMemoryScopeRef,
  normalizeMemoryScopeTags,
  normalizeMemorySourceType,
  type MemoryScopeQuery,
  type PurrMemory,
} from './types.js';
import {
  normalizeMemoryMaintenanceReviewInput,
} from './maintenance-review.js';
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
} from './postgres-store/admin.js';
import {
  fromEvolutionLinkRow,
  normalizeEvolutionLinkInput,
  normalizeEvolutionRelation,
} from './postgres-store/evolution.js';
import { fromMaintenanceReviewRow } from './postgres-store/reviews.js';
import type {
  AdminMemoryPrivacyAggregateRow,
  ContactProfileRow,
  CountRow,
  MemoryAbstractionLinkRow,
  MemoryDeleteVersionRow,
  MemoryEmbeddingSearchRow,
  MemoryEvolutionLinkRow,
  MemoryLinkRow,
  MemoryMaintenanceReviewPgRow,
  MemoryRow,
  ScratchpadRow,
  SensitivityCountRow,
} from './postgres-store/rows.js';
import {
  decodeEmbedding,
  decodeStringArray,
  encodeEmbeddingLiteral,
  fromMemoryRow,
  parseOptionalPgNumber,
  parsePgNumber,
  serializeJsonValue,
  toMemoryRow,
  validateEmbeddingDimensions,
} from './postgres-store/rows.js';
import {
  clampLimit,
  increment,
  lexicalScore,
  memoryEvolutionKey,
  memoryKey,
} from './postgres-store/utils.js';
import {
  assertExistingMemorySchemaHasEmbeddingColumn,
  validatePostgresMemorySchema,
} from './postgres-store/schema.js';

const SCRATCHPAD_TTL_MS = 24 * 60 * 60 * 1000;
const SCRATCHPAD_MAX_ENTRIES = 64;
const log = createComponentLogger('PostgresMemoryStore');

export interface PostgresMemoryStoreOptions {
  notesDir?: string;
  scratchpadMirrorPath?: string;
  journal?: MemoryJournal;
  /** Optional per-companion Postgres schema; pins the pool's search_path. */
  schema?: string;
}

export async function createPostgresMemoryStore(
  databaseUrl: string,
  embeddingDims: number,
  options: PostgresMemoryStoreOptions = {},
): Promise<MemoryStorePort> {
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-memory',
    allowExitOnIdle: true,
    schema: options.schema,
  });
  return await createPostgresMemoryStoreFromPool(pool, embeddingDims, options);
}

export async function createPostgresMemoryStoreFromPool(
  pool: Pool,
  embeddingDims: number,
  options: PostgresMemoryStoreOptions = {},
): Promise<MemoryStorePort> {
  // A pre-existing l2_memories without its embedding column is a broken
  // schema, not a fresh database; surface the fail-closed guidance before
  // the idempotent migrations trip over the missing column with a raw
  // Postgres error.
  await assertExistingMemorySchemaHasEmbeddingColumn(pool);
  await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
  await validatePostgresMemorySchema(pool);
  const store = new PostgresMemoryStore(pool, embeddingDims, options);
  await store.waitUntilReady();
  return store;
}

interface MemoryStoreTransactionState {
  client: PoolClient;
  operations: Array<Promise<unknown>>;
}

class PostgresMemoryStore implements MemoryStorePort {
  private readonly pool: Pool;
  private readonly embeddingDims: number;
  private readonly journal: MemoryJournal | null;
  private readonly scratchpadMirrorPath: string | null;
  private persistChain: Promise<void> = Promise.resolve();
  private readonly initialization: Promise<void>;
  /** Active transaction scope: writes issued inside a runInTransaction handler join its client. */
  private readonly transactionContext = new AsyncLocalStorage<MemoryStoreTransactionState>();

  private memories = new Map<string, PurrMemory>();
  private embeddings = new Map<string, Float32Array>();
  private deleteVersions = new Map<string, MemoryDeleteVersion>();
  private abstractionLinks = new Map<string, MemoryAbstractionLink>();
  private memoryEvolutionLinks = new Map<string, MemoryEvolutionLink>();
  private memoryLinks = new Map<string, MemoryLink>();
  private maintenanceReviews = new Map<string, MemoryMaintenanceReview>();
  private contactProfiles = new Map<string, ContactProfileArtifact>();
  private scratchpadEntries = new Map<string, ScratchpadEntry>();

  constructor(pool: Pool, embeddingDims: number, options: PostgresMemoryStoreOptions = {}) {
    this.pool = pool;
    this.embeddingDims = embeddingDims;
    this.journal = options.journal ?? null;
    this.scratchpadMirrorPath = options.scratchpadMirrorPath?.trim() ? options.scratchpadMirrorPath.trim() : null;
    this.initialization = this.initialize();
  }

  async waitUntilReady(): Promise<void> {
    await this.initialization;
  }

  private async initialize(): Promise<void> {
    const memoryRows = await queryRows<MemoryRow>(this.pool, `
      SELECT
        id, text, type, importance, confidence, emotional_valence, formation_vad,
        salience, source_ref, source_type, provenance_json, extracted_at, last_accessed,
        access_count, superseded_by,
        tags, scope_ref_kind, scope_ref_id, scope_ref_label, scope_tags, provenance_refs,
        retention_class, sensitivity, consent_flags, contact_id, deleted_at, deleted_by,
        delete_reason, embedding::text AS embedding
      FROM l2_memories
      ORDER BY extracted_at DESC, id DESC
    `);
    for (const row of memoryRows) {
      this.memories.set(row.id, fromMemoryRow(row));
      if (row.embedding) {
        const embedding = decodeEmbedding(row.embedding);
        if (!embedding) {
          throw new Error(`PostgreSQL memory schema returned an unreadable pgvector embedding for memory ${row.id}`);
        }
        validateEmbeddingDimensions(embedding, this.embeddingDims, 'hydrate');
        this.embeddings.set(row.id, embedding);
      }
    }

    const deleteRows = await queryRows<MemoryDeleteVersionRow>(this.pool, `
      SELECT delete_id, memory_id, snapshot_json, deleted_at, deleted_by, delete_reason, restored_at, restored_by
      FROM l2_memory_delete_versions
    `);
    for (const row of deleteRows) {
      this.deleteVersions.set(row.delete_id, {
        deleteId: row.delete_id,
        memoryId: row.memory_id,
        snapshot: typeof row.snapshot_json === 'object' && row.snapshot_json !== null
          ? (row.snapshot_json as PurrMemory)
          : JSON.parse(String(row.snapshot_json)) as PurrMemory,
        deletedAt: parsePgNumber(row.deleted_at, 'deleted_at'),
        deletedBy: row.deleted_by ?? 'unknown',
        deleteReason: row.delete_reason ?? undefined,
        restoredAt: parseOptionalPgNumber(row.restored_at, 'restored_at'),
        restoredBy: row.restored_by ?? undefined,
      });
    }

    const linkRows = await queryRows<MemoryAbstractionLinkRow>(this.pool, `
      SELECT id, source_memory_id, abstracted_memory_id, external_ref, created_at, created_by, reason
      FROM l2_memory_abstraction_links
    `);
    for (const row of linkRows) {
      const link = {
        id: row.id,
        sourceMemoryId: row.source_memory_id,
        abstractedMemoryId: row.abstracted_memory_id,
        externalRef: row.external_ref,
        createdAt: row.created_at,
        ...(row.created_by ? { createdBy: row.created_by } : {}),
        ...(row.reason ? { reason: row.reason } : {}),
      };
      this.abstractionLinks.set(link.id, link);
    }

    const evolutionLinkRows = await queryRows<MemoryEvolutionLinkRow>(this.pool, `
      SELECT
        id, source_memory_id, target_memory_id, relation, confidence, reason,
        source_ref, source_type, provenance_refs, provenance_json, created_at
      FROM memory_evolution_links
    `);
    for (const row of evolutionLinkRows) {
      const link = fromEvolutionLinkRow(row);
      this.memoryEvolutionLinks.set(memoryEvolutionKey(
        link.sourceMemoryId,
        link.targetMemoryId,
        link.relation,
      ), link);
    }

    const memoryLinkRows = await queryRows<MemoryLinkRow>(this.pool, `
      SELECT id1, id2, link_type, created_at FROM memory_links
    `);
    for (const row of memoryLinkRows) {
      this.memoryLinks.set(memoryKey(row.id1, row.id2), {
        id1: row.id1,
        id2: row.id2,
        linkType: row.link_type,
        createdAt: row.created_at,
      });
    }

    const maintenanceReviewRows = await queryRows<MemoryMaintenanceReviewPgRow>(this.pool, `
      SELECT
        id, kind, status, subject_memory_id, candidate_memory_ids, state_json,
        quarantine_reason, created_at, updated_at
      FROM l2_memory_maintenance_reviews
    `);
    for (const row of maintenanceReviewRows) {
      const review = fromMaintenanceReviewRow(row);
      this.maintenanceReviews.set(review.id, review);
    }

    const contactProfiles = await queryRows<ContactProfileRow>(this.pool, `
      SELECT contact_id, summary_text, source_memory_ids, confidence_score, novelty_score, updated_at
      FROM contact_profiles
    `);
    for (const row of contactProfiles) {
      this.contactProfiles.set(row.contact_id, {
        contactId: row.contact_id,
        summary: row.summary_text,
        sourceMemoryIds: decodeStringArray(row.source_memory_ids),
        confidenceScore: row.confidence_score,
        noveltyScore: row.novelty_score,
        updatedAt: row.updated_at,
      });
    }

    const scratchpadEntries = await queryRows<ScratchpadRow>(this.pool, `
      SELECT id, content, created_at, updated_at
      FROM scratchpad_entries
      ORDER BY updated_at DESC, created_at DESC
    `);
    for (const row of scratchpadEntries) {
      this.scratchpadEntries.set(row.id, {
        id: row.id,
        content: row.content,
        createdAt: parsePgNumber(row.created_at, 'scratchpad_entries.created_at'),
        updatedAt: parsePgNumber(row.updated_at, 'scratchpad_entries.updated_at'),
      });
    }
    this.pruneExpiredScratchpadEntries();
  }

  private persist<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.persistChain.then(task);
    this.persistChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /**
   * Routes a write either into the active transaction (eager, on the
   * checked-out client, awaited by runInTransaction before COMMIT) or onto
   * the serialized persist chain when no transaction is open.
   */
  private runWrite<T>(task: () => Promise<T>): Promise<T> {
    const transaction = this.transactionContext.getStore();
    if (transaction) {
      const operation = task();
      transaction.operations.push(operation);
      return operation;
    }
    return this.persist(task);
  }

  private async executeWrite(text: string, values: readonly unknown[]): Promise<void> {
    const transaction = this.transactionContext.getStore();
    if (transaction) {
      await transaction.client.query(text, [...values]);
      return;
    }
    await executeQuery(this.pool, text, values);
  }

  private async upsertMemoryRow(memory: PurrMemory, embedding?: Float32Array): Promise<void> {
    if (embedding) {
      validateEmbeddingDimensions(embedding, this.embeddingDims, 'write');
    }
    const row = toMemoryRow(memory, embedding);
    await this.executeWrite(`
      INSERT INTO l2_memories (
        id, text, type, importance, confidence, emotional_valence, formation_vad, salience,
        source_ref, source_type, provenance_json, extracted_at, last_accessed, access_count,
        superseded_by, tags,
        scope_ref_kind, scope_ref_id, scope_ref_label, scope_tags, provenance_refs,
        retention_class, sensitivity, consent_flags, contact_id, deleted_at, deleted_by,
        delete_reason, embedding
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29::vector
      )
      ON CONFLICT (id) DO UPDATE SET
        text = EXCLUDED.text,
        type = EXCLUDED.type,
        importance = EXCLUDED.importance,
        confidence = EXCLUDED.confidence,
        emotional_valence = EXCLUDED.emotional_valence,
        formation_vad = EXCLUDED.formation_vad,
        salience = EXCLUDED.salience,
        source_ref = EXCLUDED.source_ref,
        source_type = EXCLUDED.source_type,
        provenance_json = EXCLUDED.provenance_json,
        extracted_at = EXCLUDED.extracted_at,
        last_accessed = EXCLUDED.last_accessed,
        access_count = EXCLUDED.access_count,
        superseded_by = EXCLUDED.superseded_by,
        tags = EXCLUDED.tags,
        scope_ref_kind = EXCLUDED.scope_ref_kind,
        scope_ref_id = EXCLUDED.scope_ref_id,
        scope_ref_label = EXCLUDED.scope_ref_label,
        scope_tags = EXCLUDED.scope_tags,
        provenance_refs = EXCLUDED.provenance_refs,
        retention_class = EXCLUDED.retention_class,
        sensitivity = EXCLUDED.sensitivity,
        consent_flags = EXCLUDED.consent_flags,
        contact_id = EXCLUDED.contact_id,
        deleted_at = EXCLUDED.deleted_at,
        deleted_by = EXCLUDED.deleted_by,
        delete_reason = EXCLUDED.delete_reason,
        embedding = EXCLUDED.embedding
    `, [
      row.id,
      row.text,
      row.type,
      row.importance,
      row.confidence,
      row.emotional_valence,
      serializeJsonValue(row.formation_vad),
      row.salience,
      row.source_ref,
      row.source_type,
      serializeJsonValue(row.provenance_json),
      row.extracted_at,
      row.last_accessed,
      row.access_count,
      row.superseded_by,
      serializeJsonValue(row.tags),
      row.scope_ref_kind,
      row.scope_ref_id,
      row.scope_ref_label,
      serializeJsonValue(row.scope_tags),
      serializeJsonValue(row.provenance_refs),
      row.retention_class,
      row.sensitivity,
      serializeJsonValue(row.consent_flags),
      row.contact_id,
      row.deleted_at,
      row.deleted_by,
      row.delete_reason,
      row.embedding,
    ]);
  }

  private async upsertDeleteVersion(deleteVersion: MemoryDeleteVersion): Promise<void> {
    await executeQuery(this.pool, `
      INSERT INTO l2_memory_delete_versions (
        delete_id, memory_id, snapshot_json, deleted_at, deleted_by, delete_reason, restored_at, restored_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (delete_id) DO UPDATE SET
        snapshot_json = EXCLUDED.snapshot_json,
        deleted_at = EXCLUDED.deleted_at,
        deleted_by = EXCLUDED.deleted_by,
        delete_reason = EXCLUDED.delete_reason,
        restored_at = EXCLUDED.restored_at,
        restored_by = EXCLUDED.restored_by
    `, [
      deleteVersion.deleteId,
      deleteVersion.memoryId,
      serializeJsonValue(deleteVersion.snapshot),
      deleteVersion.deletedAt,
      deleteVersion.deletedBy,
      deleteVersion.deleteReason ?? null,
      deleteVersion.restoredAt ?? null,
      deleteVersion.restoredBy ?? null,
    ]);
  }

  private async upsertScratchpadEntry(entry: ScratchpadEntry): Promise<void> {
    await executeQuery(this.pool, `
      INSERT INTO scratchpad_entries (id, content, created_at, updated_at)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (id) DO UPDATE SET
        content = EXCLUDED.content,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at
    `, [entry.id, entry.content, entry.createdAt, entry.updatedAt]);
    this.syncScratchpadMirror();
  }

  private async persistContactProfile(profile: ContactProfileArtifact): Promise<void> {
    await executeQuery(this.pool, `
      INSERT INTO contact_profiles (
        contact_id, summary_text, source_memory_ids, confidence_score, novelty_score, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (contact_id) DO UPDATE SET
        summary_text = EXCLUDED.summary_text,
        source_memory_ids = EXCLUDED.source_memory_ids,
        confidence_score = EXCLUDED.confidence_score,
        novelty_score = EXCLUDED.novelty_score,
        updated_at = EXCLUDED.updated_at
    `, [
      profile.contactId,
      profile.summary,
      serializeJsonValue(profile.sourceMemoryIds),
      profile.confidenceScore,
      profile.noveltyScore,
      profile.updatedAt,
    ]);
  }

  private syncScratchpadMirror(): void {
    if (!this.scratchpadMirrorPath) return;
    const payload = {
      entries: this.listScratchpadEntries(),
    };
    writeJsonAtomic(this.scratchpadMirrorPath, payload);
  }

  private collectExpiredScratchpadEntryIds(now = Date.now()): string[] {
    const cutoff = now - SCRATCHPAD_TTL_MS;
    return Array.from(this.scratchpadEntries.values())
      .filter(entry => entry.updatedAt < cutoff)
      .map(entry => entry.id);
  }

  private pruneExpiredScratchpadEntries(now = Date.now()): string[] {
    const expiredIds = this.collectExpiredScratchpadEntryIds(now);
    if (expiredIds.length === 0) {
      return [];
    }

    for (const id of expiredIds) {
      this.scratchpadEntries.delete(id);
    }

    void this.persist(async () => {
      for (const id of expiredIds) {
        await executeQuery(this.pool, 'DELETE FROM scratchpad_entries WHERE id = $1', [id]);
      }
    }).catch((error: unknown) => {
      log.warn('Failed to prune expired scratchpad entries', { error: String(error) });
    });
    this.syncScratchpadMirror();
    return expiredIds;
  }

  async insertMemory(memory: PurrMemory, embedding: Float32Array): Promise<void> {
    validateEmbeddingDimensions(embedding, this.embeddingDims, 'insert');
    await this.runWrite(() => this.upsertMemoryRow(memory, embedding));
    this.memories.set(memory.id, memory);
    this.embeddings.set(memory.id, embedding);
    this.journal?.onInsert(memory);
  }

  async persistMemoryWrite(input: MemoryWriteCommit): Promise<void> {
    for (const id of new Set(input.supersededMemoryIds ?? [])) {
      await this.updateMemory(id, { supersededBy: input.memory.id });
    }
    await this.insertMemory(input.memory, input.embedding);
  }

  /**
   * Runs the handler inside a real database transaction: a dedicated client
   * is checked out, BEGIN/COMMIT wrap the handler's writes, and any failure
   * rolls back both the database statements and the in-memory cache. Writes
   * issued inside the handler (awaited or fire-and-forget) are captured via
   * AsyncLocalStorage and awaited before COMMIT. The whole transaction holds
   * the persist chain so unrelated writes never interleave with it. The
   * append-only JSONL journal is an audit mirror, not a restore primitive,
   * so entries it may have recorded for rolled-back writes are tolerated.
   */
  async runInTransaction<T>(handler: () => T): Promise<T> {
    if (this.transactionContext.getStore()) {
      throw new Error('Nested memory-store transactions are not supported');
    }
    return this.persist(async () => {
      const client = await this.pool.connect();
      const state: MemoryStoreTransactionState = { client, operations: [] };
      const memoriesSnapshot = new Map(this.memories);
      const embeddingsSnapshot = new Map(this.embeddings);
      try {
        await client.query('BEGIN');
        const result = await this.transactionContext.run(state, () => handler());
        await Promise.all(state.operations);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        // Let in-flight statements settle before rolling back; their
        // failures are subsumed by the transaction failure being thrown.
        await Promise.allSettled(state.operations);
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          log.error('Failed to roll back memory-store transaction', {
            error: String(rollbackError),
          });
        }
        this.memories = memoriesSnapshot;
        this.embeddings = embeddingsSnapshot;
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async recordPatchEvent(event: MemoryPatchEvent): Promise<void> {
    await this.runWrite(() => this.executeWrite(`
      INSERT INTO l2_memory_patch_events (
        id, memory_id, source_ref, source_type, provenance_json, reason, patch_json, previous_json, next_json, created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      event.id,
      event.memoryId,
      event.sourceRef,
      normalizeMemorySourceType(event.sourceType),
      serializeJsonValue(normalizeMemoryProvenance(event.provenance) ?? {}),
      event.reason ?? null,
      serializeJsonValue(event.patch),
      serializeJsonValue(event.previousValues),
      serializeJsonValue(event.nextValues),
      event.createdAt,
    ]));
  }

  async searchByEmbedding(
    embedding: Float32Array,
    threshold: number,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Promise<Array<PurrMemory & { similarity: number }>> {
    validateEmbeddingDimensions(embedding, this.embeddingDims, 'search');
    const normalizedScopeQuery = normalizeMemoryScopeQuery(scopeQuery);
    const rows = await queryRows<MemoryEmbeddingSearchRow>(this.pool, `
      SELECT
        id, text, type, importance, confidence, emotional_valence, formation_vad,
        salience, source_ref, source_type, provenance_json, extracted_at, last_accessed,
        access_count, superseded_by,
        tags, scope_ref_kind, scope_ref_id, scope_ref_label, scope_tags, provenance_refs,
        retention_class, sensitivity, consent_flags, contact_id, deleted_at, deleted_by,
        delete_reason, embedding::text AS embedding,
        1 - (embedding <=> $1::vector) AS similarity
      FROM l2_memories
      WHERE embedding IS NOT NULL
        AND superseded_by IS NULL
        AND deleted_at IS NULL
        AND 1 - (embedding <=> $1::vector) >= $2
      ORDER BY embedding <=> $1::vector ASC, salience DESC, extracted_at DESC
    `, [encodeEmbeddingLiteral(embedding), threshold]);

    return rows
      .map((row) => ({ ...fromMemoryRow(row), similarity: parsePgNumber(row.similarity, 'similarity') }))
      .filter((memory) => {
        if (!normalizedScopeQuery) return true;
        const refs = normalizedScopeQuery.refs ?? [];
        const tags = normalizedScopeQuery.tags ?? [];
        if (refs.length === 0 && tags.length === 0) return true;
        const scopeMatch = refs.length === 0 || refs.some(ref => {
          const scope = memory.scopeRef;
          return scope?.kind === ref.kind && scope.id === ref.id;
        });
        const tagMatch = tags.length === 0 || tags.some(tag => memory.scopeTags?.includes(tag));
        return normalizedScopeQuery.mode === 'only' ? scopeMatch && tagMatch : scopeMatch || tagMatch;
      })
      .sort((left, right) => right.similarity - left.similarity || right.salience - left.salience || right.extractedAt - left.extractedAt)
      .slice(0, limit);
  }

  async searchByText(
    query: string,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Promise<Array<PurrMemory & { similarity: number }>> {
    const normalizedScopeQuery = normalizeMemoryScopeQuery(scopeQuery);
    return Array.from(this.memories.values())
      .filter((memory) => {
        if (memory.supersededBy || memory.deletedAt) return false;
        if (!normalizedScopeQuery) return true;
        const refs = normalizedScopeQuery.refs ?? [];
        const tags = normalizedScopeQuery.tags ?? [];
        if (refs.length === 0 && tags.length === 0) return true;
        const scopeMatch = refs.length === 0 || refs.some(ref => {
          const scope = memory.scopeRef;
          return scope?.kind === ref.kind && scope.id === ref.id;
        });
        const tagMatch = tags.length === 0 || tags.some(tag => memory.scopeTags?.includes(tag));
        return normalizedScopeQuery.mode === 'only' ? scopeMatch && tagMatch : scopeMatch || tagMatch;
      })
      .map(memory => ({ ...memory, similarity: lexicalScore(memory, query) }))
      .filter(memory => memory.similarity > 0)
      .sort((left, right) => right.similarity - left.similarity || right.salience - left.salience || right.extractedAt - left.extractedAt)
      .slice(0, limit);
  }

  async updateMemory(id: string, updates: MemoryStoreUpdatePatch): Promise<void> {
    const existing = this.memories.get(id);
    if (!existing) return;
    const next = { ...existing };
    if (updates.salience !== undefined) next.salience = updates.salience;
    if (updates.lastAccessed !== undefined) next.lastAccessed = updates.lastAccessed;
    if (updates.accessCount !== undefined) next.accessCount = updates.accessCount;
    if (updates.supersededBy !== undefined) next.supersededBy = updates.supersededBy;
    if (updates.sensitivity !== undefined) next.sensitivity = updates.sensitivity;
    if (updates.consentFlags !== undefined) next.consentFlags = updates.consentFlags;
    if (updates.tags !== undefined) next.tags = [...updates.tags];
    if (updates.scopeRef !== undefined) next.scopeRef = normalizeMemoryScopeRef(updates.scopeRef);
    if (updates.scopeTags !== undefined) next.scopeTags = normalizeMemoryScopeTags(updates.scopeTags);
    if (updates.provenanceRefs !== undefined) next.provenanceRefs = [...updates.provenanceRefs];
    if (updates.retentionClass !== undefined) next.retentionClass = updates.retentionClass;
    if (updates.contactId !== undefined) next.contactId = updates.contactId;
    if (updates.deletedAt !== undefined) next.deletedAt = updates.deletedAt;
    if (updates.deletedBy !== undefined) next.deletedBy = updates.deletedBy;
    if (updates.deleteReason !== undefined) next.deleteReason = updates.deleteReason;
    const embedding = this.embeddings.get(id);
    await this.runWrite(() => this.upsertMemoryRow(next, embedding));
    this.memories.set(id, next);
  }

  async getAllActiveMemories(limit: number = 10_000): Promise<PurrMemory[]> {
    return Array.from(this.memories.values())
      .filter(memory => !memory.supersededBy && !memory.deletedAt)
      .sort((left, right) => right.extractedAt - left.extractedAt || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  async listMemories(options: MemoryListOptions = {}): Promise<PurrMemory[]> {
    const offset = clampLimit(options.offset, 0, 0, 100_000);
    const memories = Array.from(this.memories.values())
      .sort((left, right) => {
        const leftArchived = left.supersededBy || left.deletedAt ? 1 : 0;
        const rightArchived = right.supersededBy || right.deletedAt ? 1 : 0;
        return leftArchived - rightArchived
          || right.extractedAt - left.extractedAt
          || right.id.localeCompare(left.id);
      });
    if (options.limit === undefined) {
      return memories.slice(offset);
    }
    const limit = clampLimit(options.limit, 50, 1, 500);
    return memories.slice(offset, offset + limit);
  }

  async listActiveMemories(options: MemoryListOptions = {}): Promise<PurrMemory[]> {
    const limit = clampLimit(options.limit, 50, 1, 500);
    const offset = clampLimit(options.offset, 0, 0, 100_000);
    return Array.from(this.memories.values())
      .filter(memory => !memory.supersededBy && !memory.deletedAt)
      .sort((left, right) => right.extractedAt - left.extractedAt || right.id.localeCompare(left.id))
      .slice(offset, offset + limit);
  }

  async listAdminMemories(options: MemoryAdminListOptions = {}): Promise<MemoryAdminListResult> {
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
    const rows = await queryRows<MemoryRow>(this.pool, `
      SELECT
        id, text, type, importance, confidence, emotional_valence, formation_vad,
        salience, source_ref, source_type, provenance_json, extracted_at, last_accessed,
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
    const totalRows = await queryRows<CountRow>(this.pool, `
      SELECT COUNT(*) AS count
      FROM l2_memories
      WHERE ${where.sql}
    `, where.values);
    return {
      memories: rows.map(fromMemoryRow),
      total: totalRows[0] ? parsePgNumber(totalRows[0].count, 'count') : 0,
      privacySummary: await this.getAdminMemoryPrivacySummary(),
    };
  }

  async getAdminMemoryPrivacySummary(): Promise<MemoryAdminPrivacySummary> {
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
    const aggregateRows = await queryRows<AdminMemoryPrivacyAggregateRow>(this.pool, `
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
    const sensitivityRows = await queryRows<SensitivityCountRow>(this.pool, `
      SELECT COALESCE(sensitivity, 'personal') AS sensitivity, COUNT(*) AS count
      FROM l2_memories
      WHERE ${activeWhere}
      GROUP BY COALESCE(sensitivity, 'personal')
    `);
    return mapPostgresAdminPrivacySummary(aggregateRows[0], sensitivityRows);
  }

  async countActiveMemories(): Promise<number> {
    return Array.from(this.memories.values()).filter(memory => !memory.supersededBy && !memory.deletedAt).length;
  }

  async getById(id: string): Promise<PurrMemory | undefined> {
    return this.memories.get(id);
  }

  async softDeleteMemory(id: string, options: MemorySoftDeleteOptions = {}): Promise<MemoryDeleteVersion | null> {
    const memory = this.memories.get(id);
    if (!memory || memory.deletedAt) return null;
    const deleteId = options.deleteId ?? randomUUID();
    const deletedAt = options.deletedAt ?? Date.now();
    const deletedBy = options.deletedBy?.trim() || 'agent';
    const deleteReason = options.reason?.trim();
    const version: MemoryDeleteVersion = {
      deleteId,
      memoryId: id,
      snapshot: memory,
      deletedAt,
      deletedBy,
      ...(deleteReason ? { deleteReason } : {}),
    };
    await this.persist(async () => {
      await this.upsertDeleteVersion(version);
      await this.upsertMemoryRow({ ...memory, deletedAt, deletedBy, deleteReason }, this.embeddings.get(id));
    });
    this.memories.set(id, { ...memory, deletedAt, deletedBy, deleteReason });
    this.deleteVersions.set(deleteId, version);
    this.journal?.onSoftDelete(version);
    return version;
  }

  async undoSoftDelete(deleteId: string, options: MemoryUndoSoftDeleteOptions = {}): Promise<MemoryDeleteVersion | null> {
    const version = this.deleteVersions.get(deleteId);
    if (!version) return null;
    const current = this.memories.get(version.memoryId);
    if (!current) return null;
    const restoredAt = options.restoredAt ?? Date.now();
    const restoredBy = options.restoredBy?.trim() || 'agent';
    const restored = { ...current, deletedAt: undefined, deletedBy: undefined, deleteReason: undefined };
    const nextVersion = { ...version, restoredAt, restoredBy };
    await this.persist(async () => {
      await this.upsertDeleteVersion(nextVersion);
      await this.upsertMemoryRow(restored, this.embeddings.get(version.memoryId));
    });
    this.memories.set(version.memoryId, restored);
    this.deleteVersions.set(deleteId, nextVersion);
    this.journal?.onRestore(nextVersion);
    return nextVersion;
  }

  async getDeleteVersion(deleteId: string): Promise<MemoryDeleteVersion | undefined> {
    return this.deleteVersions.get(deleteId);
  }

  async recordAbstractionLink(input: MemoryAbstractionLinkInput): Promise<MemoryAbstractionLink> {
    const id = input.linkId?.trim() || randomUUID();
    const link: MemoryAbstractionLink = {
      id,
      sourceMemoryId: input.sourceMemoryId.trim(),
      abstractedMemoryId: input.abstractedMemoryId.trim(),
      externalRef: input.externalRef.trim(),
      createdAt: input.createdAt ?? Date.now(),
      ...(input.createdBy ? { createdBy: input.createdBy.trim() } : {}),
      ...(input.reason ? { reason: input.reason.trim() } : {}),
    };
    await this.persist(async () => {
      await executeQuery(this.pool, `
        INSERT INTO l2_memory_abstraction_links (
          id, source_memory_id, abstracted_memory_id, external_ref, created_at, created_by, reason
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (id) DO UPDATE SET
          source_memory_id = EXCLUDED.source_memory_id,
          abstracted_memory_id = EXCLUDED.abstracted_memory_id,
          external_ref = EXCLUDED.external_ref,
          created_at = EXCLUDED.created_at,
          created_by = EXCLUDED.created_by,
          reason = EXCLUDED.reason
      `, [link.id, link.sourceMemoryId, link.abstractedMemoryId, link.externalRef, link.createdAt, link.createdBy ?? null, link.reason ?? null]);
    });
    this.abstractionLinks.set(link.id, link);
    return link;
  }

  async getAbstractionLinksForSourceMemory(sourceMemoryId: string): Promise<MemoryAbstractionLink[]> {
    return Array.from(this.abstractionLinks.values()).filter(link => link.sourceMemoryId === sourceMemoryId);
  }

  async getAbstractionLinksForAbstractedMemory(abstractedMemoryId: string): Promise<MemoryAbstractionLink[]> {
    return Array.from(this.abstractionLinks.values()).filter(link => link.abstractedMemoryId === abstractedMemoryId);
  }

  async recordEvolutionLink(input: MemoryEvolutionLinkInput): Promise<MemoryEvolutionLink> {
    const link = normalizeEvolutionLinkInput(input);
    await this.persist(async () => {
      await executeQuery(this.pool, `
        INSERT INTO memory_evolution_links (
          id, source_memory_id, target_memory_id, relation, confidence, reason,
          source_ref, source_type, provenance_refs, provenance_json, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (source_memory_id, target_memory_id, relation) DO UPDATE SET
          id = EXCLUDED.id,
          confidence = EXCLUDED.confidence,
          reason = EXCLUDED.reason,
          source_ref = EXCLUDED.source_ref,
          source_type = EXCLUDED.source_type,
          provenance_refs = EXCLUDED.provenance_refs,
          provenance_json = EXCLUDED.provenance_json,
          created_at = EXCLUDED.created_at
      `, [
        link.id,
        link.sourceMemoryId,
        link.targetMemoryId,
        link.relation,
        link.confidence,
        link.reason ?? null,
        link.sourceRef ?? null,
        link.sourceType,
        serializeJsonValue(link.provenanceRefs),
        serializeJsonValue(link.provenance ?? {}),
        link.createdAt,
      ]);
    });
    this.memoryEvolutionLinks.set(memoryEvolutionKey(
      link.sourceMemoryId,
      link.targetMemoryId,
      link.relation,
    ), link);
    return link;
  }

  async getEvolutionLinksForSourceMemory(
    sourceMemoryId: string,
    relation?: MemoryEvolutionRelation,
  ): Promise<MemoryEvolutionLink[]> {
    const normalized = sourceMemoryId.trim();
    if (!normalized) return [];
    const normalizedRelation = relation ? normalizeEvolutionRelation(relation) : undefined;
    return Array.from(this.memoryEvolutionLinks.values())
      .filter(link => link.sourceMemoryId === normalized)
      .filter(link => normalizedRelation === undefined || link.relation === normalizedRelation)
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
  }

  async getEvolutionLinksForTargetMemory(
    targetMemoryId: string,
    relation?: MemoryEvolutionRelation,
  ): Promise<MemoryEvolutionLink[]> {
    const normalized = targetMemoryId.trim();
    if (!normalized) return [];
    const normalizedRelation = relation ? normalizeEvolutionRelation(relation) : undefined;
    return Array.from(this.memoryEvolutionLinks.values())
      .filter(link => link.targetMemoryId === normalized)
      .filter(link => normalizedRelation === undefined || link.relation === normalizedRelation)
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
  }

  async getStats(): Promise<MemoryStoreStats> {
    const active = Array.from(this.memories.values()).filter(memory => !memory.supersededBy && !memory.deletedAt);
    const byType: Record<string, number> = {};
    let salience = 0;
    for (const memory of active) {
      byType[memory.type] = (byType[memory.type] ?? 0) + 1;
      salience += memory.salience;
    }
    return {
      total: active.length,
      byType,
      avgSalience: active.length > 0 ? salience / active.length : 0,
    };
  }

  async upsertMemoryMaintenanceReview(input: MemoryMaintenanceReviewInput): Promise<MemoryMaintenanceReview> {
    const review = normalizeMemoryMaintenanceReviewInput(input);
    await this.persist(async () => {
      await executeQuery(this.pool, `
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

    const evolutionDecisionCountsByRelation: Record<MemoryEvolutionRelation, number> = {
      supersedes: 0,
      updates: 0,
      negates: 0,
      conflicts_with: 0,
    };
    let latestEvolutionDecisionAt: number | undefined;
    for (const link of this.memoryEvolutionLinks.values()) {
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
      evolutionDecisionCount: this.memoryEvolutionLinks.size,
      evolutionDecisionCountsByRelation,
      supersessionDecisionCount: evolutionDecisionCountsByRelation.supersedes,
      conflictDecisionCount: evolutionDecisionCountsByRelation.conflicts_with
        + evolutionDecisionCountsByRelation.negates,
      ...(latestEvolutionDecisionAt !== undefined && latestEvolutionDecisionAt > 0
        ? { latestEvolutionDecisionAt }
        : {}),
    };
  }

  async getMemoriesByChannel(channelId: string, limit: number): Promise<PurrMemory[]> {
    return Array.from(this.memories.values())
      .filter(memory => !memory.supersededBy && !memory.deletedAt && memory.sourceRef.startsWith(`${channelId}:`))
      .sort((left, right) => right.extractedAt - left.extractedAt)
      .slice(0, limit);
  }

  async getMemoriesByContact(contactId: string, limit: number): Promise<PurrMemory[]> {
    return Array.from(this.memories.values())
      .filter(memory => !memory.supersededBy && !memory.deletedAt && memory.contactId === contactId)
      .sort((left, right) => right.salience - left.salience || right.extractedAt - left.extractedAt)
      .slice(0, limit);
  }

  async linkMemories(id1: string, id2: string, linkType: string = 'related'): Promise<MemoryLink | null> {
    const normalizedId1 = id1.trim();
    const normalizedId2 = id2.trim();
    if (!normalizedId1 || !normalizedId2 || normalizedId1 === normalizedId2) return null;
    const [first, second] = normalizedId1 < normalizedId2 ? [normalizedId1, normalizedId2] : [normalizedId2, normalizedId1];
    const key = memoryKey(first, second);
    if (this.memoryLinks.has(key)) return null;
    const link: MemoryLink = { id1: first, id2: second, linkType: linkType.trim() || 'related', createdAt: Date.now() };
    await this.persist(async () => {
      await executeQuery(this.pool, `
        INSERT INTO memory_links (id1, id2, link_type, created_at)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (id1, id2) DO UPDATE SET
          link_type = EXCLUDED.link_type,
          created_at = EXCLUDED.created_at
      `, [link.id1, link.id2, link.linkType, link.createdAt]);
    });
    this.memoryLinks.set(key, link);
    return link;
  }

  async unlinkMemories(id1: string, id2: string): Promise<boolean> {
    const normalizedId1 = id1.trim();
    const normalizedId2 = id2.trim();
    if (!normalizedId1 || !normalizedId2) return false;
    const [first, second] = normalizedId1 < normalizedId2 ? [normalizedId1, normalizedId2] : [normalizedId2, normalizedId1];
    const key = memoryKey(first, second);
    if (!this.memoryLinks.has(key)) return false;
    await this.persist(async () => {
      await executeQuery(this.pool, 'DELETE FROM memory_links WHERE id1 = $1 AND id2 = $2', [first, second]);
    });
    this.memoryLinks.delete(key);
    return true;
  }

  async getLinkedMemories(id: string): Promise<MemoryLink[]> {
    const normalizedId = id.trim();
    if (!normalizedId) return [];
    return Array.from(this.memoryLinks.values())
      .filter(link => link.id1 === normalizedId || link.id2 === normalizedId)
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async bulkDelete(ids: string[]): Promise<number> {
    let count = 0;
    for (const id of ids) {
      const deleted = await this.softDeleteMemory(id, { deletedBy: 'admin:bulk', reason: 'bulk delete' });
      if (deleted) count += 1;
    }
    return count;
  }

  async bulkUpdate(ids: string[], fields: MemoryBulkUpdatePatch): Promise<number> {
    if (
      fields.type === undefined
      && fields.sensitivity === undefined
      && fields.retentionClass === undefined
    ) {
      return 0;
    }

    const updatesById = new Map<string, PurrMemory>();
    for (const id of ids) {
      const normalizedId = id.trim();
      if (!normalizedId) continue;
      const existing = this.memories.get(normalizedId);
      if (!existing || existing.deletedAt) continue;
      const next = { ...existing };
      if (fields.type !== undefined) next.type = fields.type;
      if (fields.sensitivity !== undefined) next.sensitivity = fields.sensitivity;
      if (fields.retentionClass !== undefined) {
        next.retentionClass = fields.retentionClass;
        next.tags = applyRetentionClassTags(existing, fields.retentionClass);
      }
      updatesById.set(normalizedId, next);
    }
    const updates = [...updatesById.values()];
    if (updates.length === 0) return 0;

    const values: unknown[] = [];
    const valueColumns = ['id'];
    const setClauses: string[] = [];
    if (fields.type !== undefined) {
      valueColumns.push('type');
      setClauses.push('type = updates.type');
    }
    if (fields.sensitivity !== undefined) {
      valueColumns.push('sensitivity');
      setClauses.push('sensitivity = updates.sensitivity');
    }
    if (fields.retentionClass !== undefined) {
      valueColumns.push('retention_class', 'tags');
      setClauses.push('retention_class = updates.retention_class', 'tags = updates.tags');
    }

    const rows = updates.map((update) => {
      const row: string[] = [];
      values.push(update.id);
      row.push(`$${values.length}::text`);
      if (fields.type !== undefined) {
        values.push(update.type);
        row.push(`$${values.length}::text`);
      }
      if (fields.sensitivity !== undefined) {
        values.push(update.sensitivity);
        row.push(`$${values.length}::text`);
      }
      if (fields.retentionClass !== undefined) {
        values.push(update.retentionClass ?? null);
        row.push(`$${values.length}::text`);
        values.push(JSON.stringify(update.tags));
        row.push(`$${values.length}::jsonb`);
      }
      return `(${row.join(', ')})`;
    });

    const result = await this.persist(() => executeQuery(this.pool, `
      UPDATE l2_memories AS memory
      SET ${setClauses.join(', ')}
      FROM (VALUES ${rows.join(', ')}) AS updates(${valueColumns.join(', ')})
      WHERE memory.id = updates.id
        AND memory.deleted_at IS NULL
      RETURNING memory.id
    `, values));

    const updatedIds = new Set(result.rows.flatMap(row => (
      typeof row.id === 'string' ? [row.id] : []
    )));
    for (const update of updates) {
      if (updatedIds.has(update.id)) {
        this.memories.set(update.id, update);
      }
    }
    return result.rowCount ?? updatedIds.size;
  }

  async bulkUpdateSalience(updates: MemorySalienceUpdate[]): Promise<number> {
    const normalizedUpdates = normalizeMemorySalienceUpdates(updates);
    if (normalizedUpdates.length === 0) return 0;

    const values: unknown[] = [];
    const rows = normalizedUpdates.map((update, index) => {
      const idParam = index * 2 + 1;
      const salienceParam = idParam + 1;
      values.push(update.id, update.salience);
      return `($${idParam}::text, $${salienceParam}::numeric)`;
    });

    const result = await this.persist(() => executeQuery(this.pool, `
      UPDATE l2_memories AS memory
      SET salience = updates.salience
      FROM (VALUES ${rows.join(', ')}) AS updates(id, salience)
      WHERE memory.id = updates.id
        AND memory.deleted_at IS NULL
        AND memory.superseded_by IS NULL
      RETURNING memory.id
    `, values));

    const updatedIds = new Set(result.rows.flatMap(row => (
      typeof row.id === 'string' ? [row.id] : []
    )));
    for (const update of normalizedUpdates) {
      if (!updatedIds.has(update.id)) continue;
      const existing = this.memories.get(update.id);
      if (!existing || existing.deletedAt) continue;
      this.memories.set(update.id, { ...existing, salience: update.salience });
    }

    return result.rowCount ?? 0;
  }

  async upsertContactProfile(profile: ContactProfileArtifact): Promise<void> {
    await this.persist(() => this.persistContactProfile(profile));
    this.contactProfiles.set(profile.contactId, profile);
  }

  async getContactProfile(contactId: string): Promise<ContactProfileArtifact | undefined> {
    return this.contactProfiles.get(contactId);
  }

  async listContactProfiles(): Promise<ContactProfileArtifact[]> {
    return Array.from(this.contactProfiles.values()).sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async addScratchpadEntry(
    content: string,
    options: ScratchpadEntryCreateOptions = {},
  ): Promise<ScratchpadAddResult> {
    const normalized = content.trim();
    if (!normalized) throw new Error('Scratchpad content is required');
    const now = options.now ?? Date.now();
    const id = options.id?.trim() || randomUUID();
    const entry: ScratchpadEntry = { id, content: normalized, createdAt: now, updatedAt: now };
    await this.persist(() => this.upsertScratchpadEntry(entry));
    this.scratchpadEntries.set(id, entry);
    const evictedIds = await this.pruneScratchpadEntries();
    const current = this.scratchpadEntries.get(id);
    if (!current) throw new Error(`Failed to load scratchpad entry after insert: ${id}`);
    return { entry: current, evictedIds };
  }

  async replaceScratchpadEntry(
    id: string,
    content: string,
    options: ScratchpadEntryReplaceOptions = {},
  ): Promise<ScratchpadEntry | null> {
    const normalizedId = id.trim();
    if (!normalizedId) return null;
    const existing = this.scratchpadEntries.get(normalizedId);
    if (!existing) return null;
    const updated = {
      ...existing,
      content: content.trim(),
      updatedAt: options.now ?? Date.now(),
    };
    await this.persist(() => this.upsertScratchpadEntry(updated));
    this.scratchpadEntries.set(normalizedId, updated);
    return updated;
  }

  async appendScratchpadEntry(
    id: string,
    content: string,
    options: ScratchpadEntryReplaceOptions = {},
  ): Promise<ScratchpadEntry | null> {
    const normalizedId = id.trim();
    if (!normalizedId) return null;
    const existing = this.scratchpadEntries.get(normalizedId);
    if (!existing) return null;
    const appendix = content.trim();
    if (!appendix) {
      throw new Error('Scratchpad content is required');
    }

    const separator = existing.content.length > 0 ? '\n' : '';
    const updated = {
      ...existing,
      content: `${existing.content}${separator}${appendix}`,
      updatedAt: options.now ?? Date.now(),
    };
    await this.persist(() => this.upsertScratchpadEntry(updated));
    this.scratchpadEntries.set(normalizedId, updated);
    return updated;
  }

  async removeScratchpadEntry(id: string): Promise<boolean> {
    const normalizedId = id.trim();
    if (!normalizedId) return false;
    if (!this.scratchpadEntries.has(normalizedId)) return false;
    await this.persist(async () => {
      await executeQuery(this.pool, 'DELETE FROM scratchpad_entries WHERE id = $1', [normalizedId]);
    });
    this.scratchpadEntries.delete(normalizedId);
    this.syncScratchpadMirror();
    return true;
  }

  async getScratchpadEntry(id: string): Promise<ScratchpadEntry | undefined> {
    this.pruneExpiredScratchpadEntries();
    return this.scratchpadEntries.get(id.trim());
  }

  listScratchpadEntries(limit: number = 64): ScratchpadEntry[] {
    this.pruneExpiredScratchpadEntries();
    return Array.from(this.scratchpadEntries.values())
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
      .slice(0, clampLimit(limit, SCRATCHPAD_MAX_ENTRIES, 1, SCRATCHPAD_MAX_ENTRIES));
  }

  private async pruneScratchpadEntries(): Promise<string[]> {
    this.pruneExpiredScratchpadEntries();
    const maxEntries = SCRATCHPAD_MAX_ENTRIES;
    const ordered = Array.from(this.scratchpadEntries.values())
      .sort((left, right) => left.updatedAt - right.updatedAt || left.createdAt - right.createdAt);
    const overflow = Math.max(0, ordered.length - maxEntries);
    const evicted = ordered.slice(0, overflow).map(entry => entry.id);
    if (evicted.length > 0) {
      await this.persist(async () => {
        for (const id of evicted) {
          await executeQuery(this.pool, 'DELETE FROM scratchpad_entries WHERE id = $1', [id]);
        }
      });
      for (const id of evicted) {
        this.scratchpadEntries.delete(id);
      }
    }
    this.syncScratchpadMirror();
    return evicted;
  }
}
