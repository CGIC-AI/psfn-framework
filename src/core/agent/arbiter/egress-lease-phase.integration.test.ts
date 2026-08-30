// Live-database integration for the speaking-arbiter egress-lease phase
// (jp36.5.1.3). Exercises the FULL two-phase lifecycle over the REAL Postgres
// arbiter store (a throwaway dockerized postgres, fresh database per test):
// reserve → (appraise) → egress lease grant → deliver → complete, plus the
// durable single-probe breaker discipline, send-once fencing across the phase,
// the react non-lease release path, and the new store surface this bead added
// (breaker read/persist, listActiveReservers). The social pot, room pressure,
// and reply sender are stubbed here; their own integration lives with them.

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SpeakingEgressLeasePhase,
  type EgressLeasePhaseConfig,
  type EgressReplySender,
  type EgressReplyTrigger,
  type RoomEpisodePressureAssessmentResolver,
} from './egress-lease-phase.js';
import type { SpeakingReservationSnapshot } from './speaking-arbiter-store-port.js';
import type { RoomEpisodePressureAssessment } from '../fatigue/room-episode-pressure.js';
import type { ParticipationAppraisal } from '../../participation/types.js';
import { PostgresSpeakingArbiterStore } from '../../../persistence/postgres/speaking-arbiter-store.js';
import { bootstrapSharedSchema } from '../../../persistence/postgres/shared-schema.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';

const TEST_IMAGE = 'postgres:16-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;

const COMPANION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHANNEL = 'discord:guild-1:room-general';
const TTL_MS = 60_000;

const REPLY: Extract<ParticipationAppraisal, { action: 'reply' }> = {
  action: 'reply',
  reasonCode: 'addressed',
  confidence: 0.9,
};

function trigger(): EgressReplyTrigger {
  return {
    kind: 'inbound_room_message',
    channelId: CHANNEL,
    channelType: 'discord',
    sourceEventId: 'evt',
    authorId: 'human-1',
    authorName: 'Sam',
    content: 'hey there',
    occurredAtMs: 1_000,
  };
}

function makeConfig(): EgressLeasePhaseConfig {
  return {
    mode: 'on',
    leaseTtlMs: TTL_MS,
    egressDrawUnits: 1,
    minReplyConfidence: 0.1,
    socialPot: {
      capUnits: 240,
      perChannelDrawFraction: 0.34,
      regenerationTickMs: 3_600_000,
      regenerationUnitsPerTick: 10,
    },
    roomEpisodeCircuitBreaker: { tripThreshold: 100, resetThreshold: 40 },
    wrapUpThreshold: 60,
    replyPressureUnits: 3,
  };
}

function calmPressure(pressure = 0, leaseThresholdBias = 0): RoomEpisodePressureAssessmentResolver {
  const assessment: RoomEpisodePressureAssessment = {
    channelId: CHANNEL,
    pressure,
    contributingEventCount: 0,
    windowStartMs: 0,
    evaluatedAtMs: 0,
    level: 'calm',
    wrapUpInvited: false,
    leaseThresholdBias,
  };
  return { resolve: () => assessment };
}

const drawnPot = {
  draw: async () => ({
    outcome: 'drawn' as const,
    drawn: 1,
    before: { companionId: COMPANION_A, balance: 10, cap: 240, lastRegenAtMs: 0, revision: 1 },
    after: { companionId: COMPANION_A, balance: 9, cap: 240, lastRegenAtMs: 0, revision: 2 },
  }),
  refund: async () => (
    { companionId: COMPANION_A, balance: 10, cap: 240, lastRegenAtMs: 0, revision: 3 }
  ),
};

function deliveringSender(): EgressReplySender {
  return { deliver: async () => ({ outcome: 'delivered' }) };
}

function makePhase(
  store: PostgresSpeakingArbiterStore,
  companionId: string,
  pressure: RoomEpisodePressureAssessmentResolver = calmPressure(),
  sender: EgressReplySender = deliveringSender(),
): SpeakingEgressLeasePhase {
  return new SpeakingEgressLeasePhase({
    store,
    socialPot: drawnPot,
    roomPressure: pressure,
    sender,
    companionId,
    config: makeConfig(),
    generateLeaseId: randomUUID,
  });
}

async function reserve(
  store: PostgresSpeakingArbiterStore,
  triggerEventId: string,
  companionId: string,
  nowMs: number,
): Promise<SpeakingReservationSnapshot> {
  const result = await store.reserve({
    reservationId: randomUUID(),
    channelId: CHANNEL,
    triggerEventId,
    companionId,
    nowMs,
    expiresAtMs: nowMs + TTL_MS,
  });
  return result.reservation;
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

describe('speaking egress-lease phase integration', () => {
  it(
    'runs the full lifecycle reserve→lease→deliver→complete and respects send-once',
    async () => {
      const store = await connectStore();
      try {
        const reservationA = await reserve(store, 'evt-1', COMPANION_A, 1_000);
        const reservationB = await reserve(store, 'evt-1', COMPANION_B, 1_000);

        // A wins the trigger and delivers.
        const decisionA = await makePhase(store, COMPANION_A).grantReply(
          reservationA,
          REPLY,
          { ...trigger(), sourceEventId: 'evt-1' },
          2_000,
        );
        expect(decisionA.outcome).toBe('delivered');

        // Episode pressure + fairness updated by the delivered speech completion.
        const episode = await store.readRoomEpisode({ channelId: CHANNEL });
        expect(episode?.pressure).toBe(3);
        expect(episode?.lastSpeakerCompanionId).toBe(COMPANION_A);
        expect(episode?.participants.find((p) => p.companionId === COMPANION_A)?.speakCount).toBe(1);

        // B, holding a co-reservation snapshot, cannot bind a second send: the
        // store's send-once fence declines it (`already_delivered`), no retry.
        const decisionB = await makePhase(store, COMPANION_B).grantReply(
          reservationB,
          REPLY,
          { ...trigger(), sourceEventId: 'evt-1' },
          3_000,
        );
        expect(decisionB.outcome).toBe('lease_declined');
        expect(decisionB.declineReason).toBe('already_delivered');
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'enforces the durable single-probe half-open breaker discipline',
    async () => {
      const store = await connectStore();
      try {
        // Open an episode (reserve does), then durably set the breaker half_open —
        // a probe already spent. A grant with pressure in the hysteresis band must
        // suppress (probeAllowed alone is insufficient; priorState is not open).
        const reservation1 = await reserve(store, 'evt-ho', COMPANION_A, 1_000);
        await store.persistRoomEpisodeBreakerState({ channelId: CHANNEL, state: 'half_open', nowMs: 1_100 });

        const suppressed = await makePhase(store, COMPANION_A, calmPressure(50)).grantReply(
          reservation1,
          REPLY,
          { ...trigger(), sourceEventId: 'evt-ho' },
          1_200,
        );
        expect(suppressed.outcome).toBe('breaker_suppressed');
        expect(suppressed.breakerState).toBe('half_open');
        expect(await store.readRoomEpisodeBreakerState({ channelId: CHANNEL })).toBe('half_open');

        // Now durably set OPEN, then decay pressure to/below reset: the FRESH
        // open→half_open transition admits exactly one probe (it delivers).
        await store.persistRoomEpisodeBreakerState({ channelId: CHANNEL, state: 'open', nowMs: 1_300 });
        const reservation2 = await reserve(store, 'evt-probe', COMPANION_A, 1_400);
        const admitted = await makePhase(store, COMPANION_A, calmPressure(30)).grantReply(
          reservation2,
          REPLY,
          { ...trigger(), sourceEventId: 'evt-probe' },
          1_500,
        );
        expect(admitted.outcome).toBe('delivered');
        expect(await store.readRoomEpisodeBreakerState({ channelId: CHANNEL })).toBe('half_open');
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'gives a retained react reservation its explicit non-lease release',
    async () => {
      const store = await connectStore();
      try {
        const reservation = await reserve(store, 'evt-react', COMPANION_A, 1_000);
        const decision = await makePhase(store, COMPANION_A).releaseReact(reservation, 1_100);
        expect(decision.outcome).toBe('react_released');

        // Durably released as silence — no lease was ever acquired for the event.
        const replay = await store.reserve({
          reservationId: randomUUID(),
          channelId: CHANNEL,
          triggerEventId: 'evt-react',
          companionId: COMPANION_A,
          nowMs: 1_200,
          expiresAtMs: 1_200 + TTL_MS,
        });
        expect(replay.outcome).toBe('replayed');
        expect(replay.reservation.status).toBe('released');
        expect(replay.reservation.reason).toBe('silence');
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'lists the currently-reserved contenders for an event (fairness contender set)',
    async () => {
      const store = await connectStore();
      try {
        await reserve(store, 'evt-fair', COMPANION_A, 1_000);
        const reservationB = await reserve(store, 'evt-fair', COMPANION_B, 1_000);

        expect(
          await store.listActiveReservers({ channelId: CHANNEL, triggerEventId: 'evt-fair', nowMs: 2_000 }),
        ).toEqual([COMPANION_A, COMPANION_B]);

        // Releasing B drops it from the contender set.
        await store.releaseReservation({
          reservationId: reservationB.reservationId,
          channelId: CHANNEL,
          reason: 'silence',
          nowMs: 2_100,
        });
        expect(
          await store.listActiveReservers({ channelId: CHANNEL, triggerEventId: 'evt-fair', nowMs: 2_200 }),
        ).toEqual([COMPANION_A]);

        // An expired reservation is excluded (query time past its TTL).
        expect(
          await store.listActiveReservers({
            channelId: CHANNEL,
            triggerEventId: 'evt-fair',
            nowMs: 1_000 + TTL_MS + 1,
          }),
        ).toEqual([]);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'defaults the durable breaker state to closed and round-trips a persisted state',
    async () => {
      const store = await connectStore();
      try {
        // No episode open yet: a room with no live episode is not suppressed.
        expect(await store.readRoomEpisodeBreakerState({ channelId: CHANNEL })).toBe('closed');

        await reserve(store, 'evt-bs', COMPANION_A, 1_000);
        expect(await store.readRoomEpisodeBreakerState({ channelId: CHANNEL })).toBe('closed');

        await store.persistRoomEpisodeBreakerState({ channelId: CHANNEL, state: 'open', nowMs: 1_100 });
        expect(await store.readRoomEpisodeBreakerState({ channelId: CHANNEL })).toBe('open');
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
