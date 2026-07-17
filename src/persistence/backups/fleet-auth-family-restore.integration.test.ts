import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresPool, ensurePostgresSchema } from '../postgres.js';
import { FleetAuthAuthorityFloorStore } from '../postgres/fleet-auth/authority-floor.js';
import { reconcileFleetAuthAuthorityState } from '../postgres/fleet-auth/gateway-persistence.js';
import {
  FLEET_AUTH_SCHEMA_NAME,
  migrateFleetAuthSchema,
  type FleetAuthDatabaseRoles,
} from '../postgres/fleet-auth/schema.js';
import {
  runFleetAuthConsistentBackup as runFleetAuthConsistentBackupProduction,
} from './fleet-auth-coordinator.js';
import {
  restoreFleetAuthConsistentFamily as restoreFleetAuthConsistentFamilyProduction,
  verifyFleetAuthConsistentFamilyRestore as verifyFleetAuthConsistentFamilyRestoreProduction,
} from './fleet-restore.js';
import { runFleetBackupCycle as runFleetBackupCycleProduction } from './service.js';
import { resolveFleetAuthSchemaAccessContracts } from './fleet-auth-schema-access.js';

const TIMEOUT_MS = 120_000;
const ROLES: FleetAuthDatabaseRoles = {
  runtime: 'family_auth_runtime',
  migration: 'family_auth_migration',
  backupRestore: 'family_auth_backup',
};
const COMPANION_ROLE = 'family_companion_runtime';
const COMPANION_ROLE_TWO = 'family_companion_two';
const SHARED_OWNER_ROLE = 'family_shared_migration';
const PASSWORDS = {
  family_auth_runtime: 'runtime-password',
  family_auth_migration: 'migration-password',
  family_auth_backup: 'backup-password',
  family_companion_runtime: 'companion-password',
  family_companion_two: 'companion-two-password',
  family_shared_migration: 'shared-migration-password',
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
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    for (const role of [
      ...Object.values(ROLES), COMPANION_ROLE, COMPANION_ROLE_TWO, SHARED_OWNER_ROLE,
    ]) {
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
      + `${quoteIdentifier(ROLES.migration)}, ${quoteIdentifier(ROLES.backupRestore)}, `
      + `${quoteIdentifier(COMPANION_ROLE)}, ${quoteIdentifier(COMPANION_ROLE_TWO)}, `
      + `${quoteIdentifier(SHARED_OWNER_ROLE)}`,
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
    sharedOwnerUrl: roleUrl(database.databaseUrl, SHARED_OWNER_ROLE),
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
  it('restores companion/shared schemas before publishing the durable fleet-auth result', async () => {
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
        CREATE TABLE companion_two.restore_probe (marker TEXT NOT NULL);
        INSERT INTO companion_two.restore_probe VALUES ('companion-two-source');
        GRANT USAGE ON SCHEMA companion_two TO ${quoteIdentifier(ROLES.backupRestore)};
        GRANT SELECT ON ALL TABLES IN SCHEMA companion_two TO ${quoteIdentifier(ROLES.backupRestore)};
      `);
      await sourceSharedOwner.query(`
        CREATE SCHEMA shared;
        CREATE TABLE shared.restore_probe (marker TEXT NOT NULL);
        INSERT INTO shared.restore_probe VALUES ('shared-source');
        GRANT USAGE, CREATE ON SCHEMA shared
          TO ${quoteIdentifier(COMPANION_ROLE)}, ${quoteIdentifier(COMPANION_ROLE_TWO)};
        GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA shared
          TO ${quoteIdentifier(COMPANION_ROLE)}, ${quoteIdentifier(COMPANION_ROLE_TWO)};
        GRANT USAGE ON SCHEMA shared TO ${quoteIdentifier(ROLES.backupRestore)};
        GRANT SELECT ON ALL TABLES IN SCHEMA shared TO ${quoteIdentifier(ROLES.backupRestore)};
      `);
      const productionAccessContracts = await resolveFleetAuthSchemaAccessContracts({
        databaseUrl: source.backupUrl,
        companionSchemas: ['companion_one', 'companion_two'],
        sharedSchema: 'shared',
        roles: ROLES,
      });
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

      const sourceDatabaseName = decodeURIComponent(new URL(source.backupUrl).pathname.slice(1));
      const routedScratchUrl = new URL(source.backupUrl);
      routedScratchUrl.pathname = `/${sourceDatabaseName}_restore_verify`;
      routedScratchUrl.searchParams.set('dbname', sourceDatabaseName);
      await expect(verifyFleetAuthConsistentFamilyRestore({
        manifestPath: backup.manifestPath,
        fleetManifestPath: recovery.fleetManifestPath,
        scratchDatabaseUrl: routedScratchUrl.toString(),
        scratchSchemaOwnerDatabaseUrl: routedScratchUrl.toString(),
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
        scratchSchemaOwnerDatabaseUrl: scratch.migrationUrl,
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
      })).rejects.toThrow(/role-routing override/i);
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
      } finally {
        await targetBackup.end();
        await targetRuntime.end();
        await targetCompanion.end();
        await targetCompanionTwo.end();
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
