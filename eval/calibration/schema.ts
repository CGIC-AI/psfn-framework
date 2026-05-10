export const CALIBRATION_TABLE_SCHEMA_VERSION = 1 as const;
export const CALIBRATION_TABLE_ARTIFACT_TYPE = 'psfn.calibration_table' as const;

export interface CalibrationTableContract {
  schemaVersion: typeof CALIBRATION_TABLE_SCHEMA_VERSION;
  artifactType: typeof CALIBRATION_TABLE_ARTIFACT_TYPE;
  generatedAt: string;
  inputs: CalibrationTableInputs;
  modelFamilies: CalibrationModelFamilyTable[];
}

export interface CalibrationTableInputs {
  logprobResults: string[];
  readerResults: string[];
  minSamplesForFullConfidence: number;
}

export interface CalibrationModelFamilyTable {
  model_family: string;
  model_ids: string[];
  provider_ids: string[];
  axes: CalibrationAxisCorrection[];
}

export interface CalibrationAxisCorrection {
  axis_id: string;
  pipeline_bias: number | null;
  logprob_entropy_correlation: number | null;
  honest_layer: number | null;
  suppression_magnitude: number | null;
  correction_factor: number;
  sample_count: number;
  confidence: number;
  evidence: CalibrationAxisEvidence;
}

export interface CalibrationAxisEvidence {
  activation_sample_count: number;
  logprob_sample_count: number;
  paired_sample_count: number;
  suppression_sample_count: number;
}

type JsonSchemaPrimitive = boolean | number | string | null;

export interface JsonSchema {
  $schema?: string;
  $id?: string;
  $defs?: Record<string, JsonSchema>;
  $ref?: string;
  type?: JsonSchemaTypeName | JsonSchemaTypeName[];
  const?: JsonSchemaPrimitive;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  enum?: readonly JsonSchemaPrimitive[];
  minItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  minimum?: number;
  maximum?: number;
}

type JsonSchemaTypeName =
  | 'array'
  | 'boolean'
  | 'integer'
  | 'null'
  | 'number'
  | 'object'
  | 'string';

const signedUnitNumberSchema = {
  type: 'number',
  minimum: -1,
  maximum: 1,
} satisfies JsonSchema;

const unitNumberSchema = {
  type: 'number',
  minimum: 0,
  maximum: 1,
} satisfies JsonSchema;

const nullableFiniteNumberSchema = {
  oneOf: [
    { type: 'number' },
    { type: 'null' },
  ],
} satisfies JsonSchema;

const nullableSignedUnitNumberSchema = {
  oneOf: [
    signedUnitNumberSchema,
    { type: 'null' },
  ],
} satisfies JsonSchema;

const nullableUnitNumberSchema = {
  oneOf: [
    unitNumberSchema,
    { type: 'null' },
  ],
} satisfies JsonSchema;

const nonEmptyStringSchema = {
  type: 'string',
  minLength: 1,
} satisfies JsonSchema;

const nonEmptyUniqueStringArraySchema = {
  type: 'array',
  minItems: 1,
  uniqueItems: true,
  items: nonEmptyStringSchema,
} satisfies JsonSchema;

export const CALIBRATION_TABLE_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://psfn.local/eval/calibration/table.schema.json',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'artifactType',
    'generatedAt',
    'inputs',
    'modelFamilies',
  ],
  properties: {
    schemaVersion: {
      type: 'integer',
      const: CALIBRATION_TABLE_SCHEMA_VERSION,
    },
    artifactType: {
      type: 'string',
      const: CALIBRATION_TABLE_ARTIFACT_TYPE,
    },
    generatedAt: nonEmptyStringSchema,
    inputs: {
      type: 'object',
      additionalProperties: false,
      required: [
        'logprobResults',
        'readerResults',
        'minSamplesForFullConfidence',
      ],
      properties: {
        logprobResults: nonEmptyUniqueStringArraySchema,
        readerResults: nonEmptyUniqueStringArraySchema,
        minSamplesForFullConfidence: {
          type: 'integer',
          minimum: 1,
        },
      },
    },
    modelFamilies: {
      type: 'array',
      minItems: 1,
      items: {
        $ref: '#/$defs/modelFamily',
      },
    },
  },
  $defs: {
    modelFamily: {
      type: 'object',
      additionalProperties: false,
      required: [
        'model_family',
        'model_ids',
        'provider_ids',
        'axes',
      ],
      properties: {
        model_family: nonEmptyStringSchema,
        model_ids: nonEmptyUniqueStringArraySchema,
        provider_ids: {
          type: 'array',
          uniqueItems: true,
          items: nonEmptyStringSchema,
        },
        axes: {
          type: 'array',
          minItems: 1,
          items: {
            $ref: '#/$defs/axisCorrection',
          },
        },
      },
    },
    axisCorrection: {
      type: 'object',
      additionalProperties: false,
      required: [
        'axis_id',
        'pipeline_bias',
        'logprob_entropy_correlation',
        'honest_layer',
        'suppression_magnitude',
        'correction_factor',
        'sample_count',
        'confidence',
        'evidence',
      ],
      properties: {
        axis_id: nonEmptyStringSchema,
        pipeline_bias: nullableFiniteNumberSchema,
        logprob_entropy_correlation: nullableSignedUnitNumberSchema,
        honest_layer: {
          oneOf: [
            {
              type: 'integer',
              minimum: 0,
            },
            {
              type: 'null',
            },
          ],
        },
        suppression_magnitude: nullableUnitNumberSchema,
        correction_factor: signedUnitNumberSchema,
        sample_count: {
          type: 'integer',
          minimum: 0,
        },
        confidence: unitNumberSchema,
        evidence: {
          $ref: '#/$defs/evidence',
        },
      },
    },
    evidence: {
      type: 'object',
      additionalProperties: false,
      required: [
        'activation_sample_count',
        'logprob_sample_count',
        'paired_sample_count',
        'suppression_sample_count',
      ],
      properties: {
        activation_sample_count: {
          type: 'integer',
          minimum: 0,
        },
        logprob_sample_count: {
          type: 'integer',
          minimum: 0,
        },
        paired_sample_count: {
          type: 'integer',
          minimum: 0,
        },
        suppression_sample_count: {
          type: 'integer',
          minimum: 0,
        },
      },
    },
  },
} satisfies JsonSchema;
