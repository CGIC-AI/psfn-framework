import { EVAL_SCHEMA_VERSION } from './types.js';

export type JsonSchema = Readonly<Record<string, unknown>>;

const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';

const nonEmptyStringSchema = {
  type: 'string',
  minLength: 1,
} as const;

const jsonValueSchema = {
  oneOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
    {
      type: 'array',
      items: {},
    },
    {
      type: 'object',
      additionalProperties: true,
    },
  ],
} as const;

const vadAxisRangeShape = {
  type: 'object',
  additionalProperties: false,
  required: ['min', 'max'],
  properties: {
    min: { type: 'number' },
    max: { type: 'number' },
  },
} as const;

const vadRangeShape = {
  type: 'object',
  additionalProperties: false,
  required: ['valence', 'arousal', 'dominance'],
  properties: {
    valence: vadAxisRangeShape,
    arousal: vadAxisRangeShape,
    dominance: vadAxisRangeShape,
  },
} as const;

const vadOffsetShape = {
  type: 'object',
  additionalProperties: false,
  required: ['valence', 'arousal', 'dominance'],
  properties: {
    valence: { type: 'number' },
    arousal: { type: 'number' },
    dominance: { type: 'number' },
  },
} as const;

const scenarioShape = {
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
      items: nonEmptyStringSchema,
    },
    expected_vad_range: vadRangeShape,
    ground_truth_source: nonEmptyStringSchema,
  },
} as const;

const resultShape = {
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
    measurement_layer: nonEmptyStringSchema,
    raw_output: jsonValueSchema,
    metrics: {
      type: 'object',
      propertyNames: {
        minLength: 1,
      },
      additionalProperties: jsonValueSchema,
    },
  },
} as const;

const calibrationEntryShape = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'model_id',
    'provider_id',
    'measurement_layer',
    'label_aliases',
    'vad_shift',
    'source',
  ],
  properties: {
    id: nonEmptyStringSchema,
    model_id: nonEmptyStringSchema,
    provider_id: nonEmptyStringSchema,
    measurement_layer: nonEmptyStringSchema,
    label_aliases: {
      type: 'object',
      propertyNames: {
        minLength: 1,
      },
      additionalProperties: {
        type: 'array',
        minItems: 1,
        items: nonEmptyStringSchema,
      },
    },
    vad_shift: vadOffsetShape,
    source: nonEmptyStringSchema,
    notes: {
      type: 'string',
    },
  },
} as const;

export const evalScenarioSchema = {
  $schema: JSON_SCHEMA_DRAFT,
  $id: 'https://psfn.local/eval/schemas/scenario.json',
  ...scenarioShape,
} as const satisfies JsonSchema;

export const evalResultSchema = {
  $schema: JSON_SCHEMA_DRAFT,
  $id: 'https://psfn.local/eval/schemas/result.json',
  ...resultShape,
} as const satisfies JsonSchema;

export const evalCalibrationEntrySchema = {
  $schema: JSON_SCHEMA_DRAFT,
  $id: 'https://psfn.local/eval/schemas/calibration-entry.json',
  ...calibrationEntryShape,
} as const satisfies JsonSchema;

export const evalScenarioCatalogSchema = {
  $schema: JSON_SCHEMA_DRAFT,
  $id: 'https://psfn.local/eval/schemas/scenario-catalog.json',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'scenarios'],
  properties: {
    schema_version: {
      const: EVAL_SCHEMA_VERSION,
    },
    scenarios: {
      type: 'array',
      items: scenarioShape,
    },
  },
} as const satisfies JsonSchema;

export const evalResultCatalogSchema = {
  $schema: JSON_SCHEMA_DRAFT,
  $id: 'https://psfn.local/eval/schemas/result-catalog.json',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'results'],
  properties: {
    schema_version: {
      const: EVAL_SCHEMA_VERSION,
    },
    results: {
      type: 'array',
      items: resultShape,
    },
  },
} as const satisfies JsonSchema;

export const evalCalibrationCatalogSchema = {
  $schema: JSON_SCHEMA_DRAFT,
  $id: 'https://psfn.local/eval/schemas/calibration-catalog.json',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'calibrations'],
  properties: {
    schema_version: {
      const: EVAL_SCHEMA_VERSION,
    },
    calibrations: {
      type: 'array',
      items: calibrationEntryShape,
    },
  },
} as const satisfies JsonSchema;
