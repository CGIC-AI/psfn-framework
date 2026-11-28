import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LLMContext } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import {
  scriptedEndpointRegistries,
  startScriptedOpenAIEndpoint,
} from '../../test-support/scripted-openai-endpoint.js';
import { createPostgresPool } from '../../persistence/postgres.js';
import { PostgresModelUsageStore } from '../../persistence/postgres/model-usage-store.js';
import { LLMClient } from './client.js';
import { ModelCallPreemptedError } from './model-call-gate.js';
import { PiProviderRuntime, type ProviderRuntime } from './provider-runtime.js';

/**
 * ge9w7, lomm1: a failed attempt that reports no usage is booked from what it
 * actually sent and received. Every case runs the real LLMClient, the real pi-ai
 * OpenAI-compatible transport against a scripted HTTP endpoint, the real
 * model-call gate, and the real Postgres usage store and budget projection.
 */

const TEST_IMAGE = 'postgres:16.8-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;
const API_KEY_ENV = 'PSFN_UNREPORTED_CHARGE_TEST_KEY';
const COMPANION_ID = 'companion-a';
const OUTPUT_CAP = 32_768;
// Rates high enough that booking the output cap would be unmistakable.
const RATES = { inputPer1MUsd: 3, outputPer1MUsd: 15, cacheReadPer1MUsd: 3, cacheWritePer1MUsd: 3.75 };

function makeConfig(dataDir: string, baseUrl: string, priced: boolean): SubstrateConfig {
  const registries = scriptedEndpointRegistries({
    baseUrl,
    apiKeyEnv: API_KEY_ENV,
    maxOutputTokens: OUTPUT_CAP,
    ...(priced ? { cost: RATES } : {}),
  });
  return {
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
    providerRegistry: registries.providerRegistry,
    modelRegistry: {
      schemaVersion: 1,
      budgetPolicy: { enabled: true, dailyUsdLimit: 20, monthlyUsdLimit: 20, currency: 'USD' },
      models: [registries.model],
    },
  };
}

function context(callType: 'chat' | 'background', requestId: string): LLMContext {
  return {
    systemPrompt: 'You extract durable facts from the conversation.',
    messages: [{ role: 'user', content: 'We talked about the garden and the new greenhouse.' }],
    correlation: {
      companionId: COMPANION_ID,
      channelId: 'api:soak-session',
      channelType: 'api',
      callType,
      requestId,
      turnId: `turn-${requestId}`,
    },
  };
}

/** Delegates to the real runtime, letting a test act just before dispatch begins. */
class BeforeDispatchRuntime implements ProviderRuntime {
  beforeComplete: (() => void) | undefined;
  constructor(private readonly inner: ProviderRuntime) {}
  complete(...args: Parameters<ProviderRuntime['complete']>) {
    this.beforeComplete?.();
    this.beforeComplete = undefined;
    return this.inner.complete(...args);
  }
  stream(...args: Parameters<ProviderRuntime['stream']>) { return this.inner.stream(...args); }
  getProviders() { return this.inner.getProviders(); }
  getModels(provider: string) { return this.inner.getModels(provider); }
  getAuth(provider: Parameters<ProviderRuntime['getAuth']>[0]) { return this.inner.getAuth(provider); }
  resolveProviderApiKey(provider: string) { return this.inner.resolveProviderApiKey(provider); }
}

interface LedgerRow {
  status: string;
  settlement: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: string | null;
  cost_source: string;
  error_code: string | null;
  charge: string | null;
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

async function setup(options: { priced?: boolean } = {}) {
  if (!harness) throw new Error('Postgres test harness is unavailable');
  process.env[API_KEY_ENV] = 'scripted-endpoint-key';
  const { databaseUrl } = await harness.createDatabase();
  const pool: Pool = createPostgresPool(databaseUrl, {
    applicationName: 'unreported-attempt-charge',
    allowExitOnIdle: true,
    max: 2,
  });
  const endpoint = await startScriptedOpenAIEndpoint();
  const dataDir = mkdtempSync(join(tmpdir(), 'unreported-attempt-charge-'));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  cleanups.push(async () => await pool.end());
  cleanups.push(async () => await endpoint.close());
  const config = makeConfig(dataDir, endpoint.baseUrl, options.priced !== false);
  const store = new PostgresModelUsageStore(pool, { companionId: COMPANION_ID });
  const runtime = new BeforeDispatchRuntime(new PiProviderRuntime(undefined, config));
  const client = new LLMClient(config, { runtime, usageRecorder: store, usageBudgetQuery: store });
  const failureRows = async (): Promise<LedgerRow[]> => (await pool.query<LedgerRow>(`
    SELECT status, settlement, input_tokens, output_tokens, estimated_cost_usd::text,
           cost_source, error_code, metadata_json->>'unreportedAttemptCharge' AS charge
    FROM model_usage_events WHERE status = 'failure' ORDER BY recorded_at_ms
  `)).rows;
  const spend = async () => await store.getModelBudgetSpend(Date.now(), { companionId: COMPANION_ID }, []);
  return { client, runtime, endpoint, failureRows, spend };
}

describe('unreported attempt charge through the real usage store (ge9w7)', () => {
  it('books an owner abort before dispatch as a known $0 and never sends the request', async () => {
    const { client, runtime, endpoint, failureRows, spend } = await setup();
    const owner = new AbortController();
    runtime.beforeComplete = () => owner.abort();

    await expect(client.complete(context('background', 'pre-dispatch'), 'background', {
      disableRetry: true,
      signal: owner.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(endpoint.requests).toBe(0);
    const [row] = await failureRows();
    expect(row).toMatchObject({ charge: 'not_dispatched', input_tokens: 0, output_tokens: 0 });
    expect(Number(row!.estimated_cost_usd)).toBe(0);
    expect(await spend()).toMatchObject({ dailyEstimatedCostUsd: 0, dailyUnknownCostAttempts: 0 });
  }, INTEGRATION_TIMEOUT_MS);

  it('books a background call preempted after dispatch, before its first token, at its input bound only', async () => {
    const { client, endpoint, failureRows, spend } = await setup();
    endpoint.enqueue('role_chunk_then_hang');
    endpoint.enqueue('complete');
    const arrival = endpoint.nextArrival();
    const background = client.complete(context('background', 'preempted'), 'background', { disableRetry: true });
    const backgroundSettled = background.then(() => undefined, (error: unknown) => error);
    await arrival;

    // A foreground turn on the same one-slot endpoint preempts the in-flight background call.
    const foreground = await client.stream(context('chat', 'foreground'));
    expect(foreground.content).toBe('done');
    expect(await backgroundSettled).toBeInstanceOf(ModelCallPreemptedError);

    expect(endpoint.requests).toBe(2);
    const [row] = await failureRows();
    expect(row).toMatchObject({ charge: 'input_bound', output_tokens: 0, error_code: 'AbortError' });
    const booked = Number(row!.estimated_cost_usd);
    expect(booked).toBeGreaterThan(0);
    // The old worst case added the 32k output cap: 32768 * $15/M = $0.49.
    expect(booked).toBeLessThan(0.001);
    const { dailyEstimatedCostUsd, dailyUnknownCostAttempts } = await spend();
    expect(dailyUnknownCostAttempts).toBe(0);
    expect(dailyEstimatedCostUsd).toBeLessThan(0.002);
  }, INTEGRATION_TIMEOUT_MS);

  it('books an abort after output began from the observed partial output', async () => {
    const { client, endpoint, failureRows } = await setup();
    endpoint.enqueue('partial_text_then_hang');
    const owner = new AbortController();
    const arrival = endpoint.nextArrival();
    const call = client.complete(context('background', 'mid-stream'), 'background', {
      disableRetry: true,
      signal: owner.signal,
    });
    const settled = call.then(() => undefined, (error: unknown) => error);
    await arrival;
    owner.abort();
    expect(await settled).toMatchObject({ name: 'AbortError' });

    const [row] = await failureRows();
    expect(row).toMatchObject({ settlement: 'partial', charge: null });
    expect(row!.input_tokens).toBeGreaterThan(0);
    expect(row!.output_tokens).toBeGreaterThan(0);
    expect(row!.output_tokens).toBeLessThan(100);
    expect(Number(row!.estimated_cost_usd)).toBeLessThan(0.001);
  }, INTEGRATION_TIMEOUT_MS);

  it('books a provider error answer as a known $0', async () => {
    const { client, endpoint, failureRows, spend } = await setup();
    endpoint.enqueue('http_500');
    await expect(client.complete(context('background', 'provider-error'), 'background', { disableRetry: true }))
      .rejects.toThrow(/500/u);

    const [row] = await failureRows();
    expect(row).toMatchObject({ charge: null, input_tokens: 0, output_tokens: 0 });
    expect(Number(row!.estimated_cost_usd)).toBe(0);
    expect(await spend()).toMatchObject({ dailyEstimatedCostUsd: 0, dailyUnknownCostAttempts: 0 });
  }, INTEGRATION_TIMEOUT_MS);

  it('books an upstream timeout at the prompt it sent, never its output cap (lomm1)', async () => {
    const { client, endpoint, failureRows, spend } = await setup();
    endpoint.enqueue('http_504');
    await expect(client.complete(context('background', 'upstream-timeout'), 'background', { disableRetry: true }))
      .rejects.toThrow(/504/u);

    const [row] = await failureRows();
    expect(row).toMatchObject({ charge: 'input_bound', output_tokens: 0 });
    const booked = Number(row!.estimated_cost_usd);
    expect(booked).toBeGreaterThan(0);
    // Booking the 32k output cap would be 32768 * $15/M = $0.49 for output
    // that was never produced.
    expect(booked).toBeLessThan(0.001);
    expect((await spend()).dailyUnknownCostAttempts).toBe(0);
  }, INTEGRATION_TIMEOUT_MS);

  it('still refuses an unpriced model before dispatch under an enforced budget (fail closed)', async () => {
    const { client, endpoint, failureRows } = await setup({ priced: false });
    await expect(client.complete(context('background', 'unpriced'), 'background', { disableRetry: true }))
      .rejects.toThrow(/missing_cost_metadata/u);
    expect(endpoint.requests).toBe(0);
    expect(await failureRows()).toEqual([]);
  }, INTEGRATION_TIMEOUT_MS);
});
