import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  BackgroundWorkDeferredError,
  BackgroundWorkSupervisor,
  type BackgroundWorkSupervisorOptions,
} from '../../core/agent/background-work/supervisor.js';
import {
  createBackgroundWorkIdentity,
  fingerprintBackgroundWorkPayload,
  type BackgroundWorkPayload,
  type EnqueueBackgroundWorkInput,
} from '../../core/agent/background-work/types.js';
import { LLMClient } from '../../primitives/llm/client.js';
import { ModelCallPreemptedError } from '../../primitives/llm/model-call-gate.js';
import { PiProviderRuntime } from '../../primitives/llm/provider-runtime.js';
import { buildLLMWorkSpec } from '../../primitives/llm/work-spec.js';
import { resolveHealthEventOwner, type HealthEvent } from '../../shared/contracts/health-event.js';
import type { CorrelationMetadata, LLMContext } from '../../shared/contracts/runtime.js';
import { EventBus } from '../../shared/event-bus.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import {
  scriptedEndpointRegistries,
  startScriptedOpenAIEndpoint,
  type ScriptedOpenAIEndpoint,
} from '../../test-support/scripted-openai-endpoint.js';
import { PostgresBackgroundWorkStore } from './background-work-store.js';

/**
 * psfn-framework-22ovy: one companion's background calls were preempted "by
 * foreground_chat" every ~20 s for minutes and re-dispatched without bound.
 * These cases run the real supervisor and Postgres job store, the real
 * LLMClient and model-call gate, and the real pi-ai transport against a
 * scripted one-slot OpenAI-compatible endpoint (the round's unconfigured
 * base-URL provider).
 */

const INTEGRATION_TIMEOUT_MS = 120_000;
const API_KEY_ENV = 'PSFN_PREEMPTION_STORM_TEST_KEY';
const COMPANION_ID = 'companion-lumen';
const SESSION_ID = 'api:soak-long';
const DEFER_MS = 1_000;
const RETRY_MAX_DELAY_MS = 300_000;

const SUPERVISOR_TUNING = {
  maxConcurrentSessions: 4,
  leaseDurationMs: 300_000,
  retryBaseDelayMs: DEFER_MS,
  retryMaxDelayMs: RETRY_MAX_DELAY_MS,
  shutdownTimeoutMs: 5_000,
  terminalRetentionMs: 604_800_000,
  cleanupIntervalMs: 3_600_000,
};

function makeConfig(dataDir: string, baseUrl: string): SubstrateConfig {
  const registries = scriptedEndpointRegistries({ baseUrl, apiKeyEnv: API_KEY_ENV, maxOutputTokens: 4_096 });
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
    primaryMaxTokens: 4_096,
    extractionMaxTokens: 4_096,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 200_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    companionId: COMPANION_ID,
    retryMaxAttempts: 0,
    retryBaseDelayMs: 0,
    providerRegistry: registries.providerRegistry,
    modelRegistry: { schemaVersion: 1, models: [registries.model] },
  };
}

function llmContext(correlation: CorrelationMetadata): LLMContext {
  return {
    systemPrompt: 'System',
    messages: [{ role: 'user', content: 'We talked about the greenhouse.' }],
    correlation,
  };
}

const EXTRACTION_CORRELATION: CorrelationMetadata = {
  companionId: COMPANION_ID,
  channelId: SESSION_ID,
  channelType: 'api',
  callType: 'background',
  requestId: 'extraction',
  originStage: 'memory.extraction',
};

/** A conversational turn on another companion sharing the endpoint. */
const FOREGROUND_CORRELATION: CorrelationMetadata = {
  companionId: 'companion-primary',
  channelId: 'api:testing-harness',
  channelType: 'api',
  callType: 'chat',
  requestId: 'foreground',
  originStage: 'agent.turn.prompt',
};

/** The primary's failing daily-review reflection, retried about every 20 s in the round. */
const REFLECTION_CORRELATION: CorrelationMetadata = {
  companionId: 'companion-primary',
  channelId: 'internal:reflection:daily-review',
  channelType: 'terminal',
  callType: 'scheduled',
  requestId: 'reflection',
  originStage: 'agent.turn.prompt',
};

function extractionJob(createdAtMs: number, maxAttempts: number): EnqueueBackgroundWorkInput {
  const turnId = 'turn-1';
  const source = {
    schemaVersion: 1 as const,
    logicalSessionId: SESSION_ID,
    channelId: SESSION_ID,
    turnId,
    requestId: `request-${turnId}`,
    turnRecordFingerprint: 'a'.repeat(64),
    createdAtMs,
  };
  const payload: BackgroundWorkPayload = { schemaVersion: 1, kind: 'memory_extraction', source };
  return {
    ...createBackgroundWorkIdentity({ logicalSessionId: SESSION_ID, turnId, kind: 'memory_extraction' }),
    logicalSessionId: SESSION_ID,
    kind: 'memory_extraction',
    payload,
    payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
    sourceTurnId: turnId,
    sourceRequestId: source.requestId,
    sourceChannelId: source.channelId,
    createdAtMs,
    maxAttempts,
  };
}

let harness: PostgresTestHarness | undefined;
const cleanups: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  delete process.env[API_KEY_ENV];
});

interface Rig {
  endpoint: ScriptedOpenAIEndpoint;
  client: LLMClient;
  store: PostgresBackgroundWorkStore;
  supervisor: BackgroundWorkSupervisor;
  clock: { now: number };
  healthEvents: HealthEvent[];
  protectedClaims: boolean[];
}

async function setupRig(welfare: BackgroundWorkSupervisorOptions['welfare']): Promise<Rig> {
  if (!harness) throw new Error('Postgres test harness did not start');
  process.env[API_KEY_ENV] = 'scripted-endpoint-key';
  const database = await harness.createDatabase();
  const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, { schema: 'companion_lumen' });
  const endpoint = await startScriptedOpenAIEndpoint();
  const dataDir = mkdtempSync(join(tmpdir(), 'background-work-preemption-'));
  const config = makeConfig(dataDir, endpoint.baseUrl);
  // One gateway-wide client: its gate is shared by every companion on the endpoint.
  const client = new LLMClient(config, {
    runtime: new PiProviderRuntime(undefined, config),
    usageRecorder: { recordUsageEvent: async () => undefined },
  });
  const clock = { now: 1_000 };
  const eventBus = new EventBus();
  const healthEvents: HealthEvent[] = [];
  eventBus.on('runtime.health.event', (data) => { healthEvents.push(data.event); });
  const protectedClaims: boolean[] = [];
  const supervisor = new BackgroundWorkSupervisor({
    ...SUPERVISOR_TUNING,
    welfare,
    store,
    eventBus,
    now: () => clock.now,
    healthEventOwner: resolveHealthEventOwner(COMPANION_ID),
    // The post-turn extraction handler's model call and its preemption mapping.
    executor: async ({ job }) => {
      protectedClaims.push(job.welfareClaimed);
      const workSpec = buildLLMWorkSpec({
        purpose: 'extraction',
        durable: true,
        correlation: EXTRACTION_CORRELATION,
        ...(job.welfareClaimed ? { preemptionProtected: true, welfareGrantJobId: job.jobId } : {}),
      });
      try {
        await client.complete(llmContext(EXTRACTION_CORRELATION), 'extraction', { disableRetry: true, workSpec });
      } catch (error) {
        if (error instanceof ModelCallPreemptedError) {
          throw new BackgroundWorkDeferredError('foreground_active', DEFER_MS);
        }
        throw error;
      }
    },
  });
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  cleanups.push(async () => await store.close());
  cleanups.push(async () => await endpoint.close());
  cleanups.push(async () => await supervisor.stop());
  return { endpoint, client, store, supervisor, clock, healthEvents, protectedClaims };
}

/** Claim the job and let a foreground turn on the shared endpoint arrive while its call is in flight. */
async function claimUnderForegroundTurn(rig: Rig, backgroundAnswerDelayMs?: number): Promise<void> {
  if (backgroundAnswerDelayMs === undefined) {
    rig.endpoint.enqueue('role_chunk_then_hang');
  } else {
    rig.endpoint.enqueue('complete', { delayMs: backgroundAnswerDelayMs });
  }
  rig.endpoint.enqueue('complete');
  const backgroundArrived = rig.endpoint.nextArrival();
  const ticked = rig.supervisor.tick();
  await backgroundArrived;
  const foreground = await rig.client.stream(llmContext(FOREGROUND_CORRELATION));
  expect(foreground.content).toBe('done');
  await ticked;
  await rig.supervisor.waitForIdle();
}

describe('background model calls under foreground preemption (22ovy)', () => {
  it('lets a scheduled reflection turn wait for an in-flight background call instead of preempting it', async () => {
    const rig = await setupRig({ deferThreshold: 8, ageThresholdMs: 300_000, reserveSlots: 1, maxDefers: 16 });
    rig.endpoint.enqueue('complete', { delayMs: 300 });
    rig.endpoint.enqueue('complete');
    const backgroundArrived = rig.endpoint.nextArrival();
    const background = rig.client.complete(llmContext(EXTRACTION_CORRELATION), 'extraction', {
      disableRetry: true,
      workSpec: buildLLMWorkSpec({ purpose: 'extraction', durable: true, correlation: EXTRACTION_CORRELATION }),
    });
    await backgroundArrived;
    const reflection = await rig.client.stream(llmContext(REFLECTION_CORRELATION));

    expect(reflection.content).toBe('done');
    await expect(background).resolves.toMatchObject({ content: 'done' });
    expect(rig.endpoint.requests).toBe(2);
  }, INTEGRATION_TIMEOUT_MS);

  it('protects an aged job claimed after its backoff elapsed, so the next foreground turn waits', async () => {
    const rig = await setupRig({ deferThreshold: 100, ageThresholdMs: 60_000, reserveSlots: 1, maxDefers: 200 });
    await rig.store.enqueue(extractionJob(rig.clock.now, 5));

    await claimUnderForegroundTurn(rig);
    const deferred = await rig.store.get(extractionJob(0, 5).jobId);
    expect(deferred).toMatchObject({ state: 'deferred', deferCount: 1 });

    // Aged past the welfare threshold, and normally available again.
    rig.clock.now += 60_001;
    await claimUnderForegroundTurn(rig, 300);

    expect(rig.protectedClaims).toEqual([false, true]);
    expect(await rig.store.get(extractionJob(0, 5).jobId)).toMatchObject({ state: 'succeeded' });
  }, INTEGRATION_TIMEOUT_MS);

  it('backs off each preemption defer and ends a preemption loop at its bound with health events', async () => {
    // Welfare disabled, so nothing but the bound can end the loop.
    const rig = await setupRig({ deferThreshold: 2, ageThresholdMs: 3_600_000, reserveSlots: 0, maxDefers: 3 });
    const jobId = extractionJob(0, 2).jobId;
    await rig.store.enqueue(extractionJob(rig.clock.now, 2));

    const backoffs: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      await claimUnderForegroundTurn(rig);
      const job = await rig.store.get(jobId);
      expect(job).toMatchObject({ state: 'deferred', deferCount: round + 1 });
      backoffs.push(job!.availableAtMs - rig.clock.now);
      rig.clock.now += RETRY_MAX_DELAY_MS + 1;
    }
    expect(backoffs).toEqual([DEFER_MS, 2 * DEFER_MS, 4 * DEFER_MS]);
    expect(rig.healthEvents).toEqual([]);

    // Past the bound each preemption consumes an attempt instead of a free re-dispatch.
    await claimUnderForegroundTurn(rig);
    const retrying = await rig.store.get(jobId);
    expect(retrying).toMatchObject({ state: 'retry_wait', deferCount: 3, attemptCount: 1 });
    expect(retrying!.availableAtMs - rig.clock.now).toBe(8 * DEFER_MS);
    rig.clock.now += RETRY_MAX_DELAY_MS + 1;
    await claimUnderForegroundTurn(rig);
    expect(await rig.store.get(jobId)).toMatchObject({ state: 'failed', reasonCode: 'handler_failed', attemptCount: 2 });

    expect(rig.healthEvents.map(event => event.code)).toEqual([
      'background_work_preemption_bounded',
      'background_work_preemption_bounded',
      'background_work_job_failed',
    ]);
    expect(rig.healthEvents[0]!.evidence).toEqual({ deferCount: 3, attemptCount: 0 });

    // A terminal job is never re-dispatched.
    const requestsAtTerminal = rig.endpoint.requests;
    rig.clock.now += RETRY_MAX_DELAY_MS + 1;
    await rig.supervisor.tick();
    await rig.supervisor.waitForIdle();
    expect(rig.endpoint.requests).toBe(requestsAtTerminal);
  }, INTEGRATION_TIMEOUT_MS);
});
