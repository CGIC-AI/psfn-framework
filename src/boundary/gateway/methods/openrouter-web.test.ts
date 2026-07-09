import { describe, expect, it, vi } from 'vitest';
import {
  normalizeSearchMaxResults,
  openRouterWebFetch,
  openRouterWebSearch,
  type OpenRouterFetch,
  type OpenRouterWebBackend,
} from './openrouter-web.js';

const BACKEND: OpenRouterWebBackend = {
  apiBaseUrl: 'https://openrouter.example/api/v1',
  apiKey: 'test-key',
  model: 'test/model',
};

function jsonResponse(payload: unknown): Awaited<ReturnType<OpenRouterFetch>> {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(payload),
  };
}

function completion(content: unknown, annotations?: unknown): unknown {
  return {
    choices: [
      {
        message: {
          content,
          ...(annotations !== undefined ? { annotations } : {}),
        },
      },
    ],
  };
}

describe('openRouterWebFetch', () => {
  it('posts a web_fetch server tool to the chat/completions endpoint and returns content', async () => {
    const fetchMock = vi.fn<OpenRouterFetch>(async () =>
      jsonResponse(completion('PAGE BODY TEXT')));

    const result = await openRouterWebFetch(BACKEND, 'https://example.com/doc', 'focus hint', {
      fetch: fetchMock,
    });

    expect(result).toBe('PAGE BODY TEXT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.example/api/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body) as {
      model: string;
      tools: Array<{ type: string }>;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('test/model');
    expect(body.tools).toEqual([{ type: 'openrouter:web_fetch' }]);
    expect(body.messages.at(-1)?.content).toContain('https://example.com/doc');
    expect(body.messages.at(-1)?.content).toContain('focus hint');
  });

  it('fails closed on a non-2xx response (no swallowed error)', async () => {
    const fetchMock = vi.fn<OpenRouterFetch>(async () => ({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: async () => 'upstream boom',
    }));

    await expect(
      openRouterWebFetch(BACKEND, 'https://example.com', undefined, { fetch: fetchMock }),
    ).rejects.toThrow(/502 Bad Gateway/);
  });

  it('fails closed when the model returns empty content', async () => {
    const fetchMock = vi.fn<OpenRouterFetch>(async () => jsonResponse(completion('   ')));
    await expect(
      openRouterWebFetch(BACKEND, 'https://example.com', undefined, { fetch: fetchMock }),
    ).rejects.toThrow(/empty content/);
  });
});

describe('openRouterWebSearch', () => {
  it('posts a web_search server tool and returns content plus deduped citations', async () => {
    const fetchMock = vi.fn<OpenRouterFetch>(async () =>
      jsonResponse(completion('search summary', [
        { type: 'url_citation', url_citation: { url: 'https://a.example' } },
        { type: 'url_citation', url_citation: { url: 'https://b.example' } },
        { type: 'url_citation', url_citation: { url: 'https://a.example' } },
      ])));

    const result = await openRouterWebSearch(BACKEND, 'what is psfn', 3, { fetch: fetchMock });

    expect(result.content).toBe('search summary');
    expect(result.citations).toEqual(['https://a.example', 'https://b.example']);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as { tools: Array<{ type: string }> };
    expect(body.tools).toEqual([{ type: 'openrouter:web_search' }]);
  });

  it('returns empty citations when the response carries no annotations', async () => {
    const fetchMock = vi.fn<OpenRouterFetch>(async () => jsonResponse(completion('only text')));
    const result = await openRouterWebSearch(BACKEND, 'q', undefined, { fetch: fetchMock });
    expect(result.content).toBe('only text');
    expect(result.citations).toEqual([]);
  });

  it('fails closed when the response has no choices', async () => {
    const fetchMock = vi.fn<OpenRouterFetch>(async () => jsonResponse({ choices: [] }));
    await expect(
      openRouterWebSearch(BACKEND, 'q', undefined, { fetch: fetchMock }),
    ).rejects.toThrow(/no choices/);
  });
});

describe('normalizeSearchMaxResults', () => {
  it('clamps to [1, 10] and defaults non-numbers', () => {
    expect(normalizeSearchMaxResults(undefined)).toBe(5);
    expect(normalizeSearchMaxResults(0)).toBe(1);
    expect(normalizeSearchMaxResults(50)).toBe(10);
    expect(normalizeSearchMaxResults(3)).toBe(3);
  });
});
