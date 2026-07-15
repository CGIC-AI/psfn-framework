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
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../postgres.js';
import { FleetAuthAuthorityFloorStore } from '../postgres/fleet-auth/authority-floor.js';
import { reconcileFleetAuthAuthorityState } from '../postgres/fleet-auth/gateway-persistence.js';
import {
  FLEET_AUTH_SCHEMA_NAME,
  migrateFleetAuthSchema,
  type FleetAuthDatabaseRoles,
} from '../postgres/fleet-auth/schema.js';
import { runFleetAuthConsistentBackup } from './fleet-auth-coordinator.js';
import {
  restoreFleetAuthConsistentFamily,
  verifyFleetAuthConsistentFamilyRestore,
} from './fleet-restore.js';
import { runFleetBackupCycle } from './service.js';

const TIMEOUT_MS = 120_000;
const ROLES: FleetAuthDatabaseRoles = {
  runtime: 'family_auth_runtime',
  migration: 'family_auth_migration',
  backupRestore: 'family_auth_backup',
};
const PASSWORDS = {
  family_auth_runtime: 'runtime-password',
  family_auth_migration: 'migration-password',
  family_auth_backup: 'backup-password',
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
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    for (const role of Object.values(ROLES)) {
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD '${PASSWORDS[role as keyof typeof PASSWORDS]}'`,
      );
    }
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
      + `${quoteIdentifier(ROLES.migration)}, ${quoteIdentifier(ROLES.backupRestore)}`,
    );
  } finally {
    await admin.end();
  }
  return {
    migrationUrl: roleUrl(database.databaseUrl, ROLES.migration),
    runtimeUrl: roleUrl(database.databaseUrl, ROLES.runtime),
    backupUrl: roleUrl(database.databaseUrl, ROLES.backupRestore),
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
  return {
    migrationUrl: roleUrl(databaseUrl.toString(), ROLES.migration),
    runtimeUrl: roleUrl(databaseUrl.toString(), ROLES.runtime),
    backupUrl: roleUrl(databaseUrl.toString(), ROLES.backupRestore),
  };
}

describe('fleet-auth consistent family restore against real Postgres', () => {
  it('restores companion/shared schemas before publishing the durable fleet-auth result', async () => {
    const source = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: source.migrationUrl, roles: ROLES });
    const sourceMigration = createPostgresPool(source.migrationUrl, { max: 1 });
    const sourceRuntime = createPostgresPool(source.runtimeUrl, { max: 1 });
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
    try {
      const floors = new FleetAuthAuthorityFloorStore(floorRoot);
      const floor = floors.open({
        activationGeneration: 1,
        databaseHasDurableAuthority: false,
      });
      await reconcileFleetAuthAuthorityState(sourceRuntime, floor, randomUUID());
      await sourceMigration.query(`
        CREATE SCHEMA companion_one;
        CREATE TABLE companion_one.restore_probe (marker TEXT NOT NULL);
        INSERT INTO companion_one.restore_probe VALUES ('companion-source');
        CREATE SCHEMA shared;
        CREATE TABLE shared.restore_probe (marker TEXT NOT NULL);
        INSERT INTO shared.restore_probe VALUES ('shared-source');
        GRANT USAGE ON SCHEMA companion_one, shared TO ${quoteIdentifier(ROLES.backupRestore)};
        GRANT SELECT ON ALL TABLES IN SCHEMA companion_one, shared TO ${quoteIdentifier(ROLES.backupRestore)};
      `);
      await sourceRuntime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          (principal_id, status, authority_generation)
         VALUES ($1, 'active', 1)`,
        [principalId],
      );
      const backup = await runFleetAuthConsistentBackup({
        databaseUrl: source.backupUrl,
        roles: ROLES,
        schemas: [
          { kind: 'companion', schema: 'companion_one' },
          { kind: 'shared', schema: 'shared' },
        ],
        systemDataDir,
        backupDir,
        capturedAt: '2026-07-15T15:00:00.000Z',
      });

      const companionDataDir = join(root, 'companion-data', 'companion-one');
      const sessionsDir = join(companionDataDir, 'state', 'sessions');
      const personalWorkspacePath = join(root, 'workspaces', 'personal', 'companion-one');
      const sharedWorkspacePath = join(root, 'workspaces', 'shared');
      mkdirSync(join(companionDataDir, 'vault'), { recursive: true });
      mkdirSync(sessionsDir, { recursive: true });
      mkdirSync(join(personalWorkspacePath, 'journal'), { recursive: true });
      mkdirSync(join(sharedWorkspacePath, 'artifacts'), { recursive: true });
      copyFileSync(join(process.cwd(), 'config', 'fleet-auth.seed.json'), join(systemDataDir, 'fleet-auth.json'));
      const recovery = await runFleetBackupCycle({
        postgres: { databaseUrl: source.backupUrl },
        companions: [{
          companionId: '11111111-1111-4111-8111-111111111111',
          postgresSchema: 'companion_one',
          companionDataDir,
          sessionsDir,
          personalWorkspacePath,
        }],
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
      await expect(sourceMigration.query('SELECT marker FROM companion_one.restore_probe'))
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
      const result = await restoreFleetAuthConsistentFamily({
        manifestPath: backup.manifestPath,
        backupRestoreDatabaseUrl: target.backupUrl,
        roles: ROLES,
        authorityFloors: floors,
        activationGeneration: 2,
        restoredAt: '2026-07-15T16:00:00.000Z',
      });

      expect(result.restoredSchemas).toEqual(['companion_one', 'shared']);
      expect(result.fleetAuth.importedRows).toBeGreaterThan(0);
      const targetBackup = createPostgresPool(target.backupUrl, { max: 1 });
      const targetRuntime = createPostgresPool(target.runtimeUrl, { max: 1 });
      try {
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
      } finally {
        await targetBackup.end();
        await targetRuntime.end();
      }
    } finally {
      await sourceMigration.end();
      await sourceRuntime.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
