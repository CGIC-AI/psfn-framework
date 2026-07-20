import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  createPostgresPool,
  runPostgresMigrations,
} from '../postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { POSTGRES_MEMORY_MIGRATIONS } from './migrations.js';

const INTEGRATION_TIMEOUT_MS = 120_000;

let harness: PostgresTestHarness | undefined;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

async function readVectorExtensionSchema(pool: Pool): Promise<string | undefined> {
  const result = await pool.query<{ schema_name: string }>(`
    SELECT namespace.nspname AS schema_name
    FROM pg_extension extension
    JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
    WHERE extension.extname = 'vector'
  `);
  return result.rows[0]?.schema_name;
}

describe('Postgres pgvector extension schema targeting', () => {
  it('migrates an unprovisioned legacy database with pgvector in public', async () => {
    if (!harness) throw new Error('Postgres integration harness is not available');
    const database = await harness.createDatabase({ provisionExtensionSchema: false });
    const pool = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-vector-schema-legacy',
      max: 1,
    });
    try {
      await pool.query('CREATE EXTENSION vector WITH SCHEMA public');

      await runPostgresMigrations(pool, POSTGRES_MEMORY_MIGRATIONS);

      await expect(pool.query(`
        SELECT
          to_regnamespace('extensions')::text AS extension_namespace,
          to_regclass('public.l2_memories')::text AS memory_table
      `)).resolves.toMatchObject({
        rows: [{
          extension_namespace: null,
          memory_table: 'l2_memories',
        }],
      });
      await expect(readVectorExtensionSchema(pool)).resolves.toBe('public');
    } finally {
      await pool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('migrates public and named tenants with pgvector in extensions', async () => {
    if (!harness) throw new Error('Postgres integration harness is not available');
    const database = await harness.createDatabase();
    const admin = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-vector-schema-admin',
      max: 1,
    });
    const publicTenant = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-vector-schema-public-tenant',
      schema: 'public',
      max: 1,
    });
    const namedTenant = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-vector-schema-named-tenant',
      schema: 'companion_vector',
      max: 1,
    });
    try {
      await admin.query('CREATE EXTENSION vector WITH SCHEMA extensions');

      await runPostgresMigrations(publicTenant, POSTGRES_MEMORY_MIGRATIONS, {
        schema: 'public',
      });
      await runPostgresMigrations(namedTenant, POSTGRES_MEMORY_MIGRATIONS, {
        schema: 'companion_vector',
      });

      await expect(readVectorExtensionSchema(admin)).resolves.toBe('extensions');
      await expect(admin.query(`
        SELECT to_regclass('public.l2_memories')::text AS public_table,
               to_regclass('companion_vector.l2_memories')::text AS named_table
      `)).resolves.toMatchObject({
        rows: [{
          public_table: 'l2_memories',
          named_table: 'companion_vector.l2_memories',
        }],
      });
    } finally {
      await publicTenant.end();
      await namedTenant.end();
      await admin.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('installs available pgvector in extensions for an explicit public tenant', async () => {
    if (!harness) throw new Error('Postgres integration harness is not available');
    const database = await harness.createDatabase();
    const publicTenant = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-vector-schema-public-tenant-install',
      schema: 'public',
      max: 1,
    });
    try {
      await runPostgresMigrations(publicTenant, POSTGRES_MEMORY_MIGRATIONS, {
        schema: 'public',
      });

      await expect(readVectorExtensionSchema(publicTenant)).resolves.toBe('extensions');
    } finally {
      await publicTenant.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('fails closed with both accepted schemas named when pgvector is unavailable', async () => {
    const plainHarness = await startPostgresTestHarness({
      image: DEFAULT_POSTGRES_TEST_IMAGE,
    });
    try {
      const database = await plainHarness.createDatabase({ provisionExtensionSchema: false });
      const pool = createPostgresPool(database.databaseUrl, {
        applicationName: 'psfn-vector-schema-missing',
        max: 1,
      });
      try {
        await expect(
          runPostgresMigrations(pool, POSTGRES_MEMORY_MIGRATIONS),
        ).rejects.toThrow(
          'pgvector is not installed in either acceptable schema: public or extensions',
        );
      } finally {
        await pool.end();
      }
    } finally {
      await plainHarness.stop();
    }
  }, INTEGRATION_TIMEOUT_MS);
});
