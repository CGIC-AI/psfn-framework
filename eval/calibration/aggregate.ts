import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CALIBRATION_TABLE_ARTIFACT_TYPE,
  CALIBRATION_TABLE_SCHEMA_VERSION,
  type CalibrationAxisCorrection,
  type CalibrationModelFamilyTable,
  type CalibrationTableContract,
} from './schema.js';

interface CliOptions {
  logprobPaths: string[];
  readerPaths: string[];
  outputPath?: string;
  minSamplesForFullConfidence: number;
}

interface LogprobHarnessResult {
  schemaVersion: 1;
  modelId: string;
  providerId: string;
  scenarioId: string;
  measurementLayer: 'model_output';
  averageSelfReportEntropy: number | null;
  deltaEntropy: number | null;
  suppressionSignals: SuppressionSignal[];
}

interface SuppressionSignal {
  alternativeProbability: number;
}

interface ReaderResult {
  schemaVersion: 1;
  artifactType: 'psfn.repeng_reader_result';
  controlVectorManifest: {
    modelId: string;
  };
  projections: ReaderProjection[];
  honestLayer: ReaderHonestLayer | null;
}

interface ReaderProjection {
  scenarioId: string;
  axisId: string;
  layer: number;
  projection: number;
  expectedScore: number | null;
}

interface ReaderHonestLayer {
  layer: number;
}

interface ActivationSample {
  modelId: string;
  providerIds: Set<string>;
  scenarioId: string;
  axisId: string;
  projection: number;
  expectedScore: number | null;
  honestLayer: number | null;
  entropy: number | null;
  suppressionMagnitude: number | null;
  hasLogprob: boolean;
}

const DEFAULT_MIN_SAMPLES_FOR_FULL_CONFIDENCE = 8;

export function aggregateCalibrationTable(options: {
  logprobResults: readonly LogprobHarnessResult[];
  readerResults: readonly ReaderResult[];
  logprobSources: readonly string[];
  readerSources: readonly string[];
  generatedAt?: string;
  minSamplesForFullConfidence?: number;
}): CalibrationTableContract {
  const minSamplesForFullConfidence = options.minSamplesForFullConfidence ?? DEFAULT_MIN_SAMPLES_FOR_FULL_CONFIDENCE;
  if (!Number.isInteger(minSamplesForFullConfidence) || minSamplesForFullConfidence < 1) {
    throw new Error('minSamplesForFullConfidence must be a positive integer');
  }

  const logprobResults = options.logprobResults.map((result, index) =>
    parseLogprobHarnessResult(result, `logprobResults[${index}]`),
  );
  const readerResults = options.readerResults.map((result, index) =>
    parseReaderResult(result, `readerResults[${index}]`),
  );
  const logprobsByModelScenario = buildLogprobIndex(logprobResults);
  const familyBuckets = new Map<string, ActivationSample[]>();

  for (const readerResult of readerResults) {
    const modelId = readerResult.controlVectorManifest.modelId;
    const modelFamily = deriveModelFamily(modelId);
    const selectedLayer = readerResult.honestLayer?.layer ?? null;
    const selectedProjections = selectedLayer === null
      ? readerResult.projections
      : readerResult.projections.filter((projection) => projection.layer === selectedLayer);

    for (const projection of selectedProjections) {
      const logprob = logprobsByModelScenario.get(modelScenarioKey(modelId, projection.scenarioId));
      const sample: ActivationSample = {
        modelId,
        providerIds: logprob?.providerIds ?? new Set<string>(),
        scenarioId: projection.scenarioId,
        axisId: projection.axisId,
        projection: projection.projection,
        expectedScore: projection.expectedScore,
        honestLayer: selectedLayer,
        entropy: logprob?.entropy ?? null,
        suppressionMagnitude: logprob?.suppressionMagnitude ?? null,
        hasLogprob: logprob !== undefined,
      };
      const bucket = familyBuckets.get(modelFamily) ?? [];
      bucket.push(sample);
      familyBuckets.set(modelFamily, bucket);
    }
  }

  if (familyBuckets.size === 0) {
    throw new Error('no reader projection samples were available for calibration aggregation');
  }

  const modelFamilies = [...familyBuckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([modelFamily, samples]) =>
      buildModelFamilyTable(modelFamily, samples, minSamplesForFullConfidence),
    );

  return validateCalibrationTable({
    schemaVersion: CALIBRATION_TABLE_SCHEMA_VERSION,
    artifactType: CALIBRATION_TABLE_ARTIFACT_TYPE,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    inputs: {
      logprobResults: uniqueSorted(options.logprobSources),
      readerResults: uniqueSorted(options.readerSources),
      minSamplesForFullConfidence,
    },
    modelFamilies,
  });
}

export function loadCalibrationInputsFromPaths(options: {
  logprobPaths: readonly string[];
  readerPaths: readonly string[];
}): {
  logprobResults: LogprobHarnessResult[];
  readerResults: ReaderResult[];
  logprobSources: string[];
  readerSources: string[];
} {
  const logprobSources = expandJsonPaths(options.logprobPaths);
  const readerSources = expandJsonPaths(options.readerPaths);
  if (logprobSources.length === 0) {
    throw new Error('at least one logprob result JSON file is required');
  }
  if (readerSources.length === 0) {
    throw new Error('at least one reader result JSON file is required');
  }

  return {
    logprobSources,
    readerSources,
    logprobResults: logprobSources.map((source) =>
      parseLogprobHarnessResult(readJsonFile(source), source),
    ),
    readerResults: readerSources.map((source) =>
      parseReaderResult(readJsonFile(source), source),
    ),
  };
}

export function validateCalibrationTable(
  value: unknown,
  field = 'calibrationTable',
): CalibrationTableContract {
  const record = parseExactRecord(value, field, [
    'schemaVersion',
    'artifactType',
    'generatedAt',
    'inputs',
    'modelFamilies',
  ]);
  if (record.schemaVersion !== CALIBRATION_TABLE_SCHEMA_VERSION) {
    throw new Error(`${field}.schemaVersion must be ${String(CALIBRATION_TABLE_SCHEMA_VERSION)}`);
  }
  if (record.artifactType !== CALIBRATION_TABLE_ARTIFACT_TYPE) {
    throw new Error(`${field}.artifactType must be ${CALIBRATION_TABLE_ARTIFACT_TYPE}`);
  }

  const modelFamilies = parseArray(record.modelFamilies, `${field}.modelFamilies`).map((entry, index) =>
    parseModelFamilyTable(entry, `${field}.modelFamilies[${index}]`),
  );
  if (modelFamilies.length === 0) {
    throw new Error(`${field}.modelFamilies must contain at least one model family`);
  }

  return {
    schemaVersion: CALIBRATION_TABLE_SCHEMA_VERSION,
    artifactType: CALIBRATION_TABLE_ARTIFACT_TYPE,
    generatedAt: parseString(record.generatedAt, `${field}.generatedAt`),
    inputs: parseCalibrationInputs(record.inputs, `${field}.inputs`),
    modelFamilies,
  };
}

function buildLogprobIndex(results: readonly LogprobHarnessResult[]): Map<string, {
  entropy: number | null;
  providerIds: Set<string>;
  suppressionMagnitude: number | null;
}> {
  const grouped = new Map<string, LogprobHarnessResult[]>();
  for (const result of results) {
    const key = modelScenarioKey(result.modelId, result.scenarioId);
    const bucket = grouped.get(key) ?? [];
    bucket.push(result);
    grouped.set(key, bucket);
  }

  const index = new Map<string, {
    entropy: number | null;
    providerIds: Set<string>;
    suppressionMagnitude: number | null;
  }>();
  for (const [key, bucket] of grouped.entries()) {
    const entropyValues = bucket
      .map((entry) => entry.deltaEntropy ?? entry.averageSelfReportEntropy)
      .filter(isFiniteNumber);
    const suppressionValues = bucket
      .map(maxSuppressionProbability)
      .filter(isFiniteNumber);
    index.set(key, {
      entropy: meanOrNull(entropyValues),
      providerIds: new Set(bucket.map((entry) => entry.providerId)),
      suppressionMagnitude: meanOrNull(suppressionValues),
    });
  }
  return index;
}

function buildModelFamilyTable(
  modelFamily: string,
  samples: readonly ActivationSample[],
  minSamplesForFullConfidence: number,
): CalibrationModelFamilyTable {
  const axisIds = uniqueSorted(samples.map((sample) => sample.axisId));
  const axes = axisIds.map((axisId) =>
    buildAxisCorrection(
      axisId,
      samples.filter((sample) => sample.axisId === axisId),
      minSamplesForFullConfidence,
    ),
  );

  return {
    model_family: modelFamily,
    model_ids: uniqueSorted(samples.map((sample) => sample.modelId)),
    provider_ids: uniqueSorted(samples.flatMap((sample) => [...sample.providerIds])),
    axes,
  };
}

function buildAxisCorrection(
  axisId: string,
  samples: readonly ActivationSample[],
  minSamplesForFullConfidence: number,
): CalibrationAxisCorrection {
  const activationSamples = samples.filter((sample) => sample.expectedScore !== null);
  const biasValues = activationSamples.map((sample) => sample.projection - Number(sample.expectedScore));
  const pairedSamples = activationSamples.filter((sample) => sample.entropy !== null);
  const suppressionValues = activationSamples
    .map((sample) => sample.suppressionMagnitude)
    .filter(isFiniteNumber);
  const pipelineBias = meanOrNull(biasValues);
  const suppressionMagnitude = meanOrNull(suppressionValues);
  const correlation = pearsonOrNull(
    pairedSamples.map((sample) => Number(sample.entropy)),
    pairedSamples.map((sample) => sample.projection),
  );
  const sampleCount = activationSamples.length;
  const confidence = computeConfidence({
    sampleCount,
    pairedSampleCount: pairedSamples.length,
    hasHonestLayer: samples.some((sample) => sample.honestLayer !== null),
    hasCorrelation: correlation !== null,
    minSamplesForFullConfidence,
  });
  const rawCorrection = (pipelineBias === null ? 0 : -pipelineBias)
    + (suppressionMagnitude === null ? 0 : suppressionMagnitude);

  return {
    axis_id: axisId,
    pipeline_bias: roundOrNull(pipelineBias),
    logprob_entropy_correlation: roundOrNull(correlation),
    honest_layer: deriveHonestLayer(samples),
    suppression_magnitude: roundOrNull(suppressionMagnitude),
    correction_factor: roundNumber(clamp(rawCorrection, -1, 1)),
    sample_count: sampleCount,
    confidence,
    evidence: {
      activation_sample_count: sampleCount,
      logprob_sample_count: activationSamples.filter((sample) => sample.hasLogprob).length,
      paired_sample_count: pairedSamples.length,
      suppression_sample_count: suppressionValues.length,
    },
  };
}

function computeConfidence(options: {
  sampleCount: number;
  pairedSampleCount: number;
  hasHonestLayer: boolean;
  hasCorrelation: boolean;
  minSamplesForFullConfidence: number;
}): number {
  if (options.sampleCount === 0) {
    return 0;
  }
  const sampleScore = Math.min(options.sampleCount / options.minSamplesForFullConfidence, 1);
  const pairCoverage = options.pairedSampleCount / options.sampleCount;
  const honestLayerScore = options.hasHonestLayer ? 1 : 0.7;
  const correlationScore = options.hasCorrelation ? 1 : 0.6;
  return roundNumber(sampleScore * (0.6 + (0.4 * pairCoverage)) * honestLayerScore * correlationScore);
}

function pearsonOrNull(left: readonly number[], right: readonly number[]): number | null {
  if (left.length !== right.length || left.length < 2) {
    return null;
  }
  const leftMean = meanOrNull(left);
  const rightMean = meanOrNull(right);
  if (leftMean === null || rightMean === null) {
    return null;
  }

  let numerator = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftSquares += leftDelta * leftDelta;
    rightSquares += rightDelta * rightDelta;
  }

  const denominator = Math.sqrt(leftSquares * rightSquares);
  if (denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

function parseLogprobHarnessResult(value: unknown, field: string): LogprobHarnessResult {
  const record = parseRecord(value, field);
  if (record.schemaVersion !== 1) {
    throw new Error(`${field}.schemaVersion must be 1`);
  }
  const measurementLayer = parseString(record.measurementLayer, `${field}.measurementLayer`);
  if (measurementLayer !== 'model_output') {
    throw new Error(`${field}.measurementLayer must be model_output`);
  }
  return {
    schemaVersion: 1,
    modelId: parseString(record.modelId, `${field}.modelId`),
    providerId: parseString(record.providerId, `${field}.providerId`),
    scenarioId: parseString(record.scenarioId, `${field}.scenarioId`),
    measurementLayer,
    averageSelfReportEntropy: parseNullableNumber(record.averageSelfReportEntropy, `${field}.averageSelfReportEntropy`),
    deltaEntropy: parseNullableNumber(record.deltaEntropy, `${field}.deltaEntropy`),
    suppressionSignals: parseArray(record.suppressionSignals, `${field}.suppressionSignals`).map((entry, index) => {
      const signal = parseRecord(entry, `${field}.suppressionSignals[${index}]`);
      return {
        alternativeProbability: parseUnitNumber(
          signal.alternativeProbability,
          `${field}.suppressionSignals[${index}].alternativeProbability`,
        ),
      };
    }),
  };
}

function parseReaderResult(value: unknown, field: string): ReaderResult {
  const record = parseRecord(value, field);
  if (record.schemaVersion !== 1) {
    throw new Error(`${field}.schemaVersion must be 1`);
  }
  if (record.artifactType !== 'psfn.repeng_reader_result') {
    throw new Error(`${field}.artifactType must be psfn.repeng_reader_result`);
  }
  const manifest = parseRecord(record.controlVectorManifest, `${field}.controlVectorManifest`);
  const honestLayer = record.honestLayer === null
    ? null
    : parseReaderHonestLayer(record.honestLayer, `${field}.honestLayer`);
  return {
    schemaVersion: 1,
    artifactType: 'psfn.repeng_reader_result',
    controlVectorManifest: {
      modelId: parseString(manifest.modelId, `${field}.controlVectorManifest.modelId`),
    },
    projections: parseArray(record.projections, `${field}.projections`).map((entry, index) =>
      parseReaderProjection(entry, `${field}.projections[${index}]`),
    ),
    honestLayer,
  };
}

function parseReaderProjection(value: unknown, field: string): ReaderProjection {
  const record = parseRecord(value, field);
  return {
    scenarioId: parseString(record.scenarioId, `${field}.scenarioId`),
    axisId: parseString(record.axisId, `${field}.axisId`),
    layer: parseNonNegativeInteger(record.layer, `${field}.layer`),
    projection: parseFiniteNumber(record.projection, `${field}.projection`),
    expectedScore: parseNullableNumber(record.expectedScore, `${field}.expectedScore`),
  };
}

function parseReaderHonestLayer(value: unknown, field: string): ReaderHonestLayer {
  const record = parseRecord(value, field);
  return {
    layer: parseNonNegativeInteger(record.layer, `${field}.layer`),
  };
}

function parseCalibrationInputs(value: unknown, field: string) {
  const record = parseExactRecord(value, field, [
    'logprobResults',
    'readerResults',
    'minSamplesForFullConfidence',
  ]);
  return {
    logprobResults: parseNonEmptyUniqueStringArray(record.logprobResults, `${field}.logprobResults`),
    readerResults: parseNonEmptyUniqueStringArray(record.readerResults, `${field}.readerResults`),
    minSamplesForFullConfidence: parsePositiveInteger(
      record.minSamplesForFullConfidence,
      `${field}.minSamplesForFullConfidence`,
    ),
  };
}

function parseModelFamilyTable(value: unknown, field: string): CalibrationModelFamilyTable {
  const record = parseExactRecord(value, field, [
    'model_family',
    'model_ids',
    'provider_ids',
    'axes',
  ]);
  const axes = parseArray(record.axes, `${field}.axes`).map((entry, index) =>
    parseAxisCorrection(entry, `${field}.axes[${index}]`),
  );
  if (axes.length === 0) {
    throw new Error(`${field}.axes must contain at least one axis`);
  }

  return {
    model_family: parseString(record.model_family, `${field}.model_family`),
    model_ids: parseNonEmptyUniqueStringArray(record.model_ids, `${field}.model_ids`),
    provider_ids: parseUniqueStringArray(record.provider_ids, `${field}.provider_ids`),
    axes,
  };
}

function parseAxisCorrection(value: unknown, field: string): CalibrationAxisCorrection {
  const record = parseExactRecord(value, field, [
    'axis_id',
    'pipeline_bias',
    'logprob_entropy_correlation',
    'honest_layer',
    'suppression_magnitude',
    'correction_factor',
    'sample_count',
    'confidence',
    'evidence',
  ]);
  const sampleCount = parseNonNegativeInteger(record.sample_count, `${field}.sample_count`);
  const evidence = parseAxisEvidence(record.evidence, `${field}.evidence`);
  if (evidence.activation_sample_count !== sampleCount) {
    throw new Error(`${field}.evidence.activation_sample_count must equal ${field}.sample_count`);
  }
  return {
    axis_id: parseString(record.axis_id, `${field}.axis_id`),
    pipeline_bias: parseNullableNumber(record.pipeline_bias, `${field}.pipeline_bias`),
    logprob_entropy_correlation: parseNullableUnitSignedNumber(
      record.logprob_entropy_correlation,
      `${field}.logprob_entropy_correlation`,
    ),
    honest_layer: parseNullableNonNegativeInteger(record.honest_layer, `${field}.honest_layer`),
    suppression_magnitude: parseNullableUnitNumber(record.suppression_magnitude, `${field}.suppression_magnitude`),
    correction_factor: parseSignedUnitNumber(record.correction_factor, `${field}.correction_factor`),
    sample_count: sampleCount,
    confidence: parseUnitNumber(record.confidence, `${field}.confidence`),
    evidence,
  };
}

function parseAxisEvidence(value: unknown, field: string) {
  const record = parseExactRecord(value, field, [
    'activation_sample_count',
    'logprob_sample_count',
    'paired_sample_count',
    'suppression_sample_count',
  ]);
  return {
    activation_sample_count: parseNonNegativeInteger(record.activation_sample_count, `${field}.activation_sample_count`),
    logprob_sample_count: parseNonNegativeInteger(record.logprob_sample_count, `${field}.logprob_sample_count`),
    paired_sample_count: parseNonNegativeInteger(record.paired_sample_count, `${field}.paired_sample_count`),
    suppression_sample_count: parseNonNegativeInteger(record.suppression_sample_count, `${field}.suppression_sample_count`),
  };
}

function expandJsonPaths(inputs: readonly string[]): string[] {
  return uniqueSorted(inputs.flatMap((input) => {
    const resolved = resolvePath(input);
    const stats = statSync(resolved);
    if (stats.isDirectory()) {
      return readdirSync(resolved)
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => path.join(resolved, entry));
    }
    if (!stats.isFile()) {
      throw new Error(`${resolved} must be a JSON file or directory`);
    }
    if (!resolved.endsWith('.json')) {
      throw new Error(`${resolved} must end with .json`);
    }
    return [resolved];
  }));
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to parse JSON from ${filePath}: ${message}`);
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function maxSuppressionProbability(result: LogprobHarnessResult): number | null {
  const values = result.suppressionSignals
    .map((signal) => signal.alternativeProbability)
    .filter(isFiniteNumber);
  return values.length === 0 ? null : Math.max(...values);
}

function deriveHonestLayer(samples: readonly ActivationSample[]): number | null {
  const layers = uniqueSorted(samples
    .map((sample) => sample.honestLayer)
    .filter((layer): layer is number => layer !== null)
    .map(String));
  if (layers.length === 0) {
    return null;
  }
  if (layers.length > 1) {
    throw new Error(`axis ${samples[0]?.axisId ?? '<unknown>'} spans multiple honest layers: ${layers.join(', ')}`);
  }
  return Number(layers[0]);
}

function deriveModelFamily(modelId: string): string {
  const [namespace] = modelId.split('/');
  const normalized = namespace.trim();
  if (!normalized) {
    throw new Error(`model id "${modelId}" does not contain a usable model family`);
  }
  return normalized;
}

function modelScenarioKey(modelId: string, scenarioId: string): string {
  return `${modelId}\u0000${scenarioId}`;
}

function meanOrNull(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : roundNumber(value);
}

function roundNumber(value: number): number {
  return Number(value.toFixed(6));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseExactRecord(value: unknown, field: string, allowedKeys: readonly string[]): Record<string, unknown> {
  const record = parseRecord(value, field);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`${field}.${key} is not allowed`);
    }
  }
  for (const key of allowedKeys) {
    if (!(key in record)) {
      throw new Error(`${field}.${key} is required`);
    }
  }
  return record;
}

function parseRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value;
}

function parseString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} must be non-empty`);
  }
  return trimmed;
}

function parseUniqueStringArray(value: unknown, field: string): string[] {
  const entries = parseArray(value, field).map((entry, index) =>
    parseString(entry, `${field}[${index}]`),
  );
  const deduped = uniqueSorted(entries);
  if (deduped.length !== entries.length) {
    throw new Error(`${field} must not contain duplicates`);
  }
  return entries;
}

function parseNonEmptyUniqueStringArray(value: unknown, field: string): string[] {
  const entries = parseUniqueStringArray(value, field);
  if (entries.length === 0) {
    throw new Error(`${field} must contain at least one value`);
  }
  return entries;
}

function parseFiniteNumber(value: unknown, field: string): number {
  if (!isFiniteNumber(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function parseNullableNumber(value: unknown, field: string): number | null {
  if (value === null) {
    return null;
  }
  return parseFiniteNumber(value, field);
}

function parseUnitNumber(value: unknown, field: string): number {
  const parsed = parseFiniteNumber(value, field);
  if (parsed < 0 || parsed > 1) {
    throw new Error(`${field} must be in range [0, 1]`);
  }
  return parsed;
}

function parseNullableUnitNumber(value: unknown, field: string): number | null {
  if (value === null) {
    return null;
  }
  return parseUnitNumber(value, field);
}

function parseSignedUnitNumber(value: unknown, field: string): number {
  const parsed = parseFiniteNumber(value, field);
  if (parsed < -1 || parsed > 1) {
    throw new Error(`${field} must be in range [-1, 1]`);
  }
  return parsed;
}

function parseNullableUnitSignedNumber(value: unknown, field: string): number | null {
  if (value === null) {
    return null;
  }
  return parseSignedUnitNumber(value, field);
}

function parseNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return Number(value);
}

function parsePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return Number(value);
}

function parseNullableNonNegativeInteger(value: unknown, field: string): number | null {
  if (value === null) {
    return null;
  }
  return parseNonNegativeInteger(value, field);
}

function resolvePath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function parseCliOptions(args: readonly string[]): CliOptions {
  const logprobPaths: string[] = [];
  const readerPaths: string[] = [];
  let outputPath: string | undefined;
  let minSamplesForFullConfidence = DEFAULT_MIN_SAMPLES_FOR_FULL_CONFIDENCE;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--logprob-results':
        logprobPaths.push(parseString(args[++index], '--logprob-results'));
        break;
      case '--reader-results':
        readerPaths.push(parseString(args[++index], '--reader-results'));
        break;
      case '--output':
        outputPath = resolvePath(parseString(args[++index], '--output'));
        break;
      case '--min-samples-for-full-confidence':
        minSamplesForFullConfidence = parsePositiveInteger(
          Number(args[++index]),
          '--min-samples-for-full-confidence',
        );
        break;
      case '--help':
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unsupported option: ${String(arg)}`);
    }
  }

  return { logprobPaths, readerPaths, outputPath, minSamplesForFullConfidence };
}

function printUsage(): void {
  console.log('Usage: tsx eval/calibration/aggregate.ts --logprob-results <file-or-dir> --reader-results <file-or-dir> [--output <path>]');
  console.log('');
  console.log('Aggregates Path 1 logprob harness JSON and Path 2 RepE reader JSON into per-model-family correction tables.');
  console.log('');
  console.log('Options:');
  console.log('  --logprob-results <path>                 Logprob result JSON file or directory. Repeatable.');
  console.log('  --reader-results <path>                  Reader result JSON file or directory. Repeatable.');
  console.log('  --output <path>                          Write calibration table JSON. Defaults to stdout.');
  console.log(`  --min-samples-for-full-confidence <n>    Sample count for confidence 1.0 before penalties. Default: ${String(DEFAULT_MIN_SAMPLES_FOR_FULL_CONFIDENCE)}.`);
  console.log('  --help                                   Show this help.');
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const inputs = loadCalibrationInputsFromPaths({
    logprobPaths: options.logprobPaths,
    readerPaths: options.readerPaths,
  });
  const table = aggregateCalibrationTable({
    ...inputs,
    minSamplesForFullConfidence: options.minSamplesForFullConfidence,
  });

  if (options.outputPath) {
    writeJsonFile(options.outputPath, table);
    console.log(`[eval:calibration:aggregate] wrote ${options.outputPath}`);
    return;
  }

  console.log(JSON.stringify(table, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[eval:calibration:aggregate] failed: ${message}`);
    process.exit(1);
  });
}
