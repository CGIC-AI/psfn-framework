// Postgres proof queries for the shakedown harness.
//
// Runtime stores are Postgres-only (src/persistence/runtime-factory.ts); the
// harness proves side effects by reading the same tables the runtime writes
// (l2_memories, scratchpad_entries, active_concerns, reflections, gateway_audit,
// ...). This replaces the pre-port `sqlite3 -json` CLI calls entirely.
//
// Connection: POSTGRES_DATABASE_URL (the canonical runtime var, see
// src/system/config/load-config.ts). Optional COMPANION_PG_SCHEMA pins the
// per-companion search_path exactly the way the runtime does for multi-companion
// tenants; unset means the default (public / "$user") schema, byte-identical to
// single-companion mode. Both are read fail-closed — a missing URL throws a
// named error, never a silent localhost fallback.

import pg from 'pg';
import { requireEnv, optionalEnv, InvalidEnvError } from './env.mjs';

const { Pool } = pg;

// Same fail-closed identifier allowlist the runtime uses
// (src/persistence/postgres.ts assertValidPostgresSchemaName): a lowercase
// letter followed by lowercase letters, digits, or underscores, so a schema
// name can never smuggle SQL into the search_path.
const SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const SCHEMA_NAME_MAX_LENGTH = 63;
const EXTENSION_SCHEMA_NAME = 'extensions';
const POSTGRES_CONNECTION_TIMEOUT_MS = 5_000;
const POSTGRES_PROOF_QUERY_TIMEOUT_MS = 10_000;

let pool = null;

function assertValidSchemaName(schema) {
  if (schema.length > SCHEMA_NAME_MAX_LENGTH || !SCHEMA_NAME_PATTERN.test(schema)) {
    throw new InvalidEnvError(
      'COMPANION_PG_SCHEMA',
      'must be a lowercase letter followed by lowercase letters, digits, or underscores '
      + `(max ${SCHEMA_NAME_MAX_LENGTH} chars)`,
    );
  }
  return schema;
}

/** Lazily open the shared pool from the fail-closed env. */
export function getPool() {
  if (pool) return pool;
  const connectionString = requireEnv('POSTGRES_DATABASE_URL', 'the round Postgres database');
  const schema = optionalEnv('COMPANION_PG_SCHEMA');
  const config = {
    connectionString,
    application_name: 'psfn-shakedown-harness',
    allowExitOnIdle: true,
    max: 4,
    connectionTimeoutMillis: POSTGRES_CONNECTION_TIMEOUT_MS,
    statement_timeout: POSTGRES_PROOF_QUERY_TIMEOUT_MS,
    query_timeout: POSTGRES_PROOF_QUERY_TIMEOUT_MS,
  };
  if (schema) {
    const validated = assertValidSchemaName(schema);
    // Pin search_path at connection startup exactly like the runtime pool. The
    // validated identifier contains no whitespace or metacharacters.
    config.options = `-c search_path=${validated},${EXTENSION_SCHEMA_NAME}`;
  }
  pool = new Pool(config);
  return pool;
}

/** Run a query and return all rows (parameterized where a $-list is passed). */
export async function pgAll(sql, params = []) {
  const result = await getPool().query(sql, params);
  return result.rows;
}

/** Run a query and return the first column of the first row, or null. */
export async function pgScalar(sql, params = []) {
  const rows = await pgAll(sql, params);
  if (rows.length === 0) return null;
  const first = rows[0];
  const key = Object.keys(first)[0];
  return key ? first[key] : null;
}

/**
 * Fail-closed reachability probe for the round Postgres. On the kube target the
 * connection runs through a port-forward, so this turns an unreachable database
 * into a clear, named error at preflight instead of a mid-sweep query crash. A
 * missing POSTGRES_DATABASE_URL still fails closed naming the variable (getPool).
 */
export async function assertPostgresReachable() {
  try {
    const value = await pgScalar('SELECT 1 AS ok');
    if (Number(value) !== 1) {
      throw new Error(`unexpected SELECT 1 result: ${JSON.stringify(value)}`);
    }
  } catch (error) {
    throw new Error(
      `Postgres not reachable via POSTGRES_DATABASE_URL: ${error instanceof Error ? error.message : String(error)}`
      + ' (on the kube target, is the database port-forward up?)',
    );
  }
}

/** Close the pool. Idempotent; safe to call in a finally. */
export async function closePool() {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end();
}
