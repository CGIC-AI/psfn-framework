import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createPostgresPool, ensurePostgresSchema, ensurePostgresSchemaExists } from '../../../persistence/postgres.js';
import { POSTGRES_INTENTION_MIGRATIONS } from '../../../persistence/postgres/migrations.js';
import { PostgresSocialDesireStore } from './social-desire-adapter.js';

describe('Postgres social desire per-contact pacing (vcq8v.4)', () => {
  let harness: PostgresTestHarness;
  beforeAll(async () => { harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE }); });
  afterAll(async () => { await harness.stop(); });

  it('round-trips the cooldown anchor and the deferred re-evaluation time', async () => {
    const database = await harness.createDatabase();
    const pool = createPostgresPool(database.databaseUrl, { schema: 'companion_a' });
    try {
      await ensurePostgresSchemaExists(pool, 'companion_a');
      await ensurePostgresSchema(pool, POSTGRES_INTENTION_MIGRATIONS);
      const store = new PostgresSocialDesireStore(pool);
      const at = '2026-09-23T15:00:00.000Z';
      await store.save({
        contactId: 'contact-1', warmPressure: 0.7, repairPressure: 0, pressureAnchorAt: at,
        lastWarmFeltAt: at, lastWarmTickAt: at, tickCount: 2, absorbedSignalCount: 0,
        tierAtLastTick: 'partner', reinforcedConcernIds: [], createdAt: at,
        lastConsentMomentAt: at, deferredUntil: '2026-09-23T18:00:00.000Z',
      });
      const fresh = new PostgresSocialDesireStore(pool);
      await fresh.hydrateCache();
      expect(fresh.snapshotDesires()).toEqual([expect.objectContaining({
        contactId: 'contact-1',
        lastConsentMomentAt: at,
        deferredUntil: '2026-09-23T18:00:00.000Z',
      })]);
    } finally {
      await pool.end();
    }
  });
});
