/**
 * CALIBRATION SUITE (c): outreach-timing agreement.
 *
 * Question: does the would_message lever FIRE when (and only when) the modeled
 * social/affiliative pressure has crossed threshold and been sustained — i.e.
 * does the "she would send a proactive message now" timing agree with the
 * expectation encoded in a scenario? This is the shadow-lever timing check; the
 * lever is TRACKING-ONLY telemetry and never sends anything itself.
 *
 * Driven end-to-end through the real ObserverLeverTracker over synthetic emo_sim
 * afterTick snapshot sequences (no live server needed — the tracker is a pure,
 * clock-driven state machine).
 *
 * Runnable independently:
 *   npx vitest run src/core/eval/observer-sidecar/calibration/outreach-timing.calibration.test.ts
 *
 * PASS CRITERIA (see OUTREACH_TIMING_PASS_CRITERIA):
 *   1. would_message fires at the first observation where the met condition has
 *      been sustained >= sustainMs since first crossing — never earlier.
 *   2. It never fires while the drivers are below threshold.
 *   3. Either trigger branch (socialNeed OR attachment-family dominance) fires.
 *   4. Cooldown blocks re-fire during one uninterrupted crossing; a full
 *      condition reset re-arms it.
 *
 * LIVE RE-BASELINE CAVEAT: the socialNeed/attachment TRAJECTORIES that actually
 * drive live timing come from emo_sim on real inputs and must be re-baselined
 * operator-side (with physiological drives disabled). This suite proves the
 * timing LOGIC over known state shapes; expected fire counts on live data cannot
 * be proven from fixtures.
 */

import { describe, expect, it } from 'vitest';
import { createDefaultObserverEvalSidecarLeverSettings } from '../../../../system/config/runtime-config-contracts.js';
import type { ObserverEvalSidecarLeverSettings } from '../../../../shared/contracts/runtime.js';
import {
  ObserverLeverTracker,
  type ObserverLeverSnapshotInput,
} from '../levers.js';

const T0 = 1_780_000_000_000;
const SUSTAIN_MS = 1_800_000; // 30 min — would_message default sustain
const COOLDOWN_MS = 21_600_000; // 6 h — default cooldown

export const OUTREACH_TIMING_PASS_CRITERIA = Object.freeze({
  socialNeedThreshold: 0.7,
  attachmentIntensityThreshold: 0.5,
  sustainMs: SUSTAIN_MS,
  cooldownMs: COOLDOWN_MS,
  firesOnlyAfterSustain: true,
  neverFiresBelowThreshold: true,
});

function makeSettings(overrides: Partial<ObserverEvalSidecarLeverSettings> = {}): ObserverEvalSidecarLeverSettings {
  return {
    ...createDefaultObserverEvalSidecarLeverSettings(),
    enabled: true,
    ...overrides,
  };
}

function snapshot(overrides: {
  socialNeed?: number;
  dominant?: string;
  dominantIntensity?: number;
  valence?: number;
  arousal?: number;
}): ObserverLeverSnapshotInput {
  const dominant = overrides.dominant ?? 'Calmness';
  return {
    t: 0,
    mood: { valence: overrides.valence ?? 0.2, arousal: overrides.arousal ?? 0.1 },
    dominant,
    emotions: { [dominant]: overrides.dominantIntensity ?? 0.3 },
    drives: { socialNeed: overrides.socialNeed ?? 0.2 },
  };
}

/** Run a timeline and return the observation times at which would_message fired. */
function wouldMessageFireTimes(
  tracker: ObserverLeverTracker,
  timeline: ReadonlyArray<{ atMs: number; snapshot: ObserverLeverSnapshotInput }>,
): number[] {
  const fires: number[] = [];
  for (const step of timeline) {
    const evaluation = tracker.evaluate({ snapshot: step.snapshot, observedAtMs: step.atMs });
    if (evaluation.events.some((event) => event.lever === 'would_message')) {
      fires.push(step.atMs);
    }
  }
  return fires;
}

describe('calibration (c): outreach-timing agreement', () => {
  it('fires would_message exactly when socialNeed has been sustained >= sustainMs, not before', () => {
    const tracker = new ObserverLeverTracker(makeSettings());
    const high = snapshot({ socialNeed: 0.85 });
    const fires = wouldMessageFireTimes(tracker, [
      { atMs: T0, snapshot: high }, // crossing begins
      { atMs: T0 + SUSTAIN_MS - 1, snapshot: high }, // still sustaining, must NOT fire
      { atMs: T0 + SUSTAIN_MS, snapshot: high }, // sustain met -> fire
    ]);
    expect(fires).toEqual([T0 + SUSTAIN_MS]);
  });

  it('never fires while socialNeed and attachment stay below threshold', () => {
    const tracker = new ObserverLeverTracker(makeSettings());
    const low = snapshot({ socialNeed: 0.5, dominant: 'Calmness', dominantIntensity: 0.4 });
    const fires = wouldMessageFireTimes(tracker, [
      { atMs: T0, snapshot: low },
      { atMs: T0 + SUSTAIN_MS, snapshot: low },
      { atMs: T0 + 2 * SUSTAIN_MS, snapshot: low },
    ]);
    expect(fires).toEqual([]);
  });

  it('fires via the attachment-family dominance branch when socialNeed is low', () => {
    const tracker = new ObserverLeverTracker(makeSettings());
    const attached = snapshot({ socialNeed: 0.2, dominant: 'Love', dominantIntensity: 0.6 });
    const fires = wouldMessageFireTimes(tracker, [
      { atMs: T0, snapshot: attached },
      { atMs: T0 + SUSTAIN_MS - 1, snapshot: attached },
      { atMs: T0 + SUSTAIN_MS, snapshot: attached },
    ]);
    expect(fires).toEqual([T0 + SUSTAIN_MS]);
  });

  it('resets the crossing when the driver drops, delaying the fire to the new sustain window', () => {
    const tracker = new ObserverLeverTracker(makeSettings());
    const high = snapshot({ socialNeed: 0.85 });
    const low = snapshot({ socialNeed: 0.4 });
    const reCrossAt = T0 + 2 * SUSTAIN_MS;
    const fires = wouldMessageFireTimes(tracker, [
      { atMs: T0, snapshot: high }, // crossing begins
      { atMs: T0 + 600_000, snapshot: low }, // drops after 10 min -> reset, no fire yet
      { atMs: reCrossAt, snapshot: high }, // new crossing begins
      { atMs: reCrossAt + SUSTAIN_MS - 1, snapshot: high }, // sustaining
      { atMs: reCrossAt + SUSTAIN_MS, snapshot: high }, // fire at new sustain window
    ]);
    expect(fires).toEqual([reCrossAt + SUSTAIN_MS]);
  });

  it('blocks re-fire within cooldown on one uninterrupted crossing, then re-fires after a reset', () => {
    const tracker = new ObserverLeverTracker(makeSettings());
    const high = snapshot({ socialNeed: 0.85 });
    const low = snapshot({ socialNeed: 0.3 });

    const firstFireAt = T0 + SUSTAIN_MS;
    const resetAt = firstFireAt + 60_000;
    const reCrossAt = resetAt + 60_000;
    const secondFireAt = reCrossAt + SUSTAIN_MS;

    const fires = wouldMessageFireTimes(tracker, [
      { atMs: T0, snapshot: high },
      { atMs: firstFireAt, snapshot: high }, // first fire
      { atMs: firstFireAt + 60_000, snapshot: high }, // still met, within cooldown -> blocked
      { atMs: resetAt, snapshot: low }, // reset the crossing
      { atMs: reCrossAt, snapshot: high }, // new crossing
      { atMs: secondFireAt, snapshot: high }, // re-fires via condition reset (not cooldown wait)
    ]);

    expect(fires).toEqual([firstFireAt, secondFireAt]);
    // The second fire happened well within the 6 h cooldown, so it can only be a
    // condition-reset re-arm, never a cooldown-elapsed re-fire.
    expect(secondFireAt - firstFireAt).toBeLessThan(COOLDOWN_MS);
  });
});
