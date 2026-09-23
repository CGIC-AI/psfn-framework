import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import type { SocialImpulseLedgerRecord } from '../../core/emotion/social-impulse-outreach.js';
import { PostgresSocialImpulseOutreachStore } from './social-impulse-outreach-store.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const CROSSING_MS = 1_780_000_000_000;
const IMPULSE_ID = `felt-impulse:would_message:${CROSSING_MS}`;

function received(overrides: Partial<SocialImpulseLedgerRecord> = {}): SocialImpulseLedgerRecord {
  return {
    impulseId: IMPULSE_ID,
    companionId: COMPANION_ID,
    firstCrossingMs: CROSSING_MS,
    firedAtMs: CROSSING_MS,
    confidence: 0.82,
    modeAtReceipt: 'on',
    state: 'received',
    boostedContactCount: 0,
    reasonCode: null,
    createdAtMs: CROSSING_MS,
    updatedAtMs: CROSSING_MS,
    ...overrides,
  };
}

describe('Postgres social impulse ledger', () => {
  let harness: PostgresTestHarness;
  beforeAll(async () => { harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE }); });
  afterAll(async () => { await harness.stop(); });

  it('records each impulse once, settles it once, and reports content-free health', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresSocialImpulseOutreachStore.connect(database.databaseUrl, { schema: 'companion_a' });
    try {
      await expect(store.recordImpulse(received())).resolves.toMatchObject({ created: true });
      const replay = await store.recordImpulse(received({ firedAtMs: CROSSING_MS + 1_000 }));
      expect(replay).toMatchObject({ created: false, record: { firedAtMs: CROSSING_MS, state: 'received' } });
      await expect(store.recordImpulse(received({ companionId: '22222222-2222-4222-8222-222222222222' })))
        .rejects.toThrow('correlation collided');

      const settled = await Promise.allSettled([
        store.settleImpulse({ impulseId: IMPULSE_ID, state: 'applied', boostedContactCount: 2, settledAtMs: CROSSING_MS + 300 }),
        store.settleImpulse({ impulseId: IMPULSE_ID, state: 'applied', boostedContactCount: 2, settledAtMs: CROSSING_MS + 300 }),
      ]);
      expect(settled.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);

      await store.recordImpulse(received({
        impulseId: `felt-impulse:would_message:${CROSSING_MS + 1}`,
        firstCrossingMs: CROSSING_MS + 1,
        firedAtMs: CROSSING_MS + 1,
        companionId: '22222222-2222-4222-8222-222222222222',
      }));
      expect(await store.getHealthSummary(COMPANION_ID)).toEqual({
        total: 1,
        states: [{ state: 'applied', count: 1, lastUpdatedAtMs: CROSSING_MS + 300 }],
        lastFiredAtMs: CROSSING_MS,
        lastDeliveredAtMs: null,
      });
      expect(await store.getHealthSummary('33333333-3333-4333-8333-333333333333')).toEqual({
        total: 0, states: [], lastFiredAtMs: null, lastDeliveredAtMs: null,
      });
    } finally {
      await store.close();
    }
  });
});
