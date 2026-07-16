import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../../postgres.js';
import { digestDiscordEvidence, type DiscordEvidenceSnapshot } from '../../../boundary/fleet-auth/discord-evidence-types.js';
import { migrateFleetAuthSchema, type FleetAuthDatabaseRoles } from './schema.js';
import { PostgresDiscordEvidenceStore } from './discord-evidence-store.js';

const TIMEOUT_MS = 120_000;
const ROLES: FleetAuthDatabaseRoles = {
  runtime: 'fleet_auth_runtime',
  migration: 'fleet_auth_migration',
  backupRestore: 'fleet_auth_backup',
};
const PASSWORDS = {
  fleet_auth_runtime: 'runtime-password',
  fleet_auth_migration: 'migration-password',
  fleet_auth_backup: 'backup-password',
} as const;
const COMPANION_ID = '22222222-2222-4222-8222-222222222222';
const GUILD_ID = '100000000000000002';
const CHANNEL_ID = '100000000000000003';
const BOT_ID = '100000000000000004';
const ROLE_ID = '100000000000000005';
const NOW = new Date('2026-07-16T12:00:00.000Z');

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

function snapshot(principalId: string, providerSubjectId: string): DiscordEvidenceSnapshot {
  const permissionInputs = {
    oauthGuildMembership: {
      observedAt: NOW.toISOString(),
      guildId: GUILD_ID,
      roleIds: [ROLE_ID],
    },
    observation: {
      status: 'observed',
      observationId: 'observation-1',
      observedAt: NOW.toISOString(),
      botUserId: BOT_ID,
    },
    target: { status: 'current' },
  };
  return {
    evidenceId: randomUUID(),
    principalId,
    provider: 'discord',
    providerSubjectId,
    companionId: COMPANION_ID,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    permissionInputs,
    discordPermissionResult: true,
    memberSpecificDenyVeto: false,
    psfnEvidenceResult: true,
    inputDigest: digestDiscordEvidence(permissionInputs),
    configDigest: 'a'.repeat(64),
    mappingConfigVersion: 1,
    provenance: {
      source: 'discord_oauth_and_bot_observation',
      provider: 'discord',
      providerSubjectId,
      observationStatus: 'observed',
      observedAt: NOW.toISOString(),
      oauthObservedAt: NOW.toISOString(),
      observationId: 'observation-1',
      botUserId: BOT_ID,
    },
    fetchedAt: NOW,
    expiresAt: new Date('2026-07-16T12:05:00.000Z'),
  };
}

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    for (const role of Object.values(ROLES)) {
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT CONNECTION LIMIT 16 PASSWORD '${PASSWORDS[role]}'`,
      );
    }
  } finally {
    await admin.end();
  }
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, TIMEOUT_MS);

describe('Postgres Discord evidence authority denial', () => {
  it('denies exact positives after principal quarantine, subject revocation, or epoch advance', async () => {
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
    const migrationUrl = roleUrl(database.databaseUrl, ROLES.migration);
    await migrateFleetAuthSchema({ databaseUrl: migrationUrl, roles: ROLES });
    const runtime = createPostgresPool(roleUrl(database.databaseUrl, ROLES.runtime), { max: 2 });
    const migration = createPostgresPool(migrationUrl, { max: 1 });
    const store = new PostgresDiscordEvidenceStore(runtime, {
      sessionAuthorityGenerationIsCurrent: () => true,
    });
    const identities = [
      { principalId: randomUUID(), subjectId: '100000000000000011', lifecycleId: randomUUID() },
      { principalId: randomUUID(), subjectId: '100000000000000012', lifecycleId: randomUUID() },
      { principalId: randomUUID(), subjectId: '100000000000000013', lifecycleId: randomUUID() },
    ];
    try {
      for (const identity of identities) {
        await migration.query(`
          INSERT INTO fleet_auth.human_principals
            (principal_id, status, authority_generation)
          VALUES ($1, 'active', 1)
        `, [identity.principalId]);
        await migration.query(`
          INSERT INTO fleet_auth.provider_subjects
            (provider, subject_id, principal_id, state, authority_generation)
          VALUES ('discord', $1, $2, 'active', 1)
        `, [identity.subjectId, identity.principalId]);
        await store.activatePrincipalEvidenceLifecycle({
          principalId: identity.principalId,
          providerSubjectId: identity.subjectId,
          lifecycleId: identity.lifecycleId,
        });
        await store.replacePrincipalEvidence({
          principalId: identity.principalId,
          providerSubjectId: identity.subjectId,
          mutation: { lifecycleId: identity.lifecycleId, generation: 1 },
          snapshots: [snapshot(identity.principalId, identity.subjectId)],
        });
      }
      const lookup = (identity: typeof identities[number]) => {
        const evidence = snapshot(identity.principalId, identity.subjectId);
        return store.loadUsablePositiveEvidence({
          principalId: identity.principalId,
          providerSubjectId: identity.subjectId,
          companionId: COMPANION_ID,
          guildId: GUILD_ID,
          channelId: CHANNEL_ID,
          expectedInputDigest: evidence.inputDigest,
          expectedConfigDigest: evidence.configDigest,
          expectedMappingConfigVersion: evidence.mappingConfigVersion,
          now: new Date('2026-07-16T12:04:00.000Z'),
        });
      };
      await expect(lookup(identities[0]!)).resolves.toBeDefined();
      await migration.query(`
        UPDATE fleet_auth.human_principals SET status = 'quarantined' WHERE principal_id = $1
      `, [identities[0]!.principalId]);
      await migration.query(`
        UPDATE fleet_auth.provider_subjects SET state = 'revoked'
        WHERE provider = 'discord' AND subject_id = $1
      `, [identities[1]!.subjectId]);
      await expect(lookup(identities[0]!)).resolves.toBeUndefined();
      await expect(lookup(identities[1]!)).resolves.toBeUndefined();

      await migration.query(`
        UPDATE fleet_auth.authority_state SET global_auth_epoch = global_auth_epoch + 1
        WHERE singleton = TRUE
      `);
      await expect(lookup(identities[2]!)).resolves.toBeUndefined();
    } finally {
      await Promise.all([runtime.end(), migration.end()]);
    }
  }, TIMEOUT_MS);

  it('orders concurrent replace and terminal revoke through the database lifecycle fence', async () => {
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
    const migrationUrl = roleUrl(database.databaseUrl, ROLES.migration);
    await migrateFleetAuthSchema({ databaseUrl: migrationUrl, roles: ROLES });
    const runtime = createPostgresPool(roleUrl(database.databaseUrl, ROLES.runtime), { max: 6 });
    const migration = createPostgresPool(migrationUrl, { max: 1 });
    const authority = { sessionAuthorityGenerationIsCurrent: () => true };
    const replaceStore = new PostgresDiscordEvidenceStore(runtime, authority);
    const revokeStore = new PostgresDiscordEvidenceStore(runtime, authority);
    try {
      for (const [index, operations] of ['replace-first', 'revoke-first'].entries()) {
        const principalId = randomUUID();
        const subjectId = `10000000000000002${index + 1}`;
        const lifecycleId = randomUUID();
        await migration.query(`
          INSERT INTO fleet_auth.human_principals
            (principal_id, status, authority_generation)
          VALUES ($1, 'active', 1)
        `, [principalId]);
        await migration.query(`
          INSERT INTO fleet_auth.provider_subjects
            (provider, subject_id, principal_id, state, authority_generation)
          VALUES ('discord', $1, $2, 'active', 1)
        `, [subjectId, principalId]);
        await replaceStore.activatePrincipalEvidenceLifecycle({
          principalId,
          providerSubjectId: subjectId,
          lifecycleId,
        });
        const replace = () => replaceStore.replacePrincipalEvidence({
          principalId,
          providerSubjectId: subjectId,
          mutation: { lifecycleId, generation: 1 },
          snapshots: [snapshot(principalId, subjectId)],
        });
        const revoke = () => revokeStore.revokePrincipalEvidence({
          principalId,
          providerSubjectId: subjectId,
          mutation: { lifecycleId, generation: 2 },
        });
        const results = await Promise.allSettled(
          operations === 'replace-first' ? [replace(), revoke()] : [revoke(), replace()],
        );
        expect(results.some(result => result.status === 'fulfilled')).toBe(true);
        const count = await runtime.query<{ count: string }>(`
          SELECT COUNT(*)::text AS count
          FROM fleet_auth.discord_evidence_snapshots
          WHERE principal_id = $1 AND provider_subject_id = $2
        `, [principalId, subjectId]);
        expect(count.rows[0]?.count).toBe('0');
        await expect(replaceStore.replacePrincipalEvidence({
          principalId,
          providerSubjectId: subjectId,
          mutation: { lifecycleId, generation: 3 },
          snapshots: [snapshot(principalId, subjectId)],
        })).rejects.toMatchObject({ name: 'StaleDiscordEvidenceLifecycleError' });
      }
    } finally {
      await Promise.all([runtime.end(), migration.end()]);
    }
  }, TIMEOUT_MS);
});
