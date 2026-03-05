export const DEFAULT_EMOTIONAL_CONFIDENCE = 0.7;
export const DEFAULT_SESSION_MOOD_LEARNING_RATE = 0.55;

export interface EmotionalSnapshot {
  baselineValence: number;
  moodValence: number;
  moodDrift: number;
  moodSamples: number;
  lastMoodUpdateEpochMs?: number;
}

export interface EmotionalObservation {
  valence: number;
  confidence?: number;
  observedAtMs?: number;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_EMOTIONAL_CONFIDENCE;
  return Math.max(0, Math.min(1, value));
}

function normalizeCount(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value as number));
}

function round(value: number, precision = 4): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function resolveEmotionalBaselineLearningRate(sampleCount: number): number {
  if (sampleCount <= 0) return 0.4;
  if (sampleCount < 5) return 0.3;
  if (sampleCount < 15) return 0.2;
  return 0.12;
}

export function parseMoodSnapshot(
  baseline: Record<string, number> | undefined,
): EmotionalSnapshot {
  const baselineRecord = baseline ?? {};
  const baselineValence = clampUnit(
    baselineRecord.valenceBaseline,
  );
  const moodValence = clampUnit(
    baselineRecord.moodValence,
  );
  const moodDrift = Number.isFinite(baselineRecord.moodDrift)
    ? clampUnit(baselineRecord.moodDrift)
    : clampUnit(moodValence - baselineValence);
  const moodSamples = normalizeCount(baselineRecord.moodSamples);
  const lastMoodUpdateEpochMs = Number.isFinite(baselineRecord.lastMoodUpdateEpochMs)
    ? Math.max(0, Math.floor(baselineRecord.lastMoodUpdateEpochMs))
    : undefined;

  return {
    baselineValence,
    moodValence,
    moodDrift,
    moodSamples,
    lastMoodUpdateEpochMs,
  };
}

export function hasLearnedMoodSnapshot(snapshot: EmotionalSnapshot): boolean {
  if (snapshot.moodSamples > 0) return true;
  if (Math.abs(snapshot.baselineValence) >= 1e-6) return true;
  if (Math.abs(snapshot.moodValence) >= 1e-6) return true;
  return snapshot.lastMoodUpdateEpochMs !== undefined;
}

export function computeUpdatedEmotionalBaseline(
  baseline: Record<string, number> | undefined,
  observation: EmotionalObservation,
): Record<string, number> {
  const baselineRecord = { ...(baseline ?? {}) };
  const snapshot = parseMoodSnapshot(baselineRecord);
  const observedValence = clampUnit(observation.valence);
  const confidence = clampProbability(observation.confidence ?? DEFAULT_EMOTIONAL_CONFIDENCE);
  const confidenceWeight = 0.5 + (confidence * 0.5);
  const baselineLearningRate = resolveEmotionalBaselineLearningRate(snapshot.moodSamples) * confidenceWeight;
  const moodLearningRate = DEFAULT_SESSION_MOOD_LEARNING_RATE * confidenceWeight;

  const updatedBaselineValence = round(
    snapshot.baselineValence + ((observedValence - snapshot.baselineValence) * baselineLearningRate),
  );
  const updatedMoodValence = round(
    snapshot.moodValence + ((observedValence - snapshot.moodValence) * moodLearningRate),
  );
  const updatedMoodDrift = round(updatedMoodValence - updatedBaselineValence);
  const observedAtMs = Number.isFinite(observation.observedAtMs)
    ? Math.max(0, Math.floor(observation.observedAtMs as number))
    : Date.now();

  return {
    ...baselineRecord,
    valenceBaseline: updatedBaselineValence,
    moodValence: updatedMoodValence,
    moodDrift: updatedMoodDrift,
    lastObservedValence: round(observedValence),
    emotionalConfidence: round(confidence),
    moodSamples: snapshot.moodSamples + 1,
    lastMoodUpdateEpochMs: observedAtMs,
  };
}
