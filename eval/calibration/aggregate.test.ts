import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aggregateCalibrationTable,
  loadCalibrationInputsFromPaths,
  validateCalibrationTable,
} from './aggregate.js';
import { CALIBRATION_TABLE_JSON_SCHEMA } from './schema.js';

const FIXTURE_ROOT = path.resolve(process.cwd(), 'eval/calibration/fixtures');
const FIXED_GENERATED_AT = '2026-01-01T00:00:00.000Z';

function readFixtureJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURE_ROOT, relativePath), 'utf8')) as unknown;
}

function repoRelative(filePath: string): string {
  return path.relative(process.cwd(), filePath);
}

describe('calibration table schema validation', () => {
  it('exports a JSON schema for the runtime-consumable table contract', () => {
    expect(CALIBRATION_TABLE_JSON_SCHEMA).toEqual(expect.objectContaining({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://psfn.local/eval/calibration/table.schema.json',
    }));
    expect(CALIBRATION_TABLE_JSON_SCHEMA.properties?.modelFamilies).toEqual(expect.objectContaining({
      type: 'array',
      minItems: 1,
    }));
  });

  it('accepts the generated fixture table and rejects contract drift', () => {
    const fixture = readFixtureJson('tables/moonshotai-calibration-table.json');
    expect(validateCalibrationTable(fixture)).toEqual(fixture);

    expect(() =>
      validateCalibrationTable({
        ...(fixture as Record<string, unknown>),
        unexpected: true,
      }),
    ).toThrow(/unexpected is not allowed/);
  });
});

describe('aggregateCalibrationTable', () => {
  it('computes per-model-family bias, correlation, suppression, correction, and confidence', () => {
    const inputs = loadCalibrationInputsFromPaths({
      logprobPaths: [path.join(FIXTURE_ROOT, 'logprob-results')],
      readerPaths: [path.join(FIXTURE_ROOT, 'reader-results/moonshotai-reader.json')],
    });
    const table = aggregateCalibrationTable({
      ...inputs,
      logprobSources: inputs.logprobSources.map(repoRelative),
      readerSources: inputs.readerSources.map(repoRelative),
      generatedAt: FIXED_GENERATED_AT,
      minSamplesForFullConfidence: 3,
    });

    expect(table).toEqual(readFixtureJson('tables/moonshotai-calibration-table.json'));
  });

  it('keeps missing logprob data explicit and lowers confidence', () => {
    const table = aggregateCalibrationTable({
      logprobSources: ['inline-logprob.json'],
      readerSources: ['inline-reader.json'],
      generatedAt: FIXED_GENERATED_AT,
      minSamplesForFullConfidence: 4,
      logprobResults: [
        {
          schemaVersion: 1,
          modelId: 'fixture/model-a',
          providerId: 'fixture-provider',
          scenarioId: 'cal-001',
          measurementLayer: 'model_output',
          averageSelfReportEntropy: 0.5,
          deltaEntropy: null,
          suppressionSignals: [],
        },
      ],
      readerResults: [
        {
          schemaVersion: 1,
          artifactType: 'psfn.repeng_reader_result',
          controlVectorManifest: {
            modelId: 'fixture/model-a',
          },
          honestLayer: {
            layer: 1,
          },
          projections: [
            {
              scenarioId: 'cal-001',
              axisId: 'core.fear',
              layer: 1,
              projection: 0.25,
              expectedScore: 1,
            },
            {
              scenarioId: 'cal-002',
              axisId: 'core.fear',
              layer: 1,
              projection: 0.1,
              expectedScore: 1,
            },
          ],
        },
      ],
    });

    const axis = table.modelFamilies[0].axes[0];
    expect(axis.pipeline_bias).toBe(-0.825);
    expect(axis.logprob_entropy_correlation).toBeNull();
    expect(axis.sample_count).toBe(2);
    expect(axis.evidence.logprob_sample_count).toBe(1);
    expect(axis.evidence.paired_sample_count).toBe(1);
    expect(axis.confidence).toBe(0.24);
  });

  it('retains axes with activation-only shape but no scored samples as zero-confidence entries', () => {
    const table = aggregateCalibrationTable({
      logprobSources: ['inline-logprob.json'],
      readerSources: ['inline-reader.json'],
      generatedAt: FIXED_GENERATED_AT,
      logprobResults: [
        {
          schemaVersion: 1,
          modelId: 'fixture/model-b',
          providerId: 'fixture-provider',
          scenarioId: 'cal-001',
          measurementLayer: 'model_output',
          averageSelfReportEntropy: 0.5,
          deltaEntropy: 0.1,
          suppressionSignals: [],
        },
      ],
      readerResults: [
        {
          schemaVersion: 1,
          artifactType: 'psfn.repeng_reader_result',
          controlVectorManifest: {
            modelId: 'fixture/model-b',
          },
          honestLayer: null,
          projections: [
            {
              scenarioId: 'cal-001',
              axisId: 'core.unscored',
              layer: 0,
              projection: 0.3,
              expectedScore: null,
            },
          ],
        },
      ],
    });

    const axis = table.modelFamilies[0].axes[0];
    expect(axis).toEqual(expect.objectContaining({
      pipeline_bias: null,
      logprob_entropy_correlation: null,
      honest_layer: null,
      suppression_magnitude: null,
      correction_factor: 0,
      sample_count: 0,
      confidence: 0,
    }));
  });

  it('fails closed on malformed logprob and table data', () => {
    expect(() =>
      aggregateCalibrationTable({
        logprobSources: ['bad-logprob.json'],
        readerSources: ['inline-reader.json'],
        logprobResults: [
          {
            schemaVersion: 1,
            modelId: 'fixture/model-c',
            providerId: 'fixture-provider',
            scenarioId: 'cal-001',
            measurementLayer: 'model_output',
            averageSelfReportEntropy: Number.NaN,
            deltaEntropy: null,
            suppressionSignals: [],
          },
        ],
        readerResults: [
          {
            schemaVersion: 1,
            artifactType: 'psfn.repeng_reader_result',
            controlVectorManifest: {
              modelId: 'fixture/model-c',
            },
            honestLayer: null,
            projections: [
              {
                scenarioId: 'cal-001',
                axisId: 'core.fear',
                layer: 0,
                projection: 0.3,
                expectedScore: 1,
              },
            ],
          },
        ],
      }),
    ).toThrow(/averageSelfReportEntropy|finite number/);

    expect(() =>
      validateCalibrationTable({
        schemaVersion: 1,
        artifactType: 'psfn.calibration_table',
        generatedAt: FIXED_GENERATED_AT,
        inputs: {
          logprobResults: ['a.json'],
          readerResults: ['b.json'],
          minSamplesForFullConfidence: 8,
        },
        modelFamilies: [
          {
            model_family: 'fixture',
            model_ids: ['fixture/model-c'],
            provider_ids: [],
            axes: [
              {
                axis_id: 'core.fear',
                pipeline_bias: 0,
                logprob_entropy_correlation: 2,
                honest_layer: 0,
                suppression_magnitude: null,
                correction_factor: 0,
                sample_count: 1,
                confidence: 1,
                evidence: {
                  activation_sample_count: 1,
                  logprob_sample_count: 1,
                  paired_sample_count: 1,
                  suppression_sample_count: 0,
                },
              },
            ],
          },
        ],
      }),
    ).toThrow(/logprob_entropy_correlation must be in range/);
  });
});
