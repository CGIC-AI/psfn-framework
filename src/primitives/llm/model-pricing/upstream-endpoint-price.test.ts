import { describe, expect, it } from 'vitest';
import {
  fetchUpstreamEndpointPrice,
  selectUpstreamEndpointPrice,
  upstreamEndpointsUrl,
} from './upstream-endpoint-price.js';

// Shape of OpenRouter's /models/{id}/endpoints listing; vendors and prices are invented.
function listing(endpoints: Array<{ tag: string; pricing: Record<string, string> }>) {
  return { data: { id: 'acme/model-7', endpoints } };
}

const VENDOR = { tag: 'acme/fp8', pricing: { prompt: '0.0000014', completion: '0.0000044', input_cache_read: '0.00000026' } };
const RESELLER = { tag: 'cheaphost/fp4', pricing: { prompt: '0.0000009', completion: '0.000003' } };

describe('upstream endpoint price (lomm1)', () => {
  it("selects the model vendor's endpoint, not the cheapest host", () => {
    const result = selectUpstreamEndpointPrice(
      listing([RESELLER, VENDOR]),
      { catalogModel: 'acme/model-7', upstreamProvider: 'acme' },
    );
    expect(result).toEqual({
      ok: true,
      price: {
        endpointTag: 'acme/fp8',
        rates: { inputPer1MUsd: 1.4, outputPer1MUsd: 4.4, cacheReadPer1MUsd: 0.26, cacheWritePer1MUsd: 1.4, currency: 'USD' },
        cacheReadListed: true,
        cacheWriteListed: false,
      },
    });
  });

  it('bills an unlisted cache price at the prompt rate, never as free', () => {
    const result = selectUpstreamEndpointPrice(
      listing([RESELLER]),
      { catalogModel: 'acme/model-7', upstreamProvider: 'cheaphost' },
    );
    expect(result.ok && result.price.rates).toMatchObject({ cacheReadPer1MUsd: 0.9, cacheWritePer1MUsd: 0.9 });
  });

  it('refuses a vendor whose endpoints disagree on price unless the slot names the full tag', () => {
    const second = { tag: 'acme/int4', pricing: { prompt: '0.000001', completion: '0.000004' } };
    expect(selectUpstreamEndpointPrice(
      listing([VENDOR, second]),
      { catalogModel: 'acme/model-7', upstreamProvider: 'acme' },
    )).toEqual({ ok: false, failure: 'ambiguous_upstream' });
    const named = selectUpstreamEndpointPrice(
      listing([VENDOR, second]),
      { catalogModel: 'acme/model-7', upstreamProvider: 'acme/int4' },
    );
    expect(named.ok && named.price.rates.inputPer1MUsd).toBe(1);
  });

  it("prefers the provider's standard endpoint over its tiered variants", () => {
    const flex = { tag: 'acme/flex', pricing: { prompt: '0.0000007', completion: '0.0000022' } };
    const standard = { tag: 'acme', pricing: { prompt: '0.0000014', completion: '0.0000044' } };
    const result = selectUpstreamEndpointPrice(
      listing([flex, standard]),
      { catalogModel: 'acme/model-7', upstreamProvider: 'acme' },
    );
    expect(result.ok && result.price.endpointTag).toBe('acme');
  });

  it('reports an absent upstream, an empty listing and a malformed price as failures', () => {
    const reference = { catalogModel: 'acme/model-7', upstreamProvider: 'acme' };
    expect(selectUpstreamEndpointPrice(listing([RESELLER]), reference)).toEqual({ ok: false, failure: 'upstream_not_listed' });
    expect(selectUpstreamEndpointPrice(listing([]), reference)).toEqual({ ok: false, failure: 'model_not_listed' });
    expect(selectUpstreamEndpointPrice(
      listing([{ tag: 'acme', pricing: { prompt: '-1', completion: '0.000004' } }]),
      reference,
    )).toEqual({ ok: false, failure: 'invalid_price' });
  });

  it('reads the public endpoints listing without a credential', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchStub: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), init });
      return new Response(JSON.stringify(listing([VENDOR])), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const result = await fetchUpstreamEndpointPrice(
      fetchStub,
      'https://catalog.example.test/api/v1/models/',
      { catalogModel: 'acme/model-7', upstreamProvider: 'acme' },
    );
    expect(result.ok).toBe(true);
    expect(seen[0]?.url).toBe('https://catalog.example.test/api/v1/models/acme/model-7/endpoints');
    expect(new Headers(seen[0]?.init?.headers).has('authorization')).toBe(false);
    expect(upstreamEndpointsUrl('https://x.test/models', 'acme/model 7')).toBe('https://x.test/models/acme/model%207/endpoints');
    await expect(fetchUpstreamEndpointPrice(
      async () => new Response('', { status: 404 }),
      'https://catalog.example.test/api/v1/models',
      { catalogModel: 'acme/gone', upstreamProvider: 'acme' },
    )).resolves.toEqual({ ok: false, failure: 'model_not_listed' });
    await expect(fetchUpstreamEndpointPrice(
      async () => { throw new Error('offline'); },
      'https://catalog.example.test/api/v1/models',
      { catalogModel: 'acme/model-7', upstreamProvider: 'acme' },
    )).resolves.toEqual({ ok: false, failure: 'fetch_failed' });
  });
});
