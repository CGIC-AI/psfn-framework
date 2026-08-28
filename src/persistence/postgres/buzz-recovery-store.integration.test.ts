import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSecretKey } from 'nostr-tools';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createBuzzStreamEvent } from '../../channels/buzz/protocol.js';
import { createPostgresPool } from '../postgres.js';
import { PostgresBuzzRecoveryStore } from './buzz-recovery-store.js';

const TIMEOUT_MS = 120_000;
const COMMUNITY = 'wss://relay.example.test';
const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = 'a'.repeat(64);
const CANCELLED_EVENT_ID = '6'.repeat(64);

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, TIMEOUT_MS);

describe('Postgres Buzz recovery store', () => {
  it('persists claims, exact replies, cursors, memberships, and causal edges across instances', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const databaseUrl = (await harness.createDatabase()).databaseUrl;
    const pool = createPostgresPool(databaseUrl, { max: 3 });
    try {
      const first = await PostgresBuzzRecoveryStore.fromPool(pool, {
        community: COMMUNITY,
        companionId: COMPANION_ID,
      });
      const claim = await first.claimInbound({
        eventId: EVENT_ID,
        channelId: CHANNEL_ID,
        eventCreatedAt: 100,
      });
      expect(claim.claimed).toBe(true);
      const duplicate = await first.claimInbound({
        eventId: EVENT_ID,
        channelId: CHANNEL_ID,
        eventCreatedAt: 100,
      });
      expect(duplicate).toMatchObject({ claimed: false, record: { state: 'processing' } });

      const outbound = createBuzzStreamEvent({
        channelId: CHANNEL_ID,
        content: 'durable reply',
        tags: [['e', EVENT_ID, '', 'reply']],
        privateKey: generateSecretKey(),
      });
      await first.registerHumanRoot({
        eventId: EVENT_ID,
        channelId: CHANNEL_ID,
        authorPubkey: 'f'.repeat(64),
      });
      await first.markReady(EVENT_ID, outbound, {
        eventId: outbound.id,
        channelId: CHANNEL_ID,
        rootEventId: EVENT_ID,
        parentEventId: EVENT_ID,
        hop: 1,
        authorPubkey: outbound.pubkey,
      });
      await first.advanceReplayCursor(100);
      await first.advanceReplayCursor(90);
      await first.replaceMemberships([{
        channelId: CHANNEL_ID,
        position: { createdAt: 100, eventId: '1'.repeat(64) },
      }]);
      await expect(first.claimCausalEvent({
        rootEventId: EVENT_ID,
        channelId: CHANNEL_ID,
        parentEventId: outbound.id,
        hop: 2,
        authorPubkey: 'c'.repeat(64),
        eventId: 'd'.repeat(64),
      })).resolves.toBe('claimed');
      await expect(first.claimCausalEvent({
        rootEventId: EVENT_ID,
        channelId: CHANNEL_ID,
        parentEventId: outbound.id,
        hop: 2,
        authorPubkey: 'c'.repeat(64),
        eventId: 'e'.repeat(64),
      })).resolves.toBe('duplicate');
      await expect(first.claimCausalEvent({
        rootEventId: EVENT_ID,
        channelId: CHANNEL_ID,
        parentEventId: 'b'.repeat(64),
        hop: 1,
        authorPubkey: 'e'.repeat(64),
        eventId: '9'.repeat(64),
      })).resolves.toBe('invalid_parent');
      await first.setMembership({
        channelId: CHANNEL_ID,
        active: false,
        position: { createdAt: 200, eventId: '2'.repeat(64) },
      });
      await first.setMembership({
        channelId: CHANNEL_ID,
        active: true,
        position: { createdAt: 150, eventId: '3'.repeat(64) },
      });
      const membership = await pool.query<{ active: boolean }>(`
        SELECT active FROM buzz_room_memberships
        WHERE community = $1 AND companion_id = $2 AND channel_id = $3
      `, [COMMUNITY, COMPANION_ID, CHANNEL_ID]);
      expect(membership.rows[0]?.active).toBe(false);

      await first.claimInbound({
        eventId: CANCELLED_EVENT_ID,
        channelId: CHANNEL_ID,
        eventCreatedAt: 101,
      });
      await first.registerHumanRoot({
        eventId: CANCELLED_EVENT_ID,
        channelId: CHANNEL_ID,
        authorPubkey: '7'.repeat(64),
      });
      const cancelledOutbound = createBuzzStreamEvent({
        channelId: CHANNEL_ID,
        content: 'must not publish',
        tags: [['e', CANCELLED_EVENT_ID, '', 'reply']],
        privateKey: generateSecretKey(),
      });
      await first.markReady(CANCELLED_EVENT_ID, cancelledOutbound, {
        eventId: cancelledOutbound.id,
        channelId: CHANNEL_ID,
        rootEventId: CANCELLED_EVENT_ID,
        parentEventId: CANCELLED_EVENT_ID,
        hop: 1,
        authorPubkey: cancelledOutbound.pubkey,
      });
      await first.markSuppressed(CANCELLED_EVENT_ID, 'turn_cancelled');
      const cancelledCausalEvent = await pool.query(`
        SELECT event_id FROM buzz_causal_events
        WHERE community = $1 AND companion_id = $2 AND event_id = $3
      `, [COMMUNITY, COMPANION_ID, cancelledOutbound.id]);
      expect(cancelledCausalEvent.rowCount).toBe(0);

      const restarted = await PostgresBuzzRecoveryStore.fromPool(pool, {
        community: COMMUNITY,
        companionId: COMPANION_ID,
      });
      expect(await restarted.listRecoverable()).toEqual([expect.objectContaining({
        eventId: EVENT_ID,
        state: 'ready',
        outboundEvent: outbound,
      })]);
      await expect(restarted.loadReplayCursor()).resolves.toBe(100);
      await restarted.markCompleted(EVENT_ID);
      await expect(restarted.listRecoverable()).resolves.toEqual([]);

      const otherCompanion = await PostgresBuzzRecoveryStore.fromPool(pool, {
        community: COMMUNITY,
        companionId: '33333333-3333-4333-8333-333333333333',
      });
      await expect(otherCompanion.claimInbound({
        eventId: EVENT_ID,
        channelId: CHANNEL_ID,
        eventCreatedAt: 100,
      })).resolves.toMatchObject({ claimed: true });
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);
});
