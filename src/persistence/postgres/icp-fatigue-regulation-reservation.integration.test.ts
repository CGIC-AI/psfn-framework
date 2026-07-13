import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from "../../test-support/postgres-test-harness.js";
import type { FatigueEnforcementMetadata } from "../../shared/contracts/runtime.js";
import { PostgresIcpSharedAutonomyStore } from "./icp-shared-autonomy-store.js";
import { PostgresIcpFatigueRegulationReservationStore } from "./icp-fatigue-regulation-reservation-store.js";
import { createPostgresPool, withPostgresClient } from "../postgres.js";
import { POSTGRES_SHARED_MIGRATIONS } from "./migrations.js";

const TIMEOUT_MS = 120_000;
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROOT = "33333333-3333-4333-8333-333333333333";
const DM_CONVERSATION = "22222222-2222-4222-8222-222222222222";
const ROOM_CONVERSATION = "44444444-4444-4444-8444-444444444444";
const DM = `companion-dm:${A}:${B}`;
const ROOM = "companion-room:studio";
const HALF_LIFE_MS = 6 * 60 * 60_000;
const WINDOW_MS = 48 * 60 * 60_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({
    image: DEFAULT_POSTGRES_TEST_IMAGE,
  });
}, TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, TIMEOUT_MS);

function correlation(input: {
  conversationId: string;
  rootInitiationId?: string;
  channelId: string;
  turnId: string;
  localCompanionId?: string;
  peerCompanionId?: string;
}) {
  const localCompanionId = input.localCompanionId ?? A;
  const peerCompanionId = input.peerCompanionId ?? B;
  return {
    conversationId: input.conversationId,
    rootInitiationId: input.rootInitiationId ?? ROOT,
    initiatedByCompanionId: A,
    localCompanionId,
    peerCompanionId,
    peerContactId: `contact-${peerCompanionId}`,
    channelId: input.channelId,
    turnId: input.turnId,
    messageId: `message-${input.turnId}`,
    requestId: `request-${input.turnId}`,
    chargeLane: "companion_social" as const,
    surface:
      input.channelId === DM
        ? ("companion_dm" as const)
        : ("companion_room" as const),
    costPurpose: "conversation_turn" as const,
    costOriginStage: "reply" as const,
    fatigueDecision: "allow" as const,
  };
}

function reservationInput(
  value: ReturnType<typeof correlation>,
  timestampMs = 10_000,
) {
  return {
    correlation: value,
    timestampMs,
    decision: "charged" as const,
    amount: 1,
    hardLimit: 1,
    overchargeLimit: 2,
    relationshipPressureHalfLifeMs: HALF_LIFE_MS,
    relationshipPressureWindowMs: WINDOW_MS,
    unansweredInitiationAfterMs: 15 * 60_000,
    declinedPressureUnits: 3,
    deferredPressureUnits: 2,
    unansweredPressureUnits: 1,
  };
}

function finalizationFatigue(
  value: ReturnType<typeof correlation>,
): FatigueEnforcementMetadata {
  return {
    schemaVersion: 1,
    decision: "allowed_charged",
    modelDisposition: "allowed",
    alertInjected: false,
    shouldRecordSpend: true,
    spendDecision: "charged",
    spendReason: "machine_intelligence_response",
    policyState: "normal",
    policyBaseState: "normal",
    intent: "casual",
    relationshipClass: "trusted_collaborator_mi",
    channelSetting:
      value.surface === "companion_dm" ? "dm" : "quiet_companion_room",
    overchargeEligible: false,
    overchargePermitted: false,
    overchargeBlockedReasons: [
      "normal_allowance_not_exhausted",
      "no_qualifying_overcharge_trigger",
    ],
    overchargeReasons: [],
    scope: {
      localCompanionId: value.localCompanionId,
      peerContactId: value.peerContactId,
      channelId: value.channelId,
      dayKey: "1970-01-01",
    },
    peer: {
      contactId: value.peerContactId,
      channelAuthorId: value.peerCompanionId,
      displayName: "Peer",
      isMachineIntelligence: true,
    },
    triggeringAuthor: {
      role: "machine_intelligence",
      contactId: value.peerContactId,
      channelAuthorId: value.peerCompanionId,
      displayName: "Peer",
      isMachineIntelligence: true,
    },
    budget: {
      spentBefore: 0,
      remainingBefore: 1,
      allowance: 1,
      softLimit: 1,
      hardLimit: 1,
      amount: 1,
      spentAfterProjected: 1,
      remainingAfterProjected: 0,
      normalSpentBefore: 0,
      normalSpentAfterProjected: 1,
      overchargeSpentBefore: 0,
      overchargeSpentAfterProjected: 0,
      overchargeAllowance: 2,
      overchargeRemainingBefore: 2,
      overchargeRemainingAfterProjected: 2,
    },
    socialRegulation: {
      state: "normal",
      chargeLane: "interactive",
      relationshipPressure: 0,
      rootNormalSpent: 0,
      rootOverchargeSpent: 0,
      contributingEventCount: 0,
      marginalChargeUnits: 0,
      closeoutReserveRemainingBefore: 2,
      closeoutReserveRemainingAfterProjected: 2,
      continuationEvidence: [],
      rootInitiationId: value.rootInitiationId,
    },
    recordedEvent: {
      timestampMs: 10_000,
      amount: 1,
      decision: "charged",
      reason: "machine_intelligence_response",
      spentAfter: 1,
      remainingAllowance: 0,
      normalSpentAfter: 1,
      overchargeSpentAfter: 0,
      overchargeAllowance: 2,
      remainingOvercharge: 2,
      softState: "soft_limit_reached",
      hardState: "exhausted",
    },
  };
}

describe("Postgres ICP fatigue regulation reservations", () => {
  it(
    "upgrades an already-provisioned version-6 reservation table idempotently",
    async () => {
      if (!harness)
        throw new Error("Postgres integration harness is unavailable");
      const databaseUrl = (await harness.createDatabase()).databaseUrl;
      const bootstrapPool = createPostgresPool(databaseUrl, {
        applicationName: "companion-icp-fatigue-v6-upgrade-test",
        allowExitOnIdle: true,
      });
      try {
        await withPostgresClient(bootstrapPool, async (client) => {
          await client.query("CREATE SCHEMA shared");
          await client.query("SET LOCAL search_path TO shared, public");
          for (const statement of POSTGRES_SHARED_MIGRATIONS.slice(0, -2)) {
            await client.query(statement);
          }
        });
        const first =
          await PostgresIcpFatigueRegulationReservationStore.connect(databaseUrl);
        await first.close();
        const second =
          await PostgresIcpFatigueRegulationReservationStore.connect(databaseUrl);
        await second.close();
        const result = await bootstrapPool.query<{
          definition: string;
          version_count: string;
        }>(`
          SELECT pg_get_constraintdef(constraint_row.oid) AS definition,
            (SELECT COUNT(*)::text FROM shared.shared_schema_migrations
              WHERE version = 7) AS version_count
          FROM pg_constraint AS constraint_row
          WHERE constraint_row.conrelid = 'shared.icp_fatigue_turn_reservations'::regclass
            AND constraint_row.conname = 'icp_fatigue_turn_reservations_lifecycle_check'
        `);
        expect(result.rows).toEqual([
          expect.objectContaining({
            definition: expect.stringContaining("delivering"),
            version_count: "1",
          }),
        ]);
      } finally {
        await bootstrapPool.end();
      }
    },
    TIMEOUT_MS,
  );

  it(
    "serializes DM/room last-slot races, survives restart, and preserves per-companion choice",
    async () => {
      if (!harness)
        throw new Error("Postgres integration harness is unavailable");
      const databaseUrl = (await harness.createDatabase()).databaseUrl;
      const episodes = await PostgresIcpSharedAutonomyStore.connect(
        databaseUrl,
        {
          knownCompanionIds: [A, B],
        },
      );
      const first =
        await PostgresIcpFatigueRegulationReservationStore.connect(databaseUrl);
      const second =
        await PostgresIcpFatigueRegulationReservationStore.connect(databaseUrl);
      try {
        await episodes.createEpisode({
          conversationId: DM_CONVERSATION,
          channelId: DM,
          participantCompanionIds: [A, B],
          rootInitiationId: ROOT,
          initiatedByCompanionId: A,
          initiationSource: "foreground",
          provenanceRef: "icp-prov:11111111-1111-4111-8111-111111111111",
          openedAtMs: 1_000,
          lastActivityAtMs: 1_000,
          status: "invited",
          revision: 1,
        });
        await episodes.createEpisode({
          conversationId: ROOM_CONVERSATION,
          channelId: ROOM,
          participantCompanionIds: [A, B],
          rootInitiationId: ROOT,
          initiatedByCompanionId: A,
          initiationSource: "foreground",
          provenanceRef: "icp-prov:55555555-5555-4555-8555-555555555555",
          openedAtMs: 1_000,
          lastActivityAtMs: 1_000,
          status: "invited",
          revision: 1,
        });
        const dmTurn = correlation({
          conversationId: DM_CONVERSATION,
          channelId: DM,
          turnId: "77777777-7777-7777-8777-777777777771",
        });
        const roomTurn = correlation({
          conversationId: ROOM_CONVERSATION,
          channelId: ROOM,
          turnId: "77777777-7777-7777-8777-777777777772",
        });
        const raced = await Promise.all([
          first.reserve(reservationInput(dmTurn)),
          second.reserve(reservationInput(roomTurn)),
        ]);
        expect(raced.map((result) => result.outcome).sort()).toEqual([
          "exhausted",
          "reserved",
        ]);
        const winner = raced[0].outcome === "reserved" ? dmTurn : roomTurn;
        const winningStore = raced[0].outcome === "reserved" ? first : second;
        await winningStore.prepareDelivery({
          correlation: winner,
          fatigue: finalizationFatigue(winner),
        });
        await winningStore.finalize({
          correlation: winner,
          outcome: "delivered",
          finalizedAtMs: 11_000,
          fatigue: finalizationFatigue(winner),
        });

        await first.close();
        const restarted =
          await PostgresIcpFatigueRegulationReservationStore.connect(
            databaseUrl,
          );
        try {
          expect(
            (
              await restarted.reserve(
                reservationInput(
                  correlation({
                    conversationId: ROOM_CONVERSATION,
                    channelId: ROOM,
                    turnId: "77777777-7777-7777-8777-777777777773",
                  }),
                  12_000,
                ),
              )
            ).outcome,
          ).toBe("exhausted");

          const overchargeDm = correlation({
            conversationId: DM_CONVERSATION,
            channelId: DM,
            turnId: "77777777-7777-7777-8777-777777777776",
          });
          const overchargeRoom = correlation({
            conversationId: ROOM_CONVERSATION,
            channelId: ROOM,
            turnId: "77777777-7777-7777-8777-777777777777",
          });
          const overchargeRace = await Promise.all([
            restarted.reserve({
              ...reservationInput(overchargeDm, 13_000),
              decision: "overcharge",
              overchargeLimit: 1,
            }),
            second.reserve({
              ...reservationInput(overchargeRoom, 13_000),
              decision: "overcharge",
              overchargeLimit: 1,
            }),
          ]);
          expect(overchargeRace.map((result) => result.outcome).sort()).toEqual([
            "exhausted",
            "reserved",
          ]);

          const peerChoice = correlation({
            conversationId: DM_CONVERSATION,
            channelId: DM,
            turnId: "77777777-7777-7777-8777-777777777774",
            localCompanionId: B,
            peerCompanionId: A,
          });
          const peerReservation = await restarted.reserve(
            reservationInput(peerChoice, 12_000),
          );
          expect(peerReservation).toMatchObject({
            outcome: "reserved",
            normalSpentBefore: 0,
            rootNormalSpent: 0,
            contributingReservationCount: 1,
          });
          expect(peerReservation.relationshipPressure).toBeGreaterThan(0);
        } finally {
          await restarted.close();
        }
      } finally {
        await Promise.allSettled([episodes.close(), second.close()]);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "is replay-idempotent and rejects episode/channel substitution",
    async () => {
      if (!harness)
        throw new Error("Postgres integration harness is unavailable");
      const databaseUrl = (await harness.createDatabase()).databaseUrl;
      const episodes = await PostgresIcpSharedAutonomyStore.connect(
        databaseUrl,
        {
          knownCompanionIds: [A, B],
        },
      );
      const store =
        await PostgresIcpFatigueRegulationReservationStore.connect(databaseUrl);
      try {
        await episodes.createEpisode({
          conversationId: DM_CONVERSATION,
          channelId: DM,
          participantCompanionIds: [A, B],
          rootInitiationId: ROOT,
          initiatedByCompanionId: A,
          initiationSource: "foreground",
          provenanceRef: "icp-prov:11111111-1111-4111-8111-111111111111",
          openedAtMs: 1_000,
          lastActivityAtMs: 1_000,
          status: "invited",
          revision: 1,
        });
        const turn = correlation({
          conversationId: DM_CONVERSATION,
          channelId: DM,
          turnId: "77777777-7777-7777-8777-777777777775",
        });
        expect((await store.reserve(reservationInput(turn))).outcome).toBe(
          "reserved",
        );
        const replay = await store.reserve(reservationInput(turn));
        expect(replay).toMatchObject({
          outcome: "replayed",
          normalSpentBefore: 0,
          overchargeSpentBefore: 0,
          rootNormalSpent: 0,
          rootOverchargeSpent: 0,
          contributingReservationCount: 0,
        });
        await expect(
          store.finalize({
            correlation: turn,
            outcome: "delivered",
            finalizedAtMs: 11_000,
            fatigue: {
              ...finalizationFatigue(turn),
              socialRegulation: {
                ...finalizationFatigue(turn).socialRegulation,
                rootInitiationId: "99999999-9999-4999-8999-999999999999",
              },
            },
          }),
        ).rejects.toThrow("metadata binding mismatch");
        await store.prepareDelivery({
          correlation: turn,
          fatigue: finalizationFatigue(turn),
        });
        await expect(
          store.finalize({
            correlation: turn,
            outcome: "delivered",
            finalizedAtMs: 11_000,
            fatigue: finalizationFatigue(turn),
          }),
        ).resolves.toBeUndefined();
        await expect(
          store.reserve(
            reservationInput({
              ...turn,
              channelId: ROOM,
              surface: "companion_room",
            }),
          ),
        ).rejects.toThrow("replay mismatch");
      } finally {
        await Promise.all([episodes.close(), store.close()]);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "keeps a live long-running lease across elapsed time and recovers a delivering crash",
    async () => {
      if (!harness)
        throw new Error("Postgres integration harness is unavailable");
      const databaseUrl = (await harness.createDatabase()).databaseUrl;
      const episodes = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
        knownCompanionIds: [A, B],
      });
      const active =
        await PostgresIcpFatigueRegulationReservationStore.connect(databaseUrl);
      const racer =
        await PostgresIcpFatigueRegulationReservationStore.connect(databaseUrl);
      let recovery: PostgresIcpFatigueRegulationReservationStore | null = null;
      try {
        for (const episode of [
          { conversationId: DM_CONVERSATION, channelId: DM },
          { conversationId: ROOM_CONVERSATION, channelId: ROOM },
        ]) {
          await episodes.createEpisode({
            conversationId: episode.conversationId,
            channelId: episode.channelId,
            participantCompanionIds: [A, B],
            rootInitiationId: ROOT,
            initiatedByCompanionId: A,
            initiationSource: "foreground",
            provenanceRef: `icp-prov:${episode.conversationId}`,
            openedAtMs: 1_000,
            lastActivityAtMs: 1_000,
            status: "invited",
            revision: 1,
          });
        }
        const activeTurn = correlation({
          conversationId: DM_CONVERSATION,
          channelId: DM,
          turnId: "77777777-7777-7777-8777-777777777778",
        });
        const elapsedRacer = correlation({
          conversationId: ROOM_CONVERSATION,
          channelId: ROOM,
          turnId: "77777777-7777-7777-8777-777777777779",
        });
        await expect(active.reserve(reservationInput(activeTurn, 10_000)))
          .resolves.toMatchObject({ outcome: "reserved" });
        await expect(
          racer.reserve(reservationInput(elapsedRacer, 10_000 + WINDOW_MS)),
        ).resolves.toMatchObject({ outcome: "exhausted" });

        await active.prepareDelivery({
          correlation: activeTurn,
          fatigue: finalizationFatigue(activeTurn),
        });
        await active.close();

        recovery =
          await PostgresIcpFatigueRegulationReservationStore.connect(databaseUrl);
        await expect(recovery.reserve(reservationInput(activeTurn, 10_000)))
          .resolves.toMatchObject({
            outcome: "replayed",
            normalSpentBefore: 0,
          });
        await expect(recovery.prepareDelivery({
          correlation: activeTurn,
          fatigue: finalizationFatigue(activeTurn),
        })).resolves.toBeUndefined();
        await expect(recovery.finalize({
          correlation: activeTurn,
          outcome: "delivered",
          finalizedAtMs: 11_000,
          fatigue: finalizationFatigue(activeTurn),
        })).resolves.toBeUndefined();
        await expect(
          racer.reserve(reservationInput(elapsedRacer, 10_000 + WINDOW_MS)),
        ).resolves.toMatchObject({ outcome: "exhausted" });
      } finally {
        await Promise.allSettled([
          episodes.close(),
          active.close(),
          racer.close(),
          recovery?.close(),
        ]);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "reclaims an orphan pending row only after shutdown releases its session lease",
    async () => {
      if (!harness)
        throw new Error("Postgres integration harness is unavailable");
      const databaseUrl = (await harness.createDatabase()).databaseUrl;
      const episodes = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
        knownCompanionIds: [A, B],
      });
      const owner =
        await PostgresIcpFatigueRegulationReservationStore.connect(databaseUrl);
      const successor =
        await PostgresIcpFatigueRegulationReservationStore.connect(databaseUrl);
      try {
        await episodes.createEpisode({
          conversationId: DM_CONVERSATION,
          channelId: DM,
          participantCompanionIds: [A, B],
          rootInitiationId: ROOT,
          initiatedByCompanionId: A,
          initiationSource: "foreground",
          provenanceRef: "icp-prov:11111111-1111-4111-8111-111111111111",
          openedAtMs: 1_000,
          lastActivityAtMs: 1_000,
          status: "invited",
          revision: 1,
        });
        const abandoned = correlation({
          conversationId: DM_CONVERSATION,
          channelId: DM,
          turnId: "77777777-7777-7777-8777-777777777780",
        });
        const successorTurn = correlation({
          conversationId: DM_CONVERSATION,
          channelId: DM,
          turnId: "77777777-7777-7777-8777-777777777781",
        });
        await expect(owner.reserve(reservationInput(abandoned)))
          .resolves.toMatchObject({ outcome: "reserved" });
        await owner.close();
        await expect(successor.reserve(reservationInput(successorTurn, 20_000)))
          .resolves.toMatchObject({
            outcome: "reserved",
            normalSpentBefore: 0,
          });
      } finally {
        await Promise.allSettled([
          episodes.close(),
          owner.close(),
          successor.close(),
        ]);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "bounds dedicated lease connections and fails closed when capacity is full",
    async () => {
      if (!harness)
        throw new Error("Postgres integration harness is unavailable");
      const databaseUrl = (await harness.createDatabase()).databaseUrl;
      const episodes = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
        knownCompanionIds: [A, B],
      });
      const store =
        await PostgresIcpFatigueRegulationReservationStore.connect(databaseUrl);
      try {
        const turns: ReturnType<typeof correlation>[] = [];
        for (let index = 1; index <= 9; index += 1) {
          const suffix = String(index).padStart(12, "0");
          const conversationId = `55555555-5555-4555-8555-${suffix}`;
          await episodes.createEpisode({
            conversationId,
            channelId: DM,
            participantCompanionIds: [A, B],
            rootInitiationId: ROOT,
            initiatedByCompanionId: A,
            initiationSource: "foreground",
            provenanceRef: `icp-prov:${conversationId}`,
            openedAtMs: 1_000,
            lastActivityAtMs: 1_000,
            status: "invited",
            revision: 1,
          });
          turns.push(correlation({
            conversationId,
            channelId: DM,
            turnId: `77777777-7777-4777-8777-${suffix}`,
          }));
        }
        for (const turn of turns.slice(0, 8)) {
          await expect(store.reserve({
            ...reservationInput(turn),
            hardLimit: 100,
          })).resolves.toMatchObject({ outcome: "reserved" });
        }
        await expect(store.reserve({
          ...reservationInput(turns[8]!),
          hardLimit: 100,
        })).rejects.toThrow("lease capacity unavailable");
      } finally {
        await Promise.allSettled([episodes.close(), store.close()]);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "decays declined, deferred, and unanswered initiation pressure without a daily reset",
    async () => {
      if (!harness)
        throw new Error("Postgres integration harness is unavailable");
      const databaseUrl = (await harness.createDatabase()).databaseUrl;
      const episodes = await PostgresIcpSharedAutonomyStore.connect(
        databaseUrl,
        {
          knownCompanionIds: [A, B],
        },
      );
      const store =
        await PostgresIcpFatigueRegulationReservationStore.connect(databaseUrl);
      const episodeFixtures = [
        {
          conversationId: "55555555-5555-4555-8555-555555555551",
          rootInitiationId: "66666666-6666-4666-8666-666666666661",
          provenanceRef: "icp-prov:11111111-1111-4111-8111-111111111111",
          status: "declined" as const,
          closeReasonCode: "conversation_declined" as const,
        },
        {
          conversationId: "55555555-5555-4555-8555-555555555552",
          rootInitiationId: "66666666-6666-4666-8666-666666666662",
          provenanceRef: "icp-prov:22222222-2222-4222-8222-222222222222",
          status: "deferred" as const,
          closeReasonCode: "conversation_deferred" as const,
        },
        {
          conversationId: "55555555-5555-4555-8555-555555555553",
          rootInitiationId: "66666666-6666-4666-8666-666666666663",
          provenanceRef: "icp-prov:33333333-3333-4333-8333-333333333333",
        },
      ];
      try {
        for (const fixture of episodeFixtures) {
          await episodes.createEpisode({
            conversationId: fixture.conversationId,
            channelId: DM,
            participantCompanionIds: [A, B],
            rootInitiationId: fixture.rootInitiationId,
            initiatedByCompanionId: A,
            initiationSource: "foreground",
            provenanceRef: fixture.provenanceRef,
            openedAtMs: 1_000,
            lastActivityAtMs: 1_000,
            status: "invited",
            revision: 1,
          });
          if (fixture.status) {
            await episodes.transitionEpisode({
              conversationId: fixture.conversationId,
              expectedStatus: "invited",
              expectedRevision: 1,
              expectedLastActivityAtMs: 1_000,
              status: fixture.status,
              lastActivityAtMs: 1_000,
              closeReasonCode: fixture.closeReasonCode,
            });
          }
        }

        const pressure = await store.readInitiationPressure({
          localCompanionId: A,
          peerCompanionId: B,
          timestampMs: 2_000,
          relationshipPressureHalfLifeMs: 1_000,
          relationshipPressureWindowMs: 10_000,
          unansweredAfterMs: 500,
          declinedPressureUnits: 3,
          deferredPressureUnits: 2,
          unansweredPressureUnits: 1,
        });
        expect(pressure).toEqual({
          relationshipPressure: 3,
          chargedPressure: 0,
          declinedPressure: 1.5,
          deferredPressure: 1,
          unansweredPressure: 0.5,
          contributingReservationCount: 0,
          contributingEpisodeCount: 3,
        });
        await expect(
          store.readInitiationPressure({
            localCompanionId: B,
            peerCompanionId: A,
            timestampMs: 2_000,
            relationshipPressureHalfLifeMs: 1_000,
            relationshipPressureWindowMs: 10_000,
            unansweredAfterMs: 500,
            declinedPressureUnits: 3,
            deferredPressureUnits: 2,
            unansweredPressureUnits: 1,
          }),
        ).resolves.toMatchObject({
          relationshipPressure: 3,
          contributingEpisodeCount: 3,
        });
      } finally {
        await Promise.all([episodes.close(), store.close()]);
      }
    },
    TIMEOUT_MS,
  );
});
