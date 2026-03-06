import { EmotionState, type EmotionObservation, type EmotionStateSnapshot, type VADVector } from './state.js';
import {
  toAudioEmotionSignal,
  type AudioEmotionClassification,
  type AudioEmotionClassifierLike,
} from './audio-classifier.js';
import {
  getSharedTextEmotionClassifier,
  type TextEmotionClassification,
} from './text-classifier.js';
import {
  loadVadLexicon,
  scoreVadTokens,
  tokenizeVadText,
  type VadLexicon,
} from './vad-lexicon.js';

export interface TextEmotionClassifierLike {
  classify(text: string): Promise<readonly TextEmotionClassification[]>;
}

export interface EmotionObserverAudioInput {
  audioBuffer: Buffer;
  sampleRate: number;
}

export interface EmotionObserverAudioObservation {
  observation: EmotionObservation;
  events: readonly string[];
  classifications: readonly AudioEmotionClassification[];
}

export interface EmotionObserverModalityObservations {
  text: EmotionObservation;
  audio?: EmotionObserverAudioObservation;
}

export interface EmotionObserverConfig {
  state?: EmotionState;
  textClassifier?: TextEmotionClassifierLike;
  audioClassifier?: AudioEmotionClassifierLike | null;
  vadLexicon?: VadLexicon;
  maxTextLength?: number;
}

export interface EmotionObserverResult {
  observation: EmotionObservation;
  snapshot: EmotionStateSnapshot;
  fusedLabel: string | null;
  fusedLabelConfidence: number;
}

const RAW_TEXT_EMOTION_LABEL_VAD_MAP = {
  anger: { valence: -0.8, arousal: 0.8, dominance: 0.6 },
  anticipation: { valence: 0.3, arousal: 0.6, dominance: 0.2 },
  confusion: { valence: -0.2, arousal: 0.5, dominance: -0.4 },
  disgust: { valence: -0.7, arousal: 0.6, dominance: 0.1 },
  fear: { valence: -0.7, arousal: 0.9, dominance: -0.7 },
  joy: { valence: 0.8, arousal: 0.6, dominance: 0.2 },
  love: { valence: 0.9, arousal: 0.5, dominance: 0.1 },
  neutral: { valence: 0, arousal: 0, dominance: 0 },
  optimism: { valence: 0.7, arousal: 0.4, dominance: 0.5 },
  pessimism: { valence: -0.7, arousal: 0.5, dominance: -0.3 },
  sadness: { valence: -0.8, arousal: 0.3, dominance: -0.6 },
  surprise: { valence: 0.2, arousal: 0.9, dominance: 0 },
  trust: { valence: 0.6, arousal: 0.2, dominance: 0.4 },
} as const satisfies Record<string, Readonly<VADVector>>;

export const TEXT_EMOTION_LABEL_VAD_MAP: Readonly<Record<string, Readonly<VADVector>>> = Object.freeze(
  Object.fromEntries(
    Object.entries(RAW_TEXT_EMOTION_LABEL_VAD_MAP).map(([label, vad]) => [
      label,
      Object.freeze({ ...vad }),
    ]),
  ),
);

export const DEFAULT_EMOTION_OBSERVER_MAX_TEXT_LENGTH = 2_000;

const SIGNAL_EPSILON = 1e-6;
const VAD_KEYS = ['valence', 'arousal', 'dominance'] as const;
const NEUTRAL_SIGNED_VAD: Readonly<VADVector> = Object.freeze({
  valence: 0,
  arousal: 0,
  dominance: 0,
});

type VadKey = typeof VAD_KEYS[number];

interface CategoricalSignal {
  label: string;
  confidence: number;
  vad: VADVector;
}

interface LexiconSignal {
  vad: VADVector;
  confidence: number;
}

export class EmotionObserver {
  private readonly state: EmotionState;
  private readonly textClassifier: TextEmotionClassifierLike;
  private readonly audioClassifier: AudioEmotionClassifierLike | null;
  private readonly vadLexicon: VadLexicon;
  private readonly maxTextLength: number;

  constructor(config: EmotionObserverConfig = {}) {
    this.state = config.state ?? new EmotionState();
    this.textClassifier = config.textClassifier ?? getSharedTextEmotionClassifier();
    this.audioClassifier = config.audioClassifier ?? null;
    this.vadLexicon = config.vadLexicon ?? loadVadLexicon();
    this.maxTextLength = normalizeMaxTextLength(config.maxTextLength);
  }

  getState(): EmotionStateSnapshot {
    return this.state.getState();
  }

  async observe(text: string, elapsedSeconds: number): Promise<EmotionObserverResult> {
    const observation = await this.buildObservation(text);
    const snapshot = this.state.update(observation, elapsedSeconds);
    return {
      observation,
      snapshot,
      fusedLabel: resolveFusedLabel(observation.discrete),
      fusedLabelConfidence: clampUnit(observation.confidence ?? 0),
    };
  }

  async buildObservation(text: string): Promise<EmotionObservation> {
    const normalizedText = normalizeObserverText(text, this.maxTextLength);
    const [classifications, lexiconSignal] = await Promise.all([
      this.textClassifier.classify(normalizedText),
      Promise.resolve(this.scoreLexiconSignal(normalizedText)),
    ]);

    const classifierSignal = resolveClassifierSignal(classifications);
    const lexiconCategoricalSignal = resolveLexiconCategoricalSignal(lexiconSignal);
    const fusedCategorical = chooseStrongestCategoricalSignal([
      classifierSignal,
      lexiconCategoricalSignal,
    ]);

    const categoricalWeight = fusedCategorical?.confidence ?? 0;
    const lexiconWeight = lexiconSignal.confidence;
    const observationConfidence = clampUnit(Math.max(categoricalWeight, lexiconWeight));
    const fusedVad = fuseVadSignals(
      fusedCategorical?.vad ?? NEUTRAL_SIGNED_VAD,
      categoricalWeight,
      lexiconSignal.vad,
      lexiconWeight,
    );

    if (!fusedVad || observationConfidence <= SIGNAL_EPSILON) {
      return {};
    }

    return {
      vad: fusedVad,
      discrete: fusedCategorical ? { [fusedCategorical.label]: 1 } : undefined,
      confidence: observationConfidence,
    };
  }

  async classifyAudio(input: EmotionObserverAudioInput): Promise<readonly AudioEmotionClassification[]> {
    if (!this.audioClassifier) {
      throw new Error('audio emotion classifier is not configured');
    }
    return this.audioClassifier.classify(input.audioBuffer, input.sampleRate);
  }

  async buildAudioObservation(input: EmotionObserverAudioInput): Promise<EmotionObserverAudioObservation> {
    const classifications = await this.classifyAudio(input);
    const signal = toAudioEmotionSignal(classifications);
    return {
      observation: signal.observation,
      events: signal.events,
      classifications: [...classifications],
    };
  }

  async buildModalityObservations(input: {
    text: string;
    audio?: EmotionObserverAudioInput | null;
  }): Promise<EmotionObserverModalityObservations> {
    const text = await this.buildObservation(input.text);
    if (!input.audio) {
      return { text };
    }
    const audio = await this.buildAudioObservation(input.audio);
    return { text, audio };
  }

  private scoreLexiconSignal(text: string): LexiconSignal {
    const tokens = tokenizeVadText(text);
    const scored = scoreVadTokens(tokens, this.vadLexicon);
    const signedVad = {
      valence: normalizeSignedVadComponent(scored.score.valence),
      arousal: normalizeSignedVadComponent(scored.score.arousal),
      dominance: normalizeSignedVadComponent(scored.score.dominance),
    };
    const coverage = scored.totalTokenCount > 0
      ? scored.matchedTokenCount / scored.totalTokenCount
      : 0;
    const intensity = averageAbsoluteVad(signedVad);
    return {
      vad: signedVad,
      confidence: clampUnit(coverage * intensity),
    };
  }
}

function resolveClassifierSignal(classifications: readonly TextEmotionClassification[]): CategoricalSignal | null {
  if (!Array.isArray(classifications) || classifications.length === 0) {
    throw new Error('text emotion classifier returned no classifications');
  }

  let best: CategoricalSignal | null = null;
  for (let index = 0; index < classifications.length; index += 1) {
    const entry = classifications[index];
    if (!entry) continue;

    const label = normalizeEmotionLabel(entry.label, `classifications[${index}].label`);
    const confidence = normalizeConfidence(entry.score, `classifications[${index}].score`);
    const candidate: CategoricalSignal = {
      label,
      confidence,
      vad: cloneVad(deriveVadFromLabel(label)),
    };
    best = chooseStrongerCategoricalSignal(best, candidate);
  }

  if (!best || best.confidence <= SIGNAL_EPSILON) {
    return null;
  }
  return best;
}

function resolveLexiconCategoricalSignal(signal: LexiconSignal): CategoricalSignal | null {
  if (signal.confidence <= SIGNAL_EPSILON) {
    return null;
  }

  const label = resolveNearestEmotionLabel(signal.vad);
  return {
    label,
    confidence: signal.confidence,
    vad: cloneVad(deriveVadFromLabel(label)),
  };
}

function chooseStrongestCategoricalSignal(
  signals: Array<CategoricalSignal | null>,
): CategoricalSignal | null {
  let best: CategoricalSignal | null = null;
  for (const signal of signals) {
    if (!signal) continue;
    best = chooseStrongerCategoricalSignal(best, signal);
  }
  return best;
}

function chooseStrongerCategoricalSignal(
  left: CategoricalSignal | null,
  right: CategoricalSignal,
): CategoricalSignal {
  if (!left) return right;
  if (right.confidence !== left.confidence) {
    return right.confidence > left.confidence ? right : left;
  }
  return right.label.localeCompare(left.label) < 0 ? right : left;
}

function resolveNearestEmotionLabel(vad: VADVector): string {
  let bestLabel: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [label, mappedVad] of Object.entries(TEXT_EMOTION_LABEL_VAD_MAP)) {
    const distance = squaredDistance(vad, mappedVad);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestLabel = label;
      continue;
    }
    if (distance === bestDistance && bestLabel && label.localeCompare(bestLabel) < 0) {
      bestLabel = label;
    }
  }

  if (!bestLabel) {
    throw new Error('no emotion labels available for VAD resolution');
  }
  return bestLabel;
}

function deriveVadFromLabel(label: string): Readonly<VADVector> {
  const mapped = TEXT_EMOTION_LABEL_VAD_MAP[label];
  if (!mapped) {
    throw new Error(`unsupported text emotion label: ${label}`);
  }
  return mapped;
}

function fuseVadSignals(
  categoricalVad: Readonly<VADVector>,
  categoricalWeightRaw: number,
  lexiconVad: Readonly<VADVector>,
  lexiconWeightRaw: number,
): VADVector | null {
  const categoricalWeight = clampUnit(categoricalWeightRaw);
  const lexiconWeight = clampUnit(lexiconWeightRaw);
  const totalWeight = categoricalWeight + lexiconWeight;

  if (totalWeight <= SIGNAL_EPSILON) {
    return null;
  }

  return {
    valence: clampSigned(
      ((categoricalVad.valence * categoricalWeight) + (lexiconVad.valence * lexiconWeight)) / totalWeight,
    ),
    arousal: clampSigned(
      ((categoricalVad.arousal * categoricalWeight) + (lexiconVad.arousal * lexiconWeight)) / totalWeight,
    ),
    dominance: clampSigned(
      ((categoricalVad.dominance * categoricalWeight) + (lexiconVad.dominance * lexiconWeight)) / totalWeight,
    ),
  };
}

function normalizeEmotionLabel(label: unknown, fieldName: string): string {
  if (typeof label !== 'string') {
    throw new TypeError(`${fieldName} must be a string`);
  }
  const normalized = label.trim().toLowerCase();
  if (!normalized) {
    throw new RangeError(`${fieldName} must be non-empty`);
  }
  if (!TEXT_EMOTION_LABEL_VAD_MAP[normalized]) {
    throw new Error(`unsupported text emotion label: ${normalized}`);
  }
  return normalized;
}

function normalizeConfidence(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${fieldName} must be a finite number`);
  }
  return clampUnit(value);
}

function normalizeMaxTextLength(maxTextLength: number | undefined): number {
  if (!Number.isFinite(maxTextLength) || (maxTextLength as number) <= 0) {
    return DEFAULT_EMOTION_OBSERVER_MAX_TEXT_LENGTH;
  }
  return Math.max(1, Math.floor(maxTextLength as number));
}

function normalizeObserverText(text: unknown, maxTextLength: number): string {
  if (typeof text !== 'string') {
    throw new TypeError(`text must be a string, received ${String(text)}`);
  }
  const normalized = text.trim();
  if (!normalized) {
    throw new RangeError('text must be a non-empty string');
  }
  if (normalized.length <= maxTextLength) {
    return normalized;
  }
  return normalized.slice(0, maxTextLength);
}

function resolveFusedLabel(discrete: Record<string, number> | undefined): string | null {
  if (!discrete) return null;
  const labels = Object.keys(discrete).sort((left, right) => left.localeCompare(right));
  return labels[0] ?? null;
}

function averageAbsoluteVad(vad: Readonly<VADVector>): number {
  let total = 0;
  for (const key of VAD_KEYS) {
    total += Math.abs(vad[key]);
  }
  return total / VAD_KEYS.length;
}

function squaredDistance(left: Readonly<VADVector>, right: Readonly<VADVector>): number {
  let total = 0;
  for (const key of VAD_KEYS) {
    const delta = left[key] - right[key];
    total += delta * delta;
  }
  return total;
}

function normalizeSignedVadComponent(value: number): number {
  return clampSigned((value - 0.5) * 2);
}

function cloneVad(vad: Readonly<VADVector>): VADVector {
  return {
    valence: vad.valence,
    arousal: vad.arousal,
    dominance: vad.dominance,
  };
}

function clampSigned(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
