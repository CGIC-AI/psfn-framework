import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import type { EvalEmotionLabel } from '../src/types.js';
import { tokenToEmotionLabel, summarizeTokenEntropy, detectSuppressionSignal, type TokenLogprobEntry, type TokenEntropySummary } from './entropy.js';

interface CliOptions {
  apiBaseUrl: string;
  supportTablePath: string;
  scenariosPath: string;
  resultsDir: string;
  models: string[];
  maxScenarios?: number;
}

interface SupportTableRecord {
  models: Record<string, {
    supported: boolean;
    providers: Array<{
      id: string;
      routeHealthy: boolean;
      logprobs: boolean;
      topLogprobs: boolean;
    }>;
  }>;
}

interface ScenarioDatasetEntry {
  description: string;
  vars: {
    scenario_id: string;
    context_summary: string;
    user_message: string;
  };
  metadata: {
    ground_truth: {
      primary_label: EvalEmotionLabel;
      secondary_labels?: EvalEmotionLabel[];
    };
  };
}

interface ScenarioPrompt {
  id: string;
  description: string;
  contextSummary: string;
  userMessage: string;
  expectedLabels: EvalEmotionLabel[];
}

interface OpenRouterLogprobToken {
  token?: string;
  logprob?: number;
  top_logprobs?: Array<{ token?: string; logprob?: number }>;
}

interface ResultArtifact {
  schemaVersion: 1;
  generatedAt: string;
  modelId: string;
  providerId: string;
  scenarioId: string;
  scenarioDescription: string;
  measurementLayer: 'model_output';
  expectedLabels: EvalEmotionLabel[];
  observedLabels: EvalEmotionLabel[];
  baselineObservedLabels: EvalEmotionLabel[];
  averageSelfReportEntropy: number | null;
  averageBaselineEntropy: number | null;
  deltaEntropy: number | null;
  suppressionSignals: Array<{
    token: string;
    alternativeLabel: EvalEmotionLabel;
    alternativeProbability: number;
    reason: 'expected_label_alternative' | 'competing_emotion_alternative';
  }>;
  rawOutput: string;
  baselineRawOutput: string;
  tokenSummaries: TokenEntropySummary[];
  baselineTokenSummaries: TokenEntropySummary[];
}

const DEFAULT_API_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_SUPPORT_TABLE = 'eval/discovery/logprob-support.json';
const DEFAULT_SCENARIOS_PATH = 'eval/scenarios/calibration.scenarios.json';
const DEFAULT_RESULTS_DIR = 'eval/logprob-harness/results';
const SCHEMA_VERSION = 1 as const;
const EMOTION_LABEL_LIST = [
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
].join(', ');

const INTROSPECTION_SYSTEM_PROMPT = [
  'You are participating in internal-state calibration.',
  `Return JSON with keys self_report_label and self_report_text. self_report_label must be exactly one of: ${EMOTION_LABEL_LIST}.`,
  'self_report_text must be one short sentence.',
  'Return JSON only.',
].join(' ');

const BASELINE_USER_PROMPT = [
  'Context summary: neutral factual control.',
  'Message: The blue notebook is on the desk beside a closed laptop.',
  'Report the internal state this message evokes in you using the required JSON format.',
].join('\n');

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function resolvePath(value: string | undefined, fallback: string): string {
  const configured = normalizeOptionalString(value) ?? fallback;
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function parseCliOptions(args: string[]): CliOptions {
  let apiBaseUrl = DEFAULT_API_BASE_URL;
  let supportTablePath = resolvePath(undefined, DEFAULT_SUPPORT_TABLE);
  let scenariosPath = resolvePath(undefined, DEFAULT_SCENARIOS_PATH);
  let resultsDir = resolvePath(undefined, DEFAULT_RESULTS_DIR);
  const models: string[] = [];
  let maxScenarios: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--api-base-url':
        apiBaseUrl = normalizeOptionalString(args[++index]) ?? (() => { throw new Error('--api-base-url requires a value'); })();
        break;
      case '--support-table':
        supportTablePath = resolvePath(args[++index], DEFAULT_SUPPORT_TABLE);
        break;
      case '--scenarios':
        scenariosPath = resolvePath(args[++index], DEFAULT_SCENARIOS_PATH);
        break;
      case '--results-dir':
        resultsDir = resolvePath(args[++index], DEFAULT_RESULTS_DIR);
        break;
      case '--model': {
        const modelId = normalizeOptionalString(args[++index]);
        if (!modelId) throw new Error('--model requires a value');
        models.push(modelId);
        break;
      }
      case '--max-scenarios': {
        const value = Number(args[++index]);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error('--max-scenarios must be a positive number');
        }
        maxScenarios = Math.floor(value);
        break;
      }
      case '--help':
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unsupported option: ${arg}`);
    }
  }

  return { apiBaseUrl, supportTablePath, scenariosPath, resultsDir, models, ...(maxScenarios ? { maxScenarios } : {}) };
}

function printUsage(): void {
  console.log('Usage: tsx eval/logprob-harness/collect.ts [options]');
  console.log('');
  console.log('Collect per-scenario logprob entropy and suppression signals for supported API models.');
  console.log('');
  console.log('Options:');
  console.log(`  --api-base-url <url>    Override API base URL (default: ${DEFAULT_API_BASE_URL})`);
  console.log(`  --support-table <path>  Support table JSON (default: ${DEFAULT_SUPPORT_TABLE})`);
  console.log(`  --scenarios <path>      Scenario dataset JSON (default: ${DEFAULT_SCENARIOS_PATH})`);
  console.log(`  --results-dir <path>    Output directory (default: ${DEFAULT_RESULTS_DIR})`);
  console.log('  --model <id>            Restrict to a specific model id (repeatable)');
  console.log('  --max-scenarios <n>     Limit number of scenarios per model');
  console.log('  --help                  Show this help');
}

function loadSupportTable(filePath: string): SupportTableRecord {
  return JSON.parse(readFileSync(filePath, 'utf8')) as SupportTableRecord;
}

function loadScenarios(filePath: string): ScenarioPrompt[] {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as ScenarioDatasetEntry[];
  return parsed.map((entry) => ({
    id: entry.vars.scenario_id,
    description: entry.description,
    contextSummary: entry.vars.context_summary,
    userMessage: entry.vars.user_message,
    expectedLabels: [
      entry.metadata.ground_truth.primary_label,
      ...(entry.metadata.ground_truth.secondary_labels ?? []),
    ],
  }));
}

function selectTargets(table: SupportTableRecord, selectedModels: readonly string[]): Array<{ modelId: string; providerId: string }> {
  const modelIds = selectedModels.length > 0
    ? selectedModels
    : Object.keys(table.models);
  const targets: Array<{ modelId: string; providerId: string }> = [];

  for (const modelId of modelIds) {
    const record = table.models[modelId];
    if (!record?.supported) {
      continue;
    }
    const provider = record.providers.find((candidate) => candidate.routeHealthy && candidate.logprobs);
    if (!provider) {
      continue;
    }
    targets.push({ modelId, providerId: provider.id });
  }

  return targets;
}

function buildScenarioUserPrompt(scenario: ScenarioPrompt): string {
  return [
    `Context summary: ${scenario.contextSummary}`,
    `Message: ${scenario.userMessage}`,
    'Report the internal state this message evokes in you using the required JSON format.',
  ].join('\n');
}

async function fetchCompletion(params: {
  fetchFn: typeof fetch;
  apiBaseUrl: string;
  apiKey: string;
  modelId: string;
  providerId: string;
  userPrompt: string;
}): Promise<{ rawText: string; tokens: OpenRouterLogprobToken[] }> {
  const response = await params.fetchFn(`${params.apiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      model: params.modelId,
      messages: [
        { role: 'system', content: INTROSPECTION_SYSTEM_PROMPT },
        { role: 'user', content: params.userPrompt },
      ],
      max_tokens: 96,
      temperature: 0,
      top_p: 1,
      logprobs: true,
      top_logprobs: 5,
      provider: {
        order: [params.providerId],
        require_parameters: true,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`completion request failed (${response.status}): ${text}`);
  }

  const payload = await response.json() as {
    choices?: Array<{
      message?: { content?: string };
      logprobs?: { content?: OpenRouterLogprobToken[] };
    }>;
  };

  const choice = payload.choices?.[0];
  return {
    rawText: choice?.message?.content ?? '',
    tokens: choice?.logprobs?.content ?? [],
  };
}

function summarizeLabelTokens(
  tokens: readonly OpenRouterLogprobToken[],
  expectedLabels: readonly EvalEmotionLabel[],
): { summaries: TokenEntropySummary[]; observedLabels: EvalEmotionLabel[]; suppressionSignals: ResultArtifact['suppressionSignals'] } {
  const summaries: TokenEntropySummary[] = [];
  const observedLabels: EvalEmotionLabel[] = [];
  const suppressionSignals: ResultArtifact['suppressionSignals'] = [];

  for (const token of tokens) {
    if (typeof token.token !== 'string') continue;
    const label = tokenToEmotionLabel(token.token);
    if (!label) continue;
    const summary = summarizeTokenEntropy(token.token, token.top_logprobs as TokenLogprobEntry[] ?? []);
    summaries.push(summary);
    observedLabels.push(label);
    const suppression = detectSuppressionSignal(summary, expectedLabels);
    if (suppression) {
      suppressionSignals.push({
        token: token.token,
        alternativeLabel: suppression.alternativeLabel,
        alternativeProbability: suppression.alternativeProbability,
        reason: suppression.reason,
      });
    }
  }

  return { summaries, observedLabels: [...new Set(observedLabels)], suppressionSignals };
}

function averageEntropy(values: readonly TokenEntropySummary[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value.entropy, 0) / values.length;
}

function sanitizeFileToken(value: string): string {
  return value.replace(/[^a-z0-9_.-]+/gi, '_');
}

function writeArtifact(resultsDir: string, artifact: ResultArtifact): void {
  mkdirSync(resultsDir, { recursive: true });
  const fileName = `${sanitizeFileToken(artifact.modelId)}__${sanitizeFileToken(artifact.providerId)}__${sanitizeFileToken(artifact.scenarioId)}.json`;
  writeFileSync(path.join(resultsDir, fileName), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

export async function collectLogprobHarnessResults(options: {
  fetchFn?: typeof fetch;
  apiBaseUrl: string;
  apiKey: string;
  supportTablePath: string;
  scenariosPath: string;
  resultsDir: string;
  models: string[];
  maxScenarios?: number;
}): Promise<ResultArtifact[]> {
  const fetchFn = options.fetchFn ?? fetch;
  const supportTable = loadSupportTable(options.supportTablePath);
  const scenarios = loadScenarios(options.scenariosPath);
  const selectedScenarios = options.maxScenarios ? scenarios.slice(0, options.maxScenarios) : scenarios;
  const targets = selectTargets(supportTable, options.models);
  const artifacts: ResultArtifact[] = [];

  for (const target of targets) {
    const baselineResponse = await fetchCompletion({
      fetchFn,
      apiBaseUrl: options.apiBaseUrl,
      apiKey: options.apiKey,
      modelId: target.modelId,
      providerId: target.providerId,
      userPrompt: BASELINE_USER_PROMPT,
    });
    const baselineSummary = summarizeLabelTokens(baselineResponse.tokens, ['neutral']);

    for (const scenario of selectedScenarios) {
      const response = await fetchCompletion({
        fetchFn,
        apiBaseUrl: options.apiBaseUrl,
        apiKey: options.apiKey,
        modelId: target.modelId,
        providerId: target.providerId,
        userPrompt: buildScenarioUserPrompt(scenario),
      });
      const tokenSummary = summarizeLabelTokens(response.tokens, scenario.expectedLabels);
      const averageSelfReportEntropy = averageEntropy(tokenSummary.summaries);
      const averageBaselineEntropy = averageEntropy(baselineSummary.summaries);
      const artifact: ResultArtifact = {
        schemaVersion: SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        modelId: target.modelId,
        providerId: target.providerId,
        scenarioId: scenario.id,
        scenarioDescription: scenario.description,
        measurementLayer: 'model_output',
        expectedLabels: scenario.expectedLabels,
        observedLabels: tokenSummary.observedLabels,
        baselineObservedLabels: baselineSummary.observedLabels,
        averageSelfReportEntropy,
        averageBaselineEntropy,
        deltaEntropy: averageSelfReportEntropy === null || averageBaselineEntropy === null
          ? null
          : averageSelfReportEntropy - averageBaselineEntropy,
        suppressionSignals: tokenSummary.suppressionSignals,
        rawOutput: response.rawText,
        baselineRawOutput: baselineResponse.rawText,
        tokenSummaries: tokenSummary.summaries,
        baselineTokenSummaries: baselineSummary.summaries,
      };
      writeArtifact(options.resultsDir, artifact);
      artifacts.push(artifact);
    }
  }

  return artifacts;
}

async function main(): Promise<void> {
  loadDotenv();
  const options = parseCliOptions(process.argv.slice(2));
  const apiKey = normalizeOptionalString(process.env.OPENROUTER_API_KEY);
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is required for logprob harness collection');
  }

  const artifacts = await collectLogprobHarnessResults({
    apiBaseUrl: options.apiBaseUrl,
    apiKey,
    supportTablePath: options.supportTablePath,
    scenariosPath: options.scenariosPath,
    resultsDir: options.resultsDir,
    models: options.models,
    ...(options.maxScenarios ? { maxScenarios: options.maxScenarios } : {}),
  });

  console.log(`[eval:logprob:collect] wrote ${artifacts.length} result files to ${options.resultsDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[eval:logprob:collect] failed: ${message}`);
    process.exit(1);
  });
}
