import type { EmbeddingService } from '../agent/contracts.js';
import { createComponentLogger } from '../logger.js';

export type EmbeddingProviderKind = 'ollama' | 'transformers' | 'api';

/** Callable feature-extraction pipeline from @huggingface/transformers. */
interface FeatureExtractionPipelineType {
  (texts: string | string[], options?: { pooling?: string; normalize?: boolean }): Promise<{
    data: Float32Array;
    dims: number[];
  }>;
  dispose?(): Promise<void>;
}

export interface EmbeddingRuntimeProvider extends EmbeddingService {
  readonly kind: EmbeddingProviderKind;
}

export interface EmbeddingConfig {
  ollamaUrl: string;
  model: string;
  dims: number;
}

export interface TransformersEmbeddingConfig {
  model: string;
  dims: number;
  cacheDir?: string;
}

export interface ApiEmbeddingConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  dims: number;
}

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  ollamaUrl: 'http://purrsephone.local.vega.nyc:11434',
  model: 'snowflake-arctic-embed2',
  dims: 1024,
};

export const DEFAULT_TRANSFORMERS_EMBEDDING_CONFIG: TransformersEmbeddingConfig = {
  model: 'Xenova/all-MiniLM-L6-v2',
  dims: 384,
};

export const DEFAULT_API_EMBEDDING_CONFIG: ApiEmbeddingConfig = {
  endpoint: '',
  model: DEFAULT_EMBEDDING_CONFIG.model,
  apiKey: undefined,
  dims: DEFAULT_EMBEDDING_CONFIG.dims,
};

const DEFAULT_EMBEDDING_PROVIDER: EmbeddingProviderKind = 'ollama';

interface EmbedOptions {
  signal?: AbortSignal;
}

abstract class HttpEmbeddingProvider implements EmbeddingRuntimeProvider {
  abstract readonly kind: EmbeddingProviderKind;
  abstract readonly dims: number;

  async embed(text: string, options: EmbedOptions = {}): Promise<Float32Array> {
    const results = await this.embedBatch([text], options);
    return results[0];
  }

  async embedBatch(texts: string[], options: EmbedOptions = {}): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const embeddings = await this.embedInternal(texts, options);
    if (embeddings.length !== texts.length) {
      throw new Error(
        `${this.kind} embedding response count mismatch: expected ${texts.length}, got ${embeddings.length}`,
      );
    }
    return embeddings;
  }

  protected abstract embedInternal(texts: string[], options: EmbedOptions): Promise<Float32Array[]>;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function appendPath(baseUrl: string, suffix: string): string {
  const trimmedBase = baseUrl.trim().replace(/\/+$/g, '');
  const trimmedSuffix = suffix.replace(/^\/+/g, '');
  return `${trimmedBase}/${trimmedSuffix}`;
}

function asNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const vector: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      return null;
    }
    vector.push(item);
  }
  return vector;
}

function extractEmbeddings(value: unknown): number[][] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return [];

  const singleVector = asNumberArray(value);
  if (singleVector) return [singleVector];

  const rows: number[][] = [];
  for (const row of value) {
    const vector = asNumberArray(row);
    if (!vector) return null;
    rows.push(vector);
  }
  return rows;
}

function normalizeEmbeddingsPayload(payload: unknown): number[][] {
  const directEmbeddings = extractEmbeddings(payload);
  if (directEmbeddings) return directEmbeddings;

  if (!payload || typeof payload !== 'object') {
    throw new Error('Embedding response did not include embeddings');
  }

  const record = payload as Record<string, unknown>;

  const explicitEmbeddings = extractEmbeddings(record.embeddings);
  if (explicitEmbeddings) return explicitEmbeddings;

  if (Array.isArray(record.data)) {
    const vectors: number[][] = [];
    for (const item of record.data) {
      if (!item || typeof item !== 'object') {
        throw new Error('Embedding response contained invalid data entries');
      }
      const vector = asNumberArray((item as Record<string, unknown>).embedding);
      if (!vector) {
        throw new Error('Embedding response contained invalid embedding vectors');
      }
      vectors.push(vector);
    }
    return vectors;
  }

  throw new Error('Embedding response did not include embeddings');
}

function toFloat32Embeddings(payload: unknown): Float32Array[] {
  return normalizeEmbeddingsPayload(payload).map((vector) => new Float32Array(vector));
}

export class OllamaEmbeddingProvider extends HttpEmbeddingProvider {
  readonly kind = 'ollama' as const;
  private readonly config: EmbeddingConfig;

  constructor(config?: Partial<EmbeddingConfig>) {
    super();
    const merged = { ...DEFAULT_EMBEDDING_CONFIG, ...config };
    const model = (merged.model ?? DEFAULT_EMBEDDING_CONFIG.model).trim();
    this.config = {
      ollamaUrl: (merged.ollamaUrl ?? DEFAULT_EMBEDDING_CONFIG.ollamaUrl).trim(),
      model: model.length > 0 ? model : DEFAULT_EMBEDDING_CONFIG.model,
      dims: merged.dims ?? DEFAULT_EMBEDDING_CONFIG.dims,
    };
  }

  get dims(): number {
    return this.config.dims;
  }

  protected async embedInternal(texts: string[], options: EmbedOptions): Promise<Float32Array[]> {
    const url = appendPath(this.config.ollamaUrl, '/api/embed');

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        input: texts,
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama embedding error ${response.status}: ${body}`);
    }

    const payload = await response.json() as unknown;
    return toFloat32Embeddings(payload);
  }
}

/**
 * In-process embedding provider using @huggingface/transformers (ONNX Runtime).
 * Models are auto-downloaded on first use and cached to disk.
 * The pipeline is lazily initialized to avoid blocking startup.
 */
export class TransformersEmbeddingProvider implements EmbeddingRuntimeProvider {
  readonly kind = 'transformers' as const;
  private readonly config: TransformersEmbeddingConfig;
  private pipelineInstance: FeatureExtractionPipelineType | null = null;
  private initPromise: Promise<FeatureExtractionPipelineType> | null = null;
  private readonly log = createComponentLogger('TransformersEmbedding');

  constructor(config?: Partial<TransformersEmbeddingConfig>) {
    const merged = { ...DEFAULT_TRANSFORMERS_EMBEDDING_CONFIG, ...config };
    const model = (merged.model ?? DEFAULT_TRANSFORMERS_EMBEDDING_CONFIG.model).trim();
    this.config = {
      model: model.length > 0 ? model : DEFAULT_TRANSFORMERS_EMBEDDING_CONFIG.model,
      dims: merged.dims ?? DEFAULT_TRANSFORMERS_EMBEDDING_CONFIG.dims,
      cacheDir: merged.cacheDir?.trim() || undefined,
    };
  }

  get dims(): number {
    return this.config.dims;
  }

  private async getPipeline(): Promise<FeatureExtractionPipelineType> {
    if (this.pipelineInstance) return this.pipelineInstance;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      this.log.info(`Loading transformers.js model: ${this.config.model}`);
      const { pipeline, env } = await import('@huggingface/transformers');

      if (this.config.cacheDir) {
        env.cacheDir = this.config.cacheDir;
      }

      const extractor = await pipeline('feature-extraction', this.config.model, {
        dtype: 'fp32',
      });

      this.pipelineInstance = extractor as unknown as FeatureExtractionPipelineType;
      this.log.info(`Model loaded: ${this.config.model}`);
      return this.pipelineInstance;
    })();

    try {
      return await this.initPromise;
    } catch (err) {
      // Allow retry on next call if init fails
      this.initPromise = null;
      throw err;
    }
  }

  async embed(text: string, options: EmbedOptions = {}): Promise<Float32Array> {
    const results = await this.embedBatch([text], options);
    return results[0];
  }

  async embedBatch(texts: string[], options: EmbedOptions = {}): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    if (options.signal?.aborted) {
      throw new DOMException('Embedding aborted', 'AbortError');
    }

    const extractor = await this.getPipeline();

    const output = await extractor(texts, { pooling: 'mean', normalize: true });

    // output is a Tensor with shape [N, D] and data as a flat typed array
    const tensorData = output.data as Float32Array;
    const embeddingDim = output.dims[1];
    const count = output.dims[0];

    if (count !== texts.length) {
      throw new Error(
        `transformers embedding response count mismatch: expected ${texts.length}, got ${count}`,
      );
    }

    const results: Float32Array[] = [];
    for (let i = 0; i < count; i++) {
      results.push(new Float32Array(tensorData.buffer, tensorData.byteOffset + i * embeddingDim * 4, embeddingDim));
    }
    return results;
  }
}

export class ApiEmbeddingProvider extends HttpEmbeddingProvider {
  readonly kind = 'api' as const;
  private readonly config: ApiEmbeddingConfig;

  constructor(config?: Partial<ApiEmbeddingConfig>) {
    super();
    const merged = { ...DEFAULT_API_EMBEDDING_CONFIG, ...config };
    const endpoint = merged.endpoint?.trim();
    if (!endpoint) {
      throw new Error('EMBEDDING_API_URL must be set when EMBEDDING_PROVIDER=api');
    }
    const model = (merged.model ?? DEFAULT_API_EMBEDDING_CONFIG.model).trim();
    this.config = {
      endpoint,
      model: model.length > 0 ? model : DEFAULT_API_EMBEDDING_CONFIG.model,
      apiKey: merged.apiKey?.trim(),
      dims: merged.dims ?? DEFAULT_API_EMBEDDING_CONFIG.dims,
    };
  }

  get dims(): number {
    return this.config.dims;
  }

  protected async embedInternal(texts: string[], options: EmbedOptions): Promise<Float32Array[]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.config.model,
        input: texts,
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`API embedding error ${response.status}: ${body}`);
    }

    const json = await response.json() as unknown;
    return toFloat32Embeddings(json);
  }
}

function resolveEmbeddingProviderKind(
  value: string | undefined,
): EmbeddingProviderKind {
  if (!value || value.trim().length === 0) {
    return DEFAULT_EMBEDDING_PROVIDER;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'ollama' || normalized === 'transformers' || normalized === 'api') {
    return normalized;
  }
  throw new Error(
    `Unsupported EMBEDDING_PROVIDER "${value}". Expected one of: ollama, transformers, api.`,
  );
}

function resolveOllamaProvider(env: NodeJS.ProcessEnv): OllamaEmbeddingProvider {
  const dims = parsePositiveInt(env.EMBEDDING_DIMS);
  return new OllamaEmbeddingProvider({
    ...(env.OLLAMA_URL ? { ollamaUrl: env.OLLAMA_URL } : {}),
    ...(env.EMBEDDING_MODEL ? { model: env.EMBEDDING_MODEL } : {}),
    ...(dims ? { dims } : {}),
  });
}

function resolveTransformersProvider(env: NodeJS.ProcessEnv): TransformersEmbeddingProvider {
  const log = createComponentLogger('TransformersEmbedding');

  // Deprecation warnings for old HTTP-based env vars
  if (env.TRANSFORMERS_EMBEDDING_URL || env.TRANSFORMERS_API_KEY) {
    log.warn(
      'TRANSFORMERS_EMBEDDING_URL and TRANSFORMERS_API_KEY are deprecated. ' +
      'TransformersEmbeddingProvider now runs in-process via @huggingface/transformers. ' +
      'Use TRANSFORMERS_MODEL and TRANSFORMERS_CACHE_DIR instead.',
    );
  }

  const dims = parsePositiveInt(env.TRANSFORMERS_EMBEDDING_DIMS)
    ?? parsePositiveInt(env.EMBEDDING_DIMS);
  const model = env.TRANSFORMERS_MODEL
    ?? env.TRANSFORMERS_EMBEDDING_MODEL
    ?? env.EMBEDDING_MODEL;

  return new TransformersEmbeddingProvider({
    ...(model ? { model } : {}),
    ...(dims ? { dims } : {}),
    ...(env.TRANSFORMERS_CACHE_DIR ? { cacheDir: env.TRANSFORMERS_CACHE_DIR } : {}),
  });
}

function resolveApiProvider(env: NodeJS.ProcessEnv): ApiEmbeddingProvider {
  const endpoint = env.EMBEDDING_API_URL
    ?? (env.LITELLM_BASE_URL ? appendPath(env.LITELLM_BASE_URL, '/embeddings') : undefined);
  const dims = parsePositiveInt(env.EMBEDDING_API_DIMS)
    ?? parsePositiveInt(env.EMBEDDING_DIMS);
  const model = env.EMBEDDING_API_MODEL ?? env.EMBEDDING_MODEL;
  const apiKey = env.EMBEDDING_API_KEY ?? env.OPENAI_API_KEY ?? env.LITELLM_API_KEY;

  return new ApiEmbeddingProvider({
    ...(endpoint ? { endpoint } : {}),
    ...(model ? { model } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(dims ? { dims } : {}),
  });
}

export function createEmbeddingProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingRuntimeProvider {
  const provider = resolveEmbeddingProviderKind(env.EMBEDDING_PROVIDER);
  switch (provider) {
    case 'ollama':
      return resolveOllamaProvider(env);
    case 'transformers':
      return resolveTransformersProvider(env);
    case 'api':
      return resolveApiProvider(env);
  }
}

// Backward-compatible name for existing Ollama callers.
export class EmbeddingProvider extends OllamaEmbeddingProvider {}
