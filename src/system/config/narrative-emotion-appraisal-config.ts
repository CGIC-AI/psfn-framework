import { isRecord } from '../../shared/utils/types.js';

const NARRATIVE_EMOTION_APPRAISAL_MODES = [
  'disabled',
  'drift_only',
] as const;

export type NarrativeEmotionAppraisalMode =
  typeof NARRATIVE_EMOTION_APPRAISAL_MODES[number];

export interface NarrativeEmotionAppraisalSettings {
  /** Expensive narrative appraisal is either disabled or admitted by drift. */
  mode: NarrativeEmotionAppraisalMode;
  /** Maximum absolute VAD-axis movement required from the last narrative snapshot. */
  vadDeltaThreshold: number;
}

export function createDefaultNarrativeEmotionAppraisalSettings(): NarrativeEmotionAppraisalSettings {
  return {
    mode: 'drift_only',
    vadDeltaThreshold: 0.35,
  };
}

export function cloneNarrativeEmotionAppraisalSettings(
  settings: NarrativeEmotionAppraisalSettings,
): NarrativeEmotionAppraisalSettings {
  return { ...settings };
}

export function normalizeNarrativeEmotionAppraisalSettings(
  value: unknown,
  fieldPath = 'narrativeEmotionAppraisal',
): NarrativeEmotionAppraisalSettings {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${fieldPath}: expected object`);
  }
  const unknown = Object.keys(value).filter(key => (
    key !== 'mode' && key !== 'vadDeltaThreshold'
  ));
  if (unknown.length > 0) {
    throw new Error(`Invalid ${fieldPath}: unknown field ${unknown.join(', ')}`);
  }
  if (!(NARRATIVE_EMOTION_APPRAISAL_MODES as readonly unknown[]).includes(value.mode)) {
    throw new Error(
      `Invalid ${fieldPath}.mode: expected ${NARRATIVE_EMOTION_APPRAISAL_MODES.join(' or ')}`,
    );
  }
  if (typeof value.vadDeltaThreshold !== 'number'
    || !Number.isFinite(value.vadDeltaThreshold)
    || value.vadDeltaThreshold <= 0
    || value.vadDeltaThreshold > 2) {
    throw new Error(`Invalid ${fieldPath}.vadDeltaThreshold: expected number in range (0, 2]`);
  }
  return {
    mode: value.mode as NarrativeEmotionAppraisalMode,
    vadDeltaThreshold: value.vadDeltaThreshold,
  };
}
