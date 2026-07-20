import { describe, expect, it } from 'vitest';

import { ICP_AVAILABILITY_STATES } from '../../shared/contracts/icp-autonomy.js';
import {
  resolveIcpSocialPrecedence,
  resolveUnlinkedPeerSpeakLeast,
  type IcpSocialPrecedenceInput,
  type UnlinkedPeerSpeakLeastConfig,
} from './social-precedence.js';

// ── ICP-over-social precedence (adjudication R2 §3.7, bible §8.5) ────────────

describe('resolveIcpSocialPrecedence — ICP dominates social on any conflict', () => {
  const open: IcpSocialPrecedenceInput = {
    availabilityState: 'available',
    icpTurnFenced: false,
    icpFatigueExhausted: false,
  };

  it('admits the social turn when no ICP condition contends', () => {
    expect(resolveIcpSocialPrecedence(open)).toEqual({ admitted: true });
    expect(resolveIcpSocialPrecedence({ ...open, availabilityState: 'open_to_chat' }))
      .toEqual({ admitted: true });
    // Absent availability lease is treated as open, not as DND.
    expect(resolveIcpSocialPrecedence({
      icpTurnFenced: false,
      icpFatigueExhausted: false,
    })).toEqual({ admitted: true });
  });

  it('blocks a social lease when an ICP turn is fenced (acceptance: fence blocks social lease)', () => {
    expect(resolveIcpSocialPrecedence({ ...open, icpTurnFenced: true })).toEqual({
      admitted: false,
      blockedBy: 'icp_turn_fenced',
    });
  });

  it('blocks when the ICP continuation lane is exhausted', () => {
    expect(resolveIcpSocialPrecedence({ ...open, icpFatigueExhausted: true })).toEqual({
      admitted: false,
      blockedBy: 'icp_fatigue_exhausted',
    });
  });

  it.each(['busy', 'resting', 'do_not_disturb'] as const)(
    'blocks when the local availability is the non-open state %s',
    (availabilityState) => {
      expect(resolveIcpSocialPrecedence({ ...open, availabilityState })).toEqual({
        admitted: false,
        blockedBy: 'icp_availability',
        availabilityState,
      });
    },
  );

  it('orders the primary reason fenced → exhausted → availability when several hold', () => {
    // All three contend: the most-immediate race (fence) is reported first.
    expect(resolveIcpSocialPrecedence({
      availabilityState: 'do_not_disturb',
      icpTurnFenced: true,
      icpFatigueExhausted: true,
    })).toEqual({ admitted: false, blockedBy: 'icp_turn_fenced' });
    // Exhausted outranks availability.
    expect(resolveIcpSocialPrecedence({
      availabilityState: 'do_not_disturb',
      icpTurnFenced: false,
      icpFatigueExhausted: true,
    })).toEqual({ admitted: false, blockedBy: 'icp_fatigue_exhausted' });
  });

  it('covers every availability state as either open or blocking (no silent gap)', () => {
    for (const state of ICP_AVAILABILITY_STATES) {
      const decision = resolveIcpSocialPrecedence({
        availabilityState: state,
        icpTurnFenced: false,
        icpFatigueExhausted: false,
      });
      if (state === 'available' || state === 'open_to_chat') {
        expect(decision).toEqual({ admitted: true });
      } else {
        expect(decision).toEqual({
          admitted: false,
          blockedBy: 'icp_availability',
          availabilityState: state,
        });
      }
    }
  });

  it('fails closed on malformed input rather than admitting', () => {
    expect(() => resolveIcpSocialPrecedence({
      icpTurnFenced: 'yes' as unknown as boolean,
      icpFatigueExhausted: false,
    })).toThrow(/icpTurnFenced must be a boolean/);
    expect(() => resolveIcpSocialPrecedence({
      icpTurnFenced: false,
      icpFatigueExhausted: false,
      availabilityState: 'napping' as never,
    })).toThrow(/not a known ICP availability state/);
  });
});

// ── Unlinked-peer speak-least fallback (design review R2 option (a)) ─────────

const FALLBACK: UnlinkedPeerSpeakLeastConfig = {
  baseDelayMs: 200,
  perRecentSendDelayMs: 500,
  jitterWindowMs: 1_000,
  deferAtRecentSends: 3,
};

describe('resolveUnlinkedPeerSpeakLeast — per-installation speak-least with jitter', () => {
  it('defers a saturated installation (never dogpile-by-design)', () => {
    expect(resolveUnlinkedPeerSpeakLeast(FALLBACK, {
      installationId: 'inst-a',
      roomEventId: 'event-1',
      recentSelfSendCount: 3,
    })).toEqual({ decision: 'defer', reason: 'speak_least_saturated' });
    expect(resolveUnlinkedPeerSpeakLeast(FALLBACK, {
      installationId: 'inst-a',
      roomEventId: 'event-1',
      recentSelfSendCount: 9,
    })).toEqual({ decision: 'defer', reason: 'speak_least_saturated' });
  });

  it('is deterministic — identical inputs yield the identical delay', () => {
    const first = resolveUnlinkedPeerSpeakLeast(FALLBACK, {
      installationId: 'inst-a',
      roomEventId: 'event-1',
      recentSelfSendCount: 0,
    });
    const second = resolveUnlinkedPeerSpeakLeast(FALLBACK, {
      installationId: 'inst-a',
      roomEventId: 'event-1',
      recentSelfSendCount: 0,
    });
    expect(first).toEqual(second);
    expect(first.decision).toBe('speak_after');
  });

  it('biases the quietest installation ahead of a noisier one (speak-least)', () => {
    const quiet = resolveUnlinkedPeerSpeakLeast(FALLBACK, {
      installationId: 'inst-a',
      roomEventId: 'event-1',
      recentSelfSendCount: 0,
    });
    const noisy = resolveUnlinkedPeerSpeakLeast(FALLBACK, {
      installationId: 'inst-a',
      roomEventId: 'event-1',
      recentSelfSendCount: 2,
    });
    if (quiet.decision !== 'speak_after' || noisy.decision !== 'speak_after') {
      throw new Error('expected both to speak');
    }
    // Same installation/event => same jitter; the speak-least term alone must
    // push the noisier turn strictly later.
    expect(noisy.delayMs - quiet.delayMs).toBe(2 * FALLBACK.perRecentSendDelayMs);
    expect(noisy.jitterMs).toBe(quiet.jitterMs);
  });

  it('staggers distinct installations to distinct jitter offsets for one event', () => {
    const ids = ['inst-a', 'inst-b', 'inst-c', 'inst-d', 'inst-e'];
    const jitters = ids.map((installationId) => {
      const decision = resolveUnlinkedPeerSpeakLeast(FALLBACK, {
        installationId,
        roomEventId: 'shared-event',
        recentSelfSendCount: 0,
      });
      if (decision.decision !== 'speak_after') throw new Error('expected speak_after');
      return decision.jitterMs;
    });
    // Every jitter is inside the window and, with equal recent counts, they do
    // not all collapse to one instant — the fallback does not dogpile by design.
    for (const jitter of jitters) {
      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThan(FALLBACK.jitterWindowMs);
    }
    expect(new Set(jitters).size).toBeGreaterThan(1);
  });

  it('composes delay as base + speak-least bias + jitter', () => {
    const decision = resolveUnlinkedPeerSpeakLeast(FALLBACK, {
      installationId: 'inst-a',
      roomEventId: 'event-1',
      recentSelfSendCount: 1,
    });
    if (decision.decision !== 'speak_after') throw new Error('expected speak_after');
    expect(decision.delayMs).toBe(
      FALLBACK.baseDelayMs + 1 * FALLBACK.perRecentSendDelayMs + decision.jitterMs,
    );
    expect(decision.jitterMs).toBeGreaterThanOrEqual(0);
    expect(decision.jitterMs).toBeLessThan(FALLBACK.jitterWindowMs);
  });

  it('fails closed on malformed config', () => {
    const input = { installationId: 'inst-a', roomEventId: 'event-1', recentSelfSendCount: 0 };
    expect(() => resolveUnlinkedPeerSpeakLeast({ ...FALLBACK, jitterWindowMs: 0 }, input))
      .toThrow(/jitterWindowMs must be >= 1/);
    expect(() => resolveUnlinkedPeerSpeakLeast({ ...FALLBACK, deferAtRecentSends: 0 }, input))
      .toThrow(/deferAtRecentSends must be >= 1/);
    expect(() => resolveUnlinkedPeerSpeakLeast({ ...FALLBACK, baseDelayMs: -1 }, input))
      .toThrow(/baseDelayMs must be a finite number >= 0/);
    expect(() => resolveUnlinkedPeerSpeakLeast(
      { ...FALLBACK, perRecentSendDelayMs: Number.NaN },
      input,
    )).toThrow(/perRecentSendDelayMs must be a finite number >= 0/);
  });

  it('fails closed on malformed input', () => {
    expect(() => resolveUnlinkedPeerSpeakLeast(FALLBACK, {
      installationId: '',
      roomEventId: 'event-1',
      recentSelfSendCount: 0,
    })).toThrow(/installationId must be a non-empty trimmed string/);
    expect(() => resolveUnlinkedPeerSpeakLeast(FALLBACK, {
      installationId: ' inst-a ',
      roomEventId: 'event-1',
      recentSelfSendCount: 0,
    })).toThrow(/installationId must be a non-empty trimmed string/);
    expect(() => resolveUnlinkedPeerSpeakLeast(FALLBACK, {
      installationId: 'inst-a',
      roomEventId: 'event-1',
      recentSelfSendCount: -1,
    })).toThrow(/recentSelfSendCount must be a non-negative safe integer/);
    expect(() => resolveUnlinkedPeerSpeakLeast(FALLBACK, {
      installationId: 'inst-a',
      roomEventId: 'event-1',
      recentSelfSendCount: 1.5,
    })).toThrow(/recentSelfSendCount must be a non-negative safe integer/);
  });
});
