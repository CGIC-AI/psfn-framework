import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../../postgres.js';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetAuthAuthorityFloorStore } from './authority-floor.js';
import {
  FLEET_AUTH_SCHEMA_NAME,
  assertFleetAuthBackupRestorePrivileges,
  assertFleetAuthRuntimePrivileges,
  hasDurableFleetAuthAuthority,
  migrateFleetAuthSchema,
  type FleetAuthDatabaseRoles,
} from './schema.js';
import { reconcileFleetAuthAuthorityState } from './gateway-persistence.js';
import { FleetAuthLifecycleWitnessStore } from './lifecycle-witness.js';
import {
  runFleetAuthConsistentBackup,
  restoreFleetAuthSnapshot,
  verifyFleetAuthBackupManifest,
} from '../../backups/fleet-auth-coordinator.js';

const TIMEOUT_MS = 120_000;
const ROLES: FleetAuthDatabaseRoles = {
  runtime: 'fleet_auth_runtime',
  migration: 'fleet_auth_migration',
  backupRestore: 'fleet_auth_backup',
};
const COMPANION_ROLE = 'companion_runtime';
const PASSWORDS = {
  fleet_auth_runtime: 'runtime-password',
  fleet_auth_migration: 'migration-password',
  fleet_auth_backup: 'backup-password',
  companion_runtime: 'companion-password',
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
    for (const role of [...Object.values(ROLES), COMPANION_ROLE]) {
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
      `GRANT CREATE, CONNECT ON DATABASE ${quoteIdentifier(database.databaseName)} TO ${quoteIdentifier(ROLES.migration)}`,
    );
  } finally {
    await admin.end();
  }
  return {
    adminUrl: database.databaseUrl,
    migrationUrl: roleUrl(database.databaseUrl, ROLES.migration),
    runtimeUrl: roleUrl(database.databaseUrl, ROLES.runtime),
    backupUrl: roleUrl(database.databaseUrl, ROLES.backupRestore),
    companionUrl: roleUrl(database.databaseUrl, COMPANION_ROLE),
  };
}

describe('fleet_auth Postgres authority boundary', () => {
  it('serializes replica migrations and records one checksummed ledger', async () => {
    const db = await freshDatabase();
    await Promise.all(Array.from({ length: 8 }, () => migrateFleetAuthSchema({
      databaseUrl: db.migrationUrl,
      roles: ROLES,
    })));

    const migration = createPostgresPool(db.migrationUrl, { max: 1 });
    try {
      const ledger = await migration.query<{ version: number; checksum: string }>(
        `SELECT version, checksum FROM ${FLEET_AUTH_SCHEMA_NAME}.schema_migrations ORDER BY version`,
      );
      expect(ledger.rows.map(row => row.version)).toEqual([1, 2, 3, 4]);
      expect(ledger.rows.every(row => /^[0-9a-f]{64}$/.test(row.checksum))).toBe(true);

      const tables = await migration.query<{ table_name: string }>(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = '${FLEET_AUTH_SCHEMA_NAME}'
        ORDER BY table_name
      `);
      expect(tables.rows.map(row => row.table_name)).toEqual(expect.arrayContaining([
        'authority_state',
        'authorization_audit_events',
        'browser_sessions',
        'discord_evidence_snapshots',
        'human_principals',
        'jit_authorization_grants',
        'oauth_transactions',
        'passkey_credentials',
        'principal_contact_bindings',
        'principal_role_grants',
        'provider_subject_history',
        'provider_subject_tombstones',
        'provider_subjects',
        'schema_migrations',
        'step_up_challenges',
      ]));
    } finally {
      await migration.end();
    }
  }, TIMEOUT_MS);

  it('rejects a pre-created fleet_auth schema owned outside migration authority', async () => {
    const db = await freshDatabase();
    const admin = createPostgresPool(db.adminUrl, { max: 1 });
    try {
      await admin.query(
        `CREATE SCHEMA ${FLEET_AUTH_SCHEMA_NAME} AUTHORIZATION ${quoteIdentifier(COMPANION_ROLE)}`,
      );
    } finally {
      await admin.end();
    }
    await expect(migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES }))
      .rejects.toThrow(/schema must be owned by the configured migration role/);
  }, TIMEOUT_MS);

  it('gives broker runtime DML but no DDL/ledger access and denies the companion role', async () => {
    const db = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });
    await expect(assertFleetAuthRuntimePrivileges(db.runtimeUrl, ROLES)).resolves.toBeUndefined();

    const runtime = createPostgresPool(db.runtimeUrl, { max: 1 });
    const companion = createPostgresPool(db.companionUrl, { max: 1 });
    const principalId = randomUUID();
    try {
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          (principal_id, status, authority_generation)
         VALUES ($1, 'pending', 1)`,
        [principalId],
      );
      expect(await hasDurableFleetAuthAuthority(runtime)).toBe(true);
      await expect(runtime.query(
        `CREATE TABLE ${FLEET_AUTH_SCHEMA_NAME}.runtime_escape (id integer)`,
      )).rejects.toThrow(/permission denied/);
      await expect(runtime.query(
        `SELECT * FROM ${FLEET_AUTH_SCHEMA_NAME}.schema_migrations`,
      )).rejects.toThrow(/permission denied/);
      await expect(companion.query(
        `SELECT * FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals`,
      )).rejects.toThrow(/permission denied/);
    } finally {
      await runtime.end();
      await companion.end();
    }
  }, TIMEOUT_MS);

  it('gives the coordinator backup/restore DML but no DDL or migration authority', async () => {
    const db = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });
    await expect(assertFleetAuthBackupRestorePrivileges(db.backupUrl, ROLES))
      .resolves.toBeUndefined();
    const backup = createPostgresPool(db.backupUrl, { max: 1 });
    try {
      await backup.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          (principal_id, status, authority_generation, restore_state)
         VALUES ($1, 'quarantined', 2, 'quarantined')`,
        [randomUUID()],
      );
      await expect(backup.query(
        `CREATE TABLE ${FLEET_AUTH_SCHEMA_NAME}.backup_escape (id integer)`,
      )).rejects.toThrow(/permission denied/);
      await expect(backup.query(
        `DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.schema_migrations`,
      )).rejects.toThrow(/permission denied/);
    } finally {
      await backup.end();
    }
  }, TIMEOUT_MS);

  it('rejects cross-role membership that could SET ROLE into migration authority', async () => {
    if (!harness) throw new Error('Postgres harness unavailable');
    const db = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });
    const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
    try {
      await admin.query(
        `GRANT ${quoteIdentifier(ROLES.migration)} TO ${quoteIdentifier(ROLES.runtime)}`,
      );
      await expect(assertFleetAuthRuntimePrivileges(db.runtimeUrl, ROLES))
        .rejects.toThrow(/must not inherit or SET ROLE/);
    } finally {
      await admin.query(
        `REVOKE ${quoteIdentifier(ROLES.migration)} FROM ${quoteIdentifier(ROLES.runtime)}`,
      );
      await admin.end();
    }
  }, TIMEOUT_MS);

  it('rejects every inverse membership into protected authorities, including the companion role', async () => {
    if (!harness) throw new Error('Postgres harness unavailable');
    const db = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });
    const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
    const protectedRoles = Object.values(ROLES);
    const memberships = protectedRoles.flatMap(protectedRole => [
      ...protectedRoles
        .filter(memberRole => memberRole !== protectedRole)
        .map(memberRole => ({ protectedRole, memberRole })),
      { protectedRole, memberRole: COMPANION_ROLE },
    ]);
    try {
      for (const { protectedRole, memberRole } of memberships) {
        await admin.query(
          `GRANT ${quoteIdentifier(protectedRole)} TO ${quoteIdentifier(memberRole)}`,
        );
        await expect(migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES }))
          .rejects.toThrow(/must not inherit|unexpected role membership.*fleet auth authority/i);
        await admin.query(
          `REVOKE ${quoteIdentifier(protectedRole)} FROM ${quoteIdentifier(memberRole)}`,
        );
      }
    } finally {
      for (const { protectedRole, memberRole } of memberships) {
        await admin.query(
          `REVOKE ${quoteIdentifier(protectedRole)} FROM ${quoteIdentifier(memberRole)}`,
        ).catch(() => undefined);
      }
      await admin.end();
    }
  }, TIMEOUT_MS);

  it('rejects privilege drift and migration restores the exact runtime/backup matrix', async () => {
    const db = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });
    const migration = createPostgresPool(db.migrationUrl, { max: 1 });
    try {
      for (const role of [ROLES.runtime, ROLES.backupRestore]) {
        await migration.query(
          `GRANT TRUNCATE, REFERENCES, TRIGGER
             ON ${FLEET_AUTH_SCHEMA_NAME}.human_principals TO ${quoteIdentifier(role)}`,
        );
        await migration.query(
          `GRANT UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
             ON ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_tombstones TO ${quoteIdentifier(role)}`,
        );
      }
      await expect(assertFleetAuthRuntimePrivileges(db.runtimeUrl, ROLES))
        .rejects.toThrow(/exact DML privileges/i);
      await expect(assertFleetAuthBackupRestorePrivileges(db.backupUrl, ROLES))
        .rejects.toThrow(/exact DML privileges/i);

      await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });
      await expect(assertFleetAuthRuntimePrivileges(db.runtimeUrl, ROLES)).resolves.toBeUndefined();
      await expect(assertFleetAuthBackupRestorePrivileges(db.backupUrl, ROLES))
        .resolves.toBeUndefined();

      const runtime = createPostgresPool(db.runtimeUrl, { max: 1 });
      try {
        await expect(runtime.query(
          `DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_tombstones`,
        )).rejects.toThrow(/permission denied/);
        await expect(runtime.query(
          `TRUNCATE ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events`,
        )).rejects.toThrow(/permission denied/);
      } finally {
        await runtime.end();
      }
    } finally {
      await migration.end();
    }
  }, TIMEOUT_MS);

  it('rejects drifted fleet_auth grants to a companion role', async () => {
    const db = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });
    const migration = createPostgresPool(db.migrationUrl, { max: 1 });
    try {
      await migration.query(
        `GRANT SELECT ON ${FLEET_AUTH_SCHEMA_NAME}.human_principals TO ${quoteIdentifier(COMPANION_ROLE)}`,
      );
      await expect(assertFleetAuthRuntimePrivileges(db.runtimeUrl, ROLES))
        .rejects.toThrow(/unexpected fleet_auth grantees.*companion_runtime/);
    } finally {
      await migration.query(
        `REVOKE ALL ON ${FLEET_AUTH_SCHEMA_NAME}.human_principals FROM ${quoteIdentifier(COMPANION_ROLE)}`,
      );
      await migration.end();
    }
  }, TIMEOUT_MS);

  it('enforces immutable history/audit and forbids authoritative passkey state in fleet_auth', async () => {
    const db = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });
    const runtime = createPostgresPool(db.runtimeUrl, { max: 1 });
    const principalId = randomUUID();
    try {
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          (principal_id, status, authority_generation)
         VALUES ($1, 'pending', 1)`,
        [principalId],
      );
      const auditId = randomUUID();
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
          (event_id, actor_context, action, resource, decision, authority_generation, global_auth_epoch)
         VALUES ($1, '{"kind":"system"}'::jsonb, 'startup', 'fleet_auth', 'allow', 1, 1)`,
        [auditId],
      );
      await expect(runtime.query(
        `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
         SET action = 'rewritten' WHERE event_id = $1`,
        [auditId],
      )).rejects.toThrow(/permission denied|append-only/);

      await expect(runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.passkey_credentials
          (credential_id_hash, principal_id, expected_provider_subject_id, rp_id,
           public_key_projection, credential_generation, state, authority_floor_generation)
         VALUES ($1, $2, '123456789012345678', 'fleet.example.test', 'verifier', 1, 'current', 1)`,
        ['a'.repeat(64), principalId],
      )).rejects.toThrow(/check constraint/);
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.passkey_credentials
          (credential_id_hash, principal_id, expected_provider_subject_id, rp_id,
           public_key_projection, credential_generation, state, authority_floor_generation,
           restore_state)
         VALUES ($1, $2, '123456789012345678', 'fleet.example.test', 'verifier', 1,
                 'quarantined', 1, 'quarantined')`,
        ['b'.repeat(64), principalId],
      );
    } finally {
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('permanently fences provider subjects and serializes competing contact claims across replicas', async () => {
    const db = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });
    const replicaA = createPostgresPool(db.runtimeUrl, { max: 1 });
    const replicaB = createPostgresPool(db.runtimeUrl, { max: 1 });
    const principalA = randomUUID();
    const principalB = randomUUID();
    const companionId = randomUUID();
    const providerSubject = '123456789012345679';
    try {
      await replicaA.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          (principal_id, status, authority_generation)
         VALUES ($1, 'pending', 1), ($2, 'pending', 1)`,
        [principalA, principalB],
      );

      const providerRace = await Promise.allSettled([
        replicaA.query(
          `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
            (provider, subject_id, principal_id, state, authority_generation)
           VALUES ('discord', $1, $2, 'pending', 1)`,
          [providerSubject, principalA],
        ),
        replicaB.query(
          `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
            (provider, subject_id, principal_id, state, authority_generation)
           VALUES ('discord', $1, $2, 'pending', 1)`,
          [providerSubject, principalB],
        ),
      ]);
      expect(providerRace.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const winner = await replicaA.query<{ principal_id: string }>(
        `SELECT principal_id FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
         WHERE provider = 'discord' AND subject_id = $1`,
        [providerSubject],
      );
      const winnerId = winner.rows[0]!.principal_id;
      await expect(replicaA.query(
        `DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
         WHERE provider = 'discord' AND subject_id = $1`,
        [providerSubject],
      )).rejects.toThrow(/must be permanently tombstoned/i);
      await replicaA.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_tombstones
          (provider, subject_id, prior_principal_id, authority_generation, revoked_at, reason_digest)
         VALUES ('discord', $1, $2, 2, clock_timestamp(), $3)`,
        [providerSubject, winnerId, 'a'.repeat(64)],
      );
      await replicaA.query(
        `DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
         WHERE provider = 'discord' AND subject_id = $1`,
        [providerSubject],
      );
      await expect(replicaB.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
          (provider, subject_id, principal_id, state, authority_generation)
         VALUES ('discord', $1, $2, 'pending', 2)`,
        [providerSubject, winnerId === principalA ? principalB : principalA],
      )).rejects.toThrow(/permanently bound|tombstoned/i);

      const contactRace = await Promise.allSettled([
        replicaA.query(
          `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
            (binding_id, principal_id, companion_id, contact_id, state,
             verification_provenance, authority_generation)
           VALUES ($1, $2, $3, 'same-contact', 'pending', '{"kind":"race-a"}', 2)`,
          [randomUUID(), principalA, companionId],
        ),
        replicaB.query(
          `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
            (binding_id, principal_id, companion_id, contact_id, state,
             verification_provenance, authority_generation)
           VALUES ($1, $2, $3, 'same-contact', 'active', '{"kind":"race-b"}', 2)`,
          [randomUUID(), principalB, companionId],
        ),
      ]);
      expect(contactRace.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const bindings = await replicaA.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
         WHERE companion_id = $1 AND contact_id = 'same-contact'
           AND state IN ('active', 'pending')`,
        [companionId],
      );
      expect(bindings.rows[0]?.count).toBe('1');
    } finally {
      await replicaA.end();
      await replicaB.end();
    }
  }, TIMEOUT_MS);

  it('fences every ephemeral authority on same-generation disable/re-enable but not ordinary restart', async () => {
    const db = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });
    const runtime = createPostgresPool(db.runtimeUrl, { max: 1 });
    const principalId = randomUUID();
    const sessionId = randomUUID();
    const companionId = randomUUID();
    const floorRoot = mkdtempSync(join(tmpdir(), 'psfn-fleet-auth-reenable-'));
    chmodSync(floorRoot, 0o700);
    try {
      const floors = new FleetAuthAuthorityFloorStore(floorRoot);
      const lifecycle = new FleetAuthLifecycleWitnessStore(floorRoot);
      const initialFloor = floors.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
      lifecycle.recordEnabled(initialFloor.trustedHost.lineageId, null);
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          (principal_id, status, authority_generation)
         VALUES ($1, 'active', 1)`,
        [principalId],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
          (record_id, token_digest, csrf_digest, principal_id, audience, assurance,
           authn_version, authz_version, global_auth_epoch, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, 'garden', 'oauth', 1, 1, 1,
                 clock_timestamp() + interval '5 minutes', clock_timestamp() + interval '1 hour')`,
        [sessionId, '1'.repeat(64), '2'.repeat(64), principalId],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
          (transaction_id, state_digest, pkce_verifier_digest, callback_uri, return_path,
           global_auth_epoch, expires_at)
         VALUES ($1, $2, $3, 'https://fleet.example.test/oauth/callback', '/garden', 1,
                 clock_timestamp() + interval '5 minutes')`,
        [randomUUID(), '3'.repeat(64), '4'.repeat(64)],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_token_custody
          (custody_id, principal_id, encrypted_token, key_version, global_auth_epoch, expires_at)
         VALUES ($1, $2, decode('aa', 'hex'), 1, 1, clock_timestamp() + interval '5 minutes')`,
        [randomUUID(), principalId],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_snapshots
          (evidence_id, principal_id, provider_subject_id, companion_id, guild_id,
           permission_inputs, discord_permission_result, member_specific_deny_veto,
           psfn_evidence_result, input_digest, config_digest, provenance, global_auth_epoch,
           fetched_at, expires_at)
         VALUES ($1, $2, '123456789012345678', $3, '223456789012345678', '{}', TRUE,
                 FALSE, TRUE, $4, $5, '{}', 1, clock_timestamp(),
                 clock_timestamp() + interval '5 minutes')`,
        [randomUUID(), principalId, companionId, '5'.repeat(64), '6'.repeat(64)],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges
          (challenge_id, principal_id, browser_session_id, challenge_digest, kind, action,
           resource_digest, global_auth_epoch, expires_at)
         VALUES ($1, $2, $3, $4, 'webauthn_uv', 'settings.write', $5, 1,
                 clock_timestamp() + interval '5 minutes')`,
        [randomUUID(), principalId, sessionId, '7'.repeat(64), '8'.repeat(64)],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.jit_authorization_grants
          (grant_id, principal_id, browser_session_id, companion_id, subject_scope, action,
           resource_selector, purpose, assurance, memory_revision, classifier_evidence_digest,
           authz_version, binding_version, global_auth_epoch, expires_at)
         VALUES ($1, $2, $3, $4, '{}', 'memory.read.self', '{}', 'test', 'webauthn_uv',
                 1, $5, 1, 1, 1, clock_timestamp() + interval '5 minutes')`,
        [randomUUID(), principalId, sessionId, companionId, '9'.repeat(64)],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
          (ceremony_id, nonce_digest, kind, expected_provider_subject_id, exact_scope,
           global_auth_epoch, expires_at)
         VALUES ($1, $2, 'account_reapproval', '123456789012345678', '{}', 1,
                 clock_timestamp() + interval '5 minutes')`,
        [randomUUID(), 'a'.repeat(64)],
      );

      expect(lifecycle.prepareEnable(initialFloor.trustedHost.lineageId)).toBeUndefined();
      const ordinaryRestart = floors.open({
        activationGeneration: 1,
        databaseHasDurableAuthority: true,
      });
      await reconcileFleetAuthAuthorityState(runtime, ordinaryRestart, randomUUID());
      const beforeDisable = await runtime.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions`,
      );
      expect(beforeDisable.rows[0]?.count).toBe('1');

      lifecycle.recordDisabledIfPresent();
      const lifecycleTransitionId = lifecycle.prepareEnable(initialFloor.trustedHost.lineageId);
      expect(lifecycleTransitionId).toMatch(/^[0-9a-f]{64}$/);
      if (!lifecycleTransitionId) throw new Error('disable transition was not recorded');
      const reenabled = floors.open({
        activationGeneration: 1,
        databaseHasDurableAuthority: true,
        lifecycleTransitionId,
      });
      await reconcileFleetAuthAuthorityState(runtime, reenabled, randomUUID());

      const state = await runtime.query<{
        authority_generation: string;
        global_auth_epoch: string;
        activation_generation: string;
      }>(`SELECT authority_generation, global_auth_epoch, activation_generation
          FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state`);
      expect(state.rows[0]).toMatchObject({
        authority_generation: '2',
        global_auth_epoch: '2',
        activation_generation: '1',
      });
      const principal = await runtime.query<{ status: string; restore_state: string }>(
        `SELECT status, restore_state FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals
         WHERE principal_id = $1`,
        [principalId],
      );
      expect(principal.rows[0]).toEqual({ status: 'quarantined', restore_state: 'quarantined' });
      const ephemeralCounts = await runtime.query<{ table_name: string; count: string }>(
        `SELECT table_name, count
         FROM (VALUES
           ('browser_sessions', (SELECT COUNT(*) FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions)),
           ('oauth_transactions', (SELECT COUNT(*) FROM ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions)),
           ('provider_token_custody', (SELECT COUNT(*) FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_token_custody)),
           ('discord_evidence_snapshots', (SELECT COUNT(*) FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_snapshots)),
           ('step_up_challenges', (SELECT COUNT(*) FROM ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges)),
           ('jit_authorization_grants', (SELECT COUNT(*) FROM ${FLEET_AUTH_SCHEMA_NAME}.jit_authorization_grants)),
           ('trusted_host_ceremonies', (SELECT COUNT(*) FROM ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies))
         ) AS counts(table_name, count)`,
      );
      expect(ephemeralCounts.rows).toEqual(ephemeralCounts.rows.map(row => ({
        table_name: row.table_name,
        count: '0',
      })));
    } finally {
      await runtime.end();
      rmSync(floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('captures companion/shared and fleet_auth artifacts from one exported snapshot', async () => {
    const db = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });
    const migration = createPostgresPool(db.migrationUrl, { max: 1 });
    const runtime = createPostgresPool(db.runtimeUrl, { max: 1 });
    const root = mkdtempSync(join(tmpdir(), 'psfn-fleet-auth-backup-'));
    const systemDataDir = join(root, 'system-data');
    const backupDir = join(root, 'backup');
    const floorRoot = join(root, 'authority');
    const principalId = randomUUID();
    try {
      mkdirSync(systemDataDir, { recursive: true });
      mkdirSync(floorRoot, { mode: 0o700 });
      chmodSync(floorRoot, 0o700);
      copyFileSync(
        join(process.cwd(), 'config', 'fleet-auth.seed.json'),
        join(systemDataDir, 'fleet-auth.json'),
      );
      const floors = new FleetAuthAuthorityFloorStore(floorRoot);
      const floor = floors.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
      await reconcileFleetAuthAuthorityState(runtime, floor, randomUUID());
      await migration.query(`
        CREATE SCHEMA companion_alpha;
        CREATE TABLE companion_alpha.snapshot_probe (value TEXT NOT NULL);
        INSERT INTO companion_alpha.snapshot_probe VALUES ('companion-before');
        CREATE SCHEMA shared;
        CREATE TABLE shared.snapshot_probe (value TEXT NOT NULL);
        INSERT INTO shared.snapshot_probe VALUES ('shared-before');
        GRANT USAGE ON SCHEMA companion_alpha, shared TO ${quoteIdentifier(ROLES.backupRestore)};
        GRANT SELECT ON ALL TABLES IN SCHEMA companion_alpha, shared TO ${quoteIdentifier(ROLES.backupRestore)};
      `);
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          (principal_id, status, authority_generation)
         VALUES ($1, 'active', 1)`,
        [principalId],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
          (provider, subject_id, principal_id, state, metadata, authority_generation)
         VALUES ('discord', '123456789012345678', $1, 'active', '{"version":"before"}', 1)`,
        [principalId],
      );

      const result = await runFleetAuthConsistentBackup({
        databaseUrl: db.backupUrl,
        roles: ROLES,
        schemas: [
          { kind: 'companion', schema: 'companion_alpha' },
          { kind: 'shared', schema: 'shared' },
        ],
        systemDataDir,
        backupDir,
        capturedAt: '2026-07-15T15:00:00.000Z',
        afterSnapshotExported: async () => {
          await migration.query(`UPDATE companion_alpha.snapshot_probe SET value = 'companion-after'`);
          await migration.query(`UPDATE shared.snapshot_probe SET value = 'shared-after'`);
          await runtime.query(
            `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
             SET metadata = '{"version":"after"}' WHERE principal_id = $1`,
            [principalId],
          );
        },
      });
      const manifest = verifyFleetAuthBackupManifest(result.manifestPath);
      expect(manifest.authorityLineageId).toBe(floor.trustedHost.lineageId);
      expect(manifest.artifacts.map(artifact => artifact.kind).sort()).toEqual([
        'companion',
        'fleet_auth',
        'fleet_auth_config',
        'shared',
      ]);
      const snapshot = JSON.parse(readFileSync(result.fleetAuthSnapshotPath, 'utf8')) as {
        postgresSnapshot: string;
        durable: { providerSubjects: Array<{ metadata: { version: string } }> };
      };
      expect(snapshot.postgresSnapshot).toBe(manifest.postgresSnapshot);
      expect(snapshot.durable.providerSubjects[0]?.metadata.version).toBe('before');
      const companionSql = execFileSync('pg_restore', [
        '--data-only', '--file=-', result.schemaDumpPaths.companion_alpha,
      ], { encoding: 'utf8' });
      const sharedSql = execFileSync('pg_restore', [
        '--data-only', '--file=-', result.schemaDumpPaths.shared,
      ], { encoding: 'utf8' });
      expect(companionSql).toContain('companion-before');
      expect(companionSql).not.toContain('companion-after');
      expect(sharedSql).toContain('shared-before');
      expect(sharedSql).not.toContain('shared-after');
      const allFiles = JSON.stringify(manifest);
      expect(allFiles).not.toContain('authority-floor');
      expect(JSON.stringify(snapshot)).not.toContain('providerTokenCustody');
      expect(JSON.stringify(snapshot)).not.toContain('provisioningSecret');
    } finally {
      await migration.end();
      await runtime.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('restores durable rows quarantined while old passkey A stays denied and replacement B stays current', async () => {
    const source = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: source.migrationUrl, roles: ROLES });
    const sourceMigration = createPostgresPool(source.migrationUrl, { max: 1 });
    const sourceRuntime = createPostgresPool(source.runtimeUrl, { max: 1 });
    const root = mkdtempSync(join(tmpdir(), 'psfn-fleet-auth-restore-'));
    const systemDataDir = join(root, 'system-data');
    const backupDir = join(root, 'backup');
    const floorRoot = join(root, 'authority');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(floorRoot, { mode: 0o700 });
    chmodSync(floorRoot, 0o700);
    const principalId = randomUUID();
    const bindingId = randomUUID();
    const grantId = randomUUID();
    const keyA = {
      credentialIdHash: 'a'.repeat(64),
      publicKeyVerifier: 'verifier-a',
      rpId: 'fleet.example.test',
      principalId,
      expectedProvider: 'discord' as const,
      expectedProviderSubjectId: '123456789012345678',
      signCount: 0,
      backupEligible: false,
      backupState: false,
    };
    const keyB = { ...keyA, credentialIdHash: 'b'.repeat(64), publicKeyVerifier: 'verifier-b' };
    try {
      copyFileSync(
        join(process.cwd(), 'config', 'fleet-auth.seed.json'),
        join(systemDataDir, 'fleet-auth.json'),
      );
      const floors = new FleetAuthAuthorityFloorStore(floorRoot);
      const sourceFloor = floors.open({
        activationGeneration: 1,
        databaseHasDurableAuthority: false,
      });
      await reconcileFleetAuthAuthorityState(sourceRuntime, sourceFloor, randomUUID());
      await sourceMigration.query(`
        CREATE SCHEMA companion_alpha;
        CREATE TABLE companion_alpha.snapshot_probe (value TEXT NOT NULL);
        INSERT INTO companion_alpha.snapshot_probe VALUES ('source');
        CREATE SCHEMA shared;
        CREATE TABLE shared.snapshot_probe (value TEXT NOT NULL);
        INSERT INTO shared.snapshot_probe VALUES ('source');
        GRANT USAGE ON SCHEMA companion_alpha, shared TO ${quoteIdentifier(ROLES.backupRestore)};
        GRANT SELECT ON ALL TABLES IN SCHEMA companion_alpha, shared TO ${quoteIdentifier(ROLES.backupRestore)};
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
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
          (binding_id, principal_id, companion_id, contact_id, state,
           verification_provenance, authority_generation)
         VALUES ($1, $2, '11111111-1111-4111-8111-111111111111', 'contact-owner',
                 'active', '{"kind":"verified"}', 1)`,
        [bindingId, principalId],
      );
      await sourceRuntime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
          (grant_id, principal_id, companion_id, role, lifecycle, authority_generation)
         VALUES ($1, $2, '11111111-1111-4111-8111-111111111111', 'owner', 'active', 1)`,
        [grantId, principalId],
      );
      await sourceRuntime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.passkey_credentials
          (credential_id_hash, principal_id, expected_provider_subject_id, rp_id,
           public_key_projection, credential_generation, state, authority_floor_generation)
         VALUES ($1, $2, '123456789012345678', 'fleet.example.test', 'verifier-a', 1,
                 'pending', 1)`,
        [keyA.credentialIdHash, principalId],
      );
      const backup = await runFleetAuthConsistentBackup({
        databaseUrl: source.backupUrl,
        roles: ROLES,
        schemas: [
          { kind: 'companion', schema: 'companion_alpha' },
          { kind: 'shared', schema: 'shared' },
        ],
        systemDataDir,
        backupDir,
      });

      floors.enrollPasskey(keyA, '2026-07-15T10:00:00.000Z');
      floors.replacePasskey({
        priorCredentialIdHash: keyA.credentialIdHash,
        replacement: keyB,
        at: '2026-07-15T11:00:00.000Z',
      });
      floors.revokeAccountAuthority({
        kind: 'provider_subject',
        resourceId: 'discord:123456789012345678',
        reason: 'provider unlinked after backup',
        at: '2026-07-15T11:30:00.000Z',
      });

      const target = await freshDatabase();
      await migrateFleetAuthSchema({ databaseUrl: target.migrationUrl, roles: ROLES });
      await restoreFleetAuthSnapshot({
        manifestPath: backup.manifestPath,
        databaseUrl: target.backupUrl,
        roles: ROLES,
        authorityFloors: floors,
        activationGeneration: 2,
        restoredAt: '2026-07-15T12:00:00.000Z',
      });
      const targetRuntime = createPostgresPool(target.runtimeUrl, { max: 1 });
      try {
        const principal = await targetRuntime.query<{ status: string; restore_state: string }>(
          `SELECT status, restore_state FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals WHERE principal_id = $1`,
          [principalId],
        );
        expect(principal.rows[0]).toEqual({ status: 'quarantined', restore_state: 'quarantined' });
        const provider = await targetRuntime.query<{ state: string; restore_state: string }>(
          `SELECT state, restore_state FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
           WHERE provider = 'discord' AND subject_id = '123456789012345678'`,
        );
        expect(provider.rows[0]).toEqual({ state: 'revoked', restore_state: 'quarantined' });
        const providerTombstone = await targetRuntime.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_tombstones
           WHERE provider = 'discord' AND subject_id = '123456789012345678'`,
        );
        expect(providerTombstone.rows[0]?.count).toBe('1');
        await expect(targetRuntime.query(
          `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
           SET state = 'active'
           WHERE provider = 'discord' AND subject_id = '123456789012345678'`,
        )).rejects.toThrow(/permanently tombstoned/i);
        const passkey = await targetRuntime.query<{ state: string; restore_state: string }>(
          `SELECT state, restore_state FROM ${FLEET_AUTH_SCHEMA_NAME}.passkey_credentials
           WHERE credential_id_hash = $1`,
          [keyA.credentialIdHash],
        );
        expect(passkey.rows[0]).toEqual({ state: 'quarantined', restore_state: 'quarantined' });

        // Account/binding/role reapproval is deliberately separate and cannot
        // mutate the non-restored passkey floor.
        await targetRuntime.query(
          `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.human_principals SET status = 'active' WHERE principal_id = $1`,
          [principalId],
        );
        await targetRuntime.query(
          `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
           SET state = 'active' WHERE binding_id = $1`,
          [bindingId],
        );
        await targetRuntime.query(
          `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants SET lifecycle = 'active' WHERE grant_id = $1`,
          [grantId],
        );
        expect(floors.verifyCurrentPasskey(keyA)).toEqual({ allowed: false, reason: 'not_current' });
        expect(floors.verifyCurrentPasskey(keyB)).toMatchObject({ allowed: true, generation: 3 });
      } finally {
        await targetRuntime.end();
      }
    } finally {
      await sourceMigration.end();
      await sourceRuntime.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('rejects an old backup after floor loss and fresh provisioning before floor or database mutation', async () => {
    const source = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: source.migrationUrl, roles: ROLES });
    const sourceMigration = createPostgresPool(source.migrationUrl, { max: 1 });
    const sourceRuntime = createPostgresPool(source.runtimeUrl, { max: 1 });
    const root = mkdtempSync(join(tmpdir(), 'psfn-fleet-auth-lineage-'));
    const systemDataDir = join(root, 'system-data');
    const backupDir = join(root, 'backup');
    const oldFloorRoot = join(root, 'authority-a');
    const newFloorRoot = join(root, 'authority-b');
    const principalId = randomUUID();
    try {
      mkdirSync(systemDataDir, { recursive: true });
      mkdirSync(oldFloorRoot, { mode: 0o700 });
      mkdirSync(newFloorRoot, { mode: 0o700 });
      chmodSync(oldFloorRoot, 0o700);
      chmodSync(newFloorRoot, 0o700);
      copyFileSync(
        join(process.cwd(), 'config', 'fleet-auth.seed.json'),
        join(systemDataDir, 'fleet-auth.json'),
      );
      const oldFloors = new FleetAuthAuthorityFloorStore(oldFloorRoot);
      const oldFloor = oldFloors.open({
        activationGeneration: 1,
        databaseHasDurableAuthority: false,
      });
      await reconcileFleetAuthAuthorityState(sourceRuntime, oldFloor, randomUUID());
      await sourceMigration.query(`
        CREATE SCHEMA companion_alpha;
        CREATE TABLE companion_alpha.snapshot_probe (value TEXT NOT NULL);
        INSERT INTO companion_alpha.snapshot_probe VALUES ('source');
        CREATE SCHEMA shared;
        CREATE TABLE shared.snapshot_probe (value TEXT NOT NULL);
        INSERT INTO shared.snapshot_probe VALUES ('source');
        GRANT USAGE ON SCHEMA companion_alpha, shared TO ${quoteIdentifier(ROLES.backupRestore)};
        GRANT SELECT ON ALL TABLES IN SCHEMA companion_alpha, shared TO ${quoteIdentifier(ROLES.backupRestore)};
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
          { kind: 'companion', schema: 'companion_alpha' },
          { kind: 'shared', schema: 'shared' },
        ],
        systemDataDir,
        backupDir,
      });
      oldFloors.revokeAccountAuthority({
        kind: 'contact_binding',
        resourceId: 'revoked-after-backup',
        reason: 'prove rollback fence survived after snapshot',
        at: '2026-07-15T16:00:00.000Z',
      });
      rmSync(oldFloorRoot, { recursive: true, force: true });

      const target = await freshDatabase();
      await migrateFleetAuthSchema({ databaseUrl: target.migrationUrl, roles: ROLES });
      const targetRuntime = createPostgresPool(target.runtimeUrl, { max: 1 });
      try {
        const newFloors = new FleetAuthAuthorityFloorStore(newFloorRoot);
        const newFloor = newFloors.open({
          activationGeneration: 1,
          databaseHasDurableAuthority: false,
        });
        expect(newFloor.trustedHost.lineageId).not.toBe(oldFloor.trustedHost.lineageId);
        await reconcileFleetAuthAuthorityState(targetRuntime, newFloor, randomUUID());
        const floorBefore = newFloors.read();
        const stateBefore = await targetRuntime.query(
          `SELECT * FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state`,
        );

        await expect(restoreFleetAuthSnapshot({
          manifestPath: backup.manifestPath,
          databaseUrl: target.backupUrl,
          roles: ROLES,
          authorityFloors: newFloors,
          activationGeneration: 1,
          restoredAt: '2026-07-15T17:00:00.000Z',
        })).rejects.toThrow(/backup authority lineage does not match/i);

        expect(newFloors.read()).toEqual(floorBefore);
        const stateAfter = await targetRuntime.query(
          `SELECT * FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state`,
        );
        expect(stateAfter.rows).toEqual(stateBefore.rows);
        const principals = await targetRuntime.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals`,
        );
        expect(principals.rows[0]?.count).toBe('0');
      } finally {
        await targetRuntime.end();
      }
    } finally {
      await sourceMigration.end();
      await sourceRuntime.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
