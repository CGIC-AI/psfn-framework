import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../../../shared/event-bus.js';
import { SessionManager } from '../../session/manager.js';
import { SessionStore } from '../../../persistence/sessions/store.js';
import { createTurnId } from '../../turns/id.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { TurnSupportRuntime } from './turn-support-runtime.js';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushAsyncWork(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

function makeConfig(overrides?: Partial<SubstrateConfig>): SubstrateConfig {
  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-model',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir: './data',
    databasePath: '',
    sessionHistoryBudgetPct: 6,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 50,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16_384,
    extractionMaxTokens: 8_192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    memoryBudgetPct: 20,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    compactionEmotionalSalienceThresholdPct: 75,
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16_384, contextWindow: 1_000 },
    },
    ...overrides,
  };
}

describe('TurnSupportRuntime role-envelope projections', () => {
  let dir: string;
  let store: SessionStore;
  let sessionManager: SessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'turn-support-runtime-'));
    store = new SessionStore(dir);
    sessionManager = new SessionManager(store, makeConfig({ dataDir: dir }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('buildTurnRecord lifts promoted role-envelope refs from stored session previews', () => {
    const runtime = new TurnSupportRuntime({
      eventBus: new EventBus(),
      sessionManager,
      hashPromptText: (text) => `hash:${text.length}`,
      resolveContextWindow: () => 1_000,
    });
    const channelId = 'api:runtime-role-envelope';
    const turnId = createTurnId();
    const requestId = 'runtime-role-envelope-turn';
    const timestamp = new Date('2026-03-17T14:00:00.000Z');

    const userSessionEntryId = sessionManager.recordUserMessage(
      channelId,
      'Please check in tomorrow if I disappear.',
      'user-1',
      'User',
      undefined,
      undefined,
      {
        turnId,
        requestId,
      },
    );
    const assistantSessionEntryId = sessionManager.recordAssistantMessage(
      channelId,
      'Queued a gentle follow-up reminder for tomorrow.',
      undefined,
      undefined,
      undefined,
      {
        turnId,
        requestId,
        roleEnvelopePreview: {
          schemaVersion: 1,
          envelopeId: 'env_runtime_projection_1',
          internalRole: 'outreach_candidate',
          summary: 'Queued a gentle follow-up reminder for tomorrow.',
          sourceStage: 'post_turn_appraisal',
          promotionTarget: 'turn_record_summary',
          promotedRef: 'turn_record_summary:env_runtime_projection_1',
        },
      },
    );

    const record = runtime.buildTurnRecord({
      message: {
        id: requestId,
        channelId,
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'Please check in tomorrow if I disappear.',
        timestamp,
      },
      turnId,
      requestId,
      startedAt: timestamp.getTime(),
      completedAt: timestamp.getTime() + 50,
      userSessionEntryId,
      assistantSessionEntryId,
      response: {
        content: 'Queued a gentle follow-up reminder for tomorrow.',
        channelId,
        metadata: {
          model: 'test-model',
          inputTokens: 42,
          outputTokens: 11,
          durationMs: 50,
        },
      },
      turnMessages: [],
      promptMode: 'default',
      promptText: 'System prompt',
      contextMessageCount: 2,
      memoryContextChars: 0,
      trustLevel: 'regular',
      speakerRole: 'user',
      retrievalProvenanceRefs: [],
    });

    expect(record.roleEnvelopeRefs).toEqual(['turn_record_summary:env_runtime_projection_1']);
  });
});

describe('TurnSupportRuntime post-turn drain gate', () => {
  function createRuntime(eventBus = new EventBus()): TurnSupportRuntime {
    return new TurnSupportRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      hashPromptText: (text) => `hash:${text.length}`,
      resolveContextWindow: () => 1_000,
    });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for registered post-turn work before releasing the next turn', async () => {
    const runtime = createRuntime();
    const previousTurnId = createTurnId();
    const nextTurnId = createTurnId();
    const work = createDeferred<void>();

    runtime.registerPostTurnBackgroundWork({
      channelId: 'api:drain-wait',
      turnId: previousTurnId,
      requestId: 'previous-request',
      work: [{ name: 'emotion_appraisal', promise: work.promise }],
    });

    let released = false;
    const waitPromise = runtime.awaitPostTurnDrain({
      channelId: 'api:drain-wait',
      turnId: nextTurnId,
      requestId: 'next-request',
      timeoutMs: 1_000,
    }).then((result) => {
      released = true;
      return result;
    });

    await flushAsyncWork();
    expect(released).toBe(false);

    work.resolve();
    const result = await waitPromise;

    expect(released).toBe(true);
    expect(result).toMatchObject({
      status: 'drained',
      workCount: 1,
      previousTurnId,
      previousRequestId: 'previous-request',
    });
  });

  it('times out an active drain and clears the gate for later turns', async () => {
    vi.useFakeTimers();
    const eventBus = new EventBus();
    const telemetry: Array<Record<string, unknown>> = [];
    eventBus.on('agent.post_turn.drain', (event) => {
      telemetry.push(event);
    });
    const runtime = createRuntime(eventBus);
    const previousTurnId = createTurnId();

    runtime.registerPostTurnBackgroundWork({
      channelId: 'api:drain-timeout',
      turnId: previousTurnId,
      requestId: 'previous-timeout-request',
      work: [{ name: 'auto_compaction', promise: new Promise(() => undefined) }],
    });

    const waitPromise = runtime.awaitPostTurnDrain({
      channelId: 'api:drain-timeout',
      turnId: createTurnId(),
      requestId: 'next-timeout-request',
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);
    const result = await waitPromise;
    await flushAsyncWork();

    expect(result).toMatchObject({
      status: 'timeout',
      workCount: 1,
      previousTurnId,
      previousRequestId: 'previous-timeout-request',
    });
    expect(telemetry).toContainEqual(expect.objectContaining({
      phase: 'timeout',
      channelId: 'api:drain-timeout',
      previousTurnId,
      timeoutMs: 25,
      taskNames: ['auto_compaction'],
    }));

    await expect(runtime.awaitPostTurnDrain({
      channelId: 'api:drain-timeout',
      turnId: createTurnId(),
      requestId: 'after-timeout-request',
      timeoutMs: 25,
    })).resolves.toMatchObject({ status: 'idle' });
  });

  it('settles rejected post-turn work so failures do not block the next turn forever', async () => {
    const eventBus = new EventBus();
    const telemetry: Array<Record<string, unknown>> = [];
    eventBus.on('agent.post_turn.drain', (event) => {
      telemetry.push(event);
    });
    const runtime = createRuntime(eventBus);
    const previousTurnId = createTurnId();

    runtime.registerPostTurnBackgroundWork({
      channelId: 'api:drain-failure',
      turnId: previousTurnId,
      requestId: 'previous-failure-request',
      work: [{ name: 'memory_extraction', promise: Promise.reject(new Error('extract failed')) }],
    });

    const result = await runtime.awaitPostTurnDrain({
      channelId: 'api:drain-failure',
      turnId: createTurnId(),
      requestId: 'next-failure-request',
      timeoutMs: 1_000,
    });
    await flushAsyncWork();

    expect(result).toMatchObject({
      status: 'drained',
      workCount: 1,
      previousTurnId,
    });
    expect(telemetry).toContainEqual(expect.objectContaining({
      phase: 'drained',
      channelId: 'api:drain-failure',
      previousTurnId,
      failureCount: 1,
      taskNames: ['memory_extraction'],
    }));
  });
});
