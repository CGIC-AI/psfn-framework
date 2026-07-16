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
import {
  createGatewayProviderRevocationAuthorityPort,
  reconcileFleetAuthAuthorityState,
} from './gateway-persistence.js';
import { executeAccountReapproval } from './reapproval.js';
import { FleetAuthLifecycleWitnessStore } from './lifecycle-witness.js';
import { PostgresFleetAuthBrokerStore } from './oauth-session-store.js';
import { PostgresHubDeviceAssertionReplayStore } from './hub-device-assertion-replay.js';
import { FLEET_AUTH_RECONCILE_FUNCTION_NAME } from './authority-reconciliation-sql.js';
import { PostgresDiscordEvidenceStore } from './discord-evidence-store.js';
import { digestDiscordEvidence } from '../../../boundary/fleet-auth/discord-evidence-types.js';
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

function accountReapprovalScope(input: {
  principalId: string;
  providerSubjectId: string;
  companionId: string;
  contactId: string;
  bindingId: string;
  roleGrantId: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
  authorityLineageId: string;
  authorityGeneration: number;
  restoreCheckpoint: number;
  companionVersion?: number;
  bindingVersion?: number;
  roleGrantVersion?: number;
}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    principalId: input.principalId,
    provider: 'discord',
    providerSubjectId: input.providerSubjectId,
    companionId: input.companionId,
    contactId: input.contactId,
    bindingId: input.bindingId,
    roleGrantId: input.roleGrantId,
    role: input.role,
    companionVersion: input.companionVersion ?? 1,
    bindingVersion: input.bindingVersion ?? 1,
    roleGrantVersion: input.roleGrantVersion ?? 1,
    authorityLineageId: input.authorityLineageId,
    authorityGeneration: input.authorityGeneration,
    restoreCheckpoint: input.restoreCheckpoint,
  };
}

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    for (const role of [...Object.values(ROLES), COMPANION_ROLE]) {
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT CONNECTION LIMIT 16 PASSWORD '${PASSWORDS[role as keyof typeof PASSWORDS]}'`,
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

async function reconcileThroughCoordinator(
  backupUrl: string,
  floor: Parameters<typeof reconcileFleetAuthAuthorityState>[1],
): Promise<void> {
  const backup = createPostgresPool(backupUrl, { max: 1 });
  try {
    await reconcileFleetAuthAuthorityState(backup, floor, randomUUID());
  } finally {
    await backup.end();
  }
}

async function waitForBackendLock(pool: import('pg').Pool, pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ wait_event_type: string | null }>(
      `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    );
    if (result.rows[0]?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`PostgreSQL backend ${pid} did not block on the authority lock`);
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
      expect(ledger.rows.map(row => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
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
        'companion_authority_state',
        'discord_evidence_lifecycle_fences',
        'discord_evidence_snapshots',
        'human_principals',
        'hub_device_assertion_replays',
        'jit_authorization_grants',
        'lifecycle_decision_receipts',
        'oauth_transactions',
        'passkey_credentials',
        'principal_contact_bindings',
        'principal_merge_aliases',
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

  it('persists and loads only exact, current, positive Discord evidence', async () => {
    const db = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });
    const runtime = createPostgresPool(db.runtimeUrl, { max: 1, allowExitOnIdle: true });
    const principalId = randomUUID();
    const companionId = randomUUID();
    const providerSubjectId = '123456789012345678';
    const guildId = '223456789012345678';
    const channelId = '323456789012345678';
    const lifecycleId = randomUUID();
    const permissionInputs = {
      oauthGuildMembership: { guildId, roleIds: [], observedAt: '2026-07-16T12:00:00.000Z' },
      observation: { status: 'observed', botUserId: '423456789012345678' },
      target: { status: 'current' },
    };
    const inputDigest = digestDiscordEvidence(permissionInputs);
    const configDigest = 'a'.repeat(64);
    const fetchedAt = new Date('2026-07-16T12:00:00.000Z');
    const expiresAt = new Date('2026-07-16T12:05:00.000Z');
    try {
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
           (principal_id, status, authority_generation)
         VALUES ($1, 'active', 1)`,
        [principalId],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
           (provider, subject_id, principal_id, state, authority_generation)
         VALUES ('discord', $1, $2, 'active', 1)`,
        [providerSubjectId, principalId],
      );
      const store = new PostgresDiscordEvidenceStore(runtime, {
        sessionAuthorityGenerationIsCurrent: generation => generation === 1,
      });
      await store.activatePrincipalEvidenceLifecycle({
        principalId,
        providerSubjectId,
        lifecycleId,
      });
      await store.replacePrincipalEvidence({
        principalId,
        providerSubjectId,
        mutation: { lifecycleId, generation: 1 },
        snapshots: [{
          evidenceId: randomUUID(),
          principalId,
          provider: 'discord',
          providerSubjectId,
          companionId,
          guildId,
          channelId,
          permissionInputs,
          discordPermissionResult: true,
          memberSpecificDenyVeto: false,
          psfnEvidenceResult: true,
          inputDigest,
          configDigest,
          mappingConfigVersion: 1,
          provenance: {
            source: 'discord_oauth_and_bot_observation',
            provider: 'discord',
            providerSubjectId,
            observationStatus: 'observed',
            observedAt: fetchedAt.toISOString(),
            oauthObservedAt: fetchedAt.toISOString(),
            observationId: 'integration-observation',
            botUserId: '423456789012345678',
          },
          fetchedAt,
          expiresAt,
        }],
      });
      const lookup = {
        principalId,
        providerSubjectId,
        companionId,
        guildId,
        channelId,
        expectedInputDigest: inputDigest,
        expectedConfigDigest: configDigest,
        expectedMappingConfigVersion: 1,
        now: new Date('2026-07-16T12:04:59.999Z'),
      };
      await expect(store.loadUsablePositiveEvidence(lookup)).resolves.toMatchObject({
        providerSubjectId,
        companionId,
        permissionInputs,
        provenance: { source: 'discord_oauth_and_bot_observation' },
        fetchedAt,
        expiresAt,
      });
      await expect(store.loadUsablePositiveEvidence({
        ...lookup,
        expectedInputDigest: 'b'.repeat(64),
      })).resolves.toBeUndefined();
      await expect(store.loadUsablePositiveEvidence({
        ...lookup,
        now: expiresAt,
      })).resolves.toBeUndefined();
    } finally {
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('atomically consumes one Hub assertion and distinguishes replay from mutated reuse', async () => {
    const db = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });
    const pool = createPostgresPool(db.runtimeUrl, { max: 8, allowExitOnIdle: true });
    const store = new PostgresHubDeviceAssertionReplayStore(pool);
    const input = {
      issuer: 'psfn-satellite-hub',
      jti: randomUUID(),
      assertionDigest: 'a'.repeat(64),
      deviceId: 'office-device',
      enrollmentVersion: 7,
      expiresAt: new Date(Date.now() + 30_000),
    };
    try {
      const outcomes = await Promise.all(Array.from({ length: 8 }, () => store.consume(input)));
      expect(outcomes.filter(result => result.outcome === 'consumed')).toHaveLength(1);
      expect(outcomes.filter(result => result.outcome === 'replayed')).toHaveLength(7);
      await expect(store.consume({ ...input, assertionDigest: 'b'.repeat(64) }))
        .resolves.toEqual({ outcome: 'mismatch' });
      const audit = await pool.query<{
        assertion_digest: string;
        replay_count: string;
        last_replayed_at: Date | null;
        mismatch_count: string;
        last_mismatch_digest: string | null;
        last_mismatch_at: Date | null;
      }>(`
        SELECT assertion_digest, replay_count, last_replayed_at,
               mismatch_count, last_mismatch_digest, last_mismatch_at
        FROM ${FLEET_AUTH_SCHEMA_NAME}.hub_device_assertion_replays
        WHERE issuer = $1 AND jti = $2
      `, [input.issuer, input.jti]);
      expect(audit.rows).toEqual([expect.objectContaining({
        assertion_digest: input.assertionDigest,
        replay_count: '7',
        last_replayed_at: expect.any(Date),
        mismatch_count: '1',
        last_mismatch_digest: 'b'.repeat(64),
        last_mismatch_at: expect.any(Date),
      })]);
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

  it('rejects every dangerous PostgreSQL role attribute on runtime, migration, and backup authorities before schema/data work', async () => {
    if (!harness) throw new Error('Postgres harness unavailable');
    const db = await freshDatabase();
    const probeRoles: FleetAuthDatabaseRoles = {
      runtime: 'probe_fleet_runtime',
      migration: 'probe_fleet_migration',
      backupRestore: 'probe_fleet_backup',
    };
    const probePassword = 'probe-password';
    const probeUrl = (role: keyof FleetAuthDatabaseRoles): string => {
      const url = new URL(db.adminUrl);
      url.username = probeRoles[role];
      url.password = probePassword;
      return url.toString();
    };
    const authorities: Array<{
      role: keyof FleetAuthDatabaseRoles;
      run: () => Promise<unknown>;
    }> = [
      {
        role: 'migration',
        run: () => migrateFleetAuthSchema({ databaseUrl: probeUrl('migration'), roles: probeRoles }),
      },
      {
        role: 'runtime',
        run: () => assertFleetAuthRuntimePrivileges(probeUrl('runtime'), probeRoles),
      },
      {
        role: 'backupRestore',
        run: () => assertFleetAuthBackupRestorePrivileges(probeUrl('backupRestore'), probeRoles),
      },
    ];
    const forbiddenAttributes = [
      'SUPERUSER',
      'CREATEROLE',
      'CREATEDB',
      'REPLICATION',
      'BYPASSRLS',
    ] as const;
    const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
    try {
      for (const role of Object.values(probeRoles)) {
        await admin.query(
          `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT CONNECTION LIMIT 16 PASSWORD '${probePassword}'`,
        );
      }
      // A least-privilege LOGIN role with none of the forbidden attributes must
      // still reach the normal preflight (and fail only later on the missing
      // fleet_auth schema/privileges), proving the attribute gate does not
      // over-reject valid roles.
      await expect(assertFleetAuthRuntimePrivileges(probeUrl('runtime'), probeRoles))
        .rejects.toThrow(/least-privilege boundary|fleet_auth/i);

      for (const attribute of forbiddenAttributes) {
        for (const { role, run } of authorities) {
          await admin.query(
            `ALTER ROLE ${quoteIdentifier(probeRoles[role])} WITH ${attribute}`,
          );
          try {
            await expect(run()).rejects.toThrow(
              new RegExp(`must not hold cluster authority attributes: [A-Z, ]*${attribute}`),
            );
          } finally {
            await admin.query(
              `ALTER ROLE ${quoteIdentifier(probeRoles[role])} WITH NO${attribute}`,
            );
          }
        }
      }
    } finally {
      for (const role of Object.values(probeRoles)) {
        await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`).catch(() => undefined);
      }
      await admin.end();
    }
  }, TIMEOUT_MS);

  it('denies a REPLICATION runtime role that can otherwise create a physical replication slot', async () => {
    if (!harness) throw new Error('Postgres harness unavailable');
    const db = await freshDatabase();
    const probeRoles: FleetAuthDatabaseRoles = {
      runtime: 'probe_repl_runtime',
      migration: 'probe_repl_migration',
      backupRestore: 'probe_repl_backup',
    };
    const probePassword = 'probe-password';
    const runtimeUrl = (() => {
      const url = new URL(db.adminUrl);
      url.username = probeRoles.runtime;
      url.password = probePassword;
      return url.toString();
    })();
    const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
    const slotName = `probe_slot_${randomUUID().replaceAll('-', '')}`;
    try {
      for (const role of Object.values(probeRoles)) {
        await admin.query(
          `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT REPLICATION CONNECTION LIMIT 16 PASSWORD '${probePassword}'`,
        );
      }
      // The preflight must reject the REPLICATION runtime credential before any
      // schema/data work.
      await expect(assertFleetAuthRuntimePrivileges(runtimeUrl, probeRoles))
        .rejects.toThrow(/must not hold cluster authority attributes: [A-Z, ]*REPLICATION/);

      // Prove the danger the gate blocks is real: the same REPLICATION login
      // role can create a physical replication slot (WAL disclosure and
      // storage-exhaustion vector) once it is allowed to connect and act.
      const replica = createPostgresPool(runtimeUrl, { max: 1 });
      try {
        await replica.query('SELECT pg_create_physical_replication_slot($1)', [slotName]);
        const slots = await replica.query<{ slot_name: string }>(
          `SELECT slot_name FROM pg_replication_slots WHERE slot_name = $1`,
          [slotName],
        );
        expect(slots.rows.map(row => row.slot_name)).toEqual([slotName]);
      } finally {
        await replica.query('SELECT pg_drop_replication_slot($1)', [slotName]).catch(() => undefined);
        await replica.end();
      }
    } finally {
      for (const role of Object.values(probeRoles)) {
        await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`).catch(() => undefined);
      }
      await admin.end();
    }
  }, TIMEOUT_MS);

  it('rejects unsafe login posture and target-database ownership for every authority role', async () => {
    if (!harness) throw new Error('Postgres harness unavailable');
    const db = await freshDatabase();
    const databaseName = decodeURIComponent(new URL(db.adminUrl).pathname.slice(1));
    const probeRoles: FleetAuthDatabaseRoles = {
      runtime: 'probe_posture_runtime',
      migration: 'probe_posture_migration',
      backupRestore: 'probe_posture_backup',
    };
    const probePassword = 'probe-password';
    const probeUrl = (role: keyof FleetAuthDatabaseRoles): string => {
      const url = new URL(db.adminUrl);
      url.username = probeRoles[role];
      url.password = probePassword;
      return url.toString();
    };
    const authorities: Array<{
      role: keyof FleetAuthDatabaseRoles;
      run: () => Promise<unknown>;
    }> = [
      {
        role: 'migration',
        run: () => migrateFleetAuthSchema({ databaseUrl: probeUrl('migration'), roles: probeRoles }),
      },
      {
        role: 'runtime',
        run: () => assertFleetAuthRuntimePrivileges(probeUrl('runtime'), probeRoles),
      },
      {
        role: 'backupRestore',
        run: () => assertFleetAuthBackupRestorePrivileges(probeUrl('backupRestore'), probeRoles),
      },
    ];
    const unsafePostures = [
      {
        unsafe: 'INHERIT',
        reset: 'NOINHERIT',
        expected: /must be NOINHERIT, credential-valid, finite CONNECTION LIMIT >= 1/,
      },
      {
        unsafe: "VALID UNTIL '2000-01-01'",
        reset: "VALID UNTIL 'infinity'",
        expected: /credential-valid|password authentication failed/,
      },
      {
        unsafe: 'CONNECTION LIMIT -1',
        reset: 'CONNECTION LIMIT 16',
        expected: /must be NOINHERIT, credential-valid, finite CONNECTION LIMIT >= 1/,
      },
      {
        unsafe: 'CONNECTION LIMIT 0',
        reset: 'CONNECTION LIMIT 16',
        expected: /finite CONNECTION LIMIT|too many connections for role/,
      },
    ] as const;
    const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
    try {
      for (const role of Object.values(probeRoles)) {
        await admin.query(
          `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT CONNECTION LIMIT 16 PASSWORD '${probePassword}'`,
        );
      }
      for (const { role, run } of authorities) {
        for (const posture of unsafePostures) {
          await admin.query(
            `ALTER ROLE ${quoteIdentifier(probeRoles[role])} WITH ${posture.unsafe}`,
          );
          try {
            await expect(run()).rejects.toThrow(posture.expected);
          } finally {
            await admin.query(
              `ALTER ROLE ${quoteIdentifier(probeRoles[role])} WITH ${posture.reset}`,
            );
          }
        }

        await admin.query(
          `ALTER DATABASE ${quoteIdentifier(databaseName)} OWNER TO ${quoteIdentifier(probeRoles[role])}`,
        );
        try {
          await expect(run()).rejects.toThrow(/must not own the target database/);
        } finally {
          await admin.query(
            `ALTER DATABASE ${quoteIdentifier(databaseName)} OWNER TO postgres`,
          );
        }
      }
    } finally {
      await admin.query(
        `ALTER DATABASE ${quoteIdentifier(databaseName)} OWNER TO postgres`,
      ).catch(() => undefined);
      for (const role of Object.values(probeRoles)) {
        await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`).catch(() => undefined);
      }
      await admin.end();
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
      await expect(runtime.query(
        `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.authority_state
         SET authority_generation = authority_generation + 1 WHERE singleton = TRUE`,
      )).rejects.toThrow(/permission denied/);
      await expect(runtime.query(
        `DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state WHERE singleton = TRUE`,
      )).rejects.toThrow(/permission denied/);
      await expect(runtime.query(
        `SELECT * FROM ${FLEET_AUTH_RECONCILE_FUNCTION_NAME}($1, 1000, 1000, 1, $2)`,
        ['a'.repeat(64), randomUUID()],
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
        .rejects.toThrow(/must have no role memberships or SET ROLE targets/);
    } finally {
      await admin.query(
        `REVOKE ${quoteIdentifier(ROLES.migration)} FROM ${quoteIdentifier(ROLES.runtime)}`,
      );
      await admin.end();
    }
  }, TIMEOUT_MS);

  it('rejects direct and transitive membership in external roles, including server-program authority', async () => {
    if (!harness) throw new Error('Postgres harness unavailable');
    const db = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });
    const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
    const bridgeRole = `probe_bridge_${randomUUID().replaceAll('-', '')}`;
    try {
      await admin.query(`CREATE ROLE ${quoteIdentifier(bridgeRole)} NOLOGIN`);
      await admin.query(
        `GRANT pg_execute_server_program TO ${quoteIdentifier(bridgeRole)}`,
      );
      await admin.query(
        `GRANT ${quoteIdentifier(bridgeRole)} TO ${quoteIdentifier(ROLES.runtime)}`,
      );
      await expect(assertFleetAuthRuntimePrivileges(db.runtimeUrl, ROLES))
        .rejects.toThrow(/must have no role memberships.*pg_execute_server_program/i);
    } finally {
      await admin.query(
        `REVOKE ${quoteIdentifier(bridgeRole)} FROM ${quoteIdentifier(ROLES.runtime)}`,
      ).catch(() => undefined);
      await admin.query(
        `REVOKE pg_execute_server_program FROM ${quoteIdentifier(bridgeRole)}`,
      ).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(bridgeRole)}`).catch(() => undefined);
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
          .rejects.toThrow(/no role memberships|unexpected role membership.*fleet auth authority/i);
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

  it('preserves history-only provider ownership when the backup role restores immutable history', async () => {
    const db = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });
    const backup = createPostgresPool(db.backupUrl, { max: 1 });
    const runtime = createPostgresPool(db.runtimeUrl, { max: 1 });
    const historicalPrincipalId = randomUUID();
    const replacementPrincipalId = randomUUID();
    const subjectId = '123456789012345680';
    try {
      await backup.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_history
          (event_id, provider, subject_id, principal_id, state, event_type,
           authority_generation, payload)
         VALUES ($1, 'discord', $2, $3, 'revoked', 'unlinked', 1, '{}')`,
        [randomUUID(), subjectId, historicalPrincipalId],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          (principal_id, status, authority_generation)
         VALUES ($1, 'pending', 1)`,
        [replacementPrincipalId],
      );
      await expect(runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
          (provider, subject_id, principal_id, state, authority_generation)
         VALUES ('discord', $1, $2, 'pending', 1)`,
        [subjectId, replacementPrincipalId],
      )).rejects.toThrow(/permanently bound to another principal/);
    } finally {
      await backup.end();
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
    // The runtime role can no longer mint trusted-host ceremonies; the schema
    // owner (migration role) authors this fixture ceremony instead.
    const migration = createPostgresPool(db.migrationUrl, { max: 1 });
    const principalId = randomUUID();
    const sessionId = randomUUID();
    const companionId = randomUUID();
    const floorRoot = mkdtempSync(join(tmpdir(), 'psfn-fleet-auth-reenable-'));
    chmodSync(floorRoot, 0o700);
    try {
      const floors = new FleetAuthAuthorityFloorStore(floorRoot);
      const lifecycle = new FleetAuthLifecycleWitnessStore(floorRoot);
      const initialFloor = floors.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
      lifecycle.publishEnabled(
        lifecycle.prepareEnable(),
        initialFloor.trustedHost.lineageId,
        null,
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          (principal_id, status, authority_generation)
         VALUES ($1, 'active', 1)`,
        [principalId],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
          (provider, subject_id, principal_id, state, authority_generation)
         VALUES ('discord', '123456789012345678', $1, 'active', 1)`,
        [principalId],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
          (record_id, token_digest, csrf_digest, principal_id, audience, assurance,
           authn_version, authz_version, provider, provider_subject_id,
           global_auth_epoch, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, 'garden', 'oauth', 1, 1,
                 'discord', '123456789012345678', 1,
                 clock_timestamp() + interval '5 minutes', clock_timestamp() + interval '1 hour')`,
        [sessionId, '1'.repeat(64), '2'.repeat(64), principalId],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
          (transaction_id, state_digest, initiating_browser_digest, pkce_verifier_digest,
           callback_uri, return_path, global_auth_epoch, expires_at)
         VALUES ($1, $2, $3, $4, 'https://fleet.example.test/oauth/callback', '/garden', 1,
                 clock_timestamp() + interval '5 minutes')`,
        [randomUUID(), '3'.repeat(64), '4'.repeat(64), '5'.repeat(64)],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_token_custody
          (custody_id, principal_id, provider_subject_id, encrypted_token,
           key_version, global_auth_epoch, expires_at)
         VALUES ($1, $2, '123456789012345678', decode('aa', 'hex'), 1, 1,
                 clock_timestamp() + interval '5 minutes')`,
        [randomUUID(), principalId],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_snapshots
          (evidence_id, principal_id, provider_subject_id, companion_id, guild_id,
           permission_inputs, discord_permission_result, member_specific_deny_veto,
           psfn_evidence_result, input_digest, config_digest, provenance, global_auth_epoch,
           fetched_at, expires_at)
         VALUES ($1, $2, '123456789012345678', $3, '223456789012345678',
                 '{"oauthGuildMembership":{},"observation":{},"target":{}}', TRUE,
                 FALSE, TRUE, $4, $5,
                 '{"source":"discord_oauth_and_bot_observation","provider":"discord","providerSubjectId":"123456789012345678","observationStatus":"observed","observedAt":"2026-07-16T12:00:00.000Z","oauthObservedAt":"2026-07-16T12:00:00.000Z","observationId":"fixture","botUserId":"423456789012345678"}',
                 1, clock_timestamp(),
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
      await migration.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
          (ceremony_id, nonce_digest, kind, expected_provider_subject_id, exact_scope,
           global_auth_epoch, expires_at)
         VALUES ($1, $2, 'account_reapproval', '123456789012345678', '{}', 1,
                 clock_timestamp() + interval '5 minutes')`,
        [randomUUID(), 'a'.repeat(64)],
      );

      expect(lifecycle.prepareEnable(initialFloor.trustedHost.lineageId).lifecycleTransitionId)
        .toBeUndefined();
      const ordinaryRestart = floors.open({
        activationGeneration: 1,
        databaseHasDurableAuthority: true,
      });
      await reconcileThroughCoordinator(db.backupUrl, ordinaryRestart);
      const beforeDisable = await runtime.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions`,
      );
      expect(beforeDisable.rows[0]?.count).toBe('1');

      lifecycle.recordDisabledIfPresent();
      const lifecyclePreparation = lifecycle.prepareEnable(initialFloor.trustedHost.lineageId);
      const { lifecycleTransitionId } = lifecyclePreparation;
      expect(lifecycleTransitionId).toMatch(/^[0-9a-f]{64}$/);
      if (!lifecycleTransitionId) throw new Error('disable transition was not recorded');
      const reenabled = floors.open({
        activationGeneration: 1,
        databaseHasDurableAuthority: true,
        lifecycleTransitionId,
      });
      await reconcileThroughCoordinator(db.backupUrl, reenabled);
      lifecycle.publishEnabled(
        lifecyclePreparation,
        reenabled.trustedHost.lineageId,
        reenabled.trustedHost.lastLifecycleTransitionId,
      );

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
           ('discord_evidence_lifecycle_fences', (SELECT COUNT(*) FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_lifecycle_fences)),
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
      await migration.end();
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
      await reconcileThroughCoordinator(db.backupUrl, floor);
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
          { kind: 'companion', schema: 'companion_alpha', ownerRole: COMPANION_ROLE, runtimeRoles: [COMPANION_ROLE] },
          { kind: 'shared', schema: 'shared', ownerRole: COMPANION_ROLE, runtimeRoles: [COMPANION_ROLE] },
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
    const sourceCoordinator = createPostgresPool(source.backupUrl, { max: 1 });
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
      await reconcileThroughCoordinator(source.backupUrl, sourceFloor);
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
          { kind: 'companion', schema: 'companion_alpha', ownerRole: COMPANION_ROLE, runtimeRoles: [COMPANION_ROLE] },
          { kind: 'shared', schema: 'shared', ownerRole: COMPANION_ROLE, runtimeRoles: [COMPANION_ROLE] },
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
      const browserStore = new PostgresFleetAuthBrokerStore({
        pool: sourceRuntime,
        providerAuthorityPool: sourceCoordinator,
        sessionPepper: 'browser-revocation-session-pepper-32-bytes',
        tokenEncryptionKey: 'browser-revocation-token-key-32-bytes',
        providerRevocationAuthority: createGatewayProviderRevocationAuthorityPort(floors),
      });
      const transactionId = randomUUID();
      await browserStore.createOAuthTransaction({
        transactionId,
        stateDigest: 'a'.repeat(64),
        initiatingBrowserDigest: 'b'.repeat(64),
        pkceVerifier: 'restore-proof-pkce-verifier',
        callbackUri: 'https://fleet.example.test/auth/discord/callback',
        returnPath: '/fleet',
        kind: 'login',
        createdAt: new Date('2026-07-15T11:20:00.000Z'),
        expiresAt: new Date('2026-07-15T11:25:00.000Z'),
      });
      await browserStore.consumeOAuthTransaction({
        stateDigest: 'a'.repeat(64),
        initiatingBrowserDigest: 'b'.repeat(64),
        now: new Date('2026-07-15T11:21:00.000Z'),
      });
      const browserSession = await browserStore.createLoginSession({
        transactionId,
        providerSubjectId: '123456789012345678',
        providerMetadata: {},
        token: 'browser-provider-revocation-token',
        csrfToken: 'browser-provider-revocation-csrf',
        audience: 'fleet',
        now: new Date('2026-07-15T11:21:00.000Z'),
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      });
      await browserStore.revokeProvider({
        token: browserSession.token,
        csrfToken: browserSession.csrfToken,
        now: new Date('2026-07-15T11:30:00.000Z'),
        reasonDigest: 'e'.repeat(64),
      });
      expect(floors.isAccountAuthorityTombstoned(
        'provider_subject',
        'discord:123456789012345678',
      )).toBe(true);

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
      // The runtime role can no longer mint trusted-host ceremonies; the schema
      // owner (migration role) authors the fixture ceremony below.
      const targetMigration = createPostgresPool(target.migrationUrl, { max: 1 });
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

        // The raw restore-quarantine bypass is now impossible: ordinary runtime
        // SQL cannot reactivate a quarantined restore candidate. Every attempt
        // is fenced by restore_quarantine_activation_guard.
        await expect(targetRuntime.query(
          `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.human_principals SET status = 'active' WHERE principal_id = $1`,
          [principalId],
        )).rejects.toThrow(/reapprove_account_authority/);
        await expect(targetRuntime.query(
          `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
           SET state = 'active' WHERE binding_id = $1`,
          [bindingId],
        )).rejects.toThrow(/reapprove_account_authority/);
        await expect(targetRuntime.query(
          `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants SET lifecycle = 'active' WHERE grant_id = $1`,
          [grantId],
        )).rejects.toThrow(/reapprove_account_authority/);

        // The constrained ceremony also refuses this account: its provider
        // subject was tombstoned after the backup, so no reapproval can promote
        // it. The denial leaves every row untouched.
        const epochRow = await targetRuntime.query<{ global_auth_epoch: string }>(
          `SELECT global_auth_epoch FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state WHERE singleton = TRUE`,
        );
        const currentEpoch = Number(epochRow.rows[0]!.global_auth_epoch);
        const ceremonyId = randomUUID();
        await targetMigration.query(
          `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
            (ceremony_id, nonce_digest, kind, expected_provider_subject_id,
             expected_companion_id, expected_contact_id, exact_scope,
             global_auth_epoch, expires_at)
           VALUES ($1, $2, 'account_reapproval', '123456789012345678',
                   '11111111-1111-4111-8111-111111111111', 'contact-owner', '{}',
                   $3, clock_timestamp() + interval '5 minutes')`,
          [ceremonyId, 'c'.repeat(64), currentEpoch],
        );
        await expect(executeAccountReapproval(targetRuntime, {
          ceremonyId,
          principalId,
          provider: 'discord',
          providerSubjectId: '123456789012345678',
          companionId: '11111111-1111-4111-8111-111111111111',
          contactId: 'contact-owner',
          bindingId,
          roleGrantId: grantId,
          auditEventId: randomUUID(),
          at: '2026-07-15T12:30:00.000Z',
        })).rejects.toThrow(/tombstoned/i);
        const afterDenial = await targetRuntime.query<{ status: string; restore_state: string }>(
          `SELECT status, restore_state FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals WHERE principal_id = $1`,
          [principalId],
        );
        expect(afterDenial.rows[0]).toEqual({ status: 'quarantined', restore_state: 'quarantined' });

        // Reapproval never touches the non-restored passkey floor.
        expect(floors.verifyCurrentPasskey(keyA)).toEqual({ allowed: false, reason: 'not_current' });
        expect(floors.verifyCurrentPasskey(keyB)).toMatchObject({ allowed: true, generation: 3 });
      } finally {
        await targetRuntime.end();
        await targetMigration.end();
      }
    } finally {
      await sourceMigration.end();
      await sourceRuntime.end();
      await sourceCoordinator.end();
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
      await reconcileThroughCoordinator(source.backupUrl, oldFloor);
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
          { kind: 'companion', schema: 'companion_alpha', ownerRole: COMPANION_ROLE, runtimeRoles: [COMPANION_ROLE] },
          { kind: 'shared', schema: 'shared', ownerRole: COMPANION_ROLE, runtimeRoles: [COMPANION_ROLE] },
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
        await reconcileThroughCoordinator(target.backupUrl, newFloor);
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

  it('reapproves a clean quarantined account through the trusted-host ceremony and fences every bypass', async () => {
    const db = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });
    const runtime = createPostgresPool(db.runtimeUrl, { max: 1 });
    // The runtime role can no longer mint trusted-host ceremonies; the schema
    // owner (migration role) authors the fixture ceremonies below. The runtime
    // pool still invokes the reapproval procedure via EXECUTE.
    const migration = createPostgresPool(db.migrationUrl, { max: 1 });
    const floorRoot = mkdtempSync(join(tmpdir(), 'psfn-fleet-auth-reapprove-'));
    chmodSync(floorRoot, 0o700);
    const principalId = randomUUID();
    const bindingId = randomUUID();
    const grantId = randomUUID();
    const companionId = randomUUID();
    const subjectId = '123456789012345678';
    const passkeyHash = 'd'.repeat(64);
    try {
      const floors = new FleetAuthAuthorityFloorStore(floorRoot);
      const floor = floors.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
      await reconcileThroughCoordinator(db.backupUrl, floor);
      const exactScope = accountReapprovalScope({
        principalId,
        providerSubjectId: subjectId,
        companionId,
        contactId: 'contact-owner',
        bindingId,
        roleGrantId: grantId,
        role: 'owner',
        authorityLineageId: floor.trustedHost.lineageId,
        authorityGeneration: floor.trustedHost.authorityGeneration,
        restoreCheckpoint: floor.trustedHost.restoreCheckpoint,
      });

      await migration.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
          (companion_id, lifecycle, authority_generation, restore_state)
         VALUES ($1, 'quarantined', 1, 'quarantined')`,
        [companionId],
      );

      // A quarantined restore candidate: principal + provider subject + binding + role.
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          (principal_id, status, authority_generation, restore_state)
         VALUES ($1, 'quarantined', 1, 'quarantined')`,
        [principalId],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
          (provider, subject_id, principal_id, state, authority_generation, restore_state)
         VALUES ('discord', $1, $2, 'quarantined', 1, 'quarantined')`,
        [subjectId, principalId],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
          (binding_id, principal_id, companion_id, contact_id, state,
           verification_provenance, authority_generation, restore_state)
         VALUES ($1, $2, $3, 'contact-owner', 'quarantined', '{"kind":"verified"}', 1, 'quarantined')`,
        [bindingId, principalId, companionId],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
          (grant_id, principal_id, companion_id, role, lifecycle, authority_generation, restore_state)
         VALUES ($1, $2, $3, 'owner', 'quarantined', 1, 'quarantined')`,
        [grantId, principalId, companionId],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.passkey_credentials
          (credential_id_hash, principal_id, expected_provider_subject_id, rp_id,
           public_key_projection, credential_generation, state, authority_floor_generation,
           restore_state)
         VALUES ($1, $2, $3, 'fleet.example.test', 'verifier', 1, 'quarantined', 1, 'quarantined')`,
        [passkeyHash, principalId, subjectId],
      );

      // The SECURITY DEFINER procedure itself (not only the gateway wrapper)
      // denies restored principal/companion identities projected from the
      // non-restored authority floor.
      for (const [index, kind, resourceId] of [
        [0, 'principal', principalId],
        [1, 'companion', companionId],
      ] as const) {
        const tombstonedCeremonyId = randomUUID();
        await migration.query(`
          INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authority_floor_tombstone_projection
            (kind, resource_hash, authority_generation)
          VALUES ($1, encode(sha256(convert_to($2, 'UTF8')), 'hex'), 1)
        `, [kind, resourceId]);
        await migration.query(`
          INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
            (ceremony_id, nonce_digest, kind, expected_provider_subject_id,
             expected_companion_id, expected_contact_id, exact_scope,
             global_auth_epoch, expires_at)
          VALUES ($1, $2, 'account_reapproval', $3, $4, 'contact-owner', $5::jsonb,
                  1, clock_timestamp() + interval '5 minutes')
        `, [
          tombstonedCeremonyId,
          String(index + 7).repeat(64),
          subjectId,
          companionId,
          JSON.stringify(exactScope),
        ]);
        await expect(executeAccountReapproval(runtime, {
          ceremonyId: tombstonedCeremonyId,
          principalId,
          provider: 'discord',
          providerSubjectId: subjectId,
          companionId,
          contactId: 'contact-owner',
          bindingId,
          roleGrantId: grantId,
          auditEventId: randomUUID(),
          at: '2026-07-15T11:55:00.000Z',
        })).rejects.toThrow(/tombstoned by the non-restored floor/);
        await migration.query(`
          DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_floor_tombstone_projection
          WHERE kind = $1
        `, [kind]);
        await migration.query(`
          DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
          WHERE ceremony_id = $1
        `, [tombstonedCeremonyId]);
      }

      // Direct runtime SQL cannot escalate any quarantined row.
      await expect(runtime.query(
        `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.human_principals SET status = 'active' WHERE principal_id = $1`,
        [principalId],
      )).rejects.toThrow(/reapprove_account_authority/);
      await expect(runtime.query(
        `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.human_principals SET restore_state = 'live' WHERE principal_id = $1`,
        [principalId],
      )).rejects.toThrow(/reapprove_account_authority/);
      await expect(runtime.query(
        `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.human_principals
         SET authority_generation = authority_generation + 5 WHERE principal_id = $1`,
        [principalId],
      )).rejects.toThrow(/reapprove_account_authority/);
      await expect(runtime.query(
        `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.passkey_credentials SET state = 'pending' WHERE credential_id_hash = $1`,
        [passkeyHash],
      )).rejects.toThrow(/passkey projection cannot be reactivated/);

      // A ceremony bound to a different provider subject cannot promote this account.
      const wrongCeremonyId = randomUUID();
      await migration.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
          (ceremony_id, nonce_digest, kind, expected_provider_subject_id, exact_scope,
           global_auth_epoch, expires_at)
         VALUES ($1, $2, 'account_reapproval', '123456789012345679', '{}', 1,
                 clock_timestamp() + interval '5 minutes')`,
        [wrongCeremonyId, 'e'.repeat(64)],
      );
      await expect(executeAccountReapproval(runtime, {
        ceremonyId: wrongCeremonyId,
        principalId,
        provider: 'discord',
        providerSubjectId: subjectId,
        companionId,
        contactId: 'contact-owner',
        bindingId,
        roleGrantId: grantId,
        auditEventId: randomUUID(),
        at: '2026-07-15T12:00:00.000Z',
      })).rejects.toThrow(/does not bind the requested account/);

      // The ceremony must bind the exact grant and role; a guest-scoped
      // ceremony cannot promote a quarantined owner grant.
      const wrongRoleCeremonyId = randomUUID();
      await migration.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
          (ceremony_id, nonce_digest, kind, expected_provider_subject_id,
           expected_companion_id, expected_contact_id, exact_scope,
           global_auth_epoch, expires_at)
         VALUES ($1, $2, 'account_reapproval', $3, $4, 'contact-owner', $5::jsonb, 1,
                 clock_timestamp() + interval '5 minutes')`,
        [
          wrongRoleCeremonyId,
          'a'.repeat(64),
          subjectId,
          companionId,
          JSON.stringify({ ...exactScope, role: 'guest' }),
        ],
      );
      await expect(executeAccountReapproval(runtime, {
        ceremonyId: wrongRoleCeremonyId,
        principalId,
        provider: 'discord',
        providerSubjectId: subjectId,
        companionId,
        contactId: 'contact-owner',
        bindingId,
        roleGrantId: grantId,
        auditEventId: randomUUID(),
        at: '2026-07-15T12:00:00.000Z',
      })).rejects.toThrow(/exact scope/);

      // Even an otherwise exact ceremony becomes unusable after the authority
      // epoch advances. The caller cannot replay a trusted-host decision from
      // a stale floor projection.
      const staleCeremonyId = randomUUID();
      await migration.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
          (ceremony_id, nonce_digest, kind, expected_provider_subject_id,
           expected_companion_id, expected_contact_id, exact_scope,
           global_auth_epoch, expires_at)
         VALUES ($1, $2, 'account_reapproval', $3, $4, 'contact-owner', $5::jsonb, 2,
                 clock_timestamp() + interval '5 minutes')`,
        [staleCeremonyId, 'c'.repeat(64), subjectId, companionId, JSON.stringify(exactScope)],
      );
      await expect(executeAccountReapproval(runtime, {
        ceremonyId: staleCeremonyId,
        principalId,
        provider: 'discord',
        providerSubjectId: subjectId,
        companionId,
        contactId: 'contact-owner',
        bindingId,
        roleGrantId: grantId,
        auditEventId: randomUUID(),
        at: '2026-07-15T12:00:00.000Z',
      })).rejects.toThrow(/stale auth epoch/);

      // Expiry is database-owned. Backdating the caller-provided event time
      // cannot revive an already expired ceremony.
      const expiredCeremonyId = randomUUID();
      await migration.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
          (ceremony_id, nonce_digest, kind, expected_provider_subject_id,
           expected_companion_id, expected_contact_id, exact_scope,
           global_auth_epoch, created_at, expires_at)
         VALUES ($1, $2, 'account_reapproval', $3, $4, 'contact-owner', $5::jsonb, 1,
                 clock_timestamp() - interval '2 seconds',
                 clock_timestamp() - interval '1 second')`,
        [expiredCeremonyId, 'b'.repeat(64), subjectId, companionId, JSON.stringify(exactScope)],
      );
      await expect(executeAccountReapproval(runtime, {
        ceremonyId: expiredCeremonyId,
        principalId,
        provider: 'discord',
        providerSubjectId: subjectId,
        companionId,
        contactId: 'contact-owner',
        bindingId,
        roleGrantId: grantId,
        auditEventId: randomUUID(),
        at: '2000-01-01T00:00:00.000Z',
      })).rejects.toThrow(/expired/);

      // Expiry must be rechecked after every durable authority row lock has
      // been acquired. Otherwise a ceremony that was current when this
      // function began can expire while waiting and still be consumed.
      const lockExpiredCeremonyId = randomUUID();
      const lockExpiredAuditEventId = randomUUID();
      await migration.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
          (ceremony_id, nonce_digest, kind, expected_provider_subject_id,
           expected_companion_id, expected_contact_id, exact_scope,
           global_auth_epoch, expires_at)
         VALUES ($1, $2, 'account_reapproval', $3, $4, 'contact-owner', $5::jsonb, 1,
                 clock_timestamp() + interval '1 second')`,
        [
          lockExpiredCeremonyId,
          '9'.repeat(64),
          subjectId,
          companionId,
          JSON.stringify(exactScope),
        ],
      );
      const runtimeBackend = await runtime.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      const blocker = await migration.connect();
      const observer = createPostgresPool(db.adminUrl, { max: 1, allowExitOnIdle: true });
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          `SELECT singleton FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
           WHERE singleton = TRUE FOR UPDATE`,
        );
        const blockedReapproval = executeAccountReapproval(runtime, {
          ceremonyId: lockExpiredCeremonyId,
          principalId,
          provider: 'discord',
          providerSubjectId: subjectId,
          companionId,
          contactId: 'contact-owner',
          bindingId,
          roleGrantId: grantId,
          auditEventId: lockExpiredAuditEventId,
          at: '2000-01-01T00:00:00.000Z',
        });
        await waitForBackendLock(observer, runtimeBackend.rows[0]!.pid);
        await blocker.query(`SELECT pg_sleep(1.25)`);
        await blocker.query('COMMIT');

        await expect(blockedReapproval).rejects.toThrow(/expired/);

        const unchanged = await runtime.query<{
          principal_status: string;
          subject_state: string;
          binding_state: string;
          grant_lifecycle: string;
          global_auth_epoch: string;
          ceremony_status: string;
          audit_count: string;
        }>(`
          SELECT
            (SELECT status FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals
             WHERE principal_id = $1) AS principal_status,
            (SELECT state FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
             WHERE provider = 'discord' AND subject_id = $2) AS subject_state,
            (SELECT state FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
             WHERE binding_id = $3) AS binding_state,
            (SELECT lifecycle FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
             WHERE grant_id = $4) AS grant_lifecycle,
            (SELECT global_auth_epoch::text FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
             WHERE singleton = TRUE) AS global_auth_epoch,
            (SELECT status FROM ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
             WHERE ceremony_id = $5) AS ceremony_status,
            (SELECT COUNT(*)::text FROM ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
             WHERE event_id = $6) AS audit_count
        `, [
          principalId,
          subjectId,
          bindingId,
          grantId,
          lockExpiredCeremonyId,
          lockExpiredAuditEventId,
        ]);
        expect(unchanged.rows[0]).toEqual({
          principal_status: 'quarantined',
          subject_state: 'quarantined',
          binding_state: 'quarantined',
          grant_lifecycle: 'quarantined',
          global_auth_epoch: '1',
          ceremony_status: 'pending',
          audit_count: '0',
        });
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        blocker.release();
        await observer.end();
      }

      // The exact ceremony reapproves the account atomically.
      const ceremonyId = randomUUID();
      await migration.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
          (ceremony_id, nonce_digest, kind, expected_provider_subject_id,
           expected_companion_id, expected_contact_id, exact_scope,
           global_auth_epoch, expires_at)
         VALUES ($1, $2, 'account_reapproval', $3, $4, 'contact-owner', $5::jsonb, 1,
                 clock_timestamp() + interval '5 minutes')`,
        [ceremonyId, 'f'.repeat(64), subjectId, companionId, JSON.stringify(exactScope)],
      );
      const result = await executeAccountReapproval(runtime, {
        ceremonyId,
        principalId,
        provider: 'discord',
        providerSubjectId: subjectId,
        companionId,
        contactId: 'contact-owner',
        bindingId,
        roleGrantId: grantId,
        auditEventId: randomUUID(),
        at: '2026-07-15T12:05:00.000Z',
      });
      expect(result).toMatchObject({
        globalAuthEpoch: 2,
        authnVersion: 2,
        authzVersion: 2,
        bindingVersion: 2,
        roleVersion: 2,
      });

      const principal = await runtime.query<{ status: string; restore_state: string }>(
        `SELECT status, restore_state FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals WHERE principal_id = $1`,
        [principalId],
      );
      expect(principal.rows[0]).toEqual({ status: 'active', restore_state: 'live' });
      const provider = await runtime.query<{ state: string; restore_state: string }>(
        `SELECT state, restore_state FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects WHERE subject_id = $1`,
        [subjectId],
      );
      expect(provider.rows[0]).toEqual({ state: 'active', restore_state: 'live' });
      const binding = await runtime.query<{ state: string; restore_state: string; version: string }>(
        `SELECT state, restore_state, version::text AS version
         FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings WHERE binding_id = $1`,
        [bindingId],
      );
      expect(binding.rows[0]).toEqual({ state: 'active', restore_state: 'live', version: '2' });
      const role = await runtime.query<{ lifecycle: string; restore_state: string }>(
        `SELECT lifecycle, restore_state FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants WHERE grant_id = $1`,
        [grantId],
      );
      expect(role.rows[0]).toEqual({ lifecycle: 'active', restore_state: 'live' });
      const companion = await runtime.query<{
        lifecycle: string;
        restore_state: string;
        version: string;
      }>(`
        SELECT lifecycle, restore_state, version::text AS version
        FROM ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
        WHERE companion_id = $1
      `, [companionId]);
      expect(companion.rows[0]).toEqual({
        lifecycle: 'active',
        restore_state: 'live',
        version: '2',
      });
      const audit = await runtime.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
         WHERE action = 'authority.reapprove' AND decision = 'allow' AND principal_id = $1
           AND global_auth_epoch = 2`,
        [principalId],
      );
      expect(audit.rows[0]?.count).toBe('1');
      const state = await runtime.query<{ global_auth_epoch: string }>(
        `SELECT global_auth_epoch FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state WHERE singleton = TRUE`,
      );
      expect(state.rows[0]?.global_auth_epoch).toBe('2');
      const consumed = await runtime.query<{ status: string }>(
        `SELECT status FROM ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies WHERE ceremony_id = $1`,
        [ceremonyId],
      );
      expect(consumed.rows[0]?.status).toBe('consumed');
      const passkey = await runtime.query<{ state: string; restore_state: string }>(
        `SELECT state, restore_state FROM ${FLEET_AUTH_SCHEMA_NAME}.passkey_credentials WHERE credential_id_hash = $1`,
        [passkeyHash],
      );
      expect(passkey.rows[0]).toEqual({ state: 'quarantined', restore_state: 'quarantined' });

      // Replay is denied: the ceremony is consumed and the epoch has advanced.
      await expect(executeAccountReapproval(runtime, {
        ceremonyId,
        principalId,
        provider: 'discord',
        providerSubjectId: subjectId,
        companionId,
        contactId: 'contact-owner',
        bindingId,
        roleGrantId: grantId,
        auditEventId: randomUUID(),
        at: '2026-07-15T12:10:00.000Z',
      })).rejects.toThrow(/not pending/);

      // A second restored account can join the now-live companion without
      // advancing the independent companion resource version again.
      const secondPrincipalId = randomUUID();
      const secondBindingId = randomUUID();
      const secondGrantId = randomUUID();
      const secondSubjectId = '223456789012345678';
      await runtime.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          (principal_id, status, authority_generation, restore_state)
        VALUES ($1, 'quarantined', 1, 'quarantined')
      `, [secondPrincipalId]);
      await runtime.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
          (provider, subject_id, principal_id, state, authority_generation, restore_state)
        VALUES ('discord', $1, $2, 'quarantined', 1, 'quarantined')
      `, [secondSubjectId, secondPrincipalId]);
      await runtime.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
          (binding_id, principal_id, companion_id, contact_id, state,
           verification_provenance, authority_generation, restore_state)
        VALUES ($1, $2, $3, 'contact-member', 'quarantined',
                '{"kind":"verified"}', 1, 'quarantined')
      `, [secondBindingId, secondPrincipalId, companionId]);
      await runtime.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
          (grant_id, principal_id, companion_id, role, lifecycle,
           authority_generation, restore_state)
        VALUES ($1, $2, $3, 'member', 'quarantined', 1, 'quarantined')
      `, [secondGrantId, secondPrincipalId, companionId]);
      const secondCeremonyId = randomUUID();
      const secondScope = accountReapprovalScope({
        principalId: secondPrincipalId,
        providerSubjectId: secondSubjectId,
        companionId,
        contactId: 'contact-member',
        bindingId: secondBindingId,
        roleGrantId: secondGrantId,
        role: 'member',
        companionVersion: 2,
        authorityLineageId: floor.trustedHost.lineageId,
        authorityGeneration: floor.trustedHost.authorityGeneration,
        restoreCheckpoint: floor.trustedHost.restoreCheckpoint,
      });
      await migration.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
          (ceremony_id, nonce_digest, kind, expected_provider_subject_id,
           expected_companion_id, expected_contact_id, exact_scope,
           global_auth_epoch, expires_at)
        VALUES ($1, $2, 'account_reapproval', $3, $4, 'contact-member', $5::jsonb,
                2, clock_timestamp() + interval '5 minutes')
      `, [
        secondCeremonyId,
        '2'.repeat(64),
        secondSubjectId,
        companionId,
        JSON.stringify(secondScope),
      ]);
      await expect(executeAccountReapproval(runtime, {
        ceremonyId: secondCeremonyId,
        principalId: secondPrincipalId,
        provider: 'discord',
        providerSubjectId: secondSubjectId,
        companionId,
        contactId: 'contact-member',
        bindingId: secondBindingId,
        roleGrantId: secondGrantId,
        auditEventId: randomUUID(),
        at: '2026-07-15T12:15:00.000Z',
      })).resolves.toMatchObject({ globalAuthEpoch: 3 });
      const companionAfterSecond = await runtime.query<{
        lifecycle: string;
        restore_state: string;
        version: string;
      }>(`
        SELECT lifecycle, restore_state, version::text AS version
        FROM ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
        WHERE companion_id = $1
      `, [companionId]);
      expect(companionAfterSecond.rows[0]).toEqual({
        lifecycle: 'active',
        restore_state: 'live',
        version: '2',
      });

      // A removed companion can never be reactivated as a side effect of
      // reapproving one of its restored accounts.
      await migration.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
        SET lifecycle = 'removed', version = version + 1
        WHERE companion_id = $1
      `, [companionId]);
      const thirdPrincipalId = randomUUID();
      const thirdCeremonyId = randomUUID();
      await runtime.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          (principal_id, status, authority_generation, restore_state)
        VALUES ($1, 'quarantined', 1, 'quarantined')
      `, [thirdPrincipalId]);
      await runtime.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
          (provider, subject_id, principal_id, state, authority_generation, restore_state)
        VALUES ('discord', '323456789012345678', $1, 'quarantined', 1, 'quarantined')
      `, [thirdPrincipalId]);
      await migration.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
          (ceremony_id, nonce_digest, kind, expected_provider_subject_id,
           expected_companion_id, expected_contact_id, exact_scope,
           global_auth_epoch, expires_at)
        VALUES ($1, $2, 'account_reapproval', '323456789012345678', $3,
                'contact-removed', '{}'::jsonb, 3,
                clock_timestamp() + interval '5 minutes')
      `, [thirdCeremonyId, '3'.repeat(64), companionId]);
      await expect(executeAccountReapproval(runtime, {
        ceremonyId: thirdCeremonyId,
        principalId: thirdPrincipalId,
        provider: 'discord',
        providerSubjectId: '323456789012345678',
        companionId,
        contactId: 'contact-removed',
        bindingId: randomUUID(),
        roleGrantId: randomUUID(),
        auditEventId: randomUUID(),
        at: '2026-07-15T12:20:00.000Z',
      })).rejects.toThrow(/companion authority is not reapprovable/);
    } finally {
      await runtime.end();
      await migration.end();
      rmSync(floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('rejects runtime DELETE+INSERT and fresh-PK INSERT quarantine reactivation of contact bindings and role grants', async () => {
    const db = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });
    const runtime = createPostgresPool(db.runtimeUrl, { max: 1 });
    const principalId = randomUUID();
    const bindingId = randomUUID();
    const grantId = randomUUID();
    const companionId = randomUUID();
    try {
      // A quarantined restore candidate: principal + one binding + one role.
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          (principal_id, status, authority_generation, restore_state)
         VALUES ($1, 'quarantined', 1, 'quarantined')`,
        [principalId],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
          (binding_id, principal_id, companion_id, contact_id, state,
           verification_provenance, authority_generation, restore_state)
         VALUES ($1, $2, $3, 'contact-owner', 'quarantined', '{"kind":"verified"}', 1, 'quarantined')`,
        [bindingId, principalId, companionId],
      );
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
          (grant_id, principal_id, companion_id, role, lifecycle, authority_generation, restore_state)
         VALUES ($1, $2, $3, 'owner', 'quarantined', 1, 'quarantined')`,
        [grantId, principalId, companionId],
      );

      // Runtime cannot DELETE a quarantined row to clear its unique-index slot.
      await expect(runtime.query(
        `DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings WHERE binding_id = $1`,
        [bindingId],
      )).rejects.toThrow(/quarantined fleet_auth authority row can only be removed/);
      await expect(runtime.query(
        `DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants WHERE grant_id = $1`,
        [grantId],
      )).rejects.toThrow(/quarantined fleet_auth authority row can only be removed/);

      // Runtime cannot INSERT a fresh live/active authority row for a quarantined
      // principal (a distinct contact_id isolates the trigger as the sole
      // rejector, so no unique index masks the guard).
      await expect(runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
          (binding_id, principal_id, companion_id, contact_id, state,
           verification_provenance, authority_generation, restore_state)
         VALUES ($1, $2, $3, 'reactivation-attempt', 'active', '{"kind":"verified"}', 1, 'live')`,
        [randomUUID(), principalId, companionId],
      )).rejects.toThrow(/live fleet_auth authority row for a quarantined principal/);
      await expect(runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
          (grant_id, principal_id, companion_id, role, lifecycle, authority_generation, restore_state)
         VALUES ($1, $2, $3, 'owner', 'active', 1, 'live')`,
        [randomUUID(), principalId, companionId],
      )).rejects.toThrow(/live fleet_auth authority row for a quarantined principal/);

      // The rows remain quarantined; no reactivation happened.
      const binding = await runtime.query<{ state: string; restore_state: string }>(
        `SELECT state, restore_state FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings WHERE binding_id = $1`,
        [bindingId],
      );
      expect(binding.rows[0]).toEqual({ state: 'quarantined', restore_state: 'quarantined' });
      const role = await runtime.query<{ lifecycle: string; restore_state: string }>(
        `SELECT lifecycle, restore_state FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants WHERE grant_id = $1`,
        [grantId],
      );
      expect(role.rows[0]).toEqual({ lifecycle: 'quarantined', restore_state: 'quarantined' });
    } finally {
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('denies runtime INSERT on trusted_host_ceremonies and blocks a self-minted reapproval', async () => {
    const db = await freshDatabase();
    await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });
    // The privilege matrix must still pass with runtime lacking ceremony INSERT.
    await expect(assertFleetAuthRuntimePrivileges(db.runtimeUrl, ROLES)).resolves.toBeUndefined();
    const runtime = createPostgresPool(db.runtimeUrl, { max: 1 });
    const floorRoot = mkdtempSync(join(tmpdir(), 'psfn-fleet-auth-noceremony-'));
    chmodSync(floorRoot, 0o700);
    const principalId = randomUUID();
    try {
      // Provision authority lineage so a reapproval attempt reaches the ceremony
      // gate rather than failing earlier on an unprovisioned lineage.
      const floors = new FleetAuthAuthorityFloorStore(floorRoot);
      const floor = floors.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
      await reconcileThroughCoordinator(db.backupUrl, floor);

      // Runtime can no longer author a trusted-host ceremony.
      await expect(runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
          (ceremony_id, nonce_digest, kind, expected_provider_subject_id, exact_scope,
           global_auth_epoch, expires_at)
         VALUES ($1, $2, 'account_reapproval', '123456789012345678', '{}', 1,
                 clock_timestamp() + interval '5 minutes')`,
        [randomUUID(), '1'.repeat(64)],
      )).rejects.toThrow(/permission denied/);

      // Unable to mint a ceremony, a runtime reapproval attempt cannot pass the
      // ceremony-consumption gate: the procedure raises before any mutation.
      await runtime.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          (principal_id, status, authority_generation, restore_state)
         VALUES ($1, 'quarantined', 1, 'quarantined')`,
        [principalId],
      );
      await expect(executeAccountReapproval(runtime, {
        ceremonyId: randomUUID(),
        principalId,
        provider: 'discord',
        providerSubjectId: '123456789012345678',
        companionId: randomUUID(),
        contactId: 'contact-owner',
        bindingId: randomUUID(),
        roleGrantId: randomUUID(),
        auditEventId: randomUUID(),
        at: '2026-07-15T12:00:00.000Z',
      })).rejects.toThrow(/ceremony not found/);
    } finally {
      await runtime.end();
      rmSync(floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
