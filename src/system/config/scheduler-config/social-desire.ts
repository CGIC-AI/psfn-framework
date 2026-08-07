import { isRecord } from '../../../shared/utils/types.js';
import { assertNoUnknownKeys } from '../validators.js';
import {
  toBoolean,
  toInterval,
  toNumberAtLeast,
  toPositiveInteger,
  toUnitFactor,
} from './primitives.js';

/** Per-relationship-tier social-desire accumulation profile (bead oth4.1). */
interface SocialDesireTierProfileConfig {
  /** Multiplier on counted-tick pressure increments for this tier. */
  gainMultiplier: number;
  /** Minimum spacing between counted accumulation ticks (deterministic throttle). */
  tickGapMs: number;
}

/**
 * Deterministic social-desire lifecycle math config (bead oth4.1). Structurally
 * identical to SocialDesireLifecycleConfig in src/core/intention/social-desire.ts
 * (the weighted-thought settings/config pairing pattern). Tiers cover ONLY the
 * accumulating relationships — stranger/public tiers are hard-excluded in code
 * and cannot be configured to accumulate.
 */
interface SocialDesireLifecycleSettings {
  baseGain: number;
  pressureCap: number;
  actionThreshold: number;
  pressureFloor: number;
  decay: { warmHalflifeMs: number; repairHalflifeMs: number };
  /** repairMs MUST exceed warmMs: negative-origin desires cool off longer. */
  coolingOff: { warmMs: number; repairMs: number };
  releaseFactor: number;
  dampeningFactor: number;
  concernReinforcementGain: number;
  maxReinforcedConcernIds: number;
  tiers: {
    acquaintance: SocialDesireTierProfileConfig;
    friend: SocialDesireTierProfileConfig;
    family: SocialDesireTierProfileConfig;
    partner: SocialDesireTierProfileConfig;
    ai_companion: SocialDesireTierProfileConfig;
  };
}

/**
 * Consent-moment + outbound acceptance tuning for social desires (bead oth4.2).
 * The whole lane sits behind SocialDesireConfig.enabled; these knobs only tune
 * the consent cadence and the TIGHT desire-driven outbound rate budget
 * (operator baseline: ~1-2 spontaneous outreach desires/day across contacts).
 */
interface SocialDesireOutreachSettings {
  /** Consent-moment lane poll interval (ms). */
  checkIntervalMs: number;
  /** Cap on LLM consent moments per lane run (usually 1). */
  maxConsentMomentsPerRun: number;
  /**
   * Lifetime of an accepted-but-undispatched consent (ms). Expiry means the
   * moment has passed: the outbound gate fails closed and a fresh consent
   * moment is required.
   */
  consentTtlMs: number;
  /** Rolling desire-outbound budget across ALL contacts, enforced at the gate. */
  budget: { maxSendsPerWindow: number; windowMs: number };
}

/**
 * Per-contact durable social desire (epic oth4, bead oth4.1): tick-based
 * accumulation from felt state only, relationship-tier gated, capped, decaying.
 * `enabled` gates the runtime feed/consumer wiring including the consent
 * moment and outbound acceptance (sibling oth4.2). Disabled by default — fail
 * closed until an operator enables desire-driven outreach for a deployment.
 */
export interface SocialDesireConfig {
  enabled: boolean;
  lifecycle: SocialDesireLifecycleSettings;
  outreach: SocialDesireOutreachSettings;
}

export const DEFAULT_SOCIAL_DESIRE_CONFIG: SocialDesireConfig = {
  enabled: false,
  lifecycle: {
    baseGain: 0.15,
    pressureCap: 3,
    actionThreshold: 1,
    pressureFloor: 0.05,
    decay: {
      warmHalflifeMs: 72 * 60 * 60 * 1000,
      repairHalflifeMs: 96 * 60 * 60 * 1000,
    },
    coolingOff: {
      warmMs: 60 * 60 * 1000,
      repairMs: 12 * 60 * 60 * 1000,
    },
    releaseFactor: 0.25,
    dampeningFactor: 0.5,
    concernReinforcementGain: 0.3,
    maxReinforcedConcernIds: 16,
    // Cadence mirrors natural think-about-them rhythm per the operator
    // addendum: acquaintance occasional, friend regular, family frequent,
    // partner daily-ish.
    tiers: {
      acquaintance: { gainMultiplier: 0.5, tickGapMs: 24 * 60 * 60 * 1000 },
      friend: { gainMultiplier: 1, tickGapMs: 8 * 60 * 60 * 1000 },
      family: { gainMultiplier: 1.4, tickGapMs: 4 * 60 * 60 * 1000 },
      partner: { gainMultiplier: 2, tickGapMs: 2 * 60 * 60 * 1000 },
      ai_companion: { gainMultiplier: 1, tickGapMs: 8 * 60 * 60 * 1000 },
    },
  },
  outreach: {
    checkIntervalMs: 1_800_000,
    maxConsentMomentsPerRun: 1,
    consentTtlMs: 30 * 60 * 1000,
    // Operator baseline (2026-07-20 audit): ~1-2 spontaneous outreach
    // desires/day is plausible — the budget is TIGHT by design.
    budget: { maxSendsPerWindow: 2, windowMs: 24 * 60 * 60 * 1000 },
  },
};

function validateSocialDesireTierProfile(
  raw: unknown,
  field: string,
): SocialDesireTierProfileConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config: ${field} must be an object`);
  }
  const gainMultiplier = toNumberAtLeast(raw.gainMultiplier, `${field}.gainMultiplier`, 0);
  if (!(gainMultiplier > 0)) {
    throw new Error(`Invalid scheduler config: ${field}.gainMultiplier must be > 0`);
  }
  return {
    gainMultiplier,
    tickGapMs: toInterval(raw.tickGapMs, `${field}.tickGapMs`),
  };
}

function cloneDefaultSocialDesireOutreachSettings(): SocialDesireOutreachSettings {
  const defaults = DEFAULT_SOCIAL_DESIRE_CONFIG.outreach;
  return {
    ...defaults,
    budget: { ...defaults.budget },
  };
}

function validateSocialDesireOutreachSettings(
  raw: unknown,
  sourcePath: string,
): SocialDesireOutreachSettings {
  // A pre-oth4.2 scheduler.json has no outreach section; defaults apply the
  // same way an absent socialDesire section does (still fail-closed overall
  // because `enabled` defaults to false and gates the whole lane).
  if (raw === undefined) {
    return cloneDefaultSocialDesireOutreachSettings();
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire.outreach must be an object`);
  }
  const budgetRaw = raw.budget;
  if (!isRecord(budgetRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire.outreach.budget must be an object`);
  }
  return {
    checkIntervalMs: toInterval(raw.checkIntervalMs, 'socialDesire.outreach.checkIntervalMs'),
    maxConsentMomentsPerRun: toPositiveInteger(
      raw.maxConsentMomentsPerRun,
      'socialDesire.outreach.maxConsentMomentsPerRun',
      1,
    ),
    consentTtlMs: toInterval(raw.consentTtlMs, 'socialDesire.outreach.consentTtlMs'),
    budget: {
      maxSendsPerWindow: toPositiveInteger(
        budgetRaw.maxSendsPerWindow,
        'socialDesire.outreach.budget.maxSendsPerWindow',
        1,
      ),
      windowMs: toInterval(budgetRaw.windowMs, 'socialDesire.outreach.budget.windowMs'),
    },
  };
}

export function validateSocialDesireConfig(
  raw: unknown,
  sourcePath: string,
): SocialDesireConfig {
  const defaults = DEFAULT_SOCIAL_DESIRE_CONFIG;
  if (raw === undefined) {
    return {
      enabled: defaults.enabled,
      lifecycle: {
        ...defaults.lifecycle,
        decay: { ...defaults.lifecycle.decay },
        coolingOff: { ...defaults.lifecycle.coolingOff },
        tiers: {
          acquaintance: { ...defaults.lifecycle.tiers.acquaintance },
          friend: { ...defaults.lifecycle.tiers.friend },
          family: { ...defaults.lifecycle.tiers.family },
          partner: { ...defaults.lifecycle.tiers.partner },
          ai_companion: { ...defaults.lifecycle.tiers.ai_companion },
        },
      },
      outreach: cloneDefaultSocialDesireOutreachSettings(),
    };
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire must be an object`);
  }
  const lifecycleRaw = raw.lifecycle;
  if (!isRecord(lifecycleRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire.lifecycle must be an object`);
  }
  const decayRaw = lifecycleRaw.decay;
  if (!isRecord(decayRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire.lifecycle.decay must be an object`);
  }
  const coolingOffRaw = lifecycleRaw.coolingOff;
  if (!isRecord(coolingOffRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire.lifecycle.coolingOff must be an object`);
  }
  const tiersRaw = lifecycleRaw.tiers;
  if (!isRecord(tiersRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire.lifecycle.tiers must be an object`);
  }
  // Stranger/public tiers are hard-excluded from accumulation in code; a config
  // that tries to define them is a contract violation, not a silent no-op.
  assertNoUnknownKeys(
    tiersRaw,
    ['acquaintance', 'friend', 'family', 'partner', 'ai_companion'],
    `${sourcePath}.socialDesire.lifecycle.tiers`,
    { errorPrefix: 'Invalid scheduler config' },
  );
  const coolingOff = {
    warmMs: toInterval(coolingOffRaw.warmMs, 'socialDesire.lifecycle.coolingOff.warmMs'),
    repairMs: toInterval(coolingOffRaw.repairMs, 'socialDesire.lifecycle.coolingOff.repairMs'),
  };
  if (!(coolingOff.repairMs > coolingOff.warmMs)) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: socialDesire.lifecycle.coolingOff.repairMs must exceed warmMs `
      + '(negative-origin desires cool off longer than warm desires)',
    );
  }
  const baseGain = toNumberAtLeast(lifecycleRaw.baseGain, 'socialDesire.lifecycle.baseGain', 0);
  if (!(baseGain > 0)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire.lifecycle.baseGain must be > 0`);
  }
  const pressureCap = toNumberAtLeast(lifecycleRaw.pressureCap, 'socialDesire.lifecycle.pressureCap', 0);
  if (!(pressureCap > 0)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire.lifecycle.pressureCap must be > 0`);
  }
  const actionThreshold = toNumberAtLeast(
    lifecycleRaw.actionThreshold,
    'socialDesire.lifecycle.actionThreshold',
    0,
  );
  if (!(actionThreshold > 0)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire.lifecycle.actionThreshold must be > 0`);
  }
  return {
    enabled: toBoolean(raw.enabled, 'socialDesire.enabled'),
    lifecycle: {
      baseGain,
      pressureCap,
      actionThreshold,
      pressureFloor: toNumberAtLeast(lifecycleRaw.pressureFloor, 'socialDesire.lifecycle.pressureFloor', 0),
      decay: {
        warmHalflifeMs: toInterval(decayRaw.warmHalflifeMs, 'socialDesire.lifecycle.decay.warmHalflifeMs'),
        repairHalflifeMs: toInterval(decayRaw.repairHalflifeMs, 'socialDesire.lifecycle.decay.repairHalflifeMs'),
      },
      coolingOff,
      releaseFactor: toUnitFactor(lifecycleRaw.releaseFactor, 'socialDesire.lifecycle.releaseFactor'),
      dampeningFactor: toUnitFactor(lifecycleRaw.dampeningFactor, 'socialDesire.lifecycle.dampeningFactor'),
      concernReinforcementGain: toNumberAtLeast(
        lifecycleRaw.concernReinforcementGain,
        'socialDesire.lifecycle.concernReinforcementGain',
        0,
      ),
      maxReinforcedConcernIds: toPositiveInteger(
        lifecycleRaw.maxReinforcedConcernIds,
        'socialDesire.lifecycle.maxReinforcedConcernIds',
        1,
      ),
      tiers: {
        acquaintance: validateSocialDesireTierProfile(tiersRaw.acquaintance, 'socialDesire.lifecycle.tiers.acquaintance'),
        friend: validateSocialDesireTierProfile(tiersRaw.friend, 'socialDesire.lifecycle.tiers.friend'),
        family: validateSocialDesireTierProfile(tiersRaw.family, 'socialDesire.lifecycle.tiers.family'),
        partner: validateSocialDesireTierProfile(tiersRaw.partner, 'socialDesire.lifecycle.tiers.partner'),
        ai_companion: validateSocialDesireTierProfile(
          tiersRaw.ai_companion,
          'socialDesire.lifecycle.tiers.ai_companion',
        ),
      },
    },
    outreach: validateSocialDesireOutreachSettings(raw.outreach, sourcePath),
  };
}
