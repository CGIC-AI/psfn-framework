import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import {
  DEFAULT_OPENROUTER_API_BASE_URL,
  TARGET_MODELS,
  discoverOpenRouterLogprobSupport,
  type ProbeMode,
  type TargetModel,
} from './openrouter-logprob-discovery.js';

interface CliOptions {
  apiBaseUrl: string;
  outputPath: string;
  probeMode: ProbeMode;
  targets: TargetModel[];
}

function printUsage(): void {
  console.log('Usage: npm run eval:discover:logprobs -- [options]');
  console.log('');
  console.log('Build an OpenRouter logprob support table for the bead target models.');
  console.log('');
  console.log('Options:');
  console.log(`  --api-base-url <url>      Override API base URL (default: ${DEFAULT_OPENROUTER_API_BASE_URL})`);
  console.log('  --output <path>           Output JSON path (default: eval/discovery/logprob-support.json)');
  console.log('  --probe-mode <mode>       Probe mode: none, ambiguous, supported (default: ambiguous)');
  console.log('  --model <id>              Restrict to a specific model id (repeatable)');
  console.log('  --help                    Show this help');
  console.log('');
  console.log('Notes:');
  console.log('  - GET /models and /models/:id/endpoints are used for the zero-cost first pass.');
  console.log('  - Live POST probes only run when OPENROUTER_API_KEY is available and probe mode allows it.');
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function resolveOutputPath(value: string | undefined): string {
  const configured = normalizeOptionalString(value) ?? 'eval/discovery/logprob-support.json';
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(process.cwd(), configured);
}

function resolveProbeMode(value: string | undefined): ProbeMode {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) return 'ambiguous';
  if (normalized === 'none' || normalized === 'ambiguous' || normalized === 'supported') {
    return normalized;
  }
  throw new Error(`Unsupported probe mode: ${value}`);
}

function resolveTargets(selectedModelIds: string[]): TargetModel[] {
  if (selectedModelIds.length === 0) {
    return [...TARGET_MODELS];
  }

  const targetMap = new Map(TARGET_MODELS.map((target) => [target.id, target] as const));
  return selectedModelIds.map((modelId) => {
    const existing = targetMap.get(modelId);
    return existing ?? { id: modelId, group: 'additional' };
  });
}

function parseCliOptions(args: string[]): CliOptions {
  let apiBaseUrl = DEFAULT_OPENROUTER_API_BASE_URL;
  let outputPath = resolveOutputPath(undefined);
  let probeMode: ProbeMode = 'ambiguous';
  const selectedModels: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--api-base-url': {
        const value = normalizeOptionalString(args[index + 1]);
        if (!value) {
          throw new Error('--api-base-url requires a non-empty value');
        }
        index += 1;
        apiBaseUrl = value;
        break;
      }
      case '--output': {
        const value = normalizeOptionalString(args[index + 1]);
        if (!value) {
          throw new Error('--output requires a non-empty value');
        }
        index += 1;
        outputPath = resolveOutputPath(value);
        break;
      }
      case '--probe-mode': {
        const value = normalizeOptionalString(args[index + 1]);
        if (!value) {
          throw new Error('--probe-mode requires a value');
        }
        index += 1;
        probeMode = resolveProbeMode(value);
        break;
      }
      case '--model': {
        const value = normalizeOptionalString(args[index + 1]);
        if (!value) {
          throw new Error('--model requires a value');
        }
        index += 1;
        selectedModels.push(value);
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
    apiBaseUrl,
    outputPath,
    probeMode,
    targets: resolveTargets(selectedModels),
  };
}

async function main(): Promise<void> {
  loadDotenv();
  const options = parseCliOptions(process.argv.slice(2));
  const apiKey = normalizeOptionalString(process.env.OPENROUTER_API_KEY);

  console.log(`[eval:discover:logprobs] targets=${options.targets.length}`);
  console.log(`[eval:discover:logprobs] probeMode=${options.probeMode}`);
  console.log(`[eval:discover:logprobs] apiKey=${apiKey ? 'provided' : 'not provided'}`);

  const result = await discoverOpenRouterLogprobSupport({
    apiBaseUrl: options.apiBaseUrl,
    apiKey,
    probeMode: options.probeMode,
    targets: options.targets,
  });

  mkdirSync(path.dirname(options.outputPath), { recursive: true });
  writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  const supportedModels = Object.values(result.models).filter((record) => record.supported).length;
  const supportedProviders = Object.values(result.models)
    .flatMap((record) => record.providers)
    .filter((provider) => provider.logprobs).length;

  console.log(`[eval:discover:logprobs] supportedModels=${supportedModels}/${result.targets.length}`);
  console.log(`[eval:discover:logprobs] supportedProviders=${supportedProviders}`);
  console.log(`[eval:discover:logprobs] output=${options.outputPath}`);

  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.warn(`[eval:discover:logprobs] warning: ${warning}`);
    }
  }
  if (result.missingModels.length > 0) {
    for (const modelId of result.missingModels) {
      console.warn(`[eval:discover:logprobs] missing-model: ${modelId}`);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[eval:discover:logprobs] failed: ${message}`);
  process.exit(1);
});
