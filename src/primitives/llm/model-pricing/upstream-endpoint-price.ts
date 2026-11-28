// ── Upstream endpoint price (lomm1) ──
// OpenRouter lists one price per serving endpoint of a model. The model's
// headline price on /models is the cheapest endpoint, which is often a
// third-party host with nothing in common with the route a slot actually uses.
// The price that applies to a slot is the one of the provider that serves it:
// the model's own vendor for a vendor route (Z.AI for z-ai/*), or the endpoint
// the slot names. This module reads /models/{id}/endpoints and selects it.

import { isRecord } from '../../../shared/utils/types.js';
import type { ModelUsageCostRates } from '../../../shared/telemetry/model-usage-accounting.js';

export interface CatalogPricingReference {
  catalogModel: string;
  /** Endpoint tag slug (`z-ai`) or full tag (`z-ai/fp8`). */
  upstreamProvider: string;
}

export type CompleteUsdRates = Required<Omit<ModelUsageCostRates, 'currency'>> & { currency: 'USD' };

export interface UpstreamEndpointPrice {
  endpointTag: string;
  rates: CompleteUsdRates;
  /** False when the endpoint lists no cache price, so cached tokens bill at the prompt rate. */
  cacheReadListed: boolean;
  cacheWriteListed: boolean;
}

export type UpstreamEndpointPriceFailure =
  | 'fetch_failed'
  | 'model_not_listed'
  | 'upstream_not_listed'
  | 'ambiguous_upstream'
  | 'invalid_price';

export type UpstreamEndpointPriceResult =
  | { ok: true; price: UpstreamEndpointPrice }
  | { ok: false; failure: UpstreamEndpointPriceFailure };

const TOKENS_PER_PRICE_UNIT = 1_000_000;

/** USD per token as listed ("0.0000014") to USD per million tokens, free of float noise. */
function perMillion(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const perToken = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(perToken) || perToken < 0) return Number.NaN;
  return Number((perToken * TOKENS_PER_PRICE_UNIT).toPrecision(12));
}

function endpointSlug(tag: string): string {
  return tag.split('/')[0] ?? tag;
}

function matchesUpstream(tag: string, upstreamProvider: string): boolean {
  const normalized = tag.trim().toLowerCase();
  return upstreamProvider.includes('/')
    ? normalized === upstreamProvider
    : endpointSlug(normalized) === upstreamProvider;
}

function endpointPrice(endpoint: Record<string, unknown>): UpstreamEndpointPriceResult {
  const pricing = isRecord(endpoint.pricing) ? endpoint.pricing : undefined;
  const input = perMillion(pricing?.prompt);
  const output = perMillion(pricing?.completion);
  const cacheRead = perMillion(pricing?.input_cache_read);
  const cacheWrite = perMillion(pricing?.input_cache_write);
  if (input === undefined || output === undefined
    || [input, output, cacheRead, cacheWrite].some(rate => rate !== undefined && Number.isNaN(rate))) {
    return { ok: false, failure: 'invalid_price' };
  }
  return {
    ok: true,
    price: {
      endpointTag: String(endpoint.tag),
      rates: {
        inputPer1MUsd: input,
        outputPer1MUsd: output,
        // An endpoint that lists no cache price gives no cache discount: its
        // cached and cache-written prompt tokens are billed as prompt tokens.
        cacheReadPer1MUsd: cacheRead ?? input,
        cacheWritePer1MUsd: cacheWrite ?? input,
        currency: 'USD',
      },
      cacheReadListed: cacheRead !== undefined,
      cacheWriteListed: cacheWrite !== undefined,
    },
  };
}

function sameRates(left: CompleteUsdRates, right: CompleteUsdRates): boolean {
  return left.inputPer1MUsd === right.inputPer1MUsd
    && left.outputPer1MUsd === right.outputPer1MUsd
    && left.cacheReadPer1MUsd === right.cacheReadPer1MUsd
    && left.cacheWritePer1MUsd === right.cacheWritePer1MUsd;
}

/**
 * Select the upstream provider's endpoint from a `/models/{id}/endpoints`
 * body. Several endpoints of the same vendor (regions, quantizations) are
 * accepted only when they agree on price; otherwise the slot must name the
 * full endpoint tag, and until it does its price is unknown.
 */
export function selectUpstreamEndpointPrice(
  body: unknown,
  reference: CatalogPricingReference,
): UpstreamEndpointPriceResult {
  const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
  const endpoints = Array.isArray(data?.endpoints) ? data.endpoints.filter(isRecord) : undefined;
  if (!endpoints || endpoints.length === 0) return { ok: false, failure: 'model_not_listed' };
  const upstream = reference.upstreamProvider.trim().toLowerCase();
  const tagged = endpoints.filter(endpoint => typeof endpoint.tag === 'string');
  // An endpoint whose whole tag is the named upstream (`openai`) is that
  // provider's standard tier, preferred over its variants (`openai/flex`).
  const exact = tagged.filter(endpoint => String(endpoint.tag).trim().toLowerCase() === upstream);
  const matches = exact.length > 0
    ? exact
    : tagged.filter(endpoint => matchesUpstream(String(endpoint.tag), upstream));
  if (matches.length === 0) return { ok: false, failure: 'upstream_not_listed' };
  const prices = matches.map(endpointPrice);
  const first = prices[0];
  if (!first?.ok) return first ?? { ok: false, failure: 'upstream_not_listed' };
  for (const candidate of prices.slice(1)) {
    if (!candidate.ok) return candidate;
    if (!sameRates(candidate.price.rates, first.price.rates)) return { ok: false, failure: 'ambiguous_upstream' };
  }
  return first;
}

/** `https://openrouter.ai/api/v1/models` + `z-ai/glm-5.3` → its endpoints listing. */
export function upstreamEndpointsUrl(modelsApiUrl: string, catalogModel: string): string {
  const base = modelsApiUrl.trim().replace(/\/+$/u, '');
  const path = catalogModel.split('/').map(segment => encodeURIComponent(segment)).join('/');
  return `${base}/${path}/endpoints`;
}

/** Fetch and select one slot's upstream price. The catalogue is public: no credential is sent. */
export async function fetchUpstreamEndpointPrice(
  fetchImpl: typeof fetch,
  modelsApiUrl: string,
  reference: CatalogPricingReference,
  signal?: AbortSignal,
): Promise<UpstreamEndpointPriceResult> {
  let response: Response;
  try {
    response = await fetchImpl(upstreamEndpointsUrl(modelsApiUrl, reference.catalogModel), {
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
  } catch {
    return { ok: false, failure: 'fetch_failed' };
  }
  if (response.status === 404) return { ok: false, failure: 'model_not_listed' };
  if (!response.ok) return { ok: false, failure: 'fetch_failed' };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, failure: 'fetch_failed' };
  }
  return selectUpstreamEndpointPrice(body, reference);
}
