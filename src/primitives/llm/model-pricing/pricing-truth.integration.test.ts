import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LLMContext } from '../../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import {
  scriptedEndpointRegistries,
  startScriptedOpenAIEndpoint,
} from '../../../test-support/scripted-openai-endpoint.js';
import { createPostgresPool } from '../../../persistence/postgres.js';
import { PostgresHealthEventStore } from '../../../persistence/postgres/health-event-store.js';
import { EventBus } from '../../../shared/event-bus.js';
import { subscribeHealthEventStream } from '../../../shared/observability/health-event-stream.js';
import { classifyIncidentStatement } from '../../../shared/observability/incident-alerts/contracts.js';
import { PostgresModelUsageStore } from '../../../persistence/postgres/model-usage-store.js';
import {
  consumeActiveGatewayCapturedProviderCostEvidence,
  withGatewayLLMCostCapture,
} from '../../../boundary/gateway/llm-cost-capture.js';
import { createGatewayPrivilegedServiceRegistry } from '../../../boundary/gateway/privileged-services.js';
import { LLMClient } from '../client.js';
import { PiProviderRuntime } from '../provider-runtime.js';
import { ModelPriceBook } from './price-book.js';

/**
 * lomm1: the ledger and the budget book what a call really cost. Every case
 * runs the real LLMClient and pi-ai OpenAI-compatible transport against a
 * scripted HTTP endpoint, the real gateway wire-cost capture, the real price
 * book (its catalogue fetch stubbed with an OpenRouter-shaped endpoints
 * listing), and the real Postgres usage store and budget projection.
 */

const TEST_IMAGE = 'postgres:16.8-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;
const API_KEY_ENV = 'PSFN_PRICING_TRUTH_TEST_KEY';
const COMPANION_ID = 'companion-a';
const CATALOG_URL = 'https://catalog.example.test/api/v1/models';
const CATALOG_MODEL = 'acme/model-7';
const OUTPUT_CAP = 8_192;
// A hand-typed placeholder price far above the vendor's real one.
const STALE_OWNER_COST = { inputPer1MUsd: 3, outputPer1MUsd: 15, cacheReadPer1MUsd: 3, cacheWritePer1MUsd: 3.75 };
// The vendor's endpoint: $1.40 in, $4.40 out, $0.26 cached input per million.
const VENDOR_ENDPOINTS = {
  data: {
    id: CATALOG_MODEL,
    endpoints: [
      { tag: 'cheaphost/fp4', pricing: { prompt: '0.0000005', completion: '0.000001' } },
      { tag: 'acme/fp8', pricing: { prompt: '0.0000014', completion: '0.0000044', input_cache_read: '0.00000026' } },
    ],
  },
};

interface Row {
  status: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  estimated_cost_usd: string | null;
  provider_cost_usd: string | null;
  effective_cost_usd: string | null;
  cost_source: string;
  charge: string | null;
  pricing: { source: string; endpointTag?: string; catalogModel?: string; fetchedAtMs?: number } | null;
}

function context(requestId: string): LLMContext {
  return {
    systemPrompt: 'You extract durable facts from the conversation.',
    messages: [{ role: 'user', content: 'We talked about the garden and the new greenhouse.' }],
    correlation: {
      companionId: COMPANION_ID,
      channelId: 'api:pricing-session',
      channelType: 'api',
      callType: 'background',
      requestId,
      turnId: `turn-${requestId}`,
    },
  };
}

let harness: PostgresTestHarness | null = null;
const cleanups: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  delete process.env[API_KEY_ENV];
});

async function setup(options: {
  ownerCost?: typeof STALE_OWNER_COST;
  catalog?: unknown;
  /** Build the client the way the gateway does, from the live config. */
  viaGatewayServices?: boolean;
} = {}) {
  if (!harness) throw new Error('Postgres test harness is unavailable');
  process.env[API_KEY_ENV] = 'scripted-endpoint-key';
  const { databaseUrl } = await harness.createDatabase();
  const pool: Pool = createPostgresPool(databaseUrl, { applicationName: 'pricing-truth', allowExitOnIdle: true, max: 2 });
  const endpoint = await startScriptedOpenAIEndpoint();
  const dataDir = mkdtempSync(join(tmpdir(), 'pricing-truth-'));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  cleanups.push(async () => await pool.end());
  cleanups.push(async () => await endpoint.close());
  const registries = scriptedEndpointRegistries({
    baseUrl: endpoint.baseUrl,
    apiKeyEnv: API_KEY_ENV,
    maxOutputTokens: OUTPUT_CAP,
    ...(options.ownerCost ? { cost: options.ownerCost } : {}),
  });
  const config: SubstrateConfig = {
    primaryModel: 'scripted-model',
    primaryProvider: 'scripted-endpoint',
    extractionModel: 'scripted-model',
    extractionProvider: 'scripted-endpoint',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir,
    databasePath: '',
    extractionInterval: 5,
    primaryMaxTokens: OUTPUT_CAP,
    extractionMaxTokens: OUTPUT_CAP,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 200_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    companionId: COMPANION_ID,
    retryMaxAttempts: 0,
    retryBaseDelayMs: 0,
    providerRegistry: {
      ...registries.providerRegistry,
      providers: [
        ...registries.providerRegistry.providers,
        // Kept for its public catalogue only; no slot is routed through it.
        { id: 'openrouter', type: 'openrouter' as const, enabled: false, modelsApiUrl: CATALOG_URL },
      ],
    },
    modelRegistry: {
      schemaVersion: 1,
      budgetPolicy: { enabled: true, dailyUsdLimit: 20, monthlyUsdLimit: 20, currency: 'USD' },
      pricing: { catalogRefresh: { enabled: true, intervalMinutes: 360, maxAgeMinutes: 2880 } },
      // A direct (coding-plan style) route to the vendor, priced from its catalogue entry.
      models: [{ ...registries.model, pricing: { catalogModel: CATALOG_MODEL } }],
    },
  };
  const catalogRequests: string[] = [];
  const priceBook = new ModelPriceBook({
    config,
    fetch: async (input) => {
      catalogRequests.push(String(input));
      return new Response(JSON.stringify(options.catalog ?? VENDOR_ENDPOINTS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  config.modelPriceBook = priceBook;
  const store = new PostgresModelUsageStore(pool, { companionId: COMPANION_ID });
  const client = options.viaGatewayServices
    ? createGatewayPrivilegedServiceRegistry({
        config: {
          ...config,
          embeddingProvider: 'api',
          embeddingApiUrl: 'https://embedding.example.test',
          embeddingApiModel: 'embed-model',
          embeddingApiDims: 384,
        } as SubstrateConfig,
        providerEnv: { EMBEDDING_API_KEY: 'embedding-key' },
        llmOptions: { usageRecorder: store, usageBudgetQuery: store },
      }).llmClient
    : new LLMClient(config, {
        runtime: new PiProviderRuntime(undefined, config),
        usageRecorder: store,
        usageBudgetQuery: store,
        // As the gateway wires it: the provider cost is what was captured on the wire.
        providerCostResolver: consumeActiveGatewayCapturedProviderCostEvidence,
      });
  const rows = async (): Promise<Row[]> => (await pool.query<Row>(`
    SELECT status, input_tokens, output_tokens, cache_read_tokens,
           estimated_cost_usd::text, provider_cost_usd::text, effective_cost_usd::text, cost_source,
           metadata_json->>'unreportedAttemptCharge' AS charge, metadata_json->'pricing' AS pricing
    FROM model_usage_events ORDER BY recorded_at_ms
  `)).rows;
  const spend = async () => await store.getModelBudgetSpend(Date.now(), { companionId: COMPANION_ID }, []);
  const complete = async (requestId: string, signal?: AbortSignal) => (await withGatewayLLMCostCapture(
    async () => await client.complete(context(requestId), 'background', { disableRetry: true, ...(signal ? { signal } : {}) }),
  )).result;
  return { config, pool, priceBook, endpoint, rows, spend, complete, catalogRequests };
}

describe('pricing truth through the real usage store (lomm1)', () => {
  it("books a slot with a stale hand-typed price at its vendor's current catalogue price, cache hits at the cached rate", async () => {
    const { priceBook, endpoint, rows, spend, complete, catalogRequests } = await setup({ ownerCost: STALE_OWNER_COST });
    await priceBook.refresh();
    expect(catalogRequests).toEqual([`${CATALOG_URL}/${CATALOG_MODEL}/endpoints`]);
    endpoint.enqueue('complete', {
      usage: {
        prompt_tokens: 1_000_000,
        prompt_tokens_details: { cached_tokens: 600_000 },
        // completion_tokens already includes the reasoning tokens.
        completion_tokens: 200_000,
        completion_tokens_details: { reasoning_tokens: 50_000 },
        total_tokens: 1_200_000,
      },
    });
    await complete('catalogue-priced');

    const [row] = await rows();
    expect(row).toMatchObject({ status: 'success', input_tokens: 400_000, cache_read_tokens: 600_000, output_tokens: 200_000 });
    // 0.4M x $1.40 + 0.6M x $0.26 + 0.2M x $4.40 = $1.596; the stale owner price would book $6.00.
    expect(Number(row!.estimated_cost_usd)).toBeCloseTo(1.596, 6);
    expect(Number(row!.effective_cost_usd)).toBeCloseTo(1.596, 6);
    expect(row).toMatchObject({ cost_source: 'estimate', provider_cost_usd: null });
    expect(row!.pricing).toMatchObject({ source: 'catalog', catalogModel: CATALOG_MODEL, endpointTag: 'acme/fp8' });
    expect((await spend()).dailyEstimatedCostUsd).toBeCloseTo(1.596, 6);
  }, INTEGRATION_TIMEOUT_MS);

  it('prices through the price book on the live config when the client is built by the gateway services', async () => {
    const { priceBook, endpoint, rows, complete } = await setup({ ownerCost: STALE_OWNER_COST, viaGatewayServices: true });
    await priceBook.refresh();
    endpoint.enqueue('complete', {
      usage: { prompt_tokens: 100_000, prompt_tokens_details: { cached_tokens: 50_000 }, completion_tokens: 10_000, total_tokens: 110_000 },
    });
    await complete('gateway-composed');
    const [row] = await rows();
    // 0.05M x $1.40 + 0.05M x $0.26 + 0.01M x $4.40 = $0.127 (the stale price: $0.45).
    expect(Number(row!.estimated_cost_usd)).toBeCloseTo(0.127, 6);
    expect(row!.pricing).toMatchObject({ source: 'catalog', endpointTag: 'acme/fp8' });
  }, INTEGRATION_TIMEOUT_MS);

  it('books the cost the provider reported on the wire over any estimate, in the ledger and the budget', async () => {
    const { priceBook, endpoint, rows, spend, complete } = await setup({ ownerCost: STALE_OWNER_COST });
    await priceBook.refresh();
    endpoint.enqueue('complete', {
      usage: { prompt_tokens: 100_000, completion_tokens: 10_000, total_tokens: 110_000, cost: 0.0123 },
    });
    await complete('provider-billed');

    const [row] = await rows();
    expect(row).toMatchObject({ cost_source: 'provider' });
    expect(Number(row!.provider_cost_usd)).toBeCloseTo(0.0123, 8);
    expect(Number(row!.effective_cost_usd)).toBeCloseTo(0.0123, 8);
    // The catalogue estimate (0.1M x $1.40 + 0.01M x $4.40 = $0.184) is kept for audit, never booked.
    expect(Number(row!.estimated_cost_usd)).toBeCloseTo(0.184, 6);
    expect((await spend()).dailyEstimatedCostUsd).toBeCloseTo(0.0123, 8);
  }, INTEGRATION_TIMEOUT_MS);

  it('books an aborted call at the prompt it sent at the current price, never the output cap', async () => {
    const { priceBook, endpoint, rows, complete } = await setup({ ownerCost: STALE_OWNER_COST });
    await priceBook.refresh();
    endpoint.enqueue('role_chunk_then_hang');
    const owner = new AbortController();
    const arrival = endpoint.nextArrival();
    const settled = complete('aborted', owner.signal).then(() => undefined, (error: unknown) => error);
    await arrival;
    owner.abort();
    expect(await settled).toMatchObject({ name: 'AbortError' });

    const [row] = await rows();
    expect(row).toMatchObject({ status: 'failure', charge: 'input_bound', output_tokens: 0 });
    expect(row!.pricing).toMatchObject({ source: 'catalog' });
    const booked = Number(row!.estimated_cost_usd);
    expect(booked).toBeGreaterThan(0);
    // The prompt estimate is well under 1k tokens: under $0.0014 at $1.40/M. Booking
    // the 8k output cap would add $0.036 for output that was never produced.
    expect(booked).toBeLessThan(0.0014);
  }, INTEGRATION_TIMEOUT_MS);

  it('marks a slot without any usable price unknown, persists the incident, and refuses it under an enforced budget', async () => {
    const { pool, priceBook, endpoint, rows, complete } = await setup({
      catalog: { data: { id: CATALOG_MODEL, endpoints: [VENDOR_ENDPOINTS.data.endpoints[0]] } },
    });
    // The gateway's health plane: event bus -> stream subscriber -> Postgres ring.
    const healthStore = await PostgresHealthEventStore.fromPool(pool, 1_000);
    const eventBus = new EventBus();
    const detach = subscribeHealthEventStream({ eventBus, store: healthStore });
    cleanups.push(() => detach());
    expect(await priceBook.refresh(eventBus)).toMatchObject({ attempted: 1, failed: 1, unknown: 1 });
    const persisted = await healthStore.listRecent({ limit: 10 });
    expect(persisted.map(event => event.code).sort()).toEqual(['model_price_refresh_failed', 'model_price_unknown']);
    const unknown = persisted.find(event => event.code === 'model_price_unknown')!;
    expect(unknown).toMatchObject({ severity: 'degraded', evidence: { priceStale: false } });
    expect(unknown.provenance).toMatchObject({ component: 'model_pricing', process: 'gateway' });
    // An operator incident on its own: one per slot.
    expect(classifyIncidentStatement(unknown)).toMatchObject({ phase: 'opened', family: null });
    expect(priceBook.status()[0]).toMatchObject({ slotKey: 'scripted', source: 'unknown', lastFailure: 'upstream_not_listed' });

    await expect(complete('unpriced')).rejects.toThrow(/missing_cost_metadata/u);
    expect(endpoint.requests).toBe(0);
    expect(await rows()).toEqual([]);
  }, INTEGRATION_TIMEOUT_MS);
});
