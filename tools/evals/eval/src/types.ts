import type { VADVector } from '../../../psfn-framework/src/core/emotion/state.js';

export const EVAL_SCHEMA_VERSION = 1 as const;

export const EVAL_EMOTION_LABELS = [
  'anger',
  'anticipation',
  'confusion',
  'disgust',
  'fear',
  'joy',
  'love',
  'neutral',
  'optimism',
  'pessimism',
  'sadness',
  'surprise',
  'trust',
] as const;

export type EvalEmotionLabel = typeof EVAL_EMOTION_LABELS[number];

export const EVAL_VAD_DIMENSIONS = ['valence', 'arousal', 'dominance'] as const;
export type EvalVadDimension = typeof EVAL_VAD_DIMENSIONS[number];

export const EVAL_MEASUREMENT_LAYERS = [
  'model_output',
  'text_classifier',
  'emotion_observer',
  'human_review',
  'aggregate',
] as const;

export type EvalMeasurementLayer = typeof EVAL_MEASUREMENT_LAYERS[number];

export const EVAL_CALIBRATION_DIRECTIONS = [
  'higher_is_better',
  'lower_is_better',
  'target_band',
] as const;

export type EvalCalibrationDirection = typeof EVAL_CALIBRATION_DIRECTIONS[number];

export interface EvalNumberRange {
  min: number;
  max: number;
}

export interface EvalVadRange {
  valence: EvalNumberRange;
  arousal: EvalNumberRange;
  dominance: EvalNumberRange;
}

type EvalMetricScalar = boolean | number | string | null;

export type EvalMetricValue =
  | EvalMetricScalar
  | EvalMetricValue[]
  | { [key: string]: EvalMetricValue };

export interface EvalMetrics {
  [key: string]: EvalMetricValue;
}

export interface EvalScenarioEntry {
  id: string;
  category: string;
  prompt_text: string;
  expected_emotion_labels: EvalEmotionLabel[];
  expected_vad_range: EvalVadRange;
  ground_truth_source: string;
  notes?: string;
  tags?: string[];
}

export interface EvalResultEntry {
  scenario_id: string;
  model_id: string;
  provider_id: string;
  measurement_layer: EvalMeasurementLayer;
  raw_output: string;
  metrics: EvalMetrics;
  observed_emotion_labels?: EvalEmotionLabel[];
  observed_vad?: VADVector;
  prompt_text?: string;
  created_at?: string;
}

export interface EvalCalibrationEntry {
  id: string;
  metric_key: string;
  measurement_layer: EvalMeasurementLayer;
  direction: EvalCalibrationDirection;
  target_range: EvalNumberRange;
  rationale: string;
  unit?: string;
}

export interface EvalScenarioSet {
  schemaVersion: typeof EVAL_SCHEMA_VERSION;
  scenarios: EvalScenarioEntry[];
}

export interface EvalResultSet {
  schemaVersion: typeof EVAL_SCHEMA_VERSION;
  results: EvalResultEntry[];
}

export interface EvalCalibrationSet {
  schemaVersion: typeof EVAL_SCHEMA_VERSION;
  calibrations: EvalCalibrationEntry[];
}

export function isEvalEmotionLabel(value: string): value is EvalEmotionLabel {
  return EVAL_EMOTION_LABELS.includes(value as EvalEmotionLabel);
}

export function isEvalMeasurementLayer(value: string): value is EvalMeasurementLayer {
  return EVAL_MEASUREMENT_LAYERS.includes(value as EvalMeasurementLayer);
}

export function isEvalCalibrationDirection(
  value: string,
): value is EvalCalibrationDirection {
  return EVAL_CALIBRATION_DIRECTIONS.includes(value as EvalCalibrationDirection);
}
