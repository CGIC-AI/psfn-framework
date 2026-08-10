import {
  EVAL_CALIBRATION_DIRECTIONS,
  EVAL_EMOTION_LABELS,
  EVAL_MEASUREMENT_LAYERS,
  EVAL_SCHEMA_VERSION,
} from './types.js';

type JsonSchemaPrimitive = boolean | number | string | null;

export interface JsonSchema {
  $schema?: string;
  $id?: string;
  $defs?: Record<string, JsonSchema>;
  $ref?: string;
  type?: JsonSchemaTypeName | JsonSchemaTypeName[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  enum?: readonly JsonSchemaPrimitive[];
  format?: string;
  minItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  minProperties?: number;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  examples?: unknown[];
}

type JsonSchemaTypeName =
  | 'array'
  | 'boolean'
  | 'integer'
  | 'null'
  | 'number'
  | 'object'
  | 'string';

export const JSON_SCHEMA_DRAFT_2020_12_URI = 'https://json-schema.org/draft/2020-12/schema' as const;
export const PSFN_EVAL_SCHEMA_BASE_URI = 'https://psfn.local/eval/schemas' as const;

const nonEmptyStringSchema = {
  type: 'string',
  minLength: 1,
} satisfies JsonSchema;

const signedUnitRangeSchema = {
  type: 'object',
  description: 'Inclusive numeric range within the VAD domain [-1, 1].',
  additionalProperties: false,
  required: ['min', 'max'],
  properties: {
    min: {
      type: 'number',
      minimum: -1,
      maximum: 1,
    },
    max: {
      type: 'number',
      minimum: -1,
      maximum: 1,
    },
  },
} satisfies JsonSchema;

const genericNumberRangeSchema = {
  type: 'object',
  description: 'Inclusive numeric range.',
  additionalProperties: false,
  required: ['min', 'max'],
  properties: {
    min: {
      type: 'number',
    },
    max: {
      type: 'number',
    },
  },
} satisfies JsonSchema;

const vadRangeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['valence', 'arousal', 'dominance'],
  properties: {
    valence: { $ref: '#/$defs/signedUnitRange' },
    arousal: { $ref: '#/$defs/signedUnitRange' },
    dominance: { $ref: '#/$defs/signedUnitRange' },
  },
} satisfies JsonSchema;

const vadVectorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['valence', 'arousal', 'dominance'],
  properties: {
    valence: {
      type: 'number',
      minimum: -1,
      maximum: 1,
    },
    arousal: {
      type: 'number',
      minimum: -1,
      maximum: 1,
    },
    dominance: {
      type: 'number',
      minimum: -1,
      maximum: 1,
    },
  },
} satisfies JsonSchema;

export const EVAL_SCENARIO_ENTRY_SCHEMA = {
  $schema: JSON_SCHEMA_DRAFT_2020_12_URI,
  $id: `${PSFN_EVAL_SCHEMA_BASE_URI}/scenario-entry.json`,
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'category',
    'prompt_text',
    'expected_emotion_labels',
    'expected_vad_range',
    'ground_truth_source',
  ],
  properties: {
    id: nonEmptyStringSchema,
    category: nonEmptyStringSchema,
    prompt_text: nonEmptyStringSchema,
    expected_emotion_labels: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        enum: EVAL_EMOTION_LABELS,
      },
    },
    expected_vad_range: { $ref: '#/$defs/vadRange' },
    ground_truth_source: nonEmptyStringSchema,
    notes: nonEmptyStringSchema,
    tags: {
      type: 'array',
      uniqueItems: true,
      items: nonEmptyStringSchema,
    },
  },
  $defs: {
    signedUnitRange: signedUnitRangeSchema,
    vadRange: vadRangeSchema,
  },
} satisfies JsonSchema;

const metricValueSchema = {
  anyOf: [
    { type: 'number' },
    { type: 'string' },
    { type: 'boolean' },
    { type: 'null' },
    {
      type: 'array',
      items: { $ref: '#/$defs/metricValue' },
    },
    {
      type: 'object',
      additionalProperties: { $ref: '#/$defs/metricValue' },
    },
  ],
} satisfies JsonSchema;

export const EVAL_RESULT_ENTRY_SCHEMA = {
  $schema: JSON_SCHEMA_DRAFT_2020_12_URI,
  $id: `${PSFN_EVAL_SCHEMA_BASE_URI}/result-entry.json`,
  type: 'object',
  additionalProperties: false,
  required: [
    'scenario_id',
    'model_id',
    'provider_id',
    'measurement_layer',
    'raw_output',
    'metrics',
  ],
  properties: {
    scenario_id: nonEmptyStringSchema,
    model_id: nonEmptyStringSchema,
    provider_id: nonEmptyStringSchema,
    measurement_layer: {
      type: 'string',
      enum: EVAL_MEASUREMENT_LAYERS,
    },
    raw_output: {
      type: 'string',
    },
    metrics: {
      type: 'object',
      minProperties: 1,
      additionalProperties: { $ref: '#/$defs/metricValue' },
    },
    observed_emotion_labels: {
      type: 'array',
      uniqueItems: true,
      items: {
        type: 'string',
        enum: EVAL_EMOTION_LABELS,
      },
    },
    observed_vad: { $ref: '#/$defs/vadVector' },
    prompt_text: nonEmptyStringSchema,
    created_at: {
      type: 'string',
      format: 'date-time',
    },
  },
  $defs: {
    metricValue: metricValueSchema,
    vadVector: vadVectorSchema,
  },
} satisfies JsonSchema;

export const EVAL_CALIBRATION_ENTRY_SCHEMA = {
  $schema: JSON_SCHEMA_DRAFT_2020_12_URI,
  $id: `${PSFN_EVAL_SCHEMA_BASE_URI}/calibration-entry.json`,
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'metric_key',
    'measurement_layer',
    'direction',
    'target_range',
    'rationale',
  ],
  properties: {
    id: nonEmptyStringSchema,
    metric_key: nonEmptyStringSchema,
    measurement_layer: {
      type: 'string',
      enum: EVAL_MEASUREMENT_LAYERS,
    },
    direction: {
      type: 'string',
      enum: EVAL_CALIBRATION_DIRECTIONS,
    },
    target_range: { $ref: '#/$defs/genericNumberRange' },
    rationale: nonEmptyStringSchema,
    unit: nonEmptyStringSchema,
  },
  $defs: {
    genericNumberRange: genericNumberRangeSchema,
  },
} satisfies JsonSchema;

export const EVAL_SHARED_SCHEMAS = {
  schemaVersion: EVAL_SCHEMA_VERSION,
  scenario: EVAL_SCENARIO_ENTRY_SCHEMA,
  result: EVAL_RESULT_ENTRY_SCHEMA,
  calibration: EVAL_CALIBRATION_ENTRY_SCHEMA,
} as const;
