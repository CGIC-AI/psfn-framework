export interface VADVector {
  valence: number;
  arousal: number;
  dominance: number;
}

export interface EmotionObservation {
  vad?: Partial<VADVector>;
  discrete?: Record<string, number>;
  confidence?: number;
}

export interface EmotionStateSnapshot {
  vad: VADVector;
  mood: VADVector;
  discrete: Record<string, number>;
  confidence: number;
}

export interface EmotionStateConfig {
  vadHalfLifeSeconds?: Partial<VADVector>;
  discreteHalfLifeSeconds?: Record<string, number>;
  defaultDiscreteHalfLifeSeconds?: number;
  moodAlpha?: number;
  confidenceAlpha?: number;
  defaultObservationConfidence?: number;
}

const EPSILON = 1e-4;
const DEFAULT_MOOD_ALPHA = 0.1;
const DEFAULT_CONFIDENCE_ALPHA = 0.25;
const DEFAULT_OBSERVATION_CONFIDENCE = 0.7;
const DEFAULT_DISCRETE_HALF_LIFE_SECONDS = 30 * 60;

const DEFAULT_VAD_HALF_LIFE_SECONDS: VADVector = {
  valence: 30 * 60,
  arousal: 20 * 60,
  dominance: 45 * 60,
};

const RESEARCH_DISCRETE_HALF_LIFE_SECONDS: Record<string, number> = {
  joy: 30 * 60,
  anger: 45 * 60,
  sadness: 60 * 60,
  surprise: 5 * 60,
  love: 2 * 60 * 60,
};

const VAD_KEYS = ['valence', 'arousal', 'dominance'] as const;

export class EmotionState {
  private vad: VADVector;
  private mood: VADVector;
  private readonly discrete = new Map<string, number>();
  private confidence = 0;
  private readonly vadHalfLifeSeconds: VADVector;
  private readonly discreteHalfLifeSeconds: Map<string, number>;
  private readonly defaultDiscreteHalfLifeSeconds: number;
  private readonly moodAlpha: number;
  private readonly confidenceAlpha: number;
  private readonly defaultObservationConfidence: number;

  constructor(config: EmotionStateConfig = {}, initialState?: Partial<EmotionStateSnapshot>) {
    this.vadHalfLifeSeconds = {
      valence: positiveOr(config.vadHalfLifeSeconds?.valence, DEFAULT_VAD_HALF_LIFE_SECONDS.valence),
      arousal: positiveOr(config.vadHalfLifeSeconds?.arousal, DEFAULT_VAD_HALF_LIFE_SECONDS.arousal),
      dominance: positiveOr(config.vadHalfLifeSeconds?.dominance, DEFAULT_VAD_HALF_LIFE_SECONDS.dominance),
    };
    this.defaultDiscreteHalfLifeSeconds = positiveOr(
      config.defaultDiscreteHalfLifeSeconds,
      DEFAULT_DISCRETE_HALF_LIFE_SECONDS,
    );
    this.discreteHalfLifeSeconds = new Map(
      Object.entries({
        ...RESEARCH_DISCRETE_HALF_LIFE_SECONDS,
        ...(config.discreteHalfLifeSeconds ?? {}),
      }).map(([emotion, halfLifeSeconds]) => [emotion.trim().toLowerCase(), positiveOr(halfLifeSeconds, this.defaultDiscreteHalfLifeSeconds)]),
    );
    this.moodAlpha = alphaOr(config.moodAlpha, DEFAULT_MOOD_ALPHA);
    this.confidenceAlpha = alphaOr(config.confidenceAlpha, DEFAULT_CONFIDENCE_ALPHA);
    this.defaultObservationConfidence = alphaOr(
      config.defaultObservationConfidence,
      DEFAULT_OBSERVATION_CONFIDENCE,
    );

    this.vad = normalizeVAD(initialState?.vad);
    this.mood = normalizeVAD(initialState?.mood);
    this.confidence = clampUnit(initialState?.confidence ?? 0);

    for (const [rawEmotion, rawScore] of Object.entries(initialState?.discrete ?? {})) {
      const emotion = rawEmotion.trim().toLowerCase();
      if (!emotion) continue;
      const score = clampUnit(rawScore);
      if (score > EPSILON) {
        this.discrete.set(emotion, score);
      }
    }
  }

  update(observation: EmotionObservation, elapsedSeconds: number): EmotionStateSnapshot {
    const elapsed = normalizeElapsedSeconds(elapsedSeconds);
    this.applyDecay(elapsed);
    this.applyObservation(observation);
    this.applyMoodEma();
    return this.getState();
  }

  getState(): EmotionStateSnapshot {
    const discreteEntries = [...this.discrete.entries()].sort(([left], [right]) => left.localeCompare(right));
    return {
      vad: { ...this.vad },
      mood: { ...this.mood },
      discrete: Object.fromEntries(discreteEntries),
      confidence: this.confidence,
    };
  }

  serialize(): EmotionStateSnapshot {
    return this.getState();
  }

  static deserialize(
    snapshot: Partial<EmotionStateSnapshot> | undefined,
    config: EmotionStateConfig = {},
  ): EmotionState {
    return new EmotionState(config, snapshot);
  }

  private applyDecay(elapsedSeconds: number): void {
    if (elapsedSeconds <= 0) return;

    for (const key of VAD_KEYS) {
      const halfLife = this.vadHalfLifeSeconds[key];
      this.vad[key] = clampSigned(this.vad[key] * decayFactor(halfLife, elapsedSeconds));
    }

    for (const [emotion, score] of this.discrete.entries()) {
      const halfLife = this.discreteHalfLifeSeconds.get(emotion) ?? this.defaultDiscreteHalfLifeSeconds;
      const decayed = clampUnit(score * decayFactor(halfLife, elapsedSeconds));
      if (decayed <= EPSILON) {
        this.discrete.delete(emotion);
      } else {
        this.discrete.set(emotion, decayed);
      }
    }
  }

  private applyObservation(observation: EmotionObservation | undefined): void {
    if (!observation) return;

    const signalWeight = clampUnit(observation.confidence ?? this.defaultObservationConfidence);
    let hasSignal = false;

    for (const key of VAD_KEYS) {
      const rawImpulse = observation.vad?.[key];
      if (rawImpulse === undefined) continue;
      const impulse = clampSigned(rawImpulse) * signalWeight;
      this.vad[key] = clampSigned(this.vad[key] + impulse);
      hasSignal = true;
    }

    for (const [rawEmotion, rawScore] of Object.entries(observation.discrete ?? {})) {
      const emotion = rawEmotion.trim().toLowerCase();
      if (!emotion) continue;
      const impulse = clampUnit(rawScore) * signalWeight;
      if (impulse <= 0) continue;
      const current = this.discrete.get(emotion) ?? 0;
      const next = clampUnit(current + impulse);
      if (next <= EPSILON) {
        this.discrete.delete(emotion);
      } else {
        this.discrete.set(emotion, next);
      }
      hasSignal = true;
    }

    if (hasSignal) {
      this.confidence = clampUnit(
        this.confidence + ((signalWeight - this.confidence) * this.confidenceAlpha),
      );
    }
  }

  private applyMoodEma(): void {
    for (const key of VAD_KEYS) {
      this.mood[key] = clampSigned(
        this.mood[key] + ((this.vad[key] - this.mood[key]) * this.moodAlpha),
      );
    }
  }
}

function normalizeVAD(vad: Partial<VADVector> | undefined): VADVector {
  return {
    valence: clampSigned(vad?.valence ?? 0),
    arousal: clampSigned(vad?.arousal ?? 0),
    dominance: clampSigned(vad?.dominance ?? 0),
  };
}

function normalizeElapsedSeconds(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`elapsedSeconds must be a finite number >= 0, received ${String(value)}`);
  }
  return value;
}

function positiveOr(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value as number) <= 0) return fallback;
  return value as number;
}

function alphaOr(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return clampUnit(value as number);
}

function clampSigned(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function decayFactor(halfLifeSeconds: number, elapsedSeconds: number): number {
  return Math.exp((-Math.LN2 * elapsedSeconds) / halfLifeSeconds);
}
