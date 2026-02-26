import type { EmbeddingService } from '../agent/contracts.js';

export type EmbeddingProviderKind = 'ollama' | 'transformers' | 'api';

export interface EmbeddingRuntimeProvider extends EmbeddingService {
  readonly kind: EmbeddingProviderKind;
}

export interface EmbeddingConfig {
  ollamaUrl: string;
  model: string;
  dims: number;
}

export interface TransformersEmbeddingConfig {
  endpoint: string;
  model?: string;
  apiKey?: string;
  dims: number;
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
  endpoint: 'http://localhost:8080/embed',
  model: DEFAULT_EMBEDDING_CONFIG.model,
  apiKey: undefined,
  dims: DEFAULT_EMBEDDING_CONFIG.dims,
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

export class TransformersEmbeddingProvider extends HttpEmbeddingProvider {
  readonly kind = 'transformers' as const;
  private readonly config: TransformersEmbeddingConfig;

  constructor(config?: Partial<TransformersEmbeddingConfig>) {
    super();
    const merged = { ...DEFAULT_TRANSFORMERS_EMBEDDING_CONFIG, ...config };
    const model = merged.model?.trim();
    this.config = {
      endpoint: (merged.endpoint ?? DEFAULT_TRANSFORMERS_EMBEDDING_CONFIG.endpoint).trim(),
      model: model && model.length > 0 ? model : undefined,
      apiKey: merged.apiKey?.trim(),
      dims: merged.dims ?? DEFAULT_TRANSFORMERS_EMBEDDING_CONFIG.dims,
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

    const payload: Record<string, unknown> = {
      inputs: texts,
    };
    if (this.config.model) {
      payload.model = this.config.model;
    }

    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Transformers embedding error ${response.status}: ${body}`);
    }

    const json = await response.json() as unknown;
    return toFloat32Embeddings(json);
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
  const dims = parsePositiveInt(env.TRANSFORMERS_EMBEDDING_DIMS)
    ?? parsePositiveInt(env.EMBEDDING_DIMS);
  return new TransformersEmbeddingProvider({
    ...(env.TRANSFORMERS_EMBEDDING_URL ? { endpoint: env.TRANSFORMERS_EMBEDDING_URL } : {}),
    ...(
      env.TRANSFORMERS_EMBEDDING_MODEL || env.EMBEDDING_MODEL
        ? { model: env.TRANSFORMERS_EMBEDDING_MODEL ?? env.EMBEDDING_MODEL }
        : {}
    ),
    ...(env.TRANSFORMERS_API_KEY ? { apiKey: env.TRANSFORMERS_API_KEY } : {}),
    ...(dims ? { dims } : {}),
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
