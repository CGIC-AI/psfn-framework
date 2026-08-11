import { describe, expect, it, vi } from 'vitest';

import type { FatigueRoomEpisodePressureConfig } from '../../../shared/contracts/charge-policy.js';
import type {
  FatigueBudgetDecision,
  FatigueBudgetEvent,
  FatigueTriggeringAuthorRole,
} from '../../../shared/contracts/runtime.js';
import type { FatigueBudgetEventQuery, FatigueBudgetHistoryPort } from './fatigue-budget.js';
import {
  assertRoomEpisodePressureConfig,
  assessRoomEpisodePressure,
  computeRoomEpisodePressure,
  readRoomEpisodePressureFromLedger,
  resolveRoomEpisodePressureState,
  type RoomEpisodeContribution,
} from './room-episode-pressure.js';

const NOW = Date.UTC(2027, 0, 15, 12, 0, 0);
const HOUR = 60 * 60_000;

const CONFIG: FatigueRoomEpisodePressureConfig = {
  halfLifeMs: HOUR,
  windowMs: 2 * HOUR,
  replyPressureUnits: 1,
  reactionPressureUnits: 0.1,
  elevatedThreshold: 3,
  wrapUpThreshold: 6,
  maxLeaseThresholdBias: 0.3,
};

function reply(
  timestampMs: number,
  triggerRole: FatigueTriggeringAuthorRole = 'machine_intelligence',
): RoomEpisodeContribution {
  return { timestampMs, triggerRole, kind: 'reply' };
}

function reaction(
  timestampMs: number,
  triggerRole: FatigueTriggeringAuthorRole = 'machine_intelligence',
): RoomEpisodeContribution {
  return { timestampMs, triggerRole, kind: 'reaction' };
}

describe('room-episode pressure accrual', () => {
  it('accrues one unit of pressure per fresh machine reply', () => {
    const result = computeRoomEpisodePressure({
      contributions: [reply(NOW), reply(NOW), reply(NOW)],
      config: CONFIG,
      nowMs: NOW,
    });
    expect(result.pressure).toBeCloseTo(3, 10);
    expect(result.contributingEventCount).toBe(3);
  });

  it('decays contributions by the configured half-life', () => {
    const result = computeRoomEpisodePressure({
      contributions: [reply(NOW - HOUR)],
      config: CONFIG,
      nowMs: NOW,
    });
    // One half-life old => half a unit.
    expect(result.pressure).toBeCloseTo(0.5, 10);
  });

  it('weights reactions near-zero relative to replies', () => {
    const withReply = computeRoomEpisodePressure({
      contributions: [reply(NOW)],
      config: CONFIG,
      nowMs: NOW,
    });
    const withReaction = computeRoomEpisodePressure({
      contributions: [reaction(NOW)],
      config: CONFIG,
      nowMs: NOW,
    });
    expect(withReaction.pressure).toBeCloseTo(0.1, 10);
    expect(withReaction.pressure).toBeLessThan(withReply.pressure);
  });

  it('never charges human, system, or unknown triggers', () => {
    for (const role of ['human', 'system', 'unknown'] as const) {
      const result = computeRoomEpisodePressure({
        contributions: [reply(NOW, role), reaction(NOW, role)],
        config: CONFIG,
        nowMs: NOW,
      });
      expect(result.pressure).toBe(0);
      expect(result.contributingEventCount).toBe(0);
    }
  });

  it('excludes contributions older than the bounded window', () => {
    const result = computeRoomEpisodePressure({
      contributions: [reply(NOW - 3 * HOUR), reply(NOW)],
      config: CONFIG,
      nowMs: NOW,
    });
    expect(result.contributingEventCount).toBe(1);
    expect(result.pressure).toBeCloseTo(1, 10);
  });
});

describe('room-episode pressure ladder', () => {
  const state = (pressure: number) => resolveRoomEpisodePressureState({ pressure, config: CONFIG });

  it('stays calm below the elevated threshold with no lease bias', () => {
    expect(state(2)).toEqual({ level: 'calm', wrapUpInvited: false, leaseThresholdBias: 0 });
  });

  it('raises the lease bar progressively while elevated', () => {
    expect(state(3)).toMatchObject({ level: 'elevated', wrapUpInvited: false, leaseThresholdBias: 0 });
    expect(state(4.5).leaseThresholdBias).toBeCloseTo(0.15, 10);
    expect(state(4.5).level).toBe('elevated');
  });

  it('invites wrap-up at and above the wrap-up threshold and clamps the bias', () => {
    expect(state(6)).toEqual({
      level: 'wrap_up_invited',
      wrapUpInvited: true,
      leaseThresholdBias: 0.3,
    });
    expect(state(9)).toEqual({
      level: 'wrap_up_invited',
      wrapUpInvited: true,
      leaseThresholdBias: 0.3,
    });
  });

  it('increases the lease bias monotonically with pressure', () => {
    const biases = [0, 2, 3, 4, 5, 6, 7].map(p => state(p).leaseThresholdBias);
    for (let i = 1; i < biases.length; i += 1) {
      expect(biases[i]).toBeGreaterThanOrEqual(biases[i - 1]!);
    }
  });
});

describe('room-episode pressure config guard', () => {
  it('rejects reactions weighing more than replies', () => {
    expect(() => assertRoomEpisodePressureConfig({ ...CONFIG, reactionPressureUnits: 2 }))
      .toThrow(/reactionPressureUnits/);
  });

  it('rejects a wrap-up threshold at or below the elevated threshold', () => {
    expect(() => assertRoomEpisodePressureConfig({ ...CONFIG, wrapUpThreshold: 3 }))
      .toThrow(/wrapUpThreshold/);
  });

  it('rejects a window shorter than the half-life', () => {
    expect(() => assertRoomEpisodePressureConfig({ ...CONFIG, windowMs: HOUR - 1 }))
      .toThrow(/windowMs/);
  });
});

// --- ledger-derived per-channel accounting ---------------------------------

interface StubEventInput {
  timestampMs: number;
  localCompanionId: string;
  channelId: string;
  peerContactId: string;
  decision: FatigueBudgetDecision;
  role: FatigueTriggeringAuthorRole;
}

function makeEvent(input: StubEventInput): FatigueBudgetEvent {
  return {
    timestampMs: input.timestampMs,
    dayKey: new Date(input.timestampMs).toISOString().slice(0, 10),
    localCompanionId: input.localCompanionId,
    peerContactId: input.peerContactId,
    channelId: input.channelId,
    triggeringAuthor: { role: input.role },
    peer: { contactId: input.peerContactId },
    amount: input.decision === 'free' ? 0 : 1,
    decision: input.decision,
    reason: input.decision === 'free'
      ? 'triggering_author_not_machine_intelligence'
      : 'machine_intelligence_response',
    spentAfter: 1,
    remainingAllowance: 1,
    allowance: 3,
    softLimit: 2,
    softState: 'clear',
    hardState: 'available',
  };
}

function makeStubHistory(events: FatigueBudgetEvent[]): {
  history: Pick<FatigueBudgetHistoryPort, 'listFatigueEvents'>;
  listSpy: ReturnType<typeof vi.fn>;
} {
  const listSpy = vi.fn((query: FatigueBudgetEventQuery = {}): FatigueBudgetEvent[] =>
    events.filter(event => {
      if (query.localCompanionId && event.localCompanionId !== query.localCompanionId) return false;
      if (query.channelId && event.channelId !== query.channelId) return false;
      if (query.peerContactId && event.peerContactId !== query.peerContactId) return false;
      if (query.sinceMs !== undefined && event.timestampMs < query.sinceMs) return false;
      if (query.untilMs !== undefined && event.timestampMs > query.untilMs) return false;
      return true;
    }));
  return { history: { listFatigueEvents: listSpy }, listSpy };
}

describe('room-episode pressure from the fatigue ledger', () => {
  it('raises shared per-channel pressure across a round-robin below dyadic limits', () => {
    // Three companions round-robin in one room: each dyad has a single charged
    // turn (well below any dyadic cap) but the room aggregate is three.
    const { history } = makeStubHistory([
      makeEvent({ timestampMs: NOW, localCompanionId: 'local', channelId: 'roomA', peerContactId: 'fixture-companion', decision: 'charged', role: 'machine_intelligence' }),
      makeEvent({ timestampMs: NOW, localCompanionId: 'local', channelId: 'roomA', peerContactId: 'boreas', decision: 'charged', role: 'machine_intelligence' }),
      makeEvent({ timestampMs: NOW, localCompanionId: 'local', channelId: 'roomA', peerContactId: 'calliope', decision: 'overcharge', role: 'machine_intelligence' }),
    ]);
    const assessment = readRoomEpisodePressureFromLedger(history, {
      localCompanionId: 'local',
      channelId: 'roomA',
      nowMs: NOW,
      config: CONFIG,
    });
    expect(assessment.contributingEventCount).toBe(3);
    expect(assessment.pressure).toBeCloseTo(3, 10);
    expect(assessment.level).toBe('elevated');
  });

  it('invites wrap-up once sustained round-robin traffic crosses the threshold', () => {
    const events: FatigueBudgetEvent[] = [];
    for (let i = 0; i < 7; i += 1) {
      events.push(makeEvent({
        timestampMs: NOW - i * 60_000,
        localCompanionId: 'local',
        channelId: 'roomA',
        peerContactId: i % 2 === 0 ? 'fixture-companion' : 'boreas',
        decision: 'charged',
        role: 'machine_intelligence',
      }));
    }
    const { history } = makeStubHistory(events);
    const assessment = readRoomEpisodePressureFromLedger(history, {
      localCompanionId: 'local',
      channelId: 'roomA',
      nowMs: NOW,
      config: CONFIG,
    });
    expect(assessment.wrapUpInvited).toBe(true);
    expect(assessment.level).toBe('wrap_up_invited');
    expect(assessment.leaseThresholdBias).toBeCloseTo(0.3, 10);
  });

  it('keeps two rooms independent', () => {
    const { history } = makeStubHistory([
      makeEvent({ timestampMs: NOW, localCompanionId: 'local', channelId: 'roomA', peerContactId: 'fixture-companion', decision: 'charged', role: 'machine_intelligence' }),
      makeEvent({ timestampMs: NOW, localCompanionId: 'local', channelId: 'roomA', peerContactId: 'boreas', decision: 'charged', role: 'machine_intelligence' }),
      makeEvent({ timestampMs: NOW, localCompanionId: 'local', channelId: 'roomB', peerContactId: 'fixture-companion', decision: 'charged', role: 'machine_intelligence' }),
    ]);
    const roomA = readRoomEpisodePressureFromLedger(history, {
      localCompanionId: 'local', channelId: 'roomA', nowMs: NOW, config: CONFIG,
    });
    const roomB = readRoomEpisodePressureFromLedger(history, {
      localCompanionId: 'local', channelId: 'roomB', nowMs: NOW, config: CONFIG,
    });
    expect(roomA.contributingEventCount).toBe(2);
    expect(roomA.pressure).toBeCloseTo(2, 10);
    expect(roomB.contributingEventCount).toBe(1);
    expect(roomB.pressure).toBeCloseTo(1, 10);
  });

  it('never counts human-authored (free) turns, preserving the human-uncharged invariant', () => {
    const { history } = makeStubHistory([
      makeEvent({ timestampMs: NOW, localCompanionId: 'local', channelId: 'roomA', peerContactId: 'fixture-companion', decision: 'free', role: 'human' }),
      makeEvent({ timestampMs: NOW, localCompanionId: 'local', channelId: 'roomA', peerContactId: 'boreas', decision: 'free', role: 'human' }),
    ]);
    const assessment = readRoomEpisodePressureFromLedger(history, {
      localCompanionId: 'local', channelId: 'roomA', nowMs: NOW, config: CONFIG,
    });
    expect(assessment.pressure).toBe(0);
    expect(assessment.contributingEventCount).toBe(0);
    expect(assessment.level).toBe('calm');
  });

  it('merges observed reactions at near-zero pressure without touching the pot', () => {
    const { history, listSpy } = makeStubHistory([
      makeEvent({ timestampMs: NOW, localCompanionId: 'local', channelId: 'roomA', peerContactId: 'fixture-companion', decision: 'charged', role: 'machine_intelligence' }),
    ]);
    const assessment = readRoomEpisodePressureFromLedger(history, {
      localCompanionId: 'local',
      channelId: 'roomA',
      nowMs: NOW,
      config: CONFIG,
      additionalContributions: [reaction(NOW), reaction(NOW)],
    });
    // one reply (1) + two reactions (0.1 each) = 1.2
    expect(assessment.pressure).toBeCloseTo(1.2, 10);
    expect(assessment.contributingEventCount).toBe(3);
    // Pacing is non-monetary: only the ledger history is consulted, never a pot.
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it('reads the bounded window from now, not a calendar day', () => {
    const { history, listSpy } = makeStubHistory([]);
    readRoomEpisodePressureFromLedger(history, {
      localCompanionId: 'local', channelId: 'roomA', nowMs: NOW, config: CONFIG,
    });
    expect(listSpy).toHaveBeenCalledWith({
      localCompanionId: 'local',
      channelId: 'roomA',
      sinceMs: NOW - CONFIG.windowMs,
      untilMs: NOW,
    });
  });
});

describe('assessRoomEpisodePressure', () => {
  it('requires a channel id', () => {
    expect(() => assessRoomEpisodePressure({
      channelId: '  ',
      contributions: [],
      config: CONFIG,
      nowMs: NOW,
    })).toThrow(/channelId/);
  });
});
