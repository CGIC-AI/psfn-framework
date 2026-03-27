// ── Database adapter interface ──
// Abstracts SQLite (better-sqlite3) and Postgres (postgres.js) behind a single async API.
// SQLite implementations wrap synchronous calls in Promise.resolve(); Postgres uses native async.

// ── Result types ──

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
}

export interface MutationResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

// ── Vector search ──

export type VectorDistanceMetric = 'l2' | 'cosine' | 'ip';

export interface VectorSearchOptions {
  /** Table containing the vector column */
  table: string;
  /** Name of the vector/embedding column */
  column: string;
  /** Query vector as number array */
  queryVector: number[] | Float32Array;
  /** Maximum number of results */
  limit: number;
  /** Distance metric (default: l2) */
  metric?: VectorDistanceMetric;
  /**
   * Additional JOIN + WHERE clause to apply before vector search.
   * Use `$VEC_TABLE` as placeholder for the vector table alias.
   * Use `$MAIN_TABLE` for the joined data table alias.
   * Params should be appended to filterParams.
   */
  joinClause?: string;
  /** WHERE clause fragments (ANDed together). Positional params use ?. */
  filterClauses?: string[];
  /** Parameters for joinClause + filterClauses (positional) */
  filterParams?: unknown[];
  /** Columns to select from joined table (default: all) */
  selectColumns?: string;
}

export interface VectorSearchRow<T = Record<string, unknown>> {
  row: T;
  distance: number;
}

// ── Full-text search ──

export interface FtsSearchOptions {
  /** Query string (will be adapted to FTS5 MATCH or Postgres tsquery) */
  query: string;
  /** Maximum results */
  limit: number;
  /** Additional WHERE clauses */
  filterClauses?: string[];
  filterParams?: unknown[];
}

export interface FtsSearchRow<T = Record<string, unknown>> {
  row: T;
  score: number;
  snippet: string;
}

// ── Schema introspection ──

export interface ColumnInfo {
  name: string;
  type: string;
  notnull: boolean;
  defaultValue: string | null;
  pk: boolean;
}

// ── Transaction callback ──

/** A transactional adapter with the same query interface but scoped to a transaction. */
export type TransactionFn<T> = (tx: DatabaseAdapter) => Promise<T>;

// ── Provider type ──

export type DatabaseProvider = 'sqlite' | 'postgres';

// ── Core adapter interface ──

export interface DatabaseAdapter {
  /** Which database backend is active */
  readonly provider: DatabaseProvider;

  // ── Lifecycle ──

  /** Initialize the database connection (create extensions, set pragmas, etc.) */
  initialize(): Promise<void>;

  /** Run schema migrations for the current provider */
  migrate(): Promise<void>;

  /** Close the database connection */
  close(): Promise<void>;

  // ── Query ──

  /** Execute a SELECT query and return typed rows */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /** Execute a SELECT query and return the first row (or undefined) */
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;

  // ── Mutation ──

  /** Execute an INSERT/UPDATE/DELETE and return mutation metadata */
  run(sql: string, params?: unknown[]): Promise<MutationResult>;

  /** Execute a raw DDL or multi-statement SQL string (CREATE TABLE, etc.) */
  exec(sql: string): Promise<void>;

  // ── Transactions ──

  /**
   * Execute a function within a database transaction.
   * The callback receives a transactional adapter; use it for all queries within the tx.
   * If the callback throws, the transaction is rolled back.
   */
  transaction<T>(fn: TransactionFn<T>): Promise<T>;

  // ── Vector search ──

  /**
   * Perform a KNN vector similarity search.
   * Abstracts sqlite-vec MATCH vs pgvector distance operators.
   */
  vectorSearch<T = Record<string, unknown>>(
    options: VectorSearchOptions,
  ): Promise<Array<VectorSearchRow<T>>>;

  /** Insert or replace an embedding vector */
  vectorUpsert(
    table: string,
    idColumn: string,
    id: string,
    embeddingColumn: string,
    embedding: number[] | Float32Array,
  ): Promise<void>;

  /** Delete an embedding vector by ID */
  vectorDelete(
    table: string,
    idColumn: string,
    id: string,
  ): Promise<void>;

  // ── Schema introspection ──

  /** Check if a table exists */
  hasTable(tableName: string): Promise<boolean>;

  /** Check if a column exists on a table */
  hasColumn(tableName: string, columnName: string): Promise<boolean>;

  /** Get column info for a table */
  getColumns(tableName: string): Promise<ColumnInfo[]>;
}
