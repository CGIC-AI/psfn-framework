import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresPool, ensurePostgresSchema, ensurePostgresSchemaExists } from '../postgres.js';
import { POSTGRES_INTENTION_MIGRATIONS } from './migrations.js';
import { PostgresSocialImpulseOutreachStore } from './social-impulse-outreach-store.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const CROSSING_MS = 1_780_000_000_000;
const OPPORTUNITY_ID = `felt-impulse:would_message:${CROSSING_MS}`;

describe('Postgres social outreach recovery', () => {
  let harness: PostgresTestHarness;
  beforeAll(async () => { harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE }); });
  afterAll(async () => { await harness.stop(); });

  it('upgrades existing opportunities, preserves initial source facts, and starts a queued choice once', async () => {
    const database = await harness.createDatabase();
    const pool = createPostgresPool(database.databaseUrl, { schema: 'companion_a' });
    try {
      await ensurePostgresSchemaExists(pool, 'companion_a');
      await ensurePostgresSchema(pool, POSTGRES_INTENTION_MIGRATIONS.slice(0, -6));
      await pool.query(`INSERT INTO social_impulse_outreach_opportunities (
        opportunity_id, companion_id, impulse_dedupe_key, first_crossing_ms,
        fired_at_ms, mode_at_creation, state, created_at_ms, updated_at_ms
      ) VALUES ($1, $2, $1, $3, $3, 'on', 'pending', $3, $3)`,
      [OPPORTUNITY_ID, COMPANION_ID, CROSSING_MS]);
    } finally {
      await pool.end();
    }
    const store = await PostgresSocialImpulseOutreachStore.connect(database.databaseUrl, { schema: 'companion_a' });
    try {
      const [original] = await store.listRecoverable(COMPANION_ID);
      expect(original).toMatchObject({ state: 'pending', executionIntent: null });
      const replay = await store.createOpportunity({ ...original!, firedAtMs: CROSSING_MS + 1000 });
      expect(replay).toMatchObject({ created: false, record: { firedAtMs: CROSSING_MS } });
      await expect(store.createOpportunity({
        ...original!, companionId: '22222222-2222-4222-8222-222222222222',
      })).rejects.toThrow('correlation collided');

      const claim = await store.claimDisposition({
        opportunityId: OPPORTUNITY_ID,
        disposition: 'contact-human',
        destination: {
          kind: 'human_dm', destinationId: 'human:contact-a:discord:dm-a',
          contactId: 'contact-a', displayLabel: 'Trusted person', channelId: 'dm-a',
          channelType: 'discord', dyadId: null,
        },
        bindingHash: 'a'.repeat(64), executionIntent: 'A private hello.',
        originIcpRootInitiationId: '33333333-3333-4333-8333-333333333333',
        claimedAtMs: CROSSING_MS + 100,
      });
      expect(claim).toMatchObject({ outcome: 'claimed', record: {
        state: 'queued', executionIntent: 'A private hello.',
        originIcpRootInitiationId: '33333333-3333-4333-8333-333333333333',
      } });
      expect(await store.getDestinationStatus(COMPANION_ID, 'human:contact-a:discord:dm-a')).toMatchObject({
        pending: { opportunityId: OPPORTUNITY_ID, state: 'queued' }, latestTerminal: null,
      });
      const begun = await Promise.all([
        store.beginExecution(OPPORTUNITY_ID, 'a'.repeat(64), CROSSING_MS + 200),
        store.beginExecution(OPPORTUNITY_ID, 'a'.repeat(64), CROSSING_MS + 200),
      ]);
      expect(begun.sort()).toEqual([false, true]);
      expect(await store.listRecoverable(COMPANION_ID)).toEqual([]);
      await expect(store.deferExecution({ opportunityId: OPPORTUNITY_ID, bindingHash: 'b'.repeat(64),
        reasonCode: 'quiet_hours', deferredAtMs: CROSSING_MS + 210 })).rejects.toThrow('exact unsent execution claim');
      const deferred = await store.deferExecution({ opportunityId: OPPORTUNITY_ID, bindingHash: 'a'.repeat(64),
        reasonCode: 'quiet_hours', deferredAtMs: CROSSING_MS + 220 });
      expect(deferred).toMatchObject({ state: 'queued', bindingHash: 'a'.repeat(64), executionIntent: 'A private hello.',
        originIcpRootInitiationId: '33333333-3333-4333-8333-333333333333', reasonCode: 'quiet_hours' });
      expect(await store.listRecoverable(COMPANION_ID)).toMatchObject([{ opportunityId: OPPORTUNITY_ID, state: 'queued' }]);
      await expect(store.deferExecution({ opportunityId: OPPORTUNITY_ID, bindingHash: 'a'.repeat(64),
        reasonCode: 'quiet_hours', deferredAtMs: CROSSING_MS + 230 })).rejects.toThrow('exact unsent execution claim');
      expect(await store.beginExecution(OPPORTUNITY_ID, 'a'.repeat(64), CROSSING_MS + 240)).toBe(true);
      await store.finalize({
        opportunityId: OPPORTUNITY_ID, bindingHash: 'a'.repeat(64),
        state: 'delivered', finalizedAtMs: CROSSING_MS + 300,
      });
      expect(await store.getOpportunity(OPPORTUNITY_ID)).toMatchObject({
        state: 'delivered', executionIntent: null,
      });
      await expect(store.deferExecution({ opportunityId: OPPORTUNITY_ID, bindingHash: 'a'.repeat(64),
        reasonCode: 'quiet_hours', deferredAtMs: CROSSING_MS + 310 })).rejects.toThrow('exact unsent execution claim');
      expect(await store.getDestinationStatus(COMPANION_ID, 'human:contact-a:discord:dm-a')).toMatchObject({
        pending: null, latestTerminal: { opportunityId: OPPORTUNITY_ID, state: 'delivered' },
      });
      await store.createOpportunity({ ...original!, opportunityId: `felt-impulse:would_message:${CROSSING_MS + 1}`,
        impulseDedupeKey: `felt-impulse:would_message:${CROSSING_MS + 1}`, firstCrossingMs: CROSSING_MS + 1, firedAtMs: CROSSING_MS + 1,
        companionId: '22222222-2222-4222-8222-222222222222' });
      expect(await store.getHealthSummary(COMPANION_ID)).toEqual({
        total: 1, states: [{ state: 'delivered', count: 1, lastUpdatedAtMs: CROSSING_MS + 300 }],
        lastFiredAtMs: CROSSING_MS, lastDeliveredAtMs: CROSSING_MS + 300,
      });
      expect(await store.getHealthSummary('33333333-3333-4333-8333-333333333333')).toEqual({
        total: 0, states: [], lastFiredAtMs: null, lastDeliveredAtMs: null,
      });
    } finally {
      await store.close();
    }
  });

  it('reads bounded active and terminal destination evidence without newer defers or other owners hiding it', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresSocialImpulseOutreachStore.connect(database.databaseUrl, { schema: 'companion_a' });
    const destination = { kind: 'human_dm' as const, destinationId: 'human:contact-a:discord:dm-a',
      contactId: 'contact-a', displayLabel: 'Trusted person', channelId: 'dm-a',
      channelType: 'discord' as const, dyadId: null };
    const create = async (offset: number, companionId = COMPANION_ID) => {
      const at = CROSSING_MS + offset;
      const opportunityId = `felt-impulse:would_message:${at}`;
      await store.createOpportunity({ schemaVersion: 1, opportunityId, companionId,
        impulseDedupeKey: opportunityId, firstCrossingMs: at, firedAtMs: at,
        modeAtCreation: 'on', state: 'pending', disposition: null, destination: null,
        bindingHash: null, executionIntent: null, originIcpRootInitiationId: null,
        reasonCode: null, createdAtMs: at, updatedAtMs: at });
      return opportunityId;
    };
    const claim = async (opportunityId: string, target = destination) => store.claimDisposition({
      opportunityId, disposition: 'contact-human', destination: target,
      bindingHash: 'a'.repeat(64), executionIntent: 'Private greeting intent.', claimedAtMs: CROSSING_MS + 100,
    });
    try {
      const queued = await create(1); await claim(queued);
      const suppressed = await create(2); await claim(suppressed);
      await store.finalize({ opportunityId: suppressed, bindingHash: 'a'.repeat(64),
        state: 'suppressed', reasonCode: 'social_desire_recipient_timezone_unavailable', finalizedAtMs: CROSSING_MS + 200 });
      const deferred = await create(3);
      await store.claimDisposition({ opportunityId: deferred, disposition: 'defer', destination: null,
        bindingHash: 'b'.repeat(64), claimedAtMs: CROSSING_MS + 300 });
      await store.finalize({ opportunityId: deferred, bindingHash: 'b'.repeat(64), state: 'defer', finalizedAtMs: CROSSING_MS + 300 });
      const sibling = await create(4, '22222222-2222-4222-8222-222222222222'); await claim(sibling);
      await store.finalize({ opportunityId: sibling, bindingHash: 'a'.repeat(64), state: 'delivered', finalizedAtMs: CROSSING_MS + 400 });
      const otherDestination = await create(5);
      await claim(otherDestination, { ...destination, destinationId: 'human:other:discord:other', contactId: 'other', channelId: 'other' });
      await store.finalize({ opportunityId: otherDestination, bindingHash: 'a'.repeat(64), state: 'delivered', finalizedAtMs: CROSSING_MS + 500 });

      expect(await store.getDestinationStatus(COMPANION_ID, destination.destinationId)).toMatchObject({
        pending: { opportunityId: queued, state: 'queued' },
        latestTerminal: { opportunityId: suppressed, state: 'suppressed', reasonCode: 'social_desire_recipient_timezone_unavailable' },
      });
      expect(await store.getDestinationStatus('33333333-3333-4333-8333-333333333333', destination.destinationId))
        .toEqual({ pending: null, latestTerminal: null });
      expect(await store.getDestinationStatus(COMPANION_ID, 'unavailable-destination'))
        .toEqual({ pending: null, latestTerminal: null });
      await store.beginExecution(queued, 'a'.repeat(64), CROSSING_MS + 600);
      expect(await store.getDestinationStatus(COMPANION_ID, destination.destinationId)).toMatchObject({
        pending: { opportunityId: queued, state: 'chosen' }, latestTerminal: { opportunityId: suppressed },
      });
    } finally { await store.close(); }
  });
});
