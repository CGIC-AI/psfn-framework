import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { selectCases } from './cases.js';
import { collectLlmResponses, projectCompanionShapeResponseSet, writeLlmResponseArtifact } from './harness.js';
import { parseTargets } from './targets.js';

interface CliOptions {
  targets: string[];
  caseIds: string[];
  outputDir: string;
  runId: string;
  live: boolean;
  companionShapeProjection?: string;
  timeoutMs?: number;
}

const DEFAULT_OUTPUT_DIR = 'eval/llm-response/artifacts';

function parseCliOptions(args: string[]): CliOptions {
  const targets: string[] = [];
  const caseIds: string[] = [];
  let outputDir = resolvePath(DEFAULT_OUTPUT_DIR);
  let runId = `llm-response-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  let live = false;
  let companionShapeProjection: string | undefined;
  let timeoutMs: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--target':
        targets.push(requireNextArg(args, ++index, '--target'));
        break;
      case '--case':
        caseIds.push(requireNextArg(args, ++index, '--case'));
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
      case '--companion-shape-projection':
        companionShapeProjection = resolvePath(requireNextArg(args, ++index, '--companion-shape-projection'));
        break;
      case '--timeout-ms': {
        const parsed = Number(requireNextArg(args, ++index, '--timeout-ms'));
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error('--timeout-ms must be a positive number');
        }
        timeoutMs = Math.floor(parsed);
        break;
      }
      case '--help':
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unsupported option: ${arg}`);
    }
  }

  return {
    targets,
    caseIds,
    outputDir,
    runId,
    live,
    ...(companionShapeProjection ? { companionShapeProjection } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

function printUsage(): void {
  console.log('Usage: npm run eval:llm-response -- [options]');
  console.log('');
  console.log('Collect generic LLM response artifacts. Fixture target is default and needs no secrets.');
  console.log('');
  console.log('Options:');
  console.log('  --target <provider:model>        Target to run. Providers: fixture, openrouter, deepseek. Repeatable.');
  console.log('  --case <id>                      Restrict to one canonical case. Repeatable.');
  console.log(`  --output-dir <path>              Artifact output directory (default: ${DEFAULT_OUTPUT_DIR})`);
  console.log('  --run-id <id>                    Stable run id for artifact filenames.');
  console.log('  --live                           Required for openrouter/deepseek targets.');
  console.log('  --timeout-ms <n>                 Provider request timeout.');
  console.log('  --companion-shape-projection <path>  Also write a simple companion-shape response set.');
  console.log('  --help                           Show this help.');
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

export async function runLlmResponseCli(args: string[]): Promise<void> {
  loadDotenv();
  const options = parseCliOptions(args);
  const artifact = await collectLlmResponses({
    runId: options.runId,
    targets: parseTargets(options.targets),
    cases: selectCases(options.caseIds),
    outputDir: options.outputDir,
    liveProvidersEnabled: options.live,
    timeoutMs: options.timeoutMs,
  });
  const artifactPath = writeLlmResponseArtifact(artifact, options.outputDir);

  if (options.companionShapeProjection) {
    mkdirSync(path.dirname(options.companionShapeProjection), { recursive: true });
    writeFileSync(
      options.companionShapeProjection,
      `${JSON.stringify(projectCompanionShapeResponseSet(artifact), null, 2)}\n`,
      'utf8',
    );
  }

  console.log(`Wrote ${artifact.responses.length} response entries to ${artifactPath}`);
  if (artifact.summary.failed > 0) {
    console.log(`Captured ${artifact.summary.failed} per-case failures without dropping coverage.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runLlmResponseCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
