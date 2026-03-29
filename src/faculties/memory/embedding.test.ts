import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { createEnvCredentialVault } from '../../boundary/custody/credential-vault.js';
import {
  DEFAULT_PROJECT_TRANSFORMERS_CACHE_DIR,
  STARTUP_EMBEDDING_WARMUP_TEXT,
  OllamaEmbeddingProvider,
  TransformersEmbeddingProvider,
  createEmbeddingProviderFromConfig,
  createEmbeddingProviderFromEnv,
  warmupEmbeddingProvider,
} from './embedding.js';

const fetchMock = vi.fn();
const originalEnv = { ...process.env };

// Mock for @huggingface/transformers
const mockExtractor = vi.fn();
const mockPipeline = vi.fn();
const mockEnv = { cacheDir: './.cache' };

vi.mock('@huggingface/transformers', () => ({
  pipeline: (...args: unknown[]) => mockPipeline(...args),
  env: mockEnv,
}));

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function okJson(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

describe('embedding providers', () => {
  beforeEach(() => {
    restoreEnv();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    mockPipeline.mockReset();
    mockExtractor.mockReset();
    mockEnv.cacheDir = './.cache';
  });

  afterEach(() => {
    restoreEnv();
    vi.unstubAllGlobals();
  });

  it('defaults to ollama when EMBEDDING_PROVIDER is unset', async () => {
    delete process.env.EMBEDDING_PROVIDER;
    process.env.OLLAMA_URL = 'http://localhost:11434';
    process.env.EMBEDDING_MODEL = 'snowflake-arctic-embed2';
    process.env.EMBEDDING_DIMS = '3';
    fetchMock.mockResolvedValue(okJson({ embeddings: [[0.1, 0.2, 0.3]] }));

    const provider = createEmbeddingProviderFromEnv();

    expect(provider.kind).toBe('ollama');
    expect(provider.dims).toBe(3);

    const embedding = await provider.embed('hello world');
    expect(embedding).toEqual(new Float32Array([0.1, 0.2, 0.3]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/embed');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'snowflake-arctic-embed2',
      input: ['hello world'],
    });
  });

  it('OllamaEmbeddingProvider embeds with explicit config', async () => {
    fetchMock.mockResolvedValue(okJson({
      embeddings: [
        [1, 2],
        [3, 4],
      ],
    }));

    const provider = new OllamaEmbeddingProvider({
      ollamaUrl: 'http://ollama.local:11434',
      model: 'legacy-model',
      dims: 2,
    });

    const vectors = await provider.embedBatch(['one', 'two']);
    expect(vectors).toEqual([
      new Float32Array([1, 2]),
      new Float32Array([3, 4]),
    ]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ollama.local:11434/api/embed');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'legacy-model',
      input: ['one', 'two'],
    });
  });

  it('selects transformers provider and runs in-process inference', async () => {
    process.env.EMBEDDING_PROVIDER = 'transformers';
    process.env.TRANSFORMERS_MODEL = 'Xenova/all-MiniLM-L6-v2';
    process.env.TRANSFORMERS_EMBEDDING_DIMS = '2';

    // Mock pipeline: returns a callable extractor
    const tensorData = new Float32Array([0.5, 0.6, 0.7, 0.8]);
    mockExtractor.mockResolvedValue({
      data: tensorData,
      dims: [2, 2],
    });
    mockPipeline.mockResolvedValue(mockExtractor);

    const provider = createEmbeddingProviderFromEnv();

    expect(provider.kind).toBe('transformers');
    expect(provider.dims).toBe(2);

    const vectors = await provider.embedBatch(['alpha', 'beta']);
    expect(vectors[0]).toEqual(new Float32Array([0.5, 0.6]));
    expect(vectors[1]).toEqual(new Float32Array([0.7, 0.8]));

    // Should NOT have called fetch — this is in-process
    expect(fetchMock).not.toHaveBeenCalled();

    // Should have called pipeline() for initialization
    expect(mockPipeline).toHaveBeenCalledWith(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
      expect.objectContaining({ dtype: 'fp32' }),
    );

    // Should have called the extractor with pooling and normalize
    expect(mockExtractor).toHaveBeenCalledWith(
      ['alpha', 'beta'],
      { pooling: 'mean', normalize: true },
    );
  });

  it('copies transformer tensor rows so returned vectors are detached from backing buffer', async () => {
    process.env.EMBEDDING_PROVIDER = 'transformers';
    process.env.TRANSFORMERS_MODEL = 'Xenova/all-MiniLM-L6-v2';
    process.env.TRANSFORMERS_EMBEDDING_DIMS = '2';

    const tensorData = new Float32Array([0.5, 0.6, 0.7, 0.8]);
    mockExtractor.mockResolvedValue({
      data: tensorData,
      dims: [2, 2],
    });
    mockPipeline.mockResolvedValue(mockExtractor);

    const provider = createEmbeddingProviderFromEnv();
    const vectors = await provider.embedBatch(['alpha', 'beta']);

    tensorData[0] = 9.9;
    tensorData[2] = 8.8;

    expect(vectors[0]).toEqual(new Float32Array([0.5, 0.6]));
    expect(vectors[1]).toEqual(new Float32Array([0.7, 0.8]));
    expect(vectors[0].buffer).not.toBe(tensorData.buffer);
    expect(vectors[1].buffer).not.toBe(tensorData.buffer);
  });

  it('lazily initializes the pipeline on first embed call', async () => {
    const tensorData = new Float32Array([1, 2, 3]);
    mockExtractor.mockResolvedValue({
      data: tensorData,
      dims: [1, 3],
    });
    mockPipeline.mockResolvedValue(mockExtractor);

    const provider = new TransformersEmbeddingProvider({ model: 'test-model', dims: 3 });

    // Pipeline not created yet
    expect(mockPipeline).not.toHaveBeenCalled();

    // First call initializes
    await provider.embed('hello');
    expect(mockPipeline).toHaveBeenCalledTimes(1);

    // Second call reuses the cached pipeline
    await provider.embed('world');
    expect(mockPipeline).toHaveBeenCalledTimes(1);
    expect(mockExtractor).toHaveBeenCalledTimes(2);
  });

  it('uses TRANSFORMERS_MODEL env var for model name', async () => {
    process.env.EMBEDDING_PROVIDER = 'transformers';
    process.env.TRANSFORMERS_MODEL = 'custom/my-embedding-model';

    const tensorData = new Float32Array([1]);
    mockExtractor.mockResolvedValue({ data: tensorData, dims: [1, 1] });
    mockPipeline.mockResolvedValue(mockExtractor);

    const provider = createEmbeddingProviderFromEnv();
    await provider.embed('test');

    expect(mockPipeline).toHaveBeenCalledWith(
      'feature-extraction',
      'custom/my-embedding-model',
      expect.any(Object),
    );
  });

  it('sets cacheDir from TRANSFORMERS_CACHE_DIR env var', async () => {
    process.env.EMBEDDING_PROVIDER = 'transformers';
    process.env.TRANSFORMERS_CACHE_DIR = '/tmp/hf-cache';
    mockEnv.cacheDir = './.cache'; // Reset

    const tensorData = new Float32Array([1]);
    mockExtractor.mockResolvedValue({ data: tensorData, dims: [1, 1] });
    mockPipeline.mockResolvedValue(mockExtractor);

    const provider = createEmbeddingProviderFromEnv();
    await provider.embed('test');

    expect(mockEnv.cacheDir).toBe('/tmp/hf-cache');
  });

  it('defaults transformers cacheDir to the project-local models directory', async () => {
    process.env.EMBEDDING_PROVIDER = 'transformers';
    delete process.env.TRANSFORMERS_CACHE_DIR;
    mockEnv.cacheDir = './.cache';

    const tensorData = new Float32Array([1]);
    mockExtractor.mockResolvedValue({ data: tensorData, dims: [1, 1] });
    mockPipeline.mockResolvedValue(mockExtractor);

    const provider = createEmbeddingProviderFromEnv();
    await provider.embed('test');

    expect(mockEnv.cacheDir).toBe(DEFAULT_PROJECT_TRANSFORMERS_CACHE_DIR);
  });

  it('resolves relative TRANSFORMERS_CACHE_DIR to an absolute project-local path', async () => {
    process.env.EMBEDDING_PROVIDER = 'transformers';
    process.env.TRANSFORMERS_CACHE_DIR = 'models/custom-transformers-cache';
    mockEnv.cacheDir = './.cache';

    const tensorData = new Float32Array([1]);
    mockExtractor.mockResolvedValue({ data: tensorData, dims: [1, 1] });
    mockPipeline.mockResolvedValue(mockExtractor);

    const provider = createEmbeddingProviderFromEnv();
    await provider.embed('test');

    expect(mockEnv.cacheDir).toBe(path.resolve(process.cwd(), 'models/custom-transformers-cache'));
  });

  it('accepts HUGGINGFACE_HUB_TOKEN as an HF auth token alias', async () => {
    process.env.EMBEDDING_PROVIDER = 'transformers';
    delete process.env.HF_TOKEN;
    process.env.HUGGINGFACE_HUB_TOKEN = 'hf_alias_token';

    const tensorData = new Float32Array([1]);
    mockExtractor.mockResolvedValue({ data: tensorData, dims: [1, 1] });
    mockPipeline.mockResolvedValue(mockExtractor);

    const provider = createEmbeddingProviderFromEnv();
    await provider.embed('test');

    expect(process.env.HF_TOKEN).toBe('hf_alias_token');
  });

  it('returns empty array for empty batch', async () => {
    const provider = new TransformersEmbeddingProvider({ dims: 3 });
    const result = await provider.embedBatch([]);
    expect(result).toEqual([]);
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it('throws on AbortSignal already aborted', async () => {
    const provider = new TransformersEmbeddingProvider({ dims: 3 });
    const controller = new AbortController();
    controller.abort();

    await expect(provider.embed('test', { signal: controller.signal }))
      .rejects.toThrow('Embedding aborted');
  });

  it('selects api provider and parses openai-style responses', async () => {
    process.env.EMBEDDING_PROVIDER = 'api';
    process.env.EMBEDDING_API_URL = 'https://embeddings.example/v1/embeddings';
    process.env.EMBEDDING_API_MODEL = 'text-embedding-3-small';
    process.env.EMBEDDING_API_DIMS = '3';
    process.env.EMBEDDING_API_KEY = 'api-key';
    fetchMock.mockResolvedValue(okJson({
      data: [
        { index: 0, embedding: [1, 2, 3] },
        { index: 1, embedding: [4, 5, 6] },
      ],
    }));

    const provider = createEmbeddingProviderFromEnv();

    expect(provider.kind).toBe('api');
    expect(provider.dims).toBe(3);

    const vectors = await provider.embedBatch(['first', 'second']);
    expect(vectors).toEqual([
      new Float32Array([1, 2, 3]),
      new Float32Array([4, 5, 6]),
    ]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://embeddings.example/v1/embeddings');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer api-key');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'text-embedding-3-small',
      input: ['first', 'second'],
    });
  });

  it('derives api endpoint from LITELLM_BASE_URL when EMBEDDING_API_URL is unset', async () => {
    process.env.EMBEDDING_PROVIDER = 'api';
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    process.env.EMBEDDING_MODEL = 'snowflake-arctic-embed2';
    process.env.EMBEDDING_DIMS = '2';
    fetchMock.mockResolvedValue(okJson({ embeddings: [[9, 8]] }));

    const provider = createEmbeddingProviderFromEnv();

    expect(provider.kind).toBe('api');
    await provider.embed('litellm');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4000/v1/embeddings');
  });

  it('uses the credential vault for api embeddings loaded from runtime config', async () => {
    fetchMock.mockResolvedValue(okJson({ embeddings: [[9, 8]] }));

    const provider = createEmbeddingProviderFromConfig({
      embeddingProvider: 'api',
      embeddingApiUrl: 'https://embeddings.example/v1/embeddings',
      embeddingApiModel: 'text-embedding-3-small',
      embeddingApiDims: 2,
      credentialVault: createEnvCredentialVault({
        EMBEDDING_API_KEY: 'vault-api-key',
      }),
    });

    await provider.embed('vault-backed');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer vault-api-key');
  });

  it('throws for unsupported provider names', () => {
    process.env.EMBEDDING_PROVIDER = 'unknown-provider';
    expect(() => createEmbeddingProviderFromEnv()).toThrow(
      'Unsupported EMBEDDING_PROVIDER',
    );
  });

  it('requires EMBEDDING_API_URL for api provider when no fallback is available', () => {
    process.env.EMBEDDING_PROVIDER = 'api';
    delete process.env.EMBEDDING_API_URL;
    delete process.env.LITELLM_BASE_URL;

    expect(() => createEmbeddingProviderFromEnv()).toThrow(
      'EMBEDDING_API_URL must be set when EMBEDDING_PROVIDER=api',
    );
  });

  it('warms the embedding service with the startup probe text', async () => {
    const embeddingService = {
      dims: 3,
      embedBatch: vi.fn(),
      embed: vi.fn().mockResolvedValue(new Float32Array([1, 2, 3])),
    };

    await warmupEmbeddingProvider(embeddingService);

    expect(embeddingService.embed).toHaveBeenCalledWith(STARTUP_EMBEDDING_WARMUP_TEXT);
  });

  it('fails closed when warmup returns the wrong embedding dimensions', async () => {
    const embeddingService = {
      dims: 3,
      embedBatch: vi.fn(),
      embed: vi.fn().mockResolvedValue(new Float32Array([1, 2])),
    };

    await expect(warmupEmbeddingProvider(embeddingService)).rejects.toThrow(
      'embedding provider startup warmup failed: embedding warmup dimension mismatch: expected 3, got 2',
    );
  });
});
