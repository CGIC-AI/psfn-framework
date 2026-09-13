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
      await ensurePostgresSchema(pool, POSTGRES_INTENTION_MIGRATIONS.slice(0, -4));
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
      const begun = await Promise.all([
        store.beginExecution(OPPORTUNITY_ID, 'a'.repeat(64), CROSSING_MS + 200),
        store.beginExecution(OPPORTUNITY_ID, 'a'.repeat(64), CROSSING_MS + 200),
      ]);
      expect(begun.sort()).toEqual([false, true]);
      expect(await store.listRecoverable(COMPANION_ID)).toEqual([]);
      await store.finalize({
        opportunityId: OPPORTUNITY_ID, bindingHash: 'a'.repeat(64),
        state: 'delivered', finalizedAtMs: CROSSING_MS + 300,
      });
      expect(await store.getOpportunity(OPPORTUNITY_ID)).toMatchObject({
        state: 'delivered', executionIntent: null,
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
});
