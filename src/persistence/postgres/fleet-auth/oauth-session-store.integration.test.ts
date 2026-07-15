import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../../postgres.js';
import { migrateFleetAuthSchema, type FleetAuthDatabaseRoles } from './schema.js';
import { PostgresFleetAuthBrokerStore } from './oauth-session-store.js';

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
const PROVIDER_SUBJECT_ID = '123456789012345679';
const NOW = new Date('2026-07-15T12:00:00.000Z');

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

async function createStore(): Promise<{
  store: PostgresFleetAuthBrokerStore;
  runtime: import('pg').Pool;
  migration: import('pg').Pool;
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
  await migrateFleetAuthSchema({
    databaseUrl: migrationUrl,
    roles: ROLES,
  });
  const runtime = createPostgresPool(roleUrl(database.databaseUrl, ROLES.runtime), {
    max: 4,
    allowExitOnIdle: true,
  });
  return {
    runtime,
    migration: createPostgresPool(migrationUrl, { max: 1, allowExitOnIdle: true }),
    store: new PostgresFleetAuthBrokerStore({
      pool: runtime,
      sessionPepper: 'session-pepper-at-least-thirty-two-bytes',
      tokenEncryptionKey: 'token-encryption-key-at-least-thirty-two-bytes',
    }),
  };
}

async function authenticate(
  store: PostgresFleetAuthBrokerStore,
  suffix: string,
): Promise<{ transactionId: string; token: string; csrfToken: string }> {
  const transactionId = randomUUID();
  const stateDigest = createHash('sha256').update(suffix).digest('hex');
  await store.createOAuthTransaction({
    transactionId,
    stateDigest,
    pkceVerifier: `pkce-verifier-${suffix}`,
    callbackUri: 'https://fleet.example.test/auth/discord/callback',
    returnPath: '/fleet',
    kind: 'login',
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 300_000),
  });
  const consumed = await store.consumeOAuthTransaction(stateDigest, NOW);
  expect(consumed.pkceVerifier).toBe(`pkce-verifier-${suffix}`);
  const token = `token-${suffix}`;
  const csrfToken = `csrf-${suffix}`;
  return { transactionId, token, csrfToken };
}

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    for (const role of Object.values(ROLES)) {
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD '${PASSWORDS[role]}'`,
      );
    }
  } finally {
    await admin.end();
  }
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, TIMEOUT_MS);

describe('Postgres gateway OAuth/session authority', () => {
  it('creates pending no-role principals, rotates once under races, and tombstones provider revocation', async () => {
    const { store, runtime, migration } = await createStore();
    try {
      const loginInput = await authenticate(store, 'first');
      const login = await store.createLoginSession({
        ...loginInput,
        providerSubjectId: PROVIDER_SUBJECT_ID,
        providerMetadata: { mfaEnabled: true },
        audience: 'fleet',
        now: NOW,
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      });
      expect(login.principalStatus).toBe('pending');

      const authority = await runtime.query<{
        status: string;
        bindings: string;
        roles: string;
      }>(`
        SELECT principal.status,
               (SELECT count(*)::text FROM fleet_auth.principal_contact_bindings
                WHERE principal_id = principal.principal_id) AS bindings,
               (SELECT count(*)::text FROM fleet_auth.principal_role_grants
                WHERE principal_id = principal.principal_id) AS roles
        FROM fleet_auth.human_principals AS principal
        WHERE principal.principal_id = $1
      `, [login.principalId]);
      expect(authority.rows[0]).toEqual({ status: 'pending', bindings: '0', roles: '0' });

      const rotations = await Promise.allSettled([
        store.rotateSession({
          token: login.token,
          csrfToken: login.csrfToken,
          nextToken: 'rotated-token-a',
          nextCsrfToken: 'rotated-csrf-a',
          now: new Date(NOW.getTime() + 1000),
          idleTtlMs: 1_800_000,
        }),
        store.rotateSession({
          token: login.token,
          csrfToken: login.csrfToken,
          nextToken: 'rotated-token-b',
          nextCsrfToken: 'rotated-csrf-b',
          now: new Date(NOW.getTime() + 1000),
          idleTtlMs: 1_800_000,
        }),
      ]);
      const winner = rotations.find(result => result.status === 'fulfilled');
      expect(rotations.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(rotations.filter(result => result.status === 'rejected')).toHaveLength(1);
      if (!winner) throw new Error('Session rotation had no winner');

      const freshCsrf = await store.issueCsrf({
        token: winner.value.token,
        nextCsrfToken: 'fresh-csrf-token',
        now: new Date(NOW.getTime() + 2000),
      });
      expect(freshCsrf).toBe('fresh-csrf-token');
      const ceremonyId = randomUUID();
      const companionId = randomUUID();
      await migration.query(`
        INSERT INTO fleet_auth.trusted_host_ceremonies
          (ceremony_id, nonce_digest, kind, expected_provider,
           expected_provider_subject_id, expected_companion_id,
           expected_contact_id, exact_scope, status, global_auth_epoch,
           created_at, expires_at)
        VALUES ($1, $2, 'first_owner', 'discord', $3, $4, 'owner-contact',
                '{"role":"owner"}'::jsonb, 'pending', 1, $5, $6)
      `, [
        ceremonyId,
        'd'.repeat(64),
        PROVIDER_SUBJECT_ID,
        companionId,
        NOW,
        new Date(NOW.getTime() + 300_000),
      ]);
      const firstOwnerInput = {
        token: winner.value.token,
        csrfToken: freshCsrf,
        ceremonyId,
        principalId: login.principalId,
        providerSubjectId: PROVIDER_SUBJECT_ID,
        companionId,
        contactId: 'owner-contact',
        now: new Date(NOW.getTime() + 2500),
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      };
      await expect(store.completeFirstOwnerBootstrap({
        ...firstOwnerInput,
        companionId: randomUUID(),
        nextToken: 'mismatched-owner-token',
        nextCsrfToken: 'mismatched-owner-csrf',
      })).rejects.toMatchObject({ code: 'first_owner_denied' });
      const ownerAttempts = await Promise.allSettled([
        store.completeFirstOwnerBootstrap({
          ...firstOwnerInput,
          nextToken: 'owner-session-token-a',
          nextCsrfToken: 'owner-session-csrf-a',
        }),
        store.completeFirstOwnerBootstrap({
          ...firstOwnerInput,
          nextToken: 'owner-session-token-b',
          nextCsrfToken: 'owner-session-csrf-b',
        }),
      ]);
      expect(ownerAttempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(ownerAttempts.filter(result => result.status === 'rejected')).toHaveLength(1);
      const ownerWinner = ownerAttempts.find(result => result.status === 'fulfilled');
      if (!ownerWinner) throw new Error('First-owner race had no winner');
      const ownerSession = ownerWinner.value;
      expect(ownerSession.principalStatus).toBe('active');
      const ownerAuthority = await runtime.query<{
        status: string;
        binding_count: string;
        owner_count: string;
        ceremony_status: string;
        global_auth_epoch: string;
      }>(`
        SELECT principal.status,
               (SELECT count(*)::text FROM fleet_auth.principal_contact_bindings
                WHERE principal_id = principal.principal_id AND state = 'active') AS binding_count,
               (SELECT count(*)::text FROM fleet_auth.principal_role_grants
                WHERE principal_id = principal.principal_id AND role = 'owner'
                  AND lifecycle = 'active') AS owner_count,
               (SELECT status FROM fleet_auth.trusted_host_ceremonies
                WHERE ceremony_id = $2) AS ceremony_status,
               (SELECT global_auth_epoch::text FROM fleet_auth.authority_state
                WHERE singleton = TRUE) AS global_auth_epoch
        FROM fleet_auth.human_principals AS principal
        WHERE principal.principal_id = $1
      `, [login.principalId, ceremonyId]);
      expect(ownerAuthority.rows[0]).toEqual({
        status: 'active',
        binding_count: '1',
        owner_count: '1',
        ceremony_status: 'consumed',
        global_auth_epoch: '2',
      });
      await store.revokeProvider({
        token: ownerSession.token,
        csrfToken: ownerSession.csrfToken,
        now: new Date(NOW.getTime() + 3000),
        reasonDigest: 'b'.repeat(64),
      });

      const fenced = await runtime.query<{
        principal_status: string;
        provider_state: string;
        tombstones: string;
        live_sessions: string;
      }>(`
        SELECT principal.status AS principal_status, subject.state AS provider_state,
               (SELECT count(*)::text FROM fleet_auth.provider_subject_tombstones
                WHERE provider = 'discord' AND subject_id = $2) AS tombstones,
               (SELECT count(*)::text FROM fleet_auth.browser_sessions
                WHERE principal_id = principal.principal_id AND revoked_at IS NULL) AS live_sessions
        FROM fleet_auth.human_principals AS principal
        JOIN fleet_auth.provider_subjects AS subject
          ON subject.principal_id = principal.principal_id
        WHERE principal.principal_id = $1
      `, [login.principalId, PROVIDER_SUBJECT_ID]);
      expect(fenced.rows[0]).toEqual({
        principal_status: 'suspended',
        provider_state: 'revoked',
        tombstones: '1',
        live_sessions: '0',
      });

      const replay = await authenticate(store, 'second');
      await expect(store.createLoginSession({
        ...replay,
        providerSubjectId: PROVIDER_SUBJECT_ID,
        providerMetadata: {},
        audience: 'fleet',
        now: NOW,
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      })).rejects.toMatchObject({ code: 'provider_subject_suspended' });
    } finally {
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('atomically expires and rejects replayed OAuth state', async () => {
    const { store, runtime, migration } = await createStore();
    try {
      const transactionId = randomUUID();
      const stateDigest = 'c'.repeat(64);
      await store.createOAuthTransaction({
        transactionId,
        stateDigest,
        pkceVerifier: 'expired-pkce-verifier',
        callbackUri: 'https://fleet.example.test/auth/discord/callback',
        returnPath: '/fleet',
        kind: 'login',
        createdAt: NOW,
        expiresAt: new Date(NOW.getTime() + 1000),
      });
      await expect(store.consumeOAuthTransaction(
        stateDigest,
        new Date(NOW.getTime() + 1001),
      )).rejects.toMatchObject({ code: 'expired_oauth_transaction' });
      await expect(store.consumeOAuthTransaction(
        stateDigest,
        new Date(NOW.getTime() + 1002),
      )).rejects.toMatchObject({ code: 'invalid_oauth_state' });
    } finally {
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);
});
