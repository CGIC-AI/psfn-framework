// Live-database integration tests for the gateway speaking-arbiter store
// (jp36.5.1.1). Follows the shared-schema harness pattern: a throwaway
// dockerized postgres, a fresh database per test. Covers what a mocked pool
// cannot: the real shared-chain DDL, exclusive fenced egress leases under
// concurrency, lease expiry/reclaim + fencing-token double-send protection,
// per-channel room-episode pressure transitions, and — the acceptance
// criterion — that reservations, leases, and pressure survive a store restart.

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresSpeakingArbiterStore } from './speaking-arbiter-store.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';

const TEST_IMAGE = 'postgres:16-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;

const COMPANION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COMPANION_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const CHANNEL = 'discord:guild-1:room-general';
const TTL_MS = 60_000;

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

describe('speaking arbiter store integration', () => {
  it(
    'opens exactly one room episode per channel and reserves candidates idempotently',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSpeakingArbiterStore.connect(databaseUrl);
      try {
        const opened = await store.ensureRoomEpisode({ channelId: CHANNEL, nowMs: 1_000 });
        expect(opened.status).toBe('open');
        expect(opened.pressure).toBe(0);
        const again = await store.ensureRoomEpisode({ channelId: CHANNEL, nowMs: 2_000 });
        expect(again.episodeId).toBe(opened.episodeId);

        // Two companions reserve against the SAME triggering event: both allowed.
        const reservationA = await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-1',
          companionId: COMPANION_A,
          nowMs: 3_000,
          expiresAtMs: 3_000 + TTL_MS,
        });
        expect(reservationA.outcome).toBe('reserved');
        expect(reservationA.episode.episodeId).toBe(opened.episodeId);
        const reservationB = await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-1',
          companionId: COMPANION_B,
          nowMs: 3_100,
          expiresAtMs: 3_100 + TTL_MS,
        });
        expect(reservationB.outcome).toBe('reserved');

        // Replaying A's reservation with a NEW id returns the original durable row.
        const replay = await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-1',
          companionId: COMPANION_A,
          nowMs: 3_200,
          expiresAtMs: 3_200 + TTL_MS,
        });
        expect(replay.outcome).toBe('replayed');
        expect(replay.reservation.reservationId).toBe(reservationA.reservation.reservationId);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'grants at most one egress lease per triggering event (two companions, one send)',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSpeakingArbiterStore.connect(databaseUrl);
      try {
        const reservationA = await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-2',
          companionId: COMPANION_A,
          nowMs: 1_000,
          expiresAtMs: 1_000 + TTL_MS,
        });
        const reservationB = await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-2',
          companionId: COMPANION_B,
          nowMs: 1_000,
          expiresAtMs: 1_000 + TTL_MS,
        });

        const acquireA = await store.acquireEgressLease({
          leaseId: randomUUID(),
          reservationId: reservationA.reservation.reservationId,
          channelId: CHANNEL,
          nowMs: 2_000,
          expiresAtMs: 2_000 + TTL_MS,
        });
        expect(acquireA.outcome).toBe('acquired');
        expect(acquireA.lease?.fencingToken).toBe(1);

        const acquireB = await store.acquireEgressLease({
          leaseId: randomUUID(),
          reservationId: reservationB.reservation.reservationId,
          channelId: CHANNEL,
          nowMs: 2_100,
          expiresAtMs: 2_100 + TTL_MS,
        });
        expect(acquireB.outcome).toBe('declined');
        expect(acquireB.lease).toBeNull();
        expect(acquireB.heldBy?.companionId).toBe(COMPANION_A);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'serializes N concurrent acquisitions for one trigger into exactly one grant',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSpeakingArbiterStore.connect(databaseUrl);
      try {
        const companions = [COMPANION_A, COMPANION_B, COMPANION_C];
        const reservations = await Promise.all(
          companions.map((companionId) =>
            store.reserve({
              reservationId: randomUUID(),
              channelId: CHANNEL,
              triggerEventId: 'evt-race',
              companionId,
              nowMs: 1_000,
              expiresAtMs: 1_000 + TTL_MS,
            }),
          ),
        );
        const results = await Promise.all(
          reservations.map((reservation) =>
            store.acquireEgressLease({
              leaseId: randomUUID(),
              reservationId: reservation.reservation.reservationId,
              channelId: CHANNEL,
              nowMs: 2_000,
              expiresAtMs: 2_000 + TTL_MS,
            }),
          ),
        );
        const acquired = results.filter((result) => result.outcome === 'acquired');
        const declined = results.filter((result) => result.outcome === 'declined');
        expect(acquired).toHaveLength(1);
        expect(declined).toHaveLength(companions.length - 1);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'reclaims an expired lease and fences the crashed holder out of a double-send',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSpeakingArbiterStore.connect(databaseUrl);
      try {
        const reservationA = await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-crash',
          companionId: COMPANION_A,
          nowMs: 1_000,
          expiresAtMs: 1_000 + TTL_MS,
        });
        const reservationB = await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-crash',
          companionId: COMPANION_B,
          nowMs: 1_000,
          expiresAtMs: 1_000 + TTL_MS,
        });

        // A acquires with a short deadline, then "crashes" (never completes).
        const leaseAId = randomUUID();
        const acquireA = await store.acquireEgressLease({
          leaseId: leaseAId,
          reservationId: reservationA.reservation.reservationId,
          channelId: CHANNEL,
          nowMs: 2_000,
          expiresAtMs: 2_000 + 5_000,
        });
        expect(acquireA.outcome).toBe('acquired');
        expect(acquireA.lease?.fencingToken).toBe(1);

        // After A's deadline, B reclaims the room: lease granted with a HIGHER token.
        const acquireB = await store.acquireEgressLease({
          leaseId: randomUUID(),
          reservationId: reservationB.reservation.reservationId,
          channelId: CHANNEL,
          nowMs: 2_000 + 5_000,
          expiresAtMs: 2_000 + 5_000 + TTL_MS,
        });
        expect(acquireB.outcome).toBe('acquired');
        expect(acquireB.lease?.fencingToken).toBe(2);

        // The revived crashed holder A cannot double-send: its lease is expired.
        await expect(
          store.completeEgressLease({
            leaseId: leaseAId,
            channelId: CHANNEL,
            fencingToken: 1,
            completion: 'delivered',
            nowMs: 2_000 + 6_000,
          }),
        ).rejects.toThrow(/already terminal/);

        // A stale fencing token is rejected outright at the current holder's row.
        await expect(
          store.completeEgressLease({
            leaseId: acquireB.lease?.leaseId ?? '',
            channelId: CHANNEL,
            fencingToken: 1,
            completion: 'delivered',
            nowMs: 2_000 + 6_100,
          }),
        ).rejects.toThrow(/stale fencing token/);

        // The legitimate current holder B delivers successfully.
        const completedB = await store.completeEgressLease({
          leaseId: acquireB.lease?.leaseId ?? '',
          channelId: CHANNEL,
          fencingToken: 2,
          completion: 'delivered',
          nowMs: 2_000 + 6_200,
          pressureDelta: 3,
        });
        expect(completedB.status).toBe('delivered');

        const episode = await store.readRoomEpisode({ channelId: CHANNEL });
        expect(episode?.pressure).toBe(3);
        expect(episode?.lastSpeakerCompanionId).toBe(COMPANION_B);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'charges episode pressure and fairness only on a speech completion',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSpeakingArbiterStore.connect(databaseUrl);
      try {
        // Delivered: pressure + speak count + streak advance.
        const reservationA = await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-a',
          companionId: COMPANION_A,
          nowMs: 1_000,
          expiresAtMs: 1_000 + TTL_MS,
        });
        const leaseA = await store.acquireEgressLease({
          leaseId: randomUUID(),
          reservationId: reservationA.reservation.reservationId,
          channelId: CHANNEL,
          nowMs: 1_100,
          expiresAtMs: 1_100 + TTL_MS,
        });
        await store.completeEgressLease({
          leaseId: leaseA.lease?.leaseId ?? '',
          channelId: CHANNEL,
          fencingToken: leaseA.lease?.fencingToken ?? 0,
          completion: 'delivered',
          nowMs: 1_200,
          pressureDelta: 2,
        });

        let episode = await store.readRoomEpisode({ channelId: CHANNEL });
        expect(episode?.pressure).toBe(2);
        expect(episode?.consecutiveAutonomousTurns).toBe(1);
        const participantA = episode?.participants.find((p) => p.companionId === COMPANION_A);
        expect(participantA?.speakCount).toBe(1);

        // Delivery failure: no pressure, no speak count, no streak advance.
        const reservationB = await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-b',
          companionId: COMPANION_B,
          nowMs: 1_300,
          expiresAtMs: 1_300 + TTL_MS,
        });
        const leaseB = await store.acquireEgressLease({
          leaseId: randomUUID(),
          reservationId: reservationB.reservation.reservationId,
          channelId: CHANNEL,
          nowMs: 1_400,
          expiresAtMs: 1_400 + TTL_MS,
        });
        await store.completeEgressLease({
          leaseId: leaseB.lease?.leaseId ?? '',
          channelId: CHANNEL,
          fencingToken: leaseB.lease?.fencingToken ?? 0,
          completion: 'failed',
          nowMs: 1_500,
          pressureDelta: 99,
        });

        episode = await store.readRoomEpisode({ channelId: CHANNEL });
        expect(episode?.pressure).toBe(2);
        expect(episode?.consecutiveAutonomousTurns).toBe(1);
        const participantB = episode?.participants.find((p) => p.companionId === COMPANION_B);
        expect(participantB?.speakCount).toBe(0);

        // Human activity resets the autonomous-turn streak.
        const afterHuman = await store.recordHumanActivity({ channelId: CHANNEL, nowMs: 1_600 });
        expect(afterHuman.consecutiveAutonomousTurns).toBe(0);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'closes an episode and opens a fresh one with reset pressure',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSpeakingArbiterStore.connect(databaseUrl);
      try {
        const reservation = await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-close',
          companionId: COMPANION_A,
          nowMs: 1_000,
          expiresAtMs: 1_000 + TTL_MS,
        });
        const lease = await store.acquireEgressLease({
          leaseId: randomUUID(),
          reservationId: reservation.reservation.reservationId,
          channelId: CHANNEL,
          nowMs: 1_100,
          expiresAtMs: 1_100 + TTL_MS,
        });
        await store.completeEgressLease({
          leaseId: lease.lease?.leaseId ?? '',
          channelId: CHANNEL,
          fencingToken: lease.lease?.fencingToken ?? 0,
          completion: 'delivered',
          nowMs: 1_200,
          pressureDelta: 5,
        });
        const firstEpisodeId = reservation.episode.episodeId;

        const closed = await store.closeRoomEpisode({ channelId: CHANNEL, nowMs: 2_000 });
        expect(closed?.status).toBe('closed');
        expect(closed?.episodeId).toBe(firstEpisodeId);

        const reopened = await store.ensureRoomEpisode({ channelId: CHANNEL, nowMs: 3_000 });
        expect(reopened.episodeId).not.toBe(firstEpisodeId);
        expect(reopened.status).toBe('open');
        expect(reopened.pressure).toBe(0);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'sweeps lapsed reservations and held leases',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSpeakingArbiterStore.connect(databaseUrl);
      try {
        // A reservation that never promotes: it lapses and is swept.
        await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-stale',
          companionId: COMPANION_A,
          nowMs: 1_000,
          expiresAtMs: 1_000 + 5_000,
        });
        // A promoted lease whose holder crashes: the held lease lapses and is swept.
        const reservationB = await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-held',
          companionId: COMPANION_B,
          nowMs: 1_000,
          expiresAtMs: 1_000 + 5_000,
        });
        await store.acquireEgressLease({
          leaseId: randomUUID(),
          reservationId: reservationB.reservation.reservationId,
          channelId: CHANNEL,
          nowMs: 1_100,
          expiresAtMs: 1_100 + 5_000,
        });

        const swept = await store.sweepExpired({ channelId: CHANNEL, nowMs: 100_000 });
        expect(swept.expiredLeases).toBe(1);
        // evt-held's reservation is now sweepable too (no held lease remains).
        expect(swept.expiredReservations).toBeGreaterThanOrEqual(1);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'survives a store restart with reservations, leases, and pressure intact',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      let firstEpisodeId: string;
      let reservationAId: string;
      let reservationBId: string;

      const first = await PostgresSpeakingArbiterStore.connect(databaseUrl);
      try {
        const reservationA = await store_reserve(first, 'evt-restart', COMPANION_A, 1_000);
        const reservationB = await store_reserve(first, 'evt-restart', COMPANION_B, 1_000);
        reservationAId = reservationA.reservation.reservationId;
        reservationBId = reservationB.reservation.reservationId;
        firstEpisodeId = reservationA.episode.episodeId;

        const lease = await first.acquireEgressLease({
          leaseId: randomUUID(),
          reservationId: reservationAId,
          channelId: CHANNEL,
          nowMs: 1_100,
          expiresAtMs: 1_100 + TTL_MS,
        });
        await first.completeEgressLease({
          leaseId: lease.lease?.leaseId ?? '',
          channelId: CHANNEL,
          fencingToken: lease.lease?.fencingToken ?? 0,
          completion: 'delivered',
          nowMs: 1_200,
          pressureDelta: 7,
        });
      } finally {
        await first.close();
      }

      // Restart: a fresh store instance against the same database.
      const restarted = await PostgresSpeakingArbiterStore.connect(databaseUrl);
      try {
        const episode = await restarted.readRoomEpisode({ channelId: CHANNEL });
        expect(episode?.episodeId).toBe(firstEpisodeId);
        expect(episode?.pressure).toBe(7);
        expect(episode?.consecutiveAutonomousTurns).toBe(1);
        expect(episode?.lastSpeakerCompanionId).toBe(COMPANION_A);
        const participantA = episode?.participants.find((p) => p.companionId === COMPANION_A);
        expect(participantA?.speakCount).toBe(1);

        // A's reservation replays as terminal (delivered); B's is still reservable.
        const replayA = await restarted.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-restart',
          companionId: COMPANION_A,
          nowMs: 2_000,
          expiresAtMs: 2_000 + TTL_MS,
        });
        expect(replayA.outcome).toBe('replayed');
        expect(replayA.reservation.reservationId).toBe(reservationAId);
        expect(replayA.reservation.status).toBe('released');
        expect(replayA.reservation.reason).toBe('delivered');

        const replayB = await restarted.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-restart',
          companionId: COMPANION_B,
          nowMs: 2_000,
          expiresAtMs: 2_000 + TTL_MS,
        });
        expect(replayB.outcome).toBe('replayed');
        expect(replayB.reservation.reservationId).toBe(reservationBId);
        expect(replayB.reservation.status).toBe('reserved');
      } finally {
        await restarted.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );
});

async function store_reserve(
  store: PostgresSpeakingArbiterStore,
  triggerEventId: string,
  companionId: string,
  nowMs: number,
): ReturnType<PostgresSpeakingArbiterStore['reserve']> {
  return store.reserve({
    reservationId: randomUUID(),
    channelId: CHANNEL,
    triggerEventId,
    companionId,
    nowMs,
    expiresAtMs: nowMs + TTL_MS,
  });
}
