import { describe, expect, it, vi } from 'vitest';

import type { IcpOwnAvailabilityResult } from '../../boundary/gateway/icp-autonomy-contract.js';
import type { IcpAvailabilityLease, IcpAvailabilityState } from '../../shared/contracts/icp-autonomy.js';
import { resolveIcpSocialPrecedence } from './social-precedence.js';
import {
  createIcpSpeakingPrecedenceResolver,
  liveAvailabilityState,
  type IcpContinuationFatigueReader,
  type IcpOwnAvailabilityReader,
  type IcpTurnFenceReader,
} from './speaking-precedence-resolver.js';
import {
  SpeakingReservationPhase,
  type ReservationSignalContext,
} from '../agent/arbiter/reservation-phase.js';
import type {
  ReserveInput,
  ReserveResult,
  RoomEpisodeSnapshot,
  SpeakingReservationSnapshot,
} from '../agent/arbiter/speaking-arbiter-store-port.js';
import type { SocialPotReadInput, SocialPotSnapshot } from '../agent/fatigue/social-pot.js';

const COMPANION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHANNEL = 'discord:guild-1:general';
const TRIGGER = 'evt-42';

function ctx(overrides: Partial<ReservationSignalContext> = {}): ReservationSignalContext {
  return { channelId: CHANNEL, triggerEventId: TRIGGER, companionId: COMPANION, nowMs: 5_000, ...overrides };
}

function makeLease(state: IcpAvailabilityState): IcpAvailabilityLease {
  return {
    companionId: COMPANION,
    state,
    issuedAtMs: 1_000,
    expiresAtMs: 3_600_000,
    source: 'companion',
    revision: 1,
  };
}

function availabilityResult(overrides: Partial<IcpOwnAvailabilityResult> = {}): IcpOwnAvailabilityResult {
  return {
    eligible: true,
    control: 'companion',
    mutableByCompanion: true,
    lease: makeLease('available'),
    ...overrides,
  };
}

function makeResolver(options?: {
  availability?: IcpOwnAvailabilityResult | (() => Promise<IcpOwnAvailabilityResult>);
  fenced?: boolean | (() => Promise<boolean>);
  exhausted?: boolean | (() => Promise<boolean>);
  companionId?: string;
}) {
  const availabilityFn = vi.fn(async (): Promise<IcpOwnAvailabilityResult> => {
    if (typeof options?.availability === 'function') return await options.availability();
    return options?.availability ?? availabilityResult();
  });
  const fenceFn = vi.fn(async (): Promise<boolean> => {
    if (typeof options?.fenced === 'function') return await options.fenced();
    return options?.fenced ?? false;
  });
  const exhaustFn = vi.fn(async (): Promise<boolean> => {
    if (typeof options?.exhausted === 'function') return await options.exhausted();
    return options?.exhausted ?? false;
  });
  const availability: IcpOwnAvailabilityReader = { readOwnAvailability: availabilityFn };
  const turnFence: IcpTurnFenceReader = { isTurnFenced: fenceFn };
  const continuationFatigue: IcpContinuationFatigueReader = { isContinuationExhausted: exhaustFn };
  const resolver = createIcpSpeakingPrecedenceResolver({
    companionId: options?.companionId ?? COMPANION,
    availability,
    turnFence,
    continuationFatigue,
  });
  return { resolver, availabilityFn, fenceFn, exhaustFn };
}

describe('liveAvailabilityState', () => {
  it('returns the live lease state for a currently-held lease', () => {
    expect(liveAvailabilityState(availabilityResult({ lease: makeLease('do_not_disturb') })))
      .toBe('do_not_disturb');
  });

  it('treats a missing lease as open (undefined)', () => {
    expect(liveAvailabilityState({ eligible: false, control: 'missing', mutableByCompanion: true }))
      .toBeUndefined();
  });

  it('treats an expired lease as open (undefined) even when the stale lease is present', () => {
    expect(
      liveAvailabilityState({
        eligible: false,
        control: 'expired',
        mutableByCompanion: true,
        lease: makeLease('do_not_disturb'),
      }),
    ).toBeUndefined();
  });

  it('passes through an operator-override non-open state', () => {
    expect(
      liveAvailabilityState({
        eligible: false,
        control: 'operator_override',
        mutableByCompanion: false,
        lease: makeLease('resting'),
      }),
    ).toBe('resting');
  });
});

describe('createIcpSpeakingPrecedenceResolver — live signal matrix', () => {
  it('admits when the lease is open, no fence, and not exhausted', async () => {
    const { resolver } = makeResolver({ availability: availabilityResult({ lease: makeLease('available') }) });
    const input = await resolver.resolve(ctx());
    expect(input).toEqual({
      availabilityState: 'available',
      icpTurnFenced: false,
      icpFatigueExhausted: false,
    });
    expect(resolveIcpSocialPrecedence(input)).toEqual({ admitted: true });
  });

  it('omits availabilityState (open) when there is no current lease', async () => {
    const { resolver } = makeResolver({
      availability: { eligible: false, control: 'missing', mutableByCompanion: true },
    });
    const input = await resolver.resolve(ctx());
    expect(input).toEqual({ icpTurnFenced: false, icpFatigueExhausted: false });
    expect('availabilityState' in input).toBe(false);
    expect(resolveIcpSocialPrecedence(input)).toEqual({ admitted: true });
  });

  it.each(['busy', 'resting', 'do_not_disturb'] as const)(
    'blocks social on a live non-open availability lease (%s)',
    async (state) => {
      const { resolver } = makeResolver({ availability: availabilityResult({ lease: makeLease(state) }) });
      const input = await resolver.resolve(ctx());
      expect(input.availabilityState).toBe(state);
      expect(resolveIcpSocialPrecedence(input)).toEqual({
        admitted: false,
        blockedBy: 'icp_availability',
        availabilityState: state,
      });
    },
  );

  it('reports a live ICP turn fence and blocks social on it', async () => {
    const { resolver } = makeResolver({ fenced: true });
    const input = await resolver.resolve(ctx());
    expect(input.icpTurnFenced).toBe(true);
    expect(resolveIcpSocialPrecedence(input)).toEqual({ admitted: false, blockedBy: 'icp_turn_fenced' });
  });

  it('reports continuation-lane exhaustion and blocks social on it', async () => {
    const { resolver } = makeResolver({ exhausted: true });
    const input = await resolver.resolve(ctx());
    expect(input.icpFatigueExhausted).toBe(true);
    expect(resolveIcpSocialPrecedence(input)).toEqual({ admitted: false, blockedBy: 'icp_fatigue_exhausted' });
  });

  it('preserves the fenced -> exhausted -> availability precedence order when all contend', async () => {
    const { resolver } = makeResolver({
      availability: availabilityResult({ lease: makeLease('do_not_disturb') }),
      fenced: true,
      exhausted: true,
    });
    const input = await resolver.resolve(ctx());
    // Fence is most-immediate: it must win over the concurrent exhaustion and DND.
    expect(resolveIcpSocialPrecedence(input)).toEqual({ admitted: false, blockedBy: 'icp_turn_fenced' });
  });

  it('passes the resolver-bound companion and context scope to the fence/exhaustion reads', async () => {
    const { resolver, fenceFn, exhaustFn } = makeResolver();
    await resolver.resolve(ctx({ nowMs: 9_000 }));
    const expectedScope = { companionId: COMPANION, channelId: CHANNEL, nowMs: 9_000 };
    expect(fenceFn).toHaveBeenCalledWith(expectedScope);
    expect(exhaustFn).toHaveBeenCalledWith(expectedScope);
  });
});

describe('createIcpSpeakingPrecedenceResolver — fail closed (no swallowed errors)', () => {
  it('propagates an availability read failure (never admits on uncertainty)', async () => {
    const { resolver } = makeResolver({
      availability: async () => {
        throw new Error('gateway RPC down');
      },
    });
    await expect(resolver.resolve(ctx())).rejects.toThrow(/gateway RPC down/);
  });

  it('propagates a turn-fence read failure', async () => {
    const { resolver } = makeResolver({
      fenced: async () => {
        throw new Error('postgres unavailable');
      },
    });
    await expect(resolver.resolve(ctx())).rejects.toThrow(/postgres unavailable/);
  });

  it('propagates a continuation-fatigue read failure', async () => {
    const { resolver } = makeResolver({
      exhausted: async () => {
        throw new Error('fatigue store error');
      },
    });
    await expect(resolver.resolve(ctx())).rejects.toThrow(/fatigue store error/);
  });

  it('rejects a non-boolean fence signal rather than admitting', async () => {
    const { resolver } = makeResolver({
      fenced: async () => 'yes' as unknown as boolean,
    });
    await expect(resolver.resolve(ctx())).rejects.toThrow(/turn-fence signal must be a boolean/);
  });

  it('rejects a context bound to a different companion', async () => {
    const { resolver } = makeResolver();
    await expect(resolver.resolve(ctx({ companionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })))
      .rejects.toThrow(/different companion/);
  });

  it('rejects construction with an empty companionId', () => {
    expect(() =>
      createIcpSpeakingPrecedenceResolver({
        companionId: '   ',
        availability: { readOwnAvailability: async () => availabilityResult() },
        turnFence: { isTurnFenced: async () => false },
        continuationFatigue: { isContinuationExhausted: async () => false },
      }),
    ).toThrow(/companionId must be a non-empty string/);
  });
});

// ── Integration with the reservation phase (the seam this transport fills) ──

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

function makeReservation(reservationId: string): SpeakingReservationSnapshot {
  return {
    reservationId,
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

function makeReservationPhase(resolverOpts?: Parameters<typeof makeResolver>[0]) {
  const { resolver } = makeResolver(resolverOpts);
  const reserve = vi.fn(
    async (input: ReserveInput): Promise<ReserveResult> => ({
      outcome: 'reserved',
      reservation: makeReservation(input.reservationId),
      episode: makeEpisode(),
    }),
  );
  const releaseReservation = vi.fn(async () => makeReservation('r1'));
  const readPot = vi.fn(
    async (_input: SocialPotReadInput): Promise<SocialPotSnapshot> => ({
      companionId: COMPANION,
      balance: 100,
      cap: 240,
      lastRegenAtMs: 0,
      revision: 1,
    }),
  );
  const phase = new SpeakingReservationPhase({
    store: { reserve, releaseReservation },
    socialPot: { readPot },
    icpPrecedence: resolver,
    companionId: COMPANION,
    config: {
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
    },
    generateReservationId: () => '99999999-9999-4999-8999-999999999999',
  });
  return { phase, reserve, readPot };
}

describe('live ICP transport wired into SpeakingReservationPhase', () => {
  it('reserves when live ICP state is open (no contention)', async () => {
    const { phase, reserve } = makeReservationPhase();
    const decision = await phase.reserve(ctx());
    expect(decision.outcome).toBe('reserved');
    expect(reserve).toHaveBeenCalledOnce();
  });

  it('gates on a live ICP turn fence before the pot or store are touched', async () => {
    const { phase, reserve, readPot } = makeReservationPhase({ fenced: true });
    const decision = await phase.reserve(ctx());
    expect(decision).toEqual({ outcome: 'gated', blockedBy: 'icp_turn_fenced' });
    expect(readPot).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('gates on a live DND availability lease with the specific state', async () => {
    const { phase } = makeReservationPhase({
      availability: availabilityResult({ lease: makeLease('do_not_disturb') }),
    });
    const decision = await phase.reserve(ctx());
    expect(decision).toEqual({
      outcome: 'gated',
      blockedBy: 'icp_availability',
      availabilityState: 'do_not_disturb',
    });
  });

  it('fails closed to gate_error at the icp_precedence stage when a signal source errors', async () => {
    const { phase, reserve, readPot } = makeReservationPhase({
      fenced: async () => {
        throw new Error('postgres unavailable');
      },
    });
    const decision = await phase.reserve(ctx());
    expect(decision).toEqual({ outcome: 'gated', blockedBy: 'gate_error', errorStage: 'icp_precedence' });
    // Fail closed: no economy work, no reservation — the erroring ICP signal
    // suppressed the social turn.
    expect(readPot).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });
});
