import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
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
import { startPostgresStoreReadiness } from '../../persistence/postgres/runtime-readiness.js';
import type { MemoryJournal } from './journal.js';
import type {
  ActiveMemoryWindowOptions,
  ActiveMemoryWindowResult,
  RecentContactShapeArtifact,
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
  ActiveMemoryListOptions,
  MemoryLink,
  MemoryMaintenanceReview,
  MemoryMaintenanceReviewInput,
  MemoryMaintenanceReviewListOptions,
  MemorySalienceUpdate,
  MemorySoftDeleteOptions,
  MemoryStorePort,
  MemoryStoreStats,
  MemoryStoreUpdatePatch,
  MemoryStoreUpdateOptions,
  MemoryPatchEvent,
  MemoryUndoSoftDeleteOptions,
  ScratchpadAddResult,
  ScratchpadEntry,
  ScratchpadEntryCreateOptions,
  ScratchpadEntryReplaceOptions,
  MemoryEmbeddingSample,
  MemoryWriteCommit,
  MemorySubjectAuthorizedMutation,
  MemorySubjectAuthorizedWrite,
  MemorySubjectAuthorizedDelete,
  MemorySubjectAuthorizedRestore,
  MemorySubjectAuthorizedQuery,
  MemorySubjectAuthorizedQueryResult,
  MemorySubjectAdminQuery,
  MemorySubjectAdminResult,
  MemorySubjectBackfillOptions,
  MemorySubjectBackfillResult,
  MemorySubjectClassificationCoverage,
  EmbeddingSearchAuthorization,
} from './memory-store-port.js';
import type {
  MemoryDeletionProposalStorePort,
} from './deletion-proposals.js';
import { InactiveMemoryUpdateError } from './memory-store-port.js';
import {
  applyRetentionClassTags,
  normalizeMemoryProvenance,
  normalizeMemoryScopeRef,
  normalizeMemoryScopeTags,
  normalizeMemorySourceType,
  type MemoryScopeQuery,
  type PurrMemory,
} from './types.js';
import type { MemoryRow } from './postgres-store/rows.js';
import {
  decodeEmbedding,
  tryFromMemoryRow,
  serializeJsonValue,
  validateEmbeddingDimensions,
} from './postgres-store/rows.js';
import {
  inspectMemorySubjectClassificationCoverage,
} from './postgres-store/subject-coverage.js';
import {
  assertExistingMemorySchemaHasEmbeddingColumn,
  validatePostgresMemorySchema,
} from './postgres-store/schema.js';
import {
  buildL2EmbeddingAnnIndexConcurrently,
  detectPgvectorIterativeScanSupport,
  type L2EmbeddingAnnIndexBuildOutcome,
} from './postgres-store/embedding-index.js';
import {
  MEMORY_SUBJECT_SELECT_COLUMNS,
  getMemorySubjectClassification as loadMemorySubjectClassification,
  queryAuthorizedMemorySubjects as runAuthorizedMemorySubjectQuery,
} from './postgres-store/subject-queries.js';
import { queryAuthorizedMemorySubjectAdmin as runAuthorizedMemorySubjectAdmin } from './postgres-store/subject-admin-queries.js';
import { PostgresMemoryDeletionProposalStore } from './postgres-store/deletion-proposals.js';
import {
  resolveMemoryDeletionJustification,
  type MemoryDeletionPolicy,
} from '../../system/config/memory-deletion-policy.js';
import { persistMemorySubjectProjection } from './postgres-store/subject-projection.js';
import {
  backfillMemorySubjectClassifications as runMemorySubjectBackfill,
  runMemorySubjectBackfillToCompletion,
} from './postgres-store/subject-backfill.js';
import type { MemorySubjectClassification } from '../../shared/contracts/memory-subject.js';
import type { PostgresMemoryStoreCollaboratorContext } from './postgres-store/collaborator-context.js';
import { PostgresMemoryDeletionStore } from './postgres-store/memory-deletion.js';
import { PostgresMemorySubjectAuthorizedWrites } from './postgres-store/subject-authorized-writes.js';
import { PostgresL2BoundedReads } from './postgres-store/bounded-reads.js';
import { PostgresMemoryBulkUpdates } from './postgres-store/bulk-updates.js';
import { PostgresMemoryLinkStore } from './postgres-store/memory-links.js';
import { PostgresMemoryMaintenanceReviewStore } from './postgres-store/reviews.js';
import { PostgresRecentContactShapeStore } from './postgres-store/contact-shapes.js';
import { PostgresScratchpadStore } from './postgres-store/scratchpad.js';
import { upsertL2MemoryRow } from './postgres-store/memory-row-upsert.js';
import { PostgresL2ReadModel } from './postgres-store/l2-read-model.js';
import {
  listPostgresAdminMemories,
  queryPostgresAdminMemoryPrivacySummary,
} from './postgres-store/admin-queries.js';

const log = createComponentLogger('PostgresMemoryStore');

export interface PostgresMemoryStoreOptions {
  notesDir?: string;
  scratchpadMirrorPath?: string;
  journal?: MemoryJournal;
  /** Optional per-companion Postgres schema; pins the pool's search_path. */
  schema?: string;
  role?: string;
  /** Disable only for bounded-backfill tests; production startup drains this before hydration. */
  subjectBackfill?: false | MemorySubjectBackfillOptions;
  /** Factory-owned startup snapshot exposed to Garden health. */
  startupSubjectClassificationCoverage?: MemorySubjectClassificationCoverage;
  /**
   * Detected at startup, not caller-supplied: whether the connected pgvector
   * supports `hnsw.iterative_scan` (>= 0.8), used to make ANN + subject-filter
   * top-k exact. Threaded through {@link createPostgresMemoryStoreFromPool}.
   */
  annIterativeScanAvailable?: boolean;
  /**
   * Await the background HNSW ANN index build before the factory returns.
   * Production leaves this false so the build stays OFF the boot critical path
   * (it is a performance artifact; queries are correct on a sequential scan
   * without it — see {@link buildL2EmbeddingAnnIndexConcurrently}). Tests set it
   * true for determinism when asserting index existence. Either way the build
   * uses the identical autocommit `CREATE INDEX CONCURRENTLY` path and never
   * throws — a failure is reported as a degraded outcome, not a boot crash.
   */
  awaitAnnIndexBuild?: boolean;
  /** Live settings.json-owned deletion justification authority. */
  memoryDeletionPolicy?: MemoryDeletionPolicy | (() => MemoryDeletionPolicy | undefined);
}

export interface PostgresMemoryStorePort extends MemoryStorePort {
  readonly memoryDeletionProposalStore: MemoryDeletionProposalStorePort;
}

export async function createPostgresMemoryStore(
  databaseUrl: string,
  embeddingDims: number,
  options: PostgresMemoryStoreOptions = {},
): Promise<PostgresMemoryStorePort> {
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-memory',
    allowExitOnIdle: true,
    schema: options.schema,
    role: options.role,
  });
  return await createPostgresMemoryStoreFromPool(pool, embeddingDims, options);
}

export async function createPostgresMemoryStoreFromPool(
  pool: Pool,
  embeddingDims: number,
  options: PostgresMemoryStoreOptions = {},
): Promise<PostgresMemoryStorePort> {
  // A pre-existing l2_memories without its embedding column is a broken
  // schema, not a fresh database; surface the fail-closed guidance before
  // the idempotent migrations trip over the missing column with a raw
  // Postgres error.
  await assertExistingMemorySchemaHasEmbeddingColumn(pool);
  await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
  await validatePostgresMemorySchema(pool);
  // Detect whether iterative scans are available for exact ANN + subject-filter.
  // This is a cheap metadata read and stays on the critical path.
  const annIterativeScanAvailable = await detectPgvectorIterativeScanSupport(pool);
  if (options.subjectBackfill !== false) {
    await runMemorySubjectBackfillToCompletion(pool, embeddingDims, options.subjectBackfill);
  }
  const startupSubjectClassificationCoverage =
    await inspectMemorySubjectClassificationCoverage(pool);
  if (startupSubjectClassificationCoverage.missingCurrentClassificationCount > 0) {
    log.warn('Memory subject classification coverage is incomplete at startup', {
      ...startupSubjectClassificationCoverage,
    });
  } else {
    log.info('Memory subject classification coverage is complete at startup', {
      ...startupSubjectClassificationCoverage,
    });
  }
  const store = new PostgresMemoryStore(pool, embeddingDims, {
    ...options,
    annIterativeScanAvailable,
    startupSubjectClassificationCoverage,
  });
  await store.waitUntilReady();
  // Build the dimension-parameterized HNSW ANN index concurrently with the
  // remainder of startup, but register it as optional readiness. Semantic
  // search remains query-correct on a sequential scan if it fails; the process
  // may advertise Ready only after this DDL has settled.
  const annIndexBuild = store.startAnnIndexBuild();
  startPostgresStoreReadiness('memory_ann_index', async () => {
    const outcome = await annIndexBuild;
    if (outcome.status === 'degraded') throw outcome.error;
  });
  if (options.awaitAnnIndexBuild === true) {
    await annIndexBuild;
  }
  return store;
}

interface MemoryStoreTransactionState {
  client: PoolClient;
  operations: Array<Promise<unknown>>;
}

class PostgresMemoryStore implements PostgresMemoryStorePort {
  private readonly pool: Pool;
  private readonly embeddingDims: number;
  private readonly annIterativeScanAvailable: boolean;
  private readonly startupSubjectClassificationCoverage: MemorySubjectClassificationCoverage;
  /** Background HNSW ANN index build; kicked off once, off the boot critical path. */
  private annIndexBuild: Promise<L2EmbeddingAnnIndexBuildOutcome> | null = null;
  private annIndexBuildStatus: 'idle' | 'building' | 'ready' | 'degraded' = 'idle';
  private readonly journal: MemoryJournal | null;
  private persistChain: Promise<void> = Promise.resolve();
  private readonly initialization: Promise<void>;
  private salienceMaintenanceRevision = 0;
  private retrievalCorpusVersion = 0;
  /** Active transaction scope: writes issued inside a runInTransaction handler join its client. */
  private readonly transactionContext = new AsyncLocalStorage<MemoryStoreTransactionState>();
  readonly memoryDeletionProposalStore: MemoryDeletionProposalStorePort;
  private readonly deletionProposalPersistence: PostgresMemoryDeletionProposalStore;

  private readonly collaboratorContext: PostgresMemoryStoreCollaboratorContext;
  private readonly memoryDeletion: PostgresMemoryDeletionStore;
  private readonly subjectAuthorizedWrites: PostgresMemorySubjectAuthorizedWrites;
  private readonly boundedReads: PostgresL2BoundedReads;
  private readonly bulkUpdates: PostgresMemoryBulkUpdates;
  private readonly links: PostgresMemoryLinkStore;
  private readonly maintenanceReviews: PostgresMemoryMaintenanceReviewStore;
  private readonly recentContactShapes: PostgresRecentContactShapeStore;
  private readonly scratchpad: PostgresScratchpadStore;
  // L2 memory rows are NOT hydrated into process memory (ufgwv; embeddings
  // since a27w.1). Detail/list/count/search reads are bounded SQL through
  // PostgresL2ReadModel, so resident memory and boot cost no longer scale with
  // lifetime corpus size.
  private readonly readModel: PostgresL2ReadModel;

  constructor(
    pool: Pool,
    embeddingDims: number,
    options: PostgresMemoryStoreOptions & {
      startupSubjectClassificationCoverage: MemorySubjectClassificationCoverage;
    },
  ) {
    this.pool = pool;
    this.embeddingDims = embeddingDims;
    this.annIterativeScanAvailable = options.annIterativeScanAvailable ?? false;
    this.startupSubjectClassificationCoverage = options.startupSubjectClassificationCoverage;
    this.journal = options.journal ?? null;
    const scratchpadMirrorPath = options.scratchpadMirrorPath?.trim() ? options.scratchpadMirrorPath.trim() : null;
    const ctx: PostgresMemoryStoreCollaboratorContext = {
      pool,
      embeddingDims,
      persist: <T>(task: () => Promise<T>): Promise<T> => this.persist(task),
      settle: () => this.persistChain,
      hasActiveTransaction: () => this.transactionContext.getStore() !== undefined,
      runInTransaction: <T>(handler: () => T): Promise<T> => this.runInTransaction(handler),
      queryWrite: <T extends QueryResultRow>(text: string, values: readonly unknown[]) => (
        this.queryWrite<T>(text, values)
      ),
      persistClassifiedMemoryRow: (memory, embedding) => this.persistClassifiedMemoryRow(memory, embedding),
      markSalienceMaintenanceChanged: () => this.markSalienceMaintenanceChanged(),
      markRetrievalCorpusChanged: () => this.markRetrievalCorpusChanged(),
    };
    this.collaboratorContext = ctx;
    this.readModel = new PostgresL2ReadModel(ctx);
    this.memoryDeletion = new PostgresMemoryDeletionStore(
      ctx,
      this.readModel,
      this.journal,
      input => this.deletionProposalPersistence.markRestored(input),
    );
    this.subjectAuthorizedWrites = new PostgresMemorySubjectAuthorizedWrites(ctx, {
      updateMemory: (id, updates, updateOptions) => this.updateMemory(id, updates, updateOptions),
      insertMemory: (memory, embedding) => this.insertMemory(memory, embedding),
    });
    this.boundedReads = new PostgresL2BoundedReads(ctx, this.annIterativeScanAvailable);
    this.bulkUpdates = new PostgresMemoryBulkUpdates(ctx, this.readModel);
    this.links = new PostgresMemoryLinkStore(ctx);
    this.maintenanceReviews = new PostgresMemoryMaintenanceReviewStore(
      ctx,
      () => this.links.summarizeEvolutionDecisions(),
    );
    this.recentContactShapes = new PostgresRecentContactShapeStore(ctx);
    this.scratchpad = new PostgresScratchpadStore(ctx, scratchpadMirrorPath);
    this.deletionProposalPersistence = new PostgresMemoryDeletionProposalStore({
      runInTransaction: async <T>(handler: () => Promise<T>): Promise<T> => (
        await this.runInTransaction(handler)
      ),
      queryWrite: <T extends QueryResultRow>(text: string, values: readonly unknown[]) => (
        this.queryWrite<T>(text, values)
      ),
      queryRead: async <T extends QueryResultRow>(text: string, values: readonly unknown[]) => {
        await this.persistChain;
        return await queryRows<T>(this.pool, text, values);
      },
      hasActiveTransaction: () => this.transactionContext.getStore() !== undefined,
      upsertDeleteVersion: version => this.memoryDeletion.upsertDeleteVersion(version),
      persistClassifiedMemoryRow: (memory, embedding) => this.persistClassifiedMemoryRow(memory, embedding),
      validateEmbedding: (embedding, operation) => (
        validateEmbeddingDimensions(embedding, this.embeddingDims, operation)
      ),
      assertJustification: (categoryId, explanation) => {
        const policy = typeof options.memoryDeletionPolicy === 'function'
          ? options.memoryDeletionPolicy()
          : options.memoryDeletionPolicy;
        return resolveMemoryDeletionJustification(policy, categoryId, explanation);
      },
      onApproved: (version) => {
        this.markSalienceMaintenanceChanged();
        this.markRetrievalCorpusChanged();
        this.journal?.onSoftDelete(version);
      },
    });
    this.memoryDeletionProposalStore = this.deletionProposalPersistence;
    this.initialization = this.initialize();
  }

  async waitUntilReady(): Promise<void> {
    await this.initialization;
  }

  getStartupMemorySubjectClassificationCoverage(): MemorySubjectClassificationCoverage {
    return { ...this.startupSubjectClassificationCoverage };
  }

  /**
   * Start the background HNSW ANN index build (idempotent). Returns the settle
   * promise so callers that want determinism (tests) can await it; production
   * registers that promise with process readiness. The underlying build never
   * throws — a failure resolves to a `degraded` outcome and leaves semantic
   * search query-correct on a sequential scan.
   */
  startAnnIndexBuild(): Promise<L2EmbeddingAnnIndexBuildOutcome> {
    if (this.annIndexBuild) return this.annIndexBuild;
    this.annIndexBuildStatus = 'building';
    this.annIndexBuild = buildL2EmbeddingAnnIndexConcurrently(this.pool, this.embeddingDims)
      .then((outcome) => {
        this.annIndexBuildStatus = outcome.status;
        return outcome;
      });
    return this.annIndexBuild;
  }

  /**
   * Coarse capability signal for the ANN index build: 'building' while it runs,
   * 'ready' once the index is live, 'degraded' if the build failed (queries
   * remain correct but unindexed). Loud structured logs accompany each
   * transition; this accessor exposes the state for status/observability
   * surfaces.
   */
  getAnnIndexBuildStatus(): 'idle' | 'building' | 'ready' | 'degraded' {
    return this.annIndexBuildStatus;
  }

  getSalienceMaintenanceRevision(): number {
    return this.salienceMaintenanceRevision;
  }

  async getRetrievalCorpusVersion(): Promise<number> {
    if (this.transactionContext.getStore()) {
      throw new Error('Retrieval corpus version is unavailable inside a memory-store transaction');
    }
    // Retrieval must not fingerprint or scan the in-memory mirror while a
    // transaction can still roll back. The persist chain settles only after
    // COMMIT/ROLLBACK and cache restoration have completed.
    await this.persistChain;
    return this.retrievalCorpusVersion;
  }

  private markSalienceMaintenanceChanged(): void {
    this.salienceMaintenanceRevision += 1;
  }

  private markRetrievalCorpusChanged(): void {
    this.retrievalCorpusVersion += 1;
  }

  private async initialize(): Promise<void> {
    // ufgwv: boot no longer selects l2_memories at all; L2 rows are read at
    // query time. Embedding-column reachability is still asserted fail-closed
    // before this method runs, by assertExistingMemorySchemaHasEmbeddingColumn +
    // validatePostgresMemorySchema in createPostgresMemoryStoreFromPool.
    // t4mia: delete versions, links, maintenance reviews, and contact shapes
    // are read at query time as well; only the self-pruning scratchpad hydrates.
    await this.scratchpad.hydrate();
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
    await this.queryWrite(text, values);
  }

  private async queryWrite<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[],
  ): Promise<T[]> {
    const transaction = this.transactionContext.getStore();
    if (transaction) {
      return (await transaction.client.query<T>(text, [...values])).rows;
    }
    return (await executeQuery<T>(this.pool, text, values)).rows;
  }

  private async upsertMemoryRow(memory: PurrMemory, embedding?: Float32Array): Promise<number> {
    return await upsertL2MemoryRow(this.collaboratorContext, memory, embedding);
  }

  private async upsertMemorySubjectProjection(
    memory: PurrMemory,
    memoryRevision: number,
    embedding?: Float32Array,
  ): Promise<void> {
    const transaction = this.transactionContext.getStore();
    if (!transaction) {
      throw new Error('Memory subject projection writes require a memory-store transaction');
    }
    await persistMemorySubjectProjection(transaction.client, memory, memoryRevision, embedding);
  }

  private async persistClassifiedMemoryRow(
    memory: PurrMemory,
    embedding?: Float32Array,
  ): Promise<void> {
    const write = async (): Promise<void> => {
      const revision = await this.upsertMemoryRow(memory, embedding);
      await this.upsertMemorySubjectProjection(memory, revision, embedding);
    };
    if (this.transactionContext.getStore()) {
      await write();
      return;
    }
    await this.runInTransaction(write);
  }

  async insertMemory(memory: PurrMemory, embedding: Float32Array): Promise<void> {
    validateEmbeddingDimensions(embedding, this.embeddingDims, 'insert');
    const anchoredMemory = {
      ...memory,
      salienceDecayAnchorAt: memory.salienceDecayAnchorAt ?? memory.lastAccessed,
    };
    await this.persistClassifiedMemoryRow(anchoredMemory, embedding);
    this.markSalienceMaintenanceChanged();
    this.markRetrievalCorpusChanged();
    this.journal?.onInsert(anchoredMemory);
  }

  async persistMemoryWrite(input: MemoryWriteCommit): Promise<void> {
    const commit = async (): Promise<void> => {
      for (const id of new Set(input.supersededMemoryIds ?? [])) {
        await this.updateMemory(id, { supersededBy: input.memory.id });
      }
      await this.insertMemory(input.memory, input.embedding);
    };
    if (this.transactionContext.getStore()) {
      await commit();
      return;
    }
    await this.runInTransaction(commit);
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
      const salienceMaintenanceRevisionSnapshot = this.salienceMaintenanceRevision;
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
        // Embeddings (a27w.1) and delete versions (t4mia) are not held in
        // memory; the database ROLLBACK above is the sole authority for them.
        this.salienceMaintenanceRevision = salienceMaintenanceRevisionSnapshot;
        // Generations are monotonic. A rollback is itself a corpus transition:
        // any refresh that observed staged in-memory data must become stale.
        this.markRetrievalCorpusChanged();
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
    scopeQuery: MemoryScopeQuery | undefined,
    authorization: EmbeddingSearchAuthorization,
  ): Promise<Array<PurrMemory & { similarity: number }>> {
    return await this.boundedReads.searchByEmbedding(embedding, threshold, limit, scopeQuery, authorization);
  }

  async searchByText(
    query: string,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Promise<Array<PurrMemory & { similarity: number }>> {
    return await this.readModel.searchByText(query, limit, scopeQuery);
  }

  async updateMemory(
    id: string,
    updates: MemoryStoreUpdatePatch,
    options: MemoryStoreUpdateOptions = {},
  ): Promise<void> {
    if (updates.text !== undefined && updates.embedding === undefined) {
      throw new Error('Memory text updates require a replacement embedding');
    }
    const update = async (): Promise<void> => {
      const rows = await this.queryWrite<MemoryRow>(`
        SELECT ${MEMORY_SUBJECT_SELECT_COLUMNS}
        FROM l2_memories memory
        WHERE memory.id = $1
        FOR UPDATE
      `, [id]);
      const currentRow = rows.at(0);
      if (!currentRow) return;
      const decoded = tryFromMemoryRow(currentRow);
      if (!decoded) return;
      const next = { ...decoded };
      if (options.requireActive && (next.supersededBy !== undefined || next.deletedAt !== undefined)) {
        throw new InactiveMemoryUpdateError(id);
      }
      if (updates.type !== undefined) next.type = updates.type;
      if (updates.text !== undefined) next.text = updates.text;
      if (updates.importance !== undefined) next.importance = updates.importance;
      if (updates.confidence !== undefined) next.confidence = updates.confidence;
      if (updates.emotionalValence !== undefined) next.emotionalValence = updates.emotionalValence;
      if (updates.formationVAD !== undefined) next.formationVAD = updates.formationVAD;
      if (updates.salience !== undefined) next.salience = updates.salience;
      if (updates.lastAccessed !== undefined) next.lastAccessed = updates.lastAccessed;
      if (updates.salience !== undefined || updates.lastAccessed !== undefined) {
        next.salienceDecayAnchorAt = updates.lastAccessed ?? Date.now();
      }
      if (updates.accessCount !== undefined) next.accessCount = updates.accessCount;
      if (updates.supersededBy !== undefined) next.supersededBy = updates.supersededBy;
      if (updates.sensitivity !== undefined) next.sensitivity = updates.sensitivity;
      if (updates.consentFlags !== undefined) next.consentFlags = updates.consentFlags;
      if (updates.tags !== undefined) next.tags = [...updates.tags];
      if (updates.scopeRef !== undefined) next.scopeRef = normalizeMemoryScopeRef(updates.scopeRef);
      if (updates.scopeTags !== undefined) next.scopeTags = normalizeMemoryScopeTags(updates.scopeTags);
      if (updates.provenanceRefs !== undefined) next.provenanceRefs = [...updates.provenanceRefs];
      if (updates.retentionClass !== undefined) {
        next.retentionClass = updates.retentionClass;
        next.tags = applyRetentionClassTags(next, updates.retentionClass);
      }
      if (updates.sourceType !== undefined) next.sourceType = normalizeMemorySourceType(updates.sourceType);
      if (updates.provenance !== undefined) next.provenance = normalizeMemoryProvenance(updates.provenance);
      if (updates.contactId !== undefined) next.contactId = updates.contactId;
      if (updates.deletedAt !== undefined) next.deletedAt = updates.deletedAt;
      if (updates.deletedBy !== undefined) next.deletedBy = updates.deletedBy;
      if (updates.deleteReason !== undefined) next.deleteReason = updates.deleteReason;
      const storedEmbedding = decodeEmbedding(currentRow.embedding);
      if (storedEmbedding) validateEmbeddingDimensions(storedEmbedding, this.embeddingDims, 'update');
      const embedding = updates.embedding ?? storedEmbedding;
      await this.persistClassifiedMemoryRow(next, embedding);
      this.markSalienceMaintenanceChanged();
      if (Object.keys(updates).some(key => key !== 'lastAccessed' && key !== 'accessCount')) {
        this.markRetrievalCorpusChanged();
      }
    };
    if (this.transactionContext.getStore()) {
      await update();
      return;
    }
    await this.runInTransaction(update);
  }

  async getAllActiveMemories(limit: number = 10_000): Promise<PurrMemory[]> {
    return await this.readModel.getAllActiveMemories(limit);
  }

  async listActiveMemoryEmbeddingsSince(
    sinceMs: number,
    limit: number = 4096,
  ): Promise<MemoryEmbeddingSample[]> {
    return await this.boundedReads.listActiveMemoryEmbeddingsSince(sinceMs, limit);
  }

  async listMemories(options: MemoryListOptions = {}): Promise<PurrMemory[]> {
    return await this.readModel.listMemories(options);
  }

  async listActiveMemories(options: ActiveMemoryListOptions = {}): Promise<PurrMemory[]> {
    return await this.readModel.listActiveMemories(options);
  }

  async listActiveMemoriesInWindow(
    options: ActiveMemoryWindowOptions,
  ): Promise<ActiveMemoryWindowResult> {
    return await this.boundedReads.listActiveMemoriesInWindow(options);
  }

  async listAdminMemories(options: MemoryAdminListOptions = {}): Promise<MemoryAdminListResult> {
    return await listPostgresAdminMemories(this.pool, options);
  }

  async getAdminMemoryPrivacySummary(): Promise<MemoryAdminPrivacySummary> {
    return await queryPostgresAdminMemoryPrivacySummary(this.pool);
  }

  async countActiveMemories(): Promise<number> {
    return await this.readModel.countActiveMemories();
  }

  async getById(id: string): Promise<PurrMemory | undefined> {
    return await this.readModel.getById(id);
  }

  async getByIds(ids: readonly string[]): Promise<PurrMemory[]> {
    return await this.readModel.getByIds(ids);
  }

  async queryAuthorizedMemorySubjects(
    input: MemorySubjectAuthorizedQuery,
  ): Promise<MemorySubjectAuthorizedQueryResult> {
    if (this.transactionContext.getStore()) {
      throw new Error('Authorized memory subject queries are unavailable inside a memory-store transaction');
    }
    await this.persistChain;
    return await runAuthorizedMemorySubjectQuery(this.pool, this.embeddingDims, input, {
      iterativeScanAvailable: this.annIterativeScanAvailable,
    });
  }

  async aggregateAuthorizedMemorySubjects(
    input: MemorySubjectAdminQuery,
  ): Promise<MemorySubjectAdminResult> {
    if (this.transactionContext.getStore()) {
      throw new Error('Authorized memory subject aggregates are unavailable inside a memory-store transaction');
    }
    await this.persistChain;
    return await runAuthorizedMemorySubjectAdmin(this.pool, input);
  }

  async getMemorySubjectClassification(
    memoryId: string,
  ): Promise<MemorySubjectClassification | undefined> {
    if (this.transactionContext.getStore()) {
      throw new Error('Memory subject classification reads are unavailable inside a memory-store transaction');
    }
    await this.persistChain;
    return await loadMemorySubjectClassification(this.pool, memoryId);
  }

  async mutateAuthorizedMemorySubjects(input: MemorySubjectAuthorizedMutation): Promise<number> {
    return await this.subjectAuthorizedWrites.mutateAuthorizedMemorySubjects(input);
  }

  async persistAuthorizedMemoryWrite(input: MemorySubjectAuthorizedWrite): Promise<void> {
    await this.subjectAuthorizedWrites.persistAuthorizedMemoryWrite(input);
  }

  async softDeleteAuthorizedMemorySubject(
    input: MemorySubjectAuthorizedDelete,
  ): Promise<MemoryDeleteVersion | null> {
    return await this.memoryDeletion.softDeleteAuthorizedMemorySubject(input);
  }

  async undoAuthorizedMemorySubjectDelete(
    input: MemorySubjectAuthorizedRestore,
  ): Promise<MemoryDeleteVersion | null> {
    return await this.memoryDeletion.undoAuthorizedMemorySubjectDelete(input);
  }

  async backfillMemorySubjectClassifications(
    options: MemorySubjectBackfillOptions = {},
  ): Promise<MemorySubjectBackfillResult> {
    return await this.runInTransaction(async () => {
      const transaction = this.transactionContext.getStore();
      if (!transaction) throw new Error('Memory subject backfill transaction is unavailable');
      return await runMemorySubjectBackfill(transaction.client, this.embeddingDims, options);
    });
  }

  async softDeleteMemory(id: string, options: MemorySoftDeleteOptions = {}): Promise<MemoryDeleteVersion | null> {
    return await this.memoryDeletion.softDeleteMemory(id, options);
  }

  async undoSoftDelete(deleteId: string, options: MemoryUndoSoftDeleteOptions = {}): Promise<MemoryDeleteVersion | null> {
    return await this.memoryDeletion.undoSoftDelete(deleteId, options);
  }

  async getDeleteVersion(deleteId: string): Promise<MemoryDeleteVersion | undefined> {
    return await this.memoryDeletion.getDeleteVersion(deleteId);
  }

  async recordAbstractionLink(input: MemoryAbstractionLinkInput): Promise<MemoryAbstractionLink> {
    return await this.links.recordAbstractionLink(input);
  }

  async getAbstractionLinksForSourceMemory(sourceMemoryId: string): Promise<MemoryAbstractionLink[]> {
    return await this.links.getAbstractionLinksForSourceMemory(sourceMemoryId);
  }

  async getAbstractionLinksForAbstractedMemory(abstractedMemoryId: string): Promise<MemoryAbstractionLink[]> {
    return await this.links.getAbstractionLinksForAbstractedMemory(abstractedMemoryId);
  }

  async recordEvolutionLink(input: MemoryEvolutionLinkInput): Promise<MemoryEvolutionLink> {
    return await this.links.recordEvolutionLink(input);
  }

  async getEvolutionLinksForSourceMemory(
    sourceMemoryId: string,
    relation?: MemoryEvolutionRelation,
  ): Promise<MemoryEvolutionLink[]> {
    return await this.links.getEvolutionLinksForSourceMemory(sourceMemoryId, relation);
  }

  async getEvolutionLinksForTargetMemory(
    targetMemoryId: string,
    relation?: MemoryEvolutionRelation,
  ): Promise<MemoryEvolutionLink[]> {
    return await this.links.getEvolutionLinksForTargetMemory(targetMemoryId, relation);
  }

  async getStats(): Promise<MemoryStoreStats> {
    return await this.readModel.getStats();
  }

  async upsertMemoryMaintenanceReview(input: MemoryMaintenanceReviewInput): Promise<MemoryMaintenanceReview> {
    return await this.maintenanceReviews.upsertMemoryMaintenanceReview(input);
  }

  async listMemoryMaintenanceReviews(
    options: MemoryMaintenanceReviewListOptions = {},
  ): Promise<MemoryMaintenanceReview[]> {
    return await this.maintenanceReviews.listMemoryMaintenanceReviews(options);
  }

  async getMemoryMaintenanceReview(id: string): Promise<MemoryMaintenanceReview | undefined> {
    return await this.maintenanceReviews.getMemoryMaintenanceReview(id);
  }

  async getMemoryMaintenanceDiagnostics(
    options: MemoryMaintenanceDiagnosticsOptions = {},
  ): Promise<MemoryMaintenanceDiagnostics> {
    return await this.maintenanceReviews.getMemoryMaintenanceDiagnostics(options);
  }

  async getMemoriesByChannel(channelId: string, limit: number): Promise<PurrMemory[]> {
    return await this.readModel.getMemoriesByChannel(channelId, limit);
  }

  async getMemoriesByContact(contactId: string, limit: number): Promise<PurrMemory[]> {
    return await this.readModel.getMemoriesByContact(contactId, limit);
  }

  async getRecentlyAccessedMemories(limit: number): Promise<PurrMemory[]> {
    return await this.readModel.getRecentlyAccessedMemories(limit);
  }

  async linkMemories(id1: string, id2: string, linkType: string = 'related'): Promise<MemoryLink | null> {
    return await this.links.linkMemories(id1, id2, linkType);
  }

  async unlinkMemories(id1: string, id2: string): Promise<boolean> {
    return await this.links.unlinkMemories(id1, id2);
  }

  async getLinkedMemories(id: string): Promise<MemoryLink[]> {
    return await this.links.getLinkedMemories(id);
  }

  async bulkDelete(ids: string[]): Promise<number> {
    return await this.memoryDeletion.bulkDelete(ids);
  }

  async bulkUpdate(ids: string[], fields: MemoryBulkUpdatePatch): Promise<number> {
    return await this.bulkUpdates.bulkUpdate(ids, fields);
  }

  async bulkUpdateSalience(updates: MemorySalienceUpdate[]): Promise<number> {
    return await this.bulkUpdates.bulkUpdateSalience(updates);
  }

  async upsertRecentContactShape(shape: RecentContactShapeArtifact): Promise<void> {
    await this.recentContactShapes.upsertRecentContactShape(shape);
  }

  async getRecentContactShape(contactId: string): Promise<RecentContactShapeArtifact | undefined> {
    return await this.recentContactShapes.getRecentContactShape(contactId);
  }

  async listRecentContactShapes(): Promise<RecentContactShapeArtifact[]> {
    return await this.recentContactShapes.listRecentContactShapes();
  }

  async addScratchpadEntry(
    content: string,
    options: ScratchpadEntryCreateOptions = {},
  ): Promise<ScratchpadAddResult> {
    return await this.scratchpad.addScratchpadEntry(content, options);
  }

  async replaceScratchpadEntry(
    id: string,
    content: string,
    options: ScratchpadEntryReplaceOptions = {},
  ): Promise<ScratchpadEntry | null> {
    return await this.scratchpad.replaceScratchpadEntry(id, content, options);
  }

  async appendScratchpadEntry(
    id: string,
    content: string,
    options: ScratchpadEntryReplaceOptions = {},
  ): Promise<ScratchpadEntry | null> {
    return await this.scratchpad.appendScratchpadEntry(id, content, options);
  }

  async removeScratchpadEntry(id: string): Promise<boolean> {
    return await this.scratchpad.removeScratchpadEntry(id);
  }

  async getScratchpadEntry(id: string): Promise<ScratchpadEntry | undefined> {
    return await this.scratchpad.getScratchpadEntry(id);
  }

  listScratchpadEntries(limit: number = 64): ScratchpadEntry[] {
    return this.scratchpad.listScratchpadEntries(limit);
  }
}
