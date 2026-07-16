import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { runFleetAuthConsistentBackup } from './fleet-auth-coordinator.js';
import {
  restoreFleetAuthConsistentFamily,
  verifyFleetAuthConsistentFamilyRestore,
} from './fleet-restore.js';
import { runFleetBackupCycle } from './service.js';
import {
  prepareFleetSharedSchemaRuntime,
} from './fleet-shared-schema-startup.js';

const TIMEOUT_MS = 120_000;
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
const PASSWORDS = {
  family_auth_runtime: 'runtime-password',
  family_auth_migration: 'migration-password',
  family_auth_backup: 'backup-password',
  family_companion_runtime: 'companion-password',
  family_companion_two: 'companion-two-password',
  family_shared_migration: 'shared-migration-password',
  family_shared_overpriv: 'overprivileged-password',
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

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: PGVECTOR_POSTGRES_TEST_IMAGE });
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    for (const role of [
      ...Object.values(ROLES), COMPANION_ROLE, COMPANION_ROLE_TWO,
      OVERPRIVILEGED_SHARED_ROLE,
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
    await databaseAdmin.query('CREATE EXTENSION vector WITH SCHEMA public');
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
  };
}

async function freshRestoreVerifyDatabase() {
  if (!harness) throw new Error('Postgres harness unavailable');
  const databaseName = `psfn_${randomUUID().replaceAll('-', '')}_restore_verify`;
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await admin.query(
      `GRANT CREATE, CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO `
      + `${quoteIdentifier(ROLES.migration)}, ${quoteIdentifier(ROLES.backupRestore)}`,
    );
  } finally {
    await admin.end();
  }
  const databaseUrl = new URL(harness.adminDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const databaseAdmin = createPostgresPool(databaseUrl.toString(), { max: 1 });
  try {
    await databaseAdmin.query('CREATE EXTENSION vector WITH SCHEMA public');
  } finally {
    await databaseAdmin.end();
  }
  return {
    migrationUrl: roleUrl(databaseUrl.toString(), ROLES.migration),
    runtimeUrl: roleUrl(databaseUrl.toString(), ROLES.runtime),
    backupUrl: roleUrl(databaseUrl.toString(), ROLES.backupRestore),
  };
}

function sharedStartupOptions(
  database: Awaited<ReturnType<typeof freshDatabase>>,
  overrides: {
    sharedMigrationDatabaseUrl?: string;
    sharedMigrationRole?: string;
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
    },
  };
}

async function waitForRestoreAdvisoryLockWaiter(databaseUrl: string): Promise<void> {
  if (!harness) throw new Error('Postgres harness unavailable');
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
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
    const source = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: source.migrationUrl, roles: ROLES });
    const sourceMigration = createPostgresPool(source.migrationUrl, { max: 1 });
    const sourceRuntime = createPostgresPool(source.runtimeUrl, { max: 1 });
    const sourceBackup = createPostgresPool(source.backupUrl, { max: 1 });
    const root = join(
      tmpdir(),
      `psfn-family-restore-integration-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
    );
    const systemDataDir = join(root, 'system-data');
    const backupDir = join(root, 'backup');
    const floorRoot = join(root, 'authority');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(floorRoot, { recursive: true, mode: 0o700 });
    chmodSync(floorRoot, 0o700);
    copyFileSync(
      join(process.cwd(), 'config', 'fleet-auth.seed.json'),
      join(systemDataDir, 'fleet-auth.json'),
    );
    const principalId = randomUUID();
    const sourceAuditEventId = randomUUID();
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
        CREATE TABLE companion_one.restore_probe (marker TEXT NOT NULL);
        INSERT INTO companion_one.restore_probe VALUES ('companion-source');
        CREATE FUNCTION companion_one.restore_function() RETURNS TEXT
          LANGUAGE SQL AS 'SELECT ''companion-source''::text';
        GRANT USAGE ON SCHEMA companion_one TO ${quoteIdentifier(ROLES.backupRestore)};
        GRANT SELECT ON ALL TABLES IN SCHEMA companion_one TO ${quoteIdentifier(ROLES.backupRestore)};
      `);
      await sourceCompanionTwo.query(`
        CREATE SCHEMA companion_two;
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
        sharedStartupOptions(source),
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
      const backup = await runFleetAuthConsistentBackup({
        databaseUrl: source.backupUrl,
        roles: ROLES,
        schemas: productionAccessContracts,
        systemDataDir,
        backupDir,
        capturedAt: '2026-07-15T15:00:00.000Z',
      });

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
      copyFileSync(join(process.cwd(), 'config', 'fleet-auth.seed.json'), join(systemDataDir, 'fleet-auth.json'));
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

      const sourceDatabaseName = decodeURIComponent(new URL(source.backupUrl).pathname.slice(1));
      const routedScratchUrl = new URL(source.backupUrl);
      routedScratchUrl.pathname = `/${sourceDatabaseName}_restore_verify`;
      routedScratchUrl.searchParams.set('dbname', sourceDatabaseName);
      await expect(verifyFleetAuthConsistentFamilyRestore({
        manifestPath: backup.manifestPath,
        fleetManifestPath: recovery.fleetManifestPath,
        scratchDatabaseUrl: routedScratchUrl.toString(),
        roles: ROLES,
        authorityFloors: floors,
        activationGeneration: floors.read().trustedHost.activationGeneration,
      })).rejects.toThrow(/destination-routing parameter dbname/u);
      await expect(sourceBackup.query('SELECT marker FROM companion_one.restore_probe'))
        .resolves.toMatchObject({ rows: [{ marker: 'companion-source' }] });

      const scratch = await freshRestoreVerifyDatabase();
      await migrateFleetAuthSchema({ databaseUrl: scratch.migrationUrl, roles: ROLES });
      const floorBeforeVerification = floors.read();
      await verifyFleetAuthConsistentFamilyRestore({
        manifestPath: backup.manifestPath,
        fleetManifestPath: recovery.fleetManifestPath,
        scratchDatabaseUrl: scratch.backupUrl,
        roles: ROLES,
        authorityFloors: floors,
        activationGeneration: floorBeforeVerification.trustedHost.activationGeneration,
      });
      expect(floors.read()).toEqual(floorBeforeVerification);
      const scratchRuntime = createPostgresPool(scratch.runtimeUrl, { max: 1 });
      try {
        await expect(scratchRuntime.query(
          `SELECT count(*)::integer AS count FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals`,
        )).resolves.toMatchObject({ rows: [{ count: 0 }] });
        await expect(scratchRuntime.query(
          "SELECT to_regnamespace('companion_one') IS NULL AS absent, "
          + "to_regnamespace('shared') IS NULL AS shared_absent",
        )).resolves.toMatchObject({ rows: [{ absent: true, shared_absent: true }] });
      } finally {
        await scratchRuntime.end();
      }

      const target = await freshDatabase();
      await migrateFleetAuthSchema({ databaseUrl: target.migrationUrl, roles: ROLES });
      const routedCompanionUrl = new URL(target.companionUrl);
      routedCompanionUrl.searchParams.set('user', COMPANION_ROLE_TWO);
      await expect(restoreFleetAuthConsistentFamily({
        manifestPath: backup.manifestPath,
        backupRestoreDatabaseUrl: target.backupUrl,
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
        roles: ROLES,
        authorityFloors: floors,
        activationGeneration: 2,
        schemaOwnerDatabaseUrls: {
          companion_one: target.companionUrl,
          companion_two: target.companionTwoUrl,
          shared: target.sharedOwnerUrl,
        },
        restoredAt: '2026-07-15T16:00:00.000Z',
      });

      await prepareFleetSharedSchemaRuntime(sharedStartupOptions(target));
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
        await expect(targetCompanion.query('SELECT marker FROM companion_one.restore_probe'))
          .resolves.toMatchObject({ rows: [{ marker: 'companion-source' }] });
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
      }

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

      const retryTarget = await freshDatabase();
      await migrateFleetAuthSchema({ databaseUrl: retryTarget.migrationUrl, roles: ROLES });
      const retryRuntime = createPostgresPool(retryTarget.runtimeUrl, { max: 1 });
      try {
        await expect(restoreFleetAuthConsistentFamily({
          manifestPath: backup.manifestPath,
          backupRestoreDatabaseUrl: retryTarget.backupUrl,
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

    } finally {
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
