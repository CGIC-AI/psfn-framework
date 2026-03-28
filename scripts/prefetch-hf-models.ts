import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import {
  resolveProjectTransformersCacheDir,
  TransformersEmbeddingProvider,
} from '../src/memory/embedding.js';
import {
  TextEmotionClassifier,
} from '../src/emotion/text-classifier.js';
import { loadRuntimeSettingsSeedDefaults } from '../src/system/config/seed-defaults.js';

interface PrefetchCliOptions {
  dryRun: boolean;
  cacheDir: string;
  embeddingModel: string;
  emotionModel: string | null;
}

interface PrefetchRuntimeDefaults {
  cacheDir: string;
  embeddingModel: string;
  emotionModel: string;
}

function printUsage(defaults: PrefetchRuntimeDefaults): void {
  console.log('Usage: npm run prefetch:hf-models -- [options]');
  console.log('');
  console.log('Prefetches configured Hugging Face models into the local project models directory.');
  console.log('');
  console.log('Options:');
  console.log('  --dry-run                 Print resolved settings without downloading');
  console.log(`  --cache-dir <path>        Override cache directory (default: ${defaults.cacheDir})`);
  console.log(`  --embedding-model <id>    Override embedding model id (default: ${defaults.embeddingModel})`);
  console.log(`  --emotion-model <id>      Override emotion model id (default: ${defaults.emotionModel})`);
  console.log('  --skip-emotion            Skip text emotion model prefetch');
  console.log('  --help                    Show this help');
}

function resolveOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function resolveCacheDir(configuredCacheDir: string | undefined): string {
  const configured = resolveOptionalString(configuredCacheDir);
  if (!configured) {
    return resolveProjectTransformersCacheDir();
  }
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(process.cwd(), configured);
}

function resolvePrefetchRuntimeDefaults(env: NodeJS.ProcessEnv): PrefetchRuntimeDefaults {
  const runtimeDefaults = loadRuntimeSettingsSeedDefaults(resolveOptionalString(env.CONFIG_DIR));
  return {
    cacheDir: resolveCacheDir(runtimeDefaults.textEmotionCacheDir),
    embeddingModel: runtimeDefaults.transformersModel,
    emotionModel: runtimeDefaults.textEmotionModel,
  };
}

function resolveOptionalHfToken(env: NodeJS.ProcessEnv): string | undefined {
  return resolveOptionalString(env.HF_TOKEN)
    ?? resolveOptionalString(env.HF_ACCESS_TOKEN)
    ?? resolveOptionalString(env.HUGGINGFACE_HUB_TOKEN)
    ?? resolveOptionalString(env.TRANSFORMERS_HF_TOKEN);
}

function parseCliOptions(
  args: string[],
  runtimeDefaults: PrefetchRuntimeDefaults,
): PrefetchCliOptions {
  let dryRun = false;
  let cacheDir = runtimeDefaults.cacheDir;
  let embeddingModel = runtimeDefaults.embeddingModel;
  let emotionModel: string | null = runtimeDefaults.emotionModel;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--dry-run':
        dryRun = true;
        break;
      case '--skip-emotion':
        emotionModel = null;
        break;
      case '--cache-dir': {
        const value = args[index + 1];
        if (!value) {
          throw new Error('--cache-dir requires a value');
        }
        index += 1;
        cacheDir = path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
        break;
      }
      case '--embedding-model': {
        const value = resolveOptionalString(args[index + 1]);
        if (!value) {
          throw new Error('--embedding-model requires a non-empty value');
        }
        index += 1;
        embeddingModel = value;
        break;
      }
      case '--emotion-model': {
        const value = resolveOptionalString(args[index + 1]);
        if (!value) {
          throw new Error('--emotion-model requires a non-empty value');
        }
        index += 1;
        emotionModel = value;
        break;
      }
      case '--help':
        printUsage(runtimeDefaults);
        process.exit(0);
      default:
        throw new Error(`Unsupported option: ${arg}`);
    }
  }

  return {
    dryRun,
    cacheDir,
    embeddingModel,
    emotionModel,
  };
}

async function prefetchModels(options: PrefetchCliOptions, hfToken: string | undefined): Promise<void> {
  const embeddingProvider = new TransformersEmbeddingProvider({
    model: options.embeddingModel,
    cacheDir: options.cacheDir,
    ...(hfToken ? { hfToken } : {}),
  });

  await embeddingProvider.embed('prefetch embedding model');

  if (!options.emotionModel) {
    return;
  }

  const classifier = new TextEmotionClassifier({
    model: options.emotionModel,
    cacheDir: options.cacheDir,
  });
  await classifier.classify('prefetch emotion model');
}

async function main(): Promise<void> {
  loadDotenv();
  const runtimeDefaults = resolvePrefetchRuntimeDefaults(process.env);
  const options = parseCliOptions(process.argv.slice(2), runtimeDefaults);
  const hfToken = resolveOptionalHfToken(process.env);

  if (hfToken) {
    process.env.HF_TOKEN = hfToken;
  }

  mkdirSync(options.cacheDir, { recursive: true });

  console.log(`[prefetch:hf-models] cacheDir=${options.cacheDir}`);
  console.log(`[prefetch:hf-models] embeddingModel=${options.embeddingModel}`);
  console.log(`[prefetch:hf-models] emotionModel=${options.emotionModel ?? 'skipped'}`);
  console.log(`[prefetch:hf-models] authToken=${hfToken ? 'provided' : 'not provided'}`);

  if (options.dryRun) {
    console.log('[prefetch:hf-models] dry-run complete');
    return;
  }

  await prefetchModels(options, hfToken);
  console.log('[prefetch:hf-models] prefetch complete');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[prefetch:hf-models] failed: ${message}`);
  process.exit(1);
});
