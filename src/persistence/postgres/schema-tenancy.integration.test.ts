import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPostgresPool,
  ensurePostgresSchemaExists,
  runPostgresMigrations,
} from '../postgres.js';
import { POSTGRES_CONTACT_MIGRATIONS } from './migrations.js';
import { bootstrapSharedSchema, ensureSharedSchema } from './shared-schema.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';

// The tenancy plumbing does not need pgvector; use the plain postgres image so
// this runs against a locally available base image and stays fast.
const TEST_IMAGE = 'postgres:16-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) {
    await harness.stop();
  }
}, INTEGRATION_TIMEOUT_MS);

async function freshDatabaseUrl(): Promise<string> {
  if (!harness) {
    throw new Error('Postgres integration harness is not available');
  }
  const database = await harness.createDatabase();
  return database.databaseUrl;
}

async function tableSchemas(pool: import('pg').Pool, table: string): Promise<string[]> {
  const result = await pool.query<{ table_schema: string }>(
    `SELECT table_schema FROM information_schema.tables WHERE table_name = $1 ORDER BY table_schema`,
    [table],
  );
  return result.rows.map(row => row.table_schema);
}

describe('Postgres schema tenancy plumbing', () => {
  it(
    'pins search_path to the companion schema and runs the migration chain inside it',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-tenancy-test',
        allowExitOnIdle: true,
        max: 1,
        schema: 'companion_a',
      });
      try {
        const searchPath = await pool.query<{ search_path: string }>('SHOW search_path');
        // Set via the libpq `options` param, Postgres reports it without spaces.
        expect(searchPath.rows[0]?.search_path.replace(/\s/g, '')).toBe('companion_a,public');

        await runPostgresMigrations(pool, POSTGRES_CONTACT_MIGRATIONS, { schema: 'companion_a' });

        // The contacts table exists in the companion schema, never in public.
        expect(await tableSchemas(pool, 'contacts')).toEqual(['companion_a']);
      } finally {
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'isolates identically-named tables across companion schemas',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const poolA = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-tenancy-a',
        allowExitOnIdle: true,
        max: 1,
        schema: 'companion_a',
      });
      const poolB = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-tenancy-b',
        allowExitOnIdle: true,
        max: 1,
        schema: 'companion_b',
      });
      try {
        await runPostgresMigrations(poolA, POSTGRES_CONTACT_MIGRATIONS, { schema: 'companion_a' });
        await runPostgresMigrations(poolB, POSTGRES_CONTACT_MIGRATIONS, { schema: 'companion_b' });

        const now = new Date().toISOString();
        await poolA.query(
          `INSERT INTO contacts (id, display_name, first_seen, last_seen) VALUES ($1, $2, $3, $3)`,
          ['contact-a', 'Companion A contact', now],
        );

        // Companion B's pool sees only its own (empty) schema — no crossover.
        const bRows = await poolB.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM contacts');
        expect(bRows.rows[0]?.count).toBe('0');

        const aRows = await poolA.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM contacts');
        expect(aRows.rows[0]?.count).toBe('1');

        // Both schemas physically hold their own contacts table.
        const inventory = await poolA.query<{ table_schema: string }>(
          `SELECT table_schema FROM information_schema.tables WHERE table_name = 'contacts' ORDER BY table_schema`,
        );
        expect(inventory.rows.map(r => r.table_schema)).toEqual(['companion_a', 'companion_b']);
      } finally {
        await poolA.end();
        await poolB.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'leaves search_path at the default and uses public when no schema is requested',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-tenancy-default',
        allowExitOnIdle: true,
        max: 1,
      });
      try {
        const searchPath = await pool.query<{ search_path: string }>('SHOW search_path');
        // pg default search_path; no companion schema injected.
        expect(searchPath.rows[0]?.search_path).toContain('public');
        expect(searchPath.rows[0]?.search_path).not.toContain('companion_');

        // With no schema requested, runPostgresMigrations runs the chain in the
        // default (public) schema exactly as today.
        await runPostgresMigrations(pool, POSTGRES_CONTACT_MIGRATIONS);
        expect(await tableSchemas(pool, 'contacts')).toEqual(['public']);
      } finally {
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'provisions the shared world schema with its own version ledger and no world tables',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      await bootstrapSharedSchema(databaseUrl);

      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-shared-verify',
        allowExitOnIdle: true,
        max: 1,
      });
      try {
        const schemaExists = await pool.query<{ schema_name: string }>(
          `SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'shared'`,
        );
        expect(schemaExists.rows).toHaveLength(1);

        // Version ledger seeded with the baseline; no world tables yet.
        const version = await pool.query<{ version: number; name: string }>(
          `SELECT version, name FROM shared.shared_schema_migrations ORDER BY version`,
        );
        expect(version.rows).toEqual([{ version: 1, name: 'shared-schema-baseline' }]);

        const sharedTables = await pool.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'shared' ORDER BY table_name`,
        );
        expect(sharedTables.rows.map(r => r.table_name)).toEqual(['shared_schema_migrations']);

        // Idempotent: re-running does not duplicate the ledger row.
        await ensureSharedSchema(pool);
        const versionAgain = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM shared.shared_schema_migrations`,
        );
        expect(versionAgain.rows[0]?.count).toBe('1');
      } finally {
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'creates a schema on demand via ensurePostgresSchemaExists and fails closed on a bad name',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-ensure-schema',
        allowExitOnIdle: true,
        max: 1,
      });
      try {
        await ensurePostgresSchemaExists(pool, 'companion_ondemand');
        const created = await pool.query<{ schema_name: string }>(
          `SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'companion_ondemand'`,
        );
        expect(created.rows).toHaveLength(1);

        await expect(ensurePostgresSchemaExists(pool, 'bad; drop schema public')).rejects.toThrow();
      } finally {
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
