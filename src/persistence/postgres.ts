import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';

// Postgres identifiers are bounded to 63 bytes (NAMEDATALEN - 1). We deliberately
// stay inside that limit and only admit a strict, lowercase-first identifier so a
// schema name can never be used to smuggle SQL into a search_path or DDL string.
export const POSTGRES_SCHEMA_NAME_MAX_LENGTH = 63;
const POSTGRES_SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const POSTGRES_ROLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Fail-closed validation for a Postgres schema identifier.
 *
 * The allowlist is intentionally narrow: a lowercase letter followed by
 * lowercase letters, digits, and underscores, bounded to the Postgres
 * identifier limit. Anything else throws — we never interpolate an
 * unvalidated identifier into a search_path or DDL statement.
 */
export function assertValidPostgresSchemaName(schema: string): string {
  if (typeof schema !== 'string') {
    throw new Error('Postgres schema name must be a string');
  }
  if (schema.length === 0) {
    throw new Error('Postgres schema name must not be empty');
  }
  if (schema.length > POSTGRES_SCHEMA_NAME_MAX_LENGTH) {
    throw new Error(
      `Postgres schema name "${schema}" exceeds the ${POSTGRES_SCHEMA_NAME_MAX_LENGTH}-character limit`,
    );
  }
  if (!POSTGRES_SCHEMA_NAME_PATTERN.test(schema)) {
    throw new Error(
      `Invalid Postgres schema name "${schema}". Allowed: a lowercase letter followed by `
      + 'lowercase letters, digits, or underscores.',
    );
  }
  return schema;
}

/** Fail closed before a configured PostgreSQL role is interpolated into SQL. */
export function assertValidPostgresRoleName(role: string): string {
  if (typeof role !== 'string' || role.length === 0 || role.length > POSTGRES_SCHEMA_NAME_MAX_LENGTH
    || role === 'public' || !POSTGRES_ROLE_NAME_PATTERN.test(role)) {
    throw new Error('Invalid PostgreSQL role name');
  }
  return role;
}

export interface PostgresConnectionOptions {
  applicationName?: string;
  allowExitOnIdle?: boolean;
  connectionTimeoutMillis?: number;
  max?: number;
  /**
   * Optional companion/world schema. When provided it is strictly validated and
   * pinned as the pool's search_path at connection startup (libpq `options`), so
   * every connection handed out by the pool operates inside that schema and no
   * connection can escape it. `public` is retained after the schema so shared
   * extension types (e.g. pgvector's VECTOR) still resolve; because the
   * migration chain creates every table inside the companion schema, those
   * tables always shadow any same-named table in `public`.
   *
   * When absent, no search_path is set and behavior is byte-identical to the
   * default (`"$user", public`).
   */
  schema?: string;
}

export function createPostgresPool(
  connectionString: string,
  options: PostgresConnectionOptions = {},
): Pool {
  const config: PoolConfig = {
    connectionString,
    application_name: options.applicationName ?? 'psfn-framework',
    allowExitOnIdle: options.allowExitOnIdle ?? true,
    ...(options.connectionTimeoutMillis !== undefined
      ? { connectionTimeoutMillis: options.connectionTimeoutMillis }
      : {}),
    ...(options.max !== undefined ? { max: options.max } : {}),
  };
  if (options.schema !== undefined) {
    const schema = assertValidPostgresSchemaName(options.schema);
    // Pin search_path at connection startup for every connection in the pool.
    // libpq option tokens are whitespace-separated; the validated identifier
    // contains no whitespace or metacharacters, so this is injection-safe.
    config.options = `-c search_path=${schema},public`;
  }
  return new Pool(config);
}

export async function withPostgresClient<T>(
  pool: Pool,
  handler: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Best effort rollback only.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function ensurePostgresSchema(pool: Pool, statements: readonly string[]): Promise<void> {
  await withPostgresClient(pool, async (client) => {
    for (const statement of statements) {
      await client.query(statement);
    }
  });
}

/**
 * Serialize one migration chain across every process connected to the database.
 * PostgreSQL's `IF NOT EXISTS` DDL is not race-free when independent sessions
 * create the same relation concurrently, so callers with eager startup
 * migrations must use a stable, migration-specific lock key.
 */
export async function ensurePostgresSchemaWithAdvisoryLock(
  pool: Pool,
  statements: readonly string[],
  lockKey: readonly [number, number],
): Promise<void> {
  const [namespaceKey, migrationKey] = lockKey;
  if (
    !Number.isInteger(namespaceKey)
    || !Number.isInteger(migrationKey)
    || namespaceKey < -2_147_483_648
    || namespaceKey > 2_147_483_647
    || migrationKey < -2_147_483_648
    || migrationKey > 2_147_483_647
  ) {
    throw new Error('Postgres advisory lock keys must be signed 32-bit integers');
  }
  await withPostgresClient(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [
      namespaceKey,
      migrationKey,
    ]);
    for (const statement of statements) {
      await client.query(statement);
    }
  });
}

/**
 * Create a Postgres schema if it does not already exist.
 *
 * The name is strictly validated before it is quoted into the DDL, so an
 * invalid schema fails closed and no unvalidated identifier ever reaches the
 * database. This is a no-op-safe `CREATE SCHEMA IF NOT EXISTS`; it does not
 * touch search_path (that is pinned at the pool level).
 */
export async function ensurePostgresSchemaExists(pool: Pool, schema: string): Promise<void> {
  const validated = assertValidPostgresSchemaName(schema);
  // The identifier is already restricted to a safe character set; the quotes
  // are belt-and-suspenders so reserved words would still be legal.
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${validated}"`);
}

/**
 * Run a migration chain, optionally targeting an explicit schema.
 *
 * When `schema` is provided the schema is created first (fail-closed validated)
 * and then the existing, unchanged migration statements run inside it — the
 * search_path is expected to already be pinned to that schema at the pool level
 * (see {@link createPostgresPool}). When `schema` is omitted this is exactly
 * {@link ensurePostgresSchema}: today's behavior, no schema creation.
 */
export async function runPostgresMigrations(
  pool: Pool,
  statements: readonly string[],
  options: { schema?: string } = {},
): Promise<void> {
  if (options.schema !== undefined) {
    await ensurePostgresSchemaExists(pool, options.schema);
  }
  await ensurePostgresSchema(pool, statements);
}

export async function queryRows<T extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, [...values]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: readonly unknown[] = [],
): Promise<T | undefined> {
  const result = await pool.query<T>(text, [...values]);
  return result.rows[0];
}

export async function executeQuery(
  pool: Pool,
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult> {
  return await pool.query(text, [...values]);
}
