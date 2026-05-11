export const DEFAULT_EMOTIONAL_CONFIDENCE = 0.7;
export const DEFAULT_SESSION_MOOD_LEARNING_RATE = 0.55;
export const DEFAULT_CONTACT_EMOTIONAL_TIME_SERIES_LIMIT = 8;

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

export interface EmotionalTimeSeriesPoint {
  valence: number;
  confidence: number;
  observedAtMs: number;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_EMOTIONAL_CONFIDENCE;
  return Math.max(0, Math.min(1, value));
}

function normalizeConfidence(value: number | undefined): number {
  return clampProbability(value ?? DEFAULT_EMOTIONAL_CONFIDENCE);
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

function normalizeSeriesLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_CONTACT_EMOTIONAL_TIME_SERIES_LIMIT;
  return Math.max(1, Math.min(64, Math.floor(limit as number)));
}

function normalizeObservedAtMs(value: number | undefined): number {
  if (!Number.isFinite(value)) return Date.now();
  return Math.max(0, Math.floor(value as number));
}

function normalizeTimeSeriesPoint(
  value: unknown,
): EmotionalTimeSeriesPoint | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const point = value as Partial<EmotionalTimeSeriesPoint>;
  if (!Number.isFinite(point.valence)) return undefined;
  return {
    valence: round(clampUnit(point.valence as number)),
    confidence: round(normalizeConfidence(point.confidence)),
    observedAtMs: normalizeObservedAtMs(point.observedAtMs),
  };
}

function finalizeTimeSeries(
  points: readonly unknown[],
  limit: number | undefined,
): EmotionalTimeSeriesPoint[] {
  const boundedLimit = normalizeSeriesLimit(limit);
  const deduped = new Map<string, EmotionalTimeSeriesPoint>();
  for (const point of points) {
    const normalized = normalizeTimeSeriesPoint(point);
    if (!normalized) continue;
    deduped.set(
      `${normalized.observedAtMs}:${normalized.valence.toFixed(4)}:${normalized.confidence.toFixed(4)}`,
      normalized,
    );
  }
  return [...deduped.values()]
    .sort((left, right) => left.observedAtMs - right.observedAtMs)
    .slice(-boundedLimit);
}

export function normalizeEmotionalTimeSeries(
  value: unknown,
  limit = DEFAULT_CONTACT_EMOTIONAL_TIME_SERIES_LIMIT,
): EmotionalTimeSeriesPoint[] {
  if (Array.isArray(value)) {
    return finalizeTimeSeries(value, limit);
  }
  if (typeof value === 'string') {
    try {
      return normalizeEmotionalTimeSeries(JSON.parse(value), limit);
    } catch {
      return [];
    }
  }
  return [];
}

export function appendEmotionalObservationToTimeSeries(
  series: unknown,
  observation: EmotionalObservation,
  limit = DEFAULT_CONTACT_EMOTIONAL_TIME_SERIES_LIMIT,
): EmotionalTimeSeriesPoint[] {
  const nextPoint: EmotionalTimeSeriesPoint = {
    valence: round(clampUnit(observation.valence)),
    confidence: round(normalizeConfidence(observation.confidence)),
    observedAtMs: normalizeObservedAtMs(observation.observedAtMs),
  };
  return finalizeTimeSeries(
    [...normalizeEmotionalTimeSeries(series, limit), nextPoint],
    limit,
  );
}

export function mergeEmotionalTimeSeries(
  left: unknown,
  right: unknown,
  limit = DEFAULT_CONTACT_EMOTIONAL_TIME_SERIES_LIMIT,
): EmotionalTimeSeriesPoint[] {
  return finalizeTimeSeries(
    [
      ...normalizeEmotionalTimeSeries(left, limit),
      ...normalizeEmotionalTimeSeries(right, limit),
    ],
    limit,
  );
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
