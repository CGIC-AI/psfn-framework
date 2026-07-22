import type { Pool, QueryResultRow } from 'pg';
import { ensurePostgresSchema, queryRows } from '../../../persistence/postgres.js';

/**
 * ANN (approximate nearest neighbour) support for the L2 embedding column.
 *
 * The embedding column is declared as an unbounded pgvector `VECTOR` because the
 * runtime embedding dimension is configuration-owned, not known at migration
 * authoring time. HNSW/IVFFlat, however, require a fixed dimension: a generic
 * index over an unbounded `vector` fails to build with
 * `ERROR: column does not have dimensions`. We therefore resolve the typmod
 * constraint explicitly by building the index over the fixed-dimension cast
 * expression `(embedding::vector(N))`, with N pinned to the runtime dimension,
 * and every ANN query orders by the identical cast expression so the planner
 * uses the index. A dimension change is already a breaking corpus event
 * (`validateEmbeddingDimensions` rejects mismatched writes); rebuilding this
 * index is part of that migration.
 */
export const L2_EMBEDDING_ANN_INDEX_NAME = 'idx_l2_memories_embedding_hnsw_cosine';

// HNSW build parameters. m = 16 / ef_construction = 64 are pgvector's defaults;
// they give strong recall (>0.95 at ef_search >= the candidate pool) for corpora
// up to the low millions while keeping build time and index size bounded. cosine
// ops (`<=>`) match the distance every embedding query uses. The index is partial
// on `embedding IS NOT NULL` so the (already search-excluded) null-embedding rows
// never enter the graph, mirroring idx_l2_memories_embedding_present.
const HNSW_M = 16;
const HNSW_EF_CONSTRUCTION = 64;

// ANN candidate-pool sizing. The ANN scan retrieves `candidatePool` nearest
// neighbours; a larger pool raises recall after post-filtering (threshold, scope,
// subject authorization) at a bounded cost. ef_search is pinned to at least the
// pool so the graph-search breadth matches what the query intends to keep. On
// pgvector >= 0.8 iterative scans additionally make a filtered top-k exact up to
// hnsw.max_scan_tuples; below that the oversample is a best-effort recall floor.
export const ANN_CANDIDATE_OVERSAMPLE = 4;
export const ANN_MIN_CANDIDATES = 200;
// Keep the candidate ceiling at/under pgvector's hnsw.ef_search hard cap so a
// single graph scan can actually yield the whole pool without iterative scans.
export const ANN_MAX_CANDIDATES = 1000;
export const ANN_MAX_EF_SEARCH = 1000;

export interface AnnQueryTuning {
  efSearch: number;
  iterativeScan: boolean;
}

function assertEmbeddingDims(embeddingDims: number): number {
  if (!Number.isInteger(embeddingDims) || embeddingDims <= 0) {
    throw new Error(
      `L2 embedding ANN index requires a positive integer embedding dimension, got ${String(embeddingDims)}`,
    );
  }
  return embeddingDims;
}

export function annCandidatePool(requested: number): number {
  const base = Number.isFinite(requested) && requested > 0 ? Math.ceil(requested) : 1;
  return Math.min(ANN_MAX_CANDIDATES, Math.max(ANN_MIN_CANDIDATES, base * ANN_CANDIDATE_OVERSAMPLE));
}

export function annEfSearch(candidatePool: number): number {
  return Math.min(ANN_MAX_EF_SEARCH, Math.max(1, Math.ceil(candidatePool)));
}

/**
 * Distance expression an ANN query must order by so the HNSW index is used. The
 * left operand casts the column to the fixed dimension to match the indexed
 * expression exactly; the right operand casts the query parameter to the same
 * dimension. Both sides are numerically identical to the unbounded `<=>` used in
 * the SELECT/threshold, so similarity scoring is unchanged.
 */
export function embeddingAnnOrderExpression(
  column: string,
  queryParameter: string,
  embeddingDims: number,
): string {
  const dims = assertEmbeddingDims(embeddingDims);
  return `${column}::vector(${dims}) <=> ${queryParameter}::vector(${dims})`;
}

export function buildL2EmbeddingAnnIndexStatements(embeddingDims: number): string[] {
  const dims = assertEmbeddingDims(embeddingDims);
  return [
    `CREATE INDEX IF NOT EXISTS ${L2_EMBEDDING_ANN_INDEX_NAME} `
      + `ON l2_memories USING hnsw ((embedding::vector(${dims})) vector_cosine_ops) `
      + `WITH (m = ${HNSW_M}, ef_construction = ${HNSW_EF_CONSTRUCTION}) `
      + `WHERE embedding IS NOT NULL;`,
  ];
}

/**
 * Create the HNSW cosine ANN index for the runtime embedding dimension. Runs
 * after the static memory migrations because the index expression is
 * dimension-parameterized. Fails closed: a build failure (unbounded typmod left
 * unresolved, a stored row whose dimension differs from N, or a pgvector too old
 * for HNSW) throws rather than leaving semantic search on a silent sequential
 * scan.
 */
export async function ensureL2EmbeddingAnnIndex(pool: Pool, embeddingDims: number): Promise<void> {
  await ensurePostgresSchema(pool, buildL2EmbeddingAnnIndexStatements(embeddingDims));
}

function parsePgvectorMajorMinor(version: string): { major: number; minor: number } | null {
  const match = /^(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * pgvector >= 0.8.0 supports `hnsw.iterative_scan`, which re-scans the graph
 * until a filtered top-k is satisfied. Without it, ANN combined with a selective
 * filter (subject authorization) can under-return authorized rows even though
 * isolation is never violated; with it the filtered top-k is exact up to
 * hnsw.max_scan_tuples. Detected once at startup so query tuning can enable it.
 */
export async function detectPgvectorIterativeScanSupport(pool: Pool): Promise<boolean> {
  const rows = await queryRows<{ extversion: string | null }>(
    pool,
    `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
  );
  const version = rows[0]?.extversion;
  if (!version) return false;
  const parsed = parsePgvectorMajorMinor(version);
  if (!parsed) return false;
  return parsed.major > 0 || (parsed.major === 0 && parsed.minor >= 8);
}

/**
 * Run a read query with the ANN tuning GUCs applied transaction-locally. A
 * dedicated client is checked out and wrapped in BEGIN/COMMIT so `SET LOCAL`
 * (via set_config with is_local = true) is scoped to this statement and never
 * leaks onto a pooled connection. Errors roll back and rethrow; a rollback
 * failure is surfaced (never swallowed) as an AggregateError.
 */
export async function runAnnTunedQuery<T extends QueryResultRow>(
  pool: Pool,
  tuning: AnnQueryTuning,
  text: string,
  values: readonly unknown[],
): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('hnsw.ef_search', $1, true)`, [String(annEfSearch(tuning.efSearch))]);
    if (tuning.iterativeScan) {
      await client.query(`SELECT set_config('hnsw.iterative_scan', 'strict_order', true)`);
    }
    const result = await client.query<T>(text, [...values]);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'ANN-tuned query failed and its transaction rollback also failed',
      );
    }
    throw error;
  } finally {
    client.release();
  }
}
