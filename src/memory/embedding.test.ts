import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmbeddingProvider,
  createEmbeddingProviderFromEnv,
} from './embedding.js';

const fetchMock = vi.fn();
const originalEnv = { ...process.env };

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

  it('keeps legacy EmbeddingProvider ollama behavior', async () => {
    fetchMock.mockResolvedValue(okJson({
      embeddings: [
        [1, 2],
        [3, 4],
      ],
    }));

    const provider = new EmbeddingProvider({
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

  it('selects transformers provider and sends transformer payload', async () => {
    process.env.EMBEDDING_PROVIDER = 'transformers';
    process.env.TRANSFORMERS_EMBEDDING_URL = 'http://localhost:8080/embed';
    process.env.TRANSFORMERS_EMBEDDING_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
    process.env.TRANSFORMERS_EMBEDDING_DIMS = '2';
    process.env.TRANSFORMERS_API_KEY = 'transformers-key';
    fetchMock.mockResolvedValue(okJson([
      [0.5, 0.6],
      [0.7, 0.8],
    ]));

    const provider = createEmbeddingProviderFromEnv();

    expect(provider.kind).toBe('transformers');
    expect(provider.dims).toBe(2);

    const vectors = await provider.embedBatch(['alpha', 'beta']);
    expect(vectors).toEqual([
      new Float32Array([0.5, 0.6]),
      new Float32Array([0.7, 0.8]),
    ]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8080/embed');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer transformers-key');
    expect(JSON.parse(String(init.body))).toEqual({
      inputs: ['alpha', 'beta'],
      model: 'sentence-transformers/all-MiniLM-L6-v2',
    });
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
});
