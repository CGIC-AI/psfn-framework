import { isRecord } from '../../shared/utils/types.js';
import type { EmotionalSnapshot } from '../contacts/store/emotional-baseline.js';
import type { EmotionStateSnapshot } from '../emotion/state.js';

export type MotivationSignalKind =
  | 'vad_delta'
  | 'arousal_spike'
  | 'sustained_negative_valence'
  | 'sustained_mood_drift';

export interface MotivationSignal {
  kind: MotivationSignalKind;
  value: number;
  threshold: number;
  streak?: number;
  requiredStreak?: number;
}

export interface MotivationThresholdProfile {
  vadDeltaThreshold: number;
  arousalSpikeThreshold: number;
  highArousalThreshold: number;
  negativeMoodValenceThreshold: number;
  sustainedNegativeTurns: number;
  moodDriftThreshold: number;
  sustainedMoodDriftTurns: number;
  minConfidence: number;
}

export const DEFAULT_MOTIVATION_THRESHOLDS: MotivationThresholdProfile = Object.freeze({
  vadDeltaThreshold: 0.45,
  arousalSpikeThreshold: 0.35,
  highArousalThreshold: 0.45,
  negativeMoodValenceThreshold: -0.35,
  sustainedNegativeTurns: 3,
  moodDriftThreshold: 0.35,
  sustainedMoodDriftTurns: 3,
  minConfidence: 0.2,
});

export const PRIMARY_MOTIVATION_THRESHOLDS: MotivationThresholdProfile = Object.freeze({
  vadDeltaThreshold: 0.3,
  arousalSpikeThreshold: 0.25,
  highArousalThreshold: 0.35,
  negativeMoodValenceThreshold: -0.25,
  sustainedNegativeTurns: 2,
  moodDriftThreshold: 0.25,
  sustainedMoodDriftTurns: 2,
  minConfidence: 0.15,
});

export interface MotivationBridgeConfig {
  defaultThresholds?: Partial<MotivationThresholdProfile>;
  primaryThresholds?: Partial<MotivationThresholdProfile>;
}

export interface MotivationBridgeInput {
  sessionId: string;
  currentEmotion: EmotionStateSnapshot | null;
  contactEmotionalSnapshot?: EmotionalSnapshot | null;
  isPrimaryContact?: boolean;
}

export interface MotivationBridgeResult {
  shouldTriggerAppraisal: boolean;
  profile: 'default' | 'primary';
  signals: MotivationSignal[];
  metrics: {
    confidence: number;
    maxEmotionDelta: number;
    arousalDelta: number;
    moodDrift: number;
    negativeValenceStreak: number;
    moodDriftStreak: number;
  };
}

interface SessionMotivationState {
  previousEmotion: EmotionStateSnapshot | null;
  negativeValenceStreak: number;
  moodDriftStreak: number;
}

const EPSILON = 1e-6;


function normalizeSessionId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`MotivationBridge sessionId must be a string, received ${String(value)}`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('MotivationBridge sessionId must be non-empty');
  }
  return trimmed;
}

function parseUnit(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`${field} must be in range [0, 1]`);
  }
  return value;
}

function parseSigned(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (value < -1 || value > 1) {
    throw new Error(`${field} must be in range [-1, 1]`);
  }
  return value;
}

function parsePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (value <= 0) {
    throw new Error(`${field} must be > 0`);
  }
  return value;
}

function parsePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function normalizeEmotionSnapshot(snapshot: EmotionStateSnapshot): EmotionStateSnapshot {
  if (!isRecord(snapshot)) {
    throw new Error('Emotion snapshot must be an object');
  }
  if (!isRecord(snapshot.vad) || !isRecord(snapshot.mood) || !isRecord(snapshot.discrete)) {
    throw new Error('Emotion snapshot is missing required VAD/mood/discrete fields');
  }

  const discrete: Record<string, number> = {};
  for (const [rawLabel, rawScore] of Object.entries(snapshot.discrete)) {
    const label = rawLabel.trim().toLowerCase();
    if (!label) continue;
    discrete[label] = parseUnit(rawScore, `emotion.discrete.${label}`);
  }

  return {
    vad: {
      valence: parseSigned(snapshot.vad.valence, 'emotion.vad.valence'),
      arousal: parseSigned(snapshot.vad.arousal, 'emotion.vad.arousal'),
      dominance: parseSigned(snapshot.vad.dominance, 'emotion.vad.dominance'),
    },
    mood: {
      valence: parseSigned(snapshot.mood.valence, 'emotion.mood.valence'),
      arousal: parseSigned(snapshot.mood.arousal, 'emotion.mood.arousal'),
      dominance: parseSigned(snapshot.mood.dominance, 'emotion.mood.dominance'),
    },
    discrete,
    confidence: parseUnit(snapshot.confidence, 'emotion.confidence'),
  };
}

function mergeThresholds(
  base: MotivationThresholdProfile,
  overrides: Partial<MotivationThresholdProfile> | undefined,
): MotivationThresholdProfile {
  const merged = { ...base, ...(overrides ?? {}) };
  return normalizeThresholds(merged);
}

function normalizeThresholds(
  thresholds: MotivationThresholdProfile,
): MotivationThresholdProfile {
  const vadDeltaThreshold = parsePositiveNumber(thresholds.vadDeltaThreshold, 'motivation.vadDeltaThreshold');
  const arousalSpikeThreshold = parsePositiveNumber(
    thresholds.arousalSpikeThreshold,
    'motivation.arousalSpikeThreshold',
  );
  const highArousalThreshold = parseUnit(thresholds.highArousalThreshold, 'motivation.highArousalThreshold');
  const negativeMoodValenceThreshold = parseSigned(
    thresholds.negativeMoodValenceThreshold,
    'motivation.negativeMoodValenceThreshold',
  );
  if (negativeMoodValenceThreshold > 0) {
    throw new Error('motivation.negativeMoodValenceThreshold must be <= 0');
  }

  const sustainedNegativeTurns = parsePositiveInteger(
    thresholds.sustainedNegativeTurns,
    'motivation.sustainedNegativeTurns',
  );
  const moodDriftThreshold = parsePositiveNumber(thresholds.moodDriftThreshold, 'motivation.moodDriftThreshold');
  const sustainedMoodDriftTurns = parsePositiveInteger(
    thresholds.sustainedMoodDriftTurns,
    'motivation.sustainedMoodDriftTurns',
  );
  const minConfidence = parseUnit(thresholds.minConfidence, 'motivation.minConfidence');

  return {
    vadDeltaThreshold,
    arousalSpikeThreshold,
    highArousalThreshold,
    negativeMoodValenceThreshold,
    sustainedNegativeTurns,
    moodDriftThreshold,
    sustainedMoodDriftTurns,
    minConfidence,
  };
}

function resolveMoodBaseline(
  snapshot: EmotionalSnapshot | null | undefined,
): number {
  if (snapshot === null || snapshot === undefined) {
    return 0;
  }
  if (!isRecord(snapshot)) {
    throw new Error('contactEmotionalSnapshot must be an object when provided');
  }
  return parseSigned(snapshot.baselineValence, 'contactEmotionalSnapshot.baselineValence');
}

function maxEmotionDelta(previous: EmotionStateSnapshot | null, current: EmotionStateSnapshot): number {
  if (!previous) return 0;
  return Math.max(
    Math.abs(current.vad.valence - previous.vad.valence),
    Math.abs(current.vad.arousal - previous.vad.arousal),
    Math.abs(current.vad.dominance - previous.vad.dominance),
    Math.abs(current.mood.valence - previous.mood.valence),
    Math.abs(current.mood.arousal - previous.mood.arousal),
    Math.abs(current.mood.dominance - previous.mood.dominance),
  );
}

export class MotivationBridge {
  private readonly defaultThresholds: MotivationThresholdProfile;
  private readonly primaryThresholds: MotivationThresholdProfile;
  private readonly sessionState = new Map<string, SessionMotivationState>();

  constructor(config: MotivationBridgeConfig = {}) {
    this.defaultThresholds = mergeThresholds(DEFAULT_MOTIVATION_THRESHOLDS, config.defaultThresholds);
    this.primaryThresholds = mergeThresholds(PRIMARY_MOTIVATION_THRESHOLDS, config.primaryThresholds);
  }

  clearSession(sessionId: string): void {
    this.sessionState.delete(normalizeSessionId(sessionId));
  }

  assess(input: MotivationBridgeInput): MotivationBridgeResult {
    const sessionId = normalizeSessionId(input.sessionId);
    const profile = input.isPrimaryContact ? 'primary' : 'default';
    const thresholds = profile === 'primary' ? this.primaryThresholds : this.defaultThresholds;
    const state = this.sessionState.get(sessionId) ?? {
      previousEmotion: null,
      negativeValenceStreak: 0,
      moodDriftStreak: 0,
    };

    const currentEmotion = input.currentEmotion ? normalizeEmotionSnapshot(input.currentEmotion) : null;
    if (!currentEmotion) {
      this.sessionState.set(sessionId, {
        previousEmotion: null,
        negativeValenceStreak: 0,
        moodDriftStreak: 0,
      });
      return {
        shouldTriggerAppraisal: false,
        profile,
        signals: [],
        metrics: {
          confidence: 0,
          maxEmotionDelta: 0,
          arousalDelta: 0,
          moodDrift: 0,
          negativeValenceStreak: 0,
          moodDriftStreak: 0,
        },
      };
    }

    const baselineValence = resolveMoodBaseline(input.contactEmotionalSnapshot);
    const confidence = currentEmotion.confidence;
    const maxDelta = maxEmotionDelta(state.previousEmotion, currentEmotion);
    const arousalDelta = state.previousEmotion
      ? currentEmotion.vad.arousal - state.previousEmotion.vad.arousal
      : 0;
    const moodDrift = Math.abs(currentEmotion.mood.valence - baselineValence);
    const nextNegativeStreak = currentEmotion.mood.valence <= thresholds.negativeMoodValenceThreshold
      ? state.negativeValenceStreak + 1
      : 0;
    const nextMoodDriftStreak = moodDrift >= thresholds.moodDriftThreshold
      ? state.moodDriftStreak + 1
      : 0;

    const signals: MotivationSignal[] = [];
    if (confidence >= thresholds.minConfidence) {
      if (maxDelta + EPSILON >= thresholds.vadDeltaThreshold) {
        signals.push({
          kind: 'vad_delta',
          value: Number(maxDelta.toFixed(4)),
          threshold: thresholds.vadDeltaThreshold,
        });
      }
      if (
        state.previousEmotion
        && arousalDelta + EPSILON >= thresholds.arousalSpikeThreshold
        && currentEmotion.vad.arousal + EPSILON >= thresholds.highArousalThreshold
      ) {
        signals.push({
          kind: 'arousal_spike',
          value: Number(arousalDelta.toFixed(4)),
          threshold: thresholds.arousalSpikeThreshold,
        });
      }
      if (nextNegativeStreak === thresholds.sustainedNegativeTurns) {
        signals.push({
          kind: 'sustained_negative_valence',
          value: Number(currentEmotion.mood.valence.toFixed(4)),
          threshold: thresholds.negativeMoodValenceThreshold,
          streak: nextNegativeStreak,
          requiredStreak: thresholds.sustainedNegativeTurns,
        });
      }
      if (nextMoodDriftStreak === thresholds.sustainedMoodDriftTurns) {
        signals.push({
          kind: 'sustained_mood_drift',
          value: Number(moodDrift.toFixed(4)),
          threshold: thresholds.moodDriftThreshold,
          streak: nextMoodDriftStreak,
          requiredStreak: thresholds.sustainedMoodDriftTurns,
        });
      }
    }

    this.sessionState.set(sessionId, {
      previousEmotion: currentEmotion,
      negativeValenceStreak: confidence >= thresholds.minConfidence ? nextNegativeStreak : 0,
      moodDriftStreak: confidence >= thresholds.minConfidence ? nextMoodDriftStreak : 0,
    });

    return {
      shouldTriggerAppraisal: signals.length > 0,
      profile,
      signals,
      metrics: {
        confidence: Number(confidence.toFixed(4)),
        maxEmotionDelta: Number(maxDelta.toFixed(4)),
        arousalDelta: Number(arousalDelta.toFixed(4)),
        moodDrift: Number(moodDrift.toFixed(4)),
        negativeValenceStreak: confidence >= thresholds.minConfidence ? nextNegativeStreak : 0,
        moodDriftStreak: confidence >= thresholds.minConfidence ? nextMoodDriftStreak : 0,
      },
    };
  }
}
