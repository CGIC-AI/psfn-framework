// psfn-framework-aqp2u — real-Postgres proof that the canonical fleet
// operator path provisions a DEDICATED gateway welfare-verifier LOGIN role and
// grants it exact USAGE/SELECT across fleet schemas, while preserving strict
// companion runtime sibling isolation (the runtime login holds no
// cross-schema grant).
//
// Root cause this pins: the verifier previously connected unpinned as the
// companion runtime login role, and the runtime login is NOINHERIT, so the
// membership provisioning grants carry inherit_option=false — the login holds
// no privilege through it and the readiness probe
// (`assertPostgresRelationColumns`, SELECT) failed closed, degrading
// `welfare_grant_verifier` at gateway startup. The original repair applied a
// direct USAGE/SELECT grant to the runtime login. That grant breaches fleet
// sibling isolation: the same companion runtime credential reaches the agent
// pods, so a cross-schema grant on it lets one companion's agent read another
// companion's background-work rows. The correct repair is a DEDICATED
// least-privilege LOGIN role used ONLY by the gateway verifier, provisioned
// and granted by `provision:postgres-tenancy` after tenant migrations.

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
import {
  grantWelfareVerifierReadAccessToTenantSchema,
  provisionWelfareVerifierLoginRole,
} from './welfare-verifier-access.js';
import {
  createWelfareGrantVerifierForPool,
  type WelfareGrantVerifier,
} from '../../boundary/gateway/welfare-grant-verifier.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const LOGIN_PASSWORD = 'runtime-login-test';
const VERIFIER_PASSWORD = 'welfare-verifier-test';

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

/**
 * PostgreSQL roles are cluster-wide, so each test derives a unique verifier
 * role name from its fresh database name (mirrors the runtime-login helper).
 */
function verifierRoleFor(databaseName: string): string {
  return `wlverify_${databaseName}`.replaceAll('-', '_').slice(0, 63);
}

/**
 * A NOINHERIT runtime login role per companion, exactly how the fleet runtime
 * roles are shaped. Each is granted membership in ITS OWN tenant role only —
 * that membership is the sibling-isolation boundary the dedicated verifier
 * grant must not widen.
 */
async function createCompanionRuntimeLogin(admin: Pool, name: string): Promise<string> {
  const login = name;
  await admin.query(`DROP ROLE IF EXISTS "${login}"`);
  await admin.query(`CREATE ROLE "${login}" LOGIN NOINHERIT PASSWORD '${LOGIN_PASSWORD}'`);
  return login;
}

function loginDatabaseUrl(databaseUrl: string, login: string, password: string): string {
  const url = new URL(databaseUrl);
  url.username = login;
  url.password = password;
  return url.toString();
}

function createVerifier(
  databaseUrl: string,
  verifierRole: string,
  fleet: ReadonlyArray<{ companionId: string; postgresSchema: string }>,
): WelfareGrantVerifier {
  const pool = createPostgresPool(
    loginDatabaseUrl(databaseUrl, verifierRole, VERIFIER_PASSWORD),
    {
      applicationName: 'psfn-welfare-verify-access-test',
      allowExitOnIdle: true,
      max: 2,
    },
  );
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

/** Direct (non-inherited) privileges held by one role on the verifier table. */
async function directTablePrivileges(
  admin: Pool,
  schema: string,
  role: string,
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
  `, [schema, role]);
  return result.rows.map(row => row.privilege_type);
}

async function roleAttributes(admin: Pool, role: string): Promise<{
  login: boolean;
  inherit: boolean;
  superuser: boolean;
  createdb: boolean;
  createrole: boolean;
  replication: boolean;
  bypassrls: boolean;
  connlimit: number;
}> {
  const row = await admin.query<{
    rolcanlogin: boolean;
    rolinherit: boolean;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
    rolconnlimit: number;
  }>(`
    SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
           rolreplication, rolbypassrls, rolconnlimit
    FROM pg_roles WHERE rolname = $1
  `, [role]);
  const r = row.rows.at(0);
  if (!r) throw new Error(`role ${role} not found`);
  return {
    login: r.rolcanlogin,
    inherit: r.rolinherit,
    superuser: r.rolsuper,
    createdb: r.rolcreatedb,
    createrole: r.rolcreaterole,
    replication: r.rolreplication,
    bypassrls: r.rolbypassrls,
    connlimit: r.rolconnlimit,
  };
}

describe('dedicated welfare verifier authority (aqp2u, real Postgres)', () => {
  it('provisions a dedicated LOGIN role with exact grants and preserves companion isolation', async () => {
    const { databaseUrl, databaseName } = await freshDatabase();
    const verifierRole = verifierRoleFor(databaseName);
    const admin = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-welfare-access-admin',
      max: 2,
    });
    const primary = planPostgresTenantAccess({ schema: PRIMARY_SCHEMA });
    const follower = planPostgresTenantAccess({ schema: FOLLOWER_SCHEMA });
    const primaryLogin = `${PRIMARY_SCHEMA}_login`;
    const followerLogin = `${FOLLOWER_SCHEMA}_login`;
    let verifier: WelfareGrantVerifier | undefined;
    try {
      await createCompanionRuntimeLogin(admin, primaryLogin);
      await createCompanionRuntimeLogin(admin, followerLogin);
      // Canonical provisioning: each companion runtime login is granted
      // membership in ITS OWN tenant role only.
      await provisionPostgresTenantAccess(admin, { plan: primary, runtimeLoginRole: primaryLogin });
      await provisionPostgresTenantAccess(admin, { plan: follower, runtimeLoginRole: followerLogin });
      await migrateBackgroundWork(databaseUrl, primary);
      await migrateBackgroundWork(databaseUrl, follower);

      // The dedicated verifier LOGIN role does not exist yet → idempotent
      // provisioning creates it. Re-running converges the same posture.
      const first = await provisionWelfareVerifierLoginRole(admin, {
        role: verifierRole,
        password: VERIFIER_PASSWORD,
        connectionLimit: 8,
      });
      expect(first.created).toBe(true);
      const again = await provisionWelfareVerifierLoginRole(admin, {
        role: verifierRole,
        password: VERIFIER_PASSWORD,
        connectionLimit: 8,
      });
      expect(again.created).toBe(false);

      // Exact least-privilege posture.
      const attrs = await roleAttributes(admin, verifierRole);
      expect(attrs).toMatchObject({
        login: true,
        inherit: false,
        superuser: false,
        createdb: false,
        createrole: false,
        replication: false,
        bypassrls: false,
      });
      expect(attrs.connlimit).toBeGreaterThanOrEqual(1);

      // Before the grant, the verifier role has no table privilege → startup
      // readiness fails closed (degraded), exactly as the regression pin.
      verifier = createVerifier(databaseUrl, verifierRole, [
        { companionId: PRIMARY_COMPANION, postgresSchema: PRIMARY_SCHEMA },
        { companionId: FOLLOWER_COMPANION, postgresSchema: FOLLOWER_SCHEMA },
      ]);
      await expect(verifier.assertReady())
        .rejects.toThrow(/missing required role privileges: SELECT/u);
      await verifier.close();

      // Operator grant step lands USAGE + SELECT on the dedicated role for both
      // fleet schemas, idempotently.
      for (const plan of [primary, follower]) {
        const evidence = await grantWelfareVerifierReadAccessToTenantSchema(admin, {
          schema: plan.schema,
          verifierRole,
        });
        expect(evidence.relationGranted).toBe(true);
      }

      verifier = createVerifier(databaseUrl, verifierRole, [
        { companionId: PRIMARY_COMPANION, postgresSchema: PRIMARY_SCHEMA },
        { companionId: FOLLOWER_COMPANION, postgresSchema: FOLLOWER_SCHEMA },
      ]);
      await verifier.assertReady();

      // End-to-end: a genuine welfare-claimed running job verifies; foils strip;
      // cross-companion foil strips (the verifier scopes per-companion).
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

      // The dedicated verifier role holds exactly SELECT on the verifier table
      // in both schemas and USAGE without CREATE on each schema.
      for (const schema of [PRIMARY_SCHEMA, FOLLOWER_SCHEMA]) {
        expect(await directTablePrivileges(admin, schema, verifierRole)).toEqual(['SELECT']);
      }
      for (const schema of [PRIMARY_SCHEMA, FOLLOWER_SCHEMA]) {
        const schemaPrivileges = await admin.query<{ usage: boolean; create: boolean }>(`
          SELECT
            has_schema_privilege($2, $1, 'USAGE') AS usage,
            has_schema_privilege($2, $1, 'CREATE') AS create
        `, [schema, verifierRole]);
        expect(schemaPrivileges.rows.at(0)).toMatchObject({ usage: true, create: false });
      }

      // SIBLING ISOLATION: neither companion runtime login holds ANY direct
      // privilege on the OTHER companion's verifier table, nor on its own
      // (the runtime role gets none — it reaches its own schema through tenant
      // membership + SET ROLE, never through a direct verifier grant).
      expect(await directTablePrivileges(admin, FOLLOWER_SCHEMA, primaryLogin)).toEqual([]);
      expect(await directTablePrivileges(admin, PRIMARY_SCHEMA, followerLogin)).toEqual([]);
      expect(await directTablePrivileges(admin, PRIMARY_SCHEMA, primaryLogin)).toEqual([]);
      expect(await directTablePrivileges(admin, FOLLOWER_SCHEMA, followerLogin)).toEqual([]);
    } finally {
      await verifier?.close();
      await admin.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('grant is idempotent and covers a newly added follower after its migrations', async () => {
    const { databaseUrl, databaseName } = await freshDatabase();
    const verifierRole = verifierRoleFor(databaseName);
    const admin = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-welfare-access-added',
      max: 2,
    });
    const added = planPostgresTenantAccess({ schema: 'added_follower' });
    const addedLogin = 'added_follower_login';
    let verifier: WelfareGrantVerifier | undefined;
    try {
      await createCompanionRuntimeLogin(admin, addedLogin);
      await provisionWelfareVerifierLoginRole(admin, {
        role: verifierRole,
        password: VERIFIER_PASSWORD,
        connectionLimit: 8,
      });
      await provisionPostgresTenantAccess(admin, { plan: added, runtimeLoginRole: addedLogin });

      // Pre-migration operator grant passes are safe no-ops beyond schema
      // USAGE.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const evidence = await grantWelfareVerifierReadAccessToTenantSchema(admin, {
          schema: added.schema,
          verifierRole,
        });
        expect(evidence.relationGranted).toBe(false);
      }

      await migrateBackgroundWork(databaseUrl, added);
      verifier = createVerifier(databaseUrl, verifierRole, [
        { companionId: 'added-follower-id', postgresSchema: added.schema },
      ]);
      await expect(verifier.assertReady())
        .rejects.toThrow(/missing required role privileges: SELECT/u);
      await verifier.close();

      // The operator grant lands the table privilege exactly once, however
      // many times it runs.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const evidence = await grantWelfareVerifierReadAccessToTenantSchema(admin, {
          schema: added.schema,
          verifierRole,
        });
        expect(evidence).toMatchObject({
          schema: added.schema,
          verifierRole,
          relationGranted: true,
        });
      }
      expect(await directTablePrivileges(admin, added.schema, verifierRole)).toEqual(['SELECT']);
      // The added follower's own runtime login gets no direct verifier grant.
      expect(await directTablePrivileges(admin, added.schema, addedLogin)).toEqual([]);

      verifier = createVerifier(databaseUrl, verifierRole, [
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
