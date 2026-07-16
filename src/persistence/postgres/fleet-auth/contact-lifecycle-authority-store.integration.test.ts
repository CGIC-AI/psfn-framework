import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContactLifecycleAuthorityDeniedError } from '../../../boundary/gateway/contact-lifecycle-authority.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../../postgres.js';
import { FleetAuthAuthorityFloorStore } from './authority-floor.js';
import {
  createGatewayAccountAuthorityFencePort,
  reconcileFleetAuthAuthorityState,
} from './gateway-persistence.js';
import { migrateFleetAuthSchema, type FleetAuthDatabaseRoles } from './schema.js';
import { PostgresContactLifecycleAuthorityStore } from './contact-lifecycle-authority-store.js';

const TIMEOUT_MS = 120_000;
const ROLES: FleetAuthDatabaseRoles = {
  runtime: 'contact_lifecycle_runtime',
  migration: 'contact_lifecycle_migration',
  backupRestore: 'contact_lifecycle_backup',
};
const PASSWORDS = {
  contact_lifecycle_runtime: 'runtime-password',
  contact_lifecycle_migration: 'migration-password',
  contact_lifecycle_backup: 'backup-password',
} as const;
const COMPANION_ID = '4b90c2e6-0663-4f01-9965-9d228fa848bd';
const OTHER_COMPANION_ID = 'ff6c6900-45ea-41e0-8fde-5412c380a439';
const SUBJECT_ID = '123456789012345678';

let harness: PostgresTestHarness | null = null;
const roots: string[] = [];

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
        `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT CONNECTION LIMIT 16 PASSWORD '${PASSWORDS[role as keyof typeof PASSWORDS]}'`,
      );
    }
  } finally {
    await admin.end();
  }
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
  roots.forEach(root => rmSync(root, { recursive: true, force: true }));
}, TIMEOUT_MS);

async function createFixture(options: { withBinding?: boolean } = {}): Promise<{
  store: PostgresContactLifecycleAuthorityStore;
  coordinator: Pool;
  migration: Pool;
  floors: FleetAuthAuthorityFloorStore;
  principalId: string;
  bindingId: string;
  grantId: string;
  close(): Promise<void>;
}> {
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
  const migration = createPostgresPool(migrationUrl, { max: 1 });
  const coordinator = createPostgresPool(
    roleUrl(database.databaseUrl, ROLES.backupRestore),
    { max: 4 },
  );
  const root = mkdtempSync(join(tmpdir(), 'contact-lifecycle-floor-'));
  roots.push(root);
  const floors = new FleetAuthAuthorityFloorStore(root);
  const floor = floors.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
  await reconcileFleetAuthAuthorityState(coordinator, floor, randomUUID());
  const principalId = randomUUID();
  const bindingId = randomUUID();
  const grantId = randomUUID();
  await migration.query(`
    INSERT INTO fleet_auth.companion_authority_state
      (companion_id, lifecycle, version, authority_generation, restore_state)
    VALUES ($1, 'active', 1, 1, 'live'), ($2, 'active', 1, 1, 'live')
  `, [COMPANION_ID, OTHER_COMPANION_ID]);
  if (options.withBinding !== false) {
    await coordinator.query(`
      INSERT INTO fleet_auth.human_principals
        (principal_id, status, authn_version, authz_version, authority_generation,
         restore_state)
      VALUES ($1, 'active', 1, 1, 1, 'live')
    `, [principalId]);
    await coordinator.query(`
      INSERT INTO fleet_auth.provider_subjects
        (provider, subject_id, principal_id, state, authority_generation, restore_state)
      VALUES ('discord', $2, $1, 'active', 1, 'live')
    `, [principalId, SUBJECT_ID]);
    await coordinator.query(`
      INSERT INTO fleet_auth.principal_contact_bindings
        (binding_id, principal_id, companion_id, contact_id, state,
         verification_provenance, authority_generation, restore_state)
      VALUES ($2, $1, $3, 'contact-a', 'active', '{}'::jsonb, 1, 'live')
    `, [principalId, bindingId, COMPANION_ID]);
    await coordinator.query(`
      INSERT INTO fleet_auth.principal_role_grants
        (grant_id, principal_id, companion_id, role, lifecycle,
         authority_generation, restore_state)
      VALUES ($2, $1, $3, 'owner', 'active', 1, 'live')
    `, [principalId, grantId, COMPANION_ID]);
  }
  const accountAuthority = createGatewayAccountAuthorityFencePort(floors);
  const store = new PostgresContactLifecycleAuthorityStore({
    pool: coordinator,
    accountAuthority,
    reconcileExternalFloor: async () => {
      await reconcileFleetAuthAuthorityState(coordinator, floors.read(), randomUUID());
    },
  });
  return {
    store,
    coordinator,
    migration,
    floors,
    principalId,
    bindingId,
    grantId,
    close: async () => {
      await Promise.all([coordinator.end(), migration.end()]);
    },
  };
}

describe('Postgres contact lifecycle authority', () => {
  it('serializes exact prepare replay and denies changed or cross-companion intent reuse', async () => {
    const fixture = await createFixture();
    try {
      const intentId = randomUUID();
      const request = {
        schemaVersion: 1,
        intentId,
        phase: 'prepare',
        action: 'contact.verify',
        contactId: 'contact-a',
        providerSubjectId: SUBJECT_ID,
      } as const;
      const [first, replay] = await Promise.all([
        fixture.store.executeForCompanion(COMPANION_ID, request),
        fixture.store.executeForCompanion(COMPANION_ID, request),
      ]);
      expect(replay).toEqual(first);
      expect(first.status).toBe('reserved');
      await expect(fixture.store.executeForCompanion(COMPANION_ID, {
        ...request,
        intentId: randomUUID(),
      })).rejects.toMatchObject({ reasonCode: 'contact_resource_fenced' });
      await expect(fixture.store.executeForCompanion(COMPANION_ID, {
        ...request,
        contactId: 'changed-contact',
      })).rejects.toMatchObject({ reasonCode: 'changed_intent_reuse' });
      await expect(fixture.store.executeForCompanion(OTHER_COMPANION_ID, request))
        .rejects.toMatchObject({ reasonCode: 'cross_companion_intent_reuse' });

      await expect(fixture.coordinator.query(`
        UPDATE fleet_auth.principal_contact_bindings SET state = 'active'
        WHERE binding_id = $1
      `, [fixture.bindingId])).rejects.toThrow(/contact authority is fenced/u);
      const finalRequest = {
        ...request,
        phase: 'finalize',
        postState: { schemaVersion: 1, state: 'verified', contactVersion: 2 },
      } as const;
      const finalized = await fixture.store.executeForCompanion(COMPANION_ID, finalRequest);
      expect(finalized.status).toBe('finalized');
      expect(await fixture.store.executeForCompanion(COMPANION_ID, finalRequest))
        .toEqual(finalized);
      await expect(fixture.coordinator.query(`
        UPDATE fleet_auth.contact_authority_intents SET intent_digest = $2
        WHERE intent_id = $1
      `, [intentId, 'f'.repeat(64)])).rejects.toThrow(/invalid contact authority intent transition/u);
      await expect(fixture.coordinator.query(`
        DELETE FROM fleet_auth.contact_authority_intents WHERE intent_id = $1
      `, [intentId])).rejects.toThrow(/contact authority intents are durable/u);
      await expect(fixture.coordinator.query(`
        INSERT INTO fleet_auth.contact_authority_receipts
          (companion_id, intent_id, phase, request_digest, result,
           authority_generation, global_auth_epoch, audit_event_id)
        VALUES ($1, $2, 'prepare', $3, '{}'::jsonb, 1, 1, $4)
      `, [COMPANION_ID, intentId, 'e'.repeat(64), first.auditEventId]))
        .rejects.toThrow(/receipt does not match its exact ledger tuple/u);
      await expect(fixture.coordinator.query(`
        UPDATE fleet_auth.principal_contact_bindings SET state = 'active'
        WHERE binding_id = $1
      `, [fixture.bindingId])).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await fixture.close();
    }
  }, TIMEOUT_MS);

  it('revokes exact unlink authority at prepare and retains terminal contact/subject fences', async () => {
    const fixture = await createFixture();
    try {
      const intentId = randomUUID();
      const prepared = await fixture.store.executeForCompanion(COMPANION_ID, {
        schemaVersion: 1,
        intentId,
        phase: 'prepare',
        action: 'contact.discord_unlink',
        contactId: 'contact-a',
        providerSubjectId: SUBJECT_ID,
      });
      expect(prepared.status).toBe('prepared');
      expect(prepared.authorityGeneration).toBe(2);
      const rows = await fixture.coordinator.query<{
        binding_state: string; grant_state: string; subject_state: string;
      }>(`
        SELECT binding.state AS binding_state, role_grant.lifecycle AS grant_state,
               subject.state AS subject_state
        FROM fleet_auth.principal_contact_bindings AS binding
        JOIN fleet_auth.principal_role_grants AS role_grant
          ON role_grant.principal_id = binding.principal_id
         AND role_grant.companion_id = binding.companion_id
        JOIN fleet_auth.provider_subjects AS subject
          ON subject.principal_id = binding.principal_id
        WHERE binding.binding_id = $1
      `, [fixture.bindingId]);
      expect(rows.rows[0]).toEqual({
        binding_state: 'revoked', grant_state: 'revoked', subject_state: 'revoked',
      });
      await fixture.store.executeForCompanion(COMPANION_ID, {
        schemaVersion: 1,
        intentId,
        phase: 'finalize',
        action: 'contact.discord_unlink',
        contactId: 'contact-a',
        providerSubjectId: SUBJECT_ID,
        postState: { schemaVersion: 1, state: 'unlinked', contactVersion: 2 },
      });
      await expect(fixture.coordinator.query(`
        UPDATE fleet_auth.principal_contact_bindings SET state = 'active'
        WHERE binding_id = $1
      `, [fixture.bindingId])).rejects.toThrow(/contact authority is fenced/u);
      await expect(fixture.coordinator.query(`
        UPDATE fleet_auth.provider_subjects SET state = 'active'
        WHERE provider = 'discord' AND subject_id = $1
      `, [SUBJECT_ID])).rejects.toThrow(/provider subject authority is fenced/u);
    } finally {
      await fixture.close();
    }
  }, TIMEOUT_MS);

  it('durably records no_binding only after installing the destructive fence', async () => {
    const fixture = await createFixture({ withBinding: false });
    try {
      const result = await fixture.store.executeForCompanion(COMPANION_ID, {
        schemaVersion: 1,
        intentId: randomUUID(),
        phase: 'prepare',
        action: 'contact.delete',
        contactId: 'absent-contact',
      });
      expect(result.status).toBe('no_binding');
      expect(result.authorityGeneration).toBe(2);
      expect(fixture.floors.isAccountAuthorityTombstoned(
        'contact_authority_fence',
        `contact:${COMPANION_ID}:absent-contact`,
      )).toBe(true);
    } finally {
      await fixture.close();
    }
  }, TIMEOUT_MS);

  it('never manufactures a binding or role while finalizing verified contact ownership', async () => {
    const fixture = await createFixture({ withBinding: false });
    try {
      const intentId = randomUUID();
      await fixture.store.executeForCompanion(COMPANION_ID, {
        schemaVersion: 1,
        intentId,
        phase: 'prepare',
        action: 'contact.verify',
        contactId: 'contact-a',
        providerSubjectId: SUBJECT_ID,
      });
      await fixture.store.executeForCompanion(COMPANION_ID, {
        schemaVersion: 1,
        intentId,
        phase: 'finalize',
        action: 'contact.verify',
        contactId: 'contact-a',
        providerSubjectId: SUBJECT_ID,
        postState: { schemaVersion: 1, state: 'verified', contactVersion: 2 },
      });
      const authority = await fixture.coordinator.query<{
        binding_count: string;
        role_count: string;
      }>(`
        SELECT
          (SELECT count(*)::text FROM fleet_auth.principal_contact_bindings) AS binding_count,
          (SELECT count(*)::text FROM fleet_auth.principal_role_grants) AS role_count
      `);
      expect(authority.rows.at(0)).toEqual({ binding_count: '0', role_count: '0' });
    } finally {
      await fixture.close();
    }
  }, TIMEOUT_MS);

  it('rolls back database mutation while leaving a published non-restored fence fail closed', async () => {
    const fixture = await createFixture();
    try {
      await fixture.migration.query(`
        CREATE FUNCTION fleet_auth.reject_contact_test_audit() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.action = 'contact.discord_unlink' THEN
            RAISE EXCEPTION 'injected audit failure';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER reject_contact_test_audit
        BEFORE INSERT ON fleet_auth.authorization_audit_events
        FOR EACH ROW EXECUTE FUNCTION fleet_auth.reject_contact_test_audit()
      `);
      await expect(fixture.store.executeForCompanion(COMPANION_ID, {
        schemaVersion: 1,
        intentId: randomUUID(),
        phase: 'prepare',
        action: 'contact.discord_unlink',
        contactId: 'contact-a',
        providerSubjectId: SUBJECT_ID,
      })).rejects.toBeInstanceOf(ContactLifecycleAuthorityDeniedError);
      const intentCount = await fixture.coordinator.query<{ count: string }>(`
        SELECT count(*) FROM fleet_auth.contact_authority_intents
      `);
      expect(intentCount.rows[0]?.count).toBe('0');
      expect(fixture.floors.read().trustedHost.authorityGeneration).toBe(2);
      expect(fixture.floors.isAccountAuthorityTombstoned(
        'contact_authority_fence',
        `contact:${COMPANION_ID}:contact-a`,
      )).toBe(true);
      const projection = await fixture.coordinator.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM fleet_auth.authority_floor_tombstone_projection
        WHERE kind = 'contact_authority_fence'
      `);
      expect(projection.rows[0]?.count).toBe('2');
      await expect(fixture.coordinator.query(`
        UPDATE fleet_auth.principal_contact_bindings SET state = 'active'
        WHERE binding_id = $1
      `, [fixture.bindingId])).rejects.toThrow(/contact authority is fenced/u);
      await expect(fixture.coordinator.query(`
        UPDATE fleet_auth.provider_subjects SET state = 'active'
        WHERE provider = 'discord' AND subject_id = $1
      `, [SUBJECT_ID])).rejects.toThrow(/provider subject authority is fenced/u);
    } finally {
      await fixture.close();
    }
  }, TIMEOUT_MS);
});
