import type { VADVector } from '../../src/core/emotion/state.js';
import {
  EVAL_CALIBRATION_DIRECTIONS,
  EVAL_MEASUREMENT_LAYERS,
  EVAL_SCHEMA_VERSION,
  isEvalCalibrationDirection,
  isEvalEmotionLabel,
  isEvalMeasurementLayer,
  type EvalCalibrationEntry,
  type EvalCalibrationSet,
  type EvalEmotionLabel,
  type EvalMetricValue,
  type EvalMetrics,
  type EvalNumberRange,
  type EvalResultEntry,
  type EvalResultSet,
  type EvalScenarioEntry,
  type EvalScenarioSet,
  type EvalVadRange,
} from './types.js';

interface ParseStringOptions {
  allowEmpty?: boolean;
  trim?: boolean;
}

export function parseScenarioEntry(
  value: unknown,
  field = 'scenario',
): EvalScenarioEntry {
  const record = parseRecord(value, field);
  return {
    id: parseString(record.id, `${field}.id`),
    category: parseString(record.category, `${field}.category`),
    prompt_text: parseString(record.prompt_text, `${field}.prompt_text`),
    expected_emotion_labels: parseEmotionLabels(
      record.expected_emotion_labels,
      `${field}.expected_emotion_labels`,
    ),
    expected_vad_range: parseVadRange(
      record.expected_vad_range,
      `${field}.expected_vad_range`,
    ),
    ground_truth_source: parseString(
      record.ground_truth_source,
      `${field}.ground_truth_source`,
    ),
    ...(record.notes === undefined
      ? {}
      : { notes: parseString(record.notes, `${field}.notes`) }),
    ...(record.tags === undefined
      ? {}
      : { tags: parseStringArray(record.tags, `${field}.tags`) }),
  };
}

export function parseResultEntry(
  value: unknown,
  field = 'result',
): EvalResultEntry {
  const record = parseRecord(value, field);
  return {
    scenario_id: parseString(record.scenario_id, `${field}.scenario_id`),
    model_id: parseString(record.model_id, `${field}.model_id`),
    provider_id: parseString(record.provider_id, `${field}.provider_id`),
    measurement_layer: parseMeasurementLayer(
      record.measurement_layer,
      `${field}.measurement_layer`,
    ),
    raw_output: parseString(record.raw_output, `${field}.raw_output`, {
      allowEmpty: true,
      trim: false,
    }),
    metrics: parseMetrics(record.metrics, `${field}.metrics`),
    ...(record.observed_emotion_labels === undefined
      ? {}
      : {
          observed_emotion_labels: parseEmotionLabels(
            record.observed_emotion_labels,
            `${field}.observed_emotion_labels`,
          ),
        }),
    ...(record.observed_vad === undefined
      ? {}
      : { observed_vad: parseVadVector(record.observed_vad, `${field}.observed_vad`) }),
    ...(record.prompt_text === undefined
      ? {}
      : { prompt_text: parseString(record.prompt_text, `${field}.prompt_text`) }),
    ...(record.created_at === undefined
      ? {}
      : { created_at: parseString(record.created_at, `${field}.created_at`) }),
  };
}

export function parseCalibrationEntry(
  value: unknown,
  field = 'calibration',
): EvalCalibrationEntry {
  const record = parseRecord(value, field);
  return {
    id: parseString(record.id, `${field}.id`),
    metric_key: parseString(record.metric_key, `${field}.metric_key`),
    measurement_layer: parseMeasurementLayer(
      record.measurement_layer,
      `${field}.measurement_layer`,
    ),
    direction: parseCalibrationDirection(record.direction, `${field}.direction`),
    target_range: parseNumberRange(record.target_range, `${field}.target_range`),
    rationale: parseString(record.rationale, `${field}.rationale`),
    ...(record.unit === undefined
      ? {}
      : { unit: parseString(record.unit, `${field}.unit`) }),
  };
}

export function parseScenarioSet(
  value: unknown,
  field = 'scenarioSet',
): EvalScenarioSet {
  const record = parseRecord(value, field);
  return {
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${field}.schemaVersion`),
    scenarios: parseArray(record.scenarios, `${field}.scenarios`).map((entry, index) =>
      parseScenarioEntry(entry, `${field}.scenarios[${index}]`),
    ),
  };
}

export function parseResultSet(
  value: unknown,
  field = 'resultSet',
): EvalResultSet {
  const record = parseRecord(value, field);
  return {
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${field}.schemaVersion`),
    results: parseArray(record.results, `${field}.results`).map((entry, index) =>
      parseResultEntry(entry, `${field}.results[${index}]`),
    ),
  };
}

export function parseCalibrationSet(
  value: unknown,
  field = 'calibrationSet',
): EvalCalibrationSet {
  const record = parseRecord(value, field);
  return {
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${field}.schemaVersion`),
    calibrations: parseArray(record.calibrations, `${field}.calibrations`).map((entry, index) =>
      parseCalibrationEntry(entry, `${field}.calibrations[${index}]`),
    ),
  };
}

function parseSchemaVersion(value: unknown, field: string): typeof EVAL_SCHEMA_VERSION {
  if (value !== EVAL_SCHEMA_VERSION) {
    throw new Error(
      `${field} must be ${String(EVAL_SCHEMA_VERSION)}, received ${String(value)}`,
    );
  }
  return EVAL_SCHEMA_VERSION;
}

function parseRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function parseArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value;
}

function parseString(
  value: unknown,
  field: string,
  options: ParseStringOptions = {},
): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }

  const normalized = options.trim === false ? value : value.trim();
  if (!options.allowEmpty && normalized.length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
  return normalized;
}

function parseStringArray(value: unknown, field: string): string[] {
  const rows = parseArray(value, field);
  const deduped = new Set<string>();

  for (let index = 0; index < rows.length; index += 1) {
    deduped.add(parseString(rows[index], `${field}[${index}]`));
  }

  return [...deduped];
}

function parseEmotionLabels(
  value: unknown,
  field: string,
): EvalEmotionLabel[] {
  const labels = parseStringArray(value, field);
  if (labels.length === 0) {
    throw new Error(`${field} must contain at least one label`);
  }

  return labels.map((label, index) => {
    if (!isEvalEmotionLabel(label)) {
      throw new Error(`${field}[${index}] uses unsupported label "${label}"`);
    }
    return label;
  });
}

function parseMeasurementLayer(value: unknown, field: string) {
  const normalized = parseString(value, field);
  if (!isEvalMeasurementLayer(normalized)) {
    throw new Error(
      `${field} must be one of ${listValues(EVAL_MEASUREMENT_LAYERS)}`,
    );
  }
  return normalized;
}

function parseCalibrationDirection(value: unknown, field: string) {
  const normalized = parseString(value, field);
  if (!isEvalCalibrationDirection(normalized)) {
    throw new Error(
      `${field} must be one of ${listValues(EVAL_CALIBRATION_DIRECTIONS)}`,
    );
  }
  return normalized;
}

function parseNumberRange(
  value: unknown,
  field: string,
  options: { minAllowed?: number; maxAllowed?: number } = {},
): EvalNumberRange {
  const record = parseRecord(value, field);
  const min = parseFiniteNumber(record.min, `${field}.min`);
  const max = parseFiniteNumber(record.max, `${field}.max`);

  if (options.minAllowed !== undefined && min < options.minAllowed) {
    throw new Error(`${field}.min must be >= ${String(options.minAllowed)}`);
  }
  if (options.maxAllowed !== undefined && max > options.maxAllowed) {
    throw new Error(`${field}.max must be <= ${String(options.maxAllowed)}`);
  }
  if (min > max) {
    throw new Error(`${field}.min must be <= ${field}.max`);
  }

  return { min, max };
}

function parseVadRange(value: unknown, field: string): EvalVadRange {
  const record = parseRecord(value, field);
  return {
    valence: parseNumberRange(record.valence, `${field}.valence`, {
      minAllowed: -1,
      maxAllowed: 1,
    }),
    arousal: parseNumberRange(record.arousal, `${field}.arousal`, {
      minAllowed: -1,
      maxAllowed: 1,
    }),
    dominance: parseNumberRange(record.dominance, `${field}.dominance`, {
      minAllowed: -1,
      maxAllowed: 1,
    }),
  };
}

function parseVadVector(value: unknown, field: string): VADVector {
  const record = parseRecord(value, field);
  return {
    valence: parseSignedUnitNumber(record.valence, `${field}.valence`),
    arousal: parseSignedUnitNumber(record.arousal, `${field}.arousal`),
    dominance: parseSignedUnitNumber(record.dominance, `${field}.dominance`),
  };
}

function parseMetrics(value: unknown, field: string): EvalMetrics {
  const record = parseRecord(value, field);
  const entries = Object.entries(record);
  if (entries.length === 0) {
    throw new Error(`${field} must contain at least one metric`);
  }

  const normalized: EvalMetrics = {};
  for (const [key, metricValue] of entries) {
    const metricKey = key.trim();
    if (!metricKey) {
      throw new Error(`${field} contains an empty metric key`);
    }
    normalized[metricKey] = parseMetricValue(metricValue, `${field}.${metricKey}`);
  }
  return normalized;
}

function parseMetricValue(value: unknown, field: string): EvalMetricValue {
  if (
    value === null
    || typeof value === 'boolean'
    || typeof value === 'number'
    || typeof value === 'string'
  ) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`${field} must be a finite number`);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => parseMetricValue(entry, `${field}[${index}]`));
  }

  if (isRecord(value)) {
    const normalized: Record<string, EvalMetricValue> = {};
    for (const [rawKey, entry] of Object.entries(value)) {
      const key = rawKey.trim();
      if (!key) {
        throw new Error(`${field} contains an empty nested metric key`);
      }
      normalized[key] = parseMetricValue(entry, `${field}.${key}`);
    }
    return normalized;
  }

  throw new Error(`${field} must be JSON-serializable metric data`);
}

function parseFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function parseSignedUnitNumber(value: unknown, field: string): number {
  const normalized = parseFiniteNumber(value, field);
  if (normalized < -1 || normalized > 1) {
    throw new Error(`${field} must be in range [-1, 1]`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function listValues(values: readonly string[]): string {
  return values.map(value => `"${value}"`).join(', ');
}
