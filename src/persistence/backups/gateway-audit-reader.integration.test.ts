import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PGVECTOR_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../postgres.js';
import { prepareFleetSharedSchemaRuntime } from './fleet-shared-schema-startup.js';
import { grantGatewayAuditReaderAccess } from '../postgres/gateway-audit-reader-access.js';

// Timeout-margin policy (see src/test-support/integration-timeout-registry.json):
// see the registered "measured" entry for this file.
const TIMEOUT_MS = 120_000;

const SHARED_OWNER_ROLE = 'audit_reader_shared_migration';
const COMPANION_ONE_ROLE = 'audit_reader_companion_one';
const COMPANION_TWO_ROLE = 'audit_reader_companion_two';
const READER_ROLE = 'audit_reader_declared';
const UNBOUNDED_READER_ROLE = 'audit_reader_unbounded';
const PASSWORDS: Record<string, string> = {
  [SHARED_OWNER_ROLE]: 'shared-migration-password',
  [COMPANION_ONE_ROLE]: 'companion-one-password',
  [COMPANION_TWO_ROLE]: 'companion-two-password',
  [READER_ROLE]: 'reader-password',
};
const AUDIT_TABLES = ['gateway_audit', 'model_usage_events'] as const;

let harness: PostgresTestHarness | null = null;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function roleUrl(databaseUrl: string, role: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = PASSWORDS[role] ?? `${role}-password`;
  return url.toString();
}

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: PGVECTOR_POSTGRES_TEST_IMAGE });
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    for (const role of [SHARED_OWNER_ROLE, COMPANION_ONE_ROLE, COMPANION_TWO_ROLE, READER_ROLE]) {
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT CONNECTION LIMIT 8 `
        + `PASSWORD '${PASSWORDS[role]}'`,
      );
    }
    // The shape the shakedown provisioned: read-only, but no connection limit.
    await admin.query(
      `CREATE ROLE ${quoteIdentifier(UNBOUNDED_READER_ROLE)} LOGIN NOINHERIT `
      + `PASSWORD '${UNBOUNDED_READER_ROLE}-password'`,
    );
  } finally {
    await admin.end();
  }
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, TIMEOUT_MS);

async function provisionFleet(options: { withAuditTables: boolean }) {
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
  for (const schema of ['companion_one', 'companion_two'] as const) {
    const owner = createPostgresPool(companionUrls[schema], { max: 1 });
    try {
      await owner.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await owner.query(`CREATE TABLE ${quoteIdentifier(schema)}.private_notes (id text PRIMARY KEY)`);
      if (options.withAuditTables && schema === 'companion_one') {
        await createAuditTables(companionUrls.companion_one);
      }
    } finally {
      await owner.end();
    }
  }
  return {
    databaseUrl: database.databaseUrl,
    companionUrls,
    readerUrl: roleUrl(database.databaseUrl, READER_ROLE),
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

async function createAuditTables(ownerUrl: string): Promise<void> {
  const owner = createPostgresPool(ownerUrl, { max: 1 });
  try {
    for (const table of AUDIT_TABLES) {
      await owner.query(
        `CREATE TABLE IF NOT EXISTS companion_one.${table} (id bigserial PRIMARY KEY, body text)`,
      );
      await owner.query(`INSERT INTO companion_one.${table} (body) VALUES ('row')`);
    }
  } finally {
    await owner.end();
  }
}

async function readerCan(readerUrl: string, sql: string): Promise<boolean> {
  const reader = createPostgresPool(readerUrl, { max: 1 });
  try {
    await reader.query(sql);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && /permission denied/.test(error.message)) return false;
    throw error;
  } finally {
    await reader.end();
  }
}

describe('declared gateway audit reader against real Postgres (jqg13)', () => {
  it('boots with a declared reader and grants exactly SELECT on the gateway audit tables', async () => {
    const fleet = await provisionFleet({ withAuditTables: false });
    const reader = { gatewayAuditReaderRole: READER_ROLE };
    // Fresh fleet: the audit tables do not exist yet at the startup ACL step.
    await expect(prepareFleetSharedSchemaRuntime({ ...fleet.startupOptions, ...reader }))
      .resolves.toBeDefined();
    // The post-readiness step refuses to report success while a table is missing.
    const grantInput = {
      ownerDatabaseUrl: fleet.companionUrls.companion_one,
      ownerRole: COMPANION_ONE_ROLE,
      schema: 'companion_one',
      role: READER_ROLE,
    };
    await expect(grantGatewayAuditReaderAccess(grantInput))
      .rejects.toThrow(/require every gateway audit table to exist/);

    await createAuditTables(fleet.companionUrls.companion_one);
    await grantGatewayAuditReaderAccess(grantInput);

    for (const table of AUDIT_TABLES) {
      expect(await readerCan(fleet.readerUrl, `SELECT count(*) FROM companion_one.${table}`)).toBe(true);
      expect(await readerCan(fleet.readerUrl, `INSERT INTO companion_one.${table} (body) VALUES ('x')`))
        .toBe(false);
    }
    expect(await readerCan(fleet.readerUrl, 'SELECT count(*) FROM companion_one.private_notes')).toBe(false);
    expect(await readerCan(fleet.readerUrl, 'SELECT count(*) FROM companion_two.private_notes')).toBe(false);

    // A restart with the reader already holding its grants is the case that
    // crash-looped; it now converges and stays idempotent.
    await expect(prepareFleetSharedSchemaRuntime({ ...fleet.startupOptions, ...reader }))
      .resolves.toBeDefined();
    await grantGatewayAuditReaderAccess(grantInput);
    expect(await readerCan(fleet.readerUrl, 'SELECT count(*) FROM companion_one.gateway_audit')).toBe(true);
  }, TIMEOUT_MS);

  it('still refuses the same reader when it is not declared', async () => {
    const fleet = await provisionFleet({ withAuditTables: true });
    const owner = createPostgresPool(fleet.companionUrls.companion_one, { max: 1 });
    try {
      await owner.query(`GRANT USAGE ON SCHEMA companion_one TO ${READER_ROLE}`);
      await owner.query(`GRANT SELECT ON companion_one.gateway_audit TO ${READER_ROLE}`);
    } finally {
      await owner.end();
    }
    await expect(prepareFleetSharedSchemaRuntime(fleet.startupOptions))
      .rejects.toThrow(new RegExp(`unexpected PostgreSQL grantees: ${READER_ROLE}`));
  }, TIMEOUT_MS);

  it('refuses a declared reader holding grants on another companion schema', async () => {
    const fleet = await provisionFleet({ withAuditTables: true });
    const owner = createPostgresPool(fleet.companionUrls.companion_two, { max: 1 });
    try {
      await owner.query(`GRANT USAGE ON SCHEMA companion_two TO ${READER_ROLE}`);
      await owner.query(`GRANT SELECT ON companion_two.private_notes TO ${READER_ROLE}`);
    } finally {
      await owner.end();
    }
    await expect(prepareFleetSharedSchemaRuntime({
      ...fleet.startupOptions,
      gatewayAuditReaderRole: READER_ROLE,
    })).rejects.toThrow(new RegExp(`unexpected PostgreSQL grantees: ${READER_ROLE}`));
  }, TIMEOUT_MS);

  it('refuses a declared reader without least-privilege posture or reusing an authority role', async () => {
    const fleet = await provisionFleet({ withAuditTables: true });
    await expect(prepareFleetSharedSchemaRuntime({
      ...fleet.startupOptions,
      gatewayAuditReaderRole: UNBOUNDED_READER_ROLE,
    })).rejects.toThrow(new RegExp(`${UNBOUNDED_READER_ROLE} must be NOINHERIT.*finite CONNECTION LIMIT`));
    await expect(prepareFleetSharedSchemaRuntime({
      ...fleet.startupOptions,
      gatewayAuditReaderRole: COMPANION_TWO_ROLE,
    })).rejects.toThrow(/distinct/);
  }, TIMEOUT_MS);
});
