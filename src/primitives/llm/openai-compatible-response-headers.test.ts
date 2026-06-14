import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  latestCapturedProviderCostUsd,
  withOpenAICompatibleResponseHeaderCapture,
} from './openai-compatible-response-headers.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.stubGlobal('fetch', originalFetch);
});

describe('openai-compatible response header capture', () => {
  it('captures LiteLLM response cost headers for matching base URLs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', {
      status: 200,
      headers: {
        'x-litellm-response-cost': '0.123',
      },
    })));

    const { result, captures } = await withOpenAICompatibleResponseHeaderCapture(
      'http://litellm.test/v1',
      async () => {
        await fetch('http://litellm.test/v1/chat/completions');
        return 'done';
      },
    );

    expect(result).toBe('done');
    expect(captures).toHaveLength(1);
    expect(captures[0]?.providerCostUsd).toBe(0.123);
    expect(latestCapturedProviderCostUsd(captures)).toBe(0.123);
  });

  it('does not capture unrelated response headers outside the active base URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', {
      status: 200,
      headers: {
        'x-litellm-response-cost': '0.123',
      },
    })));

    const { captures } = await withOpenAICompatibleResponseHeaderCapture(
      'http://litellm.test/v1',
      async () => {
        await fetch('http://other.test/v1/chat/completions');
      },
    );

    expect(captures).toHaveLength(0);
  });
});
