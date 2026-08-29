import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';
import { isRecord } from '../shared/utils/types.js';
import type { PostgresConnectionOptions } from './postgres/connection-options.js';
import { acquireOwnedPostgresPool } from './postgres/pool-owner.js';
import {
  assertPostgresRuntimeDdlAllowed,
  type PostgresRuntimeDdlAuthority,
} from './postgres/runtime-readiness.js';

export {
  getPostgresPoolTelemetry,
  PostgresPoolOwner,
  runWithPostgresPoolOwner,
} from './postgres/pool-owner.js';
export type {
  PostgresPoolOwnerTelemetry,
} from './postgres/pool-owner.js';
export type { PostgresConnectionOptions } from './postgres/connection-options.js';

// Postgres identifiers are bounded to 63 bytes (NAMEDATALEN - 1). We deliberately
// stay inside that limit and only admit a strict, lowercase-first identifier so a
// schema name can never be used to smuggle SQL into a search_path or DDL string.
export const POSTGRES_SCHEMA_NAME_MAX_LENGTH = 63;
export const POSTGRES_EXTENSION_SCHEMA_NAME = 'extensions';
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

/** Quote an identifier only after it has passed the canonical schema validator. */
export function quotePostgresSchemaName(schema: string): string {
  return `"${assertValidPostgresSchemaName(schema)}"`;
}

/** Quote an identifier only after it has passed the canonical role validator. */
export function quotePostgresRoleName(role: string): string {
  return `"${assertValidPostgresRoleName(role)}"`;
}

export function createPostgresPool(
  connectionString: string,
  options: PostgresConnectionOptions = {},
): Pool {
  return acquireOwnedPostgresPool(connectionString, options, createRawPostgresPool)
    ?? createRawPostgresPool(connectionString, options);
}

function createRawPostgresPool(
  connectionString: string,
  options: PostgresConnectionOptions,
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
  if (options.role !== undefined && options.schema === undefined) {
    throw new Error('A PostgreSQL runtime role requires an explicit tenant schema');
  }
  if (options.schema !== undefined) {
    const schema = assertValidPostgresSchemaName(options.schema);
    const role = options.role !== undefined
      ? assertValidPostgresRoleName(options.role)
      : undefined;
    // Pin search_path at connection startup for every connection in the pool.
    // libpq option tokens are whitespace-separated; the validated identifier
    // contains no whitespace or metacharacters, so this is injection-safe.
    config.options = [
      ...(role ? [`-c role=${role}`] : []),
      `-c search_path=${schema},${POSTGRES_EXTENSION_SCHEMA_NAME}`,
      ...(options.readOnly === true ? ['-c default_transaction_read_only=on'] : []),
    ].join(' ');
  } else if (options.readOnly === true) {
    config.options = '-c default_transaction_read_only=on';
  }
  const pool = new Pool(config);
  installBindParameterNulStripping(pool);
  return pool;
}

/** Marks a client whose `query` has already been wrapped, so re-acquiring a
 * pooled connection never double-wraps it. */
const NUL_STRIPPING_INSTALLED = Symbol('psfnNulStrippingInstalled');

/**
 * Return `args` for a `query(...)` call with any string bind parameters
 * NUL-stripped, without changing the call shape. Handles both the
 * `query(text, values[, cb])` form and the `query(config)` form where the
 * parameters live on `config.values`. Any other shape is passed through
 * untouched.
 */
function sanitizeQueryArguments(args: unknown[]): unknown[] {
  if (args.length >= 2 && Array.isArray(args[1])) {
    const next = args.slice();
    next[1] = stripNulBytesFromBindParameters(args[1] as readonly unknown[]);
    return next;
  }
  const [first] = args;
  if (isRecord(first) && Array.isArray((first as { values?: unknown }).values)) {
    const next = args.slice();
    next[0] = {
      ...(first as Record<string, unknown>),
      values: stripNulBytesFromBindParameters(
        (first as { values: readonly unknown[] }).values,
      ),
    };
    return next;
  }
  return args;
}

/**
 * Wrap a `Queryable`'s `query` method so every parameterized query strips NUL
 * bytes from string bind parameters before they reach the driver — the same
 * choke point as {@link queryRows}/{@link queryOne}/{@link executeQuery}, but at
 * the shared client/pool boundary so direct `client.query(...)` call sites
 * (fleet-auth stores, the session message upsert, etc.) are covered too. A
 * NUL byte in a text/jsonb bind parameter otherwise fails the write with
 * `22021 invalid byte sequence for encoding "UTF8": 0x00`.
 */
function wrapQueryMethodWithNulStripping(
  target: { query: (...args: unknown[]) => unknown },
): void {
  const marked = target as { [NUL_STRIPPING_INSTALLED]?: boolean };
  if (marked[NUL_STRIPPING_INSTALLED] === true) return;
  marked[NUL_STRIPPING_INSTALLED] = true;
  const originalQuery = target.query.bind(target);
  target.query = (...args: unknown[]) => originalQuery(...sanitizeQueryArguments(args));
}

/**
 * Install NUL stripping at the pool boundary: both the pool's own `pool.query`
 * fast path and every `PoolClient` handed out by `pool.connect()` get their
 * `query` wrapped. This is the least-invasive shared seam — no call site is
 * hand-edited — and it is idempotent per client via {@link NUL_STRIPPING_INSTALLED}.
 */
export function installBindParameterNulStripping(pool: Pool): void {
  wrapQueryMethodWithNulStripping(pool as unknown as { query: (...args: unknown[]) => unknown });
  const originalConnect = pool.connect.bind(pool);
  // pg's connect is overloaded (promise form + callback form); preserve both.
  pool.connect = ((callback?: unknown) => {
    if (typeof callback === 'function') {
      return originalConnect((err, client, release) => {
        if (client) {
          wrapQueryMethodWithNulStripping(
            client as unknown as { query: (...args: unknown[]) => unknown },
          );
        }
        (callback as (err: Error | undefined, client?: PoolClient, release?: unknown) => void)(
          err,
          client,
          release,
        );
      });
    }
    return originalConnect().then((client) => {
      wrapQueryMethodWithNulStripping(
        client as unknown as { query: (...args: unknown[]) => unknown },
      );
      return client;
    });
  }) as typeof pool.connect;
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
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'PostgreSQL operation failed and its transaction rollback also failed',
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function ensurePostgresSchema(
  pool: Pool,
  statements: readonly string[],
  options: { ddlAuthority?: PostgresRuntimeDdlAuthority } = {},
): Promise<void> {
  assertPostgresRuntimeDdlAllowed('ensure schema', options.ddlAuthority);
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
  options: { ddlAuthority?: PostgresRuntimeDdlAuthority } = {},
): Promise<void> {
  assertPostgresRuntimeDdlAllowed('ensure schema with advisory lock', options.ddlAuthority);
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
export async function ensurePostgresSchemaExists(
  pool: Pool,
  schema: string,
  options: { ddlAuthority?: PostgresRuntimeDdlAuthority } = {},
): Promise<void> {
  assertPostgresRuntimeDdlAllowed('ensure schema exists', options.ddlAuthority);
  const validated = assertValidPostgresSchemaName(schema);
  const existing = await pool.query<{ exists: boolean }>(
    'SELECT to_regnamespace($1) IS NOT NULL AS exists',
    [validated],
  );
  if (existing.rows[0]?.exists === true) return;
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
  options: { schema?: string; ddlAuthority?: PostgresRuntimeDdlAuthority } = {},
): Promise<void> {
  if (options.schema !== undefined) {
    if (options.ddlAuthority) {
      await ensurePostgresSchemaExists(pool, options.schema, {
        ddlAuthority: options.ddlAuthority,
      });
    } else {
      await ensurePostgresSchemaExists(pool, options.schema);
    }
  }
  if (options.ddlAuthority) {
    await ensurePostgresSchema(pool, statements, {
      ddlAuthority: options.ddlAuthority,
    });
  } else {
    await ensurePostgresSchema(pool, statements);
  }
}

/**
 * PostgreSQL text and jsonb storage cannot hold a NUL (0x00) byte: the wire
 * protocol rejects it with `22021 invalid byte sequence for encoding "UTF8":
 * 0x00`. NUL bytes reach bind parameters through untrusted inbound content
 * (e.g. a portal identity string, or a JSON payload that was serialized to a
 * string before binding), so strip them at this single choke point before any
 * value is handed to the driver. Only the invalid-for-Postgres NUL byte is
 * removed; every other byte is preserved.
 */
function stripNulBytesFromBindParameters(values: readonly unknown[]): unknown[] {
  return values.map(value => (typeof value === 'string' && value.includes('\u0000')
    ? value.replace(/\u0000/g, '')
    : value));
}

export async function queryRows<T extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, stripNulBytesFromBindParameters(values));
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: readonly unknown[] = [],
): Promise<T | undefined> {
  const result = await pool.query<T>(text, stripNulBytesFromBindParameters(values));
  return result.rows[0];
}

export async function executeQuery<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  return await pool.query<T>(text, stripNulBytesFromBindParameters(values));
}
