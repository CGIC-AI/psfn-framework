// ── Slot price resolution (lomm1) ──
// The single answer to "what does this slot cost right now, and why" for a
// models.json slot: LLM-client booking and admission, intake screener rows,
// historical budget repricing and the ICP cost breaker read it through
// model-budget.ts. Embedding rates read it once when the embedding provider is
// built. Jev decisions are priced by their own decision-backend setting.
//
// Order: a fresh catalogue price of the slot's upstream provider, then the
// owner's published-price `cost` from models.json, else unknown. The catalogue
// comes first because a hand-typed owner price goes stale silently (release
// pricing, protective placeholders), and the owner direction is that calls are
// booked at the model's current price. A stale catalogue price is not used:
// the slot falls back to its owner price or is unknown, and the refresher
// reports it.

import type {
  CanonicalProviderRegistry,
  ModelRegistryEntry,
  ModelRegistryPricingPolicy,
} from '../../../shared/contracts/runtime.js';
import type { ModelUsageCostRates } from '../../../shared/telemetry/model-usage-accounting.js';
import type { CatalogPricingReference, CompleteUsdRates } from './upstream-endpoint-price.js';

export type SlotPriceSource = 'catalog' | 'owner' | 'unknown';

export interface CatalogPriceQuote extends CatalogPricingReference {
  slotKey: string;
  endpointTag: string;
  rates: CompleteUsdRates;
  cacheReadListed: boolean;
  cacheWriteListed: boolean;
  fetchedAtMs: number;
}

export interface ResolvedSlotPrice {
  source: SlotPriceSource;
  /** Absent when unknown; owner rates may be partial (an unpriced bucket stays unknown). */
  rates?: ModelUsageCostRates;
  catalog?: Pick<CatalogPriceQuote, 'catalogModel' | 'upstreamProvider' | 'endpointTag' | 'fetchedAtMs'>;
  /** A catalogue reference exists but its quote is missing or too old to use. */
  catalogUnavailable?: 'missing' | 'stale';
}

/** Lookup of current catalogue prices; implemented by the gateway's price book. */
export interface ModelPriceBookPort {
  resolve(entry: ModelRegistryEntry, atMs: number): ResolvedSlotPrice;
}

const OPENROUTER_PROVIDER_TYPE = 'openrouter';
const MINUTE_MS = 60_000;

function isOpenRouterProvider(
  providerId: string,
  providerRegistry: CanonicalProviderRegistry | undefined,
): boolean {
  const normalized = providerId.trim().toLowerCase();
  const configured = providerRegistry?.providers.find(provider => provider.id.trim().toLowerCase() === normalized);
  return configured ? configured.type === OPENROUTER_PROVIDER_TYPE : normalized === OPENROUTER_PROVIDER_TYPE;
}

function authorSlug(catalogModel: string): string {
  return catalogModel.split('/')[0]?.trim().toLowerCase() ?? '';
}

/**
 * The catalogue model and upstream endpoint a slot is priced from, or none
 * when the slot has no catalogue identity (a local or private endpoint).
 */
export function resolveCatalogReference(
  entry: ModelRegistryEntry,
  providerRegistry: CanonicalProviderRegistry | undefined,
): CatalogPricingReference | undefined {
  const catalogModel = entry.pricing?.catalogModel
    ?? (isOpenRouterProvider(entry.identity.provider, providerRegistry)
      ? entry.identity.model.trim().replace(/^openrouter\//u, '')
      : undefined);
  if (!catalogModel || !catalogModel.includes('/')) return undefined;
  // The provider that serves the slot: the owner's explicit choice, else the
  // first provider the slot's OpenRouter routing pins, else the model vendor.
  const pinned = entry.routing?.providerOrder?.find(provider => provider.trim() !== '')?.trim().toLowerCase();
  return {
    catalogModel,
    upstreamProvider: entry.pricing?.upstreamProvider ?? pinned ?? authorSlug(catalogModel),
  };
}

/** An explicit zero rate is known pricing (a free route); only an absent or invalid rate is unknown. */
function toNonNegativeRate(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/** The owner's published-price `cost`, bucket by bucket; undefined when nothing usable is set. */
export function resolveOwnerCostRates(entry: ModelRegistryEntry): ModelUsageCostRates | undefined {
  if (!entry.cost) return undefined;
  const currency = typeof entry.cost.currency === 'string'
    ? entry.cost.currency.trim().toUpperCase()
    : 'USD';
  if (currency !== 'USD') return undefined;
  const rates: ModelUsageCostRates = { currency };
  const input = toNonNegativeRate(entry.cost.inputPer1MUsd);
  const output = toNonNegativeRate(entry.cost.outputPer1MUsd);
  const cacheRead = toNonNegativeRate(entry.cost.cacheReadPer1MUsd);
  const cacheWrite = toNonNegativeRate(entry.cost.cacheWritePer1MUsd);
  if (input !== undefined) rates.inputPer1MUsd = input;
  if (output !== undefined) rates.outputPer1MUsd = output;
  if (cacheRead !== undefined) rates.cacheReadPer1MUsd = cacheRead;
  if (cacheWrite !== undefined) rates.cacheWritePer1MUsd = cacheWrite;
  return Object.keys(rates).length > 1 ? rates : undefined;
}

function sameReference(quote: CatalogPriceQuote, reference: CatalogPricingReference): boolean {
  return quote.catalogModel === reference.catalogModel
    && quote.upstreamProvider === reference.upstreamProvider;
}

/** Pure resolution over one slot's quote; `atMs` is when the priced attempt started. */
export function resolveSlotPrice(input: {
  entry: ModelRegistryEntry;
  providerRegistry: CanonicalProviderRegistry | undefined;
  policy: ModelRegistryPricingPolicy | undefined;
  quote: CatalogPriceQuote | undefined;
  atMs: number;
}): ResolvedSlotPrice {
  const reference = input.policy?.catalogRefresh.enabled
    ? resolveCatalogReference(input.entry, input.providerRegistry)
    : undefined;
  let catalogUnavailable: ResolvedSlotPrice['catalogUnavailable'];
  if (reference && input.policy) {
    const quote = input.quote && sameReference(input.quote, reference) ? input.quote : undefined;
    const maxAgeMs = input.policy.catalogRefresh.maxAgeMinutes * MINUTE_MS;
    if (quote && input.atMs - quote.fetchedAtMs <= maxAgeMs) {
      return {
        source: 'catalog',
        rates: { ...quote.rates },
        catalog: {
          catalogModel: quote.catalogModel,
          upstreamProvider: quote.upstreamProvider,
          endpointTag: quote.endpointTag,
          fetchedAtMs: quote.fetchedAtMs,
        },
      };
    }
    catalogUnavailable = quote ? 'stale' : 'missing';
  }
  const owner = resolveOwnerCostRates(input.entry);
  if (owner) return { source: 'owner', rates: owner, ...(catalogUnavailable ? { catalogUnavailable } : {}) };
  return { source: 'unknown', ...(catalogUnavailable ? { catalogUnavailable } : {}) };
}
