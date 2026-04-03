export const EVAL_SCHEMA_VERSION = 1 as const;

export const RECOMMENDED_MEASUREMENT_LAYERS = [
  'raw_output',
  'structured_parse',
  'metric_rollup',
  'calibrated_projection',
] as const;

export type JsonPrimitive = boolean | number | string | null;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface VadAxisRange {
  min: number;
  max: number;
}

export interface VadRange {
  valence: VadAxisRange;
  arousal: VadAxisRange;
  dominance: VadAxisRange;
}

export interface VadOffset {
  valence: number;
  arousal: number;
  dominance: number;
}

export interface EvalScenario {
  id: string;
  category: string;
  prompt_text: string;
  expected_emotion_labels: string[];
  expected_vad_range: VadRange;
  ground_truth_source: string;
}

export interface EvalResult {
  scenario_id: string;
  model_id: string;
  provider_id: string;
  measurement_layer: string;
  raw_output: JsonValue;
  metrics: JsonObject;
}

export interface EvalCalibrationEntry {
  id: string;
  model_id: string;
  provider_id: string;
  measurement_layer: string;
  label_aliases: Record<string, string[]>;
  vad_shift: VadOffset;
  source: string;
  notes?: string;
}

export interface EvalScenarioCatalog {
  schema_version: typeof EVAL_SCHEMA_VERSION;
  scenarios: EvalScenario[];
}

export interface EvalResultCatalog {
  schema_version: typeof EVAL_SCHEMA_VERSION;
  results: EvalResult[];
}

export interface EvalCalibrationCatalog {
  schema_version: typeof EVAL_SCHEMA_VERSION;
  calibrations: EvalCalibrationEntry[];
}
