// Live-database integration tests for the per-companion social pot store
// (jp36.4.1.1). Follows the shared-schema harness pattern: a throwaway
// dockerized postgres, a fresh database per test. Covers what a mocked pool
// cannot: real DDL for the shared chain, durable regeneration/draw semantics,
// and — the acceptance criterion — that the pot survives a process restart.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SocialPotConfig } from '../../core/agent/fatigue/social-pot.js';
import { PostgresSocialPotStore } from './social-pot-store.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';

const TEST_IMAGE = 'postgres:16-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;

const COMPANION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const TICK_MS = 60 * 60_000;
const CONFIG: SocialPotConfig = {
  capUnits: 24,
  regenerationTickMs: TICK_MS,
  regenerationUnitsPerTick: 1,
};

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) {
    await harness.stop();
  }
}, INTEGRATION_TIMEOUT_MS);

async function freshDatabaseUrl(): Promise<string> {
  if (!harness) {
    throw new Error('Postgres integration harness is not available');
  }
  const database = await harness.createDatabase();
  return database.databaseUrl;
}

describe('companion_social_pot store integration', () => {
  it(
    'initializes a full pot, provisioning the table in the shared schema only',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSocialPotStore.connect(databaseUrl);
      try {
        const snapshot = await store.readPot({
          companionId: COMPANION_A,
          nowMs: TICK_MS,
          config: CONFIG,
        });
        expect(snapshot.balance).toBe(CONFIG.capUnits);
        expect(snapshot.cap).toBe(CONFIG.capUnits);
        expect(snapshot.lastRegenAtMs).toBe(TICK_MS);
        expect(snapshot.revision).toBe(1);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'persists the drained balance across a store restart',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const first = await PostgresSocialPotStore.connect(databaseUrl);
      let drawnRevision: number;
      try {
        // Seed the pot at t0 (full), then draw within the same tick so no
        // regeneration masks the draw.
        await first.readPot({ companionId: COMPANION_A, nowMs: 0, config: CONFIG });
        const draw = await first.draw({
          companionId: COMPANION_A,
          nowMs: 0,
          amount: 10,
          config: CONFIG,
        });
        expect(draw.outcome).toBe('drawn');
        expect(draw.drawn).toBe(10);
        expect(draw.before.balance).toBe(24);
        expect(draw.after.balance).toBe(14);
        drawnRevision = draw.after.revision;
      } finally {
        await first.close();
      }

      // Restart: a fresh store instance against the same database, reading in
      // the same tick so regeneration does not move the balance.
      const restarted = await PostgresSocialPotStore.connect(databaseUrl);
      try {
        const snapshot = await restarted.readPot({
          companionId: COMPANION_A,
          nowMs: 0,
          config: CONFIG,
        });
        expect(snapshot.balance).toBe(14);
        expect(snapshot.revision).toBe(drawnRevision);
      } finally {
        await restarted.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'regenerates lazily on read and persists the regenerated balance and tick boundary',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSocialPotStore.connect(databaseUrl);
      try {
        await store.readPot({ companionId: COMPANION_A, nowMs: 0, config: CONFIG });
        await store.draw({ companionId: COMPANION_A, nowMs: 0, amount: 20, config: CONFIG });

        // Four full ticks later: +4 units on the remaining 4.
        const regenerated = await store.readPot({
          companionId: COMPANION_A,
          nowMs: 4 * TICK_MS + 30 * 60_000,
          config: CONFIG,
        });
        expect(regenerated.balance).toBe(8);
        expect(regenerated.lastRegenAtMs).toBe(4 * TICK_MS);

        // A re-read at the same instant must not double-credit.
        const stable = await store.readPot({
          companionId: COMPANION_A,
          nowMs: 4 * TICK_MS + 30 * 60_000,
          config: CONFIG,
        });
        expect(stable.balance).toBe(8);
        expect(stable.revision).toBe(regenerated.revision);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'refuses a draw larger than the balance without partial spend, keeping regeneration',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSocialPotStore.connect(databaseUrl);
      try {
        await store.readPot({ companionId: COMPANION_A, nowMs: 0, config: CONFIG });
        await store.draw({ companionId: COMPANION_A, nowMs: 0, amount: 22, config: CONFIG });

        // Balance is 2; one tick later it is 3. Request 10 -> insufficient, but
        // the regeneration to 3 still persists.
        const result = await store.draw({
          companionId: COMPANION_A,
          nowMs: TICK_MS,
          amount: 10,
          config: CONFIG,
        });
        expect(result.outcome).toBe('insufficient');
        expect(result.drawn).toBe(0);
        expect(result.before.balance).toBe(3);
        expect(result.after.balance).toBe(3);

        const snapshot = await store.readPot({
          companionId: COMPANION_A,
          nowMs: TICK_MS,
          config: CONFIG,
        });
        expect(snapshot.balance).toBe(3);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'keeps per-companion pots independent',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSocialPotStore.connect(databaseUrl);
      try {
        await store.draw({ companionId: COMPANION_A, nowMs: 0, amount: 15, config: CONFIG });
        const a = await store.readPot({ companionId: COMPANION_A, nowMs: 0, config: CONFIG });
        const b = await store.readPot({ companionId: COMPANION_B, nowMs: 0, config: CONFIG });
        expect(a.balance).toBe(9);
        expect(b.balance).toBe(CONFIG.capUnits);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'serializes concurrent draws so the pot never over-spends',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSocialPotStore.connect(databaseUrl);
      try {
        await store.readPot({ companionId: COMPANION_A, nowMs: 0, config: CONFIG });
        // 24 in the pot, 30 concurrent unit draws. Exactly 24 must succeed.
        const results = await Promise.all(
          Array.from({ length: 30 }, () =>
            store.draw({ companionId: COMPANION_A, nowMs: 0, amount: 1, config: CONFIG }),
          ),
        );
        const drawn = results.filter((result) => result.outcome === 'drawn').length;
        expect(drawn).toBe(24);
        const snapshot = await store.readPot({
          companionId: COMPANION_A,
          nowMs: 0,
          config: CONFIG,
        });
        expect(snapshot.balance).toBe(0);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
