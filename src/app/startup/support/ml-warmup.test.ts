import { describe, expect, it, vi } from 'vitest';
import { TextEmotionClassifier } from '../../../core/emotion/text-classifier.js';
import {
  createStartupTextEmotionClassifier,
  warmRuntimeMlServices,
} from './ml-warmup.js';

describe('runtime ML warmup', () => {
  it('fails closed when textEmotionModel is blank', () => {
    expect(() => createStartupTextEmotionClassifier({
      model: '   ',
      dtype: 'fp32',
    })).toThrow('textEmotionModel runtime setting is required');
  });

  it('fails closed when textEmotionDtype is missing', () => {
    expect(() => createStartupTextEmotionClassifier({
      model: 'SamLowe/roberta-base-go_emotions-onnx',
    })).toThrow('textEmotionDtype runtime setting is required');
  });

  it('preloads both text emotion and embeddings before startup completes', async () => {
    let resolveClassifier: (() => void) | null = null;
    let resolveEmbedding: (() => void) | null = null;
    const steps: string[] = [];
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };
    const textClassifier = {
      preload: vi.fn(async () => {
        steps.push('classifier:start');
        await new Promise<void>((resolve) => {
          resolveClassifier = () => {
            steps.push('classifier:end');
            resolve();
          };
        });
      }),
    } as unknown as TextEmotionClassifier;
    const embeddingService = {
      kind: 'ollama' as const,
      dims: 3,
      embedBatch: vi.fn(),
      embed: vi.fn(async () => {
        steps.push('embedding:start');
        await new Promise<void>((resolve) => {
          resolveEmbedding = () => {
            steps.push('embedding:end');
            resolve();
          };
        });
        return new Float32Array([1, 2, 3]);
      }),
    };

    const warmupPromise = warmRuntimeMlServices({
      textClassifier,
      embeddingService,
      textEmotionModel: 'SamLowe/roberta-base-go_emotions-onnx',
      logger,
    });

    await vi.waitFor(() => {
      expect(textClassifier.preload).toHaveBeenCalledTimes(1);
      expect(embeddingService.embed).toHaveBeenCalledTimes(1);
    });

    expect(steps).toEqual(['classifier:start', 'embedding:start']);

    resolveClassifier?.();
    resolveEmbedding?.();
    await warmupPromise;

    expect(logger.info).toHaveBeenNthCalledWith(
      1,
      'Pre-loading ML services',
      expect.objectContaining({
        textEmotionModel: 'SamLowe/roberta-base-go_emotions-onnx',
        embeddingProvider: 'ollama',
        embeddingDims: 3,
      }),
    );
    expect(logger.info).toHaveBeenNthCalledWith(
      2,
      'ML services warmed',
      expect.objectContaining({
        textEmotionModel: 'SamLowe/roberta-base-go_emotions-onnx',
      }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('surfaces preload failures as fatal startup errors', async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };
    const textClassifier = {
      preload: vi.fn().mockRejectedValue(new Error('classifier warmup failed')),
    } as unknown as TextEmotionClassifier;
    const embeddingService = {
      kind: 'ollama' as const,
      dims: 3,
      embedBatch: vi.fn(),
      embed: vi.fn().mockResolvedValue(new Float32Array([1, 2, 3])),
    };

    await expect(warmRuntimeMlServices({
      textClassifier,
      embeddingService,
      textEmotionModel: 'SamLowe/roberta-base-go_emotions-onnx',
      logger,
    })).rejects.toThrow('text emotion classifier warmup failed: classifier warmup failed');

    expect(logger.error).toHaveBeenCalledWith(
      'ML service preload failed',
      expect.objectContaining({
        error: 'text emotion classifier warmup failed: classifier warmup failed',
        textEmotionModel: 'SamLowe/roberta-base-go_emotions-onnx',
      }),
    );
  });

  it('does not swallow concurrent warmup failures when both services fail', async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };
    const textClassifier = {
      preload: vi.fn().mockRejectedValue(new Error('classifier warmup failed')),
    } as unknown as TextEmotionClassifier;
    const embeddingService = {
      kind: 'api' as const,
      dims: 1024,
      embedBatch: vi.fn(),
      embed: vi.fn().mockRejectedValue(new Error('gateway embeddings offline')),
    };

    await expect(warmRuntimeMlServices({
      textClassifier,
      embeddingService,
      textEmotionModel: 'SamLowe/roberta-base-go_emotions-onnx',
      logger,
    })).rejects.toThrow(
      'text emotion classifier warmup failed: classifier warmup failed; embedding provider startup warmup failed: gateway embeddings offline',
    );

    expect(logger.error).toHaveBeenCalledWith(
      'ML service preload failed',
      expect.objectContaining({
        error: 'text emotion classifier warmup failed: classifier warmup failed; embedding provider startup warmup failed: gateway embeddings offline',
        embeddingProvider: 'api',
      }),
    );
  });
});
