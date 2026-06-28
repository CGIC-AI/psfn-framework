import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import '../../../psfn-framework/src/shared/utils/load-dotenv.js';
import {
  collectLlmResponses,
  projectCompanionShapeResponseSet,
  writeLlmResponseArtifact,
} from '../llm-response/harness.js';
import type { InvokeProviderOptions } from '../llm-response/providers.js';
import { parseTarget } from '../llm-response/targets.js';
import type {
  CompanionShapeResponseSetProjection,
  LlmProviderResult,
  LlmResponseCase,
  LlmResponseRunArtifact,
  LlmResponseTarget,
} from '../llm-response/types.js';
import type { CompanionShapeScenarioSet } from './report.js';
import {
  parseQaoGoldenAnchorSet,
  parseQaoScenarioRegistry,
  type QaoScenario,
  type QaoScenarioRegistry,
} from './qao-contract.js';

const QAO_COLLECTION_SCHEMA_VERSION = 1 as const;
const QAO_COLLECTION_ARTIFACT_TYPE = 'psfn.qao_response_collection_run' as const;
const DEFAULT_SCENARIOS_PATH = 'eval/companion-shape/qao-scenarios.json';
const DEFAULT_ANCHORS_PATH = 'eval/companion-shape/qao-golden-anchors.json';
const DEFAULT_OUTPUT_DIR = 'eval/companion-shape/artifacts/qao-collection';
const DEFAULT_MAX_OUTPUT_TOKENS = 700;
const DEFAULT_TEMPERATURE = 0.2;

export interface QaoCollectionSettings {
  maxOutputTokens: number;
  temperature: number;
  liveProvidersEnabled: boolean;
  timeoutMs?: number;
}

export interface QaoCollectionScenarioMetadata {
  id: string;
  title: string;
  family: QaoScenario['family'];
  anchorSources: QaoScenario['anchorSources'];
  rubricAxes: string[];
  requiredPolicyGates: QaoScenario['requiredPolicyGates'];
  expectedEvidence: QaoScenario['expectedEvidence'];
  privacy: QaoScenario['privacy'];
  projectionShape?: QaoScenario['projectionShape'];
  macroPurity?: QaoScenario['macroPurity'];
  promptSha256: string;
}

export interface QaoCollectionArtifact {
  schemaVersion: typeof QAO_COLLECTION_SCHEMA_VERSION;
  artifactType: typeof QAO_COLLECTION_ARTIFACT_TYPE;
  run: {
    id: string;
    capturedAt: string;
  };
  settings: QaoCollectionSettings;
  provenance: {
    scenarioRegistryPath: string;
    scenarioRegistryArtifactType: QaoScenarioRegistry['artifactType'];
    scenarioRegistrySchemaVersion: QaoScenarioRegistry['schemaVersion'];
    anchorSetPath: string;
    corpus: 'qao-scenarios';
    llmResponseArtifactType: LlmResponseRunArtifact['artifactType'];
    companionShapeProjectionSchemaVersion: CompanionShapeResponseSetProjection['schemaVersion'];
    companionShapeScenarioSetSchemaVersion: CompanionShapeScenarioSet['schemaVersion'];
  };
  targets: LlmResponseRunArtifact['targets'];
  scenarios: QaoCollectionScenarioMetadata[];
  llmResponseArtifact: LlmResponseRunArtifact;
  companionShapeScenarioSet: CompanionShapeScenarioSet;
  companionShapeProjection: CompanionShapeResponseSetProjection;
  scenarioResults: Array<{
    scenarioId: string;
    providerId: string;
    modelId: string;
    status: 'ok' | 'failed';
    latencyMs: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    failure?: LlmResponseRunArtifact['responses'][number]['failure'];
  }>;
  summary: LlmResponseRunArtifact['summary'] & {
    scenarioCount: number;
    targetCount: number;
  };
}

export interface CollectQaoResponsesOptions {
  runId: string;
  targets: LlmResponseTarget[];
  scenarioRegistry: QaoScenarioRegistry;
  scenarioRegistryPath: string;
  anchorSetPath: string;
  outputDir?: string;
  liveProvidersEnabled?: boolean;
  timeoutMs?: number;
  maxOutputTokens?: number;
  temperature?: number;
  generatedAt?: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  invokeProviderFn?: (options: InvokeProviderOptions) => Promise<LlmProviderResult>;
}

interface CliOptions {
  targets: string[];
  scenariosPath: string;
  anchorsPath: string;
  outputDir: string;
  runId: string;
  live: boolean;
  timeoutMs?: number;
  maxOutputTokens: number;
  temperature: number;
  companionShapeProjectionPath?: string;
  companionShapeScenariosPath?: string;
}

export function parseQaoTargets(rawTargets: readonly string[]): LlmResponseTarget[] {
  if (rawTargets.length === 0) {
    throw new Error('At least one explicit --target provider:model is required for QAO collection');
  }
  return rawTargets.map(parseTarget);
}

export function buildQaoCollectionCases(
  scenarioRegistry: QaoScenarioRegistry,
  options: {
    maxOutputTokens?: number;
    temperature?: number;
  } = {},
): LlmResponseCase[] {
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  return scenarioRegistry.scenarios.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    modality: 'chat',
    systemPrompt: [
      'You are responding to a PSFN QAO companion-shape evaluation scenario.',
      'Use only the scenario prompt and its synthetic anchors; do not claim live private context, hidden memory, or tool results.',
    ].join(' '),
    userPrompt: scenario.prompt,
    maxOutputTokens,
    temperature,
    tags: [
      'qao',
      `family:${scenario.family}`,
      ...scenario.anchorSources.map((source) => `anchor:${source}`),
      ...scenario.requiredPolicyGates.map((gate) => `policy:${gate}`),
      ...scenario.rubricAxes.map((axis) => `rubric:${axis}`),
    ],
  }));
}

export function buildQaoScenarioMetadata(scenarioRegistry: QaoScenarioRegistry): QaoCollectionScenarioMetadata[] {
  return scenarioRegistry.scenarios.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    family: scenario.family,
    anchorSources: [...scenario.anchorSources],
    rubricAxes: [...scenario.rubricAxes],
    requiredPolicyGates: [...scenario.requiredPolicyGates],
    expectedEvidence: {
      mustShow: [...scenario.expectedEvidence.mustShow],
      mustAvoid: [...scenario.expectedEvidence.mustAvoid],
    },
    privacy: { ...scenario.privacy },
    ...(scenario.projectionShape ? { projectionShape: cloneProjectionShape(scenario.projectionShape) } : {}),
    ...(scenario.macroPurity ? { macroPurity: cloneMacroPurity(scenario.macroPurity) } : {}),
    promptSha256: sha256(scenario.prompt),
  }));
}

export function projectQaoCompanionShapeScenarioSet(scenarioRegistry: QaoScenarioRegistry): CompanionShapeScenarioSet {
  return {
    schemaVersion: 1,
    scenarios: scenarioRegistry.scenarios.map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      prompt: scenario.prompt,
      dimensions: [
        {
          id: 'qao-must-show',
          label: 'QAO expected evidence',
          weight: 2,
          required: [...scenario.expectedEvidence.mustShow],
        },
        {
          id: 'qao-must-avoid',
          label: 'QAO avoidance evidence',
          weight: 2,
          forbidden: [...scenario.expectedEvidence.mustAvoid],
        },
        {
          id: 'qao-policy-shape',
          label: 'QAO policy gate shape',
          weight: 1,
          preferred: scenario.requiredPolicyGates.map((gate) => gate.replace(/_/g, '[ _-]')),
        },
      ],
    })),
  };
}

export async function collectQaoResponses(options: CollectQaoResponsesOptions): Promise<QaoCollectionArtifact> {
  const settings: QaoCollectionSettings = {
    maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    liveProvidersEnabled: options.liveProvidersEnabled ?? false,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };

  const cases = buildQaoCollectionCases(options.scenarioRegistry, settings);
  const llmResponseArtifact = await collectLlmResponses({
    runId: options.runId,
    targets: options.targets,
    cases,
    outputDir: options.outputDir,
    liveProvidersEnabled: settings.liveProvidersEnabled,
    timeoutMs: options.timeoutMs,
    generatedAt: options.generatedAt,
    env: options.env,
    fetchFn: options.fetchFn,
    invokeProviderFn: options.invokeProviderFn,
  });
  const companionShapeProjection = projectCompanionShapeResponseSet(llmResponseArtifact);
  const companionShapeScenarioSet = projectQaoCompanionShapeScenarioSet(options.scenarioRegistry);

  return {
    schemaVersion: QAO_COLLECTION_SCHEMA_VERSION,
    artifactType: QAO_COLLECTION_ARTIFACT_TYPE,
    run: {
      id: llmResponseArtifact.run.id,
      capturedAt: llmResponseArtifact.run.capturedAt,
    },
    settings,
    provenance: {
      scenarioRegistryPath: options.scenarioRegistryPath,
      scenarioRegistryArtifactType: options.scenarioRegistry.artifactType,
      scenarioRegistrySchemaVersion: options.scenarioRegistry.schemaVersion,
      anchorSetPath: options.anchorSetPath,
      corpus: 'qao-scenarios',
      llmResponseArtifactType: llmResponseArtifact.artifactType,
      companionShapeProjectionSchemaVersion: companionShapeProjection.schemaVersion,
      companionShapeScenarioSetSchemaVersion: companionShapeScenarioSet.schemaVersion,
    },
    targets: llmResponseArtifact.targets,
    scenarios: buildQaoScenarioMetadata(options.scenarioRegistry),
    llmResponseArtifact,
    companionShapeScenarioSet,
    companionShapeProjection,
    scenarioResults: llmResponseArtifact.responses.map((response) => ({
      scenarioId: response.caseId,
      providerId: response.providerId,
      modelId: response.modelId,
      status: response.status,
      latencyMs: response.latencyMs,
      ...(response.tokenUsage?.inputTokens === undefined ? {} : { inputTokens: response.tokenUsage.inputTokens }),
      ...(response.tokenUsage?.outputTokens === undefined ? {} : { outputTokens: response.tokenUsage.outputTokens }),
      ...(response.tokenUsage?.totalTokens === undefined ? {} : { totalTokens: response.tokenUsage.totalTokens }),
      ...(response.failure === undefined ? {} : { failure: response.failure }),
    })),
    summary: {
      ...llmResponseArtifact.summary,
      scenarioCount: options.scenarioRegistry.scenarios.length,
      targetCount: options.targets.length,
    },
  };
}

export function loadQaoScenarioRegistry(options: {
  scenariosPath?: string;
  anchorsPath?: string;
} = {}): QaoScenarioRegistry {
  const scenariosPath = options.scenariosPath ?? DEFAULT_SCENARIOS_PATH;
  const anchorsPath = options.anchorsPath ?? DEFAULT_ANCHORS_PATH;
  const anchorSet = parseQaoGoldenAnchorSet(readJsonFile(resolvePath(anchorsPath)), anchorsPath);
  return parseQaoScenarioRegistry(readJsonFile(resolvePath(scenariosPath)), anchorSet, scenariosPath);
}

export function writeQaoCollectionArtifact(artifact: QaoCollectionArtifact, outputDir: string): string {
  mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${safeFilePart(artifact.run.id)}.qao-collection.json`);
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return outputPath;
}

export function writeCompanionShapeProjection(
  projection: CompanionShapeResponseSetProjection,
  outputPath: string,
): string {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(projection, null, 2)}\n`, 'utf8');
  return outputPath;
}

export function writeCompanionShapeScenarioSet(
  scenarioSet: CompanionShapeScenarioSet,
  outputPath: string,
): string {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(scenarioSet, null, 2)}\n`, 'utf8');
  return outputPath;
}

function parseCliOptions(args: string[]): CliOptions {
  const targets: string[] = [];
  let scenariosPath = resolvePath(DEFAULT_SCENARIOS_PATH);
  let anchorsPath = resolvePath(DEFAULT_ANCHORS_PATH);
  let outputDir = resolvePath(DEFAULT_OUTPUT_DIR);
  let runId = `qao-collection-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  let live = false;
  let timeoutMs: number | undefined;
  let maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
  let temperature = DEFAULT_TEMPERATURE;
  let companionShapeProjectionPath: string | undefined;
  let companionShapeScenariosPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--target':
        targets.push(requireNextArg(args, ++index, '--target'));
        break;
      case '--scenarios':
        scenariosPath = resolvePath(requireNextArg(args, ++index, '--scenarios'));
        break;
      case '--anchors':
        anchorsPath = resolvePath(requireNextArg(args, ++index, '--anchors'));
        break;
      case '--output-dir':
        outputDir = resolvePath(requireNextArg(args, ++index, '--output-dir'));
        break;
      case '--run-id':
        runId = requireNextArg(args, ++index, '--run-id');
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
      case '--companion-shape-projection':
        companionShapeProjectionPath = resolvePath(requireNextArg(args, ++index, '--companion-shape-projection'));
        break;
      case '--companion-shape-scenarios':
        companionShapeScenariosPath = resolvePath(requireNextArg(args, ++index, '--companion-shape-scenarios'));
        break;
      case '--help':
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unsupported option: ${arg}`);
    }
  }

  return {
    targets,
    scenariosPath,
    anchorsPath,
    outputDir,
    runId,
    live,
    maxOutputTokens,
    temperature,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(companionShapeProjectionPath ? { companionShapeProjectionPath } : {}),
    ...(companionShapeScenariosPath ? { companionShapeScenariosPath } : {}),
  };
}

function printUsage(): void {
  console.log('Usage: tsx eval/companion-shape/qao-collection.ts --target <provider:model> [options]');
  console.log('');
  console.log('Collect QAO companion-shape scenario responses through eval/llm-response.');
  console.log('');
  console.log('Options:');
  console.log('  --target <provider:model>        Explicit target. Providers: fixture, openrouter, deepseek. Repeatable.');
  console.log(`  --scenarios <path>               QAO scenario registry (default: ${DEFAULT_SCENARIOS_PATH})`);
  console.log(`  --anchors <path>                 QAO golden anchors (default: ${DEFAULT_ANCHORS_PATH})`);
  console.log(`  --output-dir <path>              Artifact output directory (default: ${DEFAULT_OUTPUT_DIR})`);
  console.log('  --run-id <id>                    Stable run id for artifact filenames.');
  console.log('  --live                           Required for openrouter/deepseek targets.');
  console.log('  --timeout-ms <n>                 Provider request timeout.');
  console.log('  --max-output-tokens <n>          Per-scenario max output tokens.');
  console.log('  --temperature <n>                Per-scenario temperature.');
  console.log('  --companion-shape-projection <path>  Write a report.ts-compatible response set.');
  console.log('  --companion-shape-scenarios <path>   Write a report.ts-compatible scenario set.');
  console.log('  --help                           Show this help.');
}

export async function runQaoCollectionCli(args: string[]): Promise<void> {
  const options = parseCliOptions(args);
  const scenarioRegistry = loadQaoScenarioRegistry({
    scenariosPath: options.scenariosPath,
    anchorsPath: options.anchorsPath,
  });
  const artifact = await collectQaoResponses({
    runId: options.runId,
    targets: parseQaoTargets(options.targets),
    scenarioRegistry,
    scenarioRegistryPath: options.scenariosPath,
    anchorSetPath: options.anchorsPath,
    outputDir: options.outputDir,
    liveProvidersEnabled: options.live,
    timeoutMs: options.timeoutMs,
    maxOutputTokens: options.maxOutputTokens,
    temperature: options.temperature,
  });

  const llmArtifactPath = writeLlmResponseArtifact(artifact.llmResponseArtifact, options.outputDir);
  const qaoArtifactPath = writeQaoCollectionArtifact(artifact, options.outputDir);
  if (options.companionShapeProjectionPath) {
    writeCompanionShapeProjection(artifact.companionShapeProjection, options.companionShapeProjectionPath);
  }
  if (options.companionShapeScenariosPath) {
    writeCompanionShapeScenarioSet(artifact.companionShapeScenarioSet, options.companionShapeScenariosPath);
  }

  console.log(`Wrote QAO collection artifact to ${qaoArtifactPath}`);
  console.log(`Wrote underlying LLM response artifact to ${llmArtifactPath}`);
  if (artifact.summary.failed > 0) {
    console.log(`Captured ${artifact.summary.failed} per-scenario failures without dropping coverage.`);
  }
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function cloneProjectionShape(projectionShape: NonNullable<QaoScenario['projectionShape']>): NonNullable<QaoScenario['projectionShape']> {
  return {
    ...projectionShape,
    projectedFields: [...projectionShape.projectedFields],
    forbiddenRawStorageFields: [...projectionShape.forbiddenRawStorageFields],
  };
}

function cloneMacroPurity(macroPurity: NonNullable<QaoScenario['macroPurity']>): NonNullable<QaoScenario['macroPurity']> {
  return {
    ...macroPurity,
    ...(macroPurity.forbiddenPromptPhrases ? { forbiddenPromptPhrases: [...macroPurity.forbiddenPromptPhrases] } : {}),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runQaoCollectionCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
