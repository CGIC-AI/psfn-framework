import { isRecord } from '../../shared/utils/types.js';
import type { NarrativeEmotionAppraisalMode } from '../../system/config/narrative-emotion-appraisal-config.js';
import type { VADVector } from './state.js';

export interface NarrativeAppraisalDriftDecision {
  schemaVersion: 1;
  mode: Extract<NarrativeEmotionAppraisalMode, 'drift_only'>;
  baselineVad: VADVector;
  targetVad: VADVector;
  vadDelta: number;
  threshold: number;
}

export function maxAbsoluteNarrativeVadDelta(left: VADVector, right: VADVector): number {
  return Math.max(
    Math.abs(left.valence - right.valence),
    Math.abs(left.arousal - right.arousal),
    Math.abs(left.dominance - right.dominance),
  );
}

function parseVad(value: unknown, fieldPath: string): VADVector {
  if (!isRecord(value)) throw new Error(`${fieldPath} must be an object`);
  const parseAxis = (axis: keyof VADVector): number => {
    const entry = value[axis];
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < -1 || entry > 1) {
      throw new Error(`${fieldPath}.${axis} must be in range [-1, 1]`);
    }
    return entry;
  };
  return {
    valence: parseAxis('valence'),
    arousal: parseAxis('arousal'),
    dominance: parseAxis('dominance'),
  };
}

export function parseNarrativeAppraisalDriftDecision(
  value: unknown,
  fieldPath = 'narrativeAppraisalDrift',
): NarrativeAppraisalDriftDecision {
  if (!isRecord(value)) throw new Error(`${fieldPath} must be an object`);
  const allowed = new Set([
    'schemaVersion', 'mode', 'baselineVad', 'targetVad', 'vadDelta', 'threshold',
  ]);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${fieldPath} contains unsupported field ${unknown[0]}`);
  if (value.schemaVersion !== 1 || value.mode !== 'drift_only') {
    throw new Error(`${fieldPath} must use schemaVersion 1 and mode drift_only`);
  }
  const baselineVad = parseVad(value.baselineVad, `${fieldPath}.baselineVad`);
  const targetVad = parseVad(value.targetVad, `${fieldPath}.targetVad`);
  if (typeof value.threshold !== 'number'
    || !Number.isFinite(value.threshold)
    || value.threshold <= 0
    || value.threshold > 2) {
    throw new Error(`${fieldPath}.threshold must be in range (0, 2]`);
  }
  const computedDelta = maxAbsoluteNarrativeVadDelta(baselineVad, targetVad);
  if (typeof value.vadDelta !== 'number'
    || !Number.isFinite(value.vadDelta)
    || Math.abs(value.vadDelta - computedDelta) > Number.EPSILON) {
    throw new Error(`${fieldPath}.vadDelta does not match its VAD snapshots`);
  }
  return {
    schemaVersion: 1,
    mode: 'drift_only',
    baselineVad,
    targetVad,
    vadDelta: computedDelta,
    threshold: value.threshold,
  };
}
