import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import { resolveChargeLedgerPath, resolveFatigueLedgerPath } from '../../persistence/layout.js';
import { createPostgresPool } from '../../persistence/postgres.js';
import { readRunChargeRollingWindowFromLedger } from '../../shared/telemetry/charge-ledger.js';
import { FatigueLedger } from '../../shared/telemetry/fatigue-ledger.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  PGVECTOR_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import {
  CERTIFICATION_COMPANION_A,
  CERTIFICATION_COMPANION_B,
  CERTIFICATION_DM_CHANNEL,
  CERTIFICATION_PRIVATE_ROOM,
  CERTIFICATION_SCHEMA_A,
  CERTIFICATION_SCHEMA_B,
} from './icp-certification/constants.js';
import {
  createIcpCertificationFixture,
  type IcpCertificationFixture,
} from './icp-certification/fixture.js';
import {
  startIcpCertificationProcessHarness,
  startIcpSingleCompanionFeatureOffHarness,
  type IcpCertificationProcessHarness,
  type IcpSingleCompanionFeatureOffHarness,
} from './icp-certification/process-harness.js';

const COLLISION_ROUNDS = 4;
const QUIESCENCE_TIMEOUT_MS = 30_000;
const QUIESCENCE_WINDOW_MS = 1_000;
const PROCESS_EXIT_TIMEOUT_MS = 10_000;
const MULTI_COMPANION_COVERAGE_CASE_IDS = [
  'multi_companion_crossover_isolation',
  'icp_durable_turns_restart',
  // Earned by validateFatigueCloseoutReserve (overcharge reserve provably
  // fires under continuation evidence), NOT by the room suppression scenario.
  'icp_fatigue_closeout_reserve',
] as const;

type CertificationAgent = IcpCertificationProcessHarness['agents'][number];

interface ChannelSnapshot {
  entries: Array<{ authorId?: string; role: string }>;
  memories: unknown[];
  summaries: unknown[];
}

interface TurnRecordsSnapshot {
  records: Array<{
    requestId: string;
    status: string;
    correlation?: {
      fatigueDecision: string;
      fatigueReasonCode?: string;
      rootInitiationId: string;
    };
  }>;
}

interface FatigueSnapshot {
  amount: number;
  chargedEventCount: number;
  eventCount: number;
  hardState: string | null;
  overchargeEventCount: number;
}

class ValidationFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ValidationFailure';
  }
}

function requireInvariant(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ValidationFailure(code);
}

function requireDefined<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new ValidationFailure(code);
  return value;
}

function currentRevision(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function pathIdentity(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 16);
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isRecord(error) || error.code !== 'ESRCH';
  }
}

async function waitForProcessesToExit(pids: readonly number[]): Promise<number[]> {
  const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS;
  let running = pids.filter(processIsRunning);
  while (running.length > 0 && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
    running = pids.filter(processIsRunning);
  }
  return running;
}

async function waitForModelQuiescence(harness: IcpCertificationProcessHarness): Promise<number> {
  const deadline = Date.now() + QUIESCENCE_TIMEOUT_MS;
  let previousCount = harness.modelRequestCount;
  let unchangedSinceMs = Date.now();
  while (Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
    const currentCount = harness.modelRequestCount;
    if (currentCount !== previousCount) {
      previousCount = currentCount;
      unchangedSinceMs = Date.now();
      continue;
    }
    if (Date.now() - unchangedSinceMs >= QUIESCENCE_WINDOW_MS) return currentCount;
  }
  throw new ValidationFailure('model_fixture_did_not_quiesce');
}

function createCollisionMessage(input: {
  channelId: string;
  channelType: 'api' | 'telegram';
  requestId: string;
  targetLabel: 'a' | 'b';
}): SubstrateMessage {
  return {
    id: input.requestId,
    channelId: input.channelId,
    channelType: input.channelType,
    isDirectMessage: true,
    authorId: 'runtime-validation-operator',
    authorName: 'Runtime Validation',
    content: `private-route-marker-${input.targetLabel}-${input.requestId}`,
    timestamp: new Date(),
  };
}

async function readChannelSnapshot(
  agent: CertificationAgent,
  channelId: string,
): Promise<ChannelSnapshot> {
  const snapshot = await agent.channelSnapshot(channelId);
  requireInvariant(Array.isArray(snapshot.entries), 'channel_snapshot_entries_invalid');
  requireInvariant(Array.isArray(snapshot.memories), 'channel_snapshot_memories_invalid');
  requireInvariant(Array.isArray(snapshot.summaries), 'channel_snapshot_summaries_invalid');
  const entries = snapshot.entries.map((entry) => {
    requireInvariant(isRecord(entry), 'channel_snapshot_entry_invalid');
    requireInvariant(typeof entry.role === 'string', 'channel_snapshot_entry_role_invalid');
    requireInvariant(
      entry.authorId === undefined || typeof entry.authorId === 'string',
      'channel_snapshot_entry_author_invalid',
    );
    return {
      role: entry.role,
      ...(typeof entry.authorId === 'string' ? { authorId: entry.authorId } : {}),
    };
  });
  return { entries, memories: snapshot.memories, summaries: snapshot.summaries };
}

async function readTurnRecords(
  agent: CertificationAgent,
  channelId: string,
): Promise<TurnRecordsSnapshot> {
  const snapshot = await agent.turnRecordsSnapshot(channelId);
  requireInvariant(Array.isArray(snapshot.records), 'turn_records_snapshot_invalid');
  const records = snapshot.records.map((record) => {
    requireInvariant(isRecord(record), 'turn_record_invalid');
    requireInvariant(typeof record.requestId === 'string', 'turn_record_request_id_invalid');
    requireInvariant(typeof record.status === 'string', 'turn_record_status_invalid');
    if (record.correlation === undefined) {
      return { requestId: record.requestId, status: record.status };
    }
    requireInvariant(isRecord(record.correlation), 'turn_record_correlation_invalid');
    requireInvariant(
      typeof record.correlation.fatigueDecision === 'string',
      'turn_record_fatigue_decision_invalid',
    );
    requireInvariant(
      typeof record.correlation.rootInitiationId === 'string',
      'turn_record_root_initiation_invalid',
    );
    requireInvariant(
      record.correlation.fatigueReasonCode === undefined
        || typeof record.correlation.fatigueReasonCode === 'string',
      'turn_record_fatigue_reason_invalid',
    );
    return {
      requestId: record.requestId,
      status: record.status,
      correlation: {
        fatigueDecision: record.correlation.fatigueDecision,
        rootInitiationId: record.correlation.rootInitiationId,
        ...(typeof record.correlation.fatigueReasonCode === 'string'
          ? { fatigueReasonCode: record.correlation.fatigueReasonCode }
          : {}),
      },
    };
  });
  return { records };
}

function readFatigueSnapshot(
  companionDataDir: string,
  channelId: string = CERTIFICATION_PRIVATE_ROOM,
): FatigueSnapshot {
  const ledger = new FatigueLedger(resolveFatigueLedgerPath(companionDataDir));
  try {
    const data = ledger.getData({ channelId, limit: 2_000 });
    return {
      amount: data.aggregates.amount,
      eventCount: data.aggregates.eventCount,
      chargedEventCount: data.aggregates.byDecision
        .find(entry => entry.key === 'charged')?.eventCount ?? 0,
      overchargeEventCount: data.aggregates.byDecision
        .find(entry => entry.key === 'overcharge')?.eventCount ?? 0,
      hardState: data.events.at(0)?.event.hardState ?? null,
    };
  } finally {
    ledger.close();
  }
}

function readCompanionSocialCharge(companionDataDir: string): number {
  return readRunChargeRollingWindowFromLedger(
    resolveChargeLedgerPath(companionDataDir),
  ).spentByLane.companion_social ?? 0;
}

function fatigueDelta(before: FatigueSnapshot, after: FatigueSnapshot): FatigueSnapshot {
  return {
    amount: after.amount - before.amount,
    eventCount: after.eventCount - before.eventCount,
    chargedEventCount: after.chargedEventCount - before.chargedEventCount,
    overchargeEventCount: after.overchargeEventCount - before.overchargeEventCount,
    hardState: after.hardState,
  };
}

async function validateCollidingRoutes(
  harness: IcpCertificationProcessHarness,
): Promise<Record<string, unknown>> {
  const [agentA, agentB] = harness.agents;
  let responseCount = 0;
  let crossoverCount = 0;
  const receivedTurnCounts = { companionA: 0, companionB: 0 };

  for (let round = 1; round <= COLLISION_ROUNDS; round += 1) {
    const requestId = `runtime-collision-${String(round)}`;
    const channelA = `api:runtime-validation:a:${String(round)}`;
    const channelB = `telegram:runtime-validation:b:${String(round)}`;
    const [responseA, responseB] = await Promise.all([
      harness.gateway.requestAgentVoiceStream(createCollisionMessage({
        channelId: channelA,
        channelType: 'api',
        requestId,
        targetLabel: 'a',
      })),
      harness.gateway.requestAgentVoiceStream(createCollisionMessage({
        channelId: channelB,
        channelType: 'telegram',
        requestId,
        targetLabel: 'b',
      })),
    ]);
    requireInvariant(responseA.channelId === channelA, 'api_route_response_channel_mismatch');
    requireInvariant(responseB.channelId === channelB, 'telegram_route_response_channel_mismatch');
    responseCount += 2;

    const [aOwn, aPeer, bOwn, bPeer, aTurns, aPeerTurns, bTurns, bPeerTurns] =
      await Promise.all([
        readChannelSnapshot(agentA, channelA),
        readChannelSnapshot(agentA, channelB),
        readChannelSnapshot(agentB, channelB),
        readChannelSnapshot(agentB, channelA),
        readTurnRecords(agentA, channelA),
        readTurnRecords(agentA, channelB),
        readTurnRecords(agentB, channelB),
        readTurnRecords(agentB, channelA),
      ]);
    const aMatchingTurns = aTurns.records.filter(record => record.requestId === requestId);
    const bMatchingTurns = bTurns.records.filter(record => record.requestId === requestId);
    requireInvariant(aOwn.entries.length > 0, 'api_route_missing_companion_a_session');
    requireInvariant(bOwn.entries.length > 0, 'telegram_route_missing_companion_b_session');
    requireInvariant(aMatchingTurns.length === 1, 'api_route_request_id_not_unique');
    requireInvariant(bMatchingTurns.length === 1, 'telegram_route_request_id_not_unique');
    requireInvariant(aMatchingTurns[0]?.status === 'completed', 'api_route_turn_not_completed');
    requireInvariant(bMatchingTurns[0]?.status === 'completed', 'telegram_route_turn_not_completed');
    receivedTurnCounts.companionA += aMatchingTurns.length;
    receivedTurnCounts.companionB += bMatchingTurns.length;
    crossoverCount += aPeer.entries.length
      + aPeer.memories.length
      + aPeer.summaries.length
      + bPeer.entries.length
      + bPeer.memories.length
      + bPeer.summaries.length
      + aPeerTurns.records.length
      + bPeerTurns.records.length;
  }

  requireInvariant(crossoverCount === 0, 'colliding_request_crossover_detected');
  const fleet = harness.gateway.getFleetConnectionSnapshot();
  const crossoverAlarmCount = Object.values(fleet.recentViolationsByCompanionId)
    .reduce((sum, count) => sum + count, fleet.unattributedRecentViolationCount);
  requireInvariant(crossoverAlarmCount === 0, 'gateway_crossover_alarm_detected');

  return {
    roundCount: COLLISION_ROUNDS,
    collidingRequestIdCount: COLLISION_ROUNDS,
    dispatchedRequestCount: COLLISION_ROUNDS * 2,
    responseCount,
    routeDecisionCounts: {
      apiToCompanionA: COLLISION_ROUNDS,
      telegramToCompanionB: COLLISION_ROUNDS,
    },
    receivedTurnCounts,
    crossoverCount,
    crossoverAlarmCount,
    peerLeakCount: crossoverCount,
  };
}

async function validateCompanionRoom(
  harness: IcpCertificationProcessHarness,
  fixture: IcpCertificationFixture,
): Promise<Record<string, unknown>> {
  const [agentA, agentB] = harness.agents;
  await Promise.all([agentA.enterPrivateRoom(), agentB.enterPrivateRoom()]);
  await agentB.publishAvailability('open_to_chat');
  await waitForModelQuiescence(harness);

  const fatigueBefore = fixture.companions.map(companion => (
    readFatigueSnapshot(companion.companionDataDir)
  ));
  const chargeBefore = fixture.companions.map(companion => (
    readCompanionSocialCharge(companion.companionDataDir)
  ));
  const modelRequestsBefore = harness.modelRequestCount;

  const initiated = await agentA.runRoomWeightedThoughtScheduler();
  requireInvariant(initiated.status === 'consumed', 'companion_room_initiation_not_consumed');
  requireInvariant(
    initiated.deliveryDisposition === 'delivered',
    'companion_room_initiation_not_delivered',
  );
  const rootInitiationId = String(initiated.rootInitiationId ?? '');
  requireInvariant(rootInitiationId.length > 0, 'companion_room_root_initiation_missing');
  const modelRequestsAfter = await waitForModelQuiescence(harness);

  const fatigueAfter = fixture.companions.map(companion => (
    readFatigueSnapshot(companion.companionDataDir)
  ));
  const chargeAfter = fixture.companions.map(companion => (
    readCompanionSocialCharge(companion.companionDataDir)
  ));
  const fatigueDeltas = fatigueAfter.map((after, index) => (
    fatigueDelta(
      requireDefined(fatigueBefore[index], 'companion_room_fatigue_baseline_missing'),
      after,
    )
  ));
  const chargeDeltas = chargeAfter.map((after, index) => after - requireDefined(
    chargeBefore[index],
    'companion_room_charge_baseline_missing',
  ));
  for (const delta of fatigueDeltas) {
    requireInvariant(delta.amount > 0, 'companion_room_fatigue_ledger_did_not_charge');
    requireInvariant(delta.eventCount > 0, 'companion_room_fatigue_event_missing');
    requireInvariant(delta.hardState === 'exhausted', 'companion_room_ledger_not_exhausted');
    // This unidirectional room exchange (only companion A initiates) is the
    // suppression-with-zero-overcharge proof. The closeout overcharge reserve
    // fires only when an already-exhausted companion receives a turn carrying
    // continuation evidence (icp-fatigue-regulation.ts:158-165). Here the only
    // continuation-evidence dimension the room path can produce —
    // explicit_peer_invitation — lands on the recipient's FIRST (initiation)
    // turn, when it is not yet exhausted; every post-exhaustion turn is a
    // 'reply' stage carrying no evidence, so it suppresses. Overcharge is
    // therefore mechanically guaranteed to be zero, and we assert it so the
    // suppression path stays proven and cannot silently start reserving.
    // The reserve-fires proof lives in validateFatigueCloseoutReserve.
    requireInvariant(
      delta.overchargeEventCount === 0,
      'companion_room_overcharge_fired_without_continuation_evidence',
    );
  }
  for (const delta of chargeDeltas) {
    requireInvariant(delta > 0, 'companion_room_run_charge_missing');
  }

  const [turnsA, turnsB] = await Promise.all([
    readTurnRecords(agentA, CERTIFICATION_PRIVATE_ROOM),
    readTurnRecords(agentB, CERTIFICATION_PRIVATE_ROOM),
  ]);
  const rootTurnsA = turnsA.records.filter(record => (
    record.correlation?.rootInitiationId === rootInitiationId
  ));
  const rootTurnsB = turnsB.records.filter(record => (
    record.correlation?.rootInitiationId === rootInitiationId
  ));
  requireInvariant(rootTurnsA.length > 0, 'companion_room_missing_companion_a_turns');
  requireInvariant(rootTurnsB.length > 0, 'companion_room_missing_companion_b_turns');
  const suppressionCountA = rootTurnsA.filter(record => (
    record.correlation?.fatigueDecision === 'suppress'
  )).length;
  const suppressionCountB = rootTurnsB.filter(record => (
    record.correlation?.fatigueDecision === 'suppress'
  )).length;
  requireInvariant(
    suppressionCountA + suppressionCountB > 0,
    'companion_room_exchange_did_not_stop_by_suppression',
  );

  const fatigueDeltaA = requireDefined(
    fatigueDeltas[0],
    'companion_room_companion_a_fatigue_delta_missing',
  );
  const fatigueDeltaB = requireDefined(
    fatigueDeltas[1],
    'companion_room_companion_b_fatigue_delta_missing',
  );
  const chargeDeltaA = requireDefined(
    chargeDeltas[0],
    'companion_room_companion_a_charge_delta_missing',
  );
  const chargeDeltaB = requireDefined(
    chargeDeltas[1],
    'companion_room_companion_b_charge_delta_missing',
  );

  const fleet = harness.gateway.getFleetConnectionSnapshot();
  const crossoverAlarmCount = Object.values(fleet.recentViolationsByCompanionId)
    .reduce((sum, count) => sum + count, fleet.unattributedRecentViolationCount);
  requireInvariant(crossoverAlarmCount === 0, 'companion_room_crossover_alarm_detected');

  const [channelBeforeRestartA, channelBeforeRestartB] = await Promise.all([
    readChannelSnapshot(agentA, CERTIFICATION_PRIVATE_ROOM),
    readChannelSnapshot(agentB, CERTIFICATION_PRIVATE_ROOM),
  ]);
  const [restartedAgentA, restartedAgentB] = await harness.restartAgents();
  const [
    turnsAfterRestartA,
    turnsAfterRestartB,
    channelAfterRestartA,
    channelAfterRestartB,
  ] = await Promise.all([
    readTurnRecords(restartedAgentA, CERTIFICATION_PRIVATE_ROOM),
    readTurnRecords(restartedAgentB, CERTIFICATION_PRIVATE_ROOM),
    readChannelSnapshot(restartedAgentA, CERTIFICATION_PRIVATE_ROOM),
    readChannelSnapshot(restartedAgentB, CERTIFICATION_PRIVATE_ROOM),
  ]);
  const durableRootTurnsA = turnsAfterRestartA.records.filter(record => (
    record.correlation?.rootInitiationId === rootInitiationId
  ));
  const durableRootTurnsB = turnsAfterRestartB.records.filter(record => (
    record.correlation?.rootInitiationId === rootInitiationId
  ));
  requireInvariant(
    durableRootTurnsA.length === rootTurnsA.length,
    'companion_room_companion_a_turns_not_durable',
  );
  requireInvariant(
    durableRootTurnsB.length === rootTurnsB.length,
    'companion_room_companion_b_turns_not_durable',
  );
  requireInvariant(
    channelAfterRestartA.entries.length >= channelBeforeRestartA.entries.length,
    'companion_room_companion_a_channel_not_durable',
  );
  requireInvariant(
    channelAfterRestartB.entries.length >= channelBeforeRestartB.entries.length,
    'companion_room_companion_b_channel_not_durable',
  );
  const fatigueAfterRestart = fixture.companions.map(companion => (
    readFatigueSnapshot(companion.companionDataDir)
  ));
  requireInvariant(
    fatigueAfterRestart[0]?.amount === fatigueAfter[0]?.amount
      && fatigueAfterRestart[0]?.eventCount === fatigueAfter[0]?.eventCount,
    'companion_room_companion_a_fatigue_not_durable',
  );
  requireInvariant(
    fatigueAfterRestart[1]?.amount === fatigueAfter[1]?.amount
      && fatigueAfterRestart[1]?.eventCount === fatigueAfter[1]?.eventCount,
    'companion_room_companion_b_fatigue_not_durable',
  );

  return {
    channelClass: 'companion_room',
    initiationStatus: initiated.status,
    deliveryDisposition: initiated.deliveryDisposition,
    turnCountsByCompanion: {
      [CERTIFICATION_COMPANION_A]: rootTurnsA.length,
      [CERTIFICATION_COMPANION_B]: rootTurnsB.length,
    },
    fatigueLedgerDeltasByCompanion: {
      [CERTIFICATION_COMPANION_A]: fatigueDeltaA,
      [CERTIFICATION_COMPANION_B]: fatigueDeltaB,
    },
    companionSocialChargeDeltasByCompanion: {
      [CERTIFICATION_COMPANION_A]: chargeDeltaA,
      [CERTIFICATION_COMPANION_B]: chargeDeltaB,
    },
    suppressionCountsByCompanion: {
      [CERTIFICATION_COMPANION_A]: suppressionCountA,
      [CERTIFICATION_COMPANION_B]: suppressionCountB,
    },
    modelRequestDelta: modelRequestsAfter - modelRequestsBefore,
    stopReason: 'both_fatigue_ledgers_exhausted_and_model_suppressed',
    restartDurability: {
      agentRestartCount: 2,
      durableTurnCountsByCompanion: {
        [CERTIFICATION_COMPANION_A]: durableRootTurnsA.length,
        [CERTIFICATION_COMPANION_B]: durableRootTurnsB.length,
      },
      durableChannelEntryCountsByCompanion: {
        [CERTIFICATION_COMPANION_A]: channelAfterRestartA.entries.length,
        [CERTIFICATION_COMPANION_B]: channelAfterRestartB.entries.length,
      },
      fatigueLedgerPreserved: true,
    },
    crossoverAlarmCount,
  };
}

async function validateFlagOff(
  postgres: PostgresTestHarness,
): Promise<{ evidence: Record<string, unknown>; processIds: number[]; socketRemoved: boolean }> {
  const { databaseUrl } = await postgres.createDatabase();
  const fixture = createIcpCertificationFixture({
    databaseUrl,
    autonomyEnabled: false,
    topology: 'single_companion',
  });
  let harness: IcpSingleCompanionFeatureOffHarness | null = null;
  try {
    harness = await startIcpSingleCompanionFeatureOffHarness({ fixture });
    const ready = await harness.agent.ready();
    requireInvariant(ready.multiCompanion === false, 'flag_off_agent_resolved_multi_companion');
    requireInvariant(ready.runtimeClass === 'SubstrateAgent', 'flag_off_runtime_class_changed');
    let autonomyRejected = false;
    try {
      await harness.agent.runFreeTimeNotification();
    } catch (error) {
      autonomyRejected = /autonomy is disabled by scheduler\.json/iu.test(String(error));
    }
    requireInvariant(autonomyRejected, 'flag_off_autonomy_did_not_fail_closed');
    const snapshot = await readChannelSnapshot(harness.agent, CERTIFICATION_PRIVATE_ROOM);
    requireInvariant(snapshot.entries.length === 0, 'flag_off_companion_room_state_created');
    requireInvariant(snapshot.summaries.length === 0, 'flag_off_companion_room_summary_created');
    requireInvariant(harness.modelRequestCount === 0, 'flag_off_dispatched_model_request');
    const processIds = [harness.agent.processId];
    await harness.stop();
    harness = null;
    const running = await waitForProcessesToExit(processIds);
    requireInvariant(running.length === 0, 'flag_off_agent_process_remained');
    const socketRemoved = !existsSync(fixture.gatewaySocketPath);
    requireInvariant(socketRemoved, 'flag_off_gateway_socket_remained');
    return {
      evidence: {
        runtimeClass: ready.runtimeClass,
        multiCompanion: ready.multiCompanion,
        modelRequestCount: 0,
        companionRoomEntryCount: 0,
        behaviorUnchanged: true,
      },
      processIds,
      socketRemoved,
    };
  } finally {
    await harness?.stop().catch(() => harness?.agent.forceStop());
    fixture.cleanup();
  }
}

/**
 * Executable proof that the ICP closeout overcharge RESERVE actually fires.
 *
 * The suppression path (validateCompanionRoom) proves that a companion which
 * exhausts on a turn carrying no continuation evidence stops by suppression
 * with zero overcharge. This scenario proves the complementary behavior: when
 * an already-exhausted companion takes a turn that DOES carry genuine
 * continuation evidence, the bounded overcharge reserve is spent
 * (icp-fatigue-regulation.ts:158-165) instead of suppressing.
 *
 * It drives the production companion-to-companion weighted-thought (DM)
 * exchange under the `final_reserve` fatigue profile (softLimit=hardLimit=1,
 * overcharge.enabled, reserveResponses=1). Companion A initiates a real
 * conversation; the exchange charges to hard exhaustion and takes the bounded
 * closeout reserve on a turn that still carries continuation evidence. Proof is
 * read from the authoritative shared reservation store
 * (`shared.icp_fatigue_turn_reservations`): a finalized decision='overcharge'
 * row exists ONLY when reserve('overcharge') was taken via the
 * continuationEvidence-gated branch at icp-fatigue-regulation.ts:163. No
 * regulation code is stubbed or monkey-patched; the reserve is exercised
 * through the real reservation store and turn pipeline. This mirrors the
 * committed process-harness.integration.test.ts closeout assertion and is what
 * earns the `icp_fatigue_closeout_reserve` coverage id.
 */
async function validateFatigueCloseoutReserve(
  postgres: PostgresTestHarness,
): Promise<{ evidence: Record<string, unknown>; processIds: number[]; socketRemoved: boolean }> {
  const { databaseUrl } = await postgres.createDatabase();
  const fixture = createIcpCertificationFixture({ databaseUrl, fatigueProfile: 'final_reserve' });
  let harness: IcpCertificationProcessHarness | null = null;
  try {
    harness = await startIcpCertificationProcessHarness({ databaseUrl, fixture });
    const [agentA, agentB] = harness.agents;
    const ready = await Promise.all(harness.agents.map(agent => agent.ready()));
    requireInvariant(
      ready.every(entry => entry.runtimeClass === 'SubstrateAgent'),
      'closeout_reserve_runtime_not_real',
    );
    requireInvariant(
      ready.every(entry => entry.multiCompanion === true),
      'closeout_reserve_topology_not_multi',
    );

    await agentB.publishAvailability('open_to_chat');
    await waitForModelQuiescence(harness);

    // Replicate the committed integration-test closeout flow. The deferred and
    // declined weighted-thought attempts and the compaction markers establish
    // the conversation/session state under which the subsequent consumed
    // conversation charges to hard exhaustion and then takes the bounded
    // closeout overcharge reserve on a continuation-evidence-bearing turn
    // (icp-fatigue-regulation.ts:158-165). We do not assert WHICH turn reaches
    // the reserve — the finalized decision='overcharge' reservation row read
    // below is itself the executable proof, because the shared store writes that
    // row only via the continuationEvidence-gated reserve('overcharge') branch
    // at icp-fatigue-regulation.ts:163. A single-sided attempt without this flow
    // only ever suppresses (proven by validateCompanionRoom), so the reserve is
    // genuinely exercised here rather than assumed.
    harness.queueConsentDecision('defer');
    const deferred = await agentA.runWeightedThoughtScheduler();
    requireInvariant(deferred.status === 'deferred', 'closeout_reserve_defer_not_deferred');
    harness.queueConsentDecision('decline');
    const declined = await agentA.runWeightedThoughtScheduler();
    requireInvariant(declined.status === 'declined', 'closeout_reserve_decline_not_declined');
    await Promise.all([
      agentA.appendCompactionMarker(CERTIFICATION_DM_CHANNEL),
      agentB.appendCompactionMarker(CERTIFICATION_DM_CHANNEL),
    ]);

    const initiated = await agentA.runWeightedThoughtScheduler();
    requireInvariant(initiated.status === 'consumed', 'closeout_reserve_initiation_not_consumed');
    requireInvariant(
      initiated.deliveryDisposition === 'delivered',
      'closeout_reserve_initiation_not_delivered',
    );
    const rootInitiationId = String(initiated.rootInitiationId ?? '');
    requireInvariant(rootInitiationId.length > 0, 'closeout_reserve_root_initiation_missing');

    // Let the conversation play fully out to its fatigue stop before reading the
    // reservation store, so the overcharge reserve has actually been finalized.
    const suppressionDeadline = Date.now() + QUIESCENCE_TIMEOUT_MS;
    let conversationSuppressed = false;
    while (Date.now() < suppressionDeadline && !conversationSuppressed) {
      for (const agent of harness.agents) {
        if (await agent.hasCompletedFatigueSuppression(
          CERTIFICATION_DM_CHANNEL,
          rootInitiationId,
        )) {
          conversationSuppressed = true;
          break;
        }
      }
      if (!conversationSuppressed) {
        await new Promise(resolveWait => setTimeout(resolveWait, 25));
      }
    }
    requireInvariant(conversationSuppressed, 'closeout_reserve_conversation_did_not_suppress');
    await waitForModelQuiescence(harness);

    // The authoritative, channel-agnostic proof: the shared reservation store
    // only ever holds a decision='overcharge' row when reserve('overcharge') was
    // taken at icp-fatigue-regulation.ts:163, which is reachable ONLY through the
    // exhausted-charged branch gated on continuationEvidence.length > 0. A
    // finalized ('delivered'/'no_reply') overcharge reservation is therefore
    // executable proof that the closeout reserve fired under continuation
    // evidence — distinct from the room suppression scenario, which provably
    // records zero overcharge.
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'multi-companion-runtime-closeout-reserve',
      max: 1,
    });
    let overchargeReservationCount = 0;
    let chargedReservationCount = 0;
    try {
      const reservations = await pool.query<{ decision: string; reservation_count: string }>(`
        SELECT decision, COUNT(*)::text AS reservation_count
        FROM shared.icp_fatigue_turn_reservations
        WHERE outcome IN ('delivered', 'no_reply')
        GROUP BY decision
      `);
      for (const row of reservations.rows) {
        if (row.decision === 'overcharge') overchargeReservationCount = Number(row.reservation_count);
        if (row.decision === 'charged') chargedReservationCount = Number(row.reservation_count);
      }
    } finally {
      await pool.end();
    }
    requireInvariant(chargedReservationCount > 0, 'closeout_reserve_no_normal_charge');
    requireInvariant(overchargeReservationCount > 0, 'closeout_reserve_did_not_fire');

    const processIds = harness.agents.map(agent => agent.processId);
    await harness.stop();
    harness = null;
    const running = await waitForProcessesToExit(processIds);
    requireInvariant(running.length === 0, 'closeout_reserve_agent_process_remained');
    const socketRemoved = !existsSync(fixture.gatewaySocketPath);
    requireInvariant(socketRemoved, 'closeout_reserve_gateway_socket_remained');

    return {
      evidence: {
        channel: 'companion_dm_weighted_thought',
        fatigueProfile: 'final_reserve',
        rootInitiationId,
        chargedReservationCount,
        overchargeReservationCount,
        overchargeReserveFired: true,
        reservationOutcomeFilter: ['delivered', 'no_reply'],
      },
      processIds,
      socketRemoved,
    };
  } finally {
    await harness?.stop().catch(() => {
      for (const agent of harness?.agents ?? []) agent.forceStop();
    });
    fixture.cleanup();
  }
}

async function main(): Promise<Record<string, unknown>> {
  const startedAtMs = Date.now();
  const revision = currentRevision();
  const postgres = await startPostgresTestHarness({ image: PGVECTOR_POSTGRES_TEST_IMAGE });
  let fixture: IcpCertificationFixture | null = null;
  let harness: IcpCertificationProcessHarness | null = null;
  let postgresStopped = false;
  try {
    const { databaseUrl } = await postgres.createDatabase();
    fixture = createIcpCertificationFixture({ databaseUrl, fatigueProfile: 'final_reserve' });
    harness = await startIcpCertificationProcessHarness({
      databaseUrl,
      fixture,
      channelRouting: {
        api: CERTIFICATION_COMPANION_A as CompanionId,
        telegram: CERTIFICATION_COMPANION_B as CompanionId,
      },
    });
    const ready = await Promise.all(harness.agents.map(agent => agent.ready()));
    requireInvariant(ready.every(entry => entry.runtimeClass === 'SubstrateAgent'), 'agent_runtime_not_real');
    requireInvariant(ready.every(entry => entry.multiCompanion === true), 'agent_topology_not_multi');
    const fleet = harness.gateway.getFleetConnectionSnapshot();
    requireInvariant(fleet.connections.length === 2, 'gateway_did_not_identify_two_agents');

    const collision = await validateCollidingRoutes(harness);
    await waitForModelQuiescence(harness);
    const room = await validateCompanionRoom(harness, fixture);
    const multiProcessIds = harness.agents.map(agent => agent.processId);
    const gatewaySocketIdentity = pathIdentity(fixture.gatewaySocketPath);
    const postgresPort = Number(new URL(postgres.adminDatabaseUrl).port);
    const companionDataRootIdentities = Object.fromEntries(
      fixture.companions.map(companion => [
        companion.companionId,
        pathIdentity(companion.companionDataDir),
      ]),
    );
    const supportFixturePaths = [
      fixture.companions[1].companionDataDir,
      fixture.companions[1].workspacePath,
      join(fixture.runtimeRoot, 'support-companions', 'lumen', 'data'),
      join(
        fixture.runtimeRoot,
        'workspaces',
        'personal',
        'c7100000-0000-4000-8000-000000000003',
      ),
    ];

    await harness.stop();
    harness = null;
    const runningMultiProcesses = await waitForProcessesToExit(multiProcessIds);
    requireInvariant(runningMultiProcesses.length === 0, 'multi_agent_process_remained');
    const multiSocketRemoved = !existsSync(fixture.gatewaySocketPath);
    requireInvariant(multiSocketRemoved, 'multi_gateway_socket_remained');
    fixture.cleanup();
    const supportFixtureResidueCount = supportFixturePaths.filter(existsSync).length;
    requireInvariant(
      supportFixtureResidueCount === 0,
      'canonical_support_fixture_residue_remained',
    );
    fixture = null;

    const closeoutReserve = await validateFatigueCloseoutReserve(postgres);
    const flagOff = await validateFlagOff(postgres);
    await postgres.stop();
    postgresStopped = true;

    return {
      schemaVersion: 1,
      event: 'multi_companion_runtime_validation',
      status: 'passed',
      revision,
      coverageCaseIds: MULTI_COMPANION_COVERAGE_CASE_IDS,
      topology: {
        fixtureContract: 'shakedown/support/companions.template.json',
        gatewayCount: 1,
        gatewayProcessId: process.pid,
        gatewayTransport: 'unix',
        gatewaySocketIdentity,
        agentProcessCount: 2,
        agentProcessIds: multiProcessIds,
        distinctCompanionIdCount: 2,
        companionIds: [CERTIFICATION_COMPANION_A, CERTIFICATION_COMPANION_B],
        postgresPort,
        postgresSchemaCount: 2,
        postgresSchemas: [CERTIFICATION_SCHEMA_A, CERTIFICATION_SCHEMA_B],
        distinctCompanionDataRootCount: 2,
        companionDataRootIdentities,
        configuredRouteCount: 2,
      },
      collision,
      room,
      fatigueCloseoutReserve: closeoutReserve.evidence,
      flagOff: flagOff.evidence,
      fixBeadIds: [
        'psfn-framework-1nsp',
        'psfn-framework-4i1c',
        'psfn-framework-573l',
      ],
      teardown: {
        multiAgentProcessesRemaining: 0,
        closeoutReserveAgentProcessesRemaining: 0,
        singleAgentProcessesRemaining: 0,
        multiGatewaySocketRemoved: multiSocketRemoved,
        closeoutReserveGatewaySocketRemoved: closeoutReserve.socketRemoved,
        singleGatewaySocketRemoved: flagOff.socketRemoved,
        postgresStopped,
        supportFixtureResidueCount,
        result: 'clean',
      },
      durationMs: Date.now() - startedAtMs,
    };
  } finally {
    await harness?.stop().catch(() => {
      for (const agent of harness?.agents ?? []) agent.forceStop();
    });
    fixture?.cleanup();
    if (!postgresStopped) await postgres.stop().catch(() => undefined);
  }
}

void main().then((evidence) => {
  process.stdout.write(`${JSON.stringify(evidence)}\n`, (error) => {
    process.exit(error ? 1 : 0);
  });
}).catch((error: unknown) => {
  const code = error instanceof ValidationFailure
    ? error.code
    : 'unexpected_runtime_error';
  process.stderr.write(`${JSON.stringify({
    schemaVersion: 1,
    event: 'multi_companion_runtime_validation',
    status: 'failed',
    revision: currentRevision(),
    errorCode: code,
    teardown: 'attempted',
  })}\n`, () => process.exit(1));
});
