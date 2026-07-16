import { afterEach, describe, expect, it, vi } from 'vitest';
import { countPromptTokens } from './prompts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prompt token-count endpoint', () => {
  it('returns backend counts for the exact supplied texts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ counts: [4, 8] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    await expect(countPromptTokens(['first', 'second'])).resolves.toEqual([4, 8]);
    expect(fetch).toHaveBeenCalledWith('/api/admin/prompts/count-tokens', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ texts: ['first', 'second'] }),
    }));
  });

  it.each([
    {},
    { counts: [1] },
    { counts: [1, -1] },
    { counts: [1, 1.5] },
  ])('fails closed on an invalid backend response (%j)', async payload => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    await expect(countPromptTokens(['first', 'second']))
      .rejects.toThrow('Invalid prompt token-count response');
  });
});
