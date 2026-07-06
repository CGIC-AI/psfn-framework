import { isObjectRecord as isRecord } from '../../shared/utils/types.js';
import { clampSigned, clampUnit } from '../../shared/utils/numeric.js';
import { EmotionState, type EmotionObservation, type EmotionStateSnapshot, type VADVector } from './state.js';
import {
  toAudioEmotionSignal,
  type AudioEmotionClassification,
  type AudioEmotionClassifierLike,
} from './audio-classifier.js';
import {
  type TextEmotionClassification,
} from './text-classifier.js';
import {
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
  observation: EmotionObservation;
  fusedLabel: string | null;
  fusedLabelConfidence: number;
}

export interface EmotionObserverConfig {
  state?: EmotionState;
  textClassifier: TextEmotionClassifierLike;
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
const TEXT_EMOTION_LABEL_SET = new Set(Object.keys(RAW_TEXT_EMOTION_LABEL_VAD_MAP));
const TEXT_EMOTION_LABEL_ALIAS_MAP: Readonly<Record<string, string>> = Object.freeze({
  admiration: 'trust',
  amusement: 'joy',
  annoyance: 'anger',
  approval: 'trust',
  caring: 'love',
  curiosity: 'anticipation',
  desire: 'anticipation',
  disappointment: 'sadness',
  disapproval: 'pessimism',
  embarrassment: 'confusion',
  excitement: 'joy',
  gratitude: 'trust',
  grief: 'sadness',
  nervousness: 'fear',
  pride: 'optimism',
  realization: 'surprise',
  relief: 'optimism',
  remorse: 'pessimism',
});

export const DEFAULT_EMOTION_OBSERVER_MAX_TEXT_LENGTH = 2_000;

const SIGNAL_EPSILON = 1e-6;
const VAD_KEYS = ['valence', 'arousal', 'dominance'] as const;

interface CategoricalSignal {
  label: string;
  confidence: number;
  vad: VADVector;
}

interface ModalityObservationInput {
  modality: string;
  observation: EmotionObservation;
}

interface NormalizedModalitySignal {
  confidence: number;
  vad: VADVector | null;
  categorical: CategoricalSignal | null;
}

export class EmotionObserver {
  private readonly state: EmotionState;
  private readonly textClassifier: TextEmotionClassifierLike;
  private readonly audioClassifier: AudioEmotionClassifierLike | null;
  private readonly maxTextLength: number;

  constructor(config: EmotionObserverConfig) {
    this.state = config.state ?? new EmotionState();
    this.textClassifier = config.textClassifier;
    this.audioClassifier = config.audioClassifier ?? null;
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
    const classifications = await this.textClassifier.classify(normalizedText);
    const classifierSignal = resolveClassifierSignal(classifications);
    if (!classifierSignal || classifierSignal.confidence <= SIGNAL_EPSILON) {
      return {};
    }

    return {
      vad: cloneVad(classifierSignal.vad),
      discrete: { [classifierSignal.label]: 1 },
      confidence: clampUnit(classifierSignal.confidence),
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
    const audio = input.audio ? await this.buildAudioObservation(input.audio) : undefined;
    const modalities: ModalityObservationInput[] = [{ modality: 'text', observation: text }];
    if (audio) {
      modalities.push({ modality: 'audio', observation: audio.observation });
    }
    const observation = fuseModalityObservations(modalities);

    return {
      text,
      audio,
      observation,
      fusedLabel: resolveFusedLabel(observation.discrete),
      fusedLabelConfidence: clampUnit(observation.confidence ?? 0),
    };
  }

}

function resolveClassifierSignal(classifications: readonly TextEmotionClassification[]): CategoricalSignal | null {
  if (!Array.isArray(classifications) || classifications.length === 0) {
    throw new Error('text emotion classifier returned no classifications');
  }

  let best: CategoricalSignal | null = null;
  for (let index = 0; index < classifications.length; index += 1) {
    const entry = normalizeClassifierEntry(classifications[index], index);

    const label = normalizeEmotionLabel(entry.label, `classifications[${index}].label`);
    const confidence = normalizeClassifierConfidence(entry.score, `classifications[${index}].score`);
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

function normalizeClassifierEntry(
  value: unknown,
  index: number,
): { label: unknown; score: unknown } {
  if (!isRecord(value)) {
    throw new TypeError(`classifications[${index}] must be an object`);
  }
  return {
    label: value.label,
    score: value.score,
  };
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

function fuseModalityObservations(
  modalityInputs: readonly ModalityObservationInput[],
): EmotionObservation {
  if (!Array.isArray(modalityInputs) || modalityInputs.length === 0) {
    throw new Error('at least one modality observation is required');
  }

  const fusedVadAccumulator: VADVector = {
    valence: 0,
    arousal: 0,
    dominance: 0,
  };
  let strongestCategorical: CategoricalSignal | null = null;
  let strongestConfidence = 0;
  let fusedVadWeight = 0;
  let modalitySignalCount = 0;

  for (let index = 0; index < modalityInputs.length; index += 1) {
    const signal = normalizeModalitySignal(modalityInputs[index], index);
    if (!signal) continue;

    modalitySignalCount += 1;
    strongestConfidence = Math.max(strongestConfidence, signal.confidence);

    if (signal.categorical) {
      strongestCategorical = chooseStrongerCategoricalSignal(strongestCategorical, signal.categorical);
    }

    if (!signal.vad) continue;

    fusedVadWeight += signal.confidence;
    for (const key of VAD_KEYS) {
      fusedVadAccumulator[key] += signal.vad[key] * signal.confidence;
    }
  }

  if (modalitySignalCount === 0) {
    throw new Error('modality observations must include at least one signal with positive confidence');
  }
  if (fusedVadWeight <= SIGNAL_EPSILON) {
    throw new Error('modality observations must include at least one VAD signal with positive confidence');
  }

  return {
    vad: {
      valence: clampSigned(fusedVadAccumulator.valence / fusedVadWeight),
      arousal: clampSigned(fusedVadAccumulator.arousal / fusedVadWeight),
      dominance: clampSigned(fusedVadAccumulator.dominance / fusedVadWeight),
    },
    discrete: strongestCategorical ? { [strongestCategorical.label]: 1 } : undefined,
    confidence: clampUnit(strongestConfidence),
  };
}

function normalizeModalitySignal(
  input: ModalityObservationInput,
  index: number,
): NormalizedModalitySignal | null {
  if (!isRecord(input)) {
    throw new TypeError(`modalityInputs[${index}] must be an object`);
  }
  const modality = normalizeModalityName(input.modality, index);
  const observation = input.observation;

  if (!isRecord(observation)) {
    throw new TypeError(`${modality}.observation must be an object`);
  }

  const confidence = normalizeConfidence(
    observation.confidence ?? 0,
    `${modality}.observation.confidence`,
  );
  if (confidence <= SIGNAL_EPSILON) {
    return null;
  }

  const categorical = resolveObservationCategoricalSignal(
    observation.discrete,
    `${modality}.observation.discrete`,
  );
  const vad = normalizeObservationVad(
    observation.vad,
    `${modality}.observation.vad`,
  );

  if (!categorical && !vad) {
    throw new Error(
      `${modality}.observation must include vad or discrete emotion when confidence is positive`,
    );
  }

  return {
    confidence,
    vad,
    categorical: categorical
      ? {
        label: categorical.label,
        confidence,
        vad: categorical.vad,
      }
      : null,
  };
}

function normalizeModalityName(modality: unknown, index: number): string {
  if (typeof modality !== 'string') {
    throw new TypeError(`modalityInputs[${index}].modality must be a string`);
  }
  const normalized = modality.trim().toLowerCase();
  if (!normalized) {
    throw new RangeError(`modalityInputs[${index}].modality must be non-empty`);
  }
  return normalized;
}

function resolveObservationCategoricalSignal(
  discrete: unknown,
  fieldName: string,
): CategoricalSignal | null {
  if (discrete === undefined) {
    return null;
  }
  if (!isRecord(discrete)) {
    throw new TypeError(`${fieldName} must be an object`);
  }

  let bestLabel: string | null = null;
  let bestScore = 0;
  for (const [rawLabel, rawScore] of Object.entries(discrete)) {
    const label = normalizeEmotionLabel(rawLabel, `${fieldName}.${rawLabel}.label`);
    const score = normalizeConfidence(rawScore, `${fieldName}.${label}.score`);
    if (score <= SIGNAL_EPSILON) continue;

    if (!bestLabel || score > bestScore) {
      bestLabel = label;
      bestScore = score;
      continue;
    }
    if (score === bestScore && label.localeCompare(bestLabel) < 0) {
      bestLabel = label;
    }
  }

  if (!bestLabel) {
    return null;
  }

  return {
    label: bestLabel,
    confidence: bestScore,
    vad: cloneVad(deriveVadFromLabel(bestLabel)),
  };
}

function normalizeObservationVad(vad: unknown, fieldName: string): VADVector | null {
  if (vad === undefined) {
    return null;
  }
  if (!isRecord(vad)) {
    throw new TypeError(`${fieldName} must be an object`);
  }

  const valence = normalizeOptionalVadComponent(vad.valence, `${fieldName}.valence`);
  const arousal = normalizeOptionalVadComponent(vad.arousal, `${fieldName}.arousal`);
  const dominance = normalizeOptionalVadComponent(vad.dominance, `${fieldName}.dominance`);

  if (valence === null && arousal === null && dominance === null) {
    return null;
  }
  if (valence === null || arousal === null || dominance === null) {
    throw new Error(`${fieldName} must include valence, arousal, and dominance`);
  }

  return {
    valence,
    arousal,
    dominance,
  };
}

function normalizeOptionalVadComponent(value: unknown, fieldName: string): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${fieldName} must be a finite number`);
  }
  return clampSigned(value);
}

function deriveVadFromLabel(label: string): Readonly<VADVector> {
  if (!TEXT_EMOTION_LABEL_SET.has(label)) {
    throw new Error(`unsupported text emotion label: ${label}`);
  }
  return TEXT_EMOTION_LABEL_VAD_MAP[label];
}

function normalizeEmotionLabel(label: unknown, fieldName: string): string {
  if (typeof label !== 'string') {
    throw new TypeError(`${fieldName} must be a string`);
  }
  const normalized = label.trim().toLowerCase();
  if (!normalized) {
    throw new RangeError(`${fieldName} must be non-empty`);
  }
  const canonical = TEXT_EMOTION_LABEL_ALIAS_MAP[normalized] ?? normalized;
  if (!TEXT_EMOTION_LABEL_SET.has(canonical)) {
    throw new Error(`unsupported text emotion label: ${normalized}`);
  }
  return canonical;
}

function normalizeConfidence(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${fieldName} must be a finite number`);
  }
  return clampUnit(value);
}

function normalizeClassifierConfidence(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${fieldName} must be a finite number`);
  }
  if (value < 0 || value > 1) {
    throw new RangeError(`${fieldName} must be between 0 and 1`);
  }
  return value;
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

function cloneVad(vad: Readonly<VADVector>): VADVector {
  return {
    valence: vad.valence,
    arousal: vad.arousal,
    dominance: vad.dominance,
  };
}
