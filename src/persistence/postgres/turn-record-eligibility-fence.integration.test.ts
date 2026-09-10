import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';

import {
  PostgresPoolOwner,
  createPostgresPool,
  ensurePostgresSchemaExists,
  runWithPostgresPoolOwner,
} from '../postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { PostgresBackgroundWorkStore } from './background-work-store.js';
import {
  PostgresTurnRecordEligibilityFence,
  TURN_RECORD_ELIGIBILITY_FENCE_POOL_CAPACITY,
  TURN_RECORD_ELIGIBILITY_FENCE_POOL_LANE,
} from './turn-record-eligibility-fence.js';

const SCHEMA = 'companion_fence';
const SHARED_LANE_CAPACITY = 3;
const NESTED_CONNECT_TIMEOUT_MS = 750;

async function provisionSchema(databaseUrl: string): Promise<void> {
  const bootstrap = createPostgresPool(databaseUrl, { applicationName: 'fence-bootstrap', max: 1 });
  try {
    await ensurePostgresSchemaExists(bootstrap, SCHEMA);
  } finally {
    await bootstrap.end();
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * The stall shape from bead psfn-framework-52epa: a fenced background
 * operation holds one pool client for its whole duration and, inside, needs a
 * second client from the same pool (the claim-ownership check every post-turn
 * handler makes first). Three such holders on a capacity-three lane leave
 * nothing for the nested check — or for a foreground turn.
 */
async function runFencedHoldersWithNestedAccess(
  fence: PostgresTurnRecordEligibilityFence,
  nested: Pool,
  holderCount: number,
): Promise<{ allHeld: Promise<void>; release: () => void; results: Promise<PromiseSettledResult<void>[]> }> {
  const release = deferred();
  let heldCount = 0;
  const allHeld = deferred();
  const results = Promise.allSettled(Array.from({ length: holderCount }, (_, index) => (
    fence.withTurnRecordEligibilityFence(
      { logicalSessionId: `session-${String(index)}`, turnId: `turn-${String(index)}` },
      async () => {
        heldCount += 1;
        if (heldCount === holderCount) allHeld.resolve();
        // What `effects.assertOwned()` does under the fence: one more client.
        await nested.query('SELECT 1');
        await release.promise;
      },
    )
  )));
  return { allHeld: allHeld.promise, release: release.resolve, results };
}

describe('PostgresTurnRecordEligibilityFence against PostgreSQL', () => {
  let harness: PostgresTestHarness;

  beforeAll(async () => {
    harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
  }, 90_000);

  afterAll(async () => {
    await harness.stop();
  }, 30_000);

  it('deadlocks three fenced holders and a foreground caller on one capacity-three lane (the pre-fix shape)', async () => {
    const database = await harness.createDatabase();
    await provisionSchema(database.databaseUrl);
    // A raw pool outside any owner: the exact shared-lane capacity, with a
    // bounded wait so the deadlock reports itself instead of hanging the test.
    const shared = createPostgresPool(database.databaseUrl, {
      applicationName: 'fence-shared-lane',
      schema: SCHEMA,
      max: SHARED_LANE_CAPACITY,
      connectionTimeoutMillis: NESTED_CONNECT_TIMEOUT_MS,
    });
    try {
      const fence = new PostgresTurnRecordEligibilityFence(shared, SCHEMA);
      const holders = await runFencedHoldersWithNestedAccess(fence, shared, SHARED_LANE_CAPACITY);
      await holders.allHeld;

      // The foreground turn's first durable step waits on the same lane.
      await expect(shared.query('SELECT 1')).rejects.toThrow('timeout exceeded when trying to connect');

      holders.release();
      const settled = await holders.results;
      // Every holder's nested access timed out too: each was waiting on the
      // clients the other holders were keeping.
      expect(settled.map(result => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
      for (const result of settled) {
        expect(result.status === 'rejected' && String(result.reason))
          .toContain('timeout exceeded when trying to connect');
      }
      // Every fence released its client and its advisory key on the way out.
      await expect(shared.query('SELECT 1')).resolves.toBeDefined();
      const locks = await shared.query<{ count: string }>(
        "SELECT count(*) AS count FROM pg_locks WHERE locktype = 'advisory'",
      );
      expect(Number(locks.rows[0]?.count)).toBe(0);
    } finally {
      await shared.end();
    }
  }, 30_000);

  it('keeps foreground work and nested claim checks flowing when the fence has its own lane', async () => {
    const database = await harness.createDatabase();
    await provisionSchema(database.databaseUrl);
    const owner = new PostgresPoolOwner('test');
    let shared!: Pool;
    let fencePool!: Pool;
    let store!: PostgresBackgroundWorkStore;
    try {
      await runWithPostgresPoolOwner(owner, async () => {
        // Production composition: every store of the authority shares one
        // capacity-three physical pool; the fence rides its own lane.
        shared = createPostgresPool(database.databaseUrl, {
          applicationName: 'fence-shared-lane',
          schema: SCHEMA,
          connectionTimeoutMillis: NESTED_CONNECT_TIMEOUT_MS,
        });
        fencePool = createPostgresPool(database.databaseUrl, {
          applicationName: TURN_RECORD_ELIGIBILITY_FENCE_POOL_LANE,
          schema: SCHEMA,
          lane: TURN_RECORD_ELIGIBILITY_FENCE_POOL_LANE,
          max: TURN_RECORD_ELIGIBILITY_FENCE_POOL_CAPACITY,
          connectionTimeoutMillis: NESTED_CONNECT_TIMEOUT_MS,
        });
        store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, { schema: SCHEMA });
      });
      expect(shared.options.max).toBe(SHARED_LANE_CAPACITY);
      expect(owner.telemetry().physicalPoolCount).toBe(2);

      const fence = new PostgresTurnRecordEligibilityFence(fencePool, SCHEMA);
      // One more holder than the shared lane could ever carry.
      const holders = await runFencedHoldersWithNestedAccess(
        fence,
        shared,
        SHARED_LANE_CAPACITY + 1,
      );
      await holders.allHeld;

      // A later turn on another channel: `beginForeground` on the shared lane
      // completes while four background fences are held.
      await expect(store.beginForeground({
        logicalSessionId: 'session-foreground',
        leaseOwner: 'turn-owner',
        leaseId: 'lease-foreground',
        nowMs: Date.now(),
        leaseDurationMs: 60_000,
      })).resolves.toBeUndefined();
      await expect(shared.query('SELECT 1')).resolves.toBeDefined();

      holders.release();
      const settled = await holders.results;
      expect(settled.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
      await expect(store.endForeground({
        logicalSessionId: 'session-foreground',
        leaseOwner: 'turn-owner',
        leaseId: 'lease-foreground',
        nowMs: Date.now(),
      })).resolves.toBe(true);
    } finally {
      await store.close();
      await Promise.allSettled([shared.end(), fencePool.end()]);
      await owner.close();
    }
  }, 30_000);

  it('times out behind a held advisory key, releases the waiter, and acquires once the holder lets go', async () => {
    const database = await harness.createDatabase();
    await provisionSchema(database.databaseUrl);
    const pool = createPostgresPool(database.databaseUrl, {
      applicationName: 'fence-timeout',
      schema: SCHEMA,
      max: 2,
    });
    let holder: PoolClient | undefined;
    try {
      const fence = new PostgresTurnRecordEligibilityFence(pool, SCHEMA, { acquireTimeoutMs: 400 });
      const key = { logicalSessionId: 'session-held', turnId: 'turn-held' };
      const advisoryKey = JSON.stringify(['turn-record-source-eligibility-v2', SCHEMA, key.turnId]);
      holder = await pool.connect();
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [advisoryKey]);

      const startedAt = Date.now();
      await expect(fence.withTurnRecordEligibilityFence(key, async () => 'should-not-run'))
        .rejects.toMatchObject({ name: 'TurnRecordEligibilityFenceTimeoutError', phase: 'acquire' });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      // The waiter's client is back in the pool: a second acquire attempt
      // would otherwise exhaust a two-client pool.
      expect(pool.idleCount + (pool.totalCount - pool.idleCount)).toBeLessThanOrEqual(2);

      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [advisoryKey]);
      await expect(fence.withTurnRecordEligibilityFence(key, async () => 'ran')).resolves.toBe('ran');
    } finally {
      holder?.release();
      await pool.end();
    }
  }, 30_000);
});
