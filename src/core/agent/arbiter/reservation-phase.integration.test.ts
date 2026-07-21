// Live-database integration for the speaking-arbiter reservation phase
// (jp36.5.1.2). Exercises the reservation phase over the REAL Postgres arbiter
// store (a throwaway dockerized postgres, fresh database) — what a mocked store
// cannot cover: that an admitted candidate places a durable reservation, that a
// gated candidate places none, and that an `ignore` settlement durably releases
// the reservation. The social pot and ICP precedence are stubbed here; their own
// integration lives with their stores.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SpeakingReservationPhase } from './reservation-phase.js';
import type { ReservationPhaseConfig, ReservationSignalContext } from './reservation-phase.js';
import type { SocialPotSnapshot } from '../fatigue/social-pot.js';
import { PostgresSpeakingArbiterStore } from '../../../persistence/postgres/speaking-arbiter-store.js';
import { bootstrapSharedSchema } from '../../../persistence/postgres/shared-schema.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';

const TEST_IMAGE = 'postgres:16-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;

const COMPANION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHANNEL = 'discord:guild-1:room-general';

function makeConfig(): ReservationPhaseConfig {
  return {
    reservationTtlMs: 120_000,
    minReserveDrawUnits: 1,
    socialPot: {
      capUnits: 240,
      perChannelDrawFraction: 0.34,
      regenerationTickMs: 3_600_000,
      regenerationUnitsPerTick: 10,
    },
    roomEpisodeCircuitBreaker: { tripThreshold: 100, resetThreshold: 40 },
    wrapUpThreshold: 60,
  };
}

function stubPot(balance: number): { readPot: () => Promise<SocialPotSnapshot> } {
  return {
    readPot: async () => ({
      companionId: COMPANION,
      balance,
      cap: 240,
      lastRegenAtMs: 0,
      revision: 1,
    }),
  };
}

function ctx(nowMs: number, overrides: Partial<ReservationSignalContext> = {}): ReservationSignalContext {
  return { channelId: CHANNEL, triggerEventId: 'evt-1', companionId: COMPANION, nowMs, ...overrides };
}

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) {
    await harness.stop();
  }
}, INTEGRATION_TIMEOUT_MS);

async function connectStore(): Promise<PostgresSpeakingArbiterStore> {
  if (!harness) {
    throw new Error('Postgres integration harness is not available');
  }
  const database = await harness.createDatabase();
  // The store no longer runs DDL: the gateway migration authority provisions
  // the shared schema before agents connect. Mirror that here.
  await bootstrapSharedSchema(database.databaseUrl);
  return PostgresSpeakingArbiterStore.connect(database.databaseUrl);
}

describe('speaking reservation phase integration', () => {
  it(
    'places a durable non-exclusive reservation when the gates admit',
    async () => {
      const store = await connectStore();
      try {
        const phase = new SpeakingReservationPhase({
          store,
          socialPot: stubPot(100),
          icpPrecedence: { resolve: () => ({ icpTurnFenced: false, icpFatigueExhausted: false }) },
          companionId: COMPANION,
          config: makeConfig(),
        });

        const decision = await phase.reserve(ctx(1_000));
        expect(decision.outcome).toBe('reserved');
        if (decision.outcome !== 'reserved') return;
        expect(decision.replayed).toBe(false);

        // The reservation is durable: a second reserve for the same event replays
        // the SAME row (idempotent per channel/event/companion).
        const again = await phase.reserve(ctx(1_100));
        expect(again.outcome).toBe('reserved');
        if (again.outcome !== 'reserved') return;
        expect(again.replayed).toBe(true);
        expect(again.reservation.reservationId).toBe(decision.reservation.reservationId);
        expect(again.reservation.status).toBe('reserved');
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'places no reservation when a deterministic gate blocks the candidate',
    async () => {
      const store = await connectStore();
      try {
        const gatedPhase = new SpeakingReservationPhase({
          store,
          socialPot: stubPot(0), // below minReserveDrawUnits → fatigue_pot_insufficient
          icpPrecedence: { resolve: () => ({ icpTurnFenced: false, icpFatigueExhausted: false }) },
          companionId: COMPANION,
          config: makeConfig(),
        });
        const gated = await gatedPhase.reserve(ctx(1_000));
        expect(gated).toEqual({ outcome: 'gated', blockedBy: 'fatigue_pot_insufficient' });

        // Nothing was persisted: a now-funded phase reserving the same event
        // creates a FRESH reservation (not a replay of a gated one).
        const fundedPhase = new SpeakingReservationPhase({
          store,
          socialPot: stubPot(100),
          icpPrecedence: { resolve: () => ({ icpTurnFenced: false, icpFatigueExhausted: false }) },
          companionId: COMPANION,
          config: makeConfig(),
        });
        const fresh = await fundedPhase.reserve(ctx(2_000));
        expect(fresh.outcome).toBe('reserved');
        if (fresh.outcome !== 'reserved') return;
        expect(fresh.replayed).toBe(false);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'durably releases the reservation on an ignore settlement',
    async () => {
      const store = await connectStore();
      try {
        const phase = new SpeakingReservationPhase({
          store,
          socialPot: stubPot(100),
          icpPrecedence: { resolve: () => ({ icpTurnFenced: false, icpFatigueExhausted: false }) },
          companionId: COMPANION,
          config: makeConfig(),
        });

        const decision = await phase.reserve(ctx(1_000));
        expect(decision.outcome).toBe('reserved');
        if (decision.outcome !== 'reserved') return;

        const settlement = await phase.settleAfterAppraisal(decision.reservation, 'ignore', 1_500);
        expect(settlement).toBe('released');

        // The release is durable: replaying the reservation shows it released.
        const replay = await phase.reserve(ctx(1_600));
        expect(replay.outcome).toBe('reserved');
        if (replay.outcome !== 'reserved') return;
        expect(replay.replayed).toBe(true);
        expect(replay.reservation.status).toBe('released');
        expect(replay.reservation.reason).toBe('ignore');
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'retains the reservation on a reply settlement (handed to the egress phase)',
    async () => {
      const store = await connectStore();
      try {
        const phase = new SpeakingReservationPhase({
          store,
          socialPot: stubPot(100),
          icpPrecedence: { resolve: () => ({ icpTurnFenced: false, icpFatigueExhausted: false }) },
          companionId: COMPANION,
          config: makeConfig(),
        });

        const decision = await phase.reserve(ctx(1_000));
        expect(decision.outcome).toBe('reserved');
        if (decision.outcome !== 'reserved') return;

        const settlement = await phase.settleAfterAppraisal(decision.reservation, 'reply', 1_500);
        expect(settlement).toBe('retained');

        // Still reserved for the egress-lease phase (jp36.5.1.3).
        const replay = await phase.reserve(ctx(1_600));
        expect(replay.outcome).toBe('reserved');
        if (replay.outcome !== 'reserved') return;
        expect(replay.reservation.status).toBe('reserved');
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
