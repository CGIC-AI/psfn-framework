export interface TextEmotionClassification {
  label: string;
  score: number;
}

export type TextEmotionDType =
  | 'auto'
  | 'fp32'
  | 'fp16'
  | 'q8'
  | 'int8'
  | 'uint8'
  | 'q4'
  | 'bnb4'
  | 'q4f16';

export interface TextEmotionClassifierConfig {
  model?: string;
  cacheDir?: string;
  dtype?: TextEmotionDType;
  pipelineFactory?: TextEmotionPipelineFactory;
}

export interface TextEmotionPipelineFactoryConfig {
  model: string;
  cacheDir?: string;
  dtype: TextEmotionDType;
}

export type TextEmotionPipeline = (
  text: string,
  options: { top_k: number },
) => Promise<unknown>;

export type TextEmotionPipelineFactory = (
  config: TextEmotionPipelineFactoryConfig,
) => Promise<TextEmotionPipeline>;

export const TEXT_EMOTION_MODEL_ID = 'boltuix/bert-emotion';
export const TEXT_EMOTION_LABEL_COUNT = 13;

const DEFAULT_DTYPE: TextEmotionDType = 'fp32';

export class TextEmotionClassifier {
  private readonly model: string;
  private readonly cacheDir?: string;
  private readonly dtype: TextEmotionDType;
  private readonly pipelineFactory: TextEmotionPipelineFactory;
  private pipeline: TextEmotionPipeline | null = null;
  private initPromise: Promise<TextEmotionPipeline> | null = null;

  constructor(config: TextEmotionClassifierConfig = {}) {
    this.model = normalizeModel(config.model);
    this.cacheDir = normalizeOptionalString(config.cacheDir);
    this.dtype = normalizeDtype(config.dtype);
    this.pipelineFactory = config.pipelineFactory ?? defaultTextEmotionPipelineFactory;
  }

  async classify(text: string): Promise<TextEmotionClassification[]> {
    const normalizedText = normalizeInputText(text);
    const pipeline = await this.getPipeline();
    const rawOutput = await pipeline(normalizedText, { top_k: TEXT_EMOTION_LABEL_COUNT });
    return normalizeClassificationOutput(rawOutput);
  }

  private async getPipeline(): Promise<TextEmotionPipeline> {
    if (this.pipeline) return this.pipeline;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.pipelineFactory({
      model: this.model,
      cacheDir: this.cacheDir,
      dtype: this.dtype,
    }).then((pipeline) => {
      if (typeof pipeline !== 'function') {
        throw new Error('text emotion classifier pipeline factory must return a callable pipeline');
      }
      this.pipeline = pipeline;
      return pipeline;
    });

    try {
      return await this.initPromise;
    } catch (error) {
      this.initPromise = null;
      throw error;
    }
  }
}

let sharedTextEmotionClassifier: TextEmotionClassifier | null = null;

export function getSharedTextEmotionClassifier(): TextEmotionClassifier {
  if (!sharedTextEmotionClassifier) {
    sharedTextEmotionClassifier = new TextEmotionClassifier();
  }
  return sharedTextEmotionClassifier;
}

export function resetSharedTextEmotionClassifierForTests(): void {
  sharedTextEmotionClassifier = null;
}

export async function defaultTextEmotionPipelineFactory(
  config: TextEmotionPipelineFactoryConfig,
): Promise<TextEmotionPipeline> {
  const { pipeline, env } = await import('@huggingface/transformers');

  if (config.cacheDir) {
    env.cacheDir = config.cacheDir;
  }

  const classifier = await pipeline('text-classification', config.model, {
    dtype: config.dtype,
  });

  return classifier as unknown as TextEmotionPipeline;
}

function normalizeClassificationOutput(output: unknown): TextEmotionClassification[] {
  const rows = unwrapRows(output);
  if (rows.length !== TEXT_EMOTION_LABEL_COUNT) {
    throw new Error(
      `text emotion classifier expected ${TEXT_EMOTION_LABEL_COUNT} labels, received ${rows.length}`,
    );
  }

  return rows
    .map((row, index) => normalizeClassificationRow(row, index))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.label.localeCompare(right.label);
    });
}

function unwrapRows(output: unknown): unknown[] {
  if (!Array.isArray(output)) {
    throw new Error(
      `text emotion classifier returned non-array output: ${String(output)}`,
    );
  }

  if (output.length === 0) {
    return [];
  }

  const first = output[0];
  if (Array.isArray(first)) {
    if (output.length !== 1) {
      throw new Error(
        `text emotion classifier returned unexpected batch output size: ${output.length}`,
      );
    }
    return first;
  }

  return output;
}

function normalizeClassificationRow(
  value: unknown,
  index: number,
): TextEmotionClassification {
  if (!isRecord(value)) {
    throw new Error(`text emotion classifier row ${index} must be an object`);
  }

  const label = normalizeLabel(value.label);
  const score = normalizeScore(value.score, index);

  return { label, score };
}

function normalizeLabel(label: unknown): string {
  if (typeof label !== 'string') {
    throw new Error('text emotion classifier label must be a string');
  }

  const normalized = label.trim();
  if (normalized.length === 0) {
    throw new Error('text emotion classifier label must be non-empty');
  }

  return normalized;
}

function normalizeScore(score: unknown, index: number): number {
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new Error(`text emotion classifier score at row ${index} must be a finite number`);
  }

  if (score < 0 || score > 1) {
    throw new Error(`text emotion classifier score at row ${index} must be between 0 and 1`);
  }

  return score;
}

function normalizeModel(model: string | undefined): string {
  const normalized = model?.trim();
  return normalized && normalized.length > 0 ? normalized : TEXT_EMOTION_MODEL_ID;
}

function normalizeDtype(dtype: TextEmotionDType | undefined): TextEmotionDType {
  const normalized = dtype?.trim();
  if (!normalized) return DEFAULT_DTYPE;
  switch (normalized) {
    case 'auto':
    case 'fp32':
    case 'fp16':
    case 'q8':
    case 'int8':
    case 'uint8':
    case 'q4':
    case 'bnb4':
    case 'q4f16':
      return normalized;
    default:
      return DEFAULT_DTYPE;
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeInputText(text: string): string {
  if (typeof text !== 'string') {
    throw new TypeError(`text must be a string, received ${String(text)}`);
  }

  const normalized = text.trim();
  if (!normalized) {
    throw new RangeError('text must be a non-empty string');
  }

  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
