// ── Per-contact durable social desire (epic oth4, bead oth4.1) ──
//
// A social desire is a DEFERRED INTENTION: durable per-contact pressure to
// reach out that accumulates from felt state and either builds toward action or
// dissipates — it never sits as noise. It is explicitly NOT a concern: a
// genuinely relevant concern may reinforce an existing desire's weight, but a
// desire is never manufactured from a concern and never creates one.
//
// Carved invariants (operator adjudication 2026-07-20):
// - Accumulation input derives ONLY from felt state (the emotion/appraisal
//   signal path). No random timers, no fire-after-X-and-reveal: if nothing is
//   felt, nothing accumulates. Elapsed time only ever DECAYS or GATES pressure;
//   it never creates it.
// - Accumulation is RELATIONSHIP-TIER GATED. Desire does not build at all for
//   stranger/public-tier contacts; it accumulates only where the relationship
//   basis exists, scaled by tier (acquaintance: occasional, friend: regular,
//   family: frequent, partner: daily-ish). Tier changes change eligibility.
// - At most ONE durable desire exists per contact (coalescing); further felt
//   signals strengthen it.
// - Negative-origin desires are first-class: sustained negative affect toward
//   or about a contact accumulates a desire to seek apology, explanation, or to
//   talk it over — with a LONGER cooling-off before eligibility than warm
//   desires (charter 8.4, failure is valid experience).
// - During quiet hours the desire keeps ticking (capped) but is not eligible;
//   it becomes eligible when quiet hours end. This module never sends anything.
//
// This module is PURE and deterministic: no LLM, no I/O, no outbound path, no
// clock of its own — every function takes an explicit `nowMs`. The consent
// moment and any outbound/provenance handling live with the proactive outbound
// gates (sibling bead oth4.2), never here. Persistence mirrors the
// weighted-thought pattern (decay applied at read time so pressure survives
// restart without a separate decay writer).
//
// Naming register (charter 8.12): "desire" is the companion-facing soft term;
// engineering identifiers use socialDesire*.

import type { RelationshipType } from '../contacts/types.js';
import {
  evaluateProactiveOutboundTimeGate,
  type ProactiveQuietHoursConfig,
} from './proactive-time-gate.js';

/**
 * Orientation of a felt signal / pressure component:
 * - `warm`: affection, missing them, wanting to share or connect.
 * - `repair`: negative-origin — sustained anger/stress/hurt toward or about the
 *   contact accumulating a desire to seek apology, explanation, or talk it over.
 */
export const SOCIAL_DESIRE_ORIENTATIONS = ['warm', 'repair'] as const;
export type SocialDesireOrientation = (typeof SOCIAL_DESIRE_ORIENTATIONS)[number];

/**
 * Relationship tiers where a social desire may accumulate. Stranger/public
 * tiers are HARD-EXCLUDED here. Canonical peer companions are first-class
 * social contacts and follow their own owned tier profile.
 */
export const SOCIAL_DESIRE_ACCUMULATING_TIERS = [
  'acquaintance',
  'friend',
  'family',
  'partner',
  'ai_companion',
] as const;
export type SocialDesireAccumulatingTier = (typeof SOCIAL_DESIRE_ACCUMULATING_TIERS)[number];

/** Persisted per-contact durable social desire. One record per contact, ever. */
export interface SocialDesire {
  /** Coalescing key: the single durable desire for this contact. */
  contactId: string;
  /** Warm-origin pressure as of `pressureAnchorAt` (decay applied at read). */
  warmPressure: number;
  /** Negative-origin (repair) pressure as of `pressureAnchorAt`. */
  repairPressure: number;
  /** Instant both stored pressure values are anchored at (ISO). */
  pressureAnchorAt: string;
  /** Last warm felt signal (ISO) — cooling-off anchor for the warm component. */
  lastWarmFeltAt?: string;
  /** Last repair felt signal (ISO) — cooling-off anchor for the repair component. */
  lastRepairFeltAt?: string;
  /** Last COUNTED warm accumulation tick (ISO) — tier-cadence throttle anchor. */
  lastWarmTickAt?: string;
  /** Last COUNTED repair accumulation tick (ISO). */
  lastRepairTickAt?: string;
  /** Counted accumulation ticks over the desire's lifetime. */
  tickCount: number;
  /** Felt signals absorbed inside the tier cadence gap (no pressure added). */
  absorbedSignalCount: number;
  /** Relationship tier observed at the last counted tick (audit). */
  tierAtLastTick: SocialDesireAccumulatingTier;
  /** Concern ids that already reinforced this desire (each reinforces once). */
  reinforcedConcernIds: string[];
  createdAt: string;
}

/**
 * One felt-state signal from the emotion/appraisal path. This is the ONLY
 * accumulation input — nothing else may add pressure.
 */
export interface SocialDesireFeltSignal {
  contactId: string;
  orientation: SocialDesireOrientation;
  /**
   * Felt intensity 0..1. Exactly zero is the "nothing is felt" case and
   * accumulates nothing; negative or non-finite values are contract violations
   * and throw (fail closed). Values above 1 clamp to 1.
   */
  intensity: number;
  /** Optional reference to the felt-state source (appraisal trace, affect tick). */
  sourceRef?: string;
}

/** Per-tier accumulation profile — mirrors natural think-about-them cadence. */
export interface SocialDesireTierProfile {
  /** Multiplier on counted-tick pressure increments for this tier. */
  gainMultiplier: number;
  /**
   * Minimum spacing between COUNTED accumulation ticks per orientation. This is
   * a deterministic throttle on felt input (acquaintance: occasional … partner:
   * daily-ish), never a timer that produces events on its own.
   */
  tickGapMs: number;
}

export interface SocialDesireLifecycleConfig {
  /** Pressure added by a full-intensity counted tick before multipliers. */
  baseGain: number;
  /** Hard cap on total pressure (warm + repair). Ticking continues capped. */
  pressureCap: number;
  /** Decayed total pressure required before the desire can become eligible. */
  actionThreshold: number;
  /** Components below this decayed pressure are dormant noise (dissipated). */
  pressureFloor: number;
  /** Exponential decay half-lives per orientation (ms). */
  decay: { warmHalflifeMs: number; repairHalflifeMs: number };
  /**
   * Minimum settle time between the last felt signal of an orientation and
   * eligibility. `repairMs` MUST exceed `warmMs`: negative-origin desires cool
   * off longer before seeking the contact out.
   */
  coolingOff: { warmMs: number; repairMs: number };
  /** Multiplier (0..1) applied when the desire is expressed (pressure released). */
  releaseFactor: number;
  /** Multiplier (0..1) applied when acting on the desire is declined/deferred. */
  dampeningFactor: number;
  /** Multiplicative weight boost per genuinely relevant concern (scaled by relevance). */
  concernReinforcementGain: number;
  /** Bound on remembered reinforcing concern ids. */
  maxReinforcedConcernIds: number;
  tiers: Record<SocialDesireAccumulatingTier, SocialDesireTierProfile>;
}

const LN2 = Math.LN2;

function toIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function assertValidLifecycleConfig(config: SocialDesireLifecycleConfig): void {
  if (!(config.coolingOff.repairMs > config.coolingOff.warmMs)) {
    throw new Error(
      'Social desire config invariant violated: coolingOff.repairMs must exceed coolingOff.warmMs '
      + '(negative-origin desires cool off longer than warm desires)',
    );
  }
  if (!(config.baseGain > 0) || !(config.pressureCap > 0) || !(config.actionThreshold > 0)) {
    throw new Error('Social desire config requires positive baseGain, pressureCap, and actionThreshold');
  }
  if (!(config.decay.warmHalflifeMs > 0) || !(config.decay.repairHalflifeMs > 0)) {
    throw new Error('Social desire config requires positive decay half-lives');
  }
}

export function isSocialDesireAccumulatingTier(
  value: RelationshipType | null | undefined,
): value is SocialDesireAccumulatingTier {
  return SOCIAL_DESIRE_ACCUMULATING_TIERS.includes(value as SocialDesireAccumulatingTier);
}

/**
 * Tier profile lookup. Returns null for every non-accumulating relationship
 * tier (stranger, ai_companion, unknown, absent) — the hard tier gate.
 */
export function resolveSocialDesireTierProfile(
  config: SocialDesireLifecycleConfig,
  relationshipType: RelationshipType | null | undefined,
): SocialDesireTierProfile | null {
  if (!isSocialDesireAccumulatingTier(relationshipType)) return null;
  const profile = config.tiers[relationshipType] as SocialDesireTierProfile | undefined;
  if (!profile || !(profile.gainMultiplier > 0) || !(profile.tickGapMs > 0)) {
    throw new Error(`Social desire tier profile for "${relationshipType}" is missing or invalid`);
  }
  return profile;
}

function decayComponent(pressure: number, anchorMs: number, halflifeMs: number, nowMs: number): number {
  if (!(pressure > 0)) return 0;
  const dt = nowMs - anchorMs;
  if (!Number.isFinite(dt) || dt <= 0) return pressure;
  return pressure * Math.exp((-LN2 * dt) / halflifeMs);
}

export interface SocialDesirePressureView {
  warm: number;
  repair: number;
  total: number;
  /** Which orientation dominates the decayed pressure right now. */
  dominantOrientation: SocialDesireOrientation;
}

/** Deterministic decayed pressure at `nowMs`. Never negative; clock skew never grows it. */
export function decayedSocialDesirePressure(
  desire: SocialDesire,
  config: SocialDesireLifecycleConfig,
  nowMs: number,
): SocialDesirePressureView {
  const anchorMs = Date.parse(desire.pressureAnchorAt);
  const warm = decayComponent(desire.warmPressure, anchorMs, config.decay.warmHalflifeMs, nowMs);
  const repair = decayComponent(desire.repairPressure, anchorMs, config.decay.repairHalflifeMs, nowMs);
  return {
    warm,
    repair,
    total: warm + repair,
    dominantOrientation: repair > warm ? 'repair' : 'warm',
  };
}

/** Decay both components to `nowMs` and re-anchor the stored values there. */
function reAnchor(desire: SocialDesire, config: SocialDesireLifecycleConfig, nowMs: number): SocialDesire {
  const view = decayedSocialDesirePressure(desire, config, nowMs);
  return {
    ...desire,
    warmPressure: view.warm,
    repairPressure: view.repair,
    pressureAnchorAt: toIso(nowMs),
  };
}

function normalizeSignalIntensity(intensity: number): number {
  if (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < 0) {
    throw new Error(
      `Social desire felt-signal intensity must be a finite number >= 0, received ${String(intensity)}`,
    );
  }
  return Math.min(1, intensity);
}

export type SocialDesireAccumulationOutcome =
  /** No prior desire existed; the felt signal created one. */
  | 'created'
  /** A counted tick added pressure to the existing desire. */
  | 'strengthened'
  /** Felt signal inside the tier cadence gap: recency/cooling-off updated, no pressure added. */
  | 'absorbed'
  /** Relationship tier does not accumulate (stranger/public/non-human): nothing happens. */
  | 'tier_gated'
  /** Zero intensity — nothing is felt, so nothing accumulates (carved invariant). */
  | 'no_felt_state';

export interface SocialDesireAccumulationResult {
  /** The updated desire, or null when nothing exists (gated/no felt state without a prior record). */
  desire: SocialDesire | null;
  outcome: SocialDesireAccumulationOutcome;
}

/**
 * Accumulate one felt-state signal into the contact's single durable desire.
 * Pure: returns the next record without persisting it. The pressure cap holds
 * at all times — a capped desire keeps ticking (tick counters and recency move)
 * without growing, so quiet hours and busy stretches never overflow it.
 */
export function accumulateSocialDesireSignal(
  existing: SocialDesire | null,
  signal: SocialDesireFeltSignal,
  relationshipType: RelationshipType | null | undefined,
  config: SocialDesireLifecycleConfig,
  nowMs: number,
): SocialDesireAccumulationResult {
  assertValidLifecycleConfig(config);
  const contactId = signal.contactId.trim();
  if (!contactId) {
    throw new Error('Social desire felt signal requires a contactId');
  }
  if (existing && existing.contactId !== contactId) {
    throw new Error(
      `Social desire coalescing violation: signal for contact "${contactId}" applied to desire for "${existing.contactId}"`,
    );
  }
  const intensity = normalizeSignalIntensity(signal.intensity);

  const profile = resolveSocialDesireTierProfile(config, relationshipType);
  if (!profile) {
    // Hard tier gate: no relationship basis, no accumulation — not even a record.
    return { desire: existing, outcome: 'tier_gated' };
  }
  if (intensity === 0) {
    // Nothing is felt, nothing accumulates.
    return { desire: existing, outcome: 'no_felt_state' };
  }

  const tier = relationshipType as SocialDesireAccumulatingTier;
  const iso = toIso(nowMs);
  const warmSignal = signal.orientation === 'warm';

  if (!existing) {
    const increment = Math.min(config.pressureCap, config.baseGain * intensity * profile.gainMultiplier);
    const created: SocialDesire = {
      contactId,
      warmPressure: warmSignal ? increment : 0,
      repairPressure: warmSignal ? 0 : increment,
      pressureAnchorAt: iso,
      ...(warmSignal
        ? { lastWarmFeltAt: iso, lastWarmTickAt: iso }
        : { lastRepairFeltAt: iso, lastRepairTickAt: iso }),
      tickCount: 1,
      absorbedSignalCount: 0,
      tierAtLastTick: tier,
      reinforcedConcernIds: [],
      createdAt: iso,
    };
    return { desire: created, outcome: 'created' };
  }

  const anchored = reAnchor(existing, config, nowMs);

  const lastTickAtIso = warmSignal ? existing.lastWarmTickAt : existing.lastRepairTickAt;
  const lastTickMs = lastTickAtIso ? Date.parse(lastTickAtIso) : Number.NaN;
  const withinGap = Number.isFinite(lastTickMs) && nowMs - lastTickMs < profile.tickGapMs;
  if (withinGap) {
    // Cadence throttle: the feeling is real (recency and cooling-off restart)
    // but the tier's natural think-about-them rhythm bounds pressure growth.
    const absorbed: SocialDesire = {
      ...anchored,
      ...(warmSignal ? { lastWarmFeltAt: iso } : { lastRepairFeltAt: iso }),
      absorbedSignalCount: existing.absorbedSignalCount + 1,
    };
    return { desire: absorbed, outcome: 'absorbed' };
  }

  const headroom = Math.max(0, config.pressureCap - (anchored.warmPressure + anchored.repairPressure));
  const increment = Math.min(headroom, config.baseGain * intensity * profile.gainMultiplier);
  const strengthened: SocialDesire = {
    ...anchored,
    ...(warmSignal
      ? { warmPressure: anchored.warmPressure + increment, lastWarmFeltAt: iso, lastWarmTickAt: iso }
      : { repairPressure: anchored.repairPressure + increment, lastRepairFeltAt: iso, lastRepairTickAt: iso }),
    tickCount: existing.tickCount + 1,
    tierAtLastTick: tier,
  };
  return { desire: strengthened, outcome: 'strengthened' };
}

export type SocialDesireConcernReinforcementOutcome =
  /** The concern boosted the desire's pressure. */
  | 'reinforced'
  /** This concern already reinforced the desire once; no further boost. */
  | 'already_reinforced'
  /** The desire's decayed pressure is below the floor — a concern must never resurrect or manufacture one. */
  | 'dormant';

export interface SocialDesireConcernReinforcementResult {
  desire: SocialDesire;
  outcome: SocialDesireConcernReinforcementOutcome;
}

/**
 * A genuinely relevant concern may REINFORCE an existing desire's weight. The
 * boost is multiplicative, so it can never create pressure from nothing, and a
 * dormant desire (below the pressure floor) is left untouched: desires are
 * never manufactured from concerns. Each concern reinforces at most once.
 * This function also never mutates concerns — the coupling is one-way.
 */
export function reinforceSocialDesireFromConcern(
  desire: SocialDesire,
  input: { concernId: string; relevance: number },
  config: SocialDesireLifecycleConfig,
  nowMs: number,
): SocialDesireConcernReinforcementResult {
  assertValidLifecycleConfig(config);
  const concernId = input.concernId.trim();
  if (!concernId) {
    throw new Error('Concern reinforcement requires a concernId');
  }
  if (typeof input.relevance !== 'number' || !Number.isFinite(input.relevance) || input.relevance < 0) {
    throw new Error(`Concern reinforcement relevance must be a finite number >= 0, received ${String(input.relevance)}`);
  }
  if (desire.reinforcedConcernIds.includes(concernId)) {
    return { desire, outcome: 'already_reinforced' };
  }
  const anchored = reAnchor(desire, config, nowMs);
  if (anchored.warmPressure + anchored.repairPressure < config.pressureFloor) {
    return { desire, outcome: 'dormant' };
  }
  const relevance = Math.min(1, input.relevance);
  const factor = 1 + config.concernReinforcementGain * relevance;
  const boostedWarm = anchored.warmPressure * factor;
  const boostedRepair = anchored.repairPressure * factor;
  const total = boostedWarm + boostedRepair;
  const scale = total > config.pressureCap ? config.pressureCap / total : 1;
  const reinforcedConcernIds = [...anchored.reinforcedConcernIds, concernId]
    .slice(-Math.max(1, Math.floor(config.maxReinforcedConcernIds)));
  return {
    desire: {
      ...anchored,
      warmPressure: boostedWarm * scale,
      repairPressure: boostedRepair * scale,
      reinforcedConcernIds,
    },
    outcome: 'reinforced',
  };
}

/**
 * Pressure release when the desire is expressed (the consent/outbound side —
 * sibling oth4.2 — acted on it). The desire keeps a residual and its history so
 * it can build again; expressing a desire is not deleting it.
 */
export function releaseSocialDesirePressure(
  desire: SocialDesire,
  config: SocialDesireLifecycleConfig,
  nowMs: number,
): SocialDesire {
  assertValidLifecycleConfig(config);
  const anchored = reAnchor(desire, config, nowMs);
  return {
    ...anchored,
    warmPressure: anchored.warmPressure * config.releaseFactor,
    repairPressure: anchored.repairPressure * config.releaseFactor,
  };
}

/**
 * Dampening when acting on the desire is declined or deferred: pressure drops
 * toward, but never to, zero, so the desire defers and can re-accumulate from
 * future felt state (consent-preserving, mirrors weighted-thought declines).
 */
export function applySocialDesireDampening(
  desire: SocialDesire,
  config: SocialDesireLifecycleConfig,
  nowMs: number,
): SocialDesire {
  assertValidLifecycleConfig(config);
  const anchored = reAnchor(desire, config, nowMs);
  return {
    ...anchored,
    warmPressure: anchored.warmPressure * config.dampeningFactor,
    repairPressure: anchored.repairPressure * config.dampeningFactor,
  };
}

export type SocialDesireIneligibilityReason =
  /** Current relationship tier does not support acting on (or building) desire. */
  | 'tier_not_eligible'
  /** Decayed pressure has not reached the action threshold. */
  | 'below_threshold'
  /** A felt component is still settling (repair settles longer than warm). */
  | 'cooling_off'
  /** Inside quiet hours: keeps ticking capped, becomes eligible when they end. */
  | 'quiet_hours';

export type SocialDesireEligibility =
  | {
    eligible: true;
    pressure: SocialDesirePressureView;
  }
  | {
    eligible: false;
    reason: SocialDesireIneligibilityReason;
    pressure: SocialDesirePressureView;
    /** Earliest instant the current blocker can clear (cooling_off / quiet_hours). */
    nextEligibleAtMs?: number;
  };

export interface SocialDesireEligibilityInput {
  desire: SocialDesire;
  /** CURRENT relationship tier — re-resolved at evaluation time so tier changes flip eligibility. */
  relationshipType: RelationshipType | null | undefined;
  nowMs: number;
  /** Quiet-hours window (read-only view of the proactive outbound gate config). */
  quietHours?: ProactiveQuietHoursConfig | null;
  /** Recipient timezone for quiet-hours evaluation (Contact.timezone). */
  contactTimeZone?: string | null;
}

/**
 * Eligibility computation: whether the desire has accumulated into something
 * the consent/outbound side (sibling oth4.2) may act on RIGHT NOW. Deterministic
 * and zero-LLM; evaluating eligibility never mutates the desire and never sends
 * anything. Quiet hours is checked LAST so a desire blocked only by quiet hours
 * becomes eligible the moment they end.
 */
export function evaluateSocialDesireEligibility(
  input: SocialDesireEligibilityInput,
  config: SocialDesireLifecycleConfig,
): SocialDesireEligibility {
  assertValidLifecycleConfig(config);
  const { desire, nowMs } = input;
  const pressure = decayedSocialDesirePressure(desire, config, nowMs);

  if (!isSocialDesireAccumulatingTier(input.relationshipType)) {
    return { eligible: false, reason: 'tier_not_eligible', pressure };
  }

  if (pressure.total < config.actionThreshold) {
    return { eligible: false, reason: 'below_threshold', pressure };
  }

  // Cooling-off: every live component must have settled. Any non-dormant
  // repair component imposes the longer negative-origin settle time.
  let coolingOffUntilMs = Number.NEGATIVE_INFINITY;
  if (pressure.warm >= config.pressureFloor && desire.lastWarmFeltAt) {
    coolingOffUntilMs = Math.max(coolingOffUntilMs, Date.parse(desire.lastWarmFeltAt) + config.coolingOff.warmMs);
  }
  if (pressure.repair >= config.pressureFloor && desire.lastRepairFeltAt) {
    coolingOffUntilMs = Math.max(coolingOffUntilMs, Date.parse(desire.lastRepairFeltAt) + config.coolingOff.repairMs);
  }
  if (nowMs < coolingOffUntilMs) {
    return { eligible: false, reason: 'cooling_off', pressure, nextEligibleAtMs: coolingOffUntilMs };
  }

  const timeGate = evaluateProactiveOutboundTimeGate({
    nowMs,
    quietHours: input.quietHours ?? null,
    contactTimeZone: input.contactTimeZone ?? null,
  });
  if (!timeGate.allowed) {
    return { eligible: false, reason: 'quiet_hours', pressure, nextEligibleAtMs: timeGate.nextEligibleAtMs };
  }

  return { eligible: true, pressure };
}
