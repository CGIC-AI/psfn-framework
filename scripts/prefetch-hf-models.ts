import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import {
  DEFAULT_TRANSFORMERS_EMBEDDING_CONFIG,
  resolveProjectTransformersCacheDir,
  TransformersEmbeddingProvider,
} from '../src/memory/embedding.js';
import {
  TextEmotionClassifier,
  TEXT_EMOTION_MODEL_ID,
} from '../src/emotion/text-classifier.js';

interface PrefetchCliOptions {
  dryRun: boolean;
  cacheDir: string;
  embeddingModel: string;
  emotionModel: string | null;
}

function printUsage(): void {
  console.log('Usage: npm run prefetch:hf-models -- [options]');
  console.log('');
  console.log('Prefetches configured Hugging Face models into the local project models directory.');
  console.log('');
  console.log('Options:');
  console.log('  --dry-run                 Print resolved settings without downloading');
  console.log('  --cache-dir <path>        Override cache directory (default: ./models/transformers)');
  console.log('  --embedding-model <id>    Override embedding model id');
  console.log(`  --emotion-model <id>      Override emotion model id (default: ${TEXT_EMOTION_MODEL_ID})`);
  console.log('  --skip-emotion            Skip text emotion model prefetch');
  console.log('  --help                    Show this help');
}

function resolveOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function resolveConfiguredEmbeddingModel(env: NodeJS.ProcessEnv): string {
  return resolveOptionalString(env.TRANSFORMERS_MODEL)
    ?? resolveOptionalString(env.TRANSFORMERS_EMBEDDING_MODEL)
    ?? resolveOptionalString(env.EMBEDDING_MODEL)
    ?? DEFAULT_TRANSFORMERS_EMBEDDING_CONFIG.model;
}

function resolveConfiguredCacheDir(env: NodeJS.ProcessEnv): string {
  const configured = resolveOptionalString(env.TRANSFORMERS_CACHE_DIR);
  if (!configured) {
    return resolveProjectTransformersCacheDir();
  }
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(process.cwd(), configured);
}

function resolveOptionalHfToken(env: NodeJS.ProcessEnv): string | undefined {
  return resolveOptionalString(env.HF_TOKEN)
    ?? resolveOptionalString(env.HF_ACCESS_TOKEN)
    ?? resolveOptionalString(env.HUGGINGFACE_HUB_TOKEN)
    ?? resolveOptionalString(env.TRANSFORMERS_HF_TOKEN);
}

function parseCliOptions(args: string[], env: NodeJS.ProcessEnv): PrefetchCliOptions {
  let dryRun = false;
  let cacheDir = resolveConfiguredCacheDir(env);
  let embeddingModel = resolveConfiguredEmbeddingModel(env);
  let emotionModel: string | null = TEXT_EMOTION_MODEL_ID;

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
        printUsage();
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
  const options = parseCliOptions(process.argv.slice(2), process.env);
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
