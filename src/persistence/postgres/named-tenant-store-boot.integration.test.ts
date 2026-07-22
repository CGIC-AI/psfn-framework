// ── Live-database coverage for startup stores under a NAMED tenant schema ──
//
// Regression coverage for psfn-framework-stmof. Every store that opens its own
// pool from runtime config (rather than through `createAgentPersistenceRuntime`)
// is a candidate for the same blindspot: it inherits Postgres' default
// `"$user", public` search_path, which resolves to *nothing* under a fleet
// member's credential — there is no schema named after the login role, and an
// adopted `public` tenant has revoked USAGE from PUBLIC. Its unqualified
// startup DDL then dies with `no schema has been selected to create in`.
//
// A single-companion cluster on `public` cannot see this: `public` is the
// default search_path entry and its own tenant role owns it. So the fixture
// below deliberately mirrors the multi-companion posture — a provisioned
// `companion_*` tenant, a login role that is the tenant role, and a `public`
// schema locked away from PUBLIC.
//
// Two properties are asserted per store: it works when pinned to the tenant
// boundary, and a startup migration failure is reported and re-thrown rather
// than escaping as a process-level unhandled rejection.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresPool } from '../postgres.js';
import { clearDiagnosticLogRingBufferForTests, getRecentDiagnosticLogRecords } from '../../shared/logger.js';
import {
  PostgresAnalysisWorkbenchTraceStore,
  createPostgresAnalysisWorkbenchTraceStoreFromConfig,
} from './analysis-workbench-trace-store.js';
import { PostgresModelUsageStore } from './model-usage-store.js';
import { planPostgresTenantAccess, provisionPostgresTenantAccess } from './tenancy.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import type { AnalysisWorkbenchTraceView } from '../../operator/garden/types.js';

// The stores under test need no pgvector; the plain postgres image is fast.
const TEST_IMAGE = 'postgres:16-alpine';
const INTEGRATION_TIMEOUT_MS = 180_000;
const TENANT_SCHEMA = 'companion_named_tenant_boot';
const TENANT_PASSWORD = 'named-tenant-boot';
const COMPANION_ID = 'f1a2b3c4-d5e6-4f70-8123-456789abcdef';
const RETENTION_CAP = 50;
/** Postgres' error when every search_path entry is missing or unreadable. */
const NO_SCHEMA_SELECTED = /no schema has been selected to create in/;

let harness: PostgresTestHarness | null = null;

interface NamedTenantDatabase {
  /** Superuser URL, for out-of-band placement assertions. */
  adminUrl: string;
  /** The agent's own credential: the tenant role, with LOGIN. */
  tenantUrl: string;
  schema: string;
  role: string;
}

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

/**
 * Provision one database exactly as the fleet deployment does: an explicit
 * tenant boundary (schema owned by a least-privilege role, USAGE on
 * `extensions` only), the tenant role given LOGIN so it is the agent's own
 * credential, and `public` closed to PUBLIC the way flagship adoption leaves it.
 */
async function namedTenantDatabase(): Promise<NamedTenantDatabase> {
  if (!harness) throw new Error('Postgres integration harness is unavailable');
  const database = await harness.createDatabase();
  const plan = planPostgresTenantAccess({ schema: TENANT_SCHEMA });
  const admin = createPostgresPool(database.databaseUrl, {
    applicationName: 'psfn-named-tenant-boot-provision',
    max: 1,
  });
  try {
    await provisionPostgresTenantAccess(admin, { plan });
    // Provisioning deliberately leaves the tenant role NOLOGIN; the deployment
    // grants it a password separately so each agent connects as its own tenant.
    await admin.query(`ALTER ROLE "${plan.role}" LOGIN PASSWORD '${TENANT_PASSWORD}'`);
    await admin.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  } finally {
    await admin.end();
  }
  const tenantUrl = new URL(database.databaseUrl);
  tenantUrl.username = plan.role;
  tenantUrl.password = TENANT_PASSWORD;
  return {
    adminUrl: database.databaseUrl,
    tenantUrl: tenantUrl.toString(),
    schema: plan.schema,
    role: plan.role,
  };
}

/** Schemas that own a relation of this name, read with superuser authority. */
async function schemasHoldingRelation(adminUrl: string, relation: string): Promise<string[]> {
  const admin = createPostgresPool(adminUrl, {
    applicationName: 'psfn-named-tenant-boot-placement',
    max: 1,
  });
  try {
    const result = await admin.query<{ table_schema: string }>(
      'SELECT table_schema FROM information_schema.tables WHERE table_name = $1 ORDER BY 1',
      [relation],
    );
    return result.rows.map(row => row.table_schema);
  } finally {
    await admin.end();
  }
}

function traceView(timestamp: number, task: string): AnalysisWorkbenchTraceView {
  return {
    timestamp,
    task,
    iterations: 1,
    totalTokens: 12,
    durationMs: 34,
    truncated: false,
    budgetStop: null,
    steps: [{
      iteration: 1,
      inputTokens: 8,
      outputTokens: 4,
      cumulativeTokens: 12,
      durationMs: 34,
      code: 'sum(1, 1)',
      output: '2',
      error: null,
      variablesChanged: [],
    }],
  };
}

/**
 * Run `handler` while capturing process-level unhandled rejections, so a store
 * that leaves its constructor-created migration promise unobserved fails the
 * test instead of only printing an ERROR line in production.
 */
async function withUnhandledRejectionCapture<T>(
  handler: () => Promise<T>,
): Promise<{ result: T; unhandled: string[] }> {
  const unhandled: string[] = [];
  const listener = (reason: unknown): void => { unhandled.push(String(reason)); };
  process.on('unhandledRejection', listener);
  try {
    const result = await handler();
    // Node reports an unhandled rejection only after the microtask queue
    // drains, so give the failed migration a real window to surface.
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    return { result, unhandled };
  } finally {
    process.off('unhandledRejection', listener);
  }
}

describe('analysis-workbench trace store on a named tenant schema', () => {
  it('records and rehydrates inside the tenant schema, never public', async () => {
    const tenant = await namedTenantDatabase();
    const store = PostgresAnalysisWorkbenchTraceStore.connect(
      tenant.tenantUrl,
      COMPANION_ID,
      RETENTION_CAP,
      { schema: tenant.schema, role: tenant.role },
    );
    try {
      await store.record(traceView(1_700_000_000_000, 'first'));
      await store.record(traceView(1_700_000_001_000, 'second'));
      const listed = await store.listRecent(RETENTION_CAP);
      expect(listed.map(trace => trace.task)).toEqual(['second', 'first']);
    } finally {
      await store.close();
    }
    // The whole point of the fix: the relation belongs to the companion's
    // tenant, not to the legacy public tenant every fleet member shares.
    expect(await schemasHoldingRelation(tenant.adminUrl, 'analysis_workbench_traces'))
      .toEqual([TENANT_SCHEMA]);
  }, INTEGRATION_TIMEOUT_MS);

  it('fails closed, reports, and re-throws when the tenant pin is missing', async () => {
    const tenant = await namedTenantDatabase();
    clearDiagnosticLogRingBufferForTests();
    // An unpinned pool is exactly the pre-fix wiring. It must not silently
    // write somewhere else, and its failure must not escape the process.
    const store = PostgresAnalysisWorkbenchTraceStore.connect(
      tenant.tenantUrl,
      COMPANION_ID,
      RETENTION_CAP,
    );
    const { result: listRejection, unhandled } = await withUnhandledRejectionCapture(async () => {
      return await store.listRecent(RETENTION_CAP).then(
        () => null,
        (error: unknown) => String(error),
      );
    });
    await store.close();

    expect(listRejection).toMatch(NO_SCHEMA_SELECTED);
    expect(unhandled).toEqual([]);
    expect(getRecentDiagnosticLogRecords({ limit: 50 }).some(record => (
      record.component === 'AnalysisWorkbenchTraceStore'
      && record.message === 'Analysis-workbench trace schema migration failed'
    ))).toBe(true);
    expect(await schemasHoldingRelation(tenant.adminUrl, 'analysis_workbench_traces')).toEqual([]);
  }, INTEGRATION_TIMEOUT_MS);
});

describe('createPostgresAnalysisWorkbenchTraceStoreFromConfig tenant resolution', () => {
  it('pins the configured per-companion schema and role', async () => {
    const tenant = await namedTenantDatabase();
    const store = createPostgresAnalysisWorkbenchTraceStoreFromConfig({
      persistenceBackend: 'postgres',
      postgresDatabaseUrl: tenant.tenantUrl,
      companionId: COMPANION_ID,
      postgresSchema: tenant.schema,
      postgresRole: tenant.role,
      multiCompanion: true,
    }, RETENTION_CAP);
    if (!store) throw new Error('Postgres config must yield an analysis-workbench trace store');
    try {
      await store.record(traceView(1_700_000_002_000, 'from-config'));
      expect((await store.listRecent(RETENTION_CAP)).map(trace => trace.task))
        .toEqual(['from-config']);
    } finally {
      await store.close();
    }
    expect(await schemasHoldingRelation(tenant.adminUrl, 'analysis_workbench_traces'))
      .toEqual([TENANT_SCHEMA]);
  }, INTEGRATION_TIMEOUT_MS);

  it('refuses a multi-companion fleet member that has no topology-owned role', () => {
    expect(() => createPostgresAnalysisWorkbenchTraceStoreFromConfig({
      persistenceBackend: 'postgres',
      postgresDatabaseUrl: 'postgresql://unused:unused@127.0.0.1:1/psfn',
      companionId: COMPANION_ID,
      postgresSchema: TENANT_SCHEMA,
      multiCompanion: true,
    }, RETENTION_CAP)).toThrow(/requires config\.postgresRole/);
  });
});

describe('model usage store startup migration on a named tenant schema', () => {
  // The fleet cost ledger lives in the shared legacy `public` tenant and is
  // written by the gateway, so a fleet member's credential genuinely cannot run
  // its DDL. That is a tenancy question of its own; what must never happen is
  // the failure escaping the agent as an unhandled rejection — the second half
  // of psfn-framework-stmof.
  it('reports and re-throws instead of escaping as an unhandled rejection', async () => {
    const tenant = await namedTenantDatabase();
    clearDiagnosticLogRingBufferForTests();
    // `PostgresModelUsageStore.connect` builds exactly this pool; the store has
    // no `close`, so the test owns the pool lifecycle (harness `stop()` fails
    // closed on leaked backends).
    const pool = createPostgresPool(tenant.tenantUrl, {
      applicationName: 'psfn-model-usage',
      allowExitOnIdle: true,
      max: 1,
    });
    const store = new PostgresModelUsageStore(pool, { companionId: COMPANION_ID });
    const { result: queryRejection, unhandled } = await withUnhandledRejectionCapture(async () => {
      return await store.getUsageData({}).then(
        () => null,
        (error: unknown) => String(error),
      );
    });
    await pool.end();

    expect(queryRejection).toMatch(NO_SCHEMA_SELECTED);
    expect(unhandled).toEqual([]);
    expect(getRecentDiagnosticLogRecords({ limit: 50 }).some(record => (
      record.component === 'ModelUsageStore'
      && record.message === 'Model usage schema migration failed'
    ))).toBe(true);
  }, INTEGRATION_TIMEOUT_MS);
});
