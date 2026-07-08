import { isRecord } from '../../shared/utils/types.js';
import type { EmotionStateSnapshot, VADVector } from './state.js';

export const EMOTION_TELEMETRY_SOURCES = [
  'classifier_inferred',
  'self_report',
  'activation_or_logprob_calibrated',
  'partner_context_evidence',
  'memory_derived',
  'runtime_state',
  'missing',
  'unknown',
] as const;

export type EmotionTelemetrySource = typeof EMOTION_TELEMETRY_SOURCES[number];

export const EMOTION_TELEMETRY_STATUSES = ['trusted', 'uncertain', 'suppressed'] as const;
export type EmotionTelemetryStatus = typeof EMOTION_TELEMETRY_STATUSES[number];

export const EMOTION_TELEMETRY_REASONS = [
  'missing_signal',
  'missing_provenance',
  'low_confidence',
  'conflicting_signal',
  'stale_signal',
] as const;

export type EmotionTelemetryReason = typeof EMOTION_TELEMETRY_REASONS[number];

export interface EmotionTelemetryProvenance {
  source: EmotionTelemetrySource;
  observedAtMs?: number;
  modality?: 'text' | 'audio' | 'fusion' | 'runtime' | 'self_report' | 'unknown';
  classifier?: string;
  model?: string;
  provenanceRef?: string;
}

export interface EmotionTelemetrySignalSummary {
  confidence: number;
  topDiscreteLabels: string[];
  strongestLabelScore: number;
}

export interface EmotionTelemetryValidation {
  status: EmotionTelemetryStatus;
  source: EmotionTelemetrySource;
  reasons: EmotionTelemetryReason[];
  confidence: number;
  weight: number;
  observedAtMs: number | null;
  validatedAtMs: number;
  staleAfterMs: number;
  provenance: EmotionTelemetryProvenance[];
  rawSignal: EmotionTelemetrySignalSummary;
}

export interface EmotionTelemetryValidationInput {
  source?: EmotionTelemetrySource;
  provenance?: readonly EmotionTelemetryProvenance[];
  observedAtMs?: number | null;
  nowMs?: number;
  staleAfterMs?: number;
  minConfidence?: number;
  trustedConfidence?: number;
}

export interface ValidatedEmotionTelemetry {
  snapshot: EmotionStateSnapshot;
  validation: EmotionTelemetryValidation;
}

const DEFAULT_MIN_CONFIDENCE = 0.35;
const DEFAULT_TRUSTED_CONFIDENCE = 0.6;
export const DEFAULT_EMOTION_TELEMETRY_STALE_AFTER_MS = 10 * 60_000;

const SIGNAL_EPSILON = 1e-4;
const UNCERTAIN_WEIGHT = 0.25;

const POSITIVE_DISCRETE_LABELS = new Set([
  'admiration',
  'amusement',
  'anticipation',
  'approval',
  'calm',
  'caring',
  'curiosity',
  'desire',
  'excitement',
  'gratitude',
  'joy',
  'love',
  'optimism',
  'pride',
  'relief',
  'trust',
]);

const NEGATIVE_DISCRETE_LABELS = new Set([
  'anger',
  'annoyance',
  'confusion',
  'disappointment',
  'disapproval',
  'disgust',
  'embarrassment',
  'fear',
  'grief',
  'nervousness',
  'pessimism',
  'remorse',
  'sadness',
]);

const DISCRETE_CONFLICT_THRESHOLD = 0.35;

export function validateEmotionTelemetry(
  snapshot: EmotionStateSnapshot | null | undefined,
  input: EmotionTelemetryValidationInput = {},
): ValidatedEmotionTelemetry {
  const nowMs = normalizeTimestamp(input.nowMs, 'nowMs') ?? Date.now();
  const staleAfterMs = normalizePositiveFinite(
    input.staleAfterMs,
    DEFAULT_EMOTION_TELEMETRY_STALE_AFTER_MS,
    'staleAfterMs',
  );
  const minConfidence = normalizeUnit(input.minConfidence, DEFAULT_MIN_CONFIDENCE, 'minConfidence');
  const trustedConfidence = Math.max(
    minConfidence,
    normalizeUnit(input.trustedConfidence, DEFAULT_TRUSTED_CONFIDENCE, 'trustedConfidence'),
  );
  const source = normalizeSource(input.source ?? inferSourceFromProvenance(input.provenance) ?? 'unknown');
  const provenance = normalizeProvenance(input.provenance ?? [], 'provenance');
  const observedAtMs = resolveObservedAtMs(input.observedAtMs, provenance);
  const normalizedSnapshot = snapshot ? normalizeSnapshot(snapshot) : neutralSnapshot();
  const rawSignal = summarizeSignal(normalizedSnapshot);

  const reasons = new Set<EmotionTelemetryReason>();
  if (!hasSignal(normalizedSnapshot)) {
    reasons.add('missing_signal');
  }
  if (source === 'missing') {
    reasons.add('missing_signal');
  }
  if (source === 'unknown' && provenance.length === 0) {
    reasons.add('missing_provenance');
  }
  if (normalizedSnapshot.confidence < minConfidence && hasSignal(normalizedSnapshot)) {
    reasons.add('low_confidence');
  }
  if (
    observedAtMs !== null
    && nowMs - observedAtMs > staleAfterMs
  ) {
    reasons.add('stale_signal');
  }
  if (detectConflictingDiscreteSignals(normalizedSnapshot.discrete)) {
    reasons.add('conflicting_signal');
  }

  const severe = reasons.has('missing_signal') || reasons.has('low_confidence');
  const status: EmotionTelemetryStatus = severe
    ? 'suppressed'
    : reasons.size === 0 && normalizedSnapshot.confidence >= trustedConfidence
      ? 'trusted'
      : 'uncertain';
  const weight = status === 'trusted'
    ? 1
    : status === 'uncertain'
      ? UNCERTAIN_WEIGHT
      : 0;
  const effectiveSnapshot = applyValidationWeight(normalizedSnapshot, weight, status);

  return {
    snapshot: effectiveSnapshot,
    validation: {
      status,
      source,
      reasons: [...reasons].sort(),
      confidence: roundDecimal(normalizedSnapshot.confidence * weight),
      weight,
      observedAtMs,
      validatedAtMs: Math.floor(nowMs),
      staleAfterMs,
      provenance,
      rawSignal,
    },
  };
}

export function cloneEmotionTelemetryValidation(
  value: EmotionTelemetryValidation,
  fieldName = 'emotionTelemetry',
): EmotionTelemetryValidation {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  const status = normalizeStatus(value.status, `${fieldName}.status`);
  const source = normalizeSource(value.source, `${fieldName}.source`);
  const reasons = normalizeReasons(value.reasons, `${fieldName}.reasons`);
  const confidence = parseUnit(value.confidence, `${fieldName}.confidence`);
  const weight = parseUnit(value.weight, `${fieldName}.weight`);
  const observedAtMs = value.observedAtMs === null
    ? null
    : parseNonNegativeFinite(value.observedAtMs, `${fieldName}.observedAtMs`);
  const validatedAtMs = parseNonNegativeFinite(value.validatedAtMs, `${fieldName}.validatedAtMs`);
  const staleAfterMs = parsePositiveFinite(value.staleAfterMs, `${fieldName}.staleAfterMs`);
  const provenance = normalizeProvenance(value.provenance, `${fieldName}.provenance`);
  const rawSignal = normalizeRawSignal(value.rawSignal, `${fieldName}.rawSignal`);

  return {
    status,
    source,
    reasons,
    confidence,
    weight,
    observedAtMs,
    validatedAtMs,
    staleAfterMs,
    provenance,
    rawSignal,
  };
}

function neutralSnapshot(): EmotionStateSnapshot {
  return {
    vad: { valence: 0, arousal: 0, dominance: 0 },
    mood: { valence: 0, arousal: 0, dominance: 0 },
    discrete: {},
    confidence: 0,
  };
}

function normalizeSnapshot(snapshot: EmotionStateSnapshot): EmotionStateSnapshot {
  if (!isRecord(snapshot) || !isRecord(snapshot.vad) || !isRecord(snapshot.mood) || !isRecord(snapshot.discrete)) {
    throw new Error('Emotion telemetry snapshot must include vad, mood, and discrete objects');
  }
  const discrete: Record<string, number> = {};
  for (const [rawLabel, rawScore] of Object.entries(snapshot.discrete)) {
    const label = rawLabel.trim().toLowerCase();
    if (!label) continue;
    discrete[label] = parseUnit(rawScore, `emotionTelemetry.discrete.${label}`);
  }
  return {
    vad: normalizeVad(snapshot.vad, 'emotionTelemetry.vad'),
    mood: normalizeVad(snapshot.mood, 'emotionTelemetry.mood'),
    discrete,
    confidence: parseUnit(snapshot.confidence, 'emotionTelemetry.confidence'),
  };
}

function applyValidationWeight(
  snapshot: EmotionStateSnapshot,
  weight: number,
  status: EmotionTelemetryStatus,
): EmotionStateSnapshot {
  return {
    vad: scaleVad(snapshot.vad, weight),
    mood: scaleVad(snapshot.mood, weight),
    discrete: status === 'trusted' ? { ...snapshot.discrete } : {},
    confidence: roundDecimal(snapshot.confidence * weight),
  };
}

function summarizeSignal(snapshot: EmotionStateSnapshot): EmotionTelemetrySignalSummary {
  const entries = Object.entries(snapshot.discrete)
    .filter(([, score]) => Number.isFinite(score) && score > SIGNAL_EPSILON)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return {
    confidence: snapshot.confidence,
    topDiscreteLabels: entries.slice(0, 4).map(([label]) => label),
    strongestLabelScore: roundDecimal(entries[0]?.[1] ?? 0),
  };
}

function hasSignal(snapshot: EmotionStateSnapshot): boolean {
  return (
    snapshot.confidence > SIGNAL_EPSILON
    || Math.abs(snapshot.vad.valence) > SIGNAL_EPSILON
    || Math.abs(snapshot.vad.arousal) > SIGNAL_EPSILON
    || Math.abs(snapshot.vad.dominance) > SIGNAL_EPSILON
    || Math.abs(snapshot.mood.valence) > SIGNAL_EPSILON
    || Math.abs(snapshot.mood.arousal) > SIGNAL_EPSILON
    || Math.abs(snapshot.mood.dominance) > SIGNAL_EPSILON
    || Object.values(snapshot.discrete).some(score => score > SIGNAL_EPSILON)
  );
}

function detectConflictingDiscreteSignals(discrete: Record<string, number>): boolean {
  let positive = false;
  let negative = false;
  for (const [rawLabel, score] of Object.entries(discrete)) {
    if (score < DISCRETE_CONFLICT_THRESHOLD) continue;
    const label = rawLabel.trim().toLowerCase();
    positive ||= POSITIVE_DISCRETE_LABELS.has(label);
    negative ||= NEGATIVE_DISCRETE_LABELS.has(label);
    if (positive && negative) {
      return true;
    }
  }
  return false;
}

function resolveObservedAtMs(
  explicitObservedAtMs: number | null | undefined,
  provenance: readonly EmotionTelemetryProvenance[],
): number | null {
  if (explicitObservedAtMs === null) return null;
  const explicit = normalizeTimestamp(explicitObservedAtMs, 'observedAtMs');
  if (explicit !== undefined) return explicit;
  const observedValues = provenance
    .map(entry => entry.observedAtMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (observedValues.length === 0) return null;
  return Math.max(...observedValues);
}

function inferSourceFromProvenance(
  provenance: readonly EmotionTelemetryProvenance[] | undefined,
): EmotionTelemetrySource | null {
  if (!provenance || provenance.length === 0) return null;
  return normalizeSource(provenance[0].source);
}

function normalizeProvenance(
  value: unknown,
  fieldName: string,
): EmotionTelemetryProvenance[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  return value.map((entry, index) => normalizeProvenanceEntry(entry, `${fieldName}[${String(index)}]`));
}

function normalizeProvenanceEntry(
  value: unknown,
  fieldName: string,
): EmotionTelemetryProvenance {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  const source = normalizeSource(value.source, `${fieldName}.source`);
  const observedAtMs = value.observedAtMs === undefined
    ? undefined
    : parseNonNegativeFinite(value.observedAtMs, `${fieldName}.observedAtMs`);
  const modality = value.modality === undefined
    ? undefined
    : normalizeModality(value.modality, `${fieldName}.modality`);
  const classifier = normalizeOptionalString(value.classifier, `${fieldName}.classifier`);
  const model = normalizeOptionalString(value.model, `${fieldName}.model`);
  const provenanceRef = normalizeOptionalString(value.provenanceRef, `${fieldName}.provenanceRef`);

  return {
    source,
    ...(observedAtMs !== undefined ? { observedAtMs } : {}),
    ...(modality ? { modality } : {}),
    ...(classifier ? { classifier } : {}),
    ...(model ? { model } : {}),
    ...(provenanceRef ? { provenanceRef } : {}),
  };
}

function normalizeRawSignal(value: unknown, fieldName: string): EmotionTelemetrySignalSummary {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  const topDiscreteLabels = Array.isArray(value.topDiscreteLabels)
    ? value.topDiscreteLabels
      .map((label, index) => {
        if (typeof label !== 'string') {
          throw new Error(`${fieldName}.topDiscreteLabels[${String(index)}] must be a string`);
        }
        return label.trim().toLowerCase();
      })
      .filter(label => label.length > 0)
    : (() => {
      throw new Error(`${fieldName}.topDiscreteLabels must be an array`);
    })();
  return {
    confidence: parseUnit(value.confidence, `${fieldName}.confidence`),
    topDiscreteLabels,
    strongestLabelScore: parseUnit(value.strongestLabelScore, `${fieldName}.strongestLabelScore`),
  };
}

function normalizeSource(value: unknown, fieldName = 'source'): EmotionTelemetrySource {
  if (!EMOTION_TELEMETRY_SOURCES.includes(value as EmotionTelemetrySource)) {
    throw new Error(`${fieldName} has unsupported emotion telemetry source "${String(value)}"`);
  }
  return value as EmotionTelemetrySource;
}

function normalizeStatus(value: unknown, fieldName: string): EmotionTelemetryStatus {
  if (!EMOTION_TELEMETRY_STATUSES.includes(value as EmotionTelemetryStatus)) {
    throw new Error(`${fieldName} has unsupported emotion telemetry status "${String(value)}"`);
  }
  return value as EmotionTelemetryStatus;
}

function normalizeReasons(value: unknown, fieldName: string): EmotionTelemetryReason[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  const reasons = value.map((reason, index) => {
    if (!EMOTION_TELEMETRY_REASONS.includes(reason as EmotionTelemetryReason)) {
      throw new Error(`${fieldName}[${String(index)}] has unsupported reason "${String(reason)}"`);
    }
    return reason as EmotionTelemetryReason;
  });
  return [...new Set(reasons)].sort();
}

function normalizeModality(
  value: unknown,
  fieldName: string,
): NonNullable<EmotionTelemetryProvenance['modality']> {
  if (
    value !== 'text'
    && value !== 'audio'
    && value !== 'fusion'
    && value !== 'runtime'
    && value !== 'self_report'
    && value !== 'unknown'
  ) {
    throw new Error(`${fieldName} has unsupported modality "${String(value)}"`);
  }
  return value;
}

function normalizeVad(value: unknown, fieldName: string): VADVector {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return {
    valence: parseSigned(value.valence, `${fieldName}.valence`),
    arousal: parseSigned(value.arousal, `${fieldName}.arousal`),
    dominance: parseSigned(value.dominance, `${fieldName}.dominance`),
  };
}

function scaleVad(vad: VADVector, weight: number): VADVector {
  return {
    valence: roundDecimal(vad.valence * weight),
    arousal: roundDecimal(vad.arousal * weight),
    dominance: roundDecimal(vad.dominance * weight),
  };
}

function normalizeOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string when provided`);
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeTimestamp(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) return undefined;
  return Math.floor(parseNonNegativeFinite(value, fieldName));
}

function normalizePositiveFinite(value: unknown, fallback: number, fieldName: string): number {
  if (value === undefined) return fallback;
  return parsePositiveFinite(value, fieldName);
}

function normalizeUnit(value: unknown, fallback: number, fieldName: string): number {
  if (value === undefined) return fallback;
  return parseUnit(value, fieldName);
}

function parseSigned(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  if (value < -1 || value > 1) {
    throw new Error(`${fieldName} must be in range [-1, 1]`);
  }
  return roundDecimal(value);
}

function parseUnit(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`${fieldName} must be in range [0, 1]`);
  }
  return roundDecimal(value);
}

function parseNonNegativeFinite(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a finite number >= 0`);
  }
  return Math.floor(value);
}

function parsePositiveFinite(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a finite number > 0`);
  }
  return Math.floor(value);
}

function roundDecimal(value: number, precision = 4): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}
