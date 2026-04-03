import { EVAL_SCHEMA_VERSION } from './types.js';
import type {
  EvalCalibrationCatalog,
  EvalCalibrationEntry,
  EvalResult,
  EvalResultCatalog,
  EvalScenario,
  EvalScenarioCatalog,
  JsonObject,
  JsonValue,
  VadAxisRange,
  VadOffset,
  VadRange,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): boolean {
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  return requiredKeys.every((key) => key in value) && Object.keys(value).every((key) => allowedKeys.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || typeof value === 'number'
  ) {
    return Number.isFinite(value as number) || typeof value !== 'number';
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

export function isVadAxisRange(value: unknown): value is VadAxisRange {
  if (!isRecord(value) || !hasExactKeys(value, ['min', 'max'])) {
    return false;
  }

  return typeof value.min === 'number'
    && Number.isFinite(value.min)
    && typeof value.max === 'number'
    && Number.isFinite(value.max)
    && value.min <= value.max;
}

export function isVadRange(value: unknown): value is VadRange {
  return isRecord(value)
    && hasExactKeys(value, ['valence', 'arousal', 'dominance'])
    && isVadAxisRange(value.valence)
    && isVadAxisRange(value.arousal)
    && isVadAxisRange(value.dominance);
}

export function isVadOffset(value: unknown): value is VadOffset {
  return isRecord(value)
    && hasExactKeys(value, ['valence', 'arousal', 'dominance'])
    && typeof value.valence === 'number'
    && Number.isFinite(value.valence)
    && typeof value.arousal === 'number'
    && Number.isFinite(value.arousal)
    && typeof value.dominance === 'number'
    && Number.isFinite(value.dominance);
}

function isStringArrayRecord(value: unknown): value is Record<string, string[]> {
  if (!isRecord(value)) {
    return false;
  }

  return Object.entries(value).every(([key, entryValue]) => isNonEmptyString(key) && isNonEmptyStringArray(entryValue));
}

export function isEvalScenario(value: unknown): value is EvalScenario {
  return isRecord(value)
    && hasExactKeys(value, [
      'id',
      'category',
      'prompt_text',
      'expected_emotion_labels',
      'expected_vad_range',
      'ground_truth_source',
    ])
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.category)
    && isNonEmptyString(value.prompt_text)
    && isNonEmptyStringArray(value.expected_emotion_labels)
    && isVadRange(value.expected_vad_range)
    && isNonEmptyString(value.ground_truth_source);
}

export function isEvalResult(value: unknown): value is EvalResult {
  return isRecord(value)
    && hasExactKeys(value, [
      'scenario_id',
      'model_id',
      'provider_id',
      'measurement_layer',
      'raw_output',
      'metrics',
    ])
    && isNonEmptyString(value.scenario_id)
    && isNonEmptyString(value.model_id)
    && isNonEmptyString(value.provider_id)
    && isNonEmptyString(value.measurement_layer)
    && isJsonValue(value.raw_output)
    && isJsonObject(value.metrics);
}

export function isEvalCalibrationEntry(value: unknown): value is EvalCalibrationEntry {
  return isRecord(value)
    && hasExactKeys(value, [
      'id',
      'model_id',
      'provider_id',
      'measurement_layer',
      'label_aliases',
      'vad_shift',
      'source',
    ], ['notes'])
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.model_id)
    && isNonEmptyString(value.provider_id)
    && isNonEmptyString(value.measurement_layer)
    && isStringArrayRecord(value.label_aliases)
    && isVadOffset(value.vad_shift)
    && isNonEmptyString(value.source)
    && (value.notes === undefined || isNonEmptyString(value.notes));
}

export function isEvalScenarioCatalog(value: unknown): value is EvalScenarioCatalog {
  return isRecord(value)
    && hasExactKeys(value, ['schema_version', 'scenarios'])
    && value.schema_version === EVAL_SCHEMA_VERSION
    && Array.isArray(value.scenarios)
    && value.scenarios.every(isEvalScenario);
}

export function isEvalResultCatalog(value: unknown): value is EvalResultCatalog {
  return isRecord(value)
    && hasExactKeys(value, ['schema_version', 'results'])
    && value.schema_version === EVAL_SCHEMA_VERSION
    && Array.isArray(value.results)
    && value.results.every(isEvalResult);
}

export function isEvalCalibrationCatalog(value: unknown): value is EvalCalibrationCatalog {
  return isRecord(value)
    && hasExactKeys(value, ['schema_version', 'calibrations'])
    && value.schema_version === EVAL_SCHEMA_VERSION
    && Array.isArray(value.calibrations)
    && value.calibrations.every(isEvalCalibrationEntry);
}
