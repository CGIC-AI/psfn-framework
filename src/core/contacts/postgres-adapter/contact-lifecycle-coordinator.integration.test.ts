import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ContactAuthorityLifecycleRequest,
  ContactAuthorityLifecycleResult,
} from '../../../shared/contracts/contact-authority-lifecycle.js';
import type { ContactLifecycleGatewayPort } from '../contact-lifecycle-gateway-port.js';
import type { ContactStorePort } from '../contact-store-port.js';
import { createPostgresPool } from '../../../persistence/postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createPostgresContactStore } from '../postgres-adapter.js';
import type { ContactLifecycleFaultStage } from './options.js';

const TIMEOUT_MS = 120_000;
const SUBJECT = '12345678901234567';

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, TIMEOUT_MS);

class RecordingGateway implements ContactLifecycleGatewayPort {
  readonly calls: ContactAuthorityLifecycleRequest[] = [];
  readonly receipts = new Map<string, ContactAuthorityLifecycleResult>();
  throwAfterPersistedPrepareOnce = false;
  throwAfterPersistedFinalizeOnce = false;
  beforeExecute?: (request: ContactAuthorityLifecycleRequest) => Promise<void>;

  async executeContactLifecycle(
    request: ContactAuthorityLifecycleRequest,
  ): Promise<ContactAuthorityLifecycleResult> {
    this.calls.push(request);
    await this.beforeExecute?.(request);
    const key = `${request.intentId}:${request.phase}`;
    const replay = this.receipts.get(key);
    if (replay) return replay;
    const result: ContactAuthorityLifecycleResult = {
      schemaVersion: 1,
      intentId: request.intentId,
      phase: request.phase,
      action: request.action,
      status: request.phase === 'finalize'
        ? 'finalized'
        : (request.action === 'contact.verify' ? 'reserved' : 'no_binding'),
      authorityGeneration: 2,
      globalAuthEpoch: 2,
      auditEventId: randomUUID(),
    };
    this.receipts.set(key, result);
    if (request.phase === 'prepare' && this.throwAfterPersistedPrepareOnce) {
      this.throwAfterPersistedPrepareOnce = false;
      throw new Error('injected lost gateway acknowledgement');
    }
    if (request.phase === 'finalize' && this.throwAfterPersistedFinalizeOnce) {
      this.throwAfterPersistedFinalizeOnce = false;
      throw new Error('injected lost gateway finalize acknowledgement');
    }
    return result;
  }
}

async function fixture(
  gateway: RecordingGateway,
  contactLifecycleFaultInjection?: (
    stage: ContactLifecycleFaultStage,
    request: ContactAuthorityLifecycleRequest,
  ) => Promise<void> | void,
): Promise<{
  pool: ReturnType<typeof createPostgresPool>;
  store: ContactStorePort;
}> {
  if (!harness) throw new Error('Postgres test harness unavailable');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'contact-lifecycle-coordinator-test',
    allowExitOnIdle: true,
    max: 8,
  });
  const store = await createPostgresContactStore(database.databaseUrl, SUBJECT, {
    pool,
    contactLifecycleGateway: gateway,
    ...(contactLifecycleFaultInjection ? { contactLifecycleFaultInjection } : {}),
  });
  await store.upsert({
    id: 'contact-a',
    displayName: 'Contact A',
    channels: [{
      channel: 'api',
      userId: 'api-contact-a',
      privacyLevel: 'private',
      firstSeen: '',
      lastSeen: '',
    }],
  });
  return { pool, store };
}

async function challenge(store: ContactStorePort) {
  const created = await store.createIdentityLinkChallenge({
    contactId: 'contact-a',
    sourceChannel: 'api',
    sourceUserId: 'api-contact-a',
    targetChannel: 'discord',
    targetUserId: SUBJECT,
  });
  if (created.status !== 'challenge_created') throw new Error('Expected identity challenge');
  return created.verification;
}

async function verify(store: ContactStorePort, proof: Awaited<ReturnType<typeof challenge>>) {
  return await store.verifyIdentityLinkChallenge({
    contactId: proof.contactId,
    sourceChannel: proof.sourceChannel,
    sourceUserId: proof.sourceUserId,
    targetChannel: proof.targetChannel,
    targetUserId: proof.targetUserId,
    nonce: proof.nonce,
    expiresAt: proof.expiresAt,
    signature: proof.signature,
  });
}

describe('authenticated contact lifecycle coordinator', () => {
  it.each([
    'after_local_prepare',
    'after_gateway_fence',
    'after_gateway_result',
    'after_contact_commit',
    'after_gateway_finalize',
    'after_local_final_record',
  ] as const)('restarts deterministically after the %s crash cut', async (crashStage) => {
    const gateway = new RecordingGateway();
    let armed = true;
    const { pool, store } = await fixture(gateway, (stage) => {
      if (armed && stage === crashStage) {
        armed = false;
        throw new Error(`injected process crash at ${stage}`);
      }
    });
    try {
      await expect(store.deleteContact('contact-a')).rejects.toThrow(
        `injected process crash at ${crashStage}`,
      );
      const restarted = await createPostgresContactStore('unused-by-injected-pool', SUBJECT, {
        pool,
        contactLifecycleGateway: gateway,
      });
      await expect(restarted.deleteContact('contact-a')).resolves.toBe(true);
      await expect(restarted.getById('contact-a')).resolves.toBeUndefined();
      const ledger = await pool.query<{
        phase: string;
        lease_owner: string | null;
        finalize_count: string;
      }>(`
        SELECT intent.phase, intent.lease_owner,
               (SELECT COUNT(*)::text FROM contact_lifecycle_results AS result
                WHERE result.intent_id = intent.intent_id
                  AND result.gateway_phase = 'finalize') AS finalize_count
        FROM contact_lifecycle_intents AS intent
        WHERE intent.action = 'contact.delete'
      `);
      expect(ledger.rows).toEqual([{
        phase: 'finalized',
        lease_owner: null,
        finalize_count: '1',
      }]);
      expect(new Set(gateway.calls.map(call => call.intentId)).size).toBe(1);
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

  it('finalizes exact verification before authority activation and clears legacy identity on unlink', async () => {
    const gateway = new RecordingGateway();
    const { pool, store } = await fixture(gateway);
    try {
      gateway.beforeExecute = async request => {
        if (request.action !== 'contact.verify') return;
        const ownership = await pool.query<{ ownership_state: string }>(`
          SELECT ownership_state FROM contact_channel_ids
          WHERE channel = 'discord' AND channel_user_id = $1
        `, [SUBJECT]);
        expect(ownership.rows.at(0)?.ownership_state).toBe(
          request.phase === 'prepare' ? 'unverified' : 'verified',
        );
      };
      const result = await verify(store, await challenge(store));
      expect(result.status).toBe('linked');
      expect(gateway.calls.map(call => `${call.action}:${call.phase}`)).toEqual([
        'contact.verify:prepare',
        'contact.verify:finalize',
      ]);
      const finalized = await pool.query<{ phase: string; committed_contact_version: string }>(`
        SELECT phase, committed_contact_version FROM contact_lifecycle_intents
        WHERE action = 'contact.verify'
      `);
      expect(finalized.rows.at(0)?.phase).toBe('finalized');
      expect(Number(finalized.rows.at(0)?.committed_contact_version)).toBeGreaterThan(1);

      gateway.beforeExecute = undefined;
      await expect(store.unlinkChannelIdentity('contact-a', 'discord', SUBJECT, 'admin:test'))
        .resolves.toBe(true);
      const callsAfterUnlink = gateway.calls.length;
      await expect(store.unlinkChannelIdentity('contact-a', 'discord', SUBJECT, 'admin:test'))
        .resolves.toBe(true);
      expect(gateway.calls).toHaveLength(callsAfterUnlink);
      const legacy = await pool.query<{ discord_user_id: string | null }>(`
        SELECT discord_user_id FROM contacts WHERE id = 'contact-a'
      `);
      expect(legacy.rows.at(0)?.discord_user_id).toBeNull();
      await expect(store.getByDiscordUserId(SUBJECT)).resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

  it('resumes a lost gateway acknowledgement with the same intent and result', async () => {
    const gateway = new RecordingGateway();
    gateway.throwAfterPersistedPrepareOnce = true;
    const { pool, store } = await fixture(gateway);
    try {
      const proof = await challenge(store);
      await expect(verify(store, proof)).rejects.toThrow(/lost gateway acknowledgement/u);
      const pending = await pool.query<{ phase: string }>(`
        SELECT phase FROM contact_lifecycle_intents WHERE intent_id = $1
      `, [proof.id]);
      expect(pending.rows.at(0)?.phase).toBe('gateway_prepare_pending');

      await expect(store.recoverContactLifecycleMutations()).resolves.toMatchObject([{
        status: 'completed',
        phase: 'finalized',
      }]);
      await expect(verify(store, proof)).resolves.toMatchObject({
        status: 'verification_replayed',
      });
      expect(gateway.calls.filter(call => call.phase === 'prepare')).toHaveLength(2);
      expect(new Set(gateway.calls.map(call => call.intentId))).toEqual(new Set([proof.id]));
      const recovered = await pool.query<{ lease_owner: string | null; retry_count: number }>(`
        SELECT lease_owner, retry_count FROM contact_lifecycle_intents WHERE intent_id = $1
      `, [proof.id]);
      expect(recovered.rows.at(0)).toEqual({ lease_owner: null, retry_count: 0 });
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

  it('recovers a lost finalize acknowledgement only after the exact local commit', async () => {
    const gateway = new RecordingGateway();
    gateway.throwAfterPersistedFinalizeOnce = true;
    const { pool, store } = await fixture(gateway);
    try {
      const proof = await challenge(store);
      await expect(verify(store, proof)).rejects.toThrow(/lost gateway finalize acknowledgement/u);
      const pending = await pool.query<{ phase: string; ownership_state: string }>(`
        SELECT intent.phase, ownership.ownership_state
        FROM contact_lifecycle_intents AS intent
        JOIN contact_channel_ids AS ownership
          ON ownership.channel = 'discord' AND ownership.channel_user_id = $2
        WHERE intent.intent_id = $1
      `, [proof.id, SUBJECT]);
      expect(pending.rows.at(0)).toEqual({
        phase: 'gateway_finalize_pending',
        ownership_state: 'verified',
      });

      await expect(store.recoverContactLifecycleMutations()).resolves.toMatchObject([{
        status: 'completed',
        phase: 'finalized',
      }]);
      expect(gateway.calls.filter(call => call.phase === 'finalize')).toHaveLength(2);
      expect(new Set(gateway.calls.map(call => call.intentId))).toEqual(new Set([proof.id]));
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

  it('fails exact CAS closed when contact authority changes behind the gateway fence', async () => {
    const gateway = new RecordingGateway();
    const { pool, store } = await fixture(gateway);
    try {
      gateway.beforeExecute = async request => {
        if (request.action === 'contact.verify' && request.phase === 'prepare') {
          await pool.query(`
            INSERT INTO contact_channel_ids
              (contact_id, channel, channel_user_id, privacy_level, first_seen, last_seen)
            VALUES ('contact-a', 'telegram', 'racing-identity', 'private', now(), now())
          `);
        }
      };
      const proof = await challenge(store);
      await expect(verify(store, proof)).rejects.toThrow(/exact contact CAS failed/u);
      const state = await pool.query<{ ownership_state: string; phase: string }>(`
        SELECT ownership.ownership_state, intent.phase
        FROM contact_channel_ids AS ownership
        JOIN contact_lifecycle_intents AS intent ON intent.intent_id = $1
        WHERE ownership.channel = 'discord' AND ownership.channel_user_id = $2
      `, [proof.id, SUBJECT]);
      expect(state.rows.at(0)).toEqual({
        ownership_state: 'unverified',
        phase: 'contact_commit_pending',
      });
      gateway.beforeExecute = undefined;
      await expect(store.recoverContactLifecycleMutations()).resolves.toMatchObject([{
        status: 'pending',
        phase: 'contact_commit_pending',
        reason: 'recovery_failed',
      }]);
      const deferred = await pool.query<{
        retry_count: number;
        lease_owner: string | null;
      }>(`
        SELECT retry_count, lease_owner FROM contact_lifecycle_intents WHERE intent_id = $1
      `, [proof.id]);
      expect(deferred.rows.at(0)).toEqual({ retry_count: 1, lease_owner: null });
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

  it('routes direct merge and delete callers through exact two-phase intents', async () => {
    const gateway = new RecordingGateway();
    const { pool, store } = await fixture(gateway);
    try {
      await store.upsert({ id: 'contact-b', displayName: 'Contact B' });
      await expect(store.mergeContacts('contact-b', 'contact-a')).resolves.toBe(true);
      expect(await store.getById('contact-b')).toBeUndefined();
      await expect(store.mergeContacts('contact-b', 'contact-a')).resolves.toBe(true);
      await store.upsert({ id: 'contact-delete', displayName: 'Delete Me' });
      await expect(store.deleteContact('contact-delete')).resolves.toBe(true);
      await expect(store.deleteContact('contact-delete')).resolves.toBe(true);
      expect(gateway.calls.map(call => `${call.action}:${call.phase}`)).toEqual([
        'contact.merge:prepare',
        'contact.merge:finalize',
        'contact.delete:prepare',
        'contact.delete:finalize',
      ]);
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

  it('routes direct verified Discord link conflicts through the same suspension saga', async () => {
    const gateway = new RecordingGateway();
    const { pool, store } = await fixture(gateway);
    try {
      await verify(store, await challenge(store));
      gateway.calls.length = 0;
      await store.upsert({ id: 'contact-b', displayName: 'Contact B' });

      await expect(store.linkChannelIdentity('contact-b', 'discord', SUBJECT))
        .resolves.toBe('identity_conflict');
      expect(gateway.calls.map(call => `${call.action}:${call.phase}`)).toEqual([
        'contact.identity_conflict:prepare',
        'contact.identity_conflict:finalize',
      ]);
      const ownership = await pool.query<{ ownership_state: string; restore_state: string }>(`
        SELECT ownership_state, restore_state FROM contact_channel_ids
        WHERE channel = 'discord' AND channel_user_id = $1
      `, [SUBJECT]);
      expect(ownership.rows.at(0)).toEqual({
        ownership_state: 'quarantined',
        restore_state: 'quarantined',
      });
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

  it('reapproves exact restored contact ownership only between gateway prepare and finalize', async () => {
    const gateway = new RecordingGateway();
    const { pool, store } = await fixture(gateway);
    try {
      await verify(store, await challenge(store));
      await pool.query(`
        UPDATE contacts
        SET contact_lifecycle_state = 'quarantined', contact_restore_state = 'quarantined'
        WHERE id = 'contact-a'
      `);
      await pool.query(`
        UPDATE contact_channel_ids
        SET ownership_state = 'quarantined', restore_state = 'quarantined'
        WHERE contact_id = 'contact-a' AND channel = 'discord' AND channel_user_id = $1
      `, [SUBJECT]);
      gateway.calls.length = 0;
      gateway.beforeExecute = async request => {
        if (request.action !== 'contact.reapprove') return;
        const state = await pool.query<{
          contact_lifecycle_state: string;
          ownership_state: string;
        }>(`
          SELECT contact.contact_lifecycle_state, ownership.ownership_state
          FROM contacts AS contact
          JOIN contact_channel_ids AS ownership ON ownership.contact_id = contact.id
          WHERE contact.id = 'contact-a' AND ownership.channel = 'discord'
        `);
        expect(state.rows.at(0)).toEqual(request.phase === 'prepare'
          ? { contact_lifecycle_state: 'quarantined', ownership_state: 'quarantined' }
          : { contact_lifecycle_state: 'live', ownership_state: 'verified' });
      };

      await expect(store.reapproveRestoredDiscordIdentity('contact-a', SUBJECT))
        .resolves.toBe(true);
      const callsAfterReapproval = gateway.calls.length;
      await expect(store.reapproveRestoredDiscordIdentity('contact-a', SUBJECT))
        .resolves.toBe(true);
      expect(gateway.calls).toHaveLength(callsAfterReapproval);
      expect(gateway.calls.map(call => `${call.action}:${call.phase}`)).toEqual([
        'contact.reapprove:prepare',
        'contact.reapprove:finalize',
      ]);
      const finalized = await pool.query<{ phase: string }>(`
        SELECT phase FROM contact_lifecycle_intents WHERE action = 'contact.reapprove'
      `);
      expect(finalized.rows.at(0)?.phase).toBe('finalized');
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);
});
