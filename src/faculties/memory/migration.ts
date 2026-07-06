import type { Pool, PoolClient } from 'pg';
import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import {
  createPostgresPool,
  ensurePostgresSchema,
  queryRows,
  withPostgresClient,
} from '../../persistence/postgres.js';
import { POSTGRES_MEMORY_MIGRATIONS } from '../../persistence/postgres/migrations.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

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

export interface EmbeddingMigrationResult {
  total: number;
  processed: number;
  updated: number;
  failed: number;
  batchSize: number;
  parallelism: number;
  durationMs: number;
  failures: ReembedFailure[];
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

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function toEmbeddingBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function toPostgresEmbeddingLiteral(embedding: Float32Array): string {
  return `[${Array.from(embedding, value => Number(value)).join(',')}]`;
}

async function loadPostgresRowsForMigration(
  pool: Pool,
  includeDeleted: boolean,
): Promise<PostgresMemoryTextRow[]> {
  const whereClause = includeDeleted ? '' : 'WHERE deleted_at IS NULL';
  return await queryRows<PostgresMemoryTextRow>(pool, `
    SELECT id, text
    FROM l2_memories
    ${whereClause}
    ORDER BY id ASC
  `);
}

async function writePostgresReembeddedBatch(
  client: PoolClient,
  rows: readonly PostgresMemoryTextRow[],
  embeddings: readonly Float32Array[],
): Promise<void> {
  for (let index = 0; index < rows.length; index += 1) {
    await client.query(
      'UPDATE l2_memories SET embedding = $2::vector WHERE id = $1',
      [rows[index].id, toPostgresEmbeddingLiteral(embeddings[index])],
    );
  }
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
  const queryEmbeddings = await embeddingService.embedBatch(queryTexts);

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

  for (let idx = 0; idx < queries.length; idx++) {
    const query = queries[idx];
    const embedding = queryEmbeddings[idx];
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

  const includeDeleted = options.includeDeleted ?? false;
  const continueOnError = options.continueOnError ?? true;
  const startTime = Date.now();
  const pool = createPostgresPool(normalizedDatabaseUrl, {
    applicationName: 'psfn-memory-embedding-migration',
    allowExitOnIdle: true,
  });

  try {
    await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
    const rows = await loadPostgresRowsForMigration(pool, includeDeleted);
    const batches = chunk(rows, batchSize);

    let processed = 0;
    let updated = 0;
    let failed = 0;
    const failures: ReembedFailure[] = [];

    if (rows.length > 0) {
      let nextBatch = 0;
      const workerCount = Math.min(parallelism, batches.length);

      const runWorker = async (): Promise<void> => {
        for (;;) {
          const batchIndex = nextBatch++;
          if (batchIndex >= batches.length) return;

          const batch = batches[batchIndex];

          try {
            const embeddings = await embeddingService.embedBatch(batch.map(row => row.text));
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

            await withPostgresClient(pool, async (client) => {
              await writePostgresReembeddedBatch(client, batch, embeddings);
            });
            processed += batch.length;
            updated += batch.length;
            options.onProgress?.({
              total: rows.length,
              processed,
              updated,
              failed,
              batchIndex: batchIndex + 1,
              batchCount: batches.length,
            });
          } catch (error) {
            const message = toErrorMessage(error);
            processed += batch.length;
            failed += batch.length;
            for (const row of batch) {
              failures.push({
                memoryId: row.id,
                error: message,
              });
            }
            options.onProgress?.({
              total: rows.length,
              processed,
              updated,
              failed,
              batchIndex: batchIndex + 1,
              batchCount: batches.length,
            });

            if (!continueOnError) {
              throw new Error(`Failed PostgreSQL embedding migration batch ${batchIndex + 1}: ${message}`);
            }
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
      total: rows.length,
      processed,
      updated,
      failed,
      batchSize,
      parallelism,
      durationMs: Date.now() - startTime,
      failures,
    };
  } finally {
    await pool.end();
  }
}
