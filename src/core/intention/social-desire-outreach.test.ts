import { describe, expect, it, vi } from 'vitest';
import {
  buildSocialDesireOutboundCandidate,
  createSocialDesireConsentLedger,
  createSocialDesireOutboundRuntime,
  runSocialDesireOutreachOnce,
  type SocialDesireConsentEvaluator,
  type SocialDesireDeliveryChannel,
  type SocialDesireOutreachDeps,
} from './social-desire-outreach.js';
import {
  accumulateSocialDesireSignal,
  decayedSocialDesirePressure,
  type SocialDesire,
  type SocialDesireLifecycleConfig,
} from './social-desire.js';
import {
  createInMemorySocialDesireBackend,
  createSocialDesireStorePort,
  type SocialDesireStorePort,
} from './social-desire-store-port.js';
import { INTENTION_OUTBOUND_MESSAGE_ACTION_KIND } from './appraisal/types.js';
import type { ProactiveQuietHoursConfig } from './proactive-time-gate.js';
import type { RelationshipType } from '../contacts/types.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-07-06T15:00:00.000Z'); // Monday afternoon UTC

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

// A window covering T0 (15:00 UTC) so the desire is quiet-hours blocked.
const QUIET_HOURS: ProactiveQuietHoursConfig = {
  enabled: true,
  startLocalTime: '14:00',
  endLocalTime: '20:00',
  timeZone: 'UTC',
};

/** An eligible partner-tier desire: over threshold, warm cooling-off settled. */
function eligibleDesire(
  contactId = 'contact-1',
  orientation: 'warm' | 'repair' = 'warm',
): SocialDesire {
  let desire: SocialDesire | null = null;
  // Partner cadence (2h gap): seven full-intensity ticks clear the decayed
  // action threshold; the last felt signal (16h back) clears both cooling-off
  // windows (warm 1h, repair 12h).
  for (const offset of [-64 * HOUR, -56 * HOUR, -48 * HOUR, -40 * HOUR, -32 * HOUR, -24 * HOUR, -16 * HOUR]) {
    desire = accumulateSocialDesireSignal(
      desire,
      { contactId, orientation, intensity: 1 },
      'partner',
      CONFIG,
      T0 + offset,
    ).desire;
  }
  if (!desire) throw new Error('expected desire to accumulate');
  return desire;
}

function makeStore(...desires: SocialDesire[]): SocialDesireStorePort {
  return createSocialDesireStorePort(createInMemorySocialDesireBackend(desires));
}

function messageEvaluator(content = 'hey, I was thinking of you'): SocialDesireConsentEvaluator {
  return { evaluate: vi.fn(async () => ({ action: 'message' as const, content })) };
}

function choiceEvaluator(action: 'defer' | 'decline', reason?: string): SocialDesireConsentEvaluator {
  return { evaluate: vi.fn(async () => ({ action, ...(reason ? { reason } : {}) })) };
}

function primaryChannel(): SocialDesireDeliveryChannel {
  return {
    channelId: 'dm-primary',
    channelType: 'discord',
    contactName: 'Morgan',
    companionTarget: false,
  };
}

function baseDeps(
  store: SocialDesireStorePort,
  consentEvaluator: SocialDesireConsentEvaluator,
  overrides: Partial<SocialDesireOutreachDeps> = {},
): SocialDesireOutreachDeps {
  return {
    store,
    lifecycle: CONFIG,
    tierSource: { resolveRelationshipTier: async () => 'partner' as RelationshipType },
    consentEvaluator,
    consents: createSocialDesireConsentLedger({ ttlMs: 30 * 60 * 1000 }),
    maxConsentMomentsPerRun: 1,
    resolveDeliveryChannel: async () => primaryChannel(),
    isBudgetExhausted: () => false,
    ...overrides,
  };
}

describe('social-desire consent ledger', () => {
  it('verifies only its own live consents and enforces single use', () => {
    const ledger = createSocialDesireConsentLedger({ ttlMs: 1_000 });
    const consent = ledger.issue({ contactId: 'contact-1', orientation: 'warm', nowMs: T0 });
    const binding = {
      actionId: 'action-1',
      dedupeKey: 'dedupe-1',
      channelId: 'dm-primary',
      channelType: 'discord' as const,
      content: 'hello there',
      orientation: 'warm' as const,
      reason: 'social_desire:warm',
      actionFingerprint: 'fingerprint-1',
    };
    ledger.bind(consent.consentId, binding);

    expect(ledger.verify({
      consentId: consent.consentId,
      contactId: 'contact-1',
      nowMs: T0 + 10,
      ...binding,
    })).toMatchObject({
      contactId: 'contact-1',
      orientation: 'warm',
    });
    // Every durable action field is part of the consent capability.
    for (const mutation of [
      { actionId: 'action-2' },
      { dedupeKey: 'dedupe-2' },
      { channelId: 'dm-other' },
      { channelType: 'whisper' as const },
      { content: 'changed content' },
      { orientation: 'repair' as const },
      { reason: 'social_desire:repair' },
      { actionFingerprint: 'fingerprint-2' },
      { contactId: 'contact-2' },
    ]) {
      expect(ledger.verify({
        consentId: consent.consentId,
        contactId: 'contact-1',
        nowMs: T0 + 10,
        ...binding,
        ...mutation,
      })).toBeNull();
    }
    expect(ledger.verify({
      consentId: 'forged-id',
      contactId: 'contact-1',
      nowMs: T0,
      ...binding,
    })).toBeNull();
    expect(ledger.verify({
      consentId: consent.consentId,
      contactId: 'contact-1',
      nowMs: T0 + 1_000,
      ...binding,
    })).toBeNull();

    ledger.consume(consent.consentId);
    expect(ledger.verify({
      consentId: consent.consentId,
      contactId: 'contact-1',
      nowMs: T0 + 10,
      ...binding,
    })).toBeNull();
  });

  it('tracks live consents per contact for in-flight dedupe', () => {
    const ledger = createSocialDesireConsentLedger({ ttlMs: 1_000 });
    expect(ledger.hasLiveConsentForContact('contact-1', T0)).toBe(false);
    const consent = ledger.issue({ contactId: 'contact-1', orientation: 'repair', nowMs: T0 });
    expect(ledger.hasLiveConsentForContact('contact-1', T0 + 10)).toBe(true);
    expect(ledger.hasLiveConsentForContact('contact-2', T0 + 10)).toBe(false);
    ledger.consume(consent.consentId);
    expect(ledger.hasLiveConsentForContact('contact-1', T0 + 10)).toBe(false);
  });
});

describe('runSocialDesireOutreachOnce', () => {
  it('accepted consent produces exactly one outbound candidate with verifiable provenance', async () => {
    const store = makeStore(eligibleDesire());
    const evaluator = messageEvaluator('missed you today');
    const deps = baseDeps(store, evaluator);
    const result = await runSocialDesireOutreachOnce(deps, T0);

    expect(result.consentMomentsEvaluated).toBe(1);
    expect(result.produced).toHaveLength(1);
    const produced = result.produced[0]!;
    expect(produced.candidate.kind).toBe(INTENTION_OUTBOUND_MESSAGE_ACTION_KIND);
    expect(produced.candidate.payload).toMatchObject({
      channelId: 'dm-primary',
      channelType: 'discord',
      content: 'missed you today',
      reason: 'social_desire:warm',
      socialDesire: {
        contactId: 'contact-1',
        consentId: produced.consentId,
        orientation: 'warm',
      },
    });
    // The minted consent is live and bound to the desire's contact.
    expect(deps.consents.hasLiveConsentForContact('contact-1', T0 + 10)).toBe(true);
    // Producing a candidate never releases pressure — that happens on dispatch.
    const stored = await store.getByContactId('contact-1');
    expect(decayedSocialDesirePressure(stored!, CONFIG, T0).total)
      .toBeCloseTo(decayedSocialDesirePressure(eligibleDesire(), CONFIG, T0).total, 10);
  });

  it('defer dampens the desire and sends nothing', async () => {
    const desire = eligibleDesire();
    const before = decayedSocialDesirePressure(desire, CONFIG, T0).total;
    const store = makeStore(desire);
    const result = await runSocialDesireOutreachOnce(
      baseDeps(store, choiceEvaluator('defer', 'still settling')),
      T0,
    );

    expect(result.produced).toHaveLength(0);
    expect(result.deferred).toEqual([
      { contactId: 'contact-1', reason: 'still settling', dampenedPressure: expect.any(Number) },
    ]);
    const stored = await store.getByContactId('contact-1');
    const after = decayedSocialDesirePressure(stored!, CONFIG, T0).total;
    expect(after).toBeCloseTo(before * CONFIG.dampeningFactor, 10);
    expect(after).toBeGreaterThan(0);
  });

  it('decline dampens the desire and sends nothing', async () => {
    const desire = eligibleDesire();
    const before = decayedSocialDesirePressure(desire, CONFIG, T0).total;
    const store = makeStore(desire);
    const result = await runSocialDesireOutreachOnce(
      baseDeps(store, choiceEvaluator('decline')),
      T0,
    );

    expect(result.produced).toHaveLength(0);
    expect(result.declined).toEqual([
      { contactId: 'contact-1', dampenedPressure: expect.any(Number) },
    ]);
    const stored = await store.getByContactId('contact-1');
    expect(decayedSocialDesirePressure(stored!, CONFIG, T0).total)
      .toBeCloseTo(before * CONFIG.dampeningFactor, 10);
  });

  it('offers a repair-origin desire the same consent choice set', async () => {
    // Repair cooling-off is 12h; last felt signal is 16h back, so eligible.
    const store = makeStore(eligibleDesire('contact-1', 'repair'));
    const evaluator = choiceEvaluator('defer', 'want to cool off longer');
    const result = await runSocialDesireOutreachOnce(baseDeps(store, evaluator), T0);

    expect(evaluator.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      orientation: 'repair',
    }));
    expect(result.deferred).toHaveLength(1);

    // And a repair desire can be consented to as a message like any warm one.
    const store2 = makeStore(eligibleDesire('contact-1', 'repair'));
    const accepted = await runSocialDesireOutreachOnce(
      baseDeps(store2, messageEvaluator('I keep coming back to what happened — can we talk it over?')),
      T0,
    );
    expect(accepted.produced).toHaveLength(1);
    expect(accepted.produced[0]!.orientation).toBe('repair');
    expect(accepted.produced[0]!.candidate.payload).toMatchObject({ reason: 'social_desire:repair' });
  });

  it('makes zero LLM calls while quiet hours block eligibility', async () => {
    const store = makeStore(eligibleDesire());
    const evaluator = messageEvaluator();
    const result = await runSocialDesireOutreachOnce(
      baseDeps(store, evaluator, { quietHours: QUIET_HOURS }),
      T0,
    );

    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(result.consentMomentsEvaluated).toBe(0);
    expect(result.produced).toHaveLength(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({ contactId: 'contact-1', reason: 'quiet_hours' }),
    ]);
    // Quiet hours never dampen: the desire is intact when the window ends.
    const stored = await store.getByContactId('contact-1');
    expect(decayedSocialDesirePressure(stored!, CONFIG, T0).total).toBeGreaterThan(CONFIG.actionThreshold);
  });

  it('budget exhaustion is a structured skip that preserves pressure and burns no LLM call', async () => {
    const store = makeStore(eligibleDesire());
    const evaluator = messageEvaluator();
    const result = await runSocialDesireOutreachOnce(
      baseDeps(store, evaluator, { isBudgetExhausted: () => true }),
      T0,
    );

    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([{ contactId: 'contact-1', reason: 'budget_exhausted' }]);
    const stored = await store.getByContactId('contact-1');
    expect(decayedSocialDesirePressure(stored!, CONFIG, T0).total)
      .toBeCloseTo(decayedSocialDesirePressure(eligibleDesire(), CONFIG, T0).total, 10);
  });

  it('skips the consent moment while a prior consent is still in flight', async () => {
    const store = makeStore(eligibleDesire());
    const evaluator = messageEvaluator();
    const deps = baseDeps(store, evaluator);
    deps.consents.issue({ contactId: 'contact-1', orientation: 'warm', nowMs: T0 });

    const result = await runSocialDesireOutreachOnce(deps, T0);
    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([{ contactId: 'contact-1', reason: 'consent_pending' }]);
  });

  it('fails closed without a policy-approved delivery channel and keeps pressure', async () => {
    const store = makeStore(eligibleDesire());
    const evaluator = messageEvaluator();
    const result = await runSocialDesireOutreachOnce(
      baseDeps(store, evaluator, { resolveDeliveryChannel: async () => null }),
      T0,
    );

    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(result.blocked).toEqual([{ contactId: 'contact-1', reason: 'no_delivery_channel' }]);
    const stored = await store.getByContactId('contact-1');
    expect(decayedSocialDesirePressure(stored!, CONFIG, T0).total).toBeGreaterThan(CONFIG.actionThreshold);
  });

  it('re-resolves the relationship tier live and skips demoted contacts', async () => {
    const store = makeStore(eligibleDesire());
    const evaluator = messageEvaluator();
    const result = await runSocialDesireOutreachOnce(
      baseDeps(store, evaluator, {
        tierSource: { resolveRelationshipTier: async () => 'stranger' as RelationshipType },
      }),
      T0,
    );

    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([
      expect.objectContaining({ contactId: 'contact-1', reason: 'tier_not_eligible' }),
    ]);
  });

  it('reports below-threshold desires as structured skips without an LLM call', async () => {
    const desire = eligibleDesire();
    const store = makeStore({
      ...desire,
      warmPressure: CONFIG.actionThreshold / 10,
      repairPressure: 0,
    });
    const evaluator = messageEvaluator();

    const result = await runSocialDesireOutreachOnce(baseDeps(store, evaluator), T0);

    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([
      { contactId: 'contact-1', reason: 'below_threshold' },
    ]);
  });

  it('dampens on an accepted consent with blank content instead of producing an action', async () => {
    const desire = eligibleDesire();
    const before = decayedSocialDesirePressure(desire, CONFIG, T0).total;
    const store = makeStore(desire);
    const result = await runSocialDesireOutreachOnce(
      baseDeps(store, messageEvaluator('   ')),
      T0,
    );

    expect(result.produced).toHaveLength(0);
    expect(result.blocked).toEqual([{ contactId: 'contact-1', reason: 'empty_consent_content' }]);
    const stored = await store.getByContactId('contact-1');
    expect(decayedSocialDesirePressure(stored!, CONFIG, T0).total)
      .toBeCloseTo(before * CONFIG.dampeningFactor, 10);
  });

  it('caps consent moments per run at the configured limit, strongest desire first', async () => {
    const strong = eligibleDesire('contact-strong');
    const weaker = eligibleDesire('contact-weak');
    // Weaken the second desire so ordering is deterministic.
    const weakened = { ...weaker, warmPressure: weaker.warmPressure * 0.6 };
    const store = makeStore(strong, weakened);
    const evaluator = messageEvaluator();
    const result = await runSocialDesireOutreachOnce(baseDeps(store, evaluator), T0);

    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
    expect(result.produced).toHaveLength(1);
    expect(result.produced[0]!.contactId).toBe('contact-strong');
  });

  it('reserves durable-budget capacity for messages consented earlier in the same run', async () => {
    const store = makeStore(
      eligibleDesire('contact-a'),
      eligibleDesire('contact-b'),
      eligibleDesire('contact-c'),
    );
    const evaluator = messageEvaluator();
    const isBudgetExhausted = vi.fn((...[, reservedConsentCount]: [number, number?]) => (
      1 + (reservedConsentCount ?? 0) >= 2
    ));

    const result = await runSocialDesireOutreachOnce(
      baseDeps(store, evaluator, {
        maxConsentMomentsPerRun: 3,
        isBudgetExhausted,
      }),
      T0,
    );

    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
    expect(result.produced).toHaveLength(1);
    expect(result.skipped).toEqual([
      { contactId: 'contact-b', reason: 'budget_exhausted' },
      { contactId: 'contact-c', reason: 'budget_exhausted' },
    ]);
    expect(isBudgetExhausted).toHaveBeenCalledWith(T0, 1);
  });
});

describe('createSocialDesireOutboundRuntime', () => {
  it('verifies consents against the ledger, enforces the send budget, and settles pressure', async () => {
    const desire = eligibleDesire();
    const store = makeStore(desire);
    const consents = createSocialDesireConsentLedger({ ttlMs: 60_000 });
    let recentSends = 0;
    const runtime = createSocialDesireOutboundRuntime({
      store,
      lifecycle: CONFIG,
      consents,
      budget: { maxSendsPerWindow: 2, windowMs: 24 * HOUR },
      countRecentSends: () => recentSends,
    });

    const consent = consents.issue({ contactId: 'contact-1', orientation: 'warm', nowMs: T0 });
    const binding = {
      actionId: 'action-1',
      dedupeKey: 'dedupe-1',
      channelId: 'dm-primary',
      channelType: 'discord' as const,
      content: 'hello',
      orientation: 'warm' as const,
      reason: 'social_desire:warm',
      actionFingerprint: 'fingerprint-1',
    };
    consents.bind(consent.consentId, binding);
    expect(runtime.verifyConsent({
      consentId: consent.consentId,
      contactId: 'contact-1',
      nowMs: T0,
      ...binding,
    })).toBe(true);
    expect(runtime.verifyConsent({
      consentId: 'forged',
      contactId: 'contact-1',
      nowMs: T0,
      ...binding,
    })).toBe(false);
    expect(await runtime.hasDesire('contact-1')).toBe(true);
    expect(await runtime.hasDesire('contact-unknown')).toBe(false);

    expect(runtime.isBudgetExhausted(T0)).toBe(false);
    expect(runtime.isBudgetExhausted(T0, 1)).toBe(false);
    recentSends = 2;
    expect(runtime.isBudgetExhausted(T0)).toBe(true);
    expect(() => runtime.isBudgetExhausted(T0, -1)).toThrow(
      'Social desire outbound budget requires a non-negative reservedSendCount',
    );

    const before = decayedSocialDesirePressure(desire, CONFIG, T0).total;
    await expect(runtime.settle({
      settlementId: 'action-1',
      contactId: 'contact-1',
      disposition: 'sent',
      nowMs: T0,
    })).resolves.toBe('released');
    const released = await store.getByContactId('contact-1');
    expect(decayedSocialDesirePressure(released!, CONFIG, T0).total)
      .toBeCloseTo(before * CONFIG.releaseFactor, 10);

    await expect(runtime.settle({
      settlementId: 'action-1',
      contactId: 'contact-1',
      disposition: 'sent',
      nowMs: T0,
    })).resolves.toBe('already_settled');
    expect(decayedSocialDesirePressure((await store.getByContactId('contact-1'))!, CONFIG, T0).total)
      .toBeCloseTo(before * CONFIG.releaseFactor, 10);

    await expect(runtime.settle({
      settlementId: 'action-2',
      contactId: 'contact-1',
      disposition: 'terminal_block',
      nowMs: T0,
    })).resolves.toBe('dampened');
    const dampened = await store.getByContactId('contact-1');
    expect(decayedSocialDesirePressure(dampened!, CONFIG, T0).total)
      .toBeCloseTo(before * CONFIG.releaseFactor * CONFIG.dampeningFactor, 10);

    await expect(runtime.settle({
      settlementId: 'action-missing',
      contactId: 'contact-missing',
      disposition: 'sent',
      nowMs: T0,
    })).resolves.toBe('missing');
  });
});

describe('buildSocialDesireOutboundCandidate', () => {
  it('binds the action dedupe key to the consent for structural exactly-once dispatch', () => {
    const ledger = createSocialDesireConsentLedger({ ttlMs: 60_000 });
    const consent = ledger.issue({ contactId: 'contact-1', orientation: 'warm', nowMs: T0 });
    const candidate = buildSocialDesireOutboundCandidate({
      consent,
      content: 'hello',
      channelId: 'dm-primary',
      channelType: 'discord',
    });
    expect(candidate.dedupeKey).toBe(
      `${INTENTION_OUTBOUND_MESSAGE_ACTION_KIND}:social-desire:contact-1:${consent.consentId}`,
    );
    expect(candidate.maxRetries).toBe(1);
  });
});
