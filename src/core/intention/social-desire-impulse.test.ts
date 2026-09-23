import { describe, expect, it } from 'vitest';
import { DEFAULT_SOCIAL_DESIRE_CONFIG } from '../../system/config/scheduler-config/social-desire.js';
import { applySocialDesireImpulseGain } from './social-desire-impulse.js';
import {
  decayedSocialDesirePressure,
  evaluateSocialDesireEligibility,
  type SocialDesire,
} from './social-desire.js';

const LIFECYCLE = DEFAULT_SOCIAL_DESIRE_CONFIG.lifecycle;
const T0 = Date.parse('2026-09-23T15:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function desire(contactId: string, warmPressure: number): SocialDesire {
  const at = new Date(T0).toISOString();
  return {
    contactId,
    warmPressure,
    repairPressure: 0,
    pressureAnchorAt: at,
    lastWarmFeltAt: new Date(T0 - 6 * HOUR).toISOString(),
    lastWarmTickAt: new Date(T0 - 6 * HOUR).toISOString(),
    tickCount: 3,
    absorbedSignalCount: 0,
    tierAtLastTick: 'friend',
    reinforcedConcernIds: [],
    createdAt: at,
  };
}

describe('applySocialDesireImpulseGain', () => {
  it('adds gain per contact in proportion to each live desire and never creates or revives one', () => {
    const boosts = applySocialDesireImpulseGain(
      [desire('strong', 0.4), desire('half', 0.2), desire('dormant', 0.01)],
      { confidence: 0.5, gain: 0.4 },
      LIFECYCLE,
      T0,
    );
    expect(boosts.map(boost => boost.desire.contactId)).toEqual(['strong', 'half']);
    expect(boosts[0]!.added).toBeCloseTo(0.2, 10);
    expect(boosts[1]!.added).toBeCloseTo(0.1, 10);
    // An impulse does not reset the contact's cooling-off anchor.
    expect(boosts[0]!.desire.lastWarmFeltAt).toBe(new Date(T0 - 6 * HOUR).toISOString());
  });

  it('lets a felt impulse carry a friend-tier steady state over the retuned action threshold', () => {
    // Friend steady state under the retuned defaults: ~0.47 (see config math).
    const [boost] = applySocialDesireImpulseGain(
      [desire('friend', 0.47)],
      { confidence: 0.8, gain: DEFAULT_SOCIAL_DESIRE_CONFIG.impulse.gain },
      LIFECYCLE,
      T0,
    );
    const eligibility = evaluateSocialDesireEligibility(
      { desire: boost!.desire, relationshipType: 'friend', nowMs: T0 },
      LIFECYCLE,
    );
    expect(eligibility.eligible).toBe(true);
  });

  it('respects the pressure cap and rejects malformed impulses', () => {
    const [capped] = applySocialDesireImpulseGain(
      [desire('full', LIFECYCLE.pressureCap - 0.05)],
      { confidence: 1, gain: 5 },
      LIFECYCLE,
      T0,
    );
    expect(decayedSocialDesirePressure(capped!.desire, LIFECYCLE, T0).total)
      .toBeCloseTo(LIFECYCLE.pressureCap, 10);
    expect(() => applySocialDesireImpulseGain([], { confidence: 2, gain: 1 }, LIFECYCLE, T0))
      .toThrow(/confidence/);
    expect(() => applySocialDesireImpulseGain([], { confidence: 1, gain: -1 }, LIFECYCLE, T0))
      .toThrow(/gain/);
  });
});
