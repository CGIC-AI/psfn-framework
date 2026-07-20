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
import { SHARED_SCHEMA_NAME } from './migrations.js';
import { createPostgresPool } from '../postgres.js';
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

        // A's reservation replays as terminal (delivered). B's co-reservation was
        // retired as `superseded` when A's send completed — send-once fencing
        // means the event is spent, so B is NOT left reservable after a restart.
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
        expect(replayB.reservation.status).toBe('released');
        expect(replayB.reservation.reason).toBe('superseded');

        // Re-driving the same event across the restart cannot produce a second
        // send: even a fresh reservation + acquire for a peer is declined.
        const bReReserve = await restarted.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-restart',
          companionId: COMPANION_C,
          nowMs: 2_100,
          expiresAtMs: 2_100 + TTL_MS,
        });
        const bReAcquire = await restarted.acquireEgressLease({
          leaseId: randomUUID(),
          reservationId: bReReserve.reservation.reservationId,
          channelId: CHANNEL,
          nowMs: 2_200,
          expiresAtMs: 2_200 + TTL_MS,
        });
        expect(bReAcquire.outcome).toBe('declined');
        expect(bReAcquire.declineReason).toBe('already_delivered');
        expect(bReAcquire.lease).toBeNull();
        expect(bReAcquire.heldBy?.companionId).toBe(COMPANION_A);

        // Ground truth: exactly one speech-terminal lease exists for the event.
        expect(await countSpeechTerminalLeases(databaseUrl, 'evt-restart')).toBe(1);
      } finally {
        await restarted.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'declines a co-reserver acquiring after the winning lease is delivered (send-once)',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSpeakingArbiterStore.connect(databaseUrl);
      try {
        const reservationA = await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-once',
          companionId: COMPANION_A,
          nowMs: 1_000,
          expiresAtMs: 1_000 + TTL_MS,
        });
        const reservationB = await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-once',
          companionId: COMPANION_B,
          nowMs: 1_000,
          expiresAtMs: 1_000 + TTL_MS,
        });

        // A wins the event and delivers, then releases its held lease.
        const acquireA = await store.acquireEgressLease({
          leaseId: randomUUID(),
          reservationId: reservationA.reservation.reservationId,
          channelId: CHANNEL,
          nowMs: 1_100,
          expiresAtMs: 1_100 + TTL_MS,
        });
        expect(acquireA.outcome).toBe('acquired');
        await store.completeEgressLease({
          leaseId: acquireA.lease?.leaseId ?? '',
          channelId: CHANNEL,
          fencingToken: acquireA.lease?.fencingToken ?? 0,
          completion: 'delivered',
          nowMs: 1_200,
          pressureDelta: 1,
        });

        // With A's held lease gone, B tries to acquire for the SAME event: the
        // send-once fence declines it (`already_delivered`), no second lease.
        const acquireB = await store.acquireEgressLease({
          leaseId: randomUUID(),
          reservationId: reservationB.reservation.reservationId,
          channelId: CHANNEL,
          nowMs: 1_300,
          expiresAtMs: 1_300 + TTL_MS,
        });
        expect(acquireB.outcome).toBe('declined');
        expect(acquireB.declineReason).toBe('already_delivered');
        expect(acquireB.lease).toBeNull();
        expect(acquireB.heldBy?.companionId).toBe(COMPANION_A);

        // B's co-reservation was retired as superseded when A delivered.
        const replayB = await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-once',
          companionId: COMPANION_B,
          nowMs: 1_400,
          expiresAtMs: 1_400 + TTL_MS,
        });
        expect(replayB.outcome).toBe('replayed');
        expect(replayB.reservation.reservationId).toBe(reservationB.reservation.reservationId);
        expect(replayB.reservation.status).toBe('released');
        expect(replayB.reservation.reason).toBe('superseded');

        // SQL ground truth: exactly one delivered lease for this trigger event.
        expect(await countSpeechTerminalLeases(databaseUrl, 'evt-once')).toBe(1);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'still reclaims an event whose holder crashed without ever delivering',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSpeakingArbiterStore.connect(databaseUrl);
      try {
        const reservationA = await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-reclaim',
          companionId: COMPANION_A,
          nowMs: 1_000,
          expiresAtMs: 1_000 + TTL_MS,
        });
        const reservationB = await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-reclaim',
          companionId: COMPANION_B,
          nowMs: 1_000,
          expiresAtMs: 1_000 + TTL_MS,
        });

        // A acquires with a short deadline and crashes — it NEVER delivers.
        const acquireA = await store.acquireEgressLease({
          leaseId: randomUUID(),
          reservationId: reservationA.reservation.reservationId,
          channelId: CHANNEL,
          nowMs: 2_000,
          expiresAtMs: 2_000 + 5_000,
        });
        expect(acquireA.outcome).toBe('acquired');

        // After A's deadline B reclaims — an expired-never-delivered lease is NOT
        // a send, so send-once fencing must not block the reclaim.
        const acquireB = await store.acquireEgressLease({
          leaseId: randomUUID(),
          reservationId: reservationB.reservation.reservationId,
          channelId: CHANNEL,
          nowMs: 2_000 + 5_000,
          expiresAtMs: 2_000 + 5_000 + TTL_MS,
        });
        expect(acquireB.outcome).toBe('acquired');
        expect(acquireB.lease?.fencingToken).toBe(2);

        await store.completeEgressLease({
          leaseId: acquireB.lease?.leaseId ?? '',
          channelId: CHANNEL,
          fencingToken: acquireB.lease?.fencingToken ?? 0,
          completion: 'delivered',
          nowMs: 2_000 + 6_000,
          pressureDelta: 1,
        });

        // Exactly one send happened across the crash + reclaim.
        expect(await countSpeechTerminalLeases(databaseUrl, 'evt-reclaim')).toBe(1);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'binds the funding charge to the granted lease and it survives a restart (charge fencing)',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const leaseId = randomUUID();
      const first = await PostgresSpeakingArbiterStore.connect(databaseUrl);
      try {
        const reservation = await store_reserve(first, 'evt-charge', COMPANION_A, 1_000);
        const acquired = await first.acquireEgressLease({
          leaseId,
          reservationId: reservation.reservation.reservationId,
          channelId: CHANNEL,
          nowMs: 1_100,
          expiresAtMs: 1_100 + TTL_MS,
          chargedUnits: 4,
        });
        expect(acquired.outcome).toBe('acquired');
        // The drawn units are on the lease snapshot the caller gets back.
        expect(acquired.lease?.chargedUnits).toBe(4);

        // Idempotent replay must NOT re-apply a draw: the first grant's charge is
        // authoritative even if a retry passes a different amount.
        const replay = await first.acquireEgressLease({
          leaseId,
          reservationId: reservation.reservation.reservationId,
          channelId: CHANNEL,
          nowMs: 1_150,
          expiresAtMs: 1_150 + TTL_MS,
          chargedUnits: 999,
        });
        expect(replay.outcome).toBe('acquired');
        expect(replay.lease?.chargedUnits).toBe(4);
      } finally {
        await first.close();
      }

      // Restart: the charge is still bound to the held lease, so a reboot-time
      // reconciler can see exactly what this turn drew (no phantom, no leak).
      const restarted = await PostgresSpeakingArbiterStore.connect(databaseUrl);
      try {
        const row = await readLeaseChargeRow(databaseUrl, leaseId);
        expect(row).not.toBeNull();
        expect(row?.status).toBe('held');
        expect(row?.chargedUnits).toBe(4);
      } finally {
        await restarted.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'keeps the charge on a crashed never-delivered lease reconcilable after reclaim (exactly-once, no phantom)',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSpeakingArbiterStore.connect(databaseUrl);
      try {
        const reservationA = await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-charge-crash',
          companionId: COMPANION_A,
          nowMs: 1_000,
          expiresAtMs: 1_000 + TTL_MS,
        });
        const reservationB = await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-charge-crash',
          companionId: COMPANION_B,
          nowMs: 1_000,
          expiresAtMs: 1_000 + TTL_MS,
        });

        // A draws 4 units, acquires with a short deadline, then crashes before
        // delivery — its charge is now bound to the lease it never completed.
        const leaseAId = randomUUID();
        const acquireA = await store.acquireEgressLease({
          leaseId: leaseAId,
          reservationId: reservationA.reservation.reservationId,
          channelId: CHANNEL,
          nowMs: 2_000,
          expiresAtMs: 2_000 + 5_000,
          chargedUnits: 4,
        });
        expect(acquireA.outcome).toBe('acquired');

        // After A's deadline, B draws 6 and reclaims the never-delivered event.
        const acquireB = await store.acquireEgressLease({
          leaseId: randomUUID(),
          reservationId: reservationB.reservation.reservationId,
          channelId: CHANNEL,
          nowMs: 2_000 + 5_000,
          expiresAtMs: 2_000 + 5_000 + TTL_MS,
          chargedUnits: 6,
        });
        expect(acquireB.outcome).toBe('acquired');
        expect(acquireB.lease?.fencingToken).toBe(2);
        await store.completeEgressLease({
          leaseId: acquireB.lease?.leaseId ?? '',
          channelId: CHANNEL,
          fencingToken: acquireB.lease?.fencingToken ?? 0,
          completion: 'delivered',
          nowMs: 2_000 + 6_000,
          pressureDelta: 1,
        });

        // Exactly one send across the crash + reclaim.
        expect(await countSpeechTerminalLeases(databaseUrl, 'evt-charge-crash')).toBe(1);

        // A's crashed lease is `expired` but still carries its 4 units — the
        // refundable amount a reconciler credits back (charge did not reach the
        // room). B's delivered lease keeps its 6 units — a permanent, real charge.
        const aRow = await readLeaseChargeRow(databaseUrl, leaseAId);
        expect(aRow?.status).toBe('expired');
        expect(aRow?.chargedUnits).toBe(4);
        const bRow = await readLeaseChargeRow(databaseUrl, acquireB.lease?.leaseId ?? '');
        expect(bRow?.status).toBe('delivered');
        expect(bRow?.chargedUnits).toBe(6);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'a kill between charge and acquire leaves no lease: clean release, no orphan (residual pot micro-leak is the sender lane)',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresSpeakingArbiterStore.connect(databaseUrl);
      try {
        // The phase draws the pot (step 5) and would then acquire the lease
        // (step 6). We reserve but NEVER acquire — the exact "kill between charge
        // and send" shape: the process died after the draw, before the lease
        // existed. There is therefore no lease row to reclaim.
        await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-charge-preacquire',
          companionId: COMPANION_A,
          nowMs: 1_000,
          expiresAtMs: 1_000 + 5_000,
        });

        // On restart the watchdog sweeps: the reservation lapses to a clean
        // release and NO orphaned lease exists for the event.
        const swept = await store.sweepExpired({ channelId: CHANNEL, nowMs: 100_000 });
        expect(swept.expiredReservations).toBeGreaterThanOrEqual(1);
        expect(await countLeases(databaseUrl, 'evt-charge-preacquire')).toBe(0);
        expect(await countSpeechTerminalLeases(databaseUrl, 'evt-charge-preacquire')).toBe(0);
        // NB: the pot units drawn at step 5 are NOT recoverable from the arbiter
        // here — there is no lease to carry them. That irreducible two-store
        // micro-window is the bounded, machine-lane refund-or-tolerate decision
        // owned by the egress-sender hardening lane (qgqw.3), not the store fence.
      } finally {
        await store.close();
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

/**
 * Count speech-terminal (delivered/overridden) leases for one trigger event, at
 * the SQL level — the ground-truth "exactly one send per trigger" invariant that
 * no store method can paper over. Opens its own short-lived pool so it observes
 * committed rows independently of the store under test.
 */
async function countSpeechTerminalLeases(
  databaseUrl: string,
  triggerEventId: string,
): Promise<number> {
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'speaking-arbiter-test-probe',
    allowExitOnIdle: true,
    schema: SHARED_SCHEMA_NAME,
  });
  try {
    const result = await pool.query<{ n: string | number }>(
      `SELECT COUNT(*)::int AS n
       FROM speaking_egress_leases
       WHERE channel_id = $1 AND trigger_event_id = $2
         AND status IN ('delivered', 'overridden')`,
      [CHANNEL, triggerEventId],
    );
    return Number(result.rows.at(0)?.n ?? 0);
  } finally {
    await pool.end();
  }
}

/**
 * Read the durable `status` and `charged_units` of a single lease straight from
 * the table (independent pool, committed rows), so a crash-recovery test can
 * prove the fatigue charge stays bound to the fenced lease across reclaim and
 * restart — the ground truth no store method paraphrases (jp36.5.3).
 */
async function readLeaseChargeRow(
  databaseUrl: string,
  leaseId: string,
): Promise<{ status: string; chargedUnits: number } | null> {
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'speaking-arbiter-test-probe',
    allowExitOnIdle: true,
    schema: SHARED_SCHEMA_NAME,
  });
  try {
    const result = await pool.query<{ status: string; charged_units: string | number }>(
      `SELECT status, charged_units
       FROM speaking_egress_leases
       WHERE lease_id = $1`,
      [leaseId],
    );
    const row = result.rows.at(0);
    return row ? { status: row.status, chargedUnits: Number(row.charged_units) } : null;
  } finally {
    await pool.end();
  }
}

/** Count all leases (any status) for a trigger event — orphan-lease detection. */
async function countLeases(databaseUrl: string, triggerEventId: string): Promise<number> {
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'speaking-arbiter-test-probe',
    allowExitOnIdle: true,
    schema: SHARED_SCHEMA_NAME,
  });
  try {
    const result = await pool.query<{ n: string | number }>(
      `SELECT COUNT(*)::int AS n
       FROM speaking_egress_leases
       WHERE channel_id = $1 AND trigger_event_id = $2`,
      [CHANNEL, triggerEventId],
    );
    return Number(result.rows.at(0)?.n ?? 0);
  } finally {
    await pool.end();
  }
}
