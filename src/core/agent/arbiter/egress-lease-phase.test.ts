import { describe, expect, it, vi } from 'vitest';

import {
  SpeakingEgressLeasePhase,
  selectSpeakLeastWinner,
  type EgressLeasePhaseConfig,
  type EgressReplySender,
  type EgressReplyTrigger,
  type RoomEpisodePressureAssessmentResolver,
} from './egress-lease-phase.js';
import type {
  RoomEpisodeBreakerState,
  RoomEpisodeParticipant,
  RoomEpisodeSnapshot,
  SpeakingEgressLeaseSnapshot,
  SpeakingReservationSnapshot,
} from './speaking-arbiter-store-port.js';
import type { RoomEpisodePressureAssessment } from '../fatigue/room-episode-pressure.js';
import type { ParticipationAppraisal } from '../../participation/types.js';

const COMPANION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHANNEL = 'discord:guild-1:general';
const TRIGGER = 'evt-42';
const RESERVATION_ID = '99999999-9999-4999-8999-999999999999';
const LEASE_ID = '11111111-1111-4111-8111-111111111111';

function makeConfig(overrides: Partial<EgressLeasePhaseConfig> = {}): EgressLeasePhaseConfig {
  return {
    leaseTtlMs: 60_000,
    egressDrawUnits: 1,
    minReplyConfidence: 0.5,
    socialPot: {
      capUnits: 240,
      perChannelDrawFraction: 0.34,
      regenerationTickMs: 3_600_000,
      regenerationUnitsPerTick: 10,
    },
    roomEpisodeCircuitBreaker: { tripThreshold: 100, resetThreshold: 40 },
    wrapUpThreshold: 60,
    replyPressureUnits: 3,
    ...overrides,
  };
}

function makeReservation(overrides: Partial<SpeakingReservationSnapshot> = {}): SpeakingReservationSnapshot {
  return {
    reservationId: RESERVATION_ID,
    channelId: CHANNEL,
    triggerEventId: TRIGGER,
    companionId: COMPANION_A,
    episodeId: 'episode-1',
    reservedAtMs: 5_000,
    expiresAtMs: 125_000,
    status: 'reserved',
    reason: null,
    finalizedAtMs: null,
    revision: 1,
    ...overrides,
  };
}

function makeLease(overrides: Partial<SpeakingEgressLeaseSnapshot> = {}): SpeakingEgressLeaseSnapshot {
  return {
    leaseId: LEASE_ID,
    reservationId: RESERVATION_ID,
    channelId: CHANNEL,
    triggerEventId: TRIGGER,
    companionId: COMPANION_A,
    episodeId: 'episode-1',
    fencingToken: 1,
    acquiredAtMs: 10_000,
    expiresAtMs: 70_000,
    status: 'held',
    reason: null,
    finalizedAtMs: null,
    revision: 1,
    ...overrides,
  };
}

function makeEpisode(participants: RoomEpisodeParticipant[] = []): RoomEpisodeSnapshot {
  return {
    episodeId: 'episode-1',
    channelId: CHANNEL,
    status: 'open',
    pressure: 0,
    openedAtMs: 1_000,
    lastActivityAtMs: 1_000,
    consecutiveAutonomousTurns: 0,
    lastSpeakerCompanionId: null,
    revision: 1,
    participants,
  };
}

function makeAssessment(pressure: number, leaseThresholdBias = 0): RoomEpisodePressureAssessment {
  return {
    channelId: CHANNEL,
    pressure,
    contributingEventCount: 0,
    windowStartMs: 0,
    evaluatedAtMs: 10_000,
    level: 'calm',
    wrapUpInvited: false,
    leaseThresholdBias,
  };
}

const REPLY: Extract<ParticipationAppraisal, { action: 'reply' }> = {
  action: 'reply',
  reasonCode: 'addressed',
  confidence: 0.9,
};

const TRIGGER_CTX: EgressReplyTrigger = {
  channelId: CHANNEL,
  channelType: 'discord',
  sourceMessageId: TRIGGER,
  authorId: 'human-1',
  authorName: 'Sam',
  content: 'hey companion, thoughts?',
  timestampMs: 4_000,
};

interface FakeStoreOptions {
  breakerState?: RoomEpisodeBreakerState;
  reservers?: string[];
  participants?: RoomEpisodeParticipant[];
  acquire?: 'acquired' | 'declined_held' | 'declined_delivered';
  acquireThrows?: boolean;
  completeThrows?: boolean;
  readBreakerThrows?: boolean;
  listReserversThrows?: boolean;
}

function makeFakeStore(options: FakeStoreOptions = {}) {
  const acquireResult = (() => {
    switch (options.acquire ?? 'acquired') {
      case 'declined_held':
        return {
          outcome: 'declined' as const,
          lease: null,
          heldBy: { companionId: COMPANION_B, leaseId: 'x', fencingToken: 1 },
          declineReason: 'held' as const,
        };
      case 'declined_delivered':
        return {
          outcome: 'declined' as const,
          lease: null,
          heldBy: { companionId: COMPANION_B, leaseId: 'x', fencingToken: 1 },
          declineReason: 'already_delivered' as const,
        };
      default:
        return { outcome: 'acquired' as const, lease: makeLease(), heldBy: null };
    }
  })();

  const store = {
    readRoomEpisodeBreakerState: vi.fn(async () => {
      if (options.readBreakerThrows) throw new Error('breaker read failed');
      return options.breakerState ?? 'closed';
    }),
    persistRoomEpisodeBreakerState: vi.fn(async () => undefined),
    listActiveReservers: vi.fn(async () => {
      if (options.listReserversThrows) throw new Error('list reservers failed');
      return options.reservers ?? [COMPANION_A];
    }),
    readRoomEpisode: vi.fn(async () => makeEpisode(options.participants ?? [])),
    acquireEgressLease: vi.fn(async () => {
      if (options.acquireThrows) throw new Error('reservation not reservable');
      return acquireResult;
    }),
    completeEgressLease: vi.fn(async () => {
      if (options.completeThrows) throw new Error('completion conflict');
      return makeLease({ status: 'delivered', reason: 'delivered' });
    }),
    releaseReservation: vi.fn(async () => makeReservation({ status: 'released', reason: 'silence' })),
  };
  return store;
}

function makePot(outcome: 'drawn' | 'capped' | 'insufficient' = 'drawn') {
  return {
    draw: vi.fn(async () => ({
      outcome,
      drawn: outcome === 'drawn' ? 1 : 0,
      before: { companionId: COMPANION_A, balance: 10, cap: 240, lastRegenAtMs: 0, revision: 1 },
      after: {
        companionId: COMPANION_A,
        balance: outcome === 'drawn' ? 9 : 10,
        cap: 240,
        lastRegenAtMs: 0,
        revision: 2,
      },
    })),
  };
}

function makePressure(assessment: RoomEpisodePressureAssessment): RoomEpisodePressureAssessmentResolver {
  return { resolve: () => assessment };
}

function makeSender(result: 'delivered' | 'failed' | 'throw' = 'delivered'): EgressReplySender & {
  deliver: ReturnType<typeof vi.fn>;
} {
  return {
    deliver: vi.fn(async () => {
      if (result === 'throw') throw new Error('send exploded');
      return { outcome: result };
    }),
  };
}

function makePhase(deps: {
  store: ReturnType<typeof makeFakeStore>;
  pot?: ReturnType<typeof makePot>;
  pressure?: RoomEpisodePressureAssessmentResolver;
  sender?: ReturnType<typeof makeSender>;
  config?: EgressLeasePhaseConfig;
  companionId?: string;
}): SpeakingEgressLeasePhase {
  return new SpeakingEgressLeasePhase({
    store: deps.store,
    socialPot: deps.pot ?? makePot('drawn'),
    roomPressure: deps.pressure ?? makePressure(makeAssessment(0)),
    sender: deps.sender ?? makeSender('delivered'),
    companionId: deps.companionId ?? COMPANION_A,
    config: deps.config ?? makeConfig(),
    generateLeaseId: () => LEASE_ID,
  });
}

describe('selectSpeakLeastWinner (deterministic fairness)', () => {
  it('ranks a never-spoken contender ahead of anyone who has spoken', () => {
    const participants: RoomEpisodeParticipant[] = [
      { companionId: COMPANION_A, speakCount: 3, lastSpokeAtMs: 5_000 },
    ];
    expect(selectSpeakLeastWinner(participants, [COMPANION_A, COMPANION_B])).toBe(COMPANION_B);
  });

  it('is deterministic under ties (stable companionId tie-break)', () => {
    // Both never spoke → identical rank → the lexicographically-first id wins,
    // and the order of the contender list never changes the result.
    expect(selectSpeakLeastWinner([], [COMPANION_B, COMPANION_A])).toBe(COMPANION_A);
    expect(selectSpeakLeastWinner([], [COMPANION_A, COMPANION_B])).toBe(COMPANION_A);
  });

  it('breaks a lastSpokeAt tie by lower speak count', () => {
    const participants: RoomEpisodeParticipant[] = [
      { companionId: COMPANION_A, speakCount: 5, lastSpokeAtMs: 5_000 },
      { companionId: COMPANION_B, speakCount: 2, lastSpokeAtMs: 5_000 },
    ];
    expect(selectSpeakLeastWinner(participants, [COMPANION_A, COMPANION_B])).toBe(COMPANION_B);
  });

  it('returns the least-recent speaker among those who have all spoken', () => {
    const participants: RoomEpisodeParticipant[] = [
      { companionId: COMPANION_A, speakCount: 1, lastSpokeAtMs: 9_000 },
      { companionId: COMPANION_B, speakCount: 1, lastSpokeAtMs: 2_000 },
    ];
    expect(selectSpeakLeastWinner(participants, [COMPANION_A, COMPANION_B])).toBe(COMPANION_B);
  });

  it('returns null for an empty contender set', () => {
    expect(selectSpeakLeastWinner([], [])).toBeNull();
  });
});

describe('SpeakingEgressLeasePhase.grantReply — happy path', () => {
  it('gates, draws, acquires, sends, and completes a delivered reply', async () => {
    const store = makeFakeStore();
    const pot = makePot('drawn');
    const sender = makeSender('delivered');
    const phase = makePhase({ store, pot, sender });

    const decision = await phase.grantReply(makeReservation(), REPLY, TRIGGER_CTX, 10_000);

    expect(decision.outcome).toBe('delivered');
    expect(pot.draw).toHaveBeenCalledOnce();
    expect(store.acquireEgressLease).toHaveBeenCalledOnce();
    expect(sender.deliver).toHaveBeenCalledOnce();
    // The lease is completed `delivered` with the pressure projection (single source).
    expect(store.completeEgressLease).toHaveBeenCalledWith(
      expect.objectContaining({ completion: 'delivered', pressureDelta: 3, fencingToken: 1 }),
    );
    // The breaker state was persisted (durable single-probe discipline).
    expect(store.persistRoomEpisodeBreakerState).toHaveBeenCalledOnce();
    // A delivered reply never releases the reservation as silence.
    expect(store.releaseReservation).not.toHaveBeenCalled();
  });

  it('draws BEFORE acquiring (the real draw binds at egress)', async () => {
    const order: string[] = [];
    const store = makeFakeStore();
    store.acquireEgressLease.mockImplementation(async () => {
      order.push('acquire');
      return { outcome: 'acquired' as const, lease: makeLease(), heldBy: null };
    });
    const pot = makePot('drawn');
    pot.draw.mockImplementation(async () => {
      order.push('draw');
      return {
        outcome: 'drawn' as const,
        drawn: 1,
        before: { companionId: COMPANION_A, balance: 10, cap: 240, lastRegenAtMs: 0, revision: 1 },
        after: { companionId: COMPANION_A, balance: 9, cap: 240, lastRegenAtMs: 0, revision: 2 },
      };
    });
    const phase = makePhase({ store, pot });
    await phase.grantReply(makeReservation(), REPLY, TRIGGER_CTX, 10_000);
    expect(order).toEqual(['draw', 'acquire']);
  });
});

describe('SpeakingEgressLeasePhase.grantReply — reservation-status guard (jp36.5.1.2 handoff)', () => {
  for (const status of ['released', 'expired'] as const) {
    it(`declines a ${status} reservation with no acquire and no send`, async () => {
      const store = makeFakeStore();
      const sender = makeSender('delivered');
      const phase = makePhase({ store, sender });
      const decision = await phase.grantReply(
        makeReservation({ status, reason: status === 'released' ? 'ignore' : 'expiry' }),
        REPLY,
        TRIGGER_CTX,
        10_000,
      );
      expect(decision.outcome).toBe('reservation_not_reservable');
      expect(store.acquireEgressLease).not.toHaveBeenCalled();
      expect(sender.deliver).not.toHaveBeenCalled();
      expect(store.readRoomEpisodeBreakerState).not.toHaveBeenCalled();
    });
  }
});

describe('SpeakingEgressLeasePhase.grantReply — Law-36 single-probe breaker discipline', () => {
  it('admits when the breaker is closed', async () => {
    const store = makeFakeStore({ breakerState: 'closed' });
    const phase = makePhase({ store, pressure: makePressure(makeAssessment(10)) });
    const decision = await phase.grantReply(makeReservation(), REPLY, TRIGGER_CTX, 10_000);
    expect(decision.outcome).toBe('delivered');
  });

  it('suppresses a fresh trip into open and emits the structural firing record', async () => {
    const store = makeFakeStore({ breakerState: 'closed' });
    const sender = makeSender('delivered');
    // Pressure above the trip threshold: closed → open.
    const phase = makePhase({ store, sender, pressure: makePressure(makeAssessment(150)) });
    const decision = await phase.grantReply(makeReservation(), REPLY, TRIGGER_CTX, 10_000);
    expect(decision.outcome).toBe('breaker_suppressed');
    expect(decision.breakerState).toBe('open');
    expect(decision.breakerFiring?.transition).toBe('closed_to_open');
    expect(decision.breakerFiring?.attribution).toBe('system_circuit_breaker');
    expect(sender.deliver).not.toHaveBeenCalled();
    // Suppression releases the reservation as an affirmative silence.
    expect(store.releaseReservation).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'silence' }),
    );
    expect(store.persistRoomEpisodeBreakerState).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'open' }),
    );
  });

  it('ADMITS the single fresh open→half_open probe', async () => {
    // Prior durable state open; pressure decayed to/below reset → half_open.
    const store = makeFakeStore({ breakerState: 'open' });
    const phase = makePhase({ store, pressure: makePressure(makeAssessment(30)) });
    const decision = await phase.grantReply(makeReservation(), REPLY, TRIGGER_CTX, 10_000);
    expect(decision.outcome).toBe('delivered');
    expect(store.persistRoomEpisodeBreakerState).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'half_open' }),
    );
  });

  it('SUPPRESSES a durable half_open (a probe already spent) — probeAllowed alone is insufficient', async () => {
    // Prior durable state already half_open; pressure in the hysteresis band keeps
    // it half_open. probeAllowed is true, but priorState is NOT open, so the probe
    // was already spent: it must suppress, not re-probe (caller obligation #1).
    const store = makeFakeStore({ breakerState: 'half_open' });
    const sender = makeSender('delivered');
    const phase = makePhase({ store, sender, pressure: makePressure(makeAssessment(50)) });
    const decision = await phase.grantReply(makeReservation(), REPLY, TRIGGER_CTX, 10_000);
    expect(decision.outcome).toBe('breaker_suppressed');
    expect(decision.breakerState).toBe('half_open');
    expect(sender.deliver).not.toHaveBeenCalled();
  });
});

describe('SpeakingEgressLeasePhase.grantReply — lease-threshold bias (soft wrap-up)', () => {
  it('suppresses an appraisal below minReplyConfidence + leaseThresholdBias', async () => {
    const store = makeFakeStore({ breakerState: 'closed' });
    const sender = makeSender('delivered');
    // bar = 0.5 + 0.45 = 0.95; appraisal 0.9 < bar → suppressed.
    const phase = makePhase({ store, sender, pressure: makePressure(makeAssessment(50, 0.45)) });
    const decision = await phase.grantReply(makeReservation(), { ...REPLY, confidence: 0.9 }, TRIGGER_CTX, 10_000);
    expect(decision.outcome).toBe('below_confidence_bar');
    expect(sender.deliver).not.toHaveBeenCalled();
    expect(store.releaseReservation).toHaveBeenCalledWith(expect.objectContaining({ reason: 'silence' }));
  });

  it('admits when confidence clears the raised bar', async () => {
    const store = makeFakeStore({ breakerState: 'closed' });
    const phase = makePhase({ store, pressure: makePressure(makeAssessment(50, 0.3)) });
    // bar = 0.5 + 0.3 = 0.8; appraisal 0.9 >= bar → proceeds.
    const decision = await phase.grantReply(makeReservation(), { ...REPLY, confidence: 0.9 }, TRIGGER_CTX, 10_000);
    expect(decision.outcome).toBe('delivered');
  });
});

describe('SpeakingEgressLeasePhase.grantReply — speak-least fairness yield', () => {
  it('yields (no draw, no send) when a less-recent contender should speak', async () => {
    // Local A spoke recently; B is a reserver who never spoke → B wins → A yields.
    const store = makeFakeStore({
      reservers: [COMPANION_A, COMPANION_B],
      participants: [{ companionId: COMPANION_A, speakCount: 2, lastSpokeAtMs: 9_000 }],
    });
    const pot = makePot('drawn');
    const sender = makeSender('delivered');
    const phase = makePhase({ store, pot, sender, companionId: COMPANION_A });
    const decision = await phase.grantReply(makeReservation(), REPLY, TRIGGER_CTX, 10_000);
    expect(decision.outcome).toBe('yielded_speak_least');
    expect(decision.speakLeastWinner).toBe(COMPANION_B);
    expect(pot.draw).not.toHaveBeenCalled();
    expect(sender.deliver).not.toHaveBeenCalled();
    expect(store.releaseReservation).toHaveBeenCalledWith(expect.objectContaining({ reason: 'silence' }));
  });

  it('proceeds when the local companion is the speak-least winner', async () => {
    const store = makeFakeStore({
      reservers: [COMPANION_A, COMPANION_B],
      participants: [{ companionId: COMPANION_B, speakCount: 2, lastSpokeAtMs: 9_000 }],
    });
    const phase = makePhase({ store, companionId: COMPANION_A });
    const decision = await phase.grantReply(makeReservation(), REPLY, TRIGGER_CTX, 10_000);
    expect(decision.outcome).toBe('delivered');
  });
});

describe('SpeakingEgressLeasePhase.grantReply — fail-closed matrix', () => {
  it('refuses to send when the pot draw is capped', async () => {
    const store = makeFakeStore();
    const sender = makeSender('delivered');
    const phase = makePhase({ store, pot: makePot('capped'), sender });
    const decision = await phase.grantReply(makeReservation(), REPLY, TRIGGER_CTX, 10_000);
    expect(decision.outcome).toBe('draw_refused');
    expect(decision.drawOutcome).toBe('capped');
    expect(store.acquireEgressLease).not.toHaveBeenCalled();
    expect(sender.deliver).not.toHaveBeenCalled();
    expect(store.releaseReservation).toHaveBeenCalledWith(expect.objectContaining({ reason: 'silence' }));
  });

  it('refuses to send when the pot is insufficient', async () => {
    const store = makeFakeStore();
    const phase = makePhase({ store, pot: makePot('insufficient') });
    const decision = await phase.grantReply(makeReservation(), REPLY, TRIGGER_CTX, 10_000);
    expect(decision.outcome).toBe('draw_refused');
    expect(decision.drawOutcome).toBe('insufficient');
  });

  it('does not retry a `held` decline into speech', async () => {
    const store = makeFakeStore({ acquire: 'declined_held' });
    const sender = makeSender('delivered');
    const phase = makePhase({ store, sender });
    const decision = await phase.grantReply(makeReservation(), REPLY, TRIGGER_CTX, 10_000);
    expect(decision.outcome).toBe('lease_declined');
    expect(decision.declineReason).toBe('held');
    expect(sender.deliver).not.toHaveBeenCalled();
    expect(store.completeEgressLease).not.toHaveBeenCalled();
  });

  it('does not retry an `already_delivered` decline into speech', async () => {
    const store = makeFakeStore({ acquire: 'declined_delivered' });
    const sender = makeSender('delivered');
    const phase = makePhase({ store, sender });
    const decision = await phase.grantReply(makeReservation(), REPLY, TRIGGER_CTX, 10_000);
    expect(decision.outcome).toBe('lease_declined');
    expect(decision.declineReason).toBe('already_delivered');
    expect(sender.deliver).not.toHaveBeenCalled();
  });

  it('completes the lease `failed` when the sender reports failure', async () => {
    const store = makeFakeStore();
    const phase = makePhase({ store, sender: makeSender('failed') });
    const decision = await phase.grantReply(makeReservation(), REPLY, TRIGGER_CTX, 10_000);
    expect(decision.outcome).toBe('delivery_failed');
    expect(store.completeEgressLease).toHaveBeenCalledWith(
      expect.objectContaining({ completion: 'failed' }),
    );
  });

  it('completes the lease `failed` when the sender throws (never leaves it held)', async () => {
    const store = makeFakeStore();
    const phase = makePhase({ store, sender: makeSender('throw') });
    const decision = await phase.grantReply(makeReservation(), REPLY, TRIGGER_CTX, 10_000);
    expect(decision.outcome).toBe('delivery_failed');
    expect(store.completeEgressLease).toHaveBeenCalledWith(
      expect.objectContaining({ completion: 'failed' }),
    );
  });

  it('fails closed (no send) when the pressure resolver throws', async () => {
    const store = makeFakeStore();
    const sender = makeSender('delivered');
    const phase = makePhase({
      store,
      sender,
      pressure: { resolve: () => { throw new Error('ledger unavailable'); } },
    });
    const decision = await phase.grantReply(makeReservation(), REPLY, TRIGGER_CTX, 10_000);
    expect(decision.outcome).toBe('gate_error');
    expect(decision.errorStage).toBe('room_pressure');
    expect(sender.deliver).not.toHaveBeenCalled();
  });

  it('fails closed (no send) when the breaker read throws', async () => {
    const store = makeFakeStore({ readBreakerThrows: true });
    const sender = makeSender('delivered');
    const phase = makePhase({ store, sender });
    const decision = await phase.grantReply(makeReservation(), REPLY, TRIGGER_CTX, 10_000);
    expect(decision.outcome).toBe('gate_error');
    expect(decision.errorStage).toBe('breaker');
    expect(sender.deliver).not.toHaveBeenCalled();
  });

  it('fails closed (no send) when acquire throws (reservation concurrently retired)', async () => {
    const store = makeFakeStore({ acquireThrows: true });
    const sender = makeSender('delivered');
    const phase = makePhase({ store, sender });
    const decision = await phase.grantReply(makeReservation(), REPLY, TRIGGER_CTX, 10_000);
    expect(decision.outcome).toBe('gate_error');
    expect(decision.errorStage).toBe('acquire');
    expect(sender.deliver).not.toHaveBeenCalled();
  });

  it('surfaces a completion failure structurally after the send (never swallowed)', async () => {
    const store = makeFakeStore({ completeThrows: true });
    const phase = makePhase({ store, sender: makeSender('delivered') });
    const decision = await phase.grantReply(makeReservation(), REPLY, TRIGGER_CTX, 10_000);
    expect(decision.outcome).toBe('gate_error');
    expect(decision.errorStage).toBe('complete');
  });
});

describe('SpeakingEgressLeasePhase.releaseReact — explicit non-lease release', () => {
  it('releases a retained react reservation as silence, taking no lease', async () => {
    const store = makeFakeStore();
    const phase = makePhase({ store });
    const decision = await phase.releaseReact(makeReservation(), 10_000);
    expect(decision.outcome).toBe('react_released');
    expect(store.releaseReservation).toHaveBeenCalledWith(expect.objectContaining({ reason: 'silence' }));
    expect(store.acquireEgressLease).not.toHaveBeenCalled();
  });

  it('declines a non-reserved react reservation', async () => {
    const store = makeFakeStore();
    const phase = makePhase({ store });
    const decision = await phase.releaseReact(makeReservation({ status: 'released', reason: 'ignore' }), 10_000);
    expect(decision.outcome).toBe('reservation_not_reservable');
    expect(store.releaseReservation).not.toHaveBeenCalled();
  });

  it('tolerates a benign concurrent-terminal race on release', async () => {
    const store = makeFakeStore();
    store.releaseReservation.mockRejectedValueOnce(new Error('speaking reservation x already terminal (released/superseded)'));
    const phase = makePhase({ store });
    const decision = await phase.releaseReact(makeReservation(), 10_000);
    expect(decision.outcome).toBe('react_released');
  });
});
