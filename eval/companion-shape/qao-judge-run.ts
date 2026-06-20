import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import type { InvokeProviderOptions } from '../llm-response/providers.js';
import { invokeProvider } from '../llm-response/providers.js';
import { isLiveProvider, parseTarget } from '../llm-response/targets.js';
import type { LlmProviderResult, LlmResponseCase, LlmResponseTarget } from '../llm-response/types.js';
import {
  QAO_JUDGE_RUBRIC,
  scoreQaoJudgeCouncil,
  type QaoJudgeCouncil,
  type QaoJudgeRequest,
  type QaoJudgeRunArtifact,
  type QaoValidatedJudgeOutput,
} from './qao-judge.js';

const DEFAULT_OUTPUT_DIR = 'eval/companion-shape/artifacts/qao-judge';
const DEFAULT_JUDGE_TARGET = 'fixture:fixture-qao-judge';
const DEFAULT_COUNCIL_ID = 'qao-judge-council-v1';
const DEFAULT_MAX_OUTPUT_TOKENS = 2_000;
const DEFAULT_TEMPERATURE = 0;
const RUNNER_VERSION = 'qao-judge-runner-v1';

export interface QaoJudgeCliOptions {
  sourcePath: string;
  judgeTargets: LlmResponseTarget[];
  outputDir: string;
  outputPath?: string;
  runId?: string;
  councilId: string;
  live: boolean;
  timeoutMs?: number;
  maxOutputTokens: number;
  temperature: number;
}

export interface QaoJudgeRunOptions extends QaoJudgeCliOptions {
  scoredAt?: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  invokeProviderFn?: (options: InvokeProviderOptions) => Promise<LlmProviderResult>;
}

export interface QaoJudgeRunResult {
  artifact: QaoJudgeRunArtifact;
  outputPath: string;
}

export function parseQaoJudgeCliOptions(args: string[]): QaoJudgeCliOptions {
  const rawJudges: string[] = [];
  let sourcePath: string | undefined;
  let outputDir = resolvePath(DEFAULT_OUTPUT_DIR);
  let outputPath: string | undefined;
  let runId: string | undefined;
  let councilId = DEFAULT_COUNCIL_ID;
  let live = false;
  let timeoutMs: number | undefined;
  let maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
  let temperature = DEFAULT_TEMPERATURE;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--source':
        sourcePath = resolvePath(requireNextArg(args, ++index, '--source'));
        break;
      case '--judge':
        rawJudges.push(requireNextArg(args, ++index, '--judge'));
        break;
      case '--output-dir':
        outputDir = resolvePath(requireNextArg(args, ++index, '--output-dir'));
        break;
      case '--output':
        outputPath = resolvePath(requireNextArg(args, ++index, '--output'));
        break;
      case '--run-id':
        runId = requireNextArg(args, ++index, '--run-id');
        break;
      case '--council-id':
        councilId = requireNextArg(args, ++index, '--council-id');
        break;
      case '--live':
        live = true;
        break;
      case '--timeout-ms':
        timeoutMs = parsePositiveNumber(requireNextArg(args, ++index, '--timeout-ms'), '--timeout-ms');
        break;
      case '--max-output-tokens':
        maxOutputTokens = parsePositiveInteger(requireNextArg(args, ++index, '--max-output-tokens'), '--max-output-tokens');
        break;
      case '--temperature':
        temperature = parseNonNegativeNumber(requireNextArg(args, ++index, '--temperature'), '--temperature');
        break;
      case '--help':
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unsupported option: ${arg}`);
    }
  }

  if (!sourcePath) {
    throw new Error('--source is required');
  }

  return {
    sourcePath,
    judgeTargets: parseQaoJudgeTargets(rawJudges),
    outputDir,
    ...(outputPath ? { outputPath } : {}),
    ...(runId ? { runId } : {}),
    councilId,
    live,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    maxOutputTokens,
    temperature,
  };
}

export function parseQaoJudgeTargets(rawJudges: readonly string[]): LlmResponseTarget[] {
  const judges = rawJudges.length === 0 ? [DEFAULT_JUDGE_TARGET] : rawJudges;
  return judges.map(parseTarget);
}

export async function runQaoJudgeCli(
  args: string[],
  deps: {
    scoredAt?: string;
    env?: NodeJS.ProcessEnv;
    fetchFn?: typeof fetch;
    invokeProviderFn?: (options: InvokeProviderOptions) => Promise<LlmProviderResult>;
  } = {},
): Promise<QaoJudgeRunResult> {
  loadDotenv();
  const options = parseQaoJudgeCliOptions(args);
  const result = await runQaoJudge({
    ...options,
    ...deps,
  });

  console.log(`Wrote QAO judge artifact to ${result.outputPath}`);
  if (result.artifact.summary.judgeFailureCount > 0) {
    console.log(`Captured ${result.artifact.summary.judgeFailureCount} judge failures without dropping coverage.`);
  }
  return result;
}

export async function runQaoJudge(options: QaoJudgeRunOptions): Promise<QaoJudgeRunResult> {
  for (const target of options.judgeTargets) {
    if (isLiveProvider(target.providerId) && !options.live) {
      throw new Error(`Live judge provider "${target.providerId}" requires explicit --live opt-in`);
    }
  }

  const source = readJsonFile(options.sourcePath);
  const council = buildQaoJudgeCouncil(options);
  const artifact = await scoreQaoJudgeCouncil(source, council, {
    runId: options.runId,
    scoredAt: options.scoredAt,
  });
  const outputPath = writeQaoJudgeArtifact(artifact, resolveOutputPath(artifact, options));
  return { artifact, outputPath };
}

export function buildQaoJudgeCouncil(options: {
  councilId?: string;
  judgeTargets: readonly LlmResponseTarget[];
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  invokeProviderFn?: (options: InvokeProviderOptions) => Promise<LlmProviderResult>;
  timeoutMs?: number;
  maxOutputTokens?: number;
  temperature?: number;
}): QaoJudgeCouncil {
  const judgeIds = buildJudgeIds(options.judgeTargets);
  return {
    id: options.councilId ?? DEFAULT_COUNCIL_ID,
    judges: options.judgeTargets.map((target, index) => ({
      metadata: {
        id: judgeIds[index],
        providerId: target.providerId,
        modelId: target.modelId,
        role: 'qao-judge',
        version: RUNNER_VERSION,
      },
      judge: target.providerId === 'fixture'
        ? (request: QaoJudgeRequest) => buildFixtureJudgeOutput(request)
        : (request: QaoJudgeRequest) => invokeLiveJudge(target, request, {
          env: options.env,
          fetchFn: options.fetchFn,
          invokeProviderFn: options.invokeProviderFn,
          timeoutMs: options.timeoutMs,
          maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          temperature: options.temperature ?? DEFAULT_TEMPERATURE,
        }),
    })),
  };
}

export function writeQaoJudgeArtifact(artifact: QaoJudgeRunArtifact, outputPath: string): string {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return outputPath;
}

function buildFixtureJudgeOutput(request: QaoJudgeRequest): QaoValidatedJudgeOutput {
  return {
    rubricVersion: request.rubric.version,
    axisScores: request.rubric.axes.map((axis) => ({
      axis: axis.id,
      score: QAO_JUDGE_RUBRIC.scoreScale.passing,
      confidence: 0.8,
      rationaleSummary: `Fixture smoke score for ${axis.id}; replace with live judge output for promotion decisions.`,
    })),
  };
}

async function invokeLiveJudge(
  target: LlmResponseTarget,
  request: QaoJudgeRequest,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchFn?: typeof fetch;
    invokeProviderFn?: (options: InvokeProviderOptions) => Promise<LlmProviderResult>;
    timeoutMs?: number;
    maxOutputTokens: number;
    temperature: number;
  },
): Promise<unknown> {
  const invoke = options.invokeProviderFn ?? invokeProvider;
  const result = await invoke({
    target,
    evalCase: buildJudgeEvalCase(request, options),
    env: options.env,
    fetchFn: options.fetchFn,
    timeoutMs: options.timeoutMs,
  });

  if (result.status === 'failed') {
    throw new Error(`${result.failure.kind}: ${result.failure.message}`);
  }
  return parseJudgeResponseJson(result.responseText);
}

function buildJudgeEvalCase(
  request: QaoJudgeRequest,
  options: {
    maxOutputTokens: number;
    temperature: number;
  },
): LlmResponseCase {
  return {
    id: `${request.runId}:${request.example.id}`,
    title: `QAO judge ${request.example.scenarioId}`,
    modality: 'chat',
    systemPrompt: [
      'You are a strict PSFN QAO model-upgrade judge.',
      'Return only valid JSON with rubricVersion and axisScores.',
      'axisScores must include exactly one score for every rubric axis.',
      'Each score must be an integer from 0 to 4, confidence must be 0 to 1, and rationaleSummary must be concise.',
      'Do not include markdown fences, extra commentary, or raw private context.',
    ].join(' '),
    userPrompt: request.prompt,
    maxOutputTokens: options.maxOutputTokens,
    temperature: options.temperature,
    tags: [
      'qao-judge',
      `candidate-provider:${request.example.providerId}`,
      `candidate-model:${request.example.modelId}`,
      `scenario:${request.example.scenarioId}`,
    ],
  };
}

export function parseJudgeResponseJson(responseText: string): unknown {
  const trimmed = responseText.trim();
  const candidates = [
    trimmed,
    stripJsonFence(trimmed),
    extractJsonObject(trimmed),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next normalized candidate.
    }
  }
  throw qaoJudgeValidationError('Judge response was not valid JSON');
}

function stripJsonFence(value: string): string | undefined {
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim();
}

function extractJsonObject(value: string): string | undefined {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return undefined;
  }
  return value.slice(start, end + 1);
}

function resolveOutputPath(artifact: QaoJudgeRunArtifact, options: QaoJudgeRunOptions): string {
  if (options.outputPath) {
    return options.outputPath;
  }
  return path.join(options.outputDir, `${safeFilePart(artifact.run.id)}.qao-judge.json`);
}

function buildJudgeIds(targets: readonly LlmResponseTarget[]): string[] {
  const counts = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const target of targets) {
    const key = `${target.providerId}:${target.modelId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return targets.map((target) => {
    const key = `${target.providerId}:${target.modelId}`;
    const ordinal = (seen.get(key) ?? 0) + 1;
    seen.set(key, ordinal);
    return counts.get(key) === 1 ? key : `${key}#${ordinal}`;
  });
}

function printUsage(): void {
  console.log('Usage: npm run eval:qao:judge -- --source <qao-collection.json> [options]');
  console.log('');
  console.log('Score QAO collected outputs with a judge council. Fixture judge is default and needs no secrets.');
  console.log('');
  console.log('Options:');
  console.log('  --source <path>                  QAO collection or compatible response artifact. Required.');
  console.log('  --judge <provider:model>         Judge model. Providers: fixture, openrouter, deepseek. Repeatable.');
  console.log(`  --output-dir <path>              Artifact output directory (default: ${DEFAULT_OUTPUT_DIR})`);
  console.log('  --output <path>                  Exact artifact output path.');
  console.log('  --run-id <id>                    Stable judge run id.');
  console.log(`  --council-id <id>                Council id (default: ${DEFAULT_COUNCIL_ID})`);
  console.log('  --live                           Required for openrouter/deepseek judge targets.');
  console.log('  --timeout-ms <n>                 Provider request timeout.');
  console.log('  --max-output-tokens <n>          Per-judge-call max output tokens.');
  console.log('  --temperature <n>                Per-judge-call temperature.');
  console.log('  --help                           Show this help.');
}

function requireNextArg(args: readonly string[], index: number, flag: string): string {
  const value = args[index]?.trim();
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = parsePositiveNumber(value, flag);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${flag} must be an integer`);
  }
  return parsed;
}

function parseNonNegativeNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative number`);
  }
  return parsed;
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
}

function resolvePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}

function qaoJudgeValidationError(message: string): Error {
  const error = new Error(message);
  error.name = 'QaoJudgeValidationError';
  return error;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runQaoJudgeCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
