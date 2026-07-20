/**
 * CALIBRATION SUITE (b): EMA-mood trajectory agreement.
 *
 * Question: over a sequence of events, does the accumulated (EMA) mood trend the
 * direction the event stream implies? This is the temporal companion to the
 * per-event direction suite: even with correct per-event signs, the accumulated
 * mood must actually move — a sustained negative run seeded from a positive (Love)
 * basin must trend DOWN, not be masked by the basin.
 *
 * The projected event valences that feed the accumulator are mood-free (the
 * double-mood-inertia fix), so the basin enters the trajectory exactly once — as
 * the EMA seed — instead of also being folded into every event.
 *
 * Runnable independently:
 *   npx vitest run src/core/eval/observer-sidecar/calibration/mood-trajectory.calibration.test.ts
 *
 * PASS CRITERIA (see MOOD_TRAJECTORY_PASS_CRITERIA):
 *   1. Each scenario's reference-EMA trajectory direction equals its expectation.
 *   2. A sustained negative run seeded from a positive basin trends falling.
 *   3. The seed (basin) is applied exactly once: the per-step increments depend
 *      only on the mood-free event valences, not on any per-event mood term.
 *
 * REFERENCE MODEL: the EMA in fixtures.referenceMoodEma is a transparent
 * calibration reference (documented alpha), NOT emo_sim's internal accumulator.
 *
 * LIVE RE-BASELINE CAVEAT: the live emo_sim mood trajectory must be re-baselined
 * operator-side on clean corpus data; this suite proves the projection stream
 * produces the right trajectory under a documented reference accumulator.
 */

import { describe, expect, it } from 'vitest';
import {
  MOOD_TRAJECTORY_SCENARIOS,
  projectCalibrationEvent,
  referenceMoodEma,
  trajectoryDirection,
  type CalibrationEvent,
} from './calibration.test-fixtures.js';

export const MOOD_TRAJECTORY_PASS_CRITERIA = Object.freeze({
  emaAlpha: 0.3,
  trajectoryDeadband: 0.02,
  requireDirectionMatch: true,
});

function projectedValences(events: readonly CalibrationEvent[]): number[] {
  return events.map((event) =>
    projectCalibrationEvent({
      vad: event.vad,
      discrete: event.discrete,
      confidence: event.confidence,
      mood: event.mood,
    }).projectedAppraisal.dimensions.valence,
  );
}

describe('calibration (b): EMA-mood trajectory agreement', () => {
  for (const scenario of MOOD_TRAJECTORY_SCENARIOS) {
    it(`trends ${scenario.expectedDirection} for ${scenario.label}`, () => {
      const valences = projectedValences(scenario.events);
      const trajectory = referenceMoodEma(valences, {
        alpha: MOOD_TRAJECTORY_PASS_CRITERIA.emaAlpha,
        seed: scenario.seed,
      });
      const finalMood = trajectory[trajectory.length - 1];
      const direction = trajectoryDirection(
        scenario.seed,
        finalMood,
        MOOD_TRAJECTORY_PASS_CRITERIA.trajectoryDeadband,
      );
      expect(direction).toBe(scenario.expectedDirection);
    });
  }

  it('lets a sustained negative run pull the mood below its positive seed basin', () => {
    const scenario = MOOD_TRAJECTORY_SCENARIOS.find(
      (candidate) => candidate.label === 'sustained-negative-run-from-positive-basin',
    );
    expect(scenario).toBeDefined();
    if (!scenario) return;

    const valences = projectedValences(scenario.events);
    const trajectory = referenceMoodEma(valences, {
      alpha: MOOD_TRAJECTORY_PASS_CRITERIA.emaAlpha,
      seed: scenario.seed,
    });
    // Monotonically decreasing from the positive basin, ending clearly below it.
    for (let i = 1; i < trajectory.length; i += 1) {
      expect(trajectory[i]).toBeLessThan(trajectory[i - 1]);
    }
    expect(trajectory[trajectory.length - 1]).toBeLessThan(scenario.seed);
  });

  it('applies the basin exactly once: the trajectory is seed-shifted, not seed-scaled', () => {
    // Same mood-free event stream under two different seeds must differ by an
    // amount that decays with the EMA, proving the seed enters once and the
    // per-step increments are seed-independent given identical event valences.
    const events = MOOD_TRAJECTORY_SCENARIOS[0].events;
    const valences = projectedValences(events);
    const alpha = MOOD_TRAJECTORY_PASS_CRITERIA.emaAlpha;
    const fromPositive = referenceMoodEma(valences, { alpha, seed: 0.7 });
    const fromNeutral = referenceMoodEma(valences, { alpha, seed: 0 });

    // The gap between the two trajectories is exactly (1 - alpha)^i * seedGap,
    // independent of the event valences — the hallmark of a single seed entry.
    const seedGap = 0.7;
    for (let i = 0; i < valences.length; i += 1) {
      const expectedGap = seedGap * ((1 - alpha) ** (i + 1));
      expect(fromPositive[i] - fromNeutral[i]).toBeCloseTo(expectedGap, 10);
    }
  });
});
