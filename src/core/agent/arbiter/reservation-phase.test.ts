import { describe, expect, it, vi } from 'vitest';

import {
  SpeakingReservationPhase,
  type IcpSocialPrecedenceResolver,
  type ReservationPhaseConfig,
  type ReservationSignalContext,
  type RoomEpisodePressureResolver,
} from './reservation-phase.js';
import type {
  ReserveInput,
  ReserveResult,
  RoomEpisodeSnapshot,
  SpeakingReservationSnapshot,
} from './speaking-arbiter-store-port.js';
import type { SocialPotReadInput, SocialPotSnapshot } from '../fatigue/social-pot.js';
import type { IcpSocialPrecedenceInput } from '../../icp/social-precedence.js';

const COMPANION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHANNEL = 'discord:guild-1:general';
const TRIGGER = 'evt-42';
const RESERVATION_ID = '99999999-9999-4999-8999-999999999999';

function makeConfig(overrides: Partial<ReservationPhaseConfig> = {}): ReservationPhaseConfig {
  return {
    reservationTtlMs: 120_000,
    minReserveDrawUnits: 1,
    socialPot: {
      capUnits: 240,
      perChannelDrawFraction: 0.34,
      regenerationTickMs: 3_600_000,
      regenerationUnitsPerTick: 10,
    },
    roomEpisodeCircuitBreaker: {
      tripThreshold: 100,
      resetThreshold: 40,
    },
    wrapUpThreshold: 60,
    ...overrides,
  };
}

function makeEpisode(): RoomEpisodeSnapshot {
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
    participants: [],
  };
}

function makeReservation(): SpeakingReservationSnapshot {
  return {
    reservationId: RESERVATION_ID,
    channelId: CHANNEL,
    triggerEventId: TRIGGER,
    companionId: COMPANION,
    episodeId: 'episode-1',
    reservedAtMs: 5_000,
    expiresAtMs: 125_000,
    status: 'reserved',
    reason: null,
    finalizedAtMs: null,
    revision: 1,
  };
}

function makePot(balance: number): SocialPotSnapshot {
  return { companionId: COMPANION, balance, cap: 240, lastRegenAtMs: 0, revision: 1 };
}

interface Stubs {
  reserve: ReturnType<typeof vi.fn>;
  releaseReservation: ReturnType<typeof vi.fn>;
  readPot: ReturnType<typeof vi.fn>;
  icpResolve: ReturnType<typeof vi.fn>;
}

function makePhase(options?: {
  potBalance?: number;
  icp?: IcpSocialPrecedenceInput;
  roomPressure?: RoomEpisodePressureResolver;
  config?: Partial<ReservationPhaseConfig>;
  reserveOutcome?: 'reserved' | 'replayed';
}): { phase: SpeakingReservationPhase; stubs: Stubs } {
  const reserve = vi.fn(
    async (input: ReserveInput): Promise<ReserveResult> => ({
      outcome: options?.reserveOutcome ?? 'reserved',
      reservation: { ...makeReservation(), reservationId: input.reservationId },
      episode: makeEpisode(),
    }),
  );
  const releaseReservation = vi.fn(async () => makeReservation());
  const readPot = vi.fn(
    async (_input: SocialPotReadInput): Promise<SocialPotSnapshot> =>
      makePot(options?.potBalance ?? 100),
  );
  const icpResolve = vi.fn(
    (_ctx: ReservationSignalContext): IcpSocialPrecedenceInput =>
      options?.icp ?? { icpTurnFenced: false, icpFatigueExhausted: false },
  );
  const icpPrecedence: IcpSocialPrecedenceResolver = { resolve: icpResolve };
  const phase = new SpeakingReservationPhase({
    store: { reserve, releaseReservation },
    socialPot: { readPot },
    icpPrecedence,
    ...(options?.roomPressure ? { roomPressure: options.roomPressure } : {}),
    companionId: COMPANION,
    config: makeConfig(options?.config),
    generateReservationId: () => RESERVATION_ID,
  });
  return { phase, stubs: { reserve, releaseReservation, readPot, icpResolve } };
}

function ctx(overrides: Partial<ReservationSignalContext> = {}): ReservationSignalContext {
  return { channelId: CHANNEL, triggerEventId: TRIGGER, companionId: COMPANION, nowMs: 5_000, ...overrides };
}

describe('SpeakingReservationPhase.reserve — admit path', () => {
  it('reserves a candidate when every gate admits and passes the store the right fence', async () => {
    const { phase, stubs } = makePhase({ potBalance: 100 });
    const decision = await phase.reserve(ctx());
    expect(decision.outcome).toBe('reserved');
    if (decision.outcome !== 'reserved') return;
    expect(decision.replayed).toBe(false);
    expect(decision.reservation.reservationId).toBe(RESERVATION_ID);
    // The reservation carries the caller-generated id, the room event, the local
    // companion, and a TTL deadline in the future.
    expect(stubs.reserve).toHaveBeenCalledWith({
      reservationId: RESERVATION_ID,
      channelId: CHANNEL,
      triggerEventId: TRIGGER,
      companionId: COMPANION,
      nowMs: 5_000,
      expiresAtMs: 5_000 + 120_000,
    });
  });

  it('surfaces a replayed reservation as replayed:true', async () => {
    const { phase } = makePhase({ reserveOutcome: 'replayed' });
    const decision = await phase.reserve(ctx());
    expect(decision.outcome).toBe('reserved');
    if (decision.outcome !== 'reserved') return;
    expect(decision.replayed).toBe(true);
  });
});

describe('SpeakingReservationPhase.reserve — deterministic gate ordering (§6.10)', () => {
  it('gates on ICP precedence FIRST, before touching the pot or the store', async () => {
    const { phase, stubs } = makePhase({
      icp: { icpTurnFenced: true, icpFatigueExhausted: false },
      potBalance: 100,
    });
    const decision = await phase.reserve(ctx());
    expect(decision).toEqual({ outcome: 'gated', blockedBy: 'icp_turn_fenced' });
    // ICP dominates: the economy is never consulted and no reservation is placed.
    expect(stubs.readPot).not.toHaveBeenCalled();
    expect(stubs.reserve).not.toHaveBeenCalled();
  });

  it('carries the specific non-open availability state on an icp_availability block', async () => {
    const { phase } = makePhase({
      icp: { availabilityState: 'do_not_disturb', icpTurnFenced: false, icpFatigueExhausted: false },
    });
    const decision = await phase.reserve(ctx());
    expect(decision).toEqual({
      outcome: 'gated',
      blockedBy: 'icp_availability',
      availabilityState: 'do_not_disturb',
    });
  });

  it('gates on room-episode flood (pressure >= breaker trip) before the pot peek', async () => {
    const roomPressure: RoomEpisodePressureResolver = { resolve: vi.fn(() => 100) };
    const { phase, stubs } = makePhase({ roomPressure, potBalance: 100 });
    const decision = await phase.reserve(ctx());
    expect(decision).toEqual({ outcome: 'gated', blockedBy: 'room_flooded' });
    expect(stubs.readPot).not.toHaveBeenCalled();
    expect(stubs.reserve).not.toHaveBeenCalled();
  });

  it('admits when decayed pressure is below the breaker trip threshold', async () => {
    const roomPressure: RoomEpisodePressureResolver = { resolve: vi.fn(() => 99.9) };
    const { phase, stubs } = makePhase({ roomPressure, potBalance: 100 });
    const decision = await phase.reserve(ctx());
    expect(decision.outcome).toBe('reserved');
    expect(stubs.reserve).toHaveBeenCalledTimes(1);
  });

  it('gates when the social pot cannot fund a minimal social turn', async () => {
    const { phase, stubs } = makePhase({ potBalance: 0.5, config: { minReserveDrawUnits: 1 } });
    const decision = await phase.reserve(ctx());
    expect(decision).toEqual({ outcome: 'gated', blockedBy: 'fatigue_pot_insufficient' });
    // A funding PEEK only — never a draw (the draw binds at egress).
    expect(stubs.readPot).toHaveBeenCalledTimes(1);
    expect(stubs.reserve).not.toHaveBeenCalled();
  });

  it('does not apply the room-pressure gate when no pressure source is injected', async () => {
    const { phase, stubs } = makePhase({ potBalance: 100 });
    const decision = await phase.reserve(ctx());
    expect(decision.outcome).toBe('reserved');
    expect(stubs.reserve).toHaveBeenCalledTimes(1);
  });
});

describe('SpeakingReservationPhase.reserve — fail closed', () => {
  it('fails closed (gated, no reservation) when the ICP resolver throws', async () => {
    const { phase, stubs } = makePhase();
    stubs.icpResolve.mockImplementation(() => {
      throw new Error('icp broker unavailable');
    });
    const decision = await phase.reserve(ctx());
    expect(decision).toEqual({ outcome: 'gated', blockedBy: 'gate_error', errorStage: 'icp_precedence' });
    expect(stubs.reserve).not.toHaveBeenCalled();
  });

  it('fails closed when the ICP resolver returns malformed input', async () => {
    const { phase, stubs } = makePhase();
    // Missing the required boolean fields → resolveIcpSocialPrecedence throws.
    stubs.icpResolve.mockReturnValue({} as IcpSocialPrecedenceInput);
    const decision = await phase.reserve(ctx());
    expect(decision).toMatchObject({ outcome: 'gated', blockedBy: 'gate_error', errorStage: 'icp_precedence' });
    expect(stubs.reserve).not.toHaveBeenCalled();
  });

  it('fails closed when the room-pressure resolver throws', async () => {
    const roomPressure: RoomEpisodePressureResolver = {
      resolve: vi.fn(() => {
        throw new Error('ledger read failed');
      }),
    };
    const { phase, stubs } = makePhase({ roomPressure });
    const decision = await phase.reserve(ctx());
    expect(decision).toEqual({ outcome: 'gated', blockedBy: 'gate_error', errorStage: 'room_pressure' });
    expect(stubs.reserve).not.toHaveBeenCalled();
  });

  it('fails closed when the pot read throws', async () => {
    const { phase, stubs } = makePhase();
    stubs.readPot.mockRejectedValue(new Error('pot store down'));
    const decision = await phase.reserve(ctx());
    expect(decision).toEqual({ outcome: 'gated', blockedBy: 'gate_error', errorStage: 'social_pot' });
    expect(stubs.reserve).not.toHaveBeenCalled();
  });

  it('fails closed when the store.reserve throws (no reservation → no appraisal)', async () => {
    const { phase, stubs } = makePhase();
    stubs.reserve.mockRejectedValue(new Error('postgres unavailable'));
    const decision = await phase.reserve(ctx());
    expect(decision).toEqual({ outcome: 'gated', blockedBy: 'gate_error', errorStage: 'reserve' });
  });

  it('fails closed on a malformed context (empty channelId)', async () => {
    const { phase, stubs } = makePhase();
    const decision = await phase.reserve(ctx({ channelId: '' }));
    expect(decision).toEqual({ outcome: 'gated', blockedBy: 'gate_error', errorStage: 'reserve' });
    expect(stubs.icpResolve).not.toHaveBeenCalled();
  });
});

describe('SpeakingReservationPhase.settleAfterAppraisal', () => {
  it('releases the reservation with the ignore reason on an ignore outcome', async () => {
    const { phase, stubs } = makePhase();
    const result = await phase.settleAfterAppraisal(makeReservation(), 'ignore', 9_000);
    expect(result).toBe('released');
    expect(stubs.releaseReservation).toHaveBeenCalledWith({
      reservationId: RESERVATION_ID,
      channelId: CHANNEL,
      reason: 'ignore',
      nowMs: 9_000,
    });
  });

  it('retains the reservation on react (handed to the egress phase)', async () => {
    const { phase, stubs } = makePhase();
    const result = await phase.settleAfterAppraisal(makeReservation(), 'react', 9_000);
    expect(result).toBe('retained');
    expect(stubs.releaseReservation).not.toHaveBeenCalled();
  });

  it('retains the reservation on reply (handed to the egress phase)', async () => {
    const { phase, stubs } = makePhase();
    const result = await phase.settleAfterAppraisal(makeReservation(), 'reply', 9_000);
    expect(result).toBe('retained');
    expect(stubs.releaseReservation).not.toHaveBeenCalled();
  });
});

describe('SpeakingReservationPhase construction', () => {
  it('rejects an empty companion id', () => {
    expect(() =>
      new SpeakingReservationPhase({
        store: { reserve: vi.fn(), releaseReservation: vi.fn() },
        socialPot: { readPot: vi.fn() },
        icpPrecedence: { resolve: vi.fn() },
        companionId: '   ',
        config: makeConfig(),
      }),
    ).toThrow(/companionId/);
  });

  it('rejects a non-positive reservation TTL', () => {
    expect(() =>
      new SpeakingReservationPhase({
        store: { reserve: vi.fn(), releaseReservation: vi.fn() },
        socialPot: { readPot: vi.fn() },
        icpPrecedence: { resolve: vi.fn() },
        companionId: COMPANION,
        config: makeConfig({ reservationTtlMs: 0 }),
      }),
    ).toThrow(/reservationTtlMs/);
  });
});
