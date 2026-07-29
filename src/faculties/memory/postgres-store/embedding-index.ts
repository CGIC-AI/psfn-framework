import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { queryRows } from '../../../persistence/postgres.js';
import { createComponentLogger } from '../../../shared/logger.js';

const log = createComponentLogger('L2EmbeddingAnnIndex');

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
 * uses the index. The partial predicate admits only vectors matching the active
 * runtime dimension, so an operator can re-embed a corpus incrementally without
 * one stale vector breaking the new index or every semantic query. A rebuild
 * reclaims a same-name index whose stored predicate predates this partial
 * clause (see the predicate-drift reclamation in
 * {@link buildL2EmbeddingAnnIndexConcurrently}), so upgraded deployments adopt
 * the dimension isolation rather than silently keeping the weaker index.
 */
/**
 * Base (dimension-agnostic) name shared by every generation of the L2 embedding
 * ANN index. The live index name always carries the runtime dimension as a
 * `_d<N>` suffix (see {@link l2EmbeddingAnnIndexName}); this base is used only to
 * recognise sibling generations for cleanup.
 *
 * Baking the dimension into the name is load-bearing, not cosmetic.
 * `CREATE INDEX IF NOT EXISTS` collides on the index NAME alone — Postgres does
 * not compare the indexed expression. A fixed name would let a stale index built
 * over `embedding::vector(768)` survive an operator raising the config-owned
 * `embeddingDims` to 1024; every ANN query then orders by
 * `embedding::vector(1024) <=> ...`, the expressions never match, the planner can
 * never use the index, and semantic search silently full-scans forever with no
 * error. A dimension change now mints a NEW name, and the stale sibling of the
 * old dimension is detected and dropped (see
 * {@link buildL2EmbeddingAnnIndexConcurrently}).
 */
export const L2_EMBEDDING_ANN_INDEX_BASE_NAME = 'idx_l2_memories_embedding_hnsw_cosine';

// Matches this index family exactly: the base name, optionally with a `_d<N>`
// dimension suffix. Used to fail-closed validate any name read back from
// pg_class before it is interpolated into a DROP INDEX statement.
const L2_EMBEDDING_ANN_INDEX_NAME_PATTERN = /^idx_l2_memories_embedding_hnsw_cosine(?:_d\d+)?$/;

/** The concrete index name for a given runtime embedding dimension. */
export function l2EmbeddingAnnIndexName(embeddingDims: number): string {
  const dims = assertEmbeddingDims(embeddingDims);
  return `${L2_EMBEDDING_ANN_INDEX_BASE_NAME}_d${dims}`;
}

// HNSW build parameters. m = 16 / ef_construction = 64 are pgvector's defaults;
// they give strong recall (>0.95 at ef_search >= the candidate pool) for corpora
// up to the low millions while keeping build time and index size bounded. cosine
// ops (`<=>`) match the distance every embedding query uses. The index is partial
// on non-null vectors of the active dimension so null and stale-dimension rows
// never enter the graph.
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

/**
 * The `CREATE INDEX` statement for the runtime embedding dimension. When
 * `concurrent` is set the build runs `CONCURRENTLY` — which acquires no
 * table-blocking lock but MUST run outside any transaction block (see
 * {@link buildL2EmbeddingAnnIndexConcurrently}).
 */
export function buildL2EmbeddingAnnIndexCreateStatement(
  embeddingDims: number,
  options: { concurrent?: boolean } = {},
): string {
  const dims = assertEmbeddingDims(embeddingDims);
  const name = l2EmbeddingAnnIndexName(dims);
  const concurrently = options.concurrent === true ? 'CONCURRENTLY ' : '';
  return `CREATE INDEX ${concurrently}IF NOT EXISTS ${name} `
    + `ON l2_memories USING hnsw ((embedding::vector(${dims})) vector_cosine_ops) `
    + `WITH (m = ${HNSW_M}, ef_construction = ${HNSW_EF_CONSTRUCTION}) `
    + `WHERE embedding IS NOT NULL AND vector_dims(embedding) = ${dims};`;
}

export type L2EmbeddingAnnIndexBuildStatus = 'ready' | 'degraded';

export interface L2EmbeddingAnnIndexBuildOutcome {
  status: L2EmbeddingAnnIndexBuildStatus;
  indexName: string;
  /** Sibling/invalid indexes dropped before the build (names). */
  droppedIndexes: string[];
  /** Present only when status is 'degraded'. */
  error?: Error;
}

interface L2EmbeddingAnnSiblingIndex {
  indexName: string;
  isValid: boolean;
  hasDimensionPredicate: boolean;
}

/**
 * Enumerate every index in this schema on `l2_memories` whose name belongs to
 * the ANN index family (base name, optionally `_d<N>`), along with its validity.
 * A failed `CREATE INDEX CONCURRENTLY` leaves an INVALID index behind, so we read
 * `pg_index.indisvalid` to detect and reclaim those.
 */
async function findL2EmbeddingAnnSiblingIndexes(
  client: PoolClient,
): Promise<L2EmbeddingAnnSiblingIndex[]> {
  const result = await client.query<{ index_name: string; is_valid: boolean; index_def: string }>(
    `SELECT c.relname AS index_name, i.indisvalid AS is_valid,
            pg_get_indexdef(i.indexrelid) AS index_def
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND t.relname = 'l2_memories'
        AND c.relname LIKE $1`,
    [`${L2_EMBEDDING_ANN_INDEX_BASE_NAME}%`],
  );
  return result.rows
    // Fail closed against anything that does not match the exact family shape,
    // so a name read from the catalogue can never smuggle SQL into DROP INDEX.
    .filter(row => L2_EMBEDDING_ANN_INDEX_NAME_PATTERN.test(row.index_name))
    .map(row => ({
      indexName: row.index_name,
      isValid: row.is_valid === true,
      // A current-name index built before the partial-predicate change carries
      // the weaker `WHERE embedding IS NOT NULL` def and lacks `vector_dims`. It
      // is still valid but no longer matches the dimension-isolating build, so
      // an upgraded deployment would otherwise keep it forever under the
      // name-keyed IF NOT EXISTS. Flag that drift so it is reclaimed like any
      // other stale sibling.
      hasDimensionPredicate: /vector_dims/i.test(row.index_def),
    }));
}

/**
 * Build the HNSW cosine ANN index for the runtime embedding dimension OFF the
 * boot critical path.
 *
 * An ANN index is a PERFORMANCE artifact: every semantic query is CORRECT on a
 * sequential scan without it. Blocking startup on an HNSW build over a large
 * existing corpus is therefore the wrong fail-closed call — it can exceed the
 * pod readiness window, get the pod killed, roll back the DDL, and crash-loop
 * with no operator-visible cause. So this runs after the store is usable, using:
 *
 *  - a dedicated pooled client in AUTOCOMMIT (no BEGIN/COMMIT): `CREATE INDEX
 *    CONCURRENTLY` / `DROP INDEX CONCURRENTLY` cannot run inside a transaction
 *    block, and take no long table-blocking lock;
 *  - dimension-suffixed naming, so an `embeddingDims` change mints a new index;
 *  - stale-sibling reclamation: any ANN index of a DIFFERENT dimension (or the
 *    legacy un-suffixed name, or an INVALID current-name index left by a killed
 *    build) is dropped first, loudly, so stale indexes never accumulate and bloat
 *    writes or shadow the live one.
 *
 * It never throws: a build failure is logged loudly and reported as a `degraded`
 * outcome. The system stays query-correct (sequential scan), it does not crash.
 */
export async function buildL2EmbeddingAnnIndexConcurrently(
  pool: Pool,
  embeddingDims: number,
): Promise<L2EmbeddingAnnIndexBuildOutcome> {
  const dims = assertEmbeddingDims(embeddingDims);
  const indexName = l2EmbeddingAnnIndexName(dims);
  const droppedIndexes: string[] = [];
  // A dedicated connection kept in autocommit: we deliberately never issue BEGIN,
  // so each CONCURRENTLY statement is its own implicit transaction as pgvector/
  // Postgres require.
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const siblings = await findL2EmbeddingAnnSiblingIndexes(client);
    for (const sibling of siblings) {
      const isCurrentUsable = sibling.indexName === indexName
        && sibling.isValid
        && sibling.hasDimensionPredicate;
      if (isCurrentUsable) continue;
      // Drop: a different-dimension sibling, the legacy un-suffixed index, an
      // INVALID current-name index from a previously interrupted build, or a
      // valid current-name index built before the partial dimension predicate
      // (name-keyed IF NOT EXISTS would otherwise keep the drifted def forever).
      const reason = sibling.indexName !== indexName
        ? 'stale_dimension'
        : !sibling.isValid
          ? 'invalid_current'
          : 'predicate_drift';
      log.warn(
        'Dropping stale, invalid, or predicate-drifted L2 embedding ANN index before rebuild',
        {
          droppedIndex: sibling.indexName,
          currentIndex: indexName,
          embeddingDims: dims,
          reason,
          wasValid: sibling.isValid,
        },
      );
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${sibling.indexName}"`);
      droppedIndexes.push(sibling.indexName);
    }
    log.info('Building L2 embedding ANN index in background (CONCURRENTLY)', {
      index: indexName,
      embeddingDims: dims,
    });
    await client.query(buildL2EmbeddingAnnIndexCreateStatement(dims, { concurrent: true }));
    log.info('L2 embedding ANN index ready', {
      index: indexName,
      embeddingDims: dims,
      droppedIndexes,
    });
    return { status: 'ready', indexName, droppedIndexes };
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    log.error(
      'L2 embedding ANN index build failed; semantic search remains CORRECT on a '
        + 'sequential scan but is DEGRADED (unindexed). No crash: fix and restart to retry.',
      {
        index: indexName,
        embeddingDims: dims,
        droppedIndexes,
        error: normalized.message,
      },
    );
    return { status: 'degraded', indexName, droppedIndexes, error: normalized };
  } finally {
    client?.release();
  }
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
