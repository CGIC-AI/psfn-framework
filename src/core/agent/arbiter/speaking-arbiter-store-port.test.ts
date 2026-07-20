import { describe, expect, it } from 'vitest';

import {
  isEgressLeaseLive,
  isReservationActive,
  speakingCompletionIsSpeech,
  speakingCompletionReason,
  SPEAKING_EGRESS_LEASE_COMPLETIONS,
  SPEAKING_EGRESS_LEASE_SPEECH_COMPLETIONS,
  type SpeakingEgressLeaseCompletion,
} from './speaking-arbiter-store-port.js';

describe('speaking arbiter store port helpers', () => {
  it('maps each completion to its durable terminal reason', () => {
    expect(speakingCompletionReason('delivered')).toBe('delivered');
    expect(speakingCompletionReason('failed')).toBe('delivery_failure');
    expect(speakingCompletionReason('released')).toBe('silence');
    expect(speakingCompletionReason('overridden')).toBe('urgent_override');
  });

  it('counts only delivered and overridden as room speech (pressure-charging)', () => {
    expect(speakingCompletionIsSpeech('delivered')).toBe(true);
    expect(speakingCompletionIsSpeech('overridden')).toBe(true);
    // A delivery failure never reached the room; silence is an affirmative
    // non-utterance (bible §6.7) — neither charges pressure.
    expect(speakingCompletionIsSpeech('failed')).toBe(false);
    expect(speakingCompletionIsSpeech('released')).toBe(false);
  });

  it('keeps the speech-completion set a strict subset of all completions', () => {
    for (const completion of SPEAKING_EGRESS_LEASE_SPEECH_COMPLETIONS) {
      expect(SPEAKING_EGRESS_LEASE_COMPLETIONS).toContain(completion);
    }
    // Every completion resolves to a reason and a speech verdict — total coverage.
    for (const completion of SPEAKING_EGRESS_LEASE_COMPLETIONS) {
      expect(typeof speakingCompletionReason(completion)).toBe('string');
      expect(typeof speakingCompletionIsSpeech(completion)).toBe('boolean');
    }
  });

  it('treats a held lease as live only before its deadline', () => {
    expect(isEgressLeaseLive({ status: 'held', expiresAtMs: 100 }, 50)).toBe(true);
    // At and past the deadline the holder is presumed crashed: reclaimable.
    expect(isEgressLeaseLive({ status: 'held', expiresAtMs: 100 }, 100)).toBe(false);
    expect(isEgressLeaseLive({ status: 'held', expiresAtMs: 100 }, 150)).toBe(false);
    // Only a held lease can be live; any terminal state is never live.
    expect(isEgressLeaseLive({ status: 'delivered', expiresAtMs: 100 }, 50)).toBe(false);
    expect(isEgressLeaseLive({ status: 'expired', expiresAtMs: 100 }, 50)).toBe(false);
  });

  it('treats a reservation as active only while reserved and un-lapsed', () => {
    expect(isReservationActive({ status: 'reserved', expiresAtMs: 100 }, 50)).toBe(true);
    expect(isReservationActive({ status: 'reserved', expiresAtMs: 100 }, 100)).toBe(false);
    expect(isReservationActive({ status: 'released', expiresAtMs: 100 }, 50)).toBe(false);
    expect(isReservationActive({ status: 'expired', expiresAtMs: 100 }, 50)).toBe(false);
  });

  it('never charges pressure for a non-speech completion (exhaustive)', () => {
    const nonSpeech: SpeakingEgressLeaseCompletion[] = SPEAKING_EGRESS_LEASE_COMPLETIONS
      .filter((completion) => !speakingCompletionIsSpeech(completion));
    expect(nonSpeech).toEqual(['failed', 'released']);
  });
});
