import { isRecord } from '../../shared/utils/types.js';
import type { EmotionStateSnapshot, VADVector } from './state.js';

export const SESSION_METADATA_EMOTION_STATE_KEY = 'emotionState';

interface SessionMetadataEnvelope {
  [key: string]: unknown;
}


function parseMetadataEnvelope(metadata: string | undefined): SessionMetadataEnvelope {
  if (!metadata) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    throw new Error('Session metadata is malformed JSON; refusing emotion metadata parsing');
  }

  if (!isRecord(parsed)) {
    throw new Error('Session metadata must be a JSON object for emotion metadata parsing');
  }

  return parsed as SessionMetadataEnvelope;
}

function parseSigned(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Emotion metadata field "${fieldName}" must be a finite number`);
  }
  if (value < -1 || value > 1) {
    throw new Error(`Emotion metadata field "${fieldName}" must be in range [-1, 1]`);
  }
  return value;
}

function parseUnit(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Emotion metadata field "${fieldName}" must be a finite number`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`Emotion metadata field "${fieldName}" must be in range [0, 1]`);
  }
  return value;
}

function parseRequiredVAD(value: unknown, fieldName: string): VADVector {
  if (!isRecord(value)) {
    throw new Error(`Emotion metadata field "${fieldName}" must be an object`);
  }
  return {
    valence: parseSigned(value.valence, `${fieldName}.valence`),
    arousal: parseSigned(value.arousal, `${fieldName}.arousal`),
    dominance: parseSigned(value.dominance, `${fieldName}.dominance`),
  };
}

function parseDiscrete(value: unknown): Record<string, number> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error('Emotion metadata field "emotionState.discrete" must be an object when present');
  }

  const discrete: Record<string, number> = {};
  for (const [rawLabel, rawScore] of Object.entries(value)) {
    const label = rawLabel.trim().toLowerCase();
    if (!label) continue;
    discrete[label] = parseUnit(rawScore, `emotionState.discrete.${label}`);
  }
  return discrete;
}

function normalizeSnapshot(snapshot: EmotionStateSnapshot): EmotionStateSnapshot {
  const discrete: Record<string, number> = {};
  for (const [rawLabel, rawScore] of Object.entries(snapshot.discrete)) {
    const label = rawLabel.trim().toLowerCase();
    if (!label) continue;
    discrete[label] = parseUnit(rawScore, `emotionState.discrete.${label}`);
  }

  return {
    vad: {
      valence: parseSigned(snapshot.vad.valence, 'emotionState.vad.valence'),
      arousal: parseSigned(snapshot.vad.arousal, 'emotionState.vad.arousal'),
      dominance: parseSigned(snapshot.vad.dominance, 'emotionState.vad.dominance'),
    },
    mood: {
      valence: parseSigned(snapshot.mood.valence, 'emotionState.mood.valence'),
      arousal: parseSigned(snapshot.mood.arousal, 'emotionState.mood.arousal'),
      dominance: parseSigned(snapshot.mood.dominance, 'emotionState.mood.dominance'),
    },
    discrete,
    confidence: parseUnit(snapshot.confidence, 'emotionState.confidence'),
  };
}

export function buildSessionMetadataWithEmotionState(
  existingMetadata: string | undefined,
  snapshot: EmotionStateSnapshot,
): string {
  const base = parseMetadataEnvelope(existingMetadata);
  return JSON.stringify({
    ...base,
    [SESSION_METADATA_EMOTION_STATE_KEY]: normalizeSnapshot(snapshot),
  });
}

export function parseSessionEmotionState(
  metadata: string | undefined,
): EmotionStateSnapshot | null {
  const envelope = parseMetadataEnvelope(metadata);
  const raw = envelope[SESSION_METADATA_EMOTION_STATE_KEY];
  if (raw === undefined) {
    return null;
  }
  if (!isRecord(raw)) {
    throw new Error('Session metadata emotionState field must be an object');
  }
  return {
    vad: parseRequiredVAD(raw.vad, 'emotionState.vad'),
    mood: parseRequiredVAD(raw.mood, 'emotionState.mood'),
    discrete: parseDiscrete(raw.discrete),
    confidence: parseUnit(raw.confidence, 'emotionState.confidence'),
  };
}
