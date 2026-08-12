import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PGVECTOR_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresPool, ensurePostgresSchema } from '../postgres.js';
import { PostgresCompanionPresenceStore } from '../postgres/companion-presence-store.js';
import { assertSharedSchemaRuntimeAuthority } from '../postgres/shared-schema.js';
import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import { createSharedWikiPgvectorProjectionStore } from '../../faculties/wiki/shared-pgvector-projection.js';
import { FleetAuthAuthorityFloorStore } from '../postgres/fleet-auth/authority-floor.js';
import { reconcileFleetAuthAuthorityState } from '../postgres/fleet-auth/gateway-persistence.js';
import {
  FLEET_AUTH_SCHEMA_NAME,
  migrateFleetAuthSchema,
  type FleetAuthFamilyDatabaseRoles,
} from '../postgres/fleet-auth/schema.js';
import {
  runFleetAuthConsistentBackup as runFleetAuthConsistentBackupProduction,
} from './fleet-auth-coordinator.js';
import {
  restoreFleetAuthConsistentFamily as restoreFleetAuthConsistentFamilyProduction,
  verifyFleetAuthConsistentFamilyRestore as verifyFleetAuthConsistentFamilyRestoreProduction,
} from './fleet-restore.js';
import { runFleetBackupCycle as runFleetBackupCycleProduction } from './service.js';
import { prepareFleetSharedSchemaRuntime } from './fleet-shared-schema-startup.js';
import { PhaseTimer } from '../../test-support/phase-timer.js';
import { describeStartupOwnerFileChecks } from '../../system/config/startup-owner-files.js';
import { grantWelfareVerifierReadAccessToTenantSchema } from '../postgres/welfare-verifier-access.js';

// Timeout-margin policy (see src/test-support/integration-timeout-registry.json):
// measured worst-case baseline is the documented clean-main file runtime of 108.5s
// (local 3-run it3 max 81.8s, file max 92.9s). 2x headroom => >=217s; set to 240s
// (2.21x). Registered as a "measured" entry and enforced by integration-timeout-policy.
const TIMEOUT_MS = 240_000;
const ROLES: FleetAuthFamilyDatabaseRoles = {
  runtime: 'family_auth_runtime',
  migration: 'family_auth_migration',
  backupRestore: 'family_auth_backup',
  sharedMigration: 'family_shared_migration',
};
const COMPANION_ROLE = 'family_companion_runtime';
const COMPANION_ROLE_TWO = 'family_companion_two';
const SHARED_OWNER_ROLE = 'family_shared_migration';
const OVERPRIVILEGED_SHARED_ROLE = 'family_shared_overpriv';
const WELFARE_VERIFIER_ROLE = 'family_welfare_verifier';
const WELFARE_VERIFIER_ROLE_TWO = 'family_welfare_verifier_two';
const PASSWORDS = {
  family_auth_runtime: 'runtime-password',
  family_auth_migration: 'migration-password',
  family_auth_backup: 'backup-password',
  family_companion_runtime: 'companion-password',
  family_companion_two: 'companion-two-password',
  family_shared_migration: 'shared-migration-password',
  family_shared_overpriv: 'overprivileged-password',
  family_welfare_verifier: 'welfare-verifier-password',
  family_welfare_verifier_two: 'welfare-verifier-two-password',
} as const;

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

function requirePostgresClients() {
  if (!harness) throw new Error('Postgres integration harness is not available');
  return harness.clientBinaries;
}

function runFleetAuthConsistentBackup(
  options: Parameters<typeof runFleetAuthConsistentBackupProduction>[0],
) {
  const clients = requirePostgresClients();
  return runFleetAuthConsistentBackupProduction({
    ...options,
    pgDumpBinary: clients.pgDumpBinary,
  });
}

function runFleetBackupCycle(
  options: Parameters<typeof runFleetBackupCycleProduction>[0],
) {
  const clients = requirePostgresClients();
  return runFleetBackupCycleProduction({
    ...options,
    postgres: { ...options.postgres, pgDumpBinary: clients.pgDumpBinary },
  });
}

function restoreFleetAuthConsistentFamily(
  options: Parameters<typeof restoreFleetAuthConsistentFamilyProduction>[0],
) {
  const clients = requirePostgresClients();
  return restoreFleetAuthConsistentFamilyProduction({
    ...options,
    pgRestoreBinary: clients.pgRestoreBinary,
    psqlBinary: clients.psqlBinary,
  });
}

function verifyFleetAuthConsistentFamilyRestore(
  options: Parameters<typeof verifyFleetAuthConsistentFamilyRestoreProduction>[0],
) {
  const clients = requirePostgresClients();
  return verifyFleetAuthConsistentFamilyRestoreProduction({
    ...options,
    pgRestoreBinary: clients.pgRestoreBinary,
    psqlBinary: clients.psqlBinary,
  });
}

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: PGVECTOR_POSTGRES_TEST_IMAGE });
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    for (const role of [
      ...Object.values(ROLES), COMPANION_ROLE, COMPANION_ROLE_TWO,
      OVERPRIVILEGED_SHARED_ROLE, WELFARE_VERIFIER_ROLE, WELFARE_VERIFIER_ROLE_TWO,
    ]) {
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT CONNECTION LIMIT 8 `
        + `PASSWORD '${PASSWORDS[role as keyof typeof PASSWORDS]}'`,
      );
    }
    await admin.query(`ALTER ROLE ${quoteIdentifier(OVERPRIVILEGED_SHARED_ROLE)} SUPERUSER`);
  } finally {
    await admin.end();
  }
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, TIMEOUT_MS);

async function freshDatabase() {
  if (!harness) throw new Error('Postgres harness unavailable');
  const database = await harness.createDatabase();
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    await admin.query(
      `GRANT CREATE, CONNECT ON DATABASE ${quoteIdentifier(database.databaseName)} TO `
      + `${quoteIdentifier(ROLES.migration)}, ${quoteIdentifier(ROLES.backupRestore)}, `
      + `${quoteIdentifier(COMPANION_ROLE)}, ${quoteIdentifier(COMPANION_ROLE_TWO)}, `
      + `${quoteIdentifier(SHARED_OWNER_ROLE)}`,
    );
  } finally {
    await admin.end();
  }
  const databaseAdmin = createPostgresPool(database.databaseUrl, { max: 1 });
  try {
    await databaseAdmin.query('CREATE EXTENSION vector WITH SCHEMA extensions');
    // Mirror operator-provisioned extension access: the shared-migration owner
    // needs USAGE on the extensions schema to reference the vector type when it
    // runs the wiki DDL, and the companion runtime roles need it for DML against
    // vector columns. The migration authority only proves the extension exists;
    // it never grants schema usage.
    await databaseAdmin.query(
      'GRANT USAGE ON SCHEMA extensions TO '
      + `${quoteIdentifier(ROLES.migration)}, ${quoteIdentifier(ROLES.runtime)}, `
      + `${quoteIdentifier(ROLES.backupRestore)}, ${quoteIdentifier(COMPANION_ROLE)}, `
      + `${quoteIdentifier(COMPANION_ROLE_TWO)}, ${quoteIdentifier(SHARED_OWNER_ROLE)}`,
    );
  } finally {
    await databaseAdmin.end();
  }
  return {
    migrationUrl: roleUrl(database.databaseUrl, ROLES.migration),
    runtimeUrl: roleUrl(database.databaseUrl, ROLES.runtime),
    backupUrl: roleUrl(database.databaseUrl, ROLES.backupRestore),
    companionUrl: roleUrl(database.databaseUrl, COMPANION_ROLE),
    companionTwoUrl: roleUrl(database.databaseUrl, COMPANION_ROLE_TWO),
    sharedOwnerUrl: roleUrl(database.databaseUrl, SHARED_OWNER_ROLE),
    welfareVerifierUrl: roleUrl(database.databaseUrl, WELFARE_VERIFIER_ROLE),
    welfareVerifierTwoUrl: roleUrl(database.databaseUrl, WELFARE_VERIFIER_ROLE_TWO),
  };
}

function writeFleetAuthTestConfig(systemDataDir: string): void {
  const seed = JSON.parse(readFileSync(
    join(process.cwd(), 'config', 'fleet-auth.seed.json'),
    'utf8',
  )) as {
    verifierKeys: Array<{ kid: string; publicKeyPem: string }>;
    hubDeviceAssertions: { keys: Array<{ kid: string; publicKeyPem: string }> };
  };
  const publicKeyPem = (): string => generateKeyPairSync('ed25519').publicKey.export({
    type: 'spki',
    format: 'pem',
  }).toString();
  seed.verifierKeys[0]!.kid = 'family-restore-test-verifier';
  seed.verifierKeys[0]!.publicKeyPem = publicKeyPem();
  seed.hubDeviceAssertions.keys[0]!.kid = 'family-restore-test-hub';
  seed.hubDeviceAssertions.keys[0]!.publicKeyPem = publicKeyPem();
  writeFileSync(
    join(systemDataDir, 'fleet-auth.json'),
    `${JSON.stringify(seed, null, 2)}\n`,
    'utf8',
  );
}

function writeMandatorySystemOwnerFiles(systemDataDir: string): void {
  writeFileSync(join(systemDataDir, 'companions.json'), `${JSON.stringify({
    postgres: {
      sharedMigrationRole: SHARED_OWNER_ROLE,
      sharedMigrationDatabaseUrlRef: {
        kind: 'env',
        envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL',
      },
    },
    companions: [
      {
        companionId: '11111111-1111-4111-8111-111111111111',
        companionDataDir: 'companion-data/companion-one',
        characterCardPath: 'companion-data/companion-one/character-card.json',
        postgresSchema: 'companion_one',
        postgresRole: COMPANION_ROLE,
        postgresDatabaseUrlRef: {
          kind: 'env',
          envName: 'COMPANION_ONE_DATABASE_URL',
        },
      },
      {
        companionId: '22222222-2222-4222-8222-222222222222',
        companionDataDir: 'companion-data/companion-two',
        characterCardPath: 'companion-data/companion-two/character-card.json',
        postgresSchema: 'companion_two',
        postgresRole: COMPANION_ROLE_TWO,
        postgresDatabaseUrlRef: {
          kind: 'env',
          envName: 'COMPANION_TWO_DATABASE_URL',
        },
      },
    ],
  }, null, 2)}\n`);
  for (const descriptor of describeStartupOwnerFileChecks()) {
    if (descriptor.scope !== 'system'
      || descriptor.optionalWhenMissing
      || existsSync(join(systemDataDir, descriptor.ownerFileName))) {
      continue;
    }
    writeFileSync(
      join(systemDataDir, descriptor.ownerFileName),
      readFileSync(join(process.cwd(), 'config', descriptor.seedFileName)),
    );
  }
}

async function freshRestoreVerifyDatabase() {
  if (!harness) throw new Error('Postgres harness unavailable');
  const databaseName = `psfn_${randomUUID().replaceAll('-', '')}_restore_verify`;
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await admin.query(
      `GRANT CREATE, CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO `
      + `${quoteIdentifier(ROLES.migration)}, ${quoteIdentifier(ROLES.backupRestore)}, `
      + `${quoteIdentifier(COMPANION_ROLE)}, ${quoteIdentifier(COMPANION_ROLE_TWO)}, `
      + `${quoteIdentifier(SHARED_OWNER_ROLE)}`,
    );
  } finally {
    await admin.end();
  }
  const databaseUrl = new URL(harness.adminDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const databaseAdmin = createPostgresPool(databaseUrl.toString(), { max: 1 });
  try {
    await databaseAdmin.query('CREATE SCHEMA extensions');
    await databaseAdmin.query('CREATE EXTENSION vector WITH SCHEMA extensions');
    // Operator-provisioned extension access, mirrored into the scratch restore
    // verification database: the schema-owner role restoring the shared dump
    // (and runtime roles afterwards) must have USAGE on the extensions schema to
    // reference the vector type in the restored wiki projection table.
    await databaseAdmin.query(
      'GRANT USAGE ON SCHEMA extensions TO '
      + `${quoteIdentifier(ROLES.migration)}, ${quoteIdentifier(ROLES.runtime)}, `
      + `${quoteIdentifier(ROLES.backupRestore)}, ${quoteIdentifier(COMPANION_ROLE)}, `
      + `${quoteIdentifier(COMPANION_ROLE_TWO)}, ${quoteIdentifier(SHARED_OWNER_ROLE)}`,
    );
  } finally {
    await databaseAdmin.end();
  }
  return {
    migrationUrl: roleUrl(databaseUrl.toString(), ROLES.migration),
    runtimeUrl: roleUrl(databaseUrl.toString(), ROLES.runtime),
    backupUrl: roleUrl(databaseUrl.toString(), ROLES.backupRestore),
    companionUrl: roleUrl(databaseUrl.toString(), COMPANION_ROLE),
    companionTwoUrl: roleUrl(databaseUrl.toString(), COMPANION_ROLE_TWO),
    sharedOwnerUrl: roleUrl(databaseUrl.toString(), SHARED_OWNER_ROLE),
    welfareVerifierUrl: roleUrl(databaseUrl.toString(), WELFARE_VERIFIER_ROLE),
  };
}

function sharedStartupOptions(
  database: Awaited<ReturnType<typeof freshDatabase>>,
  overrides: {
    sharedMigrationDatabaseUrl?: string;
    sharedMigrationRole?: string;
    welfareVerifier?: {
      databaseUrl: string;
      role: string;
    };
  } = {},
) {
  return {
    sharedMigrationDatabaseUrl:
      overrides.sharedMigrationDatabaseUrl ?? database.sharedOwnerUrl,
    sharedMigrationRole: overrides.sharedMigrationRole ?? SHARED_OWNER_ROLE,
    companionDatabases: [
      { databaseUrl: database.companionUrl, role: COMPANION_ROLE, schema: 'companion_one' },
      { databaseUrl: database.companionTwoUrl, role: COMPANION_ROLE_TWO, schema: 'companion_two' },
    ],
    sharedSchema: 'shared',
    fleetAuth: {
      backupRestoreDatabaseUrl: database.backupUrl,
      roles: {
        runtime: ROLES.runtime,
        migration: ROLES.migration,
        backupRestore: ROLES.backupRestore,
      },
      ...(overrides.welfareVerifier
        ? { welfareVerifier: overrides.welfareVerifier }
        : {}),
    },
  };
}

async function waitForRestoreAdvisoryLockWaiter(databaseUrl: string): Promise<void> {
  if (!harness) throw new Error('Postgres harness unavailable');
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const result = await admin.query<{ waiter_count: number }>(`
        SELECT COUNT(*)::integer AS waiter_count
        FROM pg_stat_activity
        WHERE datname = $1
          AND application_name = 'fleet-restore-family-lock'
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
      `, [databaseName]);
      if ((result.rows.at(0)?.waiter_count ?? 0) > 0) return;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
    }
    throw new Error('Concurrent fleet restore never waited on the family advisory lock');
  } finally {
    await admin.end();
  }
}

describe('fleet-auth consistent family restore against real Postgres', () => {
  it('reconciles only the exact owner-declared welfare verifier schema access', async () => {
    const database = await freshDatabase();
    const companionOne = createPostgresPool(database.companionUrl, { max: 1 });
    const companionTwo = createPostgresPool(database.companionTwoUrl, { max: 1 });
    try {
      await companionOne.query(`
        CREATE SCHEMA companion_one;
        CREATE TABLE companion_one.agent_background_work_jobs (job_id text PRIMARY KEY);
        CREATE TABLE companion_one.verifier_forbidden_table (id integer PRIMARY KEY);
      `);
      await companionTwo.query(`
        CREATE SCHEMA companion_two;
        CREATE TABLE companion_two.agent_background_work_jobs (job_id text PRIMARY KEY);
      `);
    } finally {
      await companionOne.end();
      await companionTwo.end();
    }
    const ownerOne = createPostgresPool(database.companionUrl, { max: 1 });
    const ownerTwo = createPostgresPool(database.companionTwoUrl, { max: 1 });
    const welfareVerifier = {
      databaseUrl: database.welfareVerifierUrl,
      role: WELFARE_VERIFIER_ROLE,
    };
    try {
      await grantWelfareVerifierReadAccessToTenantSchema(ownerOne, {
        schema: 'companion_one',
        verifierRole: WELFARE_VERIFIER_ROLE,
      });
      await grantWelfareVerifierReadAccessToTenantSchema(ownerTwo, {
        schema: 'companion_two',
        verifierRole: WELFARE_VERIFIER_ROLE,
      });

      await expect(prepareFleetSharedSchemaRuntime(sharedStartupOptions(database, {
        welfareVerifier,
      }))).resolves.toHaveLength(3);

      await ownerOne.query(
        `GRANT CREATE ON SCHEMA companion_one TO ${quoteIdentifier(WELFARE_VERIFIER_ROLE)}`,
      );
      await expect(prepareFleetSharedSchemaRuntime(sharedStartupOptions(database, {
        welfareVerifier,
      }))).rejects.toThrow(/welfare verifier schema access mismatch/i);
      await ownerOne.query(
        `REVOKE CREATE ON SCHEMA companion_one FROM ${quoteIdentifier(WELFARE_VERIFIER_ROLE)}`,
      );

      await ownerOne.query(
        `GRANT SELECT ON companion_one.verifier_forbidden_table TO ${quoteIdentifier(WELFARE_VERIFIER_ROLE)}`,
      );
      await expect(prepareFleetSharedSchemaRuntime(sharedStartupOptions(database, {
        welfareVerifier,
      }))).rejects.toThrow(/welfare verifier schema access mismatch/i);
      await ownerOne.query(
        `REVOKE SELECT ON companion_one.verifier_forbidden_table FROM ${quoteIdentifier(WELFARE_VERIFIER_ROLE)}`,
      );

      await ownerOne.query(
        `GRANT UPDATE ON companion_one.agent_background_work_jobs TO ${quoteIdentifier(WELFARE_VERIFIER_ROLE)}`,
      );
      await expect(prepareFleetSharedSchemaRuntime(sharedStartupOptions(database, {
        welfareVerifier,
      }))).rejects.toThrow(/welfare verifier schema access mismatch/i);
      await ownerOne.query(
        `REVOKE UPDATE ON companion_one.agent_background_work_jobs FROM ${quoteIdentifier(WELFARE_VERIFIER_ROLE)}`,
      );

      await expect(prepareFleetSharedSchemaRuntime(sharedStartupOptions(database, {
        welfareVerifier: {
          databaseUrl: database.welfareVerifierUrl,
          role: WELFARE_VERIFIER_ROLE_TWO,
        },
      }))).rejects.toThrow(/must authenticate as PostgreSQL role family_welfare_verifier_two/i);

      await expect(prepareFleetSharedSchemaRuntime(sharedStartupOptions(database)))
        .rejects.toThrow(/unexpected PostgreSQL grantees/i);
    } finally {
      await Promise.all([ownerOne.end(), ownerTwo.end()]);
    }
  }, TIMEOUT_MS);

  it('rejects target-database ownership for every topology authority before shared DDL', async () => {
    for (const ownerRole of [
      SHARED_OWNER_ROLE,
      ROLES.backupRestore,
      COMPANION_ROLE,
      COMPANION_ROLE_TWO,
    ]) {
      const database = await freshDatabase();
      const companionOne = createPostgresPool(database.companionUrl, { max: 1 });
      const companionTwo = createPostgresPool(database.companionTwoUrl, { max: 1 });
      try {
        await companionOne.query('CREATE SCHEMA companion_one');
        await companionTwo.query('CREATE SCHEMA companion_two');
      } finally {
        await companionOne.end();
        await companionTwo.end();
      }
      const databaseName = decodeURIComponent(new URL(database.companionUrl).pathname.slice(1));
      const admin = createPostgresPool(harness!.adminDatabaseUrl, { max: 1 });
      try {
        await admin.query(
          `ALTER DATABASE ${quoteIdentifier(databaseName)} OWNER TO ${quoteIdentifier(ownerRole)}`,
        );
      } finally {
        await admin.end();
      }

      await expect(prepareFleetSharedSchemaRuntime(sharedStartupOptions(database)))
        .rejects.toThrow(/must not own the target database/i);
      const targetAdminUrl = new URL(harness!.adminDatabaseUrl);
      targetAdminUrl.pathname = `/${databaseName}`;
      const targetAdmin = createPostgresPool(targetAdminUrl.toString(), { max: 1 });
      try {
        await expect(targetAdmin.query("SELECT to_regnamespace('shared') AS schema"))
          .resolves.toMatchObject({ rows: [{ schema: null }] });
      } finally {
        await targetAdmin.end();
      }
    }
  }, TIMEOUT_MS);

  it('starts feature-off topology with gateway wiki DDL and read-only two-role runtimes', async () => {
    const database = await freshDatabase();
    const companionOne = createPostgresPool(database.companionUrl, { max: 1 });
    const companionTwo = createPostgresPool(database.companionTwoUrl, { max: 1 });
    try {
      await companionOne.query('CREATE SCHEMA companion_one');
      await companionTwo.query('CREATE SCHEMA companion_two');
    } finally {
      await companionOne.end();
      await companionTwo.end();
    }
    const options = sharedStartupOptions(database);
    const { fleetAuth: _fleetAuth, ...featureOffOptions } = options;
    await prepareFleetSharedSchemaRuntime(featureOffOptions);
    await assertSharedSchemaRuntimeAuthority(database.companionUrl, {
      ownSchema: 'companion_one',
      companionSchemas: ['companion_one', 'companion_two'],
    });
    await assertSharedSchemaRuntimeAuthority(database.companionTwoUrl, {
      ownSchema: 'companion_two',
      companionSchemas: ['companion_one', 'companion_two'],
    });
    const embedding: EmbeddingProviderPort = {
      dims: 3,
      embed: async () => new Float32Array([1, 0, 0]),
      embedBatch: async texts => texts.map(() => new Float32Array([1, 0, 0])),
    };
    const stores = await Promise.all([
      createSharedWikiPgvectorProjectionStore(database.companionUrl, embedding),
      createSharedWikiPgvectorProjectionStore(database.companionTwoUrl, embedding),
    ]);
    try {
      await expect(stores[0].listProjectedShas('readiness')).resolves.toEqual([]);
      await expect(stores[1].listProjectedShas('readiness')).resolves.toEqual([]);
      const runtimeOne = createPostgresPool(database.companionUrl, { max: 1 });
      const runtimeTwo = createPostgresPool(database.companionTwoUrl, { max: 1 });
      try {
        await expect(runtimeOne.query('CREATE TABLE shared.runtime_ddl_probe_one (id integer)'))
          .rejects.toThrow(/permission denied/i);
        await expect(runtimeTwo.query('CREATE TABLE shared.runtime_ddl_probe_two (id integer)'))
          .rejects.toThrow(/permission denied/i);
      } finally {
        await Promise.all([runtimeOne.end(), runtimeTwo.end()]);
      }
    } finally {
      await Promise.all(stores.map(store => store.close()));
    }
  }, TIMEOUT_MS);

  it('restores companion/shared schemas before publishing the durable fleet-auth result', async () => {
    const timer = new PhaseTimer('fleet-auth-family-restore');
    let phaseFailed = true;
    const endSourceSetup = timer.begin('source setup + seed + consistent backup');
    const source = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: source.migrationUrl, roles: ROLES });
    const sourceMigration = createPostgresPool(source.migrationUrl, { max: 1 });
    const sourceRuntime = createPostgresPool(source.runtimeUrl, { max: 1 });
    const sourceBackup = createPostgresPool(source.backupUrl, { max: 1 });
    const root = mkdtempSync(join(tmpdir(), 'psfn-family-restore-integration-'));
    const systemDataDir = join(root, 'system-data');
    const backupDir = join(root, 'backup');
    const floorRoot = join(root, 'authority');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(floorRoot, { recursive: true, mode: 0o700 });
    chmodSync(floorRoot, 0o700);
    writeFleetAuthTestConfig(systemDataDir);
    writeMandatorySystemOwnerFiles(systemDataDir);
    const principalId = randomUUID();
    const sourceAuditEventId = randomUUID();
    const sourceAttachmentId = randomUUID();
    const sourceAttachmentJti = randomUUID();
    let sourceCompanion: ReturnType<typeof createPostgresPool> | undefined;
    let sourceCompanionTwo: ReturnType<typeof createPostgresPool> | undefined;
    let sourceSharedOwner: ReturnType<typeof createPostgresPool> | undefined;
    try {
      const floors = new FleetAuthAuthorityFloorStore(floorRoot);
      const floor = floors.open({
        activationGeneration: 1,
        databaseHasDurableAuthority: false,
      });
      await reconcileFleetAuthAuthorityState(sourceBackup, floor, sourceAuditEventId);
      sourceCompanion = createPostgresPool(source.companionUrl, { max: 1 });
      sourceCompanionTwo = createPostgresPool(source.companionTwoUrl, { max: 1 });
      sourceSharedOwner = createPostgresPool(source.sharedOwnerUrl, { max: 1 });
      await sourceCompanion.query(`
        CREATE SCHEMA companion_one;
        CREATE TABLE companion_one.agent_background_work_jobs (job_id TEXT PRIMARY KEY);
        CREATE TABLE companion_one.restore_probe (marker TEXT NOT NULL);
        INSERT INTO companion_one.restore_probe VALUES ('companion-source');
        CREATE TABLE companion_one.contacts (
          contact_lifecycle_state TEXT NOT NULL,
          contact_restore_state TEXT NOT NULL,
          contact_authority_version BIGINT NOT NULL
        );
        INSERT INTO companion_one.contacts VALUES ('live', 'live', 4);
        CREATE TABLE companion_one.contact_channel_ids (
          ownership_state TEXT NOT NULL,
          restore_state TEXT NOT NULL
        );
        INSERT INTO companion_one.contact_channel_ids VALUES ('verified', 'live');
        CREATE TABLE companion_one.contact_lifecycle_intents (
          phase TEXT NOT NULL,
          reason TEXT NOT NULL,
          restore_state TEXT NOT NULL,
          lease_owner TEXT,
          lease_expires_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL
        );
        INSERT INTO companion_one.contact_lifecycle_intents
          VALUES ('gateway_finalize_pending', 'pending_finalize', 'live', 'source-worker', now(), now());
        CREATE TABLE companion_one.contact_lifecycle_target_locks (
          lock_state TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
        INSERT INTO companion_one.contact_lifecycle_target_locks VALUES ('active', now());
        CREATE FUNCTION companion_one.restore_function() RETURNS TEXT
          LANGUAGE SQL AS 'SELECT ''companion-source''::text';
        GRANT USAGE ON SCHEMA companion_one TO ${quoteIdentifier(ROLES.backupRestore)};
        GRANT SELECT ON ALL TABLES IN SCHEMA companion_one TO ${quoteIdentifier(ROLES.backupRestore)};
      `);
      await sourceCompanionTwo.query(`
        CREATE SCHEMA companion_two;
        CREATE TABLE companion_two.agent_background_work_jobs (job_id TEXT PRIMARY KEY);
        CREATE TABLE companion_two.restore_probe (marker TEXT NOT NULL);
        INSERT INTO companion_two.restore_probe VALUES ('companion-two-source');
        GRANT USAGE ON SCHEMA companion_two TO ${quoteIdentifier(ROLES.backupRestore)};
        GRANT SELECT ON ALL TABLES IN SCHEMA companion_two TO ${quoteIdentifier(ROLES.backupRestore)};
      `);
      const routedSharedMigrationUrl = new URL(source.sharedOwnerUrl);
      routedSharedMigrationUrl.searchParams.set('service', 'shadow');
      await expect(prepareFleetSharedSchemaRuntime(sharedStartupOptions(source, {
        sharedMigrationDatabaseUrl: routedSharedMigrationUrl.toString(),
      }))).rejects.toThrow(/routing or authentication query override/i);
      await expect(prepareFleetSharedSchemaRuntime(sharedStartupOptions(source, {
        sharedMigrationDatabaseUrl: source.companionUrl,
      }))).rejects.toThrow(/must authenticate as PostgreSQL role family_shared_migration/i);
      const mismatchedDatabase = await freshDatabase();
      await expect(prepareFleetSharedSchemaRuntime(sharedStartupOptions(source, {
        sharedMigrationDatabaseUrl: mismatchedDatabase.sharedOwnerUrl,
      }))).rejects.toThrow(/targets another database/i);
      const overprivilegedSharedUrl = roleUrl(
        source.sharedOwnerUrl,
        OVERPRIVILEGED_SHARED_ROLE,
      );
      await expect(prepareFleetSharedSchemaRuntime(sharedStartupOptions(source, {
        sharedMigrationDatabaseUrl: overprivilegedSharedUrl,
        sharedMigrationRole: OVERPRIVILEGED_SHARED_ROLE,
      }))).rejects.toThrow(/must not hold cluster authority attributes: SUPERUSER/i);
      await expect(sourceBackup.query("SELECT to_regnamespace('shared') IS NULL AS absent"))
        .resolves.toMatchObject({ rows: [{ absent: true }] });
      await prepareFleetSharedSchemaRuntime(sharedStartupOptions(source));
      await sourceSharedOwner.query(`
        CREATE TABLE shared.restore_probe (marker TEXT NOT NULL);
        INSERT INTO shared.restore_probe VALUES ('shared-source');
      `);
      const productionAccessContracts = await prepareFleetSharedSchemaRuntime(
        sharedStartupOptions(source, {
          welfareVerifier: {
            databaseUrl: source.welfareVerifierUrl,
            role: WELFARE_VERIFIER_ROLE,
          },
        }),
      );
      expect(productionAccessContracts).toEqual([
        {
          kind: 'companion', schema: 'companion_one', ownerRole: COMPANION_ROLE,
          runtimeRoles: [COMPANION_ROLE],
        },
        {
          kind: 'companion', schema: 'companion_two', ownerRole: COMPANION_ROLE_TWO,
          runtimeRoles: [COMPANION_ROLE_TWO],
        },
        {
          kind: 'shared', schema: 'shared', ownerRole: SHARED_OWNER_ROLE,
          runtimeRoles: [COMPANION_ROLE, COMPANION_ROLE_TWO],
        },
      ]);
      await sourceRuntime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          (principal_id, status, authority_generation)
         VALUES ($1, 'active', 1)`,
        [principalId],
      );
      await sourceRuntime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
          (provider, subject_id, principal_id, state, authority_generation)
         VALUES ('discord', '123456789012345678', $1, 'active', 1)`,
        [principalId],
      );
      await sourceRuntime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
          (event_id, actor_context, action, resource, decision, reason_code,
           authority_generation, global_auth_epoch)
         VALUES ($1, '{"kind":"system","id":"source"}'::jsonb,
                 'authority.source', 'fleet_auth', 'deny', 'source_event', 1, 1)`,
        [sourceAuditEventId],
      );
      await sourceBackup.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.hub_device_human_attachments
          (attachment_id, assertion_digest, assertion_jti, device_id,
           enrollment_version, place_id, key_id, companion_id, hub_session_id,
           connection_id, channel_id, device_state, human_state, created_at, updated_at)
        VALUES ($1, $2, $3, 'restore-device', 2, 'office', 'restore-key', $4,
                'restore-hub-session', 'restore-connection', $5,
                'active', 'guest', $6, $6)
      `, [
        sourceAttachmentId,
        'd'.repeat(64),
        sourceAttachmentJti,
        '11111111-1111-4111-8111-111111111111',
        `hub-device:${'e'.repeat(64)}`,
        '2026-07-15T14:59:00.000Z',
      ]);
      const backup = await runFleetAuthConsistentBackup({
        databaseUrl: source.backupUrl,
        roles: ROLES,
        schemas: productionAccessContracts,
        systemDataDir,
        backupDir,
        capturedAt: '2026-07-15T15:00:00.000Z',
      });
      endSourceSetup();

      const endBackupCycle = timer.begin('backup cycle (recovery)');
      const companionDataDir = join(root, 'companion-data', 'companion-one');
      const sessionsDir = join(companionDataDir, 'state', 'sessions');
      const personalWorkspacePath = join(root, 'workspaces', 'personal', 'companion-one');
      const companionTwoDataDir = join(root, 'companion-data', 'companion-two');
      const companionTwoSessionsDir = join(companionTwoDataDir, 'state', 'sessions');
      const companionTwoWorkspacePath = join(root, 'workspaces', 'personal', 'companion-two');
      const sharedWorkspacePath = join(root, 'workspaces', 'shared');
      mkdirSync(join(companionDataDir, 'vault'), { recursive: true });
      mkdirSync(sessionsDir, { recursive: true });
      mkdirSync(join(personalWorkspacePath, 'journal'), { recursive: true });
      mkdirSync(join(companionTwoDataDir, 'vault'), { recursive: true });
      mkdirSync(companionTwoSessionsDir, { recursive: true });
      mkdirSync(join(companionTwoWorkspacePath, 'journal'), { recursive: true });
      mkdirSync(join(sharedWorkspacePath, 'artifacts'), { recursive: true });
      writeFleetAuthTestConfig(systemDataDir);
      const recovery = await runFleetBackupCycle({
        postgres: { databaseUrl: source.backupUrl },
        companions: [
          {
            companionId: '11111111-1111-4111-8111-111111111111',
            postgresSchema: 'companion_one',
            companionDataDir,
            sessionsDir,
            personalWorkspacePath,
          },
          {
            companionId: '22222222-2222-4222-8222-222222222222',
            postgresSchema: 'companion_two',
            companionDataDir: companionTwoDataDir,
            sessionsDir: companionTwoSessionsDir,
            personalWorkspacePath: companionTwoWorkspacePath,
          },
        ],
        systemDataDir,
        sharedWorkspacePath,
        backupRootDir: join(backupDir, 'recovery'),
        consistentSnapshotDumpPaths: backup.schemaDumpPaths,
        now: () => Date.UTC(2026, 6, 15, 15, 0, 0),
      });
      endBackupCycle();

      const endRestoreVerification = timer.begin('restore verification (negative + success)');
      const sourceDatabaseName = decodeURIComponent(new URL(source.backupUrl).pathname.slice(1));
      const routedScratchUrl = new URL(source.backupUrl);
      routedScratchUrl.pathname = `/${sourceDatabaseName}_restore_verify`;
      routedScratchUrl.searchParams.set('dbname', sourceDatabaseName);
      await expect(verifyFleetAuthConsistentFamilyRestore({
        manifestPath: backup.manifestPath,
        fleetManifestPath: recovery.fleetManifestPath,
        scratchDatabaseUrl: routedScratchUrl.toString(),
        scratchFleetAuthSchemaOwnerDatabaseUrl: routedScratchUrl.toString(),
        scratchSchemaOwnerDatabaseUrls: {},
        roles: ROLES,
        authorityFloors: floors,
        activationGeneration: floors.read().trustedHost.activationGeneration,
      })).rejects.toThrow(/destination-routing parameter dbname/u);
      await expect(sourceBackup.query('SELECT marker FROM companion_one.restore_probe'))
        .resolves.toMatchObject({ rows: [{ marker: 'companion-source' }] });

      const scratch = await freshRestoreVerifyDatabase();
      await migrateFleetAuthSchema({ databaseUrl: scratch.migrationUrl, roles: ROLES });
      const floorBeforeVerification = floors.read();
      const scratchOwnerDatabaseUrls = {
        companion_one: scratch.companionUrl,
        companion_two: scratch.companionTwoUrl,
        shared: scratch.sharedOwnerUrl,
      };
      const recoveryManifest = JSON.parse(
        readFileSync(recovery.fleetManifestPath, 'utf8'),
      ) as { units: Array<{ kind: string; postgresSchema?: string }> };
      const omittedFleetManifestPath = join(
        dirname(recovery.fleetManifestPath),
        'fleet-manifest-omitted-companion.json',
      );
      writeFileSync(omittedFleetManifestPath, JSON.stringify({
        ...recoveryManifest,
        units: recoveryManifest.units.filter(unit => unit.postgresSchema !== 'companion_two'),
      }), 'utf8');
      const scratchCompanionTwo = createPostgresPool(scratch.companionTwoUrl, { max: 1 });
      try {
        await scratchCompanionTwo.query(`
          CREATE SCHEMA companion_two;
          CREATE TABLE companion_two.preflight_marker (value TEXT NOT NULL);
          INSERT INTO companion_two.preflight_marker VALUES ('untouched');
        `);
        await expect(verifyFleetAuthConsistentFamilyRestore({
          manifestPath: backup.manifestPath,
          fleetManifestPath: omittedFleetManifestPath,
          scratchDatabaseUrl: scratch.backupUrl,
          scratchFleetAuthSchemaOwnerDatabaseUrl: scratch.migrationUrl,
          scratchSchemaOwnerDatabaseUrls: scratchOwnerDatabaseUrls,
          roles: ROLES,
          authorityFloors: floors,
          activationGeneration: floorBeforeVerification.trustedHost.activationGeneration,
        })).rejects.toThrow(/coordinator and recovery schema families must match exactly/i);
        await expect(scratchCompanionTwo.query(
          'SELECT value FROM companion_two.preflight_marker',
        )).resolves.toMatchObject({ rows: [{ value: 'untouched' }] });
        await scratchCompanionTwo.query('DROP SCHEMA companion_two CASCADE');
      } finally {
        await scratchCompanionTwo.end();
      }
      await expect(verifyFleetAuthConsistentFamilyRestore({
        manifestPath: backup.manifestPath,
        fleetManifestPath: recovery.fleetManifestPath,
        scratchDatabaseUrl: scratch.backupUrl,
        scratchFleetAuthSchemaOwnerDatabaseUrl: scratch.migrationUrl,
        scratchSchemaOwnerDatabaseUrls: {
          ...scratchOwnerDatabaseUrls,
          companion_one: scratch.companionTwoUrl,
        },
        roles: ROLES,
        authorityFloors: floors,
        activationGeneration: floorBeforeVerification.trustedHost.activationGeneration,
      })).rejects.toThrow(/companion_one.*family_companion_runtime|authenticate/i);
      const routedScratchOwnerUrl = new URL(scratch.companionUrl);
      routedScratchOwnerUrl.searchParams.set('service', 'shadow');
      await expect(verifyFleetAuthConsistentFamilyRestore({
        manifestPath: backup.manifestPath,
        fleetManifestPath: recovery.fleetManifestPath,
        scratchDatabaseUrl: scratch.backupUrl,
        scratchFleetAuthSchemaOwnerDatabaseUrl: scratch.migrationUrl,
        scratchSchemaOwnerDatabaseUrls: {
          ...scratchOwnerDatabaseUrls,
          companion_one: routedScratchOwnerUrl.toString(),
        },
        roles: ROLES,
        authorityFloors: floors,
        activationGeneration: floorBeforeVerification.trustedHost.activationGeneration,
      })).rejects.toThrow(/routing or authentication query override service/i);
      const mismatchedScratch = await freshRestoreVerifyDatabase();
      await expect(verifyFleetAuthConsistentFamilyRestore({
        manifestPath: backup.manifestPath,
        fleetManifestPath: recovery.fleetManifestPath,
        scratchDatabaseUrl: scratch.backupUrl,
        scratchFleetAuthSchemaOwnerDatabaseUrl: scratch.migrationUrl,
        scratchSchemaOwnerDatabaseUrls: {
          ...scratchOwnerDatabaseUrls,
          companion_one: mismatchedScratch.companionUrl,
        },
        roles: ROLES,
        authorityFloors: floors,
        activationGeneration: floorBeforeVerification.trustedHost.activationGeneration,
      })).rejects.toThrow(/owner credential for companion_one targets another database/i);
      const unusableScratchOwnerUrl = new URL(scratch.companionUrl);
      unusableScratchOwnerUrl.password = 'wrong-password';
      await expect(verifyFleetAuthConsistentFamilyRestore({
        manifestPath: backup.manifestPath,
        fleetManifestPath: recovery.fleetManifestPath,
        scratchDatabaseUrl: scratch.backupUrl,
        scratchFleetAuthSchemaOwnerDatabaseUrl: scratch.migrationUrl,
        scratchSchemaOwnerDatabaseUrls: {
          ...scratchOwnerDatabaseUrls,
          companion_one: unusableScratchOwnerUrl.toString(),
        },
        roles: ROLES,
        authorityFloors: floors,
        activationGeneration: floorBeforeVerification.trustedHost.activationGeneration,
      })).rejects.toThrow(/password authentication failed/i);
      expect(floors.read()).toEqual(floorBeforeVerification);
      const scratchBeforeValidVerification = createPostgresPool(scratch.runtimeUrl, { max: 1 });
      try {
        await expect(scratchBeforeValidVerification.query(
          "SELECT to_regnamespace('companion_one') IS NULL AS companion_one_absent, "
          + "to_regnamespace('companion_two') IS NULL AS companion_two_absent, "
          + "to_regnamespace('shared') IS NULL AS shared_absent, "
          + "to_regnamespace('restore_control') IS NULL AS marker_absent",
        )).resolves.toMatchObject({
          rows: [{
            companion_one_absent: true,
            companion_two_absent: true,
            shared_absent: true,
            marker_absent: true,
          }],
        });
      } finally {
        await scratchBeforeValidVerification.end();
      }
      await verifyFleetAuthConsistentFamilyRestore({
        manifestPath: backup.manifestPath,
        fleetManifestPath: recovery.fleetManifestPath,
        scratchDatabaseUrl: scratch.backupUrl,
        scratchFleetAuthSchemaOwnerDatabaseUrl: scratch.migrationUrl,
        scratchSchemaOwnerDatabaseUrls: scratchOwnerDatabaseUrls,
        roles: ROLES,
        authorityFloors: floors,
        activationGeneration: floorBeforeVerification.trustedHost.activationGeneration,
        scratchWelfareVerifier: {
          databaseUrl: scratch.welfareVerifierUrl,
          role: WELFARE_VERIFIER_ROLE,
        },
      });
      expect(floors.read()).toEqual(floorBeforeVerification);
      const scratchRuntime = createPostgresPool(scratch.runtimeUrl, { max: 1 });
      try {
        await expect(scratchRuntime.query(
          `SELECT count(*)::integer AS count FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals`,
        )).resolves.toMatchObject({ rows: [{ count: 0 }] });
        await expect(scratchRuntime.query(
          "SELECT to_regnamespace('companion_one') IS NULL AS companion_one_absent, "
          + "to_regnamespace('companion_two') IS NULL AS companion_two_absent, "
          + "to_regnamespace('shared') IS NULL AS shared_absent, "
          + "to_regnamespace('restore_control') IS NULL AS marker_absent",
        )).resolves.toMatchObject({
          rows: [{
            companion_one_absent: true,
            companion_two_absent: true,
            shared_absent: true,
            marker_absent: true,
          }],
        });
      } finally {
        await scratchRuntime.end();
      }

      endRestoreVerification();

      const endDurableRestore = timer.begin('durable restore (negative + success)');
      const target = await freshDatabase();
      await migrateFleetAuthSchema({ databaseUrl: target.migrationUrl, roles: ROLES });
      const routedCompanionUrl = new URL(target.companionUrl);
      routedCompanionUrl.searchParams.set('user', COMPANION_ROLE_TWO);
      await expect(restoreFleetAuthConsistentFamily({
        manifestPath: backup.manifestPath,
        backupRestoreDatabaseUrl: target.backupUrl,
        fleetAuthSchemaOwnerDatabaseUrl: target.migrationUrl,
        roles: ROLES,
        authorityFloors: floors,
        activationGeneration: 2,
        schemaOwnerDatabaseUrls: {
          companion_one: routedCompanionUrl.toString(),
          companion_two: target.companionTwoUrl,
          shared: target.sharedOwnerUrl,
        },
        restoredAt: '2026-07-15T16:00:00.000Z',
      })).rejects.toThrow(/routing or authentication query override|role-routing override/i);
      const result = await restoreFleetAuthConsistentFamily({
        manifestPath: backup.manifestPath,
        backupRestoreDatabaseUrl: target.backupUrl,
        fleetAuthSchemaOwnerDatabaseUrl: target.migrationUrl,
        roles: ROLES,
        authorityFloors: floors,
        activationGeneration: 2,
        schemaOwnerDatabaseUrls: {
          companion_one: target.companionUrl,
          companion_two: target.companionTwoUrl,
          shared: target.sharedOwnerUrl,
        },
        welfareVerifier: {
          databaseUrl: target.welfareVerifierUrl,
          role: WELFARE_VERIFIER_ROLE,
        },
        restoredAt: '2026-07-15T16:00:00.000Z',
      });

      endDurableRestore();

      const endRestoreAssertions = timer.begin('post-restore authority assertions');
      await prepareFleetSharedSchemaRuntime(sharedStartupOptions(target, {
        welfareVerifier: {
          databaseUrl: target.welfareVerifierUrl,
          role: WELFARE_VERIFIER_ROLE,
        },
      }));
      await assertSharedSchemaRuntimeAuthority(target.companionUrl, {
        ownSchema: 'companion_one',
        companionSchemas: ['companion_one', 'companion_two'],
      });
      await assertSharedSchemaRuntimeAuthority(target.companionTwoUrl, {
        ownSchema: 'companion_two',
        companionSchemas: ['companion_one', 'companion_two'],
      });

      expect(result.restoredSchemas).toEqual(['companion_one', 'companion_two', 'shared']);
      expect(result.fleetAuth.importedRows).toBeGreaterThan(0);
      const targetBackup = createPostgresPool(target.backupUrl, { max: 1 });
      const targetRuntime = createPostgresPool(target.runtimeUrl, { max: 1 });
      const targetCompanion = createPostgresPool(target.companionUrl, { max: 1 });
      const targetCompanionTwo = createPostgresPool(target.companionTwoUrl, { max: 1 });
      const targetSharedMigration = createPostgresPool(target.sharedOwnerUrl, { max: 1 });
      const targetWelfareVerifier = createPostgresPool(target.welfareVerifierUrl, { max: 1 });
      const presenceOne = await PostgresCompanionPresenceStore.connect(target.companionUrl);
      const presenceTwo = await PostgresCompanionPresenceStore.connect(target.companionTwoUrl);
      try {
        await expect(targetSharedMigration.query(`
          CREATE TABLE shared.shared_authority_ddl_probe (marker TEXT NOT NULL);
          DROP TABLE shared.shared_authority_ddl_probe;
        `)).resolves.toBeDefined();
        await expect(targetBackup.query('SELECT marker FROM companion_one.restore_probe'))
          .resolves.toMatchObject({ rows: [{ marker: 'companion-source' }] });
        await expect(targetBackup.query('SELECT marker FROM shared.restore_probe'))
          .resolves.toMatchObject({ rows: [{ marker: 'shared-source' }] });
        await expect(targetRuntime.query(
          `SELECT status, restore_state FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals
           WHERE principal_id = $1`,
          [principalId],
        )).resolves.toMatchObject({
          rows: [{ status: 'quarantined', restore_state: 'quarantined' }],
        });
        await expect(targetRuntime.query(
          `SELECT assertion_jti, device_state, human_state, fenced_at
           FROM ${FLEET_AUTH_SCHEMA_NAME}.hub_device_human_attachments
           WHERE attachment_id = $1`,
          [sourceAttachmentId],
        )).resolves.toMatchObject({
          rows: [{
            assertion_jti: sourceAttachmentJti,
            device_state: 'fenced',
            human_state: 'detached',
            fenced_at: new Date('2026-07-15T16:00:00.000Z'),
          }],
        });
        await expect(targetCompanion.query('SELECT marker FROM companion_one.restore_probe'))
          .resolves.toMatchObject({ rows: [{ marker: 'companion-source' }] });
        await expect(targetWelfareVerifier.query(
          'SELECT count(*)::integer AS count FROM companion_one.agent_background_work_jobs',
        )).resolves.toMatchObject({ rows: [{ count: 0 }] });
        await expect(targetWelfareVerifier.query('SELECT marker FROM companion_one.restore_probe'))
          .rejects.toThrow(/permission denied/i);
        await expect(targetWelfareVerifier.query('CREATE TABLE companion_one.forbidden (id integer)'))
          .rejects.toThrow(/permission denied/i);
        await expect(targetCompanion.query(`
          SELECT contact_lifecycle_state, contact_restore_state, contact_authority_version
          FROM companion_one.contacts
        `)).resolves.toMatchObject({
          rows: [{
            contact_lifecycle_state: 'quarantined',
            contact_restore_state: 'quarantined',
            contact_authority_version: '5',
          }],
        });
        await expect(targetCompanion.query(`
          SELECT ownership_state, restore_state FROM companion_one.contact_channel_ids
        `)).resolves.toMatchObject({
          rows: [{ ownership_state: 'quarantined', restore_state: 'quarantined' }],
        });
        await expect(targetCompanion.query(`
          SELECT phase, reason, restore_state, lease_owner, lease_expires_at
          FROM companion_one.contact_lifecycle_intents
        `)).resolves.toMatchObject({
          rows: [{
            phase: 'quarantined',
            reason: 'restore_quarantine',
            restore_state: 'quarantined',
            lease_owner: null,
            lease_expires_at: null,
          }],
        });
        await expect(targetCompanion.query(`
          SELECT lock_state FROM companion_one.contact_lifecycle_target_locks
        `)).resolves.toMatchObject({ rows: [{ lock_state: 'quarantined' }] });
        const migrationPool = createPostgresPool(target.companionUrl, {
          max: 1,
          schema: 'companion_one',
        });
        try {
          await ensurePostgresSchema(migrationPool, [
            'ALTER TABLE restore_probe ADD COLUMN IF NOT EXISTS migrated BOOLEAN NOT NULL DEFAULT TRUE',
          ]);
        } finally {
          await migrationPool.end();
        }
        await expect(targetCompanion.query(
          'SELECT migrated, companion_one.restore_function() AS function_value FROM companion_one.restore_probe',
        )).resolves.toMatchObject({
          rows: [{ migrated: true, function_value: 'companion-source' }],
        });
        await expect(targetCompanion.query(
          "INSERT INTO shared.restore_probe VALUES ('companion-write') RETURNING marker",
        )).resolves.toMatchObject({ rows: [{ marker: 'companion-write' }] });
        await expect(targetCompanion.query('SELECT marker FROM companion_two.restore_probe'))
          .rejects.toThrow(/permission denied/);
        await expect(targetCompanionTwo.query('SELECT marker FROM companion_two.restore_probe'))
          .resolves.toMatchObject({ rows: [{ marker: 'companion-two-source' }] });
        await expect(targetCompanionTwo.query('SELECT marker FROM companion_one.restore_probe'))
          .rejects.toThrow(/permission denied/);
        await expect(targetCompanionTwo.query('SELECT marker FROM shared.restore_probe ORDER BY marker'))
          .resolves.toMatchObject({
            rows: [{ marker: 'companion-write' }, { marker: 'shared-source' }],
          });
        await presenceOne.upsertPresence({
          companionId: '11111111-1111-4111-8111-111111111111',
          siteId: 'site-one',
          placeId: 'place-one',
          kind: 'physical',
        });
        await expect(presenceTwo.listAll()).resolves.toHaveLength(1);
        await expect(targetCompanion.query('ALTER TABLE shared.companion_presence ADD COLUMN denied TEXT'))
          .rejects.toThrow(/must be owner|permission denied/i);
        await expect(targetCompanionTwo.query('DROP TABLE shared.companion_presence'))
          .rejects.toThrow(/must be owner|permission denied/i);
        await expect(targetSharedMigration.query('SELECT 1 FROM companion_one.restore_probe'))
          .rejects.toThrow(/permission denied/i);
        await expect(targetSharedMigration.query(
          `SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals`,
        )).rejects.toThrow(/permission denied/i);
      } finally {
        await presenceOne.close();
        await presenceTwo.close();
        await targetBackup.end();
        await targetRuntime.end();
        await targetCompanion.end();
        await targetCompanionTwo.end();
        await targetSharedMigration.end();
        await targetWelfareVerifier.end();
      }

      endRestoreAssertions();

      const endConflictTarget = timer.begin('conflicting-authority target rejection');
      const conflictingTarget = await freshDatabase();
      await migrateFleetAuthSchema({ databaseUrl: conflictingTarget.migrationUrl, roles: ROLES });
      const conflictingRuntime = createPostgresPool(conflictingTarget.runtimeUrl, { max: 1 });
      const conflictingBackup = createPostgresPool(conflictingTarget.backupUrl, { max: 1 });
      try {
        await reconcileFleetAuthAuthorityState(
          conflictingBackup,
          floors.read(),
          randomUUID(),
        );
        const targetGeneration = floors.read().trustedHost.authorityGeneration;
        await conflictingRuntime.query(
          `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
            (event_id, actor_context, action, resource, decision, reason_code,
             authority_generation, global_auth_epoch)
           VALUES ($1, '{"kind":"system","id":"conflicting-target"}'::jsonb,
                   'authority.conflict', 'fleet_auth', 'deny', 'injected_conflict', $2, 1)`,
          [sourceAuditEventId, targetGeneration],
        );

        await expect(restoreFleetAuthConsistentFamily({
          manifestPath: backup.manifestPath,
          backupRestoreDatabaseUrl: conflictingTarget.backupUrl,
          fleetAuthSchemaOwnerDatabaseUrl: conflictingTarget.migrationUrl,
          roles: ROLES,
          authorityFloors: floors,
          activationGeneration: 3,
          schemaOwnerDatabaseUrls: {
            companion_one: conflictingTarget.companionUrl,
            companion_two: conflictingTarget.companionTwoUrl,
            shared: conflictingTarget.sharedOwnerUrl,
          },
          restoredAt: '2026-07-15T17:00:00.000Z',
        })).rejects.toThrow(/conflicting durable authorization audit event/i);

        const residual = await conflictingRuntime.query<{ schema: string }>(`
          SELECT nspname AS schema
          FROM pg_namespace
          WHERE nspname IN ('companion_one', 'companion_two', 'shared', 'restore_control')
          ORDER BY nspname
        `);
        expect(residual.rows).toEqual([]);
      } finally {
        await conflictingBackup.end();
        await conflictingRuntime.end();
      }

      endConflictTarget();

      const endRetryTarget = timer.begin('fault-injection retry target');
      const retryTarget = await freshDatabase();
      await migrateFleetAuthSchema({ databaseUrl: retryTarget.migrationUrl, roles: ROLES });
      const retryRuntime = createPostgresPool(retryTarget.runtimeUrl, { max: 1 });
      try {
        await expect(restoreFleetAuthConsistentFamily({
          manifestPath: backup.manifestPath,
          backupRestoreDatabaseUrl: retryTarget.backupUrl,
          fleetAuthSchemaOwnerDatabaseUrl: retryTarget.migrationUrl,
          roles: ROLES,
          authorityFloors: floors,
          activationGeneration: 4,
          schemaOwnerDatabaseUrls: {
            companion_one: retryTarget.companionUrl,
            companion_two: retryTarget.companionTwoUrl,
            shared: retryTarget.sharedOwnerUrl,
          },
          restoredAt: '2026-07-15T18:00:00.000Z',
          faultInjection: (stage) => {
            if (stage === 'after_fleet_auth_restore') {
              throw new Error('injected failure after durable fleet-auth import');
            }
          },
        })).rejects.toThrow(/injected failure after durable fleet-auth import/i);
        const residual = await retryRuntime.query<{ schema: string }>(`
          SELECT nspname AS schema
          FROM pg_namespace
          WHERE nspname IN ('companion_one', 'companion_two', 'shared', 'restore_control')
          ORDER BY nspname
        `);
        expect(residual.rows).toEqual([]);

        await expect(restoreFleetAuthConsistentFamily({
          manifestPath: backup.manifestPath,
          backupRestoreDatabaseUrl: retryTarget.backupUrl,
          fleetAuthSchemaOwnerDatabaseUrl: retryTarget.migrationUrl,
          roles: ROLES,
          authorityFloors: floors,
          activationGeneration: 5,
          schemaOwnerDatabaseUrls: {
            companion_one: retryTarget.companionUrl,
            companion_two: retryTarget.companionTwoUrl,
            shared: retryTarget.sharedOwnerUrl,
          },
          restoredAt: '2026-07-15T19:00:00.000Z',
        })).resolves.toMatchObject({
          restoredSchemas: ['companion_one', 'companion_two', 'shared'],
        });

        const retryCompanion = createPostgresPool(retryTarget.companionUrl, { max: 1 });
        try {
          await expect(retryCompanion.query('SELECT marker FROM companion_one.restore_probe'))
            .resolves.toMatchObject({ rows: [{ marker: 'companion-source' }] });
          await expect(retryCompanion.query(
            `SELECT principal_id FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals`,
          )).rejects.toThrow(/permission denied/);
        } finally {
          await retryCompanion.end();
        }
      } finally {
        await retryRuntime.end();
      }

      endRetryTarget();

      const endConcurrentTarget = timer.begin('concurrent restore advisory-lock serialization');
      const concurrentTarget = await freshDatabase();
      await migrateFleetAuthSchema({ databaseUrl: concurrentTarget.migrationUrl, roles: ROLES });
      const concurrentOwnerUrls = {
        companion_one: concurrentTarget.companionUrl,
        companion_two: concurrentTarget.companionTwoUrl,
        shared: concurrentTarget.sharedOwnerUrl,
      };
      let releaseFirst!: () => void;
      let announceFirst!: () => void;
      const firstMayContinue = new Promise<void>(resolveBarrier => {
        releaseFirst = resolveBarrier;
      });
      const firstReachedPreflight = new Promise<void>(resolveBarrier => {
        announceFirst = resolveBarrier;
      });
      const firstRestore = restoreFleetAuthConsistentFamily({
        manifestPath: backup.manifestPath,
        backupRestoreDatabaseUrl: concurrentTarget.backupUrl,
        fleetAuthSchemaOwnerDatabaseUrl: concurrentTarget.migrationUrl,
        roles: ROLES,
        authorityFloors: floors,
        activationGeneration: 6,
        schemaOwnerDatabaseUrls: concurrentOwnerUrls,
        restoredAt: '2026-07-15T20:00:00.000Z',
        faultInjection: async (stage) => {
          if (stage === 'after_database_preflight') {
            announceFirst();
            await firstMayContinue;
            throw new Error('injected first restore cancellation after preflight');
          }
        },
      });
      await firstReachedPreflight;

      let secondReachedPreflight = false;
      const secondRestore = restoreFleetAuthConsistentFamily({
        manifestPath: backup.manifestPath,
        backupRestoreDatabaseUrl: concurrentTarget.backupUrl,
        fleetAuthSchemaOwnerDatabaseUrl: concurrentTarget.migrationUrl,
        roles: ROLES,
        authorityFloors: floors,
        activationGeneration: 7,
        schemaOwnerDatabaseUrls: concurrentOwnerUrls,
        restoredAt: '2026-07-15T21:00:00.000Z',
        faultInjection: (stage) => {
          if (stage === 'after_database_preflight') secondReachedPreflight = true;
        },
      });
      await waitForRestoreAdvisoryLockWaiter(concurrentTarget.backupUrl);
      expect(secondReachedPreflight).toBe(false);
      releaseFirst();
      await expect(firstRestore).rejects.toThrow(/first restore cancellation/);
      await expect(secondRestore).resolves.toMatchObject({
        restoredSchemas: ['companion_one', 'companion_two', 'shared'],
      });
      endConcurrentTarget();
      phaseFailed = false;
    } finally {
      // Emit timings first: a pg pool broken by the same failure we want to
      // diagnose can make the awaits below reject, and this instrumentation
      // exists precisely for that case. report() is synchronous, so running it
      // ahead of the awaitable cleanup guarantees the phase breakdown is printed
      // even when the cleanup itself throws (that error still propagates).
      timer.report({ failed: phaseFailed });
      await sourceCompanion?.end();
      await sourceCompanionTwo?.end();
      await sourceSharedOwner?.end();
      await sourceMigration.end();
      await sourceRuntime.end();
      await sourceBackup.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
