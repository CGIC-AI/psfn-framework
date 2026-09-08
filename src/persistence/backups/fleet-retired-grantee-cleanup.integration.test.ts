import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PGVECTOR_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../postgres.js';
import { RETIRED_FLEET_WELFARE_VERIFIER_ROLE } from '../postgres/retired-fleet-grantees.js';
import { prepareFleetSharedSchemaRuntime } from './fleet-shared-schema-startup.js';

// Timeout-margin policy (see src/test-support/integration-timeout-registry.json):
// see the registered "measured" entry for this file.
const TIMEOUT_MS = 120_000;

const SHARED_OWNER_ROLE = 'retired_grantee_shared_migration';
const COMPANION_ONE_ROLE = 'retired_grantee_companion_one';
const COMPANION_TWO_ROLE = 'retired_grantee_companion_two';
const STRAY_ROLE = 'retired_grantee_stray_reader';
const PASSWORDS = {
  retired_grantee_shared_migration: 'shared-migration-password',
  retired_grantee_companion_one: 'companion-one-password',
  retired_grantee_companion_two: 'companion-two-password',
} as const;
const COMPANION_SCHEMAS = ['companion_one', 'companion_two'] as const;
// The relation the retired fleet-wide reader was granted SELECT on.
const LEGACY_GRANTED_RELATION = 'agent_background_work_jobs';

let harness: PostgresTestHarness | null = null;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function roleUrl(databaseUrl: string, role: keyof typeof PASSWORDS): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = PASSWORDS[role];
  return url.toString();
}

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: PGVECTOR_POSTGRES_TEST_IMAGE });
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    for (const [role, password] of Object.entries(PASSWORDS)) {
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT CONNECTION LIMIT 8 `
        + `PASSWORD '${password}'`,
      );
    }
    // The retired fleet welfare verifier exactly as the deleted provisioning
    // path created it, plus a stray reader that must never be tolerated.
    for (const role of [RETIRED_FLEET_WELFARE_VERIFIER_ROLE, STRAY_ROLE]) {
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB `
        + 'NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 '
        + `PASSWORD '${role}-password'`,
      );
    }
  } finally {
    await admin.end();
  }
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, TIMEOUT_MS);

async function provisionLegacyFleet() {
  if (!harness) throw new Error('Postgres harness unavailable');
  const database = await harness.createDatabase();
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    await admin.query(
      `GRANT CREATE, CONNECT ON DATABASE ${quoteIdentifier(database.databaseName)} TO `
      + `${quoteIdentifier(SHARED_OWNER_ROLE)}, ${quoteIdentifier(COMPANION_ONE_ROLE)}, `
      + `${quoteIdentifier(COMPANION_TWO_ROLE)}`,
    );
  } finally {
    await admin.end();
  }
  const databaseAdmin = createPostgresPool(database.databaseUrl, { max: 1 });
  try {
    await databaseAdmin.query('CREATE EXTENSION vector WITH SCHEMA extensions');
    await databaseAdmin.query(
      'GRANT USAGE ON SCHEMA extensions TO '
      + `${quoteIdentifier(SHARED_OWNER_ROLE)}, ${quoteIdentifier(COMPANION_ONE_ROLE)}, `
      + `${quoteIdentifier(COMPANION_TWO_ROLE)}`,
    );
  } finally {
    await databaseAdmin.end();
  }
  const companionUrls = {
    companion_one: roleUrl(database.databaseUrl, COMPANION_ONE_ROLE),
    companion_two: roleUrl(database.databaseUrl, COMPANION_TWO_ROLE),
  } as const;
  // Each companion owns its schema and its background-work relation, exactly as
  // a fleet provisioned before the retirement did.
  for (const schema of COMPANION_SCHEMAS) {
    const owner = createPostgresPool(companionUrls[schema], { max: 1 });
    try {
      await owner.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await owner.query(
        `CREATE TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(LEGACY_GRANTED_RELATION)} `
        + '(job_id text PRIMARY KEY)',
      );
    } finally {
      await owner.end();
    }
  }
  return {
    databaseUrl: database.databaseUrl,
    sharedOwnerUrl: roleUrl(database.databaseUrl, SHARED_OWNER_ROLE),
    companionUrls,
    startupOptions: {
      sharedMigrationDatabaseUrl: roleUrl(database.databaseUrl, SHARED_OWNER_ROLE),
      sharedMigrationRole: SHARED_OWNER_ROLE,
      companionDatabases: [
        { databaseUrl: companionUrls.companion_one, role: COMPANION_ONE_ROLE, schema: 'companion_one' },
        { databaseUrl: companionUrls.companion_two, role: COMPANION_TWO_ROLE, schema: 'companion_two' },
      ],
      sharedSchema: 'shared',
    },
  };
}

/**
 * Apply the exact cross-schema read contract the retired provisioning path
 * applied. The admin is a superuser, so PostgreSQL records the grantor as the
 * schema owner — the same ACL shape a real fleet carries, and the reason the
 * owner's REVOKE at startup can remove it.
 */
async function applyLegacyVerifierGrants(databaseUrl: string, role: string): Promise<void> {
  const admin = createPostgresPool(databaseUrl, { max: 1 });
  try {
    for (const schema of COMPANION_SCHEMAS) {
      await admin.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(role)}`);
      await admin.query(
        `GRANT SELECT ON ${quoteIdentifier(schema)}.${quoteIdentifier(LEGACY_GRANTED_RELATION)} `
        + `TO ${quoteIdentifier(role)}`,
      );
    }
  } finally {
    await admin.end();
  }
}

async function countSchemaGrants(databaseUrl: string, role: string): Promise<number> {
  const admin = createPostgresPool(databaseUrl, { max: 1 });
  try {
    const result = await admin.query<{ grant_count: number }>(`
      WITH acl_grantees AS (
        SELECT acl.grantee
        FROM pg_namespace AS namespace
        CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS acl
        WHERE namespace.nspname = ANY($1::text[])
        UNION ALL
        SELECT acl.grantee
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL aclexplode(relation.relacl) AS acl
        WHERE namespace.nspname = ANY($1::text[])
        UNION ALL
        SELECT acl.grantee
        FROM pg_proc AS routine
        JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
        CROSS JOIN LATERAL aclexplode(routine.proacl) AS acl
        WHERE namespace.nspname = ANY($1::text[])
      )
      SELECT COUNT(*)::integer AS grant_count
      FROM acl_grantees
      WHERE grantee <> 0 AND pg_get_userbyid(grantee) = $2
    `, [[...COMPANION_SCHEMAS], role]);
    return result.rows.at(0)?.grant_count ?? 0;
  } finally {
    await admin.end();
  }
}

describe('retired fleet grantee cleanup against real Postgres', () => {
  it('revokes the retired welfare verifier at startup and still refuses a stray grantee', async () => {
    const fleet = await provisionLegacyFleet();
    await applyLegacyVerifierGrants(fleet.databaseUrl, RETIRED_FLEET_WELFARE_VERIFIER_ROLE);
    // The upgrade starts from the state that crash-looped: the retired role
    // holds standing privileges on every already-provisioned companion schema.
    expect(await countSchemaGrants(fleet.databaseUrl, RETIRED_FLEET_WELFARE_VERIFIER_ROLE))
      .toBeGreaterThan(0);

    // Startup converges instead of refusing...
    await expect(prepareFleetSharedSchemaRuntime(fleet.startupOptions)).resolves.toBeDefined();
    // ...and readiness is not the proof: the privileges themselves are gone.
    expect(await countSchemaGrants(fleet.databaseUrl, RETIRED_FLEET_WELFARE_VERIFIER_ROLE))
      .toBe(0);

    // Idempotent: a second boot over the cleaned fleet is quiet and still ready.
    await expect(prepareFleetSharedSchemaRuntime(fleet.startupOptions)).resolves.toBeDefined();
    expect(await countSchemaGrants(fleet.databaseUrl, RETIRED_FLEET_WELFARE_VERIFIER_ROLE))
      .toBe(0);

    // Tolerance is exactly one closed allowlist entry, not "unexpected grantees
    // are fine": any other grantee still fails the boot closed.
    await applyLegacyVerifierGrants(fleet.databaseUrl, STRAY_ROLE);
    await expect(prepareFleetSharedSchemaRuntime(fleet.startupOptions))
      .rejects.toThrow(new RegExp(`unexpected PostgreSQL grantees: ${STRAY_ROLE}`));
    expect(await countSchemaGrants(fleet.databaseUrl, STRAY_ROLE)).toBeGreaterThan(0);
  }, TIMEOUT_MS);
});
