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
//
// Gateway-owned tables (ypah0): in a companion fleet the gateway audit
// (`gateway_audit`) and the fleet spend ledger (`model_usage_events`, hhwwm)
// live in the gateway's schema (the primary tenant), not in each follower's.
// A follower-targeted run reads them through a SEPARATE pool:
// PSFN_GATEWAY_PG_SCHEMA names the gateway schema and, when it differs from
// COMPANION_PG_SCHEMA, PSFN_GATEWAY_POSTGRES_DATABASE_URL names a credential
// that can read it (operator-provisioned, read-only). Whenever
// COMPANION_PG_SCHEMA is set the gateway schema must be declared; a follower
// run never silently reads gateway tables through the tenant role.

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
let gatewayPool = null;

function assertValidSchemaName(schema, variable = 'COMPANION_PG_SCHEMA') {
  if (schema.length > SCHEMA_NAME_MAX_LENGTH || !SCHEMA_NAME_PATTERN.test(schema)) {
    throw new InvalidEnvError(
      variable,
      'must be a lowercase letter followed by lowercase letters, digits, or underscores '
      + `(max ${SCHEMA_NAME_MAX_LENGTH} chars)`,
    );
  }
  return schema;
}

function poolConfig(connectionString, schema) {
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
    // Pin search_path at connection startup exactly like the runtime pool. The
    // validated identifier contains no whitespace or metacharacters.
    config.options = `-c search_path=${schema},${EXTENSION_SCHEMA_NAME}`;
  }
  return config;
}

/** Lazily open the shared pool from the fail-closed env. */
export function getPool() {
  if (pool) return pool;
  const connectionString = requireEnv('POSTGRES_DATABASE_URL', 'the round Postgres database');
  const schema = optionalEnv('COMPANION_PG_SCHEMA');
  pool = new Pool(poolConfig(connectionString, schema ? assertValidSchemaName(schema) : undefined));
  return pool;
}

/**
 * Where gateway-owned tables are read (ypah0). Returns `{ shared: true }` when
 * they share the companion pool (single-schema runs, or a run targeting the
 * gateway's own tenant), else the dedicated connection. Fail closed.
 */
export function resolveGatewayPoolTarget(env = process.env) {
  const companionSchema = optionalEnv('COMPANION_PG_SCHEMA', undefined, env);
  const gatewaySchemaRaw = optionalEnv('PSFN_GATEWAY_PG_SCHEMA', undefined, env);
  if (!companionSchema) {
    if (gatewaySchemaRaw) {
      throw new InvalidEnvError(
        'PSFN_GATEWAY_PG_SCHEMA',
        'requires COMPANION_PG_SCHEMA (a single-schema run reads gateway tables from its own schema)',
      );
    }
    return { shared: true };
  }
  if (!gatewaySchemaRaw) {
    throw new InvalidEnvError(
      'PSFN_GATEWAY_PG_SCHEMA',
      'is required when COMPANION_PG_SCHEMA is set: name the fleet gateway schema that owns '
      + 'gateway_audit and model_usage_events (the primary tenant schema)',
    );
  }
  const gatewaySchema = assertValidSchemaName(gatewaySchemaRaw, 'PSFN_GATEWAY_PG_SCHEMA');
  if (gatewaySchema === assertValidSchemaName(companionSchema)) return { shared: true };
  const connectionString = requireEnv(
    'PSFN_GATEWAY_POSTGRES_DATABASE_URL',
    `a read credential for the fleet gateway schema ${gatewaySchema} (a follower tenant role cannot read it)`,
    env,
  );
  return { shared: false, connectionString, schema: gatewaySchema };
}

/** Pool for gateway-owned tables (gateway_audit, model_usage_events). */
export function getGatewayPool() {
  if (gatewayPool) return gatewayPool;
  const target = resolveGatewayPoolTarget();
  if (target.shared) return getPool();
  gatewayPool = new Pool(poolConfig(target.connectionString, target.schema));
  return gatewayPool;
}

/** Rows from a gateway-owned table. */
export async function gatewayPgAll(sql, params = []) {
  const result = await getGatewayPool().query(sql, params);
  return result.rows;
}

/** First column of the first row from a gateway-owned table, or null. */
export async function gatewayPgScalar(sql, params = []) {
  const rows = await gatewayPgAll(sql, params);
  if (rows.length === 0) return null;
  const first = rows[0];
  const key = Object.keys(first)[0];
  return key ? first[key] : null;
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
  // Gateway-owned tables must be readable from the run's gateway pool before
  // any case starts (ypah0); a missing declaration throws its named env error.
  const gatewayTarget = resolveGatewayPoolTarget();
  try {
    await gatewayPgScalar('select count(*) from gateway_audit where false');
  } catch (error) {
    throw new Error(
      `gateway_audit not readable via ${gatewayTarget.shared ? 'POSTGRES_DATABASE_URL' : 'PSFN_GATEWAY_POSTGRES_DATABASE_URL'}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Close the pools. Idempotent; safe to call in a finally. */
export async function closePool() {
  const closing = [pool, gatewayPool].filter(Boolean);
  pool = null;
  gatewayPool = null;
  await Promise.all(closing.map((entry) => entry.end()));
}
