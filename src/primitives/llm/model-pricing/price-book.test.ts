import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HealthEvent, HealthEventPublisher } from '../../../shared/contracts/health-event.js';
import type {
  CanonicalModelRegistry,
  CanonicalProviderRegistry,
  ModelRegistryEntry,
} from '../../../shared/contracts/runtime.js';
import { ModelPriceBook } from './price-book.js';

const CATALOG_URL = 'https://catalog.example.test/api/v1/models';
const MINUTE_MS = 60_000;

const providerRegistry: CanonicalProviderRegistry = {
  schemaVersion: 1,
  providers: [
    { id: 'openrouter', type: 'openrouter', enabled: true, modelsApiUrl: CATALOG_URL },
    { id: 'acme-plan', type: 'generic_openai', enabled: true, apiBaseUrl: 'https://plan.example.test/v1' },
  ],
};

function entry(id: string, overrides: Partial<ModelRegistryEntry> = {}): ModelRegistryEntry {
  return {
    id,
    rank: 10,
    identity: { provider: 'openrouter', model: 'acme/model-7', source: { type: 'openrouter' } },
    purposes: [{ purpose: 'chat', primary: true }],
    capabilities: { maxOutputTokens: 1024, contextWindow: 128_000 },
    ...overrides,
  } as ModelRegistryEntry;
}

function registry(models: ModelRegistryEntry[], intervalMinutes = 30, maxAgeMinutes = 120): CanonicalModelRegistry {
  return {
    schemaVersion: 1,
    pricing: { catalogRefresh: { enabled: true, intervalMinutes, maxAgeMinutes } },
    models,
  } as CanonicalModelRegistry;
}

function vendorListing(prompt = '0.0000014') {
  return {
    data: {
      endpoints: [
        { tag: 'cheaphost', pricing: { prompt: '0.0000001', completion: '0.0000001' } },
        { tag: 'acme/fp8', pricing: { prompt, completion: '0.0000044', input_cache_read: '0.00000026' } },
      ],
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function healthSink(): HealthEventPublisher & { events: HealthEvent[] } {
  const events: HealthEvent[] = [];
  return {
    events,
    emit: async (_name, data) => { events.push(data.event); },
  };
}

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('model price book (lomm1)', () => {
  it("prices a routed slot at its vendor's catalogue price over a stale owner price, and says so", async () => {
    let nowMs = 1_000_000;
    const config = {
      providerRegistry,
      modelRegistry: registry([entry('glm', {
        cost: { inputPer1MUsd: 3, outputPer1MUsd: 15, cacheReadPer1MUsd: 3, cacheWritePer1MUsd: 3.75, currency: 'USD' },
      })]),
    };
    const book = new ModelPriceBook({ config, fetch: async () => jsonResponse(vendorListing()), now: () => nowMs });
    const slot = config.modelRegistry.models[0]!;
    expect(book.resolve(slot, nowMs)).toMatchObject({ source: 'owner', catalogUnavailable: 'missing' });

    await book.refresh();
    expect(book.resolve(slot, nowMs)).toEqual({
      source: 'catalog',
      rates: { inputPer1MUsd: 1.4, outputPer1MUsd: 4.4, cacheReadPer1MUsd: 0.26, cacheWritePer1MUsd: 1.4, currency: 'USD' },
      catalog: { catalogModel: 'acme/model-7', upstreamProvider: 'acme', endpointTag: 'acme/fp8', fetchedAtMs: 1_000_000 },
    });
    expect(book.status()[0]).toMatchObject({
      slotKey: 'glm',
      source: 'catalog',
      endpointTag: 'acme/fp8',
      fetchedAtMs: 1_000_000,
      // The owner price disagrees with the vendor's: the vendor's is booked, and the status says so.
      ownerPriceDiffers: { owner: { inputPer1MUsd: 3, outputPer1MUsd: 15 } },
    });

    // Past maxAgeMinutes the quote is not used: back to the owner price, flagged stale.
    nowMs += 121 * MINUTE_MS;
    expect(book.resolve(slot, nowMs)).toMatchObject({ source: 'owner', catalogUnavailable: 'stale' });
  });

  it('prices a direct provider slot from the catalogue only when the owner names its catalogue model', async () => {
    const plan = entry('plan', { identity: { provider: 'acme-plan', model: 'model-7', source: { type: 'configured' } } });
    const named = entry('plan-named', {
      identity: { provider: 'acme-plan', model: 'model-7', source: { type: 'configured' } },
      pricing: { catalogModel: 'acme/model-7' },
    });
    const fetchStub = vi.fn(async () => jsonResponse(vendorListing()));
    const book = new ModelPriceBook({ config: { providerRegistry, modelRegistry: registry([plan, named]) }, fetch: fetchStub });
    const summary = await book.refresh();
    expect(summary).toMatchObject({ attempted: 1, refreshed: 1, unknown: 1 });
    expect(book.resolve(named, Date.now()).source).toBe('catalog');
    expect(book.resolve(plan, Date.now()).source).toBe('unknown');
  });

  it('prices an OpenRouter slot pinned to a host by its routing at that host, unless the owner names another', async () => {
    const pinned = entry('pinned', { routing: { providerOrder: ['CheapHost'] } });
    const named = entry('named', { routing: { providerOrder: ['cheaphost'] }, pricing: { upstreamProvider: 'acme' } });
    const book = new ModelPriceBook({
      config: { providerRegistry, modelRegistry: registry([pinned, named]) },
      fetch: async () => jsonResponse(vendorListing()),
    });
    await book.refresh();
    expect(book.resolve(pinned, Date.now())).toMatchObject({ source: 'catalog', catalog: { endpointTag: 'cheaphost' } });
    expect(book.resolve(named, Date.now())).toMatchObject({ source: 'catalog', catalog: { endpointTag: 'acme/fp8' } });
  });

  it('reports a slot it cannot price as a refresh failure and an unknown price on the health plane', async () => {
    const health = healthSink();
    const book = new ModelPriceBook({
      config: { providerRegistry, modelRegistry: registry([entry('orphan', { pricing: { upstreamProvider: 'nobody' } })]) },
      fetch: async () => jsonResponse(vendorListing()),
    });
    expect(await book.refresh(health)).toMatchObject({ attempted: 1, failed: 1, unknown: 1 });
    expect(health.events.map(event => [event.code, event.provenance.component, event.severity])).toEqual([
      ['model_price_refresh_failed', 'model_pricing', 'warning'],
      ['model_price_unknown', 'model_pricing', 'degraded'],
    ]);
    expect(health.events[1]?.evidence).toEqual({ priceStale: false });
    expect(book.status()[0]).toMatchObject({ source: 'unknown', lastFailure: 'upstream_not_listed', catalogUnavailable: 'missing' });
  });

  it('refreshes on the owner-file cadence, re-read on every cycle', async () => {
    vi.useFakeTimers();
    const fetchStub = vi.fn(async () => jsonResponse(vendorListing()));
    const config = { providerRegistry, modelRegistry: registry([entry('glm')], 30) };
    const book = new ModelPriceBook({ config, fetch: fetchStub });
    book.start(healthSink());
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    expect(fetchStub).toHaveBeenCalledTimes(2);

    config.modelRegistry = registry([entry('glm')], 5);
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    expect(fetchStub).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
    expect(fetchStub).toHaveBeenCalledTimes(4);
    // A models.json reload refreshes at once and keeps a single cadence.
    book.restart(healthSink());
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchStub).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
    expect(fetchStub).toHaveBeenCalledTimes(6);
    book.stop();
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(fetchStub).toHaveBeenCalledTimes(6);
  });

  it('without an owner refresh policy keeps owner prices, never reads the catalogue, and still reports unpriced slots', async () => {
    const health = healthSink();
    const fetchStub = vi.fn(async () => jsonResponse(vendorListing()));
    const modelRegistry = { schemaVersion: 1, models: [entry('glm'), entry('priced', { cost: { inputPer1MUsd: 2, outputPer1MUsd: 8, currency: 'USD' } })] } as CanonicalModelRegistry;
    const book = new ModelPriceBook({ config: { providerRegistry, modelRegistry }, fetch: fetchStub });
    expect(await book.refresh(health)).toMatchObject({ attempted: 0, unknown: 1 });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(health.events.map(event => event.code)).toEqual(['model_price_unknown']);
    expect(book.resolve(modelRegistry.models[1]!, Date.now()).source).toBe('owner');
  });

  it('keeps the last good quote across a restart and replaces it on the next good refresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-price-book-'));
    dirs.push(dir);
    const snapshotPath = join(dir, 'model-price-snapshot.json');
    const config = { providerRegistry, modelRegistry: registry([entry('glm')]) };
    const first = new ModelPriceBook({ config, snapshotPath, fetch: async () => jsonResponse(vendorListing()), now: () => 5_000 });
    await first.refresh();
    expect(JSON.parse(readFileSync(snapshotPath, 'utf8'))).toMatchObject({ schemaVersion: 1, quotes: [{ slotKey: 'glm', fetchedAtMs: 5_000 }] });

    const restarted = new ModelPriceBook({ config, snapshotPath, fetch: async () => { throw new Error('offline'); }, now: () => 6_000 });
    expect(restarted.resolve(config.modelRegistry.models[0]!, 6_000)).toMatchObject({ source: 'catalog', catalog: { fetchedAtMs: 5_000 } });
    await restarted.refresh();
    expect(restarted.status()[0]).toMatchObject({ source: 'catalog', fetchedAtMs: 5_000, lastFailure: 'fetch_failed', lastAttemptAtMs: 6_000 });

    const repriced = new ModelPriceBook({ config, snapshotPath, fetch: async () => jsonResponse(vendorListing('0.000001')), now: () => 7_000 });
    await repriced.refresh();
    expect(repriced.resolve(config.modelRegistry.models[0]!, 7_000).rates?.inputPer1MUsd).toBe(1);
  });

  it('does not read the catalogue when the owner turned refresh off', async () => {
    const fetchStub = vi.fn(async () => jsonResponse(vendorListing()));
    const modelRegistry = registry([entry('glm', { cost: { inputPer1MUsd: 2, outputPer1MUsd: 8, currency: 'USD' } })]);
    modelRegistry.pricing = { catalogRefresh: { enabled: false, intervalMinutes: 30, maxAgeMinutes: 120 } };
    const book = new ModelPriceBook({ config: { providerRegistry, modelRegistry }, fetch: fetchStub });
    await book.refresh();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(book.resolve(modelRegistry.models[0]!, Date.now())).toEqual({
      source: 'owner',
      rates: { inputPer1MUsd: 2, outputPer1MUsd: 8, currency: 'USD' },
    });
  });
});
