import { mkdirSync } from 'node:fs';
import path from 'node:path';
import '../src/shared/utils/load-dotenv.js';
import {
  resolveProjectTransformersCacheDir,
  TransformersEmbeddingProvider,
} from '../src/faculties/memory/embedding.js';
import {
  TEXT_EMOTION_DTYPE_VALUES,
  TextEmotionClassifier,
  type TextEmotionDType,
} from '../src/core/emotion/text-classifier.js';
import { loadSettings } from '../src/system/settings/io.js';

interface PrefetchCliOptions {
  dryRun: boolean;
  cacheDir: string;
  embeddingModel: string;
  emotionModel: string | null;
  emotionDtype: TextEmotionDType;
}

interface PrefetchRuntimeDefaults {
  cacheDir: string;
  embeddingModel: string;
  emotionModel: string;
  emotionDtype: TextEmotionDType;
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
  console.log(`  --emotion-dtype <dtype>   Override emotion model dtype (default: ${defaults.emotionDtype})`);
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

function resolveOwnerFileDataDir(env: NodeJS.ProcessEnv): string {
  const dataDir = resolveOptionalString(env.SYSTEM_DATA_DIR)
    ?? resolveOptionalString(env.DATA_DIR)
    ?? './data';
  return dataDir;
}

function requireRuntimeSetting<T extends string>(value: T | undefined, field: string, dataDir: string): T {
  const normalized = resolveOptionalString(value);
  if (normalized) return normalized as T;
  throw new Error(`${field} is required in ${dataDir}/settings.json or via the corresponding CLI override`);
}

function parseTextEmotionDtype(value: string | undefined, field: string): TextEmotionDType {
  const normalized = resolveOptionalString(value);
  if (!normalized) {
    throw new Error(`${field} requires a non-empty value`);
  }
  if (!TEXT_EMOTION_DTYPE_VALUES.includes(normalized as TextEmotionDType)) {
    throw new Error(`${field} must be one of: ${TEXT_EMOTION_DTYPE_VALUES.join(', ')}`);
  }
  return normalized as TextEmotionDType;
}

function resolvePrefetchRuntimeDefaults(env: NodeJS.ProcessEnv): PrefetchRuntimeDefaults {
  const dataDir = resolveOwnerFileDataDir(env);
  const runtimeSettings = loadSettings(dataDir, {
    seedDir: resolveOptionalString(env.CONFIG_DIR),
  });
  return {
    cacheDir: resolveCacheDir(runtimeSettings.textEmotionCacheDir),
    embeddingModel: requireRuntimeSetting(runtimeSettings.transformersModel, 'transformersModel', dataDir),
    emotionModel: requireRuntimeSetting(runtimeSettings.textEmotionModel, 'textEmotionModel', dataDir),
    emotionDtype: requireRuntimeSetting(runtimeSettings.textEmotionDtype, 'textEmotionDtype', dataDir),
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
  let emotionDtype = runtimeDefaults.emotionDtype;

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
      case '--emotion-dtype': {
        emotionDtype = parseTextEmotionDtype(args[index + 1], '--emotion-dtype');
        index += 1;
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
    emotionDtype,
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
    dtype: options.emotionDtype,
  });
  await classifier.classify('prefetch emotion model');
}

async function main(): Promise<void> {
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
  if (options.emotionModel) {
    console.log(`[prefetch:hf-models] emotionDtype=${options.emotionDtype}`);
  }
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
