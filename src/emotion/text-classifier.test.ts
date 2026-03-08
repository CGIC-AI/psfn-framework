import { describe, expect, it, vi } from 'vitest';
import {
  TEXT_EMOTION_LABEL_COUNT,
  TEXT_EMOTION_DTYPE_VALUES,
  TextEmotionClassifier,
  type TextEmotionClassification,
  type TextEmotionPipeline,
  type TextEmotionPipelineFactory,
} from './text-classifier.js';

const TEST_MODEL = 'cirimus/modernbert-base-go-emotions';

function sampleScores(): TextEmotionClassification[] {
  return [
    { label: 'neutral', score: 0.12 },
    { label: 'joy', score: 0.86 },
    { label: 'anger', score: 0.33 },
    { label: 'fear', score: 0.41 },
    { label: 'sadness', score: 0.22 },
    { label: 'surprise', score: 0.18 },
    { label: 'disgust', score: 0.41 },
    { label: 'love', score: 0.29 },
    { label: 'optimism', score: 0.36 },
    { label: 'pessimism', score: 0.13 },
    { label: 'trust', score: 0.25 },
    { label: 'anticipation', score: 0.3 },
    { label: 'confusion', score: 0.17 },
  ];
}

function sorted(scores: TextEmotionClassification[]): TextEmotionClassification[] {
  return [...scores].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.label.localeCompare(right.label);
  });
}

describe('TextEmotionClassifier', () => {
  it('lazily loads the model pipeline and returns sorted label scores', async () => {
    const pipeline: TextEmotionPipeline = vi.fn().mockResolvedValue([
      ...sampleScores(),
    ]);
    const pipelineFactory: TextEmotionPipelineFactory = vi.fn().mockResolvedValue(pipeline);
    const classifier = new TextEmotionClassifier({ model: TEST_MODEL, pipelineFactory });

    expect(pipelineFactory).not.toHaveBeenCalled();

    const result = await classifier.classify('  hello there  ');

    expect(pipelineFactory).toHaveBeenCalledTimes(1);
    expect(pipelineFactory).toHaveBeenCalledWith({
      model: TEST_MODEL,
      cacheDir: undefined,
      dtype: 'fp32',
    });
    expect(pipeline).toHaveBeenCalledWith('hello there', { top_k: TEXT_EMOTION_LABEL_COUNT });

    expect(result).toHaveLength(TEXT_EMOTION_LABEL_COUNT);
    expect(result).toEqual(sorted(sampleScores()));
    expect(Object.keys(result[0])).toEqual(['label', 'score']);
    expect(result.filter((entry) => entry.score === 0.41).map((entry) => entry.label))
      .toEqual(['disgust', 'fear']);
  });

  it('reuses one initialized model pipeline across classify calls', async () => {
    const pipeline: TextEmotionPipeline = vi.fn().mockResolvedValue(sampleScores());
    const pipelineFactory: TextEmotionPipelineFactory = vi.fn().mockResolvedValue(pipeline);
    const classifier = new TextEmotionClassifier({ model: TEST_MODEL, pipelineFactory });

    await classifier.classify('first');
    await classifier.classify('second');

    expect(pipelineFactory).toHaveBeenCalledTimes(1);
    expect(pipeline).toHaveBeenCalledTimes(2);
  });

  it('retries lazy initialization after a load failure', async () => {
    const pipeline: TextEmotionPipeline = vi.fn().mockResolvedValue(sampleScores());
    const pipelineFactory: TextEmotionPipelineFactory = vi.fn()
      .mockRejectedValueOnce(new Error('load failed'))
      .mockResolvedValueOnce(pipeline);
    const classifier = new TextEmotionClassifier({ model: TEST_MODEL, pipelineFactory });

    await expect(classifier.classify('first')).rejects.toThrow('load failed');
    await expect(classifier.classify('second')).resolves.toEqual(sorted(sampleScores()));

    expect(pipelineFactory).toHaveBeenCalledTimes(2);
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it('throws when pipeline output does not contain all expected emotion labels', async () => {
    const malformedOutput = [{ label: 'joy', score: 0.9 }];
    const pipeline: TextEmotionPipeline = vi.fn().mockResolvedValue(malformedOutput);
    const pipelineFactory: TextEmotionPipelineFactory = vi.fn().mockResolvedValue(pipeline);
    const classifier = new TextEmotionClassifier({ model: TEST_MODEL, pipelineFactory });

    await expect(classifier.classify('message')).rejects.toThrow(
      `text emotion classifier expected ${TEXT_EMOTION_LABEL_COUNT} labels, received 1`,
    );
  });

  it('throws for empty input text', async () => {
    const pipeline: TextEmotionPipeline = vi.fn();
    const pipelineFactory: TextEmotionPipelineFactory = vi.fn().mockResolvedValue(pipeline);
    const classifier = new TextEmotionClassifier({ model: TEST_MODEL, pipelineFactory });

    await expect(classifier.classify('   ')).rejects.toThrow('text must be a non-empty string');
    expect(pipelineFactory).not.toHaveBeenCalled();
  });

  it('fails closed when model is missing', () => {
    expect(() => new TextEmotionClassifier({
      model: '   ',
      pipelineFactory: vi.fn(),
    })).toThrow('text emotion classifier model must be a non-empty string');
  });

  it('fails closed when dtype is unsupported', () => {
    const unsupportedDtype = 'not-a-dtype';
    expect(TEXT_EMOTION_DTYPE_VALUES).not.toContain(
      unsupportedDtype as unknown as typeof TEXT_EMOTION_DTYPE_VALUES[number],
    );
    expect(() => new TextEmotionClassifier({
      model: TEST_MODEL,
      dtype: unsupportedDtype as unknown as typeof TEXT_EMOTION_DTYPE_VALUES[number],
      pipelineFactory: vi.fn(),
    })).toThrow('unsupported text emotion classifier dtype');
  });
});
