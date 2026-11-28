import type { Pool } from 'pg';
import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import {
  createPostgresPool,
  ensurePostgresSchema,
  queryRows,
  withPostgresClient,
} from '../../persistence/postgres.js';
import { POSTGRES_MEMORY_MIGRATIONS } from '../../persistence/postgres/migrations.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { chunk } from '../../shared/utils/arrays.js';
import { createMaintenanceEmbeddingUsageProvenance } from '../../core/agent/embedding-usage-provenance.js';
import { persistMemoryEmbedding } from './postgres-store/memory-embedding-write.js';

interface RetrievalRow {
  memory_id: string;
  distance: number;
}

export interface RetrievalValidationDatabase {
  prepare(sql: string): {
    all(...params: readonly unknown[]): RetrievalRow[];
  };
}

interface PostgresMemoryTextRow {
  id: string;
  text: string;
}

export interface RetrievalValidationQuery {
  query: string;
  expectedMemoryIds?: string[];
}

export interface RetrievalValidationQueryResult {
  query: string;
  expectedMemoryIds: string[];
  topMemoryIds: string[];
  topSimilarities: number[];
  hit: boolean | null;
  firstHitRank: number | null;
  reciprocalRank: number | null;
}

export interface RetrievalValidationReport {
  status: 'ok' | 'skipped' | 'error';
  topK: number;
  queryCount: number;
  expectedQueryCount: number;
  hitRate: number | null;
  meanReciprocalRank: number | null;
  meanTopSimilarity: number | null;
  details: RetrievalValidationQueryResult[];
  error?: string;
}

export interface ReembedMigrationProgress {
  total: number;
  processed: number;
  updated: number;
  failed: number;
  batchIndex: number;
  batchCount: number;
}

export interface ReembedFailure {
  memoryId: string;
  error: string;
}

export interface EmbeddingMigrationValidationResult {
  pre: RetrievalValidationReport;
  post: RetrievalValidationReport;
}

/** Active L2 rows (not deleted, not superseded); NULL-embedding rows are invisible to semantic recall. */
export interface MemoryEmbeddingCoverage {
  activeMemoryCount: number;
  activeMissingEmbeddingCount: number;
}

export interface EmbeddingMigrationResult {
  dryRun: boolean;
  missingOnly: boolean;
  total: number;
  processed: number;
  updated: number;
  /** Missing-only rows another writer embedded first; left untouched. */
  alreadyEmbedded: number;
  failed: number;
  batchSize: number;
  parallelism: number;
  durationMs: number;
  failures: ReembedFailure[];
  coverageBefore: MemoryEmbeddingCoverage;
  coverageAfter: MemoryEmbeddingCoverage;
  /** Missing-only runs: the exact rows selected, in id order. */
  selectedMemoryIds?: string[];
  /** Set when `limit` left matching rows behind; pass it as `afterId` to continue. */
  nextAfterId?: string;
  validation?: EmbeddingMigrationValidationResult;
}

export interface EmbeddingMigrationOptions {
  batchSize?: number;
  parallelism?: number;
  includeDeleted?: boolean;
  continueOnError?: boolean;
  validationQueries?: RetrievalValidationQuery[];
  validationTopK?: number;
  onProgress?: (progress: ReembedMigrationProgress) => void;
  /** Companion tenant schema; absent selects the connection's default schema. */
  schema?: string;
  /**
   * Embed only active rows whose embedding is NULL (psfn-framework-d5e0p.23).
   * `includeDeleted` widens the selection to deleted and superseded rows.
   */
  missingOnly?: boolean;
  /** Select at most this many rows, in id order. */
  limit?: number;
  /** Continuation cursor: select only rows whose id sorts after this one. */
  afterId?: string;
  /** Report the selection and coverage without embedding or writing. */
  dryRun?: boolean;
}

const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_PARALLELISM = 4;
const DEFAULT_VALIDATION_TOP_K = 5;

function normalizePositiveInt(
  value: number | undefined,
  fallback: number,
  fieldName: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return value;
}

function toEmbeddingBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

interface MigrationRowSelection {
  includeDeleted: boolean;
  missingOnly: boolean;
  afterId?: string;
  limit?: number;
}

async function loadPostgresRowsForMigration(
  pool: Pool,
  selection: MigrationRowSelection,
): Promise<PostgresMemoryTextRow[]> {
  const conditions = [
    ...(selection.includeDeleted ? [] : ['deleted_at IS NULL']),
    ...(selection.missingOnly && !selection.includeDeleted ? ['superseded_by IS NULL'] : []),
    ...(selection.missingOnly ? ['embedding IS NULL'] : []),
    ...(selection.afterId !== undefined ? ['id > $1'] : []),
  ];
  const values: unknown[] = selection.afterId !== undefined ? [selection.afterId] : [];
  // One row past the bound tells a bounded run whether matching rows remain.
  const limitClause = selection.limit !== undefined ? `LIMIT ${selection.limit + 1}` : '';
  return await queryRows<PostgresMemoryTextRow>(pool, `
    SELECT id, text
    FROM l2_memories
    ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY id ASC
    ${limitClause}
  `, values);
}

export async function inspectMemoryEmbeddingCoverage(pool: Pool): Promise<MemoryEmbeddingCoverage> {
  const rows = await queryRows<{ active_count: string; active_missing_count: string }>(pool, `
    SELECT
      COUNT(*) AS active_count,
      COUNT(*) FILTER (WHERE embedding IS NULL) AS active_missing_count
    FROM l2_memories
    WHERE deleted_at IS NULL AND superseded_by IS NULL
  `);
  return {
    activeMemoryCount: Number(rows[0]?.active_count ?? 0),
    activeMissingEmbeddingCount: Number(rows[0]?.active_missing_count ?? 0),
  };
}

/**
 * A missing-only backfill embeds rows beside the existing ones, so it must
 * produce vectors in their space; a provider whose dimension differs needs
 * the full re-embed instead.
 */
async function assertProviderMatchesStoredDimensions(pool: Pool, dims: number): Promise<void> {
  const rows = await queryRows<{ dims: number }>(pool, `
    SELECT DISTINCT vector_dims(embedding) AS dims
    FROM l2_memories
    WHERE embedding IS NOT NULL
  `);
  const stored = rows.map(row => Number(row.dims)).filter(value => value !== dims);
  if (stored.length > 0) {
    throw new Error(
      `Missing-embedding backfill refused: stored embeddings have dimension ${stored.join(', ')} `
      + `but the embedding provider produces ${dims}; run the full re-embed instead`,
    );
  }
}

/** Each row commits on its own, so one bad row never discards its batch's work. */
async function writePostgresReembeddedBatch(
  pool: Pool,
  rows: readonly PostgresMemoryTextRow[],
  embeddings: readonly Float32Array[],
  onlyIfMissing: boolean,
): Promise<{ updated: number; alreadyEmbedded: number; failures: ReembedFailure[] }> {
  let updated = 0;
  let alreadyEmbedded = 0;
  const failures: ReembedFailure[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const embedding = embeddings[index];
    if (row === undefined || embedding === undefined) {
      throw new Error(`Unexpected missing row or embedding at index ${index}`);
    }
    try {
      const outcome = await withPostgresClient(pool, async client => (
        await persistMemoryEmbedding(client, row.id, embedding, { onlyIfMissing })
      ));
      if (outcome === 'updated') updated += 1;
      else alreadyEmbedded += 1;
    } catch (error) {
      failures.push({ memoryId: row.id, error: toErrorMessage(error) });
    }
  }
  return { updated, alreadyEmbedded, failures };
}

function summarizeValidation(
  details: RetrievalValidationQueryResult[],
  topK: number,
): RetrievalValidationReport {
  const expectedQueryDetails = details.filter(detail => detail.expectedMemoryIds.length > 0);
  const topSimilarityValues = details
    .map(detail => detail.topSimilarities[0])
    .filter((value): value is number => Number.isFinite(value));

  const expectedQueryCount = expectedQueryDetails.length;
  const hits = expectedQueryDetails.filter(detail => detail.hit).length;
  const reciprocalRankSum = expectedQueryDetails.reduce(
    (sum, detail) => sum + (detail.reciprocalRank ?? 0),
    0,
  );
  const topSimilaritySum = topSimilarityValues.reduce((sum, value) => sum + value, 0);

  return {
    status: 'ok',
    topK,
    queryCount: details.length,
    expectedQueryCount,
    hitRate: expectedQueryCount > 0 ? hits / expectedQueryCount : null,
    meanReciprocalRank: expectedQueryCount > 0 ? reciprocalRankSum / expectedQueryCount : null,
    meanTopSimilarity: topSimilarityValues.length > 0 ? topSimilaritySum / topSimilarityValues.length : null,
    details,
  };
}

function createSkippedValidationReport(): RetrievalValidationReport {
  return {
    status: 'skipped',
    topK: DEFAULT_VALIDATION_TOP_K,
    queryCount: 0,
    expectedQueryCount: 0,
    hitRate: null,
    meanReciprocalRank: null,
    meanTopSimilarity: null,
    details: [],
  };
}

export async function runRetrievalValidation(
  db: RetrievalValidationDatabase,
  embeddingService: EmbeddingProviderPort,
  queries: readonly RetrievalValidationQuery[],
  topK: number = DEFAULT_VALIDATION_TOP_K,
): Promise<RetrievalValidationReport> {
  if (queries.length === 0) return createSkippedValidationReport();

  const normalizedTopK = normalizePositiveInt(topK, DEFAULT_VALIDATION_TOP_K, 'validationTopK');
  const queryTexts = queries.map(query => query.query);
  const queryEmbeddings = await embeddingService.embedBatch(queryTexts, {
    usageProvenance: createMaintenanceEmbeddingUsageProvenance({
      purpose: 'memory.retrieval_validation',
      service: 'memory',
      process: 'retrieval-validation',
      workloadType: 'memory_retrieval_validation',
      workloadId: 'validation-batch',
    }),
  });

  if (queryEmbeddings.length !== queryTexts.length) {
    throw new Error(
      `Embedding service returned ${queryEmbeddings.length} embeddings for ${queryTexts.length} queries`,
    );
  }

  const searchStmt = db.prepare(`
    SELECT
      m.id AS memory_id,
      v.distance AS distance
    FROM l2_memory_embeddings v
    JOIN l2_memories m ON m.id = v.memory_id
    WHERE v.embedding MATCH ?
      AND k = ?
      AND m.superseded_by IS NULL
      AND m.deleted_at IS NULL
    ORDER BY v.distance ASC
  `);

  const details: RetrievalValidationQueryResult[] = [];

  for (const [idx, query] of queries.entries()) {
    const embedding = queryEmbeddings[idx];
    if (embedding === undefined) {
      throw new Error(`Embedding missing for query at index ${idx}`);
    }
    const rows = searchStmt.all(
      toEmbeddingBuffer(embedding),
      normalizedTopK,
    ) as RetrievalRow[];
    const topMemoryIds = rows.map(row => row.memory_id);
    const topSimilarities = rows.map(row => 1 - row.distance);
    const expectedMemoryIds = [...(query.expectedMemoryIds ?? [])];

    if (expectedMemoryIds.length === 0) {
      details.push({
        query: query.query,
        expectedMemoryIds,
        topMemoryIds,
        topSimilarities,
        hit: null,
        firstHitRank: null,
        reciprocalRank: null,
      });
      continue;
    }

    const firstHitIndex = topMemoryIds.findIndex(id => expectedMemoryIds.includes(id));
    const firstHitRank = firstHitIndex >= 0 ? firstHitIndex + 1 : null;
    const reciprocalRank = firstHitRank ? 1 / firstHitRank : 0;

    details.push({
      query: query.query,
      expectedMemoryIds,
      topMemoryIds,
      topSimilarities,
      hit: firstHitRank !== null,
      firstHitRank,
      reciprocalRank,
    });
  }

  return summarizeValidation(details, normalizedTopK);
}

export async function migratePostgresMemoryEmbeddings(
  databaseUrl: string,
  embeddingService: EmbeddingProviderPort,
  options: EmbeddingMigrationOptions = {},
): Promise<EmbeddingMigrationResult> {
  const normalizedDatabaseUrl = databaseUrl.trim();
  if (!normalizedDatabaseUrl) {
    throw new Error('PostgreSQL embedding migration requires a database URL');
  }

  const batchSize = normalizePositiveInt(
    options.batchSize,
    DEFAULT_BATCH_SIZE,
    'batchSize',
  );
  const parallelism = normalizePositiveInt(
    options.parallelism,
    DEFAULT_PARALLELISM,
    'parallelism',
  );

  const limit = options.limit === undefined
    ? undefined
    : normalizePositiveInt(options.limit, options.limit, 'limit');
  const afterId = options.afterId?.trim() || undefined;
  const includeDeleted = options.includeDeleted ?? false;
  const missingOnly = options.missingOnly ?? false;
  const dryRun = options.dryRun ?? false;
  const continueOnError = options.continueOnError ?? true;
  const startTime = Date.now();
  const pool = createPostgresPool(normalizedDatabaseUrl, {
    applicationName: 'psfn-memory-embedding-migration',
    allowExitOnIdle: true,
    ...(options.schema ? { schema: options.schema } : {}),
  });

  try {
    await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
    const coverageBefore = await inspectMemoryEmbeddingCoverage(pool);
    if (missingOnly && !dryRun) {
      await assertProviderMatchesStoredDimensions(pool, embeddingService.dims);
    }
    const loaded = await loadPostgresRowsForMigration(pool, {
      includeDeleted,
      missingOnly,
      ...(afterId !== undefined ? { afterId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    const rows = limit !== undefined ? loaded.slice(0, limit) : loaded;
    const nextAfterId = loaded.length > rows.length ? rows.at(-1)?.id : undefined;
    const batches = dryRun ? [] : chunk(rows, batchSize);

    let processed = 0;
    let updated = 0;
    let alreadyEmbedded = 0;
    let failed = 0;
    const failures: ReembedFailure[] = [];

    if (batches.length > 0) {
      let nextBatch = 0;
      const workerCount = Math.min(parallelism, batches.length);

      const runWorker = async (): Promise<void> => {
        for (;;) {
          const batchIndex = nextBatch++;
          if (batchIndex >= batches.length) return;

          const batch = batches[batchIndex];
          if (batch === undefined) {
            return;
          }

          let written: Awaited<ReturnType<typeof writePostgresReembeddedBatch>>;
          try {
            const embeddings = await embeddingService.embedBatch(batch.map(row => row.text), {
              usageProvenance: createMaintenanceEmbeddingUsageProvenance({
                purpose: 'memory.embedding_migration',
                service: 'memory',
                process: 'embedding-migration',
                workloadType: 'memory_embedding_migration',
                workloadId: `batch-${batchIndex}`,
              }),
            });
            if (embeddings.length !== batch.length) {
              throw new Error(
                `Embedding service returned ${embeddings.length} embeddings for ${batch.length} records`,
              );
            }

            if (Number.isFinite(embeddingService.dims) && embeddingService.dims > 0) {
              for (const embedding of embeddings) {
                if (embedding.length !== embeddingService.dims) {
                  throw new Error(
                    `Embedding dimension ${embedding.length} does not match configured ${embeddingService.dims}`,
                  );
                }
              }
            }

            written = await writePostgresReembeddedBatch(pool, batch, embeddings, missingOnly);
          } catch (error) {
            const message = toErrorMessage(error);
            written = {
              updated: 0,
              alreadyEmbedded: 0,
              failures: batch.map(row => ({ memoryId: row.id, error: message })),
            };
          }
          processed += batch.length;
          updated += written.updated;
          alreadyEmbedded += written.alreadyEmbedded;
          failed += written.failures.length;
          failures.push(...written.failures);
          options.onProgress?.({
            total: rows.length,
            processed,
            updated,
            failed,
            batchIndex: batchIndex + 1,
            batchCount: batches.length,
          });
          const firstFailure = written.failures[0];
          if (firstFailure && !continueOnError) {
            throw new Error(`Failed PostgreSQL embedding migration batch ${batchIndex + 1}: ${firstFailure.error}`);
          }
        }
      };

      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          await runWorker();
        }),
      );
    }

    return {
      dryRun,
      missingOnly,
      total: rows.length,
      processed,
      updated,
      alreadyEmbedded,
      failed,
      batchSize,
      parallelism,
      durationMs: Date.now() - startTime,
      failures,
      coverageBefore,
      coverageAfter: dryRun ? coverageBefore : await inspectMemoryEmbeddingCoverage(pool),
      ...(missingOnly ? { selectedMemoryIds: rows.map(row => row.id) } : {}),
      ...(nextAfterId !== undefined ? { nextAfterId } : {}),
    };
  } finally {
    await pool.end();
  }
}
