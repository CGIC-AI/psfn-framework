import type { Pool } from 'pg';
import { createPostgresPool, runPostgresMigrations } from '../postgres.js';
import { POSTGRES_SHARED_MIGRATIONS, SHARED_SCHEMA_NAME } from './migrations.js';

/**
 * Provision the shared world schema and run its (currently infrastructure-only)
 * migration chain.
 *
 * This is the sprint-10 W2 scaffold for the single `shared` schema that holds
 * cross-companion world data. It creates the `shared` schema if missing and
 * runs {@link POSTGRES_SHARED_MIGRATIONS} inside it. The chain has no world
 * tables yet — only its own version ledger — so this is safe to run repeatedly
 * and against an existing database.
 *
 * The caller owns the pool. If the pool was created with
 * `{ schema: SHARED_SCHEMA_NAME }` the search_path is already pinned; otherwise
 * {@link runPostgresMigrations} still targets the schema explicitly.
 */
export async function ensureSharedSchema(pool: Pool): Promise<void> {
  await runPostgresMigrations(pool, POSTGRES_SHARED_MIGRATIONS, { schema: SHARED_SCHEMA_NAME });
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
