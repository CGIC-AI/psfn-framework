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
import { restoreFleetAuthConsistentFamily } from './fleet-restore.js';

const TIMEOUT_MS = 120_000;
const ROLES: FleetAuthDatabaseRoles = {
  runtime: 'family_auth_runtime',
  migration: 'family_auth_migration',
  backupRestore: 'family_auth_backup',
};
const COMPANION_ROLE = 'family_companion_runtime';
const COMPANION_ROLE_TWO = 'family_companion_two';
const PASSWORDS = {
  family_auth_runtime: 'runtime-password',
  family_auth_migration: 'migration-password',
  family_auth_backup: 'backup-password',
  family_companion_runtime: 'companion-password',
  family_companion_two: 'companion-two-password',
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
    for (const role of [...Object.values(ROLES), COMPANION_ROLE, COMPANION_ROLE_TWO]) {
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT CONNECTION LIMIT 8 `
        + `PASSWORD '${PASSWORDS[role as keyof typeof PASSWORDS]}'`,
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
    companionUrl: roleUrl(database.databaseUrl, COMPANION_ROLE),
    companionTwoUrl: roleUrl(database.databaseUrl, COMPANION_ROLE_TWO),
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
    const sourceAuditEventId = randomUUID();
    try {
      const floors = new FleetAuthAuthorityFloorStore(floorRoot);
      const floor = floors.open({
        activationGeneration: 1,
        databaseHasDurableAuthority: false,
      });
      await reconcileFleetAuthAuthorityState(sourceRuntime, floor, sourceAuditEventId);
      await sourceMigration.query(`
        CREATE SCHEMA companion_one;
        CREATE TABLE companion_one.restore_probe (marker TEXT NOT NULL);
        INSERT INTO companion_one.restore_probe VALUES ('companion-source');
        CREATE SCHEMA companion_two;
        CREATE TABLE companion_two.restore_probe (marker TEXT NOT NULL);
        INSERT INTO companion_two.restore_probe VALUES ('companion-two-source');
        CREATE SCHEMA shared;
        CREATE TABLE shared.restore_probe (marker TEXT NOT NULL);
        INSERT INTO shared.restore_probe VALUES ('shared-source');
        GRANT USAGE ON SCHEMA companion_one, companion_two, shared TO ${quoteIdentifier(ROLES.backupRestore)};
        GRANT SELECT ON ALL TABLES IN SCHEMA companion_one, companion_two, shared
          TO ${quoteIdentifier(ROLES.backupRestore)};
      `);
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
        schemas: [
          { kind: 'companion', schema: 'companion_one', runtimeRoles: [COMPANION_ROLE] },
          { kind: 'companion', schema: 'companion_two', runtimeRoles: [COMPANION_ROLE_TWO] },
          {
            kind: 'shared',
            schema: 'shared',
            runtimeRoles: [COMPANION_ROLE, COMPANION_ROLE_TWO],
          },
        ],
        systemDataDir,
        backupDir,
        capturedAt: '2026-07-15T15:00:00.000Z',
      });

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

      expect(result.restoredSchemas).toEqual(['companion_one', 'companion_two', 'shared']);
      expect(result.fleetAuth.importedRows).toBeGreaterThan(0);
      const targetBackup = createPostgresPool(target.backupUrl, { max: 1 });
      const targetRuntime = createPostgresPool(target.runtimeUrl, { max: 1 });
      const targetCompanion = createPostgresPool(target.companionUrl, { max: 1 });
      const targetCompanionTwo = createPostgresPool(target.companionTwoUrl, { max: 1 });
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
        await expect(targetCompanion.query('SELECT marker FROM companion_one.restore_probe'))
          .resolves.toMatchObject({ rows: [{ marker: 'companion-source' }] });
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
      } finally {
        await targetBackup.end();
        await targetRuntime.end();
        await targetCompanion.end();
        await targetCompanionTwo.end();
      }

      const conflictingTarget = await freshDatabase();
      await migrateFleetAuthSchema({ databaseUrl: conflictingTarget.migrationUrl, roles: ROLES });
      const conflictingRuntime = createPostgresPool(conflictingTarget.runtimeUrl, { max: 1 });
      try {
        await reconcileFleetAuthAuthorityState(
          conflictingRuntime,
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
          restoredAt: '2026-07-15T18:00:00.000Z',
          faultInjection: () => {
            throw new Error('injected failure after durable fleet-auth import');
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
    } finally {
      await sourceMigration.end();
      await sourceRuntime.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
