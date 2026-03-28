import type { EmbeddingService } from '../../../agent/contracts.js';
import {
  TextEmotionClassifier,
  type TextEmotionClassifierConfig,
} from '../../../core/emotion/text-classifier.js';
import { warmupEmbeddingService } from '../../../memory/embedding.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';

const DEFAULT_WARMUP_TEXT = '__psfn_startup_ml_warmup__';

interface MlWarmupLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

interface RuntimeMlWarmupOptions {
  textClassifier: TextEmotionClassifier;
  embeddingService: EmbeddingService & { readonly kind?: string };
  textEmotionModel: string;
  logger: MlWarmupLogger;
  warmupText?: string;
}

type StartupTextEmotionConfig = Pick<
  TextEmotionClassifierConfig,
  'model' | 'cacheDir' | 'dtype'
>;

export function createStartupTextEmotionClassifier(
  config: Partial<StartupTextEmotionConfig>,
): TextEmotionClassifier {
  const textEmotionModel = config.model?.trim();
  if (!textEmotionModel) {
    throw new Error('textEmotionModel runtime setting is required');
  }
  if (config.dtype === undefined) {
    throw new Error('textEmotionDtype runtime setting is required');
  }

  return new TextEmotionClassifier({
    model: textEmotionModel,
    cacheDir: config.cacheDir,
    dtype: config.dtype,
  });
}

export async function warmRuntimeMlServices(options: RuntimeMlWarmupOptions): Promise<void> {
  const warmupText = options.warmupText?.trim() || DEFAULT_WARMUP_TEXT;
  const meta = {
    textEmotionModel: options.textEmotionModel,
    embeddingProvider: options.embeddingService.kind ?? 'unknown',
    embeddingDims: options.embeddingService.dims,
  };

  options.logger.info('Pre-loading ML services', meta);

  const results = await Promise.allSettled([
    options.textClassifier.preload(warmupText).catch((error) => {
      throw new Error(`text emotion classifier warmup failed: ${toErrorMessage(error)}`);
    }),
    warmupEmbeddingService(options.embeddingService, warmupText),
  ]);
  const failures = results.flatMap((result) => (
    result.status === 'rejected' ? [toErrorMessage(result.reason)] : []
  ));

  if (failures.length > 0) {
    const errorMessage = failures.join('; ');
    options.logger.error('ML service preload failed', {
      ...meta,
      error: errorMessage,
    });
    throw new Error(errorMessage);
  }

  options.logger.info('ML services warmed', meta);
}
