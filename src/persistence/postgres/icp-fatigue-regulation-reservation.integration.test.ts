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
import { bootstrapSharedSchema } from "./shared-schema.js";

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

async function freshDatabaseUrl(): Promise<string> {
  if (!harness) throw new Error("Postgres integration harness is unavailable");
  const databaseUrl = (await harness.createDatabase()).databaseUrl;
  await bootstrapSharedSchema(databaseUrl);
  return databaseUrl;
}

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
        await bootstrapSharedSchema(databaseUrl);
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
      const databaseUrl = await freshDatabaseUrl();
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
          // 6087o: the peer's own budget ignores this side's turns.
          expect(peerReservation.relationshipPressure).toBe(0);
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
      const databaseUrl = await freshDatabaseUrl();
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
        await expect(store.reserve(reservationInput(turn))).resolves.toMatchObject({
          outcome: "replayed",
          reservationOutcome: "delivered",
        });
        await expect(store.prepareDelivery({
          correlation: turn,
          fatigue: finalizationFatigue(turn),
          recoveredOutcome: "delivered",
        })).resolves.toBeUndefined();
        await expect(store.prepareDelivery({
          correlation: turn,
          fatigue: finalizationFatigue(turn),
          recoveredOutcome: "no_reply",
        })).rejects.toThrow("terminal replay conflict");
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
      const databaseUrl = await freshDatabaseUrl();
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
      const databaseUrl = await freshDatabaseUrl();
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
      const databaseUrl = await freshDatabaseUrl();
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
    "does not count a turn whose peer appraisal or processing failed as relationship pressure (0eq2x, 9rima)",
    async () => {
      if (!harness)
        throw new Error("Postgres integration harness is unavailable");
      const databaseUrl = await freshDatabaseUrl();
      const episodes = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
        knownCompanionIds: [A, B],
      });
      const store =
        await PostgresIcpFatigueRegulationReservationStore.connect(databaseUrl);
      const sqlPool = createPostgresPool(databaseUrl, {
        applicationName: "icp-pressure-failed-peer-test",
        allowExitOnIdle: true,
      });
      const fixtures: Array<{
        conversationId: string;
        closeReasonCode: "peer_appraisal_unavailable" | "conversation_ended" | null;
        peerTurnFailed?: true;
        reclassify?: true;
      }> = [
        { conversationId: "55555555-5555-4555-8555-000000000071", closeReasonCode: "peer_appraisal_unavailable" as const },
        { conversationId: "55555555-5555-4555-8555-000000000072", closeReasonCode: "conversation_ended" as const },
        // 9rima: B's reply turn failed as a system error; B never completed a turn.
        { conversationId: "55555555-5555-4555-8555-000000000073", closeReasonCode: null, peerTurnFailed: true },
        // A pre-0eq2x appraisal failure recorded as conversation_ended, then corrected.
        { conversationId: "55555555-5555-4555-8555-000000000074", closeReasonCode: "conversation_ended", reclassify: true },
      ];
      try {
        for (const [index, fixture] of fixtures.entries()) {
          await episodes.createEpisode({
            conversationId: fixture.conversationId,
            channelId: DM,
            participantCompanionIds: [A, B],
            rootInitiationId: ROOT,
            initiatedByCompanionId: A,
            initiationSource: "operator_test",
            provenanceRef: `icp-prov:${fixture.conversationId}`,
            openedAtMs: 1_000,
            lastActivityAtMs: 1_000,
            status: "invited",
            revision: 1,
          });
          await expect(store.reserve({
            ...reservationInput(correlation({
              conversationId: fixture.conversationId,
              channelId: DM,
              turnId: `77777777-7777-4777-8777-00000000007${String(index)}`,
            })),
            hardLimit: 100,
          })).resolves.toMatchObject({ outcome: "reserved" });
          if (fixture.peerTurnFailed) {
            const peerTurnId = `77777777-7777-4777-8777-00000000008${String(index)}`;
            await expect(store.reserve({
              ...reservationInput(correlation({
                conversationId: fixture.conversationId,
                channelId: DM,
                turnId: peerTurnId,
                localCompanionId: B,
                peerCompanionId: A,
              })),
              hardLimit: 100,
            })).resolves.toMatchObject({ outcome: "reserved" });
            await sqlPool.query(
              "UPDATE shared.icp_fatigue_turn_reservations SET outcome = 'failed', finalized_at_ms = reserved_at_ms WHERE turn_id = $1",
              [peerTurnId],
            );
            continue;
          }
          await episodes.transitionEpisode({
            conversationId: fixture.conversationId,
            expectedStatus: "invited",
            expectedRevision: 1,
            expectedLastActivityAtMs: 1_000,
            status: "ended",
            lastActivityAtMs: 1_000,
            closeReasonCode: fixture.closeReasonCode!,
          });
          if (fixture.reclassify) {
            await expect(episodes.reclassifyEndedEpisodeCloseReason({
              conversationId: fixture.conversationId,
              expectedRevision: 1,
              fromReasonCode: "conversation_ended",
              toReasonCode: "peer_appraisal_unavailable",
            })).rejects.toThrow(/reclassification conflict/);
            await expect(episodes.reclassifyEndedEpisodeCloseReason({
              conversationId: fixture.conversationId,
              expectedRevision: 2,
              fromReasonCode: "conversation_ended",
              toReasonCode: "peer_appraisal_unavailable",
            })).resolves.toMatchObject({ closeReasonCode: "peer_appraisal_unavailable", revision: 3 });
          }
        }

        const pressure = await store.readInitiationPressure({
          localCompanionId: A,
          peerCompanionId: B,
          timestampMs: 10_000,
          relationshipPressureHalfLifeMs: HALF_LIFE_MS,
          relationshipPressureWindowMs: WINDOW_MS,
          unansweredAfterMs: 15 * 60_000,
          declinedPressureUnits: 3,
          deferredPressureUnits: 2,
          unansweredPressureUnits: 1,
          mutualReplyAllowancePerSide: 8,
          mutualReplyPressureUnits: 0.2,
        });
        // Only the socially ended conversation's charged turn counts.
        expect(pressure.contributingReservationCount).toBe(1);
        expect(pressure.chargedPressure).toBeCloseTo(1, 6);
      } finally {
        await Promise.allSettled([episodes.close(), store.close(), sqlPool.end()]);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "budgets each side of a conversation by its own replies with decayed carry-over (6087o)",
    async () => {
      if (!harness)
        throw new Error("Postgres integration harness is unavailable");
      const databaseUrl = await freshDatabaseUrl();
      const episodes = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
        knownCompanionIds: [A, B],
      });
      const store =
        await PostgresIcpFatigueRegulationReservationStore.connect(databaseUrl);
      let turnCounter = 0;
      const takeTurn = async (input: {
        conversationId: string;
        rootInitiationId: string;
        local: string;
        peer: string;
        timestampMs: number;
      }) => {
        turnCounter += 1;
        const value = correlation({
          conversationId: input.conversationId,
          rootInitiationId: input.rootInitiationId,
          channelId: DM,
          turnId: `99999999-9999-4999-8999-${String(turnCounter).padStart(12, "0")}`,
          localCompanionId: input.local,
          peerCompanionId: input.peer,
        });
        const result = await store.reserve({
          ...reservationInput(value, input.timestampMs),
          hardLimit: 16,
        });
        if (result.outcome === "reserved") {
          await store.prepareDelivery({ correlation: value, fatigue: finalizationFatigue(value) });
          await store.finalize({
            correlation: value,
            outcome: "delivered",
            finalizedAtMs: input.timestampMs,
            fatigue: finalizationFatigue(value),
          });
        }
        return result;
      };
      const createEpisode = async (conversationId: string, rootInitiationId: string) => {
        await episodes.createEpisode({
          conversationId,
          channelId: DM,
          participantCompanionIds: [A, B],
          rootInitiationId,
          initiatedByCompanionId: A,
          initiationSource: "operator_test",
          provenanceRef: `icp-prov:${conversationId}`,
          openedAtMs: 1_000,
          lastActivityAtMs: 1_000,
          status: "invited",
          revision: 1,
        });
      };
      try {
        // A two-sided conversation, alternating sides one second apart.
        const first = "55555555-5555-4555-8555-0000000000a1";
        const firstRoot = "66666666-6666-4666-8666-0000000000a1";
        await createEpisode(first, firstRoot);
        const reservedBySide = new Map<string, number>([[A, 0], [B, 0]]);
        const aSnapshots: Array<{ normalSpentBefore: number; relationshipPressure: number }> = [];
        let exhaustedAt: Record<string, number | undefined> = {};
        for (let step = 0; step < 40; step += 1) {
          const local = step % 2 === 0 ? A : B;
          if (exhaustedAt[local] !== undefined) continue;
          const result = await takeTurn({
            conversationId: first,
            rootInitiationId: firstRoot,
            local,
            peer: local === A ? B : A,
            timestampMs: 10_000 + step * 1_000,
          });
          if (result.outcome === "exhausted") {
            exhaustedAt = { ...exhaustedAt, [local]: reservedBySide.get(local) };
            continue;
          }
          reservedBySide.set(local, reservedBySide.get(local)! + 1);
          if (local === A) {
            aSnapshots.push({
              normalSpentBefore: result.normalSpentBefore,
              relationshipPressure: result.relationshipPressure,
            });
          }
        }
        // Each side reaches the hard stop at its own 16 replies; the other
        // side's turns never count toward it.
        expect(exhaustedAt).toEqual({ [A]: 16, [B]: 16 });
        // Before A's 9th reply its soft state reads its own 8 replies (the
        // designed soft allowance), not the pair's 15 turns.
        expect(aSnapshots[8]!.normalSpentBefore).toBe(8);
        expect(aSnapshots[8]!.relationshipPressure).toBeGreaterThan(7.99);
        expect(aSnapshots[8]!.relationshipPressure).toBeLessThanOrEqual(8);

        // A second conversation an hour after a short one of 4 replies per
        // side starts with only A's own decayed carry-over.
        const shortConversation = "55555555-5555-4555-8555-0000000000a2";
        const shortRoot = "66666666-6666-4666-8666-0000000000a2";
        const later = "55555555-5555-4555-8555-0000000000a3";
        const laterRoot = "66666666-6666-4666-8666-0000000000a3";
        const pairDatabaseUrl = await freshDatabaseUrl();
        const pairEpisodes = await PostgresIcpSharedAutonomyStore.connect(pairDatabaseUrl, {
          knownCompanionIds: [A, B],
        });
        const pairStore =
          await PostgresIcpFatigueRegulationReservationStore.connect(pairDatabaseUrl);
        try {
          for (const [conversationId, rootInitiationId] of [
            [shortConversation, shortRoot],
            [later, laterRoot],
          ] as const) {
            await pairEpisodes.createEpisode({
              conversationId,
              channelId: DM,
              participantCompanionIds: [A, B],
              rootInitiationId,
              initiatedByCompanionId: A,
              initiationSource: "operator_test",
              provenanceRef: `icp-prov:${conversationId}`,
              openedAtMs: 1_000,
              lastActivityAtMs: 1_000,
              status: "invited",
              revision: 1,
            });
          }
          let pairTurn = 0;
          const pairReserve = async (
            conversationId: string,
            rootInitiationId: string,
            local: string,
            timestampMs: number,
          ) => {
            pairTurn += 1;
            const value = correlation({
              conversationId,
              rootInitiationId,
              channelId: DM,
              turnId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(pairTurn).padStart(12, "0")}`,
              localCompanionId: local,
              peerCompanionId: local === A ? B : A,
            });
            const result = await pairStore.reserve({ ...reservationInput(value, timestampMs), hardLimit: 16 });
            if (result.outcome === "reserved") {
              await pairStore.prepareDelivery({ correlation: value, fatigue: finalizationFatigue(value) });
              await pairStore.finalize({
                correlation: value,
                outcome: "delivered",
                finalizedAtMs: timestampMs,
                fatigue: finalizationFatigue(value),
              });
            }
            return result;
          };
          for (let step = 0; step < 8; step += 1) {
            await pairReserve(shortConversation, shortRoot, step % 2 === 0 ? A : B, 10_000 + step * 1_000);
          }
          const oneHourLater = 10_000 + 60 * 60_000;
          const opening = await pairReserve(later, laterRoot, A, oneHourLater);
          expect(opening.outcome).toBe("reserved");
          // 4 own replies at a 6 h half-life: 4 x 2^(-1/6) ~ 3.56, never the pair's 8.
          expect(opening.relationshipPressure).toBeCloseTo(4 * 2 ** (-1 / 6), 3);
          expect(opening.normalSpentBefore).toBe(4);
          let aReplies = 1;
          for (let step = 1; step < 60; step += 1) {
            const local = step % 2 === 0 ? A : B;
            const result = await pairReserve(later, laterRoot, local, oneHourLater + step * 1_000);
            if (local !== A) continue;
            if (result.outcome === "exhausted") break;
            aReplies += 1;
          }
          // Only partly used: A has 12 of its 16 replies left in the new conversation.
          expect(aReplies).toBe(12);
        } finally {
          await Promise.allSettled([pairEpisodes.close(), pairStore.close()]);
        }
      } finally {
        await Promise.allSettled([episodes.close(), store.close()]);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "weighs a friendly mutual conversation lightly and one-sided outreach and declines in full (r5)",
    async () => {
      if (!harness)
        throw new Error("Postgres integration harness is unavailable");
      const databaseUrl = await freshDatabaseUrl();
      const episodes = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
        knownCompanionIds: [A, B],
      });
      const store =
        await PostgresIcpFatigueRegulationReservationStore.connect(databaseUrl);
      const sqlPool = createPostgresPool(databaseUrl, {
        applicationName: "icp-pressure-mutual-model-test",
        allowExitOnIdle: true,
      });
      const pressureInput = (allowance: number) => ({
        localCompanionId: A,
        peerCompanionId: B,
        timestampMs: 10_000,
        relationshipPressureHalfLifeMs: HALF_LIFE_MS,
        relationshipPressureWindowMs: WINDOW_MS,
        unansweredAfterMs: 15 * 60_000,
        declinedPressureUnits: 3,
        deferredPressureUnits: 2,
        unansweredPressureUnits: 1,
        mutualReplyAllowancePerSide: allowance,
        mutualReplyPressureUnits: 0.2,
      });
      let turn = 0;
      const deliveredTurn = async (conversationId: string, local: string, peer: string) => {
        turn += 1;
        const turnId = `88888888-8888-4888-8888-${String(turn).padStart(12, "0")}`;
        await expect(store.reserve({
          ...reservationInput(correlation({
            conversationId,
            channelId: DM,
            turnId,
            localCompanionId: local,
            peerCompanionId: peer,
          })),
          hardLimit: 100,
        })).resolves.toMatchObject({ outcome: "reserved" });
        await sqlPool.query(
          "UPDATE shared.icp_fatigue_turn_reservations SET outcome = 'delivered', finalized_at_ms = reserved_at_ms WHERE turn_id = $1",
          [turnId],
        );
      };
      const createEpisode = async (conversationId: string, _label: string) => {
        await episodes.createEpisode({
          conversationId,
          channelId: DM,
          participantCompanionIds: [A, B],
          rootInitiationId: ROOT,
          initiatedByCompanionId: A,
          initiationSource: "operator_test",
          provenanceRef: `icp-prov:${conversationId}`,
          openedAtMs: 1_000,
          lastActivityAtMs: 1_000,
          status: "invited",
          revision: 1,
        });
      };
      try {
        // The r5 exchange: Artemis 3 turns, Vega 2, both delivered.
        const mutual = "55555555-5555-4555-8555-000000000091";
        await createEpisode(mutual, "mutual");
        for (const [local, peer] of [[A, B], [B, A], [A, B], [B, A], [A, B]] as const) {
          await deliveredTurn(mutual, local, peer);
        }
        const friendly = await store.readInitiationPressure(pressureInput(8));
        expect(friendly.chargedPressure).toBeCloseTo(1, 6);
        expect(friendly.relationshipPressure).toBeCloseTo(1, 6);
        // Past the per-side allowance a reply counts in full: A's third turn.
        const tightAllowance = await store.readInitiationPressure(pressureInput(2));
        expect(tightAllowance.chargedPressure).toBeCloseTo(0.2 * 4 + 1, 6);

        // Three unanswered one-sided initiations and one declined invitation.
        for (const suffix of ["92", "93", "94"]) {
          const oneSided = `55555555-5555-4555-8555-0000000000${suffix}`;
          await createEpisode(oneSided, suffix);
          await deliveredTurn(oneSided, A, B);
        }
        const declined = "55555555-5555-4555-8555-000000000095";
        await createEpisode(declined, "declined");
        await episodes.transitionEpisode({
          conversationId: declined,
          expectedStatus: "invited",
          expectedRevision: 1,
          expectedLastActivityAtMs: 1_000,
          status: "declined",
          lastActivityAtMs: 10_000,
          closeReasonCode: "conversation_declined",
        });
        const pushy = await store.readInitiationPressure(pressureInput(8));
        expect(pushy.chargedPressure).toBeCloseTo(1 + 3, 6);
        expect(pushy.declinedPressure).toBeCloseTo(3, 6);
        // ceil(7) is past a soft target of 6: initiation backs off.
        expect(pushy.relationshipPressure).toBeCloseTo(7, 6);
      } finally {
        await Promise.allSettled([episodes.close(), store.close(), sqlPool.end()]);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "decays declined, deferred, and delivered-but-unanswered initiation pressure without a daily reset",
    async () => {
      if (!harness)
        throw new Error("Postgres integration harness is unavailable");
      const databaseUrl = await freshDatabaseUrl();
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
          permitStatus: "consumed" as const,
        },
        // 9rima: the permit expired before delivery, so the peer never saw it.
        {
          conversationId: "55555555-5555-4555-8555-555555555554",
          rootInitiationId: "66666666-6666-4666-8666-666666666664",
          provenanceRef: "icp-prov:44444444-4444-4444-8444-444444444444",
          permitStatus: "expired" as const,
        },
      ];
      const sqlPool = createPostgresPool(databaseUrl, {
        applicationName: "icp-pressure-undelivered-invite-test",
        allowExitOnIdle: true,
      });
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
          if ("permitStatus" in fixture) {
            await sqlPool.query(
              `INSERT INTO shared.icp_initiation_permits (
                permit_id, candidate_id, conversation_id, sender_companion_id,
                recipient_companion_id, channel_id, provenance_ref, issued_at_ms,
                expires_at_ms, status, consumed_at_ms, revision
              ) VALUES (gen_random_uuid(), gen_random_uuid(), $1, $2, $3, $4, $5, 900, 1100, $6, $7, 2)`,
              [
                fixture.conversationId, A, B, DM, fixture.provenanceRef, fixture.permitStatus,
                fixture.permitStatus === "consumed" ? 950 : null,
              ],
            );
          }
          if ("status" in fixture && fixture.status) {
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
          mutualReplyAllowancePerSide: 8,
          mutualReplyPressureUnits: 0.2,
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
            mutualReplyAllowancePerSide: 8,
            mutualReplyPressureUnits: 0.2,
          }),
        ).resolves.toMatchObject({
          relationshipPressure: 3,
          contributingEpisodeCount: 3,
        });
      } finally {
        await Promise.all([episodes.close(), store.close(), sqlPool.end()]);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "isTurnFenced reports a live pending turn for the local companion only, and clears on finalize",
    async () => {
      if (!harness)
        throw new Error("Postgres integration harness is unavailable");
      const databaseUrl = await freshDatabaseUrl();
      const episodes = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
        knownCompanionIds: [A, B],
      });
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
          turnId: "77777777-7777-7777-8777-777777777774",
        });

        // No pending turn: neither companion is fenced.
        expect(await store.isTurnFenced({ companionId: A })).toBe(false);
        expect(await store.isTurnFenced({ companionId: B })).toBe(false);

        // A live pending reservation fences the local (turn-producing) companion
        // A, but not the peer B.
        expect((await store.reserve(reservationInput(turn))).outcome).toBe("reserved");
        expect(await store.isTurnFenced({ companionId: A })).toBe(true);
        expect(await store.isTurnFenced({ companionId: B })).toBe(false);

        // The `delivering` window — where the actual external ICP egress
        // happens (prepareDelivery → finalizeDelivery → finalize) — must stay
        // fenced. Social must not race an actively-delivering ICP turn (§8.5).
        await store.prepareDelivery({ correlation: turn, fatigue: finalizationFatigue(turn) });
        expect(await store.isTurnFenced({ companionId: A })).toBe(true);
        expect(await store.isTurnFenced({ companionId: B })).toBe(false);

        // Finalizing the turn (delivered) clears the fence.
        await store.finalize({
          correlation: turn,
          outcome: "delivered",
          finalizedAtMs: 11_000,
          fatigue: finalizationFatigue(turn),
        });
        expect(await store.isTurnFenced({ companionId: A })).toBe(false);
      } finally {
        await Promise.all([episodes.close(), store.close()]);
      }
    },
    TIMEOUT_MS,
  );
});
