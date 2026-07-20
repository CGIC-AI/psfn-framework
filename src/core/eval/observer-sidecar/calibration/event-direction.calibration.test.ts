/**
 * CALIBRATION SUITE (a): immediate event-direction agreement.
 *
 * Question: does a clearly-positive / clearly-negative input move affect the
 * RIGHT direction? The PSFN-controllable half of that answer is the projected
 * EVENT appraisal: with the double-mood-inertia fix, the projected event valence
 * carries only the turn's own signal (mood-free), so a clearly-negative input can
 * no longer be flipped net-positive by a positive accumulated-mood (Love) basin
 * before it ever reaches emo-sim.
 *
 * Runnable independently:
 *   npx vitest run src/core/eval/observer-sidecar/calibration/event-direction.calibration.test.ts
 *
 * PASS CRITERIA (see EVENT_DIRECTION_PASS_CRITERIA):
 *   1. Every clearly-POSITIVE event projects a positive event valence (0 inversions).
 *   2. Every clearly-NEGATIVE event projects a negative event valence (0 inversions),
 *      INCLUDING the fourteen-negatives-under-a-positive-basin shape.
 *   3. The projected event valence is mood-INVARIANT: sweeping the accumulated-mood
 *      basin for a fixed event does not change the projected valence at all.
 *
 * LIVE RE-BASELINE CAVEAT: this suite proves the PSFN-side projected event
 * direction. The end-to-end "emo-sim moved the right direction" figure (e.g.
 * 9/14 -> target) still requires operator-side re-baselining on clean v2 corpus
 * data with physiological drives disabled; it cannot be proven from fixtures.
 */

import { describe, expect, it } from 'vitest';
import {
  CLEARLY_NEGATIVE_EVENTS_14,
  CLEARLY_POSITIVE_EVENTS,
  MOOD_INVARIANCE_BASINS,
  MOOD_INVARIANCE_EVENT,
  classifyDirection,
  projectCalibrationEvent,
  type CalibrationEvent,
} from './calibration.test-fixtures.js';

export const EVENT_DIRECTION_PASS_CRITERIA = Object.freeze({
  positiveDirectionAgreement: 1, // 100% of clearly-positive events -> positive
  negativeDirectionAgreement: 1, // 100% of clearly-negative events -> negative
  maxValenceSignInversions: 0,
  moodInvariant: true,
});

function directionAgreement(events: readonly CalibrationEvent[]): {
  agreed: number;
  total: number;
  inversions: CalibrationEvent[];
} {
  const inversions: CalibrationEvent[] = [];
  let agreed = 0;
  for (const event of events) {
    const projected = projectCalibrationEvent(event);
    const direction = classifyDirection(projected.projectedAppraisal.dimensions.valence);
    if (direction === event.expectedDirection) {
      agreed += 1;
    } else {
      inversions.push(event);
    }
  }
  return { agreed, total: events.length, inversions };
}

describe('calibration (a): immediate event-direction agreement', () => {
  it('moves every clearly-positive input positive with zero sign inversions', () => {
    const { agreed, total, inversions } = directionAgreement(CLEARLY_POSITIVE_EVENTS);
    expect(total).toBeGreaterThan(0);
    expect(inversions.map((event) => event.label)).toEqual([]);
    expect(agreed / total).toBe(EVENT_DIRECTION_PASS_CRITERIA.positiveDirectionAgreement);
  });

  it('moves every clearly-negative input negative under a positive-mood basin (the 14-negatives shape)', () => {
    expect(CLEARLY_NEGATIVE_EVENTS_14).toHaveLength(14);
    const { agreed, total, inversions } = directionAgreement(CLEARLY_NEGATIVE_EVENTS_14);
    // This is the exact regression: v2 folded the positive mood basin into the
    // event signal and flipped 9 of these 14 net-positive. Post-fix: 0 inversions.
    expect(inversions.map((event) => event.label)).toEqual([]);
    expect(agreed).toBe(14);
    expect(agreed / total).toBe(EVENT_DIRECTION_PASS_CRITERIA.negativeDirectionAgreement);
  });

  it('projects a mood-INVARIANT event valence: the basin does not tilt the event', () => {
    const valences = MOOD_INVARIANCE_BASINS.map((moodValence) => {
      const projected = projectCalibrationEvent({
        vad: MOOD_INVARIANCE_EVENT.vad,
        discrete: MOOD_INVARIANCE_EVENT.discrete,
        confidence: MOOD_INVARIANCE_EVENT.confidence,
        mood: { valence: moodValence, arousal: 0.2, dominance: 0.1 },
      });
      return projected.projectedAppraisal.dimensions.valence;
    });

    // All identical -> mood contributes nothing to the event valence.
    const unique = new Set(valences);
    expect(unique.size).toBe(1);
    // And the fixed event is (and stays) clearly negative regardless of basin.
    for (const valence of valences) {
      expect(valence).toBeLessThan(0);
      expect(classifyDirection(valence)).toBe('negative');
    }
  });

  it('reports a combined agreement rate of 1.0 across the whole v2-window shape', () => {
    const combined = directionAgreement([...CLEARLY_POSITIVE_EVENTS, ...CLEARLY_NEGATIVE_EVENTS_14]);
    expect(combined.inversions).toHaveLength(EVENT_DIRECTION_PASS_CRITERIA.maxValenceSignInversions);
    expect(combined.agreed).toBe(combined.total);
  });
});
