import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createPostgresPool } from '../../../persistence/postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { PostgresObserverEvalSidecarStore } from './persistence.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const NOW_MS = 1_780_000_000_000;
const TENANT_SCHEMA = 'companion_observer_tenant';

let harness: PostgresTestHarness | undefined;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

async function tableSchemas(pool: Pool, table: string): Promise<string[]> {
  const result = await pool.query<{ table_schema: string }>(
    'SELECT table_schema FROM information_schema.tables WHERE table_name = $1 ORDER BY table_schema',
    [table],
  );
  return result.rows.map(row => row.table_schema);
}

describe('observer-eval sidecar store on a fresh tenant schema (psfn-framework-hrmrq.86)', () => {
  it('creates the tenant schema before replaying DDL and lands tables in that schema', async () => {
    if (!harness) throw new Error('Postgres integration harness is not available');
    const database = await harness.createDatabase();

    // A follower companion pool: search_path pinned to a schema that does not
    // exist yet. Before the fix the constructor replayed DDL through plain
    // ensurePostgresSchema and crashed with "no schema has been selected to
    // create in"; runPostgresMigrations must create the schema first.
    const pool = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-observer-sidecar-tenant-test',
      schema: TENANT_SCHEMA,
      max: 1,
    });
    const inspectPool = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-observer-sidecar-tenant-inspect',
      max: 1,
    });
    try {
      const store = new PostgresObserverEvalSidecarStore(pool, {
        nowMs: () => NOW_MS,
        schema: TENANT_SCHEMA,
      });

      const run = await store.upsertRun({
        runId: 'tenant-run-1',
        sidecarId: 'observer-sidecar-tenant-test',
        deployment: 'test',
        startedAtMs: NOW_MS,
        retention: {
          retentionClass: 'short',
          policyId: 'tenant-test-policy',
          capturedAtMs: NOW_MS,
          retainUntilMs: NOW_MS + 86_400_000,
          reason: 'tenant schema integration test',
        },
      });
      expect(run.runId).toBe('tenant-run-1');

      // The tables must live in the tenant schema, not public.
      await expect(tableSchemas(inspectPool, 'observer_eval_sidecar_runs'))
        .resolves.toEqual([TENANT_SCHEMA]);

      const stored = await inspectPool.query<{ run_id: string }>(
        `SELECT run_id FROM "${TENANT_SCHEMA}".observer_eval_sidecar_runs`,
      );
      expect(stored.rows).toEqual([{ run_id: 'tenant-run-1' }]);
    } finally {
      await pool.end();
      await inspectPool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('connect() propagates the tenant scope so migrations target the tenant schema', async () => {
    if (!harness) throw new Error('Postgres integration harness is not available');
    const database = await harness.createDatabase();

    const admin = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-observer-sidecar-tenant-admin',
      max: 1,
    });
    try {
      // The production follower path passes {schema, role}; SET ROLE requires
      // the role to exist and be granted, mirroring provisioned tenants. Roles
      // are cluster-wide in the shared test container, so the name is unique.
      const roleName = `companion_observer_role_${Date.now().toString(36)}`;
      await admin.query(`CREATE ROLE "${roleName}"`);
      await admin.query(`GRANT "${roleName}" TO CURRENT_USER`);
      await admin.query(
        `GRANT CREATE ON DATABASE "${database.databaseName}" TO "${roleName}"`,
      );

      const store = PostgresObserverEvalSidecarStore.connect(
        database.databaseUrl,
        { nowMs: () => NOW_MS },
        { schema: TENANT_SCHEMA, role: roleName },
      );
      const run = await store.upsertRun({
        runId: 'tenant-run-2',
        sidecarId: 'observer-sidecar-tenant-test',
        deployment: 'test',
        startedAtMs: NOW_MS,
        retention: {
          retentionClass: 'short',
          policyId: 'tenant-test-policy',
          capturedAtMs: NOW_MS,
          retainUntilMs: NOW_MS + 86_400_000,
          reason: 'tenant schema integration test (connect path)',
        },
      });
      expect(run.runId).toBe('tenant-run-2');

      await expect(tableSchemas(admin, 'observer_eval_sidecar_runs'))
        .resolves.toEqual([TENANT_SCHEMA]);
    } finally {
      await admin.end();
    }
  }, INTEGRATION_TIMEOUT_MS);
});
