import { isObjectRecord as isRecord } from '../../shared/utils/types.js';
import { createRequire } from 'node:module';
import type { EmotionObservation, VADVector } from './state.js';

export const AUDIO_EMOTION_SENSE_VOICE_MODEL_PATH_ENV = 'EMOTION_AUDIO_SENSE_VOICE_MODEL_PATH';
export const AUDIO_EMOTION_SENSE_VOICE_TOKENS_PATH_ENV = 'EMOTION_AUDIO_SENSE_VOICE_TOKENS_PATH';
export const AUDIO_EMOTION_SENSE_VOICE_LANGUAGE_ENV = 'EMOTION_AUDIO_SENSE_VOICE_LANGUAGE';
export const AUDIO_EMOTION_SENSE_VOICE_PROVIDER_ENV = 'EMOTION_AUDIO_SENSE_VOICE_PROVIDER';
export const AUDIO_EMOTION_SENSE_VOICE_NUM_THREADS_ENV = 'EMOTION_AUDIO_SENSE_VOICE_NUM_THREADS';
export const AUDIO_EMOTION_SENSE_VOICE_FEATURE_DIM_ENV = 'EMOTION_AUDIO_SENSE_VOICE_FEATURE_DIM';
export const AUDIO_EMOTION_SENSE_VOICE_USE_ITN_ENV = 'EMOTION_AUDIO_SENSE_VOICE_USE_ITN';

export type AudioEmotionClassificationSource = 'emotion' | 'event';

export interface AudioEmotionClassification {
  label: string;
  score: number;
  source: AudioEmotionClassificationSource;
}

export interface AudioEmotionClassifierLike {
  classify(audioBuffer: Buffer, sampleRate: number): Promise<readonly AudioEmotionClassification[]>;
}

export interface AudioEmotionSignal {
  observation: EmotionObservation;
  events: readonly string[];
  strongestEmotionLabel: string | null;
  strongestEmotionScore: number;
}

export interface AudioEmotionClassifierConfig {
  modelPath?: string;
  tokensPath?: string;
  language?: string;
  provider?: string;
  numThreads?: number;
  featureDim?: number;
  useInverseTextNormalization?: boolean;
  runtimeLoader?: SherpaOnnxRuntimeLoader;
}

export const AUDIO_EMOTION_LABEL_VAD_MAP: Readonly<Partial<Record<string, Readonly<VADVector>>>> = Object.freeze({
  anger: Object.freeze({ valence: -0.8, arousal: 0.8, dominance: 0.6 }),
  disgust: Object.freeze({ valence: -0.7, arousal: 0.6, dominance: 0.1 }),
  fear: Object.freeze({ valence: -0.7, arousal: 0.9, dominance: -0.7 }),
  joy: Object.freeze({ valence: 0.8, arousal: 0.6, dominance: 0.2 }),
  neutral: Object.freeze({ valence: 0, arousal: 0, dominance: 0 }),
  sadness: Object.freeze({ valence: -0.8, arousal: 0.3, dominance: -0.6 }),
  surprise: Object.freeze({ valence: 0.2, arousal: 0.9, dominance: 0 }),
});

const DEFAULT_LANGUAGE = 'auto';
const DEFAULT_PROVIDER = 'cpu';
const DEFAULT_NUM_THREADS = 1;
const DEFAULT_FEATURE_DIM = 80;
const DEFAULT_USE_INVERSE_TEXT_NORMALIZATION = true;
const EVENT_LABEL_PREFIX = 'event:';
const SIGNAL_EPSILON = 1e-6;

const SENSE_VOICE_EMOTION_LABEL_MAP: Readonly<Record<string, string>> = Object.freeze({
  angry: 'anger',
  disgusted: 'disgust',
  fearful: 'fear',
  happy: 'joy',
  neutral: 'neutral',
  sad: 'sadness',
  surprised: 'surprise',
});

const SENSE_VOICE_EVENT_LABEL_MAP: Readonly<Record<string, string>> = Object.freeze({
  applause: 'applause',
  bgm: 'bgm',
  breath: 'breath',
  cough: 'cough',
  cry: 'cry',
  laughter: 'laughter',
  sneeze: 'sneeze',
  speech: 'speech',
});

interface NormalizedAudioEmotionClassifierConfig {
  modelPath?: string;
  tokensPath?: string;
  language: string;
  provider: string;
  numThreads: number;
  featureDim: number;
  useInverseTextNormalization: boolean;
}

interface SherpaOnnxOfflineRecognizerConfig {
  featConfig: {
    sampleRate: number;
    featureDim: number;
  };
  modelConfig: {
    senseVoice: {
      model: string;
      language: string;
      useInverseTextNormalization: 0 | 1;
    };
    tokens: string;
    numThreads: number;
    provider: string;
    debug: 0 | 1;
  };
}

interface SherpaOnnxOfflineRecognizerResult {
  emotion?: string;
  event?: string;
}

interface SherpaOnnxOfflineStreamLike {
  acceptWaveform(waveform: { sampleRate: number; samples: Float32Array }): void;
}

interface SherpaOnnxOfflineRecognizerLike {
  createStream(): SherpaOnnxOfflineStreamLike;
  decode(stream: SherpaOnnxOfflineStreamLike): void;
  getResult(stream: SherpaOnnxOfflineStreamLike): SherpaOnnxOfflineRecognizerResult;
}

interface SherpaOnnxRuntimeLike {
  OfflineRecognizer: new (config: SherpaOnnxOfflineRecognizerConfig) => SherpaOnnxOfflineRecognizerLike;
}

type SherpaOnnxRuntimeLoader = () => Promise<SherpaOnnxRuntimeLike>;

export class AudioEmotionClassifier implements AudioEmotionClassifierLike {
  private readonly config: NormalizedAudioEmotionClassifierConfig;
  private readonly runtimeLoader: SherpaOnnxRuntimeLoader;
  private recognizer: SherpaOnnxOfflineRecognizerLike | null = null;
  private initPromise: Promise<SherpaOnnxOfflineRecognizerLike> | null = null;

  constructor(config: AudioEmotionClassifierConfig = {}) {
    this.config = normalizeAudioEmotionClassifierConfig(config);
    this.runtimeLoader = config.runtimeLoader ?? loadSherpaOnnxRuntime;
  }

  async classify(audioBuffer: Buffer, sampleRate: number): Promise<AudioEmotionClassification[]> {
    const normalizedAudio = normalizePcm16LeAudio(audioBuffer);
    const normalizedSampleRate = normalizeSampleRate(sampleRate);
    const recognizer = await this.getRecognizer();
    const stream = recognizer.createStream();
    stream.acceptWaveform({
      sampleRate: normalizedSampleRate,
      samples: normalizedAudio,
    });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    return normalizeSenseVoiceClassifications(result);
  }

  private async getRecognizer(): Promise<SherpaOnnxOfflineRecognizerLike> {
    if (this.recognizer) return this.recognizer;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initRecognizer().then((recognizer) => {
      this.recognizer = recognizer;
      return recognizer;
    });

    try {
      return await this.initPromise;
    } catch (error) {
      this.initPromise = null;
      throw error;
    }
  }

  private async initRecognizer(): Promise<SherpaOnnxOfflineRecognizerLike> {
    assertRuntimeModelConfiguration(this.config);
    const runtime = await this.runtimeLoader();
    const recognizer = new runtime.OfflineRecognizer({
      featConfig: {
        sampleRate: 16000,
        featureDim: this.config.featureDim,
      },
      modelConfig: {
        senseVoice: {
          model: this.config.modelPath!,
          language: this.config.language,
          useInverseTextNormalization: this.config.useInverseTextNormalization ? 1 : 0,
        },
        tokens: this.config.tokensPath!,
        numThreads: this.config.numThreads,
        provider: this.config.provider,
        debug: 0,
      },
    });
    assertRecognizerInterface(recognizer);
    return recognizer;
  }
}

let sharedAudioEmotionClassifier: AudioEmotionClassifier | null = null;

export function getSharedAudioEmotionClassifier(): AudioEmotionClassifier {
  if (!sharedAudioEmotionClassifier) {
    sharedAudioEmotionClassifier = createAudioEmotionClassifierFromEnv();
  }
  return sharedAudioEmotionClassifier;
}

export function resetSharedAudioEmotionClassifierForTests(): void {
  sharedAudioEmotionClassifier = null;
}

export function createAudioEmotionClassifierFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AudioEmotionClassifier {
  return new AudioEmotionClassifier({
    modelPath: trimOptionalString(env[AUDIO_EMOTION_SENSE_VOICE_MODEL_PATH_ENV]),
    tokensPath: trimOptionalString(env[AUDIO_EMOTION_SENSE_VOICE_TOKENS_PATH_ENV]),
    language: trimOptionalString(env[AUDIO_EMOTION_SENSE_VOICE_LANGUAGE_ENV]),
    provider: trimOptionalString(env[AUDIO_EMOTION_SENSE_VOICE_PROVIDER_ENV]),
    numThreads: parsePositiveIntegerEnv(env[AUDIO_EMOTION_SENSE_VOICE_NUM_THREADS_ENV]),
    featureDim: parsePositiveIntegerEnv(env[AUDIO_EMOTION_SENSE_VOICE_FEATURE_DIM_ENV]),
    useInverseTextNormalization: parseOptionalBooleanEnv(env[AUDIO_EMOTION_SENSE_VOICE_USE_ITN_ENV]),
  });
}

export function toAudioEmotionSignal(
  classifications: readonly AudioEmotionClassification[],
): AudioEmotionSignal {
  let strongestEmotion: AudioEmotionClassification | null = null;
  const events: string[] = [];

  for (const classification of classifications) {
    const confidence = clampUnit(classification.score);

    if (classification.source === 'event') {
      const eventName = parseEventLabel(classification.label);
      if (eventName.length > 0) {
        events.push(eventName);
      }
      continue;
    }

    if (!AUDIO_EMOTION_LABEL_VAD_MAP[classification.label]) {
      continue;
    }

    if (!strongestEmotion) {
      strongestEmotion = {
        label: classification.label,
        score: confidence,
        source: 'emotion',
      };
      continue;
    }

    if (confidence > strongestEmotion.score) {
      strongestEmotion = {
        label: classification.label,
        score: confidence,
        source: 'emotion',
      };
      continue;
    }

    if (confidence === strongestEmotion.score && classification.label.localeCompare(strongestEmotion.label) < 0) {
      strongestEmotion = {
        label: classification.label,
        score: confidence,
        source: 'emotion',
      };
    }
  }

  const uniqueEvents = [...new Set(events)].sort((left, right) => left.localeCompare(right));
  if (!strongestEmotion || strongestEmotion.score <= SIGNAL_EPSILON) {
    return {
      observation: {},
      events: uniqueEvents,
      strongestEmotionLabel: null,
      strongestEmotionScore: 0,
    };
  }

  const vad = AUDIO_EMOTION_LABEL_VAD_MAP[strongestEmotion.label];
  if (!vad) {
    return {
      observation: {
        discrete: { [strongestEmotion.label]: 1 },
        confidence: strongestEmotion.score,
      },
      events: uniqueEvents,
      strongestEmotionLabel: strongestEmotion.label,
      strongestEmotionScore: strongestEmotion.score,
    };
  }

  return {
    observation: {
      vad: {
        valence: vad.valence,
        arousal: vad.arousal,
        dominance: vad.dominance,
      },
      discrete: { [strongestEmotion.label]: 1 },
      confidence: strongestEmotion.score,
    },
    events: uniqueEvents,
    strongestEmotionLabel: strongestEmotion.label,
    strongestEmotionScore: strongestEmotion.score,
  };
}

async function loadSherpaOnnxRuntime(): Promise<SherpaOnnxRuntimeLike> {
  try {
    const require = createRequire(import.meta.url);
    const runtime = require('sherpa-onnx-node') as unknown;
    return normalizeSherpaOnnxRuntime(runtime);
  } catch (error) {
    if (isSherpaModuleMissing(error)) {
      throw new Error(
        'Audio emotion classification requires optional dependency "sherpa-onnx-node". '
        + 'Install it before using SenseVoice audio emotion classification.',
      );
    }
    throw error;
  }
}

function normalizeSherpaOnnxRuntime(value: unknown): SherpaOnnxRuntimeLike {
  if (!isRecord(value) || typeof value.OfflineRecognizer !== 'function') {
    throw new Error('sherpa-onnx-node did not expose OfflineRecognizer');
  }
  return value as unknown as SherpaOnnxRuntimeLike;
}

function assertRecognizerInterface(recognizer: SherpaOnnxOfflineRecognizerLike): void {
  if (typeof recognizer.createStream !== 'function') {
    throw new Error('sherpa-onnx OfflineRecognizer must expose createStream()');
  }
  if (typeof recognizer.decode !== 'function') {
    throw new Error('sherpa-onnx OfflineRecognizer must expose decode()');
  }
  if (typeof recognizer.getResult !== 'function') {
    throw new Error('sherpa-onnx OfflineRecognizer must expose getResult()');
  }
}

function normalizeAudioEmotionClassifierConfig(
  config: AudioEmotionClassifierConfig,
): NormalizedAudioEmotionClassifierConfig {
  return {
    modelPath: trimOptionalString(config.modelPath),
    tokensPath: trimOptionalString(config.tokensPath),
    language: trimOptionalString(config.language) ?? DEFAULT_LANGUAGE,
    provider: trimOptionalString(config.provider) ?? DEFAULT_PROVIDER,
    numThreads: normalizePositiveInteger(config.numThreads, DEFAULT_NUM_THREADS),
    featureDim: normalizePositiveInteger(config.featureDim, DEFAULT_FEATURE_DIM),
    useInverseTextNormalization: normalizeBoolean(config.useInverseTextNormalization, DEFAULT_USE_INVERSE_TEXT_NORMALIZATION),
  };
}

function assertRuntimeModelConfiguration(config: NormalizedAudioEmotionClassifierConfig): void {
  if (!config.modelPath || !config.tokensPath) {
    throw new Error(
      'SenseVoice audio emotion model configuration is required at use-time. '
      + `Set ${AUDIO_EMOTION_SENSE_VOICE_MODEL_PATH_ENV} and ${AUDIO_EMOTION_SENSE_VOICE_TOKENS_PATH_ENV}.`,
    );
  }
}

function normalizeSenseVoiceClassifications(result: unknown): AudioEmotionClassification[] {
  if (!isRecord(result)) {
    throw new Error('sherpa-onnx SenseVoice result must be an object');
  }

  const emotion = normalizeSenseVoiceTag(result.emotion);
  const event = normalizeSenseVoiceTag(result.event);

  const classifications: AudioEmotionClassification[] = [];
  if (emotion) {
    classifications.push({
      label: mapSenseVoiceEmotion(emotion),
      score: 1,
      source: 'emotion',
    });
  }

  if (event) {
    classifications.push({
      label: `${EVENT_LABEL_PREFIX}${mapSenseVoiceEvent(event)}`,
      score: 1,
      source: 'event',
    });
  }

  if (classifications.length === 0) {
    throw new Error('sherpa-onnx SenseVoice result did not contain emotion or event labels');
  }

  return classifications;
}

function normalizeSenseVoiceTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const unwrapped = trimmed
    .replace(/^<\|/, '')
    .replace(/\|>$/, '')
    .trim()
    .toLowerCase();
  return unwrapped.length > 0 ? unwrapped : null;
}

function mapSenseVoiceEmotion(label: string): string {
  return SENSE_VOICE_EMOTION_LABEL_MAP[label] ?? label;
}

function mapSenseVoiceEvent(label: string): string {
  return SENSE_VOICE_EVENT_LABEL_MAP[label] ?? label;
}

function parseEventLabel(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (!normalized.startsWith(EVENT_LABEL_PREFIX)) {
    return '';
  }
  return normalized.slice(EVENT_LABEL_PREFIX.length).trim();
}

function normalizePcm16LeAudio(audioBuffer: unknown): Float32Array {
  if (!Buffer.isBuffer(audioBuffer)) {
    throw new TypeError(`audioBuffer must be a Buffer, received ${String(audioBuffer)}`);
  }
  if (audioBuffer.length === 0) {
    throw new RangeError('audioBuffer must not be empty');
  }
  if ((audioBuffer.length % 2) !== 0) {
    throw new RangeError('audioBuffer must contain 16-bit PCM little-endian samples');
  }

  const sampleCount = audioBuffer.length / 2;
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = audioBuffer.readInt16LE(index * 2) / 32768;
  }
  return samples;
}

function normalizeSampleRate(sampleRate: unknown): number {
  if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate)) {
    throw new TypeError(`sampleRate must be a finite number, received ${String(sampleRate)}`);
  }
  const normalized = Math.floor(sampleRate);
  if (normalized <= 0) {
    throw new RangeError(`sampleRate must be > 0, received ${String(sampleRate)}`);
  }
  return normalized;
}

function parsePositiveIntegerEnv(value: string | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function parseOptionalBooleanEnv(value: string | undefined): boolean | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return undefined;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value as number) <= 0) {
    return fallback;
  }
  return Math.floor(value as number);
}

function normalizeBoolean(value: boolean | undefined, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function trimOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}


function isSherpaModuleMissing(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : '';
  return code === 'MODULE_NOT_FOUND' && message.includes('sherpa-onnx-node');
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
