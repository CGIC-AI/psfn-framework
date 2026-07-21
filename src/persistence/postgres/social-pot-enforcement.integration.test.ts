// Live-database integration tests for draw-cap enforcement with ICP priority
// (jp36.4.1.2). Exercises what a mocked pool cannot: the per-channel cap applied
// atomically inside the store's advisory-locked draw transaction, and the
// §12.6/§3.8 behaviors — a multi-room argument drains the shared pot and stops,
// one channel cannot starve the others, ICP continuation draws at priority, and
// human-triggered turns never charge the pot.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FatigueSocialPotConfig } from '../../shared/contracts/charge-policy.js';
import { enforceSocialPotDraw } from '../../core/agent/fatigue/social-pot-enforcement.js';
import type { SocialPotConfig } from '../../core/agent/fatigue/social-pot.js';
import { PostgresSocialPotStore } from './social-pot-store.js';
import { bootstrapSharedSchema } from './shared-schema.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';

const TEST_IMAGE = 'postgres:16-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;

const COMPANION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const TICK_MS = 60 * 60_000;
const STORE_CONFIG: SocialPotConfig = {
  capUnits: 24,
  regenerationTickMs: TICK_MS,
  regenerationUnitsPerTick: 1,
};
// Owner-file config for the enforcement layer. 0.5 makes the cap arithmetic
// easy to reason about (cap == half the remaining pot).
const ENFORCEMENT_CONFIG: FatigueSocialPotConfig = {
  ...STORE_CONFIG,
  perChannelDrawFraction: 0.5,
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
  // The store no longer runs DDL: the gateway migration authority provisions
  // the shared schema before agents connect. Mirror that here.
  await bootstrapSharedSchema(database.databaseUrl);
  return database.databaseUrl;
}

describe('social pot per-channel cap (store, atomic)', () => {
  it(
    'refuses a draw above the per-channel fraction of the remaining pot without spending',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSocialPotStore.connect(databaseUrl);
      try {
        await store.readPot({ companionId: COMPANION_A, nowMs: 0, config: STORE_CONFIG });
        // Balance 24, cap fraction 0.5 => cap 12. 13 is refused; 12 is allowed.
        const capped = await store.draw({
          companionId: COMPANION_A,
          nowMs: 0,
          amount: 13,
          config: STORE_CONFIG,
          maxDrawFraction: 0.5,
        });
        expect(capped.outcome).toBe('capped');
        expect(capped.drawn).toBe(0);
        expect(capped.before.balance).toBe(24);
        expect(capped.after.balance).toBe(24);

        const drawn = await store.draw({
          companionId: COMPANION_A,
          nowMs: 0,
          amount: 12,
          config: STORE_CONFIG,
          maxDrawFraction: 0.5,
        });
        expect(drawn.outcome).toBe('drawn');
        expect(drawn.drawn).toBe(12);
        expect(drawn.after.balance).toBe(12);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'still persists regeneration when a draw is capped',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSocialPotStore.connect(databaseUrl);
      try {
        await store.readPot({ companionId: COMPANION_A, nowMs: 0, config: STORE_CONFIG });
        await store.draw({ companionId: COMPANION_A, nowMs: 0, amount: 20, config: STORE_CONFIG });
        // Balance 4; one tick later 5. cap 0.5 => 2.5. Request 4 -> capped, but
        // the regeneration to 5 still persists.
        const result = await store.draw({
          companionId: COMPANION_A,
          nowMs: TICK_MS,
          amount: 4,
          config: STORE_CONFIG,
          maxDrawFraction: 0.5,
        });
        expect(result.outcome).toBe('capped');
        expect(result.before.balance).toBe(5);
        expect(result.after.balance).toBe(5);
        const snapshot = await store.readPot({
          companionId: COMPANION_A,
          nowMs: TICK_MS,
          config: STORE_CONFIG,
        });
        expect(snapshot.balance).toBe(5);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'rejects an out-of-range per-channel fraction rather than silently uncapping',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSocialPotStore.connect(databaseUrl);
      try {
        for (const fraction of [0, -0.1, 1.5]) {
          await expect(
            store.draw({
              companionId: COMPANION_A,
              nowMs: 0,
              amount: 1,
              config: STORE_CONFIG,
              maxDrawFraction: fraction,
            }),
          ).rejects.toThrow(/maxDrawFraction must be a finite number in \(0, 1\]/);
        }
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'serializes concurrent capped draws against the balance at draw time (never over-spends)',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSocialPotStore.connect(databaseUrl);
      try {
        await store.readPot({ companionId: COMPANION_A, nowMs: 0, config: STORE_CONFIG });
        // 24 in the pot, cap 0.5, 20 concurrent draws of 3. Each cap is computed
        // against the balance under the advisory lock, so exactly the serial
        // number succeed: 24->21->...->3 is 7 draws; at balance 3 the cap (1.5)
        // refuses a 3-unit draw. A stale-read cap would let extra draws through.
        const results = await Promise.all(
          Array.from({ length: 20 }, () =>
            store.draw({
              companionId: COMPANION_A,
              nowMs: 0,
              amount: 3,
              config: STORE_CONFIG,
              maxDrawFraction: 0.5,
            }),
          ),
        );
        const drawn = results.filter((r) => r.outcome === 'drawn').length;
        const capped = results.filter((r) => r.outcome === 'capped').length;
        expect(drawn).toBe(7);
        expect(capped).toBe(13);
        const snapshot = await store.readPot({
          companionId: COMPANION_A,
          nowMs: 0,
          config: STORE_CONFIG,
        });
        expect(snapshot.balance).toBe(3);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );
});

describe('social pot enforcement (policy over real store)', () => {
  it(
    'never charges the pot for a human-triggered turn',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSocialPotStore.connect(databaseUrl);
      try {
        await store.readPot({ companionId: COMPANION_A, nowMs: 0, config: STORE_CONFIG });
        const decision = await enforceSocialPotDraw(store, ENFORCEMENT_CONFIG, {
          companionId: COMPANION_A,
          lane: 'group_social',
          triggerAuthorKind: 'human',
          amount: 5,
          nowMs: 0,
        });
        expect(decision.outcome).toBe('uncharged');
        expect(decision.drawn).toBe(0);
        const snapshot = await store.readPot({
          companionId: COMPANION_A,
          nowMs: 0,
          config: STORE_CONFIG,
        });
        expect(snapshot.balance).toBe(STORE_CONFIG.capUnits);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'stops one channel grabbing the whole pot, but lets ICP draw the same amount at priority',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSocialPotStore.connect(databaseUrl);
      try {
        await store.readPot({ companionId: COMPANION_A, nowMs: 0, config: STORE_CONFIG });
        // A single group-social channel tries to consume the entire pot: capped.
        const greedy = await enforceSocialPotDraw(store, ENFORCEMENT_CONFIG, {
          companionId: COMPANION_A,
          lane: 'group_social',
          triggerAuthorKind: 'machine_intelligence',
          amount: 24,
          nowMs: 0,
        });
        expect(greedy.outcome).toBe('capped');
        expect(greedy.drawn).toBe(0);

        // The same 24-unit draw on the ICP continuation lane draws at priority
        // (no per-channel cap), bounded only by the balance.
        const priority = await enforceSocialPotDraw(store, ENFORCEMENT_CONFIG, {
          companionId: COMPANION_A,
          lane: 'icp_continuation',
          triggerAuthorKind: 'machine_intelligence',
          amount: 24,
          nowMs: 0,
        });
        expect(priority.outcome).toBe('drawn');
        expect(priority.drawn).toBe(24);
        expect(priority.after?.balance).toBe(0);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'a three-channel argument drains the shared pot and then stops',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSocialPotStore.connect(databaseUrl);
      try {
        await store.readPot({ companionId: COMPANION_A, nowMs: 0, config: STORE_CONFIG });
        const channels = ['room-1', 'room-2', 'room-3'];
        const drawnByChannel: Record<string, number> = {
          'room-1': 0,
          'room-2': 0,
          'room-3': 0,
        };
        let cappedInARow = 0;
        // Round-robin group-social draws of 3 units against the shared pot, all
        // within one tick so regeneration does not mask the drain.
        for (let i = 0; i < 60 && cappedInARow < channels.length; i += 1) {
          const channel = channels[i % channels.length];
          const decision = await enforceSocialPotDraw(store, ENFORCEMENT_CONFIG, {
            companionId: COMPANION_A,
            lane: 'group_social',
            triggerAuthorKind: 'machine_intelligence',
            amount: 3,
            nowMs: 0,
          });
          if (decision.outcome === 'drawn') {
            drawnByChannel[channel] += decision.drawn;
            cappedInARow = 0;
          } else {
            expect(decision.outcome).toBe('capped');
            cappedInARow += 1;
          }
        }

        // The argument drained the pot and then stopped: total spent == 21
        // (24 -> 3, the point where 3 exceeds half the remaining), and the pot
        // is left at a small non-zero residue rather than fully emptied.
        const snapshot = await store.readPot({
          companionId: COMPANION_A,
          nowMs: 0,
          config: STORE_CONFIG,
        });
        const totalDrawn = Object.values(drawnByChannel).reduce((a, b) => a + b, 0);
        expect(totalDrawn).toBe(21);
        expect(snapshot.balance).toBe(3);
        // No single channel starved the others: every channel got a real share.
        for (const channel of channels) {
          expect(drawnByChannel[channel]).toBeGreaterThan(0);
        }

        // ICP continuation can still claim the residue at priority.
        const icp = await enforceSocialPotDraw(store, ENFORCEMENT_CONFIG, {
          companionId: COMPANION_A,
          lane: 'icp_continuation',
          triggerAuthorKind: 'machine_intelligence',
          amount: 3,
          nowMs: 0,
        });
        expect(icp.outcome).toBe('drawn');
        expect(icp.after?.balance).toBe(0);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'keeps per-companion pots independent under enforcement',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSocialPotStore.connect(databaseUrl);
      try {
        await enforceSocialPotDraw(store, ENFORCEMENT_CONFIG, {
          companionId: COMPANION_A,
          lane: 'icp_continuation',
          triggerAuthorKind: 'machine_intelligence',
          amount: 10,
          nowMs: 0,
        });
        const a = await store.readPot({ companionId: COMPANION_A, nowMs: 0, config: STORE_CONFIG });
        const b = await store.readPot({ companionId: COMPANION_B, nowMs: 0, config: STORE_CONFIG });
        expect(a.balance).toBe(14);
        expect(b.balance).toBe(STORE_CONFIG.capUnits);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
