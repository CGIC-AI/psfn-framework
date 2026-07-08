// ── Weighted-thought lifecycle (Charter 6.24) ──
//
// A weighted thought is a persistent internal signal that accumulates urgency
// contextually (repeat / recency / emotional charge, scoped by relationship)
// and then decays contextually so stale thoughts stop competing for attention.
// When a thought's decayed weight crosses a configured threshold it produces a
// NUDGE the companion can accept or decline; a declined nudge dampens the
// weight rather than zeroing it (consent preserved, charter 6.24).
//
// This module is PURE and deterministic: no LLM, no I/O, no clock of its own —
// every function takes an explicit `nowMs`. The Postgres adapter persists the
// plain ThoughtWeight shape; decay is applied at read time (like memory
// salience decay, src/faculties/memory/decay.ts) so weights survive restart
// without a separate decay writer.

import type { ChannelType } from '../../shared/contracts/runtime.js';
import { clampUnit } from '../../shared/utils/numeric.js';

export const THOUGHT_CLASSES = ['time_sensitive', 'standard', 'trivial'] as const;
export type ThoughtClass = (typeof THOUGHT_CLASSES)[number];

export const THOUGHT_NUDGE_STATES = ['pending', 'nudged', 'accepted', 'declined'] as const;
export type ThoughtNudgeState = (typeof THOUGHT_NUDGE_STATES)[number];

/** Where a thought originated — drives channel-resolution provenance. */
export interface ThoughtProvenance {
  /** Live active-concern id, when the thought tracks a concern. */
  concernId?: string;
  /** Live pending-follow-up id, when the thought tracks a scheduled follow-up. */
  pendingFollowUpId?: string;
  /** Channel where the concern/thought was originally raised (provenance). */
  sourceChannelId?: string;
  /** Channel type of the source channel. */
  sourceChannelType?: ChannelType;
}

export interface ThoughtContextMultipliers {
  /** Boost from repeated reinforcement of the same thought. */
  repeat: number;
  /** Boost from emotional charge at reinforcement time. */
  emotionalCharge: number;
  /** Relationship-tier scaling (charter ties weight to relationship). */
  relationship: number;
}

/** Persisted weighted-thought record. */
export interface ThoughtWeight {
  id: string;
  content: string;
  source: string;
  thoughtClass: ThoughtClass;
  contactId?: string;
  baseWeight: number;
  contextMultipliers: ThoughtContextMultipliers;
  accumulatedWeight: number;
  reinforcementCount: number;
  decayHalflifeMs: number;
  createdAt: string;
  lastReinforcedAt: string;
  provenance: ThoughtProvenance;
  nudgeState: ThoughtNudgeState;
  lastNudgedAt?: string;
  declineCount: number;
}

export interface ThoughtClassProfile {
  /** Starting weight for a fresh thought of this class. */
  baseWeight: number;
  /** Decay half-life (ms) — time-sensitive decays faster than trivial. */
  halflifeMs: number;
}

export interface ThoughtReinforcementConfig {
  /** Additive multiplier applied to baseWeight per repeat reinforcement. */
  repeatBoost: number;
  /** Weight applied to emotional intensity (0..1) at reinforcement. */
  emotionalChargeWeight: number;
}

export interface WeightedThoughtLifecycleConfig {
  classes: Record<ThoughtClass, ThoughtClassProfile>;
  reinforcement: ThoughtReinforcementConfig;
  /** Hard cap so accumulated weight cannot grow unbounded. */
  accumulatedWeightCap: number;
  /** Multiplier (0..1) applied on "said fine but context suggests otherwise". */
  contradictionDampeningFactor: number;
  /** Multiplier (0..1) applied when a produced nudge is declined. */
  declineDampeningFactor: number;
  /** Minimum decayed weight for a thought to count as currently relevant. */
  relevanceFloor: number;
}

export interface ThoughtReinforcementSignal {
  /** Emotional intensity 0..1 (e.g. participant-trend movement magnitude). */
  emotionalIntensity?: number;
  /** Relationship-tier multiplier (>= 0); defaults to the thought's existing value. */
  relationshipMultiplier?: number;
}

export interface CreateThoughtWeightInput {
  id: string;
  content: string;
  source: string;
  thoughtClass: ThoughtClass;
  contactId?: string;
  provenance?: ThoughtProvenance;
  /** Relationship-tier multiplier (>= 0); defaults to 1. */
  relationshipMultiplier?: number;
  /** Emotional intensity 0..1 at creation; defaults to 0. */
  emotionalIntensity?: number;
}

const LN2 = Math.LN2;

function clampNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function toIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

export function resolveThoughtClass(value: string | undefined): ThoughtClass {
  return THOUGHT_CLASSES.includes(value as ThoughtClass) ? (value as ThoughtClass) : 'standard';
}

export function resolveNudgeState(value: string | undefined): ThoughtNudgeState {
  return THOUGHT_NUDGE_STATES.includes(value as ThoughtNudgeState)
    ? (value as ThoughtNudgeState)
    : 'pending';
}

export function getThoughtClassProfile(
  config: WeightedThoughtLifecycleConfig,
  thoughtClass: ThoughtClass,
): ThoughtClassProfile {
  const profile = config.classes[thoughtClass] as ThoughtClassProfile | undefined;
  if (!profile || !(profile.halflifeMs > 0) || !(profile.baseWeight > 0)) {
    throw new Error(`Weighted-thought class profile for "${thoughtClass}" is missing or invalid`);
  }
  return profile;
}

/**
 * Deterministic decayed weight at `nowMs`: accumulatedWeight scaled by an
 * exponential half-life curve. Never below zero. Time before lastReinforcedAt
 * (clock skew) yields no growth — the factor is clamped to <= 1.
 */
export function decayedWeight(thought: ThoughtWeight, nowMs: number): number {
  const halflife = thought.decayHalflifeMs;
  if (!(halflife > 0)) return Math.max(0, thought.accumulatedWeight);
  const dt = nowMs - Date.parse(thought.lastReinforcedAt);
  if (!Number.isFinite(dt) || dt <= 0) return Math.max(0, thought.accumulatedWeight);
  const factor = Math.exp((-LN2 * dt) / halflife);
  return Math.max(0, thought.accumulatedWeight * factor);
}

export function createThoughtWeight(
  input: CreateThoughtWeightInput,
  config: WeightedThoughtLifecycleConfig,
  nowMs: number,
): ThoughtWeight {
  const thoughtClass = resolveThoughtClass(input.thoughtClass);
  const profile = getThoughtClassProfile(config, thoughtClass);
  const relationship = clampNonNegative(input.relationshipMultiplier ?? 1, 1);
  const emotionalCharge = 1 + config.reinforcement.emotionalChargeWeight * clampUnit(input.emotionalIntensity, 0);
  const contextMultipliers: ThoughtContextMultipliers = {
    repeat: 1,
    emotionalCharge,
    relationship,
  };
  const accumulatedWeight = Math.min(
    config.accumulatedWeightCap,
    profile.baseWeight * emotionalCharge * relationship,
  );
  const iso = toIso(nowMs);
  const provenance: ThoughtProvenance = { ...(input.provenance ?? {}) };
  return {
    id: input.id,
    content: input.content,
    source: input.source,
    thoughtClass,
    ...(input.contactId ? { contactId: input.contactId } : {}),
    baseWeight: profile.baseWeight,
    contextMultipliers,
    accumulatedWeight,
    reinforcementCount: 0,
    decayHalflifeMs: profile.halflifeMs,
    createdAt: iso,
    lastReinforcedAt: iso,
    provenance,
    nudgeState: 'pending',
    declineCount: 0,
  };
}

/**
 * Reinforce a thought on repeat: the prior accumulated weight decays to `nowMs`
 * first (recency), then a fresh increment (baseWeight * repeatBoost, scaled by
 * emotional charge and relationship) is added, capped. Deterministic.
 */
export function reinforceThoughtWeight(
  thought: ThoughtWeight,
  signal: ThoughtReinforcementSignal,
  config: WeightedThoughtLifecycleConfig,
  nowMs: number,
): ThoughtWeight {
  const relationship = clampNonNegative(
    signal.relationshipMultiplier ?? thought.contextMultipliers.relationship,
    thought.contextMultipliers.relationship,
  );
  const emotionalCharge = 1 + config.reinforcement.emotionalChargeWeight * clampUnit(signal.emotionalIntensity, 0);
  const decayed = decayedWeight(thought, nowMs);
  const increment = thought.baseWeight * config.reinforcement.repeatBoost * emotionalCharge * relationship;
  const accumulatedWeight = Math.min(config.accumulatedWeightCap, decayed + increment);
  const reinforcementCount = thought.reinforcementCount + 1;
  return {
    ...thought,
    accumulatedWeight,
    reinforcementCount,
    contextMultipliers: {
      repeat: 1 + config.reinforcement.repeatBoost * reinforcementCount,
      emotionalCharge,
      relationship,
    },
    lastReinforcedAt: toIso(nowMs),
    // Reinforcement after a decline reopens the thought for a fresh nudge.
    nudgeState: thought.nudgeState === 'declined' ? 'pending' : thought.nudgeState,
  };
}

/**
 * "Said fine but context suggests otherwise" — reduce the weight toward, but
 * never to, zero. The thought keeps a residual so it can re-accumulate.
 */
export function applyContradictionDampening(
  thought: ThoughtWeight,
  config: WeightedThoughtLifecycleConfig,
  nowMs: number,
): ThoughtWeight {
  const factor = clampUnit(config.contradictionDampeningFactor, 0.5);
  const decayed = decayedWeight(thought, nowMs);
  return {
    ...thought,
    accumulatedWeight: decayed * factor,
    lastReinforcedAt: toIso(nowMs),
  };
}

/** Mark a thought as having produced a nudge awaiting the consent decision. */
export function markThoughtNudged(thought: ThoughtWeight, nowMs: number): ThoughtWeight {
  return { ...thought, nudgeState: 'nudged', lastNudgedAt: toIso(nowMs) };
}

/** Consent granted: the nudge was accepted; the outreach action is emitted. */
export function markThoughtAccepted(thought: ThoughtWeight, nowMs: number): ThoughtWeight {
  return { ...thought, nudgeState: 'accepted', lastNudgedAt: toIso(nowMs) };
}

/**
 * Consent withheld: the nudge was declined. The weight is dampened (not zeroed)
 * so it defers and can re-accumulate later; a declined thought is reopened by
 * the next reinforcement.
 */
export function applyDeclineDampening(
  thought: ThoughtWeight,
  config: WeightedThoughtLifecycleConfig,
  nowMs: number,
): ThoughtWeight {
  const factor = clampUnit(config.declineDampeningFactor, 0.5);
  const decayed = decayedWeight(thought, nowMs);
  return {
    ...thought,
    accumulatedWeight: decayed * factor,
    nudgeState: 'declined',
    declineCount: thought.declineCount + 1,
    lastNudgedAt: toIso(nowMs),
    lastReinforcedAt: toIso(nowMs),
  };
}

export interface WeightedThoughtView {
  thought: ThoughtWeight;
  /** Decayed weight at the query instant. */
  weight: number;
}

/**
 * Top-N currently-relevant thoughts by decayed weight, descending. Thoughts
 * below the relevance floor are excluded (they no longer compete for
 * attention). Ties break by lastReinforcedAt (fresher first) then id.
 */
export function topWeightedThoughts(
  thoughts: readonly ThoughtWeight[],
  nowMs: number,
  limit: number,
  relevanceFloor: number,
): WeightedThoughtView[] {
  const floor = Number.isFinite(relevanceFloor) ? relevanceFloor : 0;
  const views: WeightedThoughtView[] = [];
  for (const thought of thoughts) {
    const weight = decayedWeight(thought, nowMs);
    if (weight < floor) continue;
    views.push({ thought, weight });
  }
  views.sort((left, right) => (
    right.weight - left.weight
    || Date.parse(right.thought.lastReinforcedAt) - Date.parse(left.thought.lastReinforcedAt)
    || left.thought.id.localeCompare(right.thought.id)
  ));
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : views.length;
  return views.slice(0, n);
}
