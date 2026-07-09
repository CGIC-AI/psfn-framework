import type { Pool } from 'pg';
import {
  assertValidPostgresSchemaName,
  createPostgresPool,
  withPostgresClient,
} from '../postgres.js';
import {
  POSTGRES_SHARED_MIGRATIONS,
  POSTGRES_SHARED_WIKI_MIGRATIONS,
  SHARED_SCHEMA_NAME,
} from './migrations.js';

/**
 * Cluster-wide advisory lock key serializing shared-schema provisioning.
 *
 * `CREATE SCHEMA IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` are *not* safe
 * under a concurrent first-creation race: two sessions can both observe the
 * object as missing and one then fails with a duplicate-key error on the
 * catalog (pg_namespace / pg_type). With N companion agent processes starting
 * simultaneously against one database (the multi-companion topology), that
 * race is real, so provisioning takes a transaction-scoped advisory lock and
 * the losers simply wait and then no-op through the IF NOT EXISTS chain.
 *
 * Key split: classid 0x5053464e (a fixed project tag), objid 1 (shared-schema
 * provisioning).
 */
const SHARED_SCHEMA_ADVISORY_LOCK_CLASS = 0x5053464e;
const SHARED_SCHEMA_ADVISORY_LOCK_ID = 1;

/**
 * Provision the shared world schema and run its migration chain.
 *
 * This is the single provisioning path for the `shared` schema that holds
 * cross-companion world data (sprint 10 W2/W5a). It creates the schema if
 * missing and runs {@link POSTGRES_SHARED_MIGRATIONS} inside it, all within
 * one transaction guarded by a transaction-scoped advisory lock, so it is
 * idempotent AND safe under N concurrently-starting agent processes.
 *
 * The caller owns the pool. The transaction pins its own `SET LOCAL
 * search_path` to the shared schema, so the unqualified migration statements
 * always resolve into `shared` — regardless of whether the pool itself was
 * created with `{ schema: SHARED_SCHEMA_NAME }` — and the pool's own
 * search_path is untouched after commit.
 */
export async function ensureSharedSchema(pool: Pool): Promise<void> {
  await provisionSharedSchema(pool, [POSTGRES_SHARED_MIGRATIONS]);
}

/**
 * Provision the shared schema INCLUDING the shared-world wiki chunk projection
 * (ledger version 3, sprint 10 s10f9). The wiki statement list requires the
 * pgvector extension, so it is a separate chain layered on top of the base
 * shared chain: pgvector-free shared consumers (companion presence) keep
 * calling {@link ensureSharedSchema}, while every shared-wiki surface calls
 * this. Runs base + wiki chains in one transaction under the SAME advisory
 * lock, so wiki provisioning serializes with presence provisioning and is
 * idempotent under N concurrent callers. Fails closed (throws) when pgvector
 * is unavailable — a shared-wiki surface must never silently come up without
 * its projection table.
 */
export async function ensureSharedWikiSchema(pool: Pool): Promise<void> {
  await provisionSharedSchema(pool, [POSTGRES_SHARED_MIGRATIONS, POSTGRES_SHARED_WIKI_MIGRATIONS]);
}

async function provisionSharedSchema(
  pool: Pool,
  chains: ReadonlyArray<readonly string[]>,
): Promise<void> {
  const schema = assertValidPostgresSchemaName(SHARED_SCHEMA_NAME);
  await withPostgresClient(pool, async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock($1, $2)',
      [SHARED_SCHEMA_ADVISORY_LOCK_CLASS, SHARED_SCHEMA_ADVISORY_LOCK_ID],
    );
    // The identifier is already restricted to a safe character set; the quotes
    // are belt-and-suspenders so reserved words would still be legal.
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    // Transaction-local pin: migration statements below are unqualified and
    // MUST land in the shared schema even on a pool without a pinned
    // search_path (`public` is retained for shared extension types).
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    for (const chain of chains) {
      for (const statement of chain) {
        await client.query(statement);
      }
    }
  });
}

/**
 * Convenience wrapper that opens a dedicated, schema-pinned pool for the shared
 * world schema, runs its migration chain, and closes the pool.
 *
 * Intended for one-shot bootstrap/maintenance callers. Long-lived runtimes
 * should own their own pool and call {@link ensureSharedSchema}.
 */
export async function bootstrapSharedSchema(databaseUrl: string): Promise<void> {
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-shared-schema',
    allowExitOnIdle: true,
    max: 1,
    schema: SHARED_SCHEMA_NAME,
  });
  try {
    await ensureSharedSchema(pool);
  } finally {
    await pool.end();
  }
}
