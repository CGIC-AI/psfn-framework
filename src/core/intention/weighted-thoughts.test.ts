import { describe, expect, it } from 'vitest';
import {
  applyContradictionDampening,
  applyDeclineDampening,
  createThoughtWeight,
  decayedWeight,
  reinforceThoughtWeight,
  topWeightedThoughts,
  type WeightedThoughtLifecycleConfig,
} from './weighted-thoughts.js';

const HOUR = 60 * 60 * 1000;

const CONFIG: WeightedThoughtLifecycleConfig = {
  classes: {
    time_sensitive: { baseWeight: 0.5, halflifeMs: 6 * HOUR },
    standard: { baseWeight: 0.4, halflifeMs: 24 * HOUR },
    trivial: { baseWeight: 0.2, halflifeMs: 72 * HOUR },
  },
  reinforcement: { repeatBoost: 0.5, emotionalChargeWeight: 1 },
  accumulatedWeightCap: 3,
  contradictionDampeningFactor: 0.6,
  declineDampeningFactor: 0.5,
  relevanceFloor: 0.05,
};

const T0 = Date.parse('2026-07-02T12:00:00.000Z');

describe('weighted-thought lifecycle math', () => {
  it('creates a thought with class-derived base weight and half-life', () => {
    const thought = createThoughtWeight(
      { id: 't1', content: 'check in', source: 'concern', thoughtClass: 'time_sensitive' },
      CONFIG,
      T0,
    );
    expect(thought.baseWeight).toBe(0.5);
    expect(thought.accumulatedWeight).toBeCloseTo(0.5, 6);
    expect(thought.decayHalflifeMs).toBe(6 * HOUR);
    expect(thought.nudgeState).toBe('pending');
  });

  it('scales creation weight by emotional charge and relationship', () => {
    const thought = createThoughtWeight(
      {
        id: 't2',
        content: 'worried',
        source: 'concern',
        thoughtClass: 'standard',
        emotionalIntensity: 1,
        relationshipMultiplier: 1.5,
      },
      CONFIG,
      T0,
    );
    // base 0.4 * (1 + 1*1) emotionalCharge * 1.5 relationship = 1.2
    expect(thought.accumulatedWeight).toBeCloseTo(1.2, 6);
  });

  it('decays by half after one class-specific half-life; classes differ', () => {
    const timeSensitive = createThoughtWeight(
      { id: 'a', content: 'x', source: 's', thoughtClass: 'time_sensitive' },
      CONFIG,
      T0,
    );
    const trivial = createThoughtWeight(
      { id: 'b', content: 'x', source: 's', thoughtClass: 'trivial' },
      CONFIG,
      T0,
    );
    // After 6h: time-sensitive at one half-life (halved), trivial barely moved.
    const at6h = T0 + 6 * HOUR;
    expect(decayedWeight(timeSensitive, at6h)).toBeCloseTo(timeSensitive.accumulatedWeight / 2, 6);
    expect(decayedWeight(trivial, at6h)).toBeGreaterThan(trivial.accumulatedWeight * 0.9);
  });

  it('does not grow weight for timestamps before lastReinforcedAt', () => {
    const thought = createThoughtWeight(
      { id: 'c', content: 'x', source: 's', thoughtClass: 'standard' },
      CONFIG,
      T0,
    );
    expect(decayedWeight(thought, T0 - HOUR)).toBeCloseTo(thought.accumulatedWeight, 6);
  });

  it('reinforces on repeat: decays prior weight then adds an increment', () => {
    let thought = createThoughtWeight(
      { id: 'd', content: 'x', source: 's', thoughtClass: 'standard' },
      CONFIG,
      T0,
    );
    // Reinforce one half-life later: prior 0.4 decays to 0.2, + increment
    // (base 0.4 * repeatBoost 0.5 * charge 1 * relationship 1 = 0.2) => 0.4.
    thought = reinforceThoughtWeight(thought, {}, CONFIG, T0 + 24 * HOUR);
    expect(thought.accumulatedWeight).toBeCloseTo(0.4, 6);
    expect(thought.reinforcementCount).toBe(1);
  });

  it('emotional charge amplifies reinforcement increment', () => {
    const base = createThoughtWeight(
      { id: 'e', content: 'x', source: 's', thoughtClass: 'standard' },
      CONFIG,
      T0,
    );
    const calm = reinforceThoughtWeight(base, { emotionalIntensity: 0 }, CONFIG, T0 + HOUR);
    const charged = reinforceThoughtWeight(base, { emotionalIntensity: 1 }, CONFIG, T0 + HOUR);
    expect(charged.accumulatedWeight).toBeGreaterThan(calm.accumulatedWeight);
  });

  it('never exceeds the accumulated weight cap', () => {
    let thought = createThoughtWeight(
      { id: 'f', content: 'x', source: 's', thoughtClass: 'standard', emotionalIntensity: 1 },
      CONFIG,
      T0,
    );
    for (let i = 1; i <= 50; i += 1) {
      thought = reinforceThoughtWeight(thought, { emotionalIntensity: 1 }, CONFIG, T0 + i * 60_000);
    }
    expect(thought.accumulatedWeight).toBeLessThanOrEqual(CONFIG.accumulatedWeightCap + 1e-9);
  });

  it('contradiction dampening reduces weight but never zeroes it', () => {
    const thought = createThoughtWeight(
      { id: 'g', content: 'said fine', source: 's', thoughtClass: 'standard' },
      CONFIG,
      T0,
    );
    const dampened = applyContradictionDampening(thought, CONFIG, T0);
    expect(dampened.accumulatedWeight).toBeCloseTo(thought.accumulatedWeight * 0.6, 6);
    expect(dampened.accumulatedWeight).toBeGreaterThan(0);
  });

  it('decline dampening reduces weight, marks declined, and counts declines', () => {
    const thought = createThoughtWeight(
      { id: 'h', content: 'x', source: 's', thoughtClass: 'standard' },
      CONFIG,
      T0,
    );
    const declined = applyDeclineDampening(thought, CONFIG, T0);
    expect(declined.nudgeState).toBe('declined');
    expect(declined.declineCount).toBe(1);
    expect(declined.accumulatedWeight).toBeCloseTo(thought.accumulatedWeight * 0.5, 6);
    expect(declined.accumulatedWeight).toBeGreaterThan(0);
  });

  it('reinforcement reopens a declined thought for a fresh nudge', () => {
    const thought = applyDeclineDampening(
      createThoughtWeight({ id: 'i', content: 'x', source: 's', thoughtClass: 'standard' }, CONFIG, T0),
      CONFIG,
      T0,
    );
    const reopened = reinforceThoughtWeight(thought, {}, CONFIG, T0 + HOUR);
    expect(reopened.nudgeState).toBe('pending');
  });

  it('topWeightedThoughts ranks by decayed weight and filters below the floor', () => {
    const strong = createThoughtWeight(
      { id: 'strong', content: 'x', source: 's', thoughtClass: 'standard', emotionalIntensity: 1 },
      CONFIG,
      T0,
    );
    const weak = createThoughtWeight(
      { id: 'weak', content: 'x', source: 's', thoughtClass: 'time_sensitive' },
      CONFIG,
      T0,
    );
    // At 48h the time-sensitive thought (6h half-life) has decayed below the
    // floor while the standard thought (24h half-life) is still relevant.
    const nowMs = T0 + 48 * HOUR;
    const top = topWeightedThoughts([weak, strong], nowMs, 5, CONFIG.relevanceFloor);
    expect(top.map((view) => view.thought.id)).toEqual(['strong']);
  });

  it('topWeightedThoughts respects the limit and descending order', () => {
    const thoughts = [0.2, 0.9, 0.5].map((intensity, index) => createThoughtWeight(
      {
        id: `rank-${index}`,
        content: 'x',
        source: 's',
        thoughtClass: 'standard',
        emotionalIntensity: intensity,
      },
      CONFIG,
      T0,
    ));
    const top = topWeightedThoughts(thoughts, T0, 2, CONFIG.relevanceFloor);
    expect(top).toHaveLength(2);
    expect(top[0]!.weight).toBeGreaterThanOrEqual(top[1]!.weight);
    expect(top[0]!.thought.id).toBe('rank-1');
  });
});
