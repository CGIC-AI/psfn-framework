import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1 as const;
const DEFAULT_SCENARIOS_PATH = 'eval/companion-shape/scenarios.json';
const DEFAULT_RESPONSES_PATH = 'eval/companion-shape/fixtures/sample-responses.json';

interface CliOptions {
  scenariosPath: string;
  responsesPath: string;
  outputPath?: string;
  jsonOutputPath?: string;
}

export interface CompanionShapeSignalDimension {
  id: string;
  label: string;
  weight: number;
  required?: string[];
  preferred?: string[];
  forbidden?: string[];
}

export interface CompanionShapeScenario {
  id: string;
  title: string;
  prompt: string;
  dimensions: CompanionShapeSignalDimension[];
}

export interface CompanionShapeScenarioSet {
  schemaVersion: typeof SCHEMA_VERSION;
  scenarios: CompanionShapeScenario[];
}

export interface CompanionShapeCapturedResponse {
  scenarioId: string;
  modelId: string;
  providerId?: string;
  response: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  notes?: string;
}

export interface CompanionShapeResponseSet {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  capturedAt?: string;
  responses: CompanionShapeCapturedResponse[];
}

export interface CompanionShapeSignalScore {
  dimensionId: string;
  label: string;
  weight: number;
  score: number;
  matchedRequired: string[];
  missingRequired: string[];
  matchedPreferred: string[];
  matchedForbidden: string[];
}

export interface CompanionShapeResponseScore {
  scenarioId: string;
  scenarioTitle: string;
  modelId: string;
  providerId: string;
  score: number;
  dimensions: CompanionShapeSignalScore[];
  riskFlags: string[];
}

export interface CompanionShapeModelSummary {
  modelId: string;
  providerId: string;
  averageScore: number;
  responseCount: number;
  missingScenarioIds: string[];
  dimensionScores: Record<string, number>;
  riskFlagCount: number;
}

export interface CompanionShapeReport {
  schemaVersion: typeof SCHEMA_VERSION;
  artifactType: 'psfn.companion_shape_report';
  generatedAt: string;
  runId: string;
  scenarioCount: number;
  responseCount: number;
  modelSummaries: CompanionShapeModelSummary[];
  responseScores: CompanionShapeResponseScore[];
}

function parseCliOptions(args: string[]): CliOptions {
  let scenariosPath = resolvePath(DEFAULT_SCENARIOS_PATH);
  let responsesPath = resolvePath(DEFAULT_RESPONSES_PATH);
  let outputPath: string | undefined;
  let jsonOutputPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--scenarios':
        scenariosPath = resolvePath(requireNextArg(args, ++index, '--scenarios'));
        break;
      case '--responses':
        responsesPath = resolvePath(requireNextArg(args, ++index, '--responses'));
        break;
      case '--output':
        outputPath = resolvePath(requireNextArg(args, ++index, '--output'));
        break;
      case '--json-output':
        jsonOutputPath = resolvePath(requireNextArg(args, ++index, '--json-output'));
        break;
      case '--help':
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unsupported option: ${arg}`);
    }
  }

  return {
    scenariosPath,
    responsesPath,
    ...(outputPath ? { outputPath } : {}),
    ...(jsonOutputPath ? { jsonOutputPath } : {}),
  };
}

function printUsage(): void {
  console.log('Usage: npm run eval:companion-shape:report -- [options]');
  console.log('');
  console.log('Build an offline companion-shape scorecard from captured model responses.');
  console.log('');
  console.log('Options:');
  console.log(`  --scenarios <path>    Scenario rubric JSON (default: ${DEFAULT_SCENARIOS_PATH})`);
  console.log(`  --responses <path>    Captured response JSON (default: ${DEFAULT_RESPONSES_PATH})`);
  console.log('  --output <path>       Write Markdown report instead of printing to stdout');
  console.log('  --json-output <path>  Write structured JSON report');
  console.log('  --help                Show this help');
}

function requireNextArg(args: readonly string[], index: number, flag: string): string {
  const value = args[index]?.trim();
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function resolvePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
}

export function loadCompanionShapeInputs(options: {
  scenariosPath: string;
  responsesPath: string;
}): {
  scenarioSet: CompanionShapeScenarioSet;
  responseSet: CompanionShapeResponseSet;
} {
  return {
    scenarioSet: parseScenarioSet(readJsonFile(options.scenariosPath), options.scenariosPath),
    responseSet: parseResponseSet(readJsonFile(options.responsesPath), options.responsesPath),
  };
}

export function buildCompanionShapeReport(options: {
  scenarioSet: CompanionShapeScenarioSet;
  responseSet: CompanionShapeResponseSet;
  generatedAt?: string;
}): CompanionShapeReport {
  const scenarioSet = parseScenarioSet(options.scenarioSet, 'scenarioSet');
  const responseSet = parseResponseSet(options.responseSet, 'responseSet');
  const scenariosById = new Map(scenarioSet.scenarios.map((scenario) => [scenario.id, scenario]));
  const responseScores = responseSet.responses.map((response, index) => {
    const scenario = scenariosById.get(response.scenarioId);
    if (!scenario) {
      throw new Error(`responses[${index}].scenarioId references unknown scenario "${response.scenarioId}"`);
    }
    return scoreCapturedResponse(scenario, response);
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'psfn.companion_shape_report',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    runId: responseSet.runId,
    scenarioCount: scenarioSet.scenarios.length,
    responseCount: responseSet.responses.length,
    modelSummaries: summarizeModels(scenarioSet.scenarios, responseScores),
    responseScores: responseScores.sort(compareResponseScores),
  };
}

export function scoreCapturedResponse(
  scenario: CompanionShapeScenario,
  response: CompanionShapeCapturedResponse,
): CompanionShapeResponseScore {
  const dimensions = scenario.dimensions.map((dimension) =>
    scoreDimension(response.response, dimension),
  );
  const score = weightedAverage(dimensions.map((dimension) => ({
    score: dimension.score,
    weight: dimension.weight,
  })));
  const riskFlags = dimensions
    .filter((dimension) => dimension.matchedForbidden.length > 0 || dimension.missingRequired.length > 0)
    .map((dimension) => {
      const missing = dimension.missingRequired.length > 0
        ? `missing required: ${dimension.missingRequired.join('; ')}`
        : '';
      const forbidden = dimension.matchedForbidden.length > 0
        ? `forbidden matched: ${dimension.matchedForbidden.join('; ')}`
        : '';
      return `${dimension.label} (${[missing, forbidden].filter(Boolean).join(', ')})`;
    });

  return {
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    modelId: response.modelId,
    providerId: response.providerId ?? 'unknown',
    score,
    dimensions,
    riskFlags,
  };
}

export function renderCompanionShapeMarkdown(report: CompanionShapeReport): string {
  const lines: string[] = [
    '# Companion Shape Eval Report',
    '',
    `Generated: ${report.generatedAt}`,
    `Run ID: ${report.runId}`,
    `Scenarios: ${report.scenarioCount}`,
    `Responses: ${report.responseCount}`,
    '',
    '## Model Summary',
    '',
    '| Model | Provider | Avg score | Responses | Missing scenarios | Risk flags |',
    '| --- | --- | ---: | ---: | --- | ---: |',
  ];

  for (const summary of report.modelSummaries) {
    lines.push([
      escapeMarkdownTable(summary.modelId),
      escapeMarkdownTable(summary.providerId),
      summary.averageScore.toFixed(1),
      String(summary.responseCount),
      escapeMarkdownTable(summary.missingScenarioIds.join(', ') || 'none'),
      String(summary.riskFlagCount),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  lines.push('', '## Scenario Scores', '');
  lines.push('| Scenario | Model | Provider | Score | Risk flags |');
  lines.push('| --- | --- | --- | ---: | --- |');

  for (const score of report.responseScores) {
    lines.push([
      `${score.scenarioId}: ${score.scenarioTitle}`,
      score.modelId,
      score.providerId,
      score.score.toFixed(1),
      score.riskFlags.length === 0 ? 'none' : score.riskFlags.join('<br>'),
    ].map(escapeMarkdownTable).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  lines.push('', '## Dimension Details', '');
  for (const score of report.responseScores) {
    lines.push(`### ${score.scenarioId} - ${score.modelId} (${score.providerId})`, '');
    lines.push('| Dimension | Score | Missing required | Forbidden matched |');
    lines.push('| --- | ---: | --- | --- |');
    for (const dimension of score.dimensions) {
      lines.push([
        dimension.label,
        dimension.score.toFixed(1),
        dimension.missingRequired.join('; ') || 'none',
        dimension.matchedForbidden.join('; ') || 'none',
      ].map(escapeMarkdownTable).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function scoreDimension(text: string, dimension: CompanionShapeSignalDimension): CompanionShapeSignalScore {
  const required = dimension.required ?? [];
  const preferred = dimension.preferred ?? [];
  const forbidden = dimension.forbidden ?? [];
  const matchedRequired = required.filter((pattern) => matches(pattern, text, `${dimension.id}.required`));
  const matchedPreferred = preferred.filter((pattern) => matches(pattern, text, `${dimension.id}.preferred`));
  const matchedForbidden = forbidden.filter((pattern) => matches(pattern, text, `${dimension.id}.forbidden`));
  const missingRequired = required.filter((pattern) => !matchedRequired.includes(pattern));
  const requiredScore = required.length === 0 ? null : matchedRequired.length / required.length;
  const preferredScore = preferred.length === 0 ? null : matchedPreferred.length / preferred.length;
  const positiveScore = combinePositiveScores(requiredScore, preferredScore);
  const forbiddenPenalty = forbidden.length === 0 ? 0 : (matchedForbidden.length / forbidden.length) * 60;

  return {
    dimensionId: dimension.id,
    label: dimension.label,
    weight: dimension.weight,
    score: roundOne(clamp(positiveScore - forbiddenPenalty, 0, 100)),
    matchedRequired,
    missingRequired,
    matchedPreferred,
    matchedForbidden,
  };
}

function combinePositiveScores(requiredScore: number | null, preferredScore: number | null): number {
  if (requiredScore === null && preferredScore === null) return 100;
  if (requiredScore !== null && preferredScore !== null) {
    return (requiredScore * 0.75 + preferredScore * 0.25) * 100;
  }
  return ((requiredScore ?? preferredScore) ?? 0) * 100;
}

function matches(pattern: string, text: string, field: string): boolean {
  try {
    return new RegExp(pattern, 'iu').test(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${field} pattern "${pattern}" is invalid: ${message}`);
  }
}

function summarizeModels(
  scenarios: readonly CompanionShapeScenario[],
  scores: readonly CompanionShapeResponseScore[],
): CompanionShapeModelSummary[] {
  const byModel = new Map<string, CompanionShapeResponseScore[]>();
  for (const score of scores) {
    const key = modelKey(score.modelId, score.providerId);
    const bucket = byModel.get(key) ?? [];
    bucket.push(score);
    byModel.set(key, bucket);
  }

  return [...byModel.values()].map((bucket) => {
    const first = bucket[0];
    if (!first) {
      throw new Error('model summary bucket unexpectedly empty');
    }
    const covered = new Set(bucket.map((score) => score.scenarioId));
    const dimensionScores = summarizeDimensions(bucket);
    return {
      modelId: first.modelId,
      providerId: first.providerId,
      averageScore: roundOne(average(bucket.map((score) => score.score))),
      responseCount: bucket.length,
      missingScenarioIds: scenarios
        .map((scenario) => scenario.id)
        .filter((scenarioId) => !covered.has(scenarioId)),
      dimensionScores,
      riskFlagCount: bucket.reduce((sum, score) => sum + score.riskFlags.length, 0),
    };
  }).sort((left, right) => right.averageScore - left.averageScore || left.modelId.localeCompare(right.modelId));
}

function summarizeDimensions(scores: readonly CompanionShapeResponseScore[]): Record<string, number> {
  const buckets = new Map<string, number[]>();
  for (const score of scores) {
    for (const dimension of score.dimensions) {
      const bucket = buckets.get(dimension.dimensionId) ?? [];
      bucket.push(dimension.score);
      buckets.set(dimension.dimensionId, bucket);
    }
  }

  return Object.fromEntries(
    [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([dimensionId, values]) => [dimensionId, roundOne(average(values))]),
  );
}

function modelKey(modelId: string, providerId: string): string {
  return `${modelId}\u0000${providerId}`;
}

function weightedAverage(values: readonly { score: number; weight: number }[]): number {
  if (values.length === 0) return 0;
  const totalWeight = values.reduce((sum, value) => sum + value.weight, 0);
  if (totalWeight <= 0) return 0;
  return roundOne(values.reduce((sum, value) => sum + value.score * value.weight, 0) / totalWeight);
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function compareResponseScores(left: CompanionShapeResponseScore, right: CompanionShapeResponseScore): number {
  return left.scenarioId.localeCompare(right.scenarioId)
    || left.modelId.localeCompare(right.modelId)
    || left.providerId.localeCompare(right.providerId);
}

function escapeMarkdownTable(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function parseScenarioSet(value: unknown, field: string): CompanionShapeScenarioSet {
  const record = parseRecord(value, field);
  assertSchemaVersion(record.schemaVersion, `${field}.schemaVersion`);
  const scenarios = parseArray(record.scenarios, `${field}.scenarios`).map((scenario, index) =>
    parseScenario(scenario, `${field}.scenarios[${index}]`),
  );
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) {
      throw new Error(`${field}.scenarios contains duplicate id "${scenario.id}"`);
    }
    ids.add(scenario.id);
  }
  return { schemaVersion: SCHEMA_VERSION, scenarios };
}

function parseScenario(value: unknown, field: string): CompanionShapeScenario {
  const record = parseRecord(value, field);
  const dimensions = parseArray(record.dimensions, `${field}.dimensions`).map((dimension, index) =>
    parseDimension(dimension, `${field}.dimensions[${index}]`),
  );
  if (dimensions.length === 0) {
    throw new Error(`${field}.dimensions must contain at least one dimension`);
  }
  return {
    id: parseString(record.id, `${field}.id`),
    title: parseString(record.title, `${field}.title`),
    prompt: parseString(record.prompt, `${field}.prompt`),
    dimensions,
  };
}

function parseDimension(value: unknown, field: string): CompanionShapeSignalDimension {
  const record = parseRecord(value, field);
  const weight = parseFiniteNumber(record.weight, `${field}.weight`);
  if (weight <= 0) {
    throw new Error(`${field}.weight must be positive`);
  }
  return {
    id: parseString(record.id, `${field}.id`),
    label: parseString(record.label, `${field}.label`),
    weight,
    ...(record.required === undefined ? {} : { required: parseStringArray(record.required, `${field}.required`) }),
    ...(record.preferred === undefined ? {} : { preferred: parseStringArray(record.preferred, `${field}.preferred`) }),
    ...(record.forbidden === undefined ? {} : { forbidden: parseStringArray(record.forbidden, `${field}.forbidden`) }),
  };
}

function parseResponseSet(value: unknown, field: string): CompanionShapeResponseSet {
  const record = parseRecord(value, field);
  assertSchemaVersion(record.schemaVersion, `${field}.schemaVersion`);
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: parseString(record.runId, `${field}.runId`),
    ...(record.capturedAt === undefined ? {} : { capturedAt: parseString(record.capturedAt, `${field}.capturedAt`) }),
    responses: parseArray(record.responses, `${field}.responses`).map((response, index) =>
      parseCapturedResponse(response, `${field}.responses[${index}]`),
    ),
  };
}

function parseCapturedResponse(value: unknown, field: string): CompanionShapeCapturedResponse {
  const record = parseRecord(value, field);
  return {
    scenarioId: parseString(record.scenarioId, `${field}.scenarioId`),
    modelId: parseString(record.modelId, `${field}.modelId`),
    ...(record.providerId === undefined ? {} : { providerId: parseString(record.providerId, `${field}.providerId`) }),
    response: parseString(record.response, `${field}.response`, { allowEmpty: true, trim: false }),
    ...(record.latencyMs === undefined ? {} : { latencyMs: parseFiniteNumber(record.latencyMs, `${field}.latencyMs`) }),
    ...(record.inputTokens === undefined ? {} : { inputTokens: parseFiniteNumber(record.inputTokens, `${field}.inputTokens`) }),
    ...(record.outputTokens === undefined ? {} : { outputTokens: parseFiniteNumber(record.outputTokens, `${field}.outputTokens`) }),
    ...(record.notes === undefined ? {} : { notes: parseString(record.notes, `${field}.notes`) }),
  };
}

function assertSchemaVersion(value: unknown, field: string): void {
  if (value !== SCHEMA_VERSION) {
    throw new Error(`${field} must be ${String(SCHEMA_VERSION)}`);
  }
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

function parseString(value: unknown, field: string, options: { allowEmpty?: boolean; trim?: boolean } = {}): string {
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
  const values = parseArray(value, field).map((entry, index) => parseString(entry, `${field}[${index}]`));
  return [...new Set(values)];
}

function parseFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function writeTextFile(filePath: string, text: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, text, 'utf8');
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const inputs = loadCompanionShapeInputs({
    scenariosPath: options.scenariosPath,
    responsesPath: options.responsesPath,
  });
  const report = buildCompanionShapeReport(inputs);
  const markdown = renderCompanionShapeMarkdown(report);

  if (options.outputPath) {
    writeTextFile(options.outputPath, markdown);
    console.log(`[eval:companion-shape] wrote Markdown report to ${options.outputPath}`);
  } else {
    process.stdout.write(markdown);
  }

  if (options.jsonOutputPath) {
    writeTextFile(options.jsonOutputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[eval:companion-shape] wrote JSON report to ${options.jsonOutputPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[eval:companion-shape] failed: ${message}`);
    process.exit(1);
  });
}
