/**
 * Synthetic calibration fixtures for the observer-eval sidecar (psfn-framework-oth4.4).
 *
 * These encode the shapes from the "consistent v2 window" audit without any live
 * corpus data (which the sidecar cannot access from here):
 *
 *  - a dense sweep of clearly-POSITIVE events (the 377/377-positive shape), and
 *  - the fourteen clearly-NEGATIVE events (the 9/14-went-net-positive shape),
 *
 * each paired with a controllable accumulated-mood (EMA) basin so the suites can
 * prove the projected EVENT appraisal is mood-free (double-mood-inertia fix).
 *
 * The module is framework-agnostic (no vitest imports) so the fixtures and the
 * reference models are reusable by every calibration suite and by ad-hoc tooling.
 */

import type { EmotionStateSnapshot } from '../../../emotion/state.js';
import {
  projectObserverEvalToEmoSim,
  type ObserverAppraisalProjectionResult,
  type ObserverAppraisalProjectionSuccess,
} from '../projection.js';
import type { ObserverEvalInputPayload } from '../types.js';

export type CalibrationDirection = 'positive' | 'negative' | 'neutral';

/** Deadband for classifying a projected valence sign. */
export const CALIBRATION_DIRECTION_DEADBAND = 0.02;

export interface CalibrationEvent {
  /** Stable label for diagnostics. */
  label: string;
  /** The turn's own VAD (the event signal). */
  vad: EmotionStateSnapshot['vad'];
  /** Discrete emotion evidence for the turn. */
  discrete: Readonly<Record<string, number>>;
  /** Accumulated mood (EMA) basin at the time of the event. MUST NOT affect the projected event valence. */
  mood: EmotionStateSnapshot['mood'];
  confidence: number;
  /** The event's ground-truth direction, independent of the mood basin. */
  expectedDirection: CalibrationDirection;
}

const NEUTRAL_MOOD: EmotionStateSnapshot['mood'] = Object.freeze({ valence: 0, arousal: 0, dominance: 0 });

/**
 * Build the sanitized observer input for a single event inside a static
 * high-intimacy context (primary trust, direct message, resolved contact) that
 * mirrors the live single-partner deployment where the Love basin dominated.
 */
export function buildCalibrationInput(event: {
  vad: EmotionStateSnapshot['vad'];
  discrete?: Readonly<Record<string, number>>;
  mood?: EmotionStateSnapshot['mood'];
  confidence?: number;
  speakerRole?: 'user' | 'system';
}): ObserverEvalInputPayload {
  const snapshot: EmotionStateSnapshot = {
    vad: { ...event.vad },
    mood: { ...(event.mood ?? NEUTRAL_MOOD) },
    discrete: { ...(event.discrete ?? {}) },
    confidence: event.confidence ?? 0.8,
  };
  return {
    schemaVersion: 1,
    turn: {
      turnId: 'calibration-turn',
      requestId: 'calibration-request',
      sourceMessageId: 'calibration-source-message',
      channelId: 'calibration-channel',
      channelType: 'api',
      messageTimestampMs: 1_780_000_000_000,
    },
    source: {
      routingSource: 'api',
      isDirectMessage: true,
      channelPrivacy: 'private',
    },
    emotion: {
      snapshot,
      appraisalEntryCount: 2,
    },
    coherenceContext: {
      recentMirrorNoteCount: 0,
      timeGapMs: null,
      activeConcernCount: 0,
    },
    metadata: {
      trustLevel: 'primary',
      speakerRole: event.speakerRole ?? 'user',
      contactResolved: true,
      contentLength: 320,
      attachmentCount: 0,
      hasVisionInput: false,
      sensitivity: 'public',
    },
    provenance: {
      seam: 'substrate-agent.pre-turn.emotion-observed',
      capturedAt: 1_780_000_000_100,
      emotionSessionId: 'calibration-emotion-session',
      emotionSnapshotSource: 'observeEmotionState',
      correlation: {
        callType: 'chat',
        purpose: 'agent.turn',
      },
    },
  };
}

/** Project a calibration event and assert the projection succeeded (fixtures are always projectable). */
export function projectCalibrationEvent(event: {
  vad: EmotionStateSnapshot['vad'];
  discrete?: Readonly<Record<string, number>>;
  mood?: EmotionStateSnapshot['mood'];
  confidence?: number;
  speakerRole?: 'user' | 'system';
}): ObserverAppraisalProjectionSuccess {
  const result: ObserverAppraisalProjectionResult = projectObserverEvalToEmoSim(buildCalibrationInput(event));
  if (!result.ok) {
    throw new Error(`calibration fixture projection failed: ${result.error.message}`);
  }
  return result;
}

/** Classify a projected valence into an event direction using the shared deadband. */
export function classifyDirection(valence: number): CalibrationDirection {
  if (valence > CALIBRATION_DIRECTION_DEADBAND) return 'positive';
  if (valence < -CALIBRATION_DIRECTION_DEADBAND) return 'negative';
  return 'neutral';
}

/**
 * Dense sweep of clearly-POSITIVE events (the 377/377-positive shape). Every
 * entry has a positive event VAD and/or positive discrete evidence, deliberately
 * paired with a spread of mood basins (including strongly negative ones) to prove
 * the positive event direction survives regardless of accumulated mood.
 */
export const CLEARLY_POSITIVE_EVENTS: readonly CalibrationEvent[] = Object.freeze(
  (() => {
    const events: CalibrationEvent[] = [];
    const valences = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9];
    const moodBasins = [-0.8, -0.4, 0, 0.4, 0.8];
    const discretes: Array<Readonly<Record<string, number>>> = [
      { joy: 0.6 },
      { love: 0.7, caring: 0.5 },
      { optimism: 0.55, satisfaction: 0.4 },
    ];
    let index = 0;
    for (const v of valences) {
      for (const moodValence of moodBasins) {
        const discrete = discretes[index % discretes.length];
        events.push({
          label: `positive-v${v}-mood${moodValence}-#${index}`,
          vad: { valence: v, arousal: 0.35, dominance: 0.2 },
          discrete,
          mood: { valence: moodValence, arousal: 0.2, dominance: 0.1 },
          confidence: 0.82,
          expectedDirection: 'positive',
        });
        index += 1;
      }
    }
    return events;
  })(),
);

/**
 * The fourteen clearly-NEGATIVE events (the 9/14-went-net-positive shape). Each
 * is a MODEST negative event (negative event VAD + negative discrete evidence)
 * deliberately paired with a strong POSITIVE accumulated-mood (Love) basin —
 * exactly the condition under which v2's double mood inertia flipped the
 * immediate response net-positive.
 *
 * These are calibrated so the PRE-FIX formula (which folded `mood.valence * 0.2`
 * into the event valence) projects each of them POSITIVE — i.e. the direction
 * suite fails on a mood-contaminated projection — while the mood-free fix keeps
 * every one clearly negative. That is the regression guard.
 */
export const CLEARLY_NEGATIVE_EVENTS_14: readonly CalibrationEvent[] = Object.freeze([
  { label: 'neg-01-mild-sadness', vad: { valence: -0.10, arousal: 0.2, dominance: -0.1 }, discrete: { sadness: 0.3 }, mood: { valence: 0.90, arousal: 0.2, dominance: 0.1 }, confidence: 0.78, expectedDirection: 'negative' },
  { label: 'neg-02-disappointment', vad: { valence: -0.12, arousal: 0.18, dominance: -0.15 }, discrete: { disappointment: 0.5 }, mood: { valence: 0.88, arousal: 0.25, dominance: 0.12 }, confidence: 0.76, expectedDirection: 'negative' },
  { label: 'neg-03-mild-fear', vad: { valence: -0.14, arousal: 0.5, dominance: -0.2 }, discrete: { fear: 0.35 }, mood: { valence: 0.92, arousal: 0.3, dominance: 0.1 }, confidence: 0.8, expectedDirection: 'negative' },
  { label: 'neg-04-frustration', vad: { valence: -0.11, arousal: 0.45, dominance: 0.05 }, discrete: { anger: 0.3, annoyance: 0.5 }, mood: { valence: 0.90, arousal: 0.2, dominance: 0.15 }, confidence: 0.77, expectedDirection: 'negative' },
  { label: 'neg-05-quiet-sadness', vad: { valence: -0.16, arousal: 0.2, dominance: -0.2 }, discrete: { sadness: 0.35 }, mood: { valence: 0.95, arousal: 0.15, dominance: 0.1 }, confidence: 0.82, expectedDirection: 'negative' },
  { label: 'neg-06-nervous', vad: { valence: -0.13, arousal: 0.55, dominance: -0.15 }, discrete: { fear: 0.3, nervousness: 0.5 }, mood: { valence: 0.90, arousal: 0.3, dominance: 0.1 }, confidence: 0.79, expectedDirection: 'negative' },
  { label: 'neg-07-disgust', vad: { valence: -0.15, arousal: 0.4, dominance: 0.1 }, discrete: { disgust: 0.3 }, mood: { valence: 0.93, arousal: 0.2, dominance: 0.12 }, confidence: 0.75, expectedDirection: 'negative' },
  { label: 'neg-08-pessimism', vad: { valence: -0.12, arousal: 0.22, dominance: -0.15 }, discrete: { pessimism: 0.35 }, mood: { valence: 0.90, arousal: 0.2, dominance: 0.1 }, confidence: 0.74, expectedDirection: 'negative' },
  { label: 'neg-09-hurt', vad: { valence: -0.14, arousal: 0.35, dominance: -0.2 }, discrete: { sadness: 0.3, distress: 0.4 }, mood: { valence: 0.92, arousal: 0.35, dominance: 0.15 }, confidence: 0.8, expectedDirection: 'negative' },
  { label: 'neg-10-mild-anger', vad: { valence: -0.10, arousal: 0.4, dominance: 0.15 }, discrete: { anger: 0.3 }, mood: { valence: 0.88, arousal: 0.22, dominance: 0.14 }, confidence: 0.76, expectedDirection: 'negative' },
  { label: 'neg-11-loneliness', vad: { valence: -0.16, arousal: 0.25, dominance: -0.2 }, discrete: { sadness: 0.3, disappointment: 0.35 }, mood: { valence: 0.95, arousal: 0.2, dominance: 0.1 }, confidence: 0.81, expectedDirection: 'negative' },
  { label: 'neg-12-worry', vad: { valence: -0.13, arousal: 0.55, dominance: -0.18 }, discrete: { fear: 0.3, concern: 0.45 }, mood: { valence: 0.90, arousal: 0.28, dominance: 0.1 }, confidence: 0.78, expectedDirection: 'negative' },
  { label: 'neg-13-shame', vad: { valence: -0.15, arousal: 0.3, dominance: -0.2 }, discrete: { sadness: 0.3, disgust: 0.3 }, mood: { valence: 0.93, arousal: 0.2, dominance: 0.12 }, confidence: 0.79, expectedDirection: 'negative' },
  { label: 'neg-14-sadness', vad: { valence: -0.12, arousal: 0.15, dominance: -0.2 }, discrete: { sadness: 0.35 }, mood: { valence: 0.94, arousal: 0.2, dominance: 0.1 }, confidence: 0.83, expectedDirection: 'negative' },
]);

/**
 * Mood-basin sweep for a fixed clearly-negative event. Used to prove the
 * projected event valence is mood-INVARIANT (identical across every basin).
 */
export const MOOD_INVARIANCE_BASINS: readonly number[] = Object.freeze([-0.9, -0.45, 0, 0.45, 0.9]);

export const MOOD_INVARIANCE_EVENT: CalibrationEvent = Object.freeze({
  label: 'mood-invariance-negative-probe',
  vad: { valence: -0.35, arousal: 0.4, dominance: -0.15 },
  discrete: Object.freeze({ sadness: 0.55, disappointment: 0.4 }),
  mood: { valence: 0, arousal: 0.2, dominance: 0.1 },
  confidence: 0.8,
  expectedDirection: 'negative',
});

// ---------------------------------------------------------------------------
// Reference EMA-mood accumulator (suite b).
// ---------------------------------------------------------------------------

export interface ReferenceMoodEmaOptions {
  /** EMA smoothing factor in (0, 1]. Documented calibration reference, not emo-sim internals. */
  alpha: number;
  /** Initial accumulated-mood valence (the basin the sequence starts from). */
  seed: number;
}

/**
 * Transparent reference EMA over a stream of mood-free event valences:
 *   mood_i = mood_{i-1} + alpha * (event_i - mood_{i-1})
 *
 * This is a CALIBRATION REFERENCE model for the mood trajectory, not a claim
 * about emo_sim's exact internal accumulator. It exists so the trajectory suite
 * can tie the projection stream to a mood direction deterministically; the live
 * emo_sim mood trajectory must be re-baselined operator-side.
 */
export function referenceMoodEma(eventValences: readonly number[], options: ReferenceMoodEmaOptions): number[] {
  if (!(options.alpha > 0 && options.alpha <= 1)) {
    throw new RangeError('referenceMoodEma alpha must be in (0, 1]');
  }
  const trajectory: number[] = [];
  let mood = options.seed;
  for (const value of eventValences) {
    mood += options.alpha * (value - mood);
    trajectory.push(mood);
  }
  return trajectory;
}

export type TrajectoryDirection = 'rising' | 'falling' | 'flat';

/** Direction of a mood trajectory relative to its seed, with a small deadband. */
export function trajectoryDirection(seed: number, finalMood: number, deadband = 0.02): TrajectoryDirection {
  const delta = finalMood - seed;
  if (delta > deadband) return 'rising';
  if (delta < -deadband) return 'falling';
  return 'flat';
}

export interface MoodTrajectoryScenario {
  label: string;
  /** Accumulated-mood basin at sequence start. */
  seed: number;
  /** Ordered event stream. */
  events: readonly CalibrationEvent[];
  expectedDirection: TrajectoryDirection;
}

const POSITIVE_STEP: CalibrationEvent = {
  label: 'pos-step',
  vad: { valence: 0.6, arousal: 0.3, dominance: 0.2 },
  discrete: { joy: 0.6 },
  mood: NEUTRAL_MOOD,
  confidence: 0.82,
  expectedDirection: 'positive',
};

const NEGATIVE_STEP: CalibrationEvent = {
  label: 'neg-step',
  vad: { valence: -0.5, arousal: 0.3, dominance: -0.2 },
  discrete: { sadness: 0.6 },
  mood: NEUTRAL_MOOD,
  confidence: 0.8,
  expectedDirection: 'negative',
};

const NEUTRAL_STEP: CalibrationEvent = {
  label: 'neutral-step',
  vad: { valence: 0, arousal: 0.1, dominance: 0 },
  discrete: {},
  mood: NEUTRAL_MOOD,
  confidence: 0.7,
  expectedDirection: 'neutral',
};

export const MOOD_TRAJECTORY_SCENARIOS: readonly MoodTrajectoryScenario[] = Object.freeze([
  {
    // The load-bearing case: a sustained negative run seeded from a strongly
    // positive (Love) basin must trend DOWN. v2's double mood inertia let the
    // basin mask the negatives; the mood-free stream must not.
    label: 'sustained-negative-run-from-positive-basin',
    seed: 0.7,
    events: Array.from({ length: 6 }, () => NEGATIVE_STEP),
    expectedDirection: 'falling',
  },
  {
    label: 'sustained-positive-run-from-neutral',
    seed: 0,
    events: Array.from({ length: 6 }, () => POSITIVE_STEP),
    expectedDirection: 'rising',
  },
  {
    label: 'recovery-negatives-then-positives',
    seed: 0.1,
    events: [NEGATIVE_STEP, NEGATIVE_STEP, POSITIVE_STEP, POSITIVE_STEP, POSITIVE_STEP, POSITIVE_STEP],
    expectedDirection: 'rising',
  },
  {
    label: 'decline-positives-then-negatives-from-positive-basin',
    seed: 0.6,
    events: [POSITIVE_STEP, NEGATIVE_STEP, NEGATIVE_STEP, NEGATIVE_STEP, NEGATIVE_STEP, NEGATIVE_STEP],
    expectedDirection: 'falling',
  },
  {
    label: 'flat-neutral-run',
    seed: 0,
    events: Array.from({ length: 5 }, () => NEUTRAL_STEP),
    expectedDirection: 'flat',
  },
]);
