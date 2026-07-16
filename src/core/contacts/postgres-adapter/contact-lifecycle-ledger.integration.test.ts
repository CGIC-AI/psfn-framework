import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresPool } from '../../../persistence/postgres.js';
import { quarantineRestoredContactLifecycleAuthority } from '../../../persistence/backups/contact-lifecycle-restore.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import type { ContactStorePort } from '../contact-store-port.js';
import { createPostgresContactStore } from '../postgres-adapter.js';

const TIMEOUT_MS = 120_000;
const SUBJECT = '12345678901234567';

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, TIMEOUT_MS);

async function freshDatabaseUrl(): Promise<string> {
  if (!harness) throw new Error('Postgres integration harness is unavailable');
  return (await harness.createDatabase()).databaseUrl;
}

function prepareRequest(intentId: string, subject = SUBJECT) {
  return {
    schemaVersion: 1 as const,
    intentId,
    phase: 'prepare' as const,
    action: 'contact.discord_unlink' as const,
    contactId: 'contact-authority-owner',
    providerSubjectId: subject,
  };
}

async function createVerifiedOwner(databaseUrl: string): Promise<{
  pool: Pool;
  store: ContactStorePort;
}> {
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-contact-lifecycle-ledger-test',
    allowExitOnIdle: true,
    max: 8,
  });
  const store = await createPostgresContactStore(databaseUrl, undefined, { pool });
  await store.upsert({
    id: 'contact-authority-owner',
    displayName: 'Exact Owner',
    channels: [{
      channel: 'api',
      userId: 'exact-owner-api',
      privacyLevel: 'private',
      firstSeen: '',
      lastSeen: '',
    }],
  });
  const challenge = await store.createIdentityLinkChallenge({
    contactId: 'contact-authority-owner',
    sourceChannel: 'api',
    sourceUserId: 'exact-owner-api',
    targetChannel: 'discord',
    targetUserId: SUBJECT,
  });
  if (challenge.status !== 'challenge_created') throw new Error('Expected identity challenge');
  const verified = await store.verifyIdentityLinkChallenge({
    contactId: 'contact-authority-owner',
    sourceChannel: 'api',
    sourceUserId: 'exact-owner-api',
    targetChannel: 'discord',
    targetUserId: SUBJECT,
    nonce: challenge.verification.nonce,
    expiresAt: challenge.verification.expiresAt,
    signature: challenge.verification.signature,
  });
  if (verified.status !== 'linked') throw new Error(`Expected linked identity, got ${verified.status}`);
  return { pool, store };
}

describe('Postgres companion contact lifecycle ledger', () => {
  it('captures exact verified ownership, resumes exact replay, and denies changed or locked reuse', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const { pool, store } = await createVerifiedOwner(databaseUrl);
    try {
      const ownership = await pool.query<{
        identity_version: string;
        ownership_state: string;
        verification_id: string | null;
        verification_digest: string | null;
        restore_state: string;
        contact_authority_version: string;
      }>(`
        SELECT identity.identity_version, identity.ownership_state,
               identity.verification_id, identity.verification_digest,
               identity.restore_state, contact.contact_authority_version
        FROM contact_channel_ids AS identity
        JOIN contacts AS contact ON contact.id = identity.contact_id
        WHERE identity.channel = 'discord' AND identity.channel_user_id = $1
      `, [SUBJECT]);
      expect(ownership.rows[0]).toMatchObject({
        ownership_state: 'verified',
        restore_state: 'live',
      });
      expect(Number(ownership.rows[0]?.identity_version)).toBeGreaterThan(1);
      expect(Number(ownership.rows[0]?.contact_authority_version)).toBeGreaterThan(1);
      expect(ownership.rows[0]?.verification_id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(ownership.rows[0]?.verification_digest).toMatch(/^[0-9a-f]{64}$/u);

      const intentId = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
      const prepared = await store.prepareContactLifecycleIntent(prepareRequest(intentId));
      expect(prepared).toEqual({
        schemaVersion: 1,
        status: 'pending',
        intentId,
        phase: 'gateway_prepare_pending',
        reason: 'gateway_prepare_pending',
        snapshotDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      await expect(store.prepareContactLifecycleIntent(prepareRequest(intentId)))
        .resolves.toEqual(prepared);
      await expect(store.prepareContactLifecycleIntent({
        ...prepareRequest(intentId),
        providerSubjectId: '22345678901234567',
      })).rejects.toThrow(/changed_intent_reuse/);

      const snapshot = await pool.query<{
        canonical_request: unknown;
        locked_snapshot: { verifiedOwnerships: Array<Record<string, unknown>> };
        snapshot_digest: string;
      }>('SELECT canonical_request, locked_snapshot, snapshot_digest FROM contact_lifecycle_intents WHERE intent_id = $1', [intentId]);
      expect(snapshot.rows[0]?.canonical_request).toEqual(prepareRequest(intentId));
      expect(snapshot.rows[0]?.locked_snapshot.verifiedOwnerships[0]).toMatchObject({
        contactId: 'contact-authority-owner',
        providerSubjectId: SUBJECT,
        ownershipState: 'verified',
        restoreState: 'live',
      });
      expect(snapshot.rows[0]?.snapshot_digest).toMatch(/^[0-9a-f]{64}$/u);

      await expect(store.prepareContactLifecycleIntent(prepareRequest(
        '6ba7b811-9dad-41d1-80b4-00c04fd430c8',
      ))).resolves.toMatchObject({
        status: 'manual_hold',
        phase: 'manual_hold',
        reason: 'target_locked',
      });
      await expect(store.prepareContactLifecycleIntent({
        ...prepareRequest('6ba7b812-9dad-41d1-80b4-00c04fd430c8'),
        companionId: 'caller-must-not-choose-schema-owner',
      })).rejects.toThrow(/invalid_v1_request/);

      await pool.query(`
        UPDATE contact_identity_link_verifications SET status = 'failed'
        WHERE id = $1
      `, [ownership.rows[0].verification_id]);
      const quarantined = await pool.query<{ ownership_state: string; restore_state: string }>(`
        SELECT ownership_state, restore_state FROM contact_channel_ids
        WHERE channel = 'discord' AND channel_user_id = $1
      `, [SUBJECT]);
      expect(quarantined.rows[0]).toEqual({
        ownership_state: 'quarantined',
        restore_state: 'quarantined',
      });
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

  it('holds absent, unverified, reassigned, stale, and non-live ownership fail closed', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const { pool, store } = await createVerifiedOwner(databaseUrl);
    try {
      await expect(store.prepareContactLifecycleIntent(prepareRequest(
        '6ca7b810-9dad-41d1-80b4-00c04fd430c8',
        '22345678901234567',
      ))).resolves.toMatchObject({ status: 'manual_hold', reason: 'ownership_not_found' });

      await pool.query(`
        UPDATE contact_channel_ids
        SET ownership_state = 'unverified'
        WHERE channel = 'discord' AND channel_user_id = $1
      `, [SUBJECT]);
      await expect(store.prepareContactLifecycleIntent(prepareRequest(
        '6ca7b811-9dad-41d1-80b4-00c04fd430c8',
      ))).resolves.toMatchObject({ status: 'manual_hold', reason: 'ownership_unverified' });

      await store.upsert({ id: 'other-contact', displayName: 'Other Contact' });
      await pool.query(`
        UPDATE contact_channel_ids
        SET contact_id = 'other-contact', ownership_state = 'verified'
        WHERE channel = 'discord' AND channel_user_id = $1
      `, [SUBJECT]);
      await expect(store.prepareContactLifecycleIntent(prepareRequest(
        '6ca7b812-9dad-41d1-80b4-00c04fd430c8',
      ))).resolves.toMatchObject({ status: 'manual_hold', reason: 'ownership_reassigned' });

      await pool.query(`
        UPDATE contact_channel_ids SET contact_id = 'contact-authority-owner'
        WHERE channel = 'discord' AND channel_user_id = $1
      `, [SUBJECT]);
      await pool.query('ALTER TABLE contact_identity_link_verifications DISABLE TRIGGER contact_verification_authority_guard');
      await pool.query(`
        UPDATE contact_identity_link_verifications
        SET status = 'failed'
        WHERE id = (
          SELECT verification_id FROM contact_channel_ids
          WHERE channel = 'discord' AND channel_user_id = $1
        )
      `, [SUBJECT]);
      await pool.query('ALTER TABLE contact_identity_link_verifications ENABLE TRIGGER contact_verification_authority_guard');
      await expect(store.prepareContactLifecycleIntent(prepareRequest(
        '6ca7b813-9dad-41d1-80b4-00c04fd430c8',
      ))).resolves.toMatchObject({ status: 'manual_hold', reason: 'stale_ownership' });

      await pool.query(`
        UPDATE contact_identity_link_verifications SET status = 'verified'
        WHERE id = (
          SELECT verification_id FROM contact_channel_ids
          WHERE channel = 'discord' AND channel_user_id = $1
        )
      `, [SUBJECT]);
      await pool.query(`
        UPDATE contacts SET contact_lifecycle_state = 'deleted'
        WHERE id = 'contact-authority-owner'
      `);
      await expect(store.prepareContactLifecycleIntent(prepareRequest(
        '6ca7b814-9dad-41d1-80b4-00c04fd430c8',
      ))).resolves.toMatchObject({ status: 'manual_hold', reason: 'contact_not_live' });
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

  it('claims recovery exactly once across a race, applies backoff, and appends exact gateway results', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const { pool, store } = await createVerifiedOwner(databaseUrl);
    const secondPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-contact-lifecycle-recovery-racer',
      allowExitOnIdle: true,
      max: 4,
    });
    try {
      const secondStore = await createPostgresContactStore(databaseUrl, undefined, { pool: secondPool });
      const intentId = '7ba7b810-9dad-41d1-80b4-00c04fd430c8';
      await store.prepareContactLifecycleIntent(prepareRequest(intentId));
      const [first, second] = await Promise.all([
        store.claimContactLifecycleRecovery({ leaseOwner: 'worker-a', limit: 1, leaseMs: 30_000 }),
        secondStore.claimContactLifecycleRecovery({ leaseOwner: 'worker-b', limit: 1, leaseMs: 30_000 }),
      ]);
      expect([...first, ...second]).toHaveLength(1);
      const lease = [...first, ...second][0];
      expect(lease.intentId).toBe(intentId);
      expect(lease.snapshot.verifiedOwnerships[0].providerSubjectId).toBe(SUBJECT);
      await expect(store.deferContactLifecycleRecovery({
        intentId,
        leaseOwner: lease.leaseOwner,
        reason: 'gateway_unavailable',
      })).resolves.toMatchObject({
        status: 'pending',
        phase: 'gateway_prepare_pending',
        reason: 'gateway_unavailable',
      });
      await expect(secondStore.claimContactLifecycleRecovery({
        leaseOwner: 'worker-c',
        limit: 1,
      })).resolves.toEqual([]);
      const retry = await pool.query<{ retry_count: number; lease_owner: string | null }>(
        'SELECT retry_count, lease_owner FROM contact_lifecycle_intents WHERE intent_id = $1',
        [intentId],
      );
      expect(retry.rows[0]).toEqual({ retry_count: 1, lease_owner: null });

      await pool.query(
        'UPDATE contact_lifecycle_intents SET next_attempt_at = clock_timestamp() WHERE intent_id = $1',
        [intentId],
      );
      const reclaimed = await secondStore.claimContactLifecycleRecovery({
        leaseOwner: 'worker-c',
        limit: 1,
      });
      expect(reclaimed).toHaveLength(1);
      const reclaimedLease = reclaimed[0];
      const prepareResult = {
        schemaVersion: 1 as const,
        intentId,
        phase: 'prepare' as const,
        action: 'contact.discord_unlink' as const,
        status: 'prepared' as const,
        authorityGeneration: 2,
        globalAuthEpoch: 2,
        auditEventId: '8ba7b810-9dad-41d1-80b4-00c04fd430c8',
      };
      await expect(store.recordContactLifecycleGatewayResult({
        intentId,
        result: prepareResult,
        leaseOwner: reclaimedLease.leaseOwner,
      }))
        .resolves.toMatchObject({ status: 'pending', phase: 'contact_commit_pending' });
      await expect(store.recordContactLifecycleGatewayResult({
        intentId,
        result: prepareResult,
        leaseOwner: reclaimedLease.leaseOwner,
      }))
        .resolves.toMatchObject({ status: 'pending', phase: 'contact_commit_pending' });
      await expect(store.recordContactLifecycleGatewayResult({
        intentId,
        result: { ...prepareResult, globalAuthEpoch: 3 },
        leaseOwner: reclaimedLease.leaseOwner,
      })).rejects.toThrow(/changed_gateway_result_reuse/);

      await expect(store.recordContactLifecycleGatewayResult({
        intentId,
        result: {
          ...prepareResult,
          phase: 'finalize',
          status: 'finalized',
          auditEventId: '9ba7b810-9dad-41d1-80b4-00c04fd430c8',
        },
        leaseOwner: reclaimedLease.leaseOwner,
      })).rejects.toThrow(/gateway_result_phase_mismatch/);
      await expect(store.assertContactLifecycleLedgerHealthy()).resolves.toBeUndefined();
      const lock = await pool.query<{ lock_state: string }>(
        'SELECT lock_state FROM contact_lifecycle_target_locks WHERE intent_id = $1',
        [intentId],
      );
      expect(new Set(lock.rows.map(row => row.lock_state))).toEqual(new Set(['active']));
    } finally {
      await Promise.all([pool.end(), secondPool.end()]);
    }
  }, TIMEOUT_MS);

  it('quarantines restored ownership and intents before startup recovery can claim them', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const { pool, store } = await createVerifiedOwner(databaseUrl);
    try {
      const intentId = 'aba7b810-9dad-41d1-80b4-00c04fd430c8';
      await store.prepareContactLifecycleIntent(prepareRequest(intentId));
      await quarantineRestoredContactLifecycleAuthority({ databaseUrl }, ['public']);
      await expect(store.assertContactLifecycleLedgerHealthy()).resolves.toBeUndefined();
      await expect(store.claimContactLifecycleRecovery({ leaseOwner: 'startup-worker' }))
        .resolves.toEqual([]);
      await expect(store.prepareContactLifecycleIntent(prepareRequest(intentId)))
        .rejects.toThrow(/restored_intent_quarantined/);
      const state = await pool.query<{
        ownership_state: string;
        ownership_restore_state: string;
        contact_lifecycle_state: string;
        contact_restore_state: string;
        phase: string;
        intent_restore_state: string;
        lock_state: string;
      }>(`
        SELECT ownership.ownership_state,
               ownership.restore_state AS ownership_restore_state,
               contact.contact_lifecycle_state, contact.contact_restore_state,
               intent.phase, intent.restore_state AS intent_restore_state,
               lock.lock_state
        FROM contact_channel_ids AS ownership
        JOIN contacts AS contact ON contact.id = ownership.contact_id
        JOIN contact_lifecycle_intents AS intent ON intent.intent_id = $1
        JOIN contact_lifecycle_target_locks AS lock ON lock.intent_id = intent.intent_id
        WHERE ownership.channel = 'discord'
        LIMIT 1
      `, [intentId]);
      expect(state.rows[0]).toEqual({
        ownership_state: 'quarantined',
        ownership_restore_state: 'quarantined',
        contact_lifecycle_state: 'quarantined',
        contact_restore_state: 'quarantined',
        phase: 'quarantined',
        intent_restore_state: 'quarantined',
        lock_state: 'quarantined',
      });
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

  it('fails store startup closed when durable canonical state is corrupt', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const { pool, store } = await createVerifiedOwner(databaseUrl);
    const intentId = 'bba7b810-9dad-41d1-80b4-00c04fd430c8';
    try {
      await store.prepareContactLifecycleIntent(prepareRequest(intentId));
      await pool.query('ALTER TABLE contact_lifecycle_intents DISABLE TRIGGER contact_lifecycle_intent_transition_guard');
      await pool.query(
        `UPDATE contact_lifecycle_intents SET request_digest = $2 WHERE intent_id = $1`,
        [intentId, 'f'.repeat(64)],
      );
      await pool.query('ALTER TABLE contact_lifecycle_intents ENABLE TRIGGER contact_lifecycle_intent_transition_guard');
      await expect(createPostgresContactStore(databaseUrl, undefined, { pool }))
        .rejects.toThrow(/Corrupt contact lifecycle intent canonical request tuple/);
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);
});
