import { describe, expect, it } from 'vitest';
import {
  accumulateSocialDesireSignal,
  applySocialDesireDampening,
  decayedSocialDesirePressure,
  evaluateSocialDesireEligibility,
  reinforceSocialDesireFromConcern,
  releaseSocialDesirePressure,
  resolveSocialDesireTierProfile,
  type SocialDesire,
  type SocialDesireFeltSignal,
  type SocialDesireLifecycleConfig,
} from './social-desire.js';
import {
  createContactSocialDesireTierSource,
  createInMemorySocialDesireBackend,
  createSocialDesireStorePort,
  recordSocialDesireFeltSignal,
} from './social-desire-store-port.js';
import type { ProactiveQuietHoursConfig } from './proactive-time-gate.js';
import type { RelationshipType } from '../contacts/types.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-07-06T12:00:00.000Z'); // Monday noon UTC

const CONFIG: SocialDesireLifecycleConfig = {
  baseGain: 0.15,
  pressureCap: 3,
  actionThreshold: 1,
  pressureFloor: 0.05,
  decay: { warmHalflifeMs: 72 * HOUR, repairHalflifeMs: 96 * HOUR },
  coolingOff: { warmMs: 1 * HOUR, repairMs: 12 * HOUR },
  releaseFactor: 0.25,
  dampeningFactor: 0.5,
  concernReinforcementGain: 0.3,
  maxReinforcedConcernIds: 16,
  tiers: {
    acquaintance: { gainMultiplier: 0.5, tickGapMs: 24 * HOUR },
    friend: { gainMultiplier: 1, tickGapMs: 8 * HOUR },
    family: { gainMultiplier: 1.4, tickGapMs: 4 * HOUR },
    partner: { gainMultiplier: 2, tickGapMs: 2 * HOUR },
    ai_companion: { gainMultiplier: 1, tickGapMs: 8 * HOUR },
  },
};

function signal(overrides: Partial<SocialDesireFeltSignal> = {}): SocialDesireFeltSignal {
  return { contactId: 'contact-a', orientation: 'warm', intensity: 1, ...overrides };
}

function buildDesire(
  tier: 'acquaintance' | 'friend' | 'family' | 'partner',
  ticks: Array<{ atMs: number; feltSignal: SocialDesireFeltSignal }>,
): SocialDesire {
  let desire: SocialDesire | null = null;
  for (const tick of ticks) {
    desire = accumulateSocialDesireSignal(desire, tick.feltSignal, tier, CONFIG, tick.atMs).desire;
  }
  if (!desire) throw new Error('expected desire to accumulate');
  return desire;
}

describe('tier gating', () => {
  it('accumulates nothing at all for stranger-tier contacts', () => {
    const result = accumulateSocialDesireSignal(null, signal(), 'stranger', CONFIG, T0);
    expect(result.outcome).toBe('tier_gated');
    expect(result.desire).toBeNull();
  });

  it('accumulates nothing for unknown or absent relationship types', () => {
    for (const tier of [null, undefined] as const) {
      const result = accumulateSocialDesireSignal(null, signal(), tier as RelationshipType | null | undefined, CONFIG, T0);
      expect(result.outcome).toBe('tier_gated');
      expect(result.desire).toBeNull();
    }
  });

  it('accumulates and becomes eligible for a canonical AI companion contact', () => {
    const first = accumulateSocialDesireSignal(null, signal(), 'ai_companion', CONFIG, T0);
    expect(first.outcome).toBe('created');
    expect(first.desire?.tierAtLastTick).toBe('ai_companion');

    let desire = first.desire;
    for (let tick = 1; tick <= 12; tick += 1) {
      desire = accumulateSocialDesireSignal(
        desire,
        signal(),
        'ai_companion',
        CONFIG,
        T0 + tick * 8 * HOUR,
      ).desire;
    }
    expect(evaluateSocialDesireEligibility({
      desire: desire!,
      relationshipType: 'ai_companion',
      nowMs: T0 + 12 * 8 * HOUR + HOUR,
    }, CONFIG).eligible).toBe(true);
  });

  it('a tier demotion to stranger stops further accumulation on an existing desire', () => {
    const desire = buildDesire('friend', [{ atMs: T0, feltSignal: signal() }]);
    const after = accumulateSocialDesireSignal(desire, signal(), 'stranger', CONFIG, T0 + 9 * HOUR);
    expect(after.outcome).toBe('tier_gated');
    expect(after.desire).toBe(desire); // untouched, not even recency movement
  });

  it('has no tier profile for stranger regardless of configuration', () => {
    expect(resolveSocialDesireTierProfile(CONFIG, 'stranger')).toBeNull();
    expect(resolveSocialDesireTierProfile(CONFIG, 'partner')).not.toBeNull();
  });

  it('scales accumulation rate by tier (partner builds faster than acquaintance)', () => {
    const partner = accumulateSocialDesireSignal(null, signal({ intensity: 0.8 }), 'partner', CONFIG, T0).desire!;
    const acquaintance = accumulateSocialDesireSignal(null, signal({ intensity: 0.8 }), 'acquaintance', CONFIG, T0).desire!;
    expect(partner.warmPressure).toBeCloseTo(0.15 * 0.8 * 2, 10);
    expect(acquaintance.warmPressure).toBeCloseTo(0.15 * 0.8 * 0.5, 10);
    expect(partner.warmPressure).toBeGreaterThan(acquaintance.warmPressure);
  });
});

describe('felt-state invariant (no timers, no felt state -> no accumulation)', () => {
  it('zero intensity accumulates nothing and creates nothing', () => {
    const result = accumulateSocialDesireSignal(null, signal({ intensity: 0 }), 'partner', CONFIG, T0);
    expect(result.outcome).toBe('no_felt_state');
    expect(result.desire).toBeNull();
  });

  it('zero intensity leaves an existing desire untouched', () => {
    const desire = buildDesire('partner', [{ atMs: T0, feltSignal: signal() }]);
    const result = accumulateSocialDesireSignal(desire, signal({ intensity: 0 }), 'partner', CONFIG, T0 + 3 * HOUR);
    expect(result.outcome).toBe('no_felt_state');
    expect(result.desire).toBe(desire);
  });

  it('rejects negative and non-finite intensities (fail closed)', () => {
    expect(() => accumulateSocialDesireSignal(null, signal({ intensity: -0.1 }), 'partner', CONFIG, T0)).toThrow();
    expect(() => accumulateSocialDesireSignal(null, signal({ intensity: Number.NaN }), 'partner', CONFIG, T0)).toThrow();
    expect(() => accumulateSocialDesireSignal(null, signal({ intensity: Number.POSITIVE_INFINITY }), 'partner', CONFIG, T0)).toThrow();
  });

  it('elapsed time alone only ever decays pressure, never grows it', () => {
    const desire = buildDesire('partner', [{ atMs: T0, feltSignal: signal() }]);
    const p0 = decayedSocialDesirePressure(desire, CONFIG, T0).total;
    const p1 = decayedSocialDesirePressure(desire, CONFIG, T0 + 24 * HOUR).total;
    const p2 = decayedSocialDesirePressure(desire, CONFIG, T0 + 240 * HOUR).total;
    expect(p1).toBeLessThan(p0);
    expect(p2).toBeLessThan(p1);
    // Half-life exactness: 72h warm half-life.
    expect(decayedSocialDesirePressure(desire, CONFIG, T0 + 72 * HOUR).warm).toBeCloseTo(desire.warmPressure / 2, 10);
  });

  it('clock skew (time before the anchor) yields no growth', () => {
    const desire = buildDesire('partner', [{ atMs: T0, feltSignal: signal() }]);
    expect(decayedSocialDesirePressure(desire, CONFIG, T0 - HOUR).total).toBe(desire.warmPressure);
  });
});

describe('accumulation, cap, and dampening math', () => {
  it('counted ticks strengthen the single desire and respect the tier cadence gap', () => {
    const first = accumulateSocialDesireSignal(null, signal(), 'partner', CONFIG, T0);
    expect(first.outcome).toBe('created');
    // Within the partner 2h gap: absorbed, no pressure added, recency updates.
    const absorbed = accumulateSocialDesireSignal(first.desire, signal(), 'partner', CONFIG, T0 + 1 * HOUR);
    expect(absorbed.outcome).toBe('absorbed');
    expect(absorbed.desire!.tickCount).toBe(1);
    expect(absorbed.desire!.absorbedSignalCount).toBe(1);
    expect(absorbed.desire!.lastWarmFeltAt).toBe(new Date(T0 + 1 * HOUR).toISOString());
    const absorbedTotal = absorbed.desire!.warmPressure + absorbed.desire!.repairPressure;
    expect(absorbedTotal).toBeLessThanOrEqual(first.desire!.warmPressure);
    // Past the gap: a counted tick adds pressure.
    const strengthened = accumulateSocialDesireSignal(absorbed.desire, signal(), 'partner', CONFIG, T0 + 3 * HOUR);
    expect(strengthened.outcome).toBe('strengthened');
    expect(strengthened.desire!.tickCount).toBe(2);
    expect(strengthened.desire!.warmPressure).toBeGreaterThan(absorbedTotal);
  });

  it('total pressure never exceeds the cap; a capped desire keeps ticking', () => {
    let desire: SocialDesire | null = null;
    for (let i = 0; i < 60; i += 1) {
      desire = accumulateSocialDesireSignal(desire, signal(), 'partner', CONFIG, T0 + i * 3 * HOUR).desire;
    }
    expect(desire!.warmPressure + desire!.repairPressure).toBeLessThanOrEqual(CONFIG.pressureCap + 1e-9);
    expect(desire!.tickCount).toBe(60);
  });

  it('the cap holds across mixed warm and repair components', () => {
    let desire: SocialDesire | null = null;
    for (let i = 0; i < 60; i += 1) {
      const orientation = i % 2 === 0 ? 'warm' : 'repair';
      desire = accumulateSocialDesireSignal(desire, signal({ orientation }), 'partner', CONFIG, T0 + i * 3 * HOUR).desire;
    }
    expect(desire!.warmPressure + desire!.repairPressure).toBeLessThanOrEqual(CONFIG.pressureCap + 1e-9);
  });

  it('dampening reduces pressure toward but not to zero, so the desire can rebuild', () => {
    const desire = buildDesire('partner', [
      { atMs: T0, feltSignal: signal() },
      { atMs: T0 + 3 * HOUR, feltSignal: signal() },
    ]);
    const dampened = applySocialDesireDampening(desire, CONFIG, T0 + 4 * HOUR);
    const before = decayedSocialDesirePressure(desire, CONFIG, T0 + 4 * HOUR).total;
    const after = decayedSocialDesirePressure(dampened, CONFIG, T0 + 4 * HOUR).total;
    expect(after).toBeCloseTo(before * CONFIG.dampeningFactor, 10);
    expect(after).toBeGreaterThan(0);
  });

  it('release drops most pressure but keeps the record and its history', () => {
    const desire = buildDesire('partner', [{ atMs: T0, feltSignal: signal() }]);
    const released = releaseSocialDesirePressure(desire, CONFIG, T0 + HOUR);
    expect(released.contactId).toBe(desire.contactId);
    expect(released.tickCount).toBe(desire.tickCount);
    const after = decayedSocialDesirePressure(released, CONFIG, T0 + HOUR).total;
    const before = decayedSocialDesirePressure(desire, CONFIG, T0 + HOUR).total;
    expect(after).toBeCloseTo(before * CONFIG.releaseFactor, 10);
  });
});

describe('coalescing (one durable desire per contact)', () => {
  it('further signals strengthen the same record instead of creating another', async () => {
    const store = createSocialDesireStorePort(createInMemorySocialDesireBackend());
    const tierSource = { resolveRelationshipTier: async () => 'partner' as RelationshipType };
    await recordSocialDesireFeltSignal(store, tierSource, CONFIG, signal(), T0);
    await recordSocialDesireFeltSignal(store, tierSource, CONFIG, signal(), T0 + 3 * HOUR);
    await recordSocialDesireFeltSignal(store, tierSource, CONFIG, signal({ orientation: 'repair' }), T0 + 6 * HOUR);
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.contactId).toBe('contact-a');
    expect(all[0]!.tickCount).toBe(3);
  });

  it('rejects applying a signal for one contact to another contact desire', () => {
    const desire = buildDesire('partner', [{ atMs: T0, feltSignal: signal() }]);
    expect(() => accumulateSocialDesireSignal(
      desire,
      signal({ contactId: 'contact-b' }),
      'partner',
      CONFIG,
      T0 + 3 * HOUR,
    )).toThrow(/coalescing/);
  });
});

describe('negative-origin (repair) desires', () => {
  it('sustained negative affect accumulates a first-class desire', () => {
    const desire = buildDesire('friend', [
      { atMs: T0, feltSignal: signal({ orientation: 'repair', intensity: 0.9 }) },
      { atMs: T0 + 9 * HOUR, feltSignal: signal({ orientation: 'repair', intensity: 0.9 }) },
    ]);
    expect(desire.repairPressure).toBeGreaterThan(0);
    expect(desire.warmPressure).toBe(0);
    expect(decayedSocialDesirePressure(desire, CONFIG, T0 + 9 * HOUR).dominantOrientation).toBe('repair');
  });

  it('repair desires wait through a longer cooling-off than warm desires', () => {
    // Two structurally identical desires above threshold, one warm, one repair.
    const mk = (orientation: 'warm' | 'repair'): SocialDesire => {
      let desire: SocialDesire | null = null;
      for (let i = 0; i < 8; i += 1) {
        desire = accumulateSocialDesireSignal(desire, signal({ orientation }), 'partner', CONFIG, T0 + i * 3 * HOUR).desire;
      }
      return desire!;
    };
    const lastFeltMs = T0 + 7 * 3 * HOUR;
    const warm = mk('warm');
    const repair = mk('repair');

    // 2h after the last signal: warm cooling-off (1h) has settled, repair (12h) has not.
    const probeMs = lastFeltMs + 2 * HOUR;
    const warmEligibility = evaluateSocialDesireEligibility(
      { desire: warm, relationshipType: 'partner', nowMs: probeMs },
      CONFIG,
    );
    const repairEligibility = evaluateSocialDesireEligibility(
      { desire: repair, relationshipType: 'partner', nowMs: probeMs },
      CONFIG,
    );
    expect(warmEligibility.eligible).toBe(true);
    expect(repairEligibility.eligible).toBe(false);
    expect(repairEligibility.eligible === false && repairEligibility.reason).toBe('cooling_off');
    if (!repairEligibility.eligible) {
      expect(repairEligibility.nextEligibleAtMs).toBe(lastFeltMs + CONFIG.coolingOff.repairMs);
    }
    // After the repair cooling-off passes, it becomes eligible too.
    const later = evaluateSocialDesireEligibility(
      { desire: repair, relationshipType: 'partner', nowMs: lastFeltMs + 13 * HOUR },
      CONFIG,
    );
    expect(later.eligible).toBe(true);
  });

  it('an absorbed repair signal restarts the cooling-off clock', () => {
    let desire: SocialDesire | null = null;
    for (let i = 0; i < 8; i += 1) {
      desire = accumulateSocialDesireSignal(desire, signal({ orientation: 'repair' }), 'partner', CONFIG, T0 + i * 3 * HOUR).desire;
    }
    const lastTickMs = T0 + 7 * 3 * HOUR;
    // A fresh flash of anger inside the cadence gap: no pressure, but still felt.
    const absorbed = accumulateSocialDesireSignal(desire, signal({ orientation: 'repair' }), 'partner', CONFIG, lastTickMs + HOUR);
    expect(absorbed.outcome).toBe('absorbed');
    const eligibility = evaluateSocialDesireEligibility(
      { desire: absorbed.desire!, relationshipType: 'partner', nowMs: lastTickMs + 12.5 * HOUR },
      CONFIG,
    );
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.eligible === false && eligibility.reason).toBe('cooling_off');
  });

  it('config invariant: repair cooling-off must exceed warm cooling-off', () => {
    const broken = { ...CONFIG, coolingOff: { warmMs: 12 * HOUR, repairMs: HOUR } };
    expect(() => accumulateSocialDesireSignal(null, signal(), 'partner', broken, T0)).toThrow(/cool/i);
  });
});

describe('eligibility computation', () => {
  const quietHours: ProactiveQuietHoursConfig = {
    enabled: true,
    startLocalTime: '22:00',
    endLocalTime: '08:00',
    timeZone: 'UTC',
  };

  function eligibleDesire(): SocialDesire {
    let desire: SocialDesire | null = null;
    for (let i = 0; i < 8; i += 1) {
      desire = accumulateSocialDesireSignal(desire, signal(), 'partner', CONFIG, T0 + i * 3 * HOUR).desire;
    }
    return desire!;
  }

  it('a below-threshold desire is not eligible', () => {
    const desire = buildDesire('partner', [{ atMs: T0, feltSignal: signal({ intensity: 0.5 }) }]);
    const eligibility = evaluateSocialDesireEligibility(
      { desire, relationshipType: 'partner', nowMs: T0 + 2 * HOUR },
      CONFIG,
    );
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.eligible === false && eligibility.reason).toBe('below_threshold');
  });

  it('a current-tier demotion flips an accumulated desire ineligible', () => {
    const desire = eligibleDesire();
    const nowMs = T0 + 8 * 3 * HOUR;
    const asPartner = evaluateSocialDesireEligibility({ desire, relationshipType: 'partner', nowMs }, CONFIG);
    expect(asPartner.eligible).toBe(true);
    const asStranger = evaluateSocialDesireEligibility({ desire, relationshipType: 'stranger', nowMs }, CONFIG);
    expect(asStranger.eligible).toBe(false);
    expect(asStranger.eligible === false && asStranger.reason).toBe('tier_not_eligible');
  });

  it('quiet hours block eligibility and it flips back the moment they end', () => {
    const desire = eligibleDesire();
    // 23:00 UTC — inside the 22:00-08:00 quiet window, well past cooling-off.
    const nightMs = Date.parse('2026-07-07T23:00:00.000Z');
    const night = evaluateSocialDesireEligibility(
      { desire, relationshipType: 'partner', nowMs: nightMs, quietHours },
      CONFIG,
    );
    expect(night.eligible).toBe(false);
    expect(night.eligible === false && night.reason).toBe('quiet_hours');
    if (!night.eligible) {
      expect(night.nextEligibleAtMs).toBe(Date.parse('2026-07-08T08:00:00.000Z'));
    }
    // Same desire, unchanged, right when quiet hours end: eligible.
    const morning = evaluateSocialDesireEligibility(
      { desire, relationshipType: 'partner', nowMs: Date.parse('2026-07-08T08:00:00.000Z'), quietHours },
      CONFIG,
    );
    expect(morning.eligible).toBe(true);
  });

  it('keeps ticking capped during quiet hours with zero side effects', () => {
    // Pure functions only: accumulating during quiet hours cannot call an LLM
    // or send anything (there is no I/O surface), and the cap still holds.
    let desire: SocialDesire | null = eligibleDesire();
    const nightStart = Date.parse('2026-07-07T22:30:00.000Z');
    for (let i = 0; i < 4; i += 1) {
      desire = accumulateSocialDesireSignal(desire, signal(), 'partner', CONFIG, nightStart + i * 2.5 * HOUR).desire;
    }
    expect(desire!.warmPressure + desire!.repairPressure).toBeLessThanOrEqual(CONFIG.pressureCap + 1e-9);
    const stillNight = evaluateSocialDesireEligibility(
      { desire: desire!, relationshipType: 'partner', nowMs: Date.parse('2026-07-08T07:00:00.000Z'), quietHours },
      CONFIG,
    );
    expect(stillNight.eligible).toBe(false);
    expect(stillNight.eligible === false && stillNight.reason).toBe('quiet_hours');
  });

  it('evaluating eligibility never mutates the desire', () => {
    const desire = eligibleDesire();
    const frozen = JSON.stringify(desire);
    evaluateSocialDesireEligibility(
      { desire, relationshipType: 'partner', nowMs: T0 + 30 * HOUR, quietHours },
      CONFIG,
    );
    expect(JSON.stringify(desire)).toBe(frozen);
  });
});

describe('concern reinforcement (one-way, never manufactures)', () => {
  it('a relevant concern boosts an existing desire once', () => {
    const desire = buildDesire('partner', [
      { atMs: T0, feltSignal: signal() },
      { atMs: T0 + 3 * HOUR, feltSignal: signal() },
    ]);
    const nowMs = T0 + 4 * HOUR;
    const before = decayedSocialDesirePressure(desire, CONFIG, nowMs).total;
    const first = reinforceSocialDesireFromConcern(desire, { concernId: 'concern-1', relevance: 1 }, CONFIG, nowMs);
    expect(first.outcome).toBe('reinforced');
    const after = decayedSocialDesirePressure(first.desire, CONFIG, nowMs).total;
    expect(after).toBeCloseTo(before * (1 + CONFIG.concernReinforcementGain), 8);
    // The same concern cannot reinforce again.
    const second = reinforceSocialDesireFromConcern(first.desire, { concernId: 'concern-1', relevance: 1 }, CONFIG, nowMs);
    expect(second.outcome).toBe('already_reinforced');
    expect(second.desire).toBe(first.desire);
  });

  it('never resurrects a dormant desire (desires are not manufactured from concerns)', () => {
    const desire = buildDesire('partner', [{ atMs: T0, feltSignal: signal({ intensity: 0.1 }) }]);
    // Months later the pressure has fully dissipated.
    const nowMs = T0 + 2000 * HOUR;
    expect(decayedSocialDesirePressure(desire, CONFIG, nowMs).total).toBeLessThan(CONFIG.pressureFloor);
    const result = reinforceSocialDesireFromConcern(desire, { concernId: 'concern-2', relevance: 1 }, CONFIG, nowMs);
    expect(result.outcome).toBe('dormant');
    expect(result.desire).toBe(desire);
  });

  it('reinforcement respects the pressure cap', () => {
    let desire: SocialDesire | null = null;
    for (let i = 0; i < 60; i += 1) {
      desire = accumulateSocialDesireSignal(desire, signal(), 'partner', CONFIG, T0 + i * 3 * HOUR).desire;
    }
    const nowMs = T0 + 60 * 3 * HOUR;
    const result = reinforceSocialDesireFromConcern(desire!, { concernId: 'concern-3', relevance: 1 }, CONFIG, nowMs);
    expect(result.outcome).toBe('reinforced');
    expect(result.desire.warmPressure + result.desire.repairPressure).toBeLessThanOrEqual(CONFIG.pressureCap + 1e-9);
  });
});

describe('store helper and tier source', () => {
  it('resolves the live tier per signal so promotions start accumulation', async () => {
    const store = createSocialDesireStorePort(createInMemorySocialDesireBackend());
    let tier: RelationshipType = 'stranger';
    const tierSource = { resolveRelationshipTier: async () => tier };

    const gated = await recordSocialDesireFeltSignal(store, tierSource, CONFIG, signal(), T0);
    expect(gated.outcome).toBe('tier_gated');
    expect(await store.getByContactId('contact-a')).toBeNull();

    tier = 'acquaintance'; // end-of-day analysis promoted the contact
    const created = await recordSocialDesireFeltSignal(store, tierSource, CONFIG, signal(), T0 + HOUR);
    expect(created.outcome).toBe('created');
    expect(await store.getByContactId('contact-a')).not.toBeNull();
  });

  it('contact tier source reads relationshipType and fails closed on unknown contacts', async () => {
    const tierSource = createContactSocialDesireTierSource({
      getById: (id) => (id === 'known' ? { relationshipType: 'friend' as RelationshipType } : undefined),
    });
    expect(await tierSource.resolveRelationshipTier('known')).toBe('friend');
    expect(await tierSource.resolveRelationshipTier('unknown')).toBeNull();
  });
});
