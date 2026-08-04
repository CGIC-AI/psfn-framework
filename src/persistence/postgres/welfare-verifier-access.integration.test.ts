// psfn-framework-m8zdu — real-Postgres proof that the canonical fleet tenant
// provisioning contract restores and preserves the gateway welfare verifier's
// read access to `agent_background_work_jobs` in every fleet schema.
//
// Root cause this pins: the verifier connects unpinned as the runtime login
// role, and tenant roles are NOINHERIT, so the membership provisioning grants
// carries inherit_option=false — the login holds no privilege through it and
// the readiness probe (`assertPostgresRelationColumns`, SELECT) fails closed,
// degrading `welfare_grant_verifier` at gateway startup. The repair is the
// idempotent least-privilege grant in `welfare-verifier-access.ts`, applied by
// `provisionPostgresTenantAccess` and re-asserted by the
// `provision:postgres-tenancy` operator path after tenant migrations.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresPool } from '../postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { PostgresBackgroundWorkStore } from './background-work-store.js';
import {
  planPostgresTenantAccess,
  provisionPostgresTenantAccess,
} from './tenancy.js';
import { grantWelfareVerifierReadAccessToTenantSchema } from './welfare-verifier-access.js';
import {
  createWelfareGrantVerifierForPool,
  type WelfareGrantVerifier,
} from '../../boundary/gateway/welfare-grant-verifier.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const LOGIN_PASSWORD = 'welfare-verifier-test';

const PRIMARY_SCHEMA = 'companion_primary';
const FOLLOWER_SCHEMA = 'companion_follower';
const PRIMARY_COMPANION = 'primary-companion-id';
const FOLLOWER_COMPANION = 'follower-companion-id';

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

async function freshDatabase(): Promise<{ databaseUrl: string; databaseName: string }> {
  if (!harness) throw new Error('Postgres welfare-verifier access harness is unavailable');
  const database = await harness.createDatabase();
  const databaseName = decodeURIComponent(new URL(database.databaseUrl).pathname.slice(1));
  return { databaseUrl: database.databaseUrl, databaseName };
}

/** A NOINHERIT login role, exactly how the fleet runtime roles are shaped. */
async function createRuntimeLogin(admin: Pool, databaseName: string): Promise<string> {
  const login = `wlverify_${databaseName}`.replaceAll('-', '_').slice(0, 63);
  await admin.query(`DROP ROLE IF EXISTS "${login}"`);
  await admin.query(`CREATE ROLE "${login}" LOGIN NOINHERIT PASSWORD '${LOGIN_PASSWORD}'`);
  return login;
}

function loginDatabaseUrl(databaseUrl: string, login: string): string {
  const url = new URL(databaseUrl);
  url.username = login;
  url.password = LOGIN_PASSWORD;
  return url.toString();
}

function createVerifier(
  databaseUrl: string,
  login: string,
  fleet: ReadonlyArray<{ companionId: string; postgresSchema: string }>,
): WelfareGrantVerifier {
  const pool = createPostgresPool(loginDatabaseUrl(databaseUrl, login), {
    applicationName: 'psfn-welfare-verify-access-test',
    allowExitOnIdle: true,
    max: 2,
  });
  return createWelfareGrantVerifierForPool(pool, {
    mode: 'fleet',
    schemaByCompanionId: new Map(
      fleet.map(companion => [companion.companionId, companion.postgresSchema]),
    ),
  });
}

async function migrateBackgroundWork(
  databaseUrl: string,
  plan: { schema: string; role: string },
): Promise<void> {
  const store = await PostgresBackgroundWorkStore.connect(databaseUrl, {
    schema: plan.schema,
    role: plan.role,
  });
  await store.close();
}

async function seedJob(
  pool: Pool,
  schema: string,
  input: { jobId: string; state: string; welfareClaimed: boolean },
): Promise<void> {
  const running = input.state === 'running';
  await pool.query(
    `INSERT INTO "${schema}".agent_background_work_jobs (
       job_id, idempotency_key, logical_session_id, kind, payload_schema_version,
       payload, payload_fingerprint, source_turn_id, source_request_id, source_channel_id,
       state, reason_code, attempt_count, max_attempts, created_at_ms, available_at_ms,
       updated_at_ms, lease_owner, lease_expires_at_ms, revision, welfare_claimed
     ) VALUES (
       $1, $1, $1, 'memory_extraction', 1,
       '{"schemaVersion":1}'::jsonb, 'fp', 'turn-1', 'req-1', 'chan-1',
       $2, 'started', 0, 3, 1, 1,
       1, $3, $4, 1, $5
     )`,
    [
      input.jobId,
      input.state,
      running ? 'owner-1' : null,
      running ? 9_999_999_999_999 : null,
      input.welfareClaimed,
    ],
  );
}

/** Direct (non-inherited) table privileges held by the runtime login role. */
async function directTablePrivileges(
  admin: Pool,
  schema: string,
  login: string,
): Promise<string[]> {
  const result = await admin.query<{ privilege_type: string }>(`
    SELECT acl.privilege_type
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL aclexplode(relation.relacl) acl
    JOIN pg_roles grantee ON grantee.oid = acl.grantee
    WHERE namespace.nspname = $1
      AND relation.relname = 'agent_background_work_jobs'
      AND grantee.rolname = $2
    ORDER BY acl.privilege_type
  `, [schema, login]);
  return result.rows.map(row => row.privilege_type);
}

describe('welfare verifier tenant-schema access (m8zdu, real Postgres)', () => {
  it('reproduces the follower degradation and repairs it through the canonical operator path', async () => {
    const { databaseUrl, databaseName } = await freshDatabase();
    const admin = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-welfare-access-admin',
      max: 2,
    });
    const primary = planPostgresTenantAccess({ schema: PRIMARY_SCHEMA });
    const follower = planPostgresTenantAccess({ schema: FOLLOWER_SCHEMA });
    let verifier: WelfareGrantVerifier | undefined;
    try {
      const login = await createRuntimeLogin(admin, databaseName);
      // Canonical provisioning: membership plus the welfare grant step. The
      // tenant tables do not exist yet, so only schema USAGE can land — this
      // is exactly the live ordering that drifted the follower schema.
      for (const plan of [primary, follower]) {
        await provisionPostgresTenantAccess(admin, { plan, runtimeLoginRole: login });
      }
      // The follower's agent boots later and runs its background-work
      // migrations as the tenant role, creating the table after provisioning.
      await migrateBackgroundWork(databaseUrl, primary);
      await migrateBackgroundWork(databaseUrl, follower);

      // REGRESSION PIN: the unpinned verifier login holds membership but no
      // table privilege, so startup readiness fails closed (degraded).
      verifier = createVerifier(databaseUrl, login, [
        { companionId: PRIMARY_COMPANION, postgresSchema: PRIMARY_SCHEMA },
        { companionId: FOLLOWER_COMPANION, postgresSchema: FOLLOWER_SCHEMA },
      ]);
      await expect(verifier.assertReady())
        .rejects.toThrow(/missing required role privileges: SELECT/u);
      await verifier.close();

      // Operator repair: re-run the canonical provisioning pass (the
      // provision:postgres-tenancy script re-asserts the same grant after
      // tenant migrations). Idempotent and scoped to the verifier relation.
      for (const plan of [primary, follower]) {
        await provisionPostgresTenantAccess(admin, { plan, runtimeLoginRole: login });
      }

      verifier = createVerifier(databaseUrl, login, [
        { companionId: PRIMARY_COMPANION, postgresSchema: PRIMARY_SCHEMA },
        { companionId: FOLLOWER_COMPANION, postgresSchema: FOLLOWER_SCHEMA },
      ]);
      // Gateway startup no longer degrades.
      await verifier.assertReady();

      // End-to-end: a genuine welfare-claimed running job in the follower
      // schema verifies; foils strip.
      await seedJob(admin, FOLLOWER_SCHEMA, {
        jobId: 'follower-welfare-running',
        state: 'running',
        welfareClaimed: true,
      });
      await seedJob(admin, FOLLOWER_SCHEMA, {
        jobId: 'follower-not-welfare',
        state: 'running',
        welfareClaimed: false,
      });
      expect(await verifier.verify('follower-welfare-running', FOLLOWER_COMPANION)).toBe(true);
      expect(await verifier.verify('follower-not-welfare', FOLLOWER_COMPANION)).toBe(false);
      expect(await verifier.verify('follower-welfare-running', PRIMARY_COMPANION)).toBe(false);

      // Exactly the required privilege: direct SELECT, nothing more, in both
      // fleet schemas; schema USAGE without CREATE.
      for (const schema of [PRIMARY_SCHEMA, FOLLOWER_SCHEMA]) {
        expect(await directTablePrivileges(admin, schema, login)).toEqual(['SELECT']);
      }
      const schemaPrivileges = await admin.query<{
        usage: boolean; create: boolean;
      }>(`
        SELECT
          has_schema_privilege($2, $1, 'USAGE') AS usage,
          has_schema_privilege($2, $1, 'CREATE') AS create
      `, [FOLLOWER_SCHEMA, login]);
      expect(schemaPrivileges.rows.at(0)).toMatchObject({ usage: true, create: false });
      const widened = await admin.query<{ privilege: string }>(`
        SELECT privilege
        FROM (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'))
          AS candidates(privilege)
        WHERE has_table_privilege($2, $1, candidates.privilege)
      `, [`${FOLLOWER_SCHEMA}.agent_background_work_jobs`, login]);
      expect(widened.rows).toEqual([]);
    } finally {
      await verifier?.close();
      await admin.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('grant is idempotent and covers a newly added follower after its migrations', async () => {
    const { databaseUrl, databaseName } = await freshDatabase();
    const admin = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-welfare-access-added',
      max: 2,
    });
    const added = planPostgresTenantAccess({ schema: 'added_follower' });
    let verifier: WelfareGrantVerifier | undefined;
    try {
      const login = await createRuntimeLogin(admin, databaseName);
      await provisionPostgresTenantAccess(admin, { plan: added, runtimeLoginRole: login });

      // Pre-migration re-asserts are safe no-ops beyond schema USAGE.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const evidence = await grantWelfareVerifierReadAccessToTenantSchema(admin, {
          schema: added.schema,
          verifierRole: login,
        });
        expect(evidence.relationGranted).toBe(false);
      }

      // The added follower runs its migrations; the operator re-assert lands
      // the table grant exactly once, however many times it runs.
      await migrateBackgroundWork(databaseUrl, added);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const evidence = await grantWelfareVerifierReadAccessToTenantSchema(admin, {
          schema: added.schema,
          verifierRole: login,
        });
        expect(evidence).toMatchObject({
          schema: added.schema,
          verifierRole: login,
          relationGranted: true,
        });
      }
      expect(await directTablePrivileges(admin, added.schema, login)).toEqual(['SELECT']);

      verifier = createVerifier(databaseUrl, login, [
        { companionId: 'added-follower-id', postgresSchema: added.schema },
      ]);
      await verifier.assertReady();
      await seedJob(admin, added.schema, {
        jobId: 'added-welfare-running',
        state: 'running',
        welfareClaimed: true,
      });
      expect(await verifier.verify('added-welfare-running', 'added-follower-id')).toBe(true);
    } finally {
      await verifier?.close();
      await admin.end();
    }
  }, INTEGRATION_TIMEOUT_MS);
});
