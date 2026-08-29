import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentResponse, InferredPostTurnAction, SubstrateMessage } from '../../../shared/contracts/runtime.js';
import { EventBus } from '../../../shared/event-bus.js';
import {
  clearDiagnosticLogRingBufferForTests,
  getRecentDiagnosticLogRecords,
} from '../../../shared/logger.js';
import {
  BACKGROUND_CONTINUATION_RUNTIME_CLASS,
  MAINTENANCE_REFLECTION_RUNTIME_CLASS,
} from '../../../core/agent/worker-lanes.js';
import { createEligibilityGate } from '../../../system/capabilities/eligibility.js';
import { Scheduler } from '../../../core/scheduler/scheduler.js';
import {
  POST_TURN_SUBAGENT_SPAWN_ACTION_KIND,
  type PostTurnActionHandler,
  wirePostTurnActionRuntime,
} from './post-turn-actions.js';
import { resetCompletionHandoffDedupeForTests } from '../../../core/agent/completion-handoff.js';
import {
  isDeferredCompanionOutreachExecutionAuthorized,
  registerDeferredCompanionOutreachRuntime,
  type DeferredCompanionOutreachAuthorizationEvidence,
  type DeferredCompanionOutreachAuthorizationRuntime,
} from '../../../core/tools/notify-companion-handoff.js';
import { ModelCallPreemptedError } from '../../../primitives/llm/model-call-gate.js';

const COMPANION_OUTREACH_PERMIT_ID = '44444444-4444-4444-8444-444444444444';
const COMPANION_OUTREACH_AUTHORIZATION: DeferredCompanionOutreachAuthorizationEvidence = {
  version: 2,
  toolName: 'notify',
  toolScope: 'extended',
  catalogSource: 'extended',
  requiredCapability: 'external.companion',
  originToolCallId: 'call-outreach-before-restart',
  originTurnId: 'turn-before-restart',
};

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function makeMessage(): SubstrateMessage {
  return {
    id: 'msg-1',
    channelId: 'test-channel',
    channelType: 'terminal',
    authorId: 'user-1',
    authorName: 'Test User',
    content: 'hello',
    timestamp: new Date(),
  };
}

function makeResponse(): AgentResponse {
  return {
    content: 'ok',
    channelId: 'test-channel',
    metadata: {
      model: 'mock-model',
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
    },
  };
}

function makeAction(overrides: Partial<InferredPostTurnAction> = {}): InferredPostTurnAction {
  return {
    id: 'action-1',
    kind: 'heartbeat.run_template',
    payload: { templateId: 'musing' },
    dedupeKey: 'heartbeat.run_template:musing',
    channelId: 'test-channel',
    sourceMessageId: 'msg-1',
    inferredAt: Date.now(),
    ...overrides,
  };
}

function makeSubagentSpawnAction(overrides: Partial<InferredPostTurnAction> = {}): InferredPostTurnAction {
  return makeAction({
    id: 'spawn-action-1',
    kind: POST_TURN_SUBAGENT_SPAWN_ACTION_KIND,
    dedupeKey: `${POST_TURN_SUBAGENT_SPAWN_ACTION_KIND}:research`,
    payload: {
      request: {
        name: 'research',
        task: 'inspect the logs',
        maxTurns: 2,
        capabilities: ['analysis'],
        requiredCapabilities: ['analysis'],
      },
      policy: {
        mode: 'post_turn_action_pipe',
        allow: true,
        budget: {
          maxTurns: 2,
        },
      },
    },
    maxRetries: 0,
    ...overrides,
  });
}

function createSleeptimeContentionHarness(handler: PostTurnActionHandler) {
  const eventBus = new EventBus();
  const scheduler = new Scheduler(eventBus, {
    tickIntervalMs: 100,
    heartbeatIntervalMs: 1_000,
  });
  const runtime = wirePostTurnActionRuntime({
    eventBus,
    scheduler,
    agentLoop: {
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    },
    intervalMs: 1,
    baseRetryDelayMs: 100,
    maxRetryDelayMs: 100,
  });
  runtime.registerHandler('memory.sleeptime.run', handler, {
    executionMode: 'background',
    runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
  });
  const phases: string[] = [];
  eventBus.on('agent.post_turn.action.telemetry', ({ phase }) => {
    phases.push(phase);
  });
  return { eventBus, scheduler, runtime, phases };
}

async function enqueueSleeptimeAction(
  eventBus: EventBus,
  overrides: Partial<InferredPostTurnAction>,
): Promise<void> {
  await eventBus.emit('agent.post_turn.actions.inferred', {
    message: makeMessage(),
    response: makeResponse(),
    actions: [makeAction({
      kind: 'memory.sleeptime.run',
      maxRetries: 0,
      ...overrides,
    })],
  });
}

function readPersistedQueue(path: string): { version: number; entries: unknown[] } {
  return JSON.parse(readFileSync(path, 'utf-8')) as { version: number; entries: unknown[] };
}

function readQuarantineSidecar(path: string): Array<{
  entryNumber: number;
  error: string;
  raw: unknown;
}> {
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as {
      entryNumber: number;
      error: string;
      raw: unknown;
    });
}


describe('wirePostTurnActionRuntime', () => {
  beforeEach(() => {
    resetCompletionHandoffDedupeForTests();
    clearDiagnosticLogRingBufferForTests();
  });

  it('deduplicates queued actions and executes once after idle', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const agentLoop = {
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = wirePostTurnActionRuntime({
      eventBus,
      scheduler,
      agentLoop,
      intervalMs: 10,
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler('heartbeat.run_template', handler);

    const phases: string[] = [];
    eventBus.on('agent.post_turn.action.telemetry', ({ phase }) => {
      phases.push(phase);
    });

    await eventBus.emit('agent.post_turn.actions.inferred', {
      message: makeMessage(),
      response: makeResponse(),
      actions: [
        makeAction({ id: 'action-a', dedupeKey: 'dedupe:key' }),
        makeAction({ id: 'action-b', dedupeKey: 'dedupe:key' }),
      ],
    });

    expect(runtime.listQueued()).toHaveLength(1);

    await scheduler.tick();

    expect(agentLoop.waitForIdle).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(runtime.listQueued()).toHaveLength(0);
    expect(phases).toContain('queued');
    expect(phases).toContain('deduplicated');
    expect(phases).toContain('started');
    expect(phases).toContain('succeeded');
  });

  it('durably coalesces watermark-backed demand onto the newest trigger cursor', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_500);
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-post-turn-coalescing-'));
    const persistencePath = join(tempDir, 'queue.json');
    try {
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const runtime = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop: { waitForIdle: vi.fn().mockResolvedValue(undefined) },
        intervalMs: 1,
        persistencePath,
      });
      const handler = vi.fn().mockResolvedValue(undefined);
      runtime.registerHandler('memory.episode-synthesis.run', handler, {
        runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
        coalescing: 'dedupe_key_with_durable_watermark',
      });

      expect(runtime.enqueue(makeAction({
        id: 'synthesis-trigger-a',
        kind: 'memory.episode-synthesis.run',
        dedupeKey: 'memory.episode-synthesis.run:session-a',
        sourceMessageId: 'message-a',
        inferredAt: 1_700_000_000_100,
        runAt: 1_700_000_001_000,
      }))).toBe('queued');
      expect(runtime.enqueue(makeAction({
        id: 'synthesis-trigger-b',
        kind: 'memory.episode-synthesis.run',
        dedupeKey: 'memory.episode-synthesis.run:session-a',
        sourceMessageId: 'message-b',
        inferredAt: 1_700_000_000_400,
        runAt: 1_700_000_001_000,
      }))).toBe('coalesced');

      expect(runtime.getStatus()).toMatchObject({
        queueDepth: 1,
        coalescing: {
          coalescedCount: 1,
        },
        queued: [{
          actionId: 'synthesis-trigger-b',
          inferredAt: 1_700_000_000_100,
          coalescedCount: 1,
          coverageThroughInferredAt: 1_700_000_000_400,
          latestSourceMessageId: 'message-b',
          successorPending: false,
        }],
      });
      expect(readPersistedQueue(persistencePath).version).toBe(2);

      const restartedBus = new EventBus();
      const restartedScheduler = new Scheduler(restartedBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const restarted = wirePostTurnActionRuntime({
        eventBus: restartedBus,
        scheduler: restartedScheduler,
        agentLoop: { waitForIdle: vi.fn().mockResolvedValue(undefined) },
        intervalMs: 1,
        persistencePath,
      });
      const restartedHandler = vi.fn().mockResolvedValue(undefined);
      restarted.registerHandler('memory.episode-synthesis.run', restartedHandler, {
        runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
        coalescing: 'dedupe_key_with_durable_watermark',
      });
      expect(restarted.getStatus().queued[0]).toMatchObject({
        actionId: 'synthesis-trigger-b',
        coalescedCount: 1,
        coverageThroughInferredAt: 1_700_000_000_400,
      });

      nowSpy.mockReturnValue(1_700_000_001_001);
      await restartedScheduler.tick();
      expect(restartedHandler).toHaveBeenCalledOnce();
      expect(restartedHandler.mock.calls[0]?.[0]).toMatchObject({
        id: 'synthesis-trigger-b',
        sourceMessageId: 'message-b',
      });
      expect(restarted.getStatus().queueDepth).toBe(0);
    } finally {
      nowSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('retains a watermark-backed successor trigger that arrives while its predecessor runs', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const firstRun = createDeferred<void>();
    const handledIds: string[] = [];
    const runtime = wirePostTurnActionRuntime({
      eventBus,
      scheduler,
      agentLoop: { waitForIdle: vi.fn().mockResolvedValue(undefined) },
      intervalMs: 1,
    });
    runtime.registerHandler('memory.episode-synthesis.run', async (action) => {
      handledIds.push(action.id);
      if (action.id === 'running-trigger') {
        await firstRun.promise;
      }
    }, {
      runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
      coalescing: 'dedupe_key_with_durable_watermark',
    });

    expect(runtime.enqueue(makeAction({
      id: 'running-trigger',
      kind: 'memory.episode-synthesis.run',
      dedupeKey: 'memory.episode-synthesis.run:session-a',
      inferredAt: 1,
    }))).toBe('queued');
    const firstTick = scheduler.tick();
    await vi.waitFor(() => expect(handledIds).toEqual(['running-trigger']));

    expect(runtime.enqueue(makeAction({
      id: 'successor-trigger',
      kind: 'memory.episode-synthesis.run',
      dedupeKey: 'memory.episode-synthesis.run:session-a',
      sourceMessageId: 'successor-message',
      // Deliberately older than the running action's inference timestamp:
      // arrival during execution, not wall-clock ordering, requires a successor.
      inferredAt: 0,
    }))).toBe('coalesced');
    expect(runtime.getStatus().queued[0]).toMatchObject({
      actionId: 'running-trigger',
      coalescedCount: 1,
      coverageThroughInferredAt: 1,
      latestSourceMessageId: 'successor-message',
      successorPending: true,
    });

    firstRun.resolve(undefined);
    await firstTick;
    expect(runtime.getStatus().queued[0]).toMatchObject({
      actionId: 'successor-trigger',
      successorPending: false,
    });

    await scheduler.tick();
    expect(handledIds).toEqual(['running-trigger', 'successor-trigger']);
    expect(runtime.getStatus().queueDepth).toBe(0);
  });

  it('rejects a cross-kind dedupe collision instead of falsely coalescing distinct work', () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const runtime = wirePostTurnActionRuntime({
      eventBus,
      scheduler,
      agentLoop: { waitForIdle: vi.fn().mockResolvedValue(undefined) },
    });
    runtime.registerHandler('memory.episode-synthesis.run', vi.fn(), {
      runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
      coalescing: 'dedupe_key_with_durable_watermark',
    });
    runtime.enqueue(makeAction({
      id: 'reflection-action',
      kind: 'heartbeat.run_template',
      dedupeKey: 'colliding-key',
    }));

    expect(() => runtime.enqueue(makeAction({
      id: 'synthesis-action',
      kind: 'memory.episode-synthesis.run',
      dedupeKey: 'colliding-key',
    }))).toThrow(/dedupe key collision/i);
    expect(runtime.listQueued()).toEqual([
      expect.objectContaining({ actionId: 'reflection-action', actionKind: 'heartbeat.run_template' }),
    ]);
  });

  it('waits for foreground handlers to reach agent idle before executing', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const idleGate = createDeferred<void>();
    const agentLoop = {
      waitForIdle: vi.fn().mockImplementation(() => idleGate.promise),
    };
    const runtime = wirePostTurnActionRuntime({
      eventBus,
      scheduler,
      agentLoop,
      intervalMs: 10,
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler('heartbeat.run_template', handler);

    await eventBus.emit('agent.post_turn.actions.inferred', {
      message: makeMessage(),
      response: makeResponse(),
      actions: [makeAction({ id: 'foreground-action', dedupeKey: 'foreground:key' })],
    });

    const tickPromise = scheduler.tick();
    await Promise.resolve();

    expect(agentLoop.waitForIdle).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    expect(runtime.getStatus()).toMatchObject({
      processing: true,
      queueDepth: 1,
      runningCount: 1,
      queued: [
        expect.objectContaining({
          actionId: 'foreground-action',
          state: 'running',
        }),
      ],
    });

    idleGate.resolve(undefined);
    await tickPromise;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(runtime.listQueued()).toHaveLength(0);
  });

  it('awaits foreground idle for a maintenance_reflection action even when the handler declares background execution', async () => {
    // Regression (mmo9.5.2): the overlap decision is owned by the lane profile
    // (RuntimeLaneBudgetProfile.requiresForegroundIdle), not by the handler's
    // executionMode. maintenance_reflection requires foreground idle, so a
    // 'heartbeat.run_template' action MUST wait even though its handler declared
    // executionMode:'background'. Before the fix this asserted NOT called.
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const idleGate = createDeferred<void>();
    const agentLoop = {
      waitForIdle: vi.fn().mockImplementation(() => idleGate.promise),
    };
    const runtime = wirePostTurnActionRuntime({
      eventBus,
      scheduler,
      agentLoop,
      intervalMs: 10,
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler('heartbeat.run_template', handler, {
      executionMode: 'background',
    });

    await eventBus.emit('agent.post_turn.actions.inferred', {
      message: makeMessage(),
      response: makeResponse(),
      actions: [makeAction({ id: 'maintenance-action', dedupeKey: 'maintenance:key' })],
    });

    const tickPromise = scheduler.tick();
    await Promise.resolve();

    // Idle wait is in progress and the handler is blocked behind it.
    expect(agentLoop.waitForIdle).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();

    idleGate.resolve(undefined);
    await tickPromise;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(runtime.listQueued()).toHaveLength(0);
  });

  it('runs a post_turn_appraisal action without waiting for agent idle', async () => {
    // The post_turn_appraisal lane sets requiresForegroundIdle=false, so the
    // action must run immediately without blocking on foreground idle.
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const idleGate = createDeferred<void>();
    const agentLoop = {
      waitForIdle: vi.fn().mockImplementation(() => idleGate.promise),
    };
    const runtime = wirePostTurnActionRuntime({
      eventBus,
      scheduler,
      agentLoop,
      intervalMs: 10,
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler('intention.follow_up', handler, {
      executionMode: 'background',
    });

    const phases: string[] = [];
    eventBus.on('agent.post_turn.action.telemetry', ({ phase }) => {
      phases.push(phase);
    });

    await eventBus.emit('agent.post_turn.actions.inferred', {
      message: makeMessage(),
      response: makeResponse(),
      actions: [makeAction({
        id: 'appraisal-action',
        kind: 'intention.follow_up',
        dedupeKey: 'intention.follow_up:appraisal',
        payload: {},
      })],
    });

    await scheduler.tick();

    expect(agentLoop.waitForIdle).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(runtime.listQueued()).toHaveLength(0);
    expect(phases).toEqual(expect.arrayContaining(['queued', 'started', 'succeeded']));
  });

  it('rejects registering a foreground handler on a lane that does not require foreground idle', () => {
    // Consistency guard against silent re-drift: declaring executionMode
    // 'foreground' on a non-idle lane (post_turn_appraisal) must fail closed at
    // registration time.
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const runtime = wirePostTurnActionRuntime({
      eventBus,
      scheduler,
      agentLoop: { waitForIdle: vi.fn().mockResolvedValue(undefined) },
      intervalMs: 10,
    });

    expect(() => runtime.registerHandler('intention.follow_up', vi.fn(), {
      executionMode: 'foreground',
    })).toThrow(/requiresForegroundIdle=false/);

    // A foreground handler on the maintenance_reflection lane is consistent and allowed.
    expect(() => runtime.registerHandler('heartbeat.run_template', vi.fn(), {
      executionMode: 'foreground',
    })).not.toThrow();
  });

  it('retains maintenance demand beyond the runnable admission window and eventually drains it', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_350_000);
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const runtime = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop: {
          waitForIdle: vi.fn().mockResolvedValue(undefined),
        },
        intervalMs: 10,
      });
      const handler = vi.fn().mockResolvedValue(undefined);
      runtime.registerHandler('heartbeat.run_template', handler, {
        executionMode: 'background',
      });

      const phases: Array<{ phase: string; dedupeKey: string; runtimeClass: string; chargeLane: string }> = [];
      eventBus.on('agent.post_turn.action.telemetry', (telemetry) => {
        phases.push({
          phase: telemetry.phase,
          dedupeKey: telemetry.dedupeKey,
          runtimeClass: telemetry.runtimeClass,
          chargeLane: telemetry.chargeLane,
        });
      });

      await eventBus.emit('agent.post_turn.actions.inferred', {
        message: makeMessage(),
        response: makeResponse(),
        actions: [0, 1, 2, 3].map((index) => makeAction({
          id: `maintenance-${index}`,
          dedupeKey: `maintenance:${index}`,
          inferredAt: 1_700_000_350_000 + index,
        })),
      });

      expect(runtime.listQueued().map((entry) => entry.dedupeKey)).toEqual([
        'maintenance:0',
        'maintenance:1',
        'maintenance:2',
        'maintenance:3',
      ]);
      expect(runtime.listQueued().map((entry) => entry.runtimeClass)).toEqual([
        MAINTENANCE_REFLECTION_RUNTIME_CLASS,
        MAINTENANCE_REFLECTION_RUNTIME_CLASS,
        MAINTENANCE_REFLECTION_RUNTIME_CLASS,
        MAINTENANCE_REFLECTION_RUNTIME_CLASS,
      ]);
      expect(runtime.getActionStatus('maintenance:3')).toMatchObject({
        state: 'deferred',
      });
      expect(phases.filter(({ phase }) => phase === 'dropped_budget')).toEqual([]);
      expect(getRecentDiagnosticLogRecords().filter(({ level }) => level === 'warn')).toEqual([]);

      for (let tick = 0; tick < 4; tick += 1) {
        nowSpy.mockReturnValue(1_700_000_350_100 + tick * 100);
        await scheduler.tick();
      }
      expect(handler.mock.calls.map(([action]) => action.id)).toEqual([
        'maintenance-0',
        'maintenance-1',
        'maintenance-2',
        'maintenance-3',
      ]);
      expect(runtime.listQueued()).toEqual([]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reports overflow maintenance demand as deferred instead of dropped', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_355_000);
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const runtime = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop: {
          waitForIdle: vi.fn().mockResolvedValue(undefined),
        },
        intervalMs: 10,
      });

      const telemetry: Array<{ phase: string; dedupeKey: string; queueDepth: number }> = [];
      eventBus.on('agent.post_turn.action.telemetry', (event) => {
        telemetry.push({
          phase: event.phase,
          dedupeKey: event.dedupeKey,
          queueDepth: event.queueDepth,
        });
      });

      await eventBus.emit('agent.post_turn.actions.inferred', {
        message: makeMessage(),
        response: makeResponse(),
        actions: [1, 2, 3].map((index) => makeAction({
          id: `maintenance-${index}`,
          dedupeKey: `maintenance:${index}`,
          inferredAt: 1_700_000_355_000 + index,
        })),
      });

      await eventBus.emit('agent.post_turn.actions.inferred', {
        message: makeMessage(),
        response: makeResponse(),
        actions: [
          makeAction({
            id: 'maintenance-old',
            dedupeKey: 'maintenance:old',
            inferredAt: 1_700_000_354_000,
          }),
        ],
      });

      expect(runtime.listQueued().map((entry) => entry.dedupeKey)).toEqual([
        'maintenance:1',
        'maintenance:2',
        'maintenance:3',
        'maintenance:old',
      ]);
      expect(telemetry.filter(({ phase }) => phase === 'dropped_budget')).toEqual([]);
      expect(telemetry).toEqual(expect.arrayContaining([
        expect.objectContaining({
          phase: 'queued',
          dedupeKey: 'maintenance:old',
        }),
      ]));

      const maintenanceLane = runtime.getStatus().lanes.find(
        (lane) => lane.runtimeClass === MAINTENANCE_REFLECTION_RUNTIME_CLASS,
      );
      expect(runtime.getStatus()).toMatchObject({
        queueDepth: 4,
        maxQueueDepth: 19,
        saturated: true,
        backPressure: {
          droppedCount: 0,
          recentDrops: [],
        },
      });
      expect(maintenanceLane).toMatchObject({
        queueDepth: 4,
        maxQueuedActions: 3,
        availableSlots: 0,
        saturated: true,
        deferredCount: 1,
        droppedCount: 0,
        oldestDeferredAt: 1_700_000_355_003,
      });
      expect(runtime.getActionStatus('maintenance:3')).toMatchObject({ state: 'deferred' });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('prioritizes appraisal before continuation before maintenance and enforces per-class tick budgets', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_360_000);
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const runtime = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop: {
          waitForIdle: vi.fn().mockResolvedValue(undefined),
        },
        intervalMs: 10,
      });
      const callOrder: string[] = [];
      runtime.registerHandler('intention.follow_up', vi.fn(async (action) => {
        callOrder.push(`appraisal:${action.id}`);
      }), {
        executionMode: 'background',
      });
      runtime.registerHandler(POST_TURN_SUBAGENT_SPAWN_ACTION_KIND, vi.fn(async (action) => {
        callOrder.push(`continuation:${action.id}`);
      }), {
        executionMode: 'background',
      });
      runtime.registerHandler('heartbeat.run_template', vi.fn(async (action) => {
        callOrder.push(`maintenance:${action.id}`);
      }), {
        executionMode: 'background',
      });

      await eventBus.emit('agent.post_turn.actions.inferred', {
        message: makeMessage(),
        response: makeResponse(),
        actions: [
          makeAction({
            id: 'maintenance-1',
            kind: 'heartbeat.run_template',
            dedupeKey: 'maintenance:one',
          }),
          makeAction({
            id: 'continuation-1',
            kind: POST_TURN_SUBAGENT_SPAWN_ACTION_KIND,
            dedupeKey: 'continuation:one',
          }),
          makeAction({
            id: 'continuation-2',
            kind: POST_TURN_SUBAGENT_SPAWN_ACTION_KIND,
            dedupeKey: 'continuation:two',
          }),
          makeAction({
            id: 'appraisal-1',
            kind: 'intention.follow_up',
            dedupeKey: 'appraisal:one',
          }),
        ],
      });

      await scheduler.tick();

      expect(callOrder).toEqual([
        'appraisal:appraisal-1',
        'continuation:continuation-1',
        'maintenance:maintenance-1',
      ]);
      expect(runtime.listQueued()).toEqual([
        expect.objectContaining({
          actionId: 'continuation-2',
          dedupeKey: 'continuation:two',
          runtimeClass: BACKGROUND_CONTINUATION_RUNTIME_CLASS,
        }),
      ]);

      nowSpy.mockReturnValue(1_700_000_360_051);
      await scheduler.tick();
      expect(callOrder).toEqual([
        'appraisal:appraisal-1',
        'continuation:continuation-1',
        'maintenance:maintenance-1',
        'continuation:continuation-2',
      ]);
      expect(runtime.listQueued()).toHaveLength(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('lets handlers reschedule an action without consuming retry attempts', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_000_000);

      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const runtime = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop: {
          waitForIdle: vi.fn().mockResolvedValue(undefined),
        },
        intervalMs: 1,
      });
      const handler = vi.fn().mockResolvedValue({
        detail: 'quiet_hours',
        rescheduleAt: 1_700_000_060_000,
      });
      runtime.registerHandler('heartbeat.run_template', handler, {
        executionMode: 'background',
      });

      const phases: string[] = [];
      eventBus.on('agent.post_turn.action.telemetry', ({ phase }) => {
        phases.push(phase);
      });

      await eventBus.emit('agent.post_turn.actions.inferred', {
        message: makeMessage(),
        response: makeResponse(),
        actions: [
          makeAction({
            id: 'reschedule-action',
            dedupeKey: 'reschedule:key',
            maxRetries: 1,
          }),
        ],
      });

      await scheduler.tick();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(runtime.getStatus()).toMatchObject({
        queueDepth: 1,
        scheduledCount: 1,
        queued: [
          expect.objectContaining({
            actionId: 'reschedule-action',
            state: 'scheduled',
            attempt: 0,
            maxAttempts: 2,
            nextRunAt: 1_700_000_060_000,
          }),
        ],
      });
      expect(phases).toContain('rescheduled');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reschedules a preempted background continuation without consuming its attempt', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_000_000);

      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const runtime = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop: {
          waitForIdle: vi.fn().mockResolvedValue(undefined),
        },
        intervalMs: 1,
        baseRetryDelayMs: 100,
        maxRetryDelayMs: 100,
      });
      const handler = vi.fn()
        .mockRejectedValueOnce(new ModelCallPreemptedError(
          'registered_model::local_endpoint',
          BACKGROUND_CONTINUATION_RUNTIME_CLASS,
          'post_turn_appraisal',
        ))
        .mockResolvedValueOnce(undefined);
      runtime.registerHandler(POST_TURN_SUBAGENT_SPAWN_ACTION_KIND, handler, {
        executionMode: 'background',
      });

      const phases: string[] = [];
      eventBus.on('agent.post_turn.action.telemetry', ({ phase }) => {
        phases.push(phase);
      });

      await eventBus.emit('agent.post_turn.actions.inferred', {
        message: makeMessage(),
        response: makeResponse(),
        actions: [
          makeSubagentSpawnAction({
            id: 'preempted-continuation',
            dedupeKey: 'continuation:preempted',
            maxRetries: 0,
          }),
        ],
      });

      await scheduler.tick();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(runtime.getStatus()).toMatchObject({
        queueDepth: 1,
        scheduledCount: 1,
        queued: [
          expect.objectContaining({
            actionId: 'preempted-continuation',
            state: 'scheduled',
            attempt: 0,
            maxAttempts: 1,
            nextRunAt: 1_700_000_000_100,
          }),
        ],
      });
      expect(phases).toContain('rescheduled');
      expect(phases).not.toContain('failed');

      nowSpy.mockReturnValue(1_700_000_000_100);
      await scheduler.tick();

      expect(handler).toHaveBeenCalledTimes(2);
      expect(runtime.listQueued()).toHaveLength(0);
      expect(phases).toContain('succeeded');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reschedules an agent-busy rejection without consuming its attempt', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_000_000);
      const handler = vi.fn()
        .mockRejectedValueOnce(new Error(
          'Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.',
        ))
        .mockResolvedValueOnce(undefined);
      const { eventBus, scheduler, runtime, phases } = createSleeptimeContentionHarness(handler);
      await enqueueSleeptimeAction(eventBus, {
        id: 'busy-sleeptime',
        dedupeKey: 'memory.sleeptime.run:test-channel',
      });

      await scheduler.tick();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(runtime.getStatus()).toMatchObject({
        queueDepth: 1,
        scheduledCount: 1,
        queued: [
          expect.objectContaining({
            actionId: 'busy-sleeptime',
            state: 'scheduled',
            attempt: 0,
            maxAttempts: 1,
            nextRunAt: 1_700_000_000_100,
          }),
        ],
        failures: { failedCount: 0 },
      });
      expect(phases).toContain('rescheduled');
      expect(phases).not.toContain('retry_scheduled');
      expect(phases).not.toContain('failed');

      nowSpy.mockReturnValue(1_700_000_000_100);
      await scheduler.tick();

      expect(handler).toHaveBeenCalledTimes(2);
      expect(runtime.listQueued()).toHaveLength(0);
      expect(phases).toContain('succeeded');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('eventually completes sleeptime after sustained foreground contention', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      let nowMs = 1_700_000_000_000;
      nowSpy.mockImplementation(() => nowMs);
      const busyError = new Error('Agent is already processing a prompt.');
      const handler = vi.fn()
        .mockRejectedValueOnce(busyError)
        .mockRejectedValueOnce(busyError)
        .mockRejectedValueOnce(busyError)
        .mockRejectedValueOnce(busyError)
        .mockResolvedValueOnce(undefined);
      const { eventBus, scheduler, runtime } = createSleeptimeContentionHarness(handler);
      await enqueueSleeptimeAction(eventBus, {
        id: 'contended-sleeptime',
        dedupeKey: 'memory.sleeptime.run:contended',
      });

      for (let collision = 0; collision < 4; collision += 1) {
        await scheduler.tick();
        expect(runtime.getStatus()).toMatchObject({
          queueDepth: 1,
          queued: [expect.objectContaining({ attempt: 0 })],
          failures: { failedCount: 0 },
        });
        nowMs += 100;
      }

      await scheduler.tick();

      expect(handler).toHaveBeenCalledTimes(5);
      expect(runtime.listQueued()).toHaveLength(0);
      expect(runtime.getStatus()).toMatchObject({
        failures: { failedCount: 0 },
        completions: { completedCount: 1 },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('retries failures with bounded attempts and then marks failed', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_000_000);

      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const agentLoop = {
        waitForIdle: vi.fn().mockResolvedValue(undefined),
      };
      const runtime = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop,
        intervalMs: 1,
        baseRetryDelayMs: 100,
        maxRetryDelayMs: 100,
      });
      const handler = vi
        .fn()
        .mockRejectedValueOnce(new Error('first failure'))
        .mockRejectedValueOnce(new Error('Database is already processing a migration'));
      runtime.registerHandler('heartbeat.run_template', handler);

      const phases: string[] = [];
      eventBus.on('agent.post_turn.action.telemetry', ({ phase }) => {
        phases.push(phase);
      });

      await eventBus.emit('agent.post_turn.actions.inferred', {
        message: makeMessage(),
        response: makeResponse(),
        actions: [
          makeAction({
            id: 'retry-action',
            dedupeKey: 'retry:key',
            maxRetries: 1,
          }),
        ],
      });

      nowSpy.mockReturnValue(1_700_000_000_001);
      await scheduler.tick();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(runtime.listQueued()).toHaveLength(1);
      expect(runtime.getStatus()).toMatchObject({
        queueDepth: 1,
        retryScheduledCount: 1,
        queued: [
          expect.objectContaining({
            actionId: 'retry-action',
            state: 'retry_scheduled',
            attempt: 1,
            maxAttempts: 2,
            runAfterMs: 100,
          }),
        ],
      });

      nowSpy.mockReturnValue(1_700_000_000_050);
      await scheduler.tick();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(runtime.listQueued()).toHaveLength(1);

      nowSpy.mockReturnValue(1_700_000_000_101);
      await scheduler.tick();
      expect(handler).toHaveBeenCalledTimes(2);
      expect(runtime.listQueued()).toHaveLength(0);
      expect(phases).toContain('retry_scheduled');
      expect(phases).toContain('failed');
      expect(runtime.getStatus()).toMatchObject({
        queueDepth: 0,
        failures: {
          failedCount: 1,
          recentFailures: [
            expect.objectContaining({
              actionId: 'retry-action',
              reason: 'retries_exhausted',
              attempt: 2,
              maxAttempts: 2,
              error: 'Error: Database is already processing a migration',
            }),
          ],
        },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('restores the retryable-failure count with a durable retry checkpoint', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-post-turn-retry-restart-'));
    const persistencePath = join(tempDir, 'queue.json');

    try {
      nowSpy.mockReturnValue(1_700_000_000_000);
      const firstBus = new EventBus();
      const firstScheduler = new Scheduler(firstBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const firstRuntime = wirePostTurnActionRuntime({
        eventBus: firstBus,
        scheduler: firstScheduler,
        agentLoop: { waitForIdle: vi.fn().mockResolvedValue(undefined) },
        intervalMs: 1,
        baseRetryDelayMs: 100,
        maxRetryDelayMs: 100,
        persistencePath,
      });
      firstRuntime.registerHandler(
        'heartbeat.run_template',
        vi.fn().mockRejectedValue(new Error('retry after restart')),
      );
      await firstBus.emit('agent.post_turn.actions.inferred', {
        message: makeMessage(),
        response: makeResponse(),
        actions: [makeAction({
          id: 'retry-before-restart',
          dedupeKey: 'retry:before-restart',
          maxRetries: 1,
        })],
      });

      await firstScheduler.tick();
      expect(firstRuntime.getStatus()).toMatchObject({
        retryScheduledCount: 1,
        failures: { retryableFailureCount: 1 },
      });

      const restartedBus = new EventBus();
      const restartedScheduler = new Scheduler(restartedBus, {
          tickIntervalMs: 100,
          heartbeatIntervalMs: 1_000,
      });
      const restartedRuntime = wirePostTurnActionRuntime({
        eventBus: restartedBus,
        scheduler: restartedScheduler,
        agentLoop: { waitForIdle: vi.fn().mockResolvedValue(undefined) },
        intervalMs: 1,
        persistencePath,
      });
      expect(restartedRuntime.getStatus()).toMatchObject({
        retryScheduledCount: 1,
        failures: { retryableFailureCount: 1 },
        queued: [expect.objectContaining({
          actionId: 'retry-before-restart',
          attempt: 1,
          state: 'retry_scheduled',
        })],
      });
    } finally {
      nowSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('defers execution until runAt is due', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_100_000);
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const agentLoop = {
        waitForIdle: vi.fn().mockResolvedValue(undefined),
      };
      const runtime = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop,
        intervalMs: 1,
      });
      const handler = vi.fn().mockResolvedValue(undefined);
      runtime.registerHandler('heartbeat.run_template', handler);

      await eventBus.emit('agent.post_turn.actions.inferred', {
        message: makeMessage(),
        response: makeResponse(),
        actions: [
          makeAction({
            id: 'scheduled-action',
            dedupeKey: 'scheduled:key',
            runAt: 1_700_000_100_500,
          }),
        ],
      });

      expect(runtime.listQueued()[0]?.nextRunAt).toBe(1_700_000_100_500);

      nowSpy.mockReturnValue(1_700_000_100_499);
      await scheduler.tick();
      expect(handler).toHaveBeenCalledTimes(0);
      expect(runtime.listQueued()).toHaveLength(1);

      nowSpy.mockReturnValue(1_700_000_100_550);
      await scheduler.tick();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(runtime.listQueued()).toHaveLength(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('cancels queued autonomous actions without running handlers', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const runtime = wirePostTurnActionRuntime({
      eventBus,
      scheduler,
      agentLoop: {
        waitForIdle: vi.fn().mockResolvedValue(undefined),
      },
      intervalMs: 1,
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler('intention.follow_up', handler, {
      executionMode: 'background',
    });

    const phases: string[] = [];
    eventBus.on('agent.post_turn.action.telemetry', ({ phase }) => {
      phases.push(phase);
    });

    await eventBus.emit('agent.post_turn.actions.inferred', {
      message: makeMessage(),
      response: makeResponse(),
      actions: [
        makeAction({
          id: 'cancel-me',
          kind: 'intention.follow_up',
          dedupeKey: 'proactive:cancel-me',
          runAt: Date.now() + 1_000,
        }),
      ],
    });

    expect(runtime.cancel('cancel-me', 'operator cancelled stale proactive action')).toBe(true);
    expect(runtime.cancel('cancel-me')).toBe(false);
    await scheduler.tick();

    expect(handler).not.toHaveBeenCalled();
    expect(runtime.listQueued()).toHaveLength(0);
    expect(phases).toEqual(expect.arrayContaining(['queued', 'cancelled']));
    expect(runtime.getStatus()).toMatchObject({
      queueDepth: 0,
      terminal: {
        cancelledCount: 1,
        acknowledgedCount: 0,
        recentTerminals: [
          expect.objectContaining({
            actionId: 'cancel-me',
            dedupeKey: 'proactive:cancel-me',
            reason: 'cancelled',
            detail: 'operator cancelled stale proactive action',
          }),
        ],
      },
    });
  });

  it('acknowledges queued autonomous actions as handled without execution', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const runtime = wirePostTurnActionRuntime({
      eventBus,
      scheduler,
      agentLoop: {
        waitForIdle: vi.fn().mockResolvedValue(undefined),
      },
      intervalMs: 1,
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler('intention.follow_up', handler, {
      executionMode: 'background',
    });

    await eventBus.emit('agent.post_turn.actions.inferred', {
      message: makeMessage(),
      response: makeResponse(),
      actions: [
        makeAction({
          id: 'ack-me',
          kind: 'intention.follow_up',
          dedupeKey: 'proactive:ack-me',
        }),
      ],
    });

    expect(runtime.acknowledge('proactive:ack-me', 'operator acknowledged proactive suggestion')).toBe(true);
    await scheduler.tick();

    expect(handler).not.toHaveBeenCalled();
    expect(runtime.listQueued()).toHaveLength(0);
    expect(runtime.getStatus()).toMatchObject({
      terminal: {
        cancelledCount: 0,
        acknowledgedCount: 1,
        recentTerminals: [
          expect.objectContaining({
            actionId: 'ack-me',
            dedupeKey: 'proactive:ack-me',
            reason: 'acknowledged',
            detail: 'operator acknowledged proactive suggestion',
          }),
        ],
      },
    });
  });

  it('fails closed on malformed inferred action events', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const runtime = wirePostTurnActionRuntime({
      eventBus,
      scheduler,
      agentLoop: {
        waitForIdle: vi.fn().mockResolvedValue(undefined),
      },
      intervalMs: 1,
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler('heartbeat.run_template', handler);

    const phases: string[] = [];
    eventBus.on('agent.post_turn.action.telemetry', ({ phase }) => {
      phases.push(phase);
    });

    await eventBus.emit('agent.post_turn.actions.inferred', {
      message: makeMessage(),
      response: makeResponse(),
      actions: [
        makeAction({ id: 'valid-after-malformed', dedupeKey: 'valid:after-malformed' }),
        {
          id: 'bad-action',
          kind: 'heartbeat.run_template',
          dedupeKey: '',
          channelId: 'test-channel',
          sourceMessageId: 'msg-1',
          inferredAt: 'not-a-number',
        },
      ],
    });

    expect(runtime.listQueued()).toEqual([
      expect.objectContaining({
        actionId: 'valid-after-malformed',
        dedupeKey: 'valid:after-malformed',
      }),
    ]);
    expect(phases).toContain('malformed_dropped');
    expect(runtime.getStatus()).toMatchObject({
      failures: {
        failedCount: 1,
        recentFailures: [
          expect.objectContaining({
            actionId: 'malformed',
            reason: 'malformed_action',
            error: 'Invalid inferred post-turn action payload',
          }),
        ],
      },
    });

    await scheduler.tick();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('persists overflow maintenance demand and reloads all of it on runtime restart', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-post-turn-actions-'));
    const persistencePath = join(tempDir, 'queue.json');

    try {
      nowSpy.mockReturnValue(1_700_000_200_000);
      const firstBus = new EventBus();
      const firstScheduler = new Scheduler(firstBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const firstRuntime = wirePostTurnActionRuntime({
        eventBus: firstBus,
        scheduler: firstScheduler,
        agentLoop: {
          waitForIdle: vi.fn().mockResolvedValue(undefined),
        },
        intervalMs: 1,
        persistencePath,
      });
      firstRuntime.registerHandler('heartbeat.run_template', vi.fn().mockResolvedValue(undefined));

      await firstBus.emit('agent.post_turn.actions.inferred', {
        message: makeMessage(),
        response: makeResponse(),
        actions: Array.from({ length: 5 }, (_, index) => (
          makeAction({
            id: `persisted-action-${index}`,
            dedupeKey: `persisted:key:${index}`,
            inferredAt: 1_700_000_200_000 + index,
            runAt: 1_700_000_200_300,
          })
        )),
      });

      const persistedBeforeRestart = readPersistedQueue(persistencePath);
      expect(persistedBeforeRestart.version).toBe(2);
      expect(persistedBeforeRestart.entries).toHaveLength(5);

      const secondBus = new EventBus();
      const secondScheduler = new Scheduler(secondBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const secondRuntime = wirePostTurnActionRuntime({
        eventBus: secondBus,
        scheduler: secondScheduler,
        agentLoop: {
          waitForIdle: vi.fn().mockResolvedValue(undefined),
        },
        intervalMs: 1,
        persistencePath,
      });
      const secondHandler = vi.fn().mockResolvedValue(undefined);
      secondRuntime.registerHandler('heartbeat.run_template', secondHandler);

      expect(secondRuntime.listQueued()).toHaveLength(5);
      expect(secondRuntime.listQueued()[0]?.nextRunAt).toBe(1_700_000_200_300);
      expect(secondRuntime.getActionStatus('persisted:key:3')).toMatchObject({ state: 'deferred' });
      expect(secondRuntime.getActionStatus('persisted:key:4')).toMatchObject({ state: 'deferred' });

      nowSpy.mockReturnValue(1_700_000_200_250);
      await secondScheduler.tick();
      expect(secondHandler).toHaveBeenCalledTimes(0);

      for (let tick = 0; tick < 5; tick += 1) {
        nowSpy.mockReturnValue(1_700_000_200_301 + tick * 100);
        await secondScheduler.tick();
      }
      expect(secondHandler.mock.calls.map(([action]) => action.id)).toEqual([
        'persisted-action-0',
        'persisted-action-1',
        'persisted-action-2',
        'persisted-action-3',
        'persisted-action-4',
      ]);

      const persistedAfterDrain = readPersistedQueue(persistencePath);
      expect(persistedAfterDrain.entries).toHaveLength(0);
    } finally {
      nowSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails a direct enqueue before exposing work when queue persistence fails', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-post-turn-enqueue-failure-'));
    const nonDirectoryParent = join(tempDir, 'not-a-directory');
    const persistencePath = join(nonDirectoryParent, 'queue.json');
    writeFileSync(nonDirectoryParent, 'occupied', 'utf-8');

    try {
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const runtime = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop: { waitForIdle: vi.fn().mockResolvedValue(undefined) },
        persistencePath,
      });

      expect(() => runtime.enqueue(makeAction({
        id: 'durable-enqueue',
        dedupeKey: 'durable:enqueue',
      }))).toThrow();
      expect(runtime.listQueued()).toHaveLength(0);
      expect(runtime.getStatus().persistence.lastPersistError).toBeTruthy();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('executes restored companion outreach through the real handler with an empty adaptive overlay cache', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_250_000);
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-post-turn-outreach-restart-'));
    const persistencePath = join(tempDir, 'queue.json');
    const actionKind = 'notify.companion_outreach';
    try {
      const firstBus = new EventBus();
      const firstScheduler = new Scheduler(firstBus, {
        tickIntervalMs: 5,
        heartbeatIntervalMs: 1_000,
      });
      wirePostTurnActionRuntime({
        eventBus: firstBus,
        scheduler: firstScheduler,
        agentLoop: { waitForIdle: vi.fn().mockResolvedValue(undefined) },
        intervalMs: 1,
        persistencePath,
      });
      await firstBus.emit('agent.post_turn.actions.inferred', {
        message: makeMessage(),
        response: makeResponse(),
        actions: [makeAction({
          id: 'persisted-companion-outreach',
          kind: actionKind,
          payload: {
            contactId: 'contact-b',
            permitId: COMPANION_OUTREACH_PERMIT_ID,
            candidateOrigin: {
              candidateId: '11111111-1111-4111-8111-111111111111',
              rootInitiationId: '22222222-2222-4222-8222-222222222222',
              source: 'intention',
              provenanceRef: 'icp-prov:11111111-1111-4111-8111-111111111111',
              continuationTaskKind: 'research',
            },
            authorization: COMPANION_OUTREACH_AUTHORIZATION,
          },
          dedupeKey: `${actionKind}:fingerprint`,
          runAt: 1_700_000_250_000,
        })],
      });

      const restartedBus = new EventBus();
      const restartedScheduler = new Scheduler(restartedBus, {
        tickIntervalMs: 5,
        heartbeatIntervalMs: 1_000,
      });
      const restartedRuntime = wirePostTurnActionRuntime({
        eventBus: restartedBus,
        scheduler: restartedScheduler,
        agentLoop: { waitForIdle: vi.fn().mockResolvedValue(undefined) },
        intervalMs: 1,
        persistencePath,
      });
      const executeCompanionOutreach = vi.fn().mockResolvedValue(undefined);
      const restartedAdaptiveState = { activeTools: [] as Array<{ toolName: string }> };
      const authorizationRuntime: DeferredCompanionOutreachAuthorizationRuntime = {
        hasExternalCompanionCapability: () => true,
        isNotifyToolRegistered: () => true,
      };
      const dispose = registerDeferredCompanionOutreachRuntime({
        agentLoop: {},
        postTurnActions: restartedRuntime,
        runtime: { executeCompanionOutreach } as never,
        resolveOriginCatalogSource: () => null,
        isExecutionAuthorized: evidence => isDeferredCompanionOutreachExecutionAuthorized(
          evidence,
          authorizationRuntime,
        ),
      });
      restartedScheduler.start();
      try {
        await vi.waitFor(() => expect(executeCompanionOutreach).toHaveBeenCalledOnce());
      } finally {
        await restartedScheduler.stop();
        dispose();
      }

      expect(restartedAdaptiveState.activeTools).toEqual([]);
      expect(executeCompanionOutreach).toHaveBeenCalledWith(
        'contact-b',
        COMPANION_OUTREACH_PERMIT_ID,
        expect.objectContaining({
          candidateId: '11111111-1111-4111-8111-111111111111',
          continuationTaskKind: 'research',
        }),
        expect.any(Function),
      );
      expect(readPersistedQueue(persistencePath).entries).toHaveLength(0);
    } finally {
      nowSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed when persisted queue entries are invalid', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-post-turn-actions-invalid-'));
    const persistencePath = join(tempDir, 'queue.json');
    const quarantinePath = `${persistencePath}.quarantine`;
    writeFileSync(persistencePath, JSON.stringify({
      version: 1,
      entries: [{
        action: {
          id: 'invalid-action',
          kind: 'heartbeat.run_template',
          payload: { templateId: 'musing' },
          dedupeKey: 'invalid:key',
          channelId: 'test-channel',
          sourceMessageId: 'msg-1',
          inferredAt: 1_700_000_300_000,
        },
        attempt: 0,
        nextRunAt: 'not-a-timestamp',
        maxRetries: 1,
      }],
    }), 'utf-8');

    try {
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const agentLoop = {
        waitForIdle: vi.fn().mockResolvedValue(undefined),
      };
      const runtime = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop,
        intervalMs: 10,
        persistencePath,
      });
      const handler = vi.fn().mockResolvedValue(undefined);
      runtime.registerHandler('heartbeat.run_template', handler);

      expect(runtime.listQueued()).toHaveLength(0);
      expect(runtime.getStatus()).toMatchObject({
        persistence: {
          enabled: true,
          path: persistencePath,
          quarantinePath,
          loadState: 'loaded',
          loadedEntries: 0,
          quarantinedEntries: 1,
          quarantinePersisted: true,
        },
        quarantine: {
          count: 1,
          persisted: true,
          entries: [
            expect.objectContaining({
              entryNumber: 1,
              error: 'Invalid deferred post-turn action queue entry payload',
            }),
          ],
        },
      });
      expect(existsSync(quarantinePath)).toBe(true);
      expect(readQuarantineSidecar(quarantinePath)).toEqual([
        expect.objectContaining({
          entryNumber: 1,
          error: 'Invalid deferred post-turn action queue entry payload',
          raw: expect.objectContaining({
            action: expect.objectContaining({
              id: 'invalid-action',
            }),
            nextRunAt: 'not-a-timestamp',
          }),
        }),
      ]);
      expect(readPersistedQueue(persistencePath).entries).toHaveLength(0);
      await scheduler.tick();
      expect(handler).not.toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads valid persisted queue entries and quarantines invalid entries during hydrate', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-post-turn-actions-mixed-'));
    const persistencePath = join(tempDir, 'queue.json');
    const quarantinePath = `${persistencePath}.quarantine`;

    try {
      nowSpy.mockReturnValue(1_700_000_400_000);
      writeFileSync(persistencePath, JSON.stringify({
        version: 1,
        entries: [
          {
            action: {
              id: 'valid-action',
              kind: 'heartbeat.run_template',
              payload: { templateId: 'musing' },
              dedupeKey: 'valid:key',
              channelId: 'test-channel',
              sourceMessageId: 'msg-1',
              inferredAt: 1_700_000_399_000,
            },
            runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
            attempt: 0,
            nextRunAt: 1_700_000_400_000,
            maxRetries: 1,
          },
          {
            action: {
              id: 'invalid-action',
              kind: 'heartbeat.run_template',
              payload: { templateId: 'musing' },
              dedupeKey: 'invalid:key',
              channelId: 'test-channel',
              sourceMessageId: 'msg-1',
              inferredAt: 1_700_000_399_100,
            },
            attempt: 0,
            nextRunAt: 'not-a-timestamp',
            maxRetries: 1,
          },
        ],
      }), 'utf-8');

      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const agentLoop = {
        waitForIdle: vi.fn().mockResolvedValue(undefined),
      };
      const runtime = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop,
        intervalMs: 10,
        persistencePath,
      });
      const handler = vi.fn().mockResolvedValue(undefined);
      runtime.registerHandler('heartbeat.run_template', handler);

      expect(runtime.listQueued()).toEqual([
        expect.objectContaining({
          actionId: 'valid-action',
          dedupeKey: 'valid:key',
          runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
          attempt: 0,
          maxAttempts: 2,
        }),
      ]);
      expect(existsSync(quarantinePath)).toBe(true);
      expect(readQuarantineSidecar(quarantinePath)).toEqual([
        expect.objectContaining({
          entryNumber: 2,
          error: 'Invalid deferred post-turn action queue entry payload',
          raw: expect.objectContaining({
            action: expect.objectContaining({
              id: 'invalid-action',
            }),
            nextRunAt: 'not-a-timestamp',
          }),
        }),
      ]);
      const migratedQueue = readPersistedQueue(persistencePath);
      expect(migratedQueue.version).toBe(2);
      expect(migratedQueue.entries).toEqual([
        expect.objectContaining({
          demandStartedAt: 1_700_000_399_000,
          coverageThroughInferredAt: 1_700_000_399_000,
          coalescedCount: 0,
        }),
      ]);

      await scheduler.tick();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(runtime.listQueued()).toHaveLength(0);
    } finally {
      nowSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('cancels queued post-turn subagent spawn actions before execution and exposes terminal status', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const runtime = wirePostTurnActionRuntime({
      eventBus,
      scheduler,
      agentLoop: {
        waitForIdle: vi.fn().mockResolvedValue(undefined),
      },
      intervalMs: 1,
    });
    await eventBus.emit('agent.post_turn.actions.inferred', {
      message: makeMessage(),
      response: makeResponse(),
      actions: [
        makeSubagentSpawnAction({
          id: 'spawn-cancelled',
          dedupeKey: `${POST_TURN_SUBAGENT_SPAWN_ACTION_KIND}:cancelled`,
          runAt: Date.now() + 10_000,
        }),
      ],
    });

    expect(runtime.cancel('spawn-cancelled', 'operator cancelled background spawn')).toBe(true);
    await scheduler.tick();

    expect(runtime.getActionStatus('spawn-cancelled')).toMatchObject({
      state: 'cancelled',
      cancellable: false,
      capability: 'subagent_spawn',
      detail: 'operator cancelled background spawn',
    });
    expect(runtime.getStatus()).toMatchObject({
      terminal: {
        cancelledCount: 1,
        recentTerminals: [
          expect.objectContaining({
            actionId: 'spawn-cancelled',
            capability: 'subagent_spawn',
            reason: 'cancelled',
          }),
        ],
      },
    });
  });

  it('blocks deferred actions when eligibility denies required capabilities', async () => {
    const eventBus = new EventBus();
    const handoffEvents: Array<Record<string, any>> = [];
    eventBus.on('agent.completion_handoff', event => {
      handoffEvents.push(event as Record<string, any>);
    });
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const agentLoop = {
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };
    const eligibilityGate = createEligibilityGate(() => ({
      getTier: () => 'custom',
      getGrantedTokens: () => new Set(),
      has: () => false,
    }));
    const runtime = wirePostTurnActionRuntime({
      eventBus,
      scheduler,
      agentLoop,
      eligibilityGate,
      intervalMs: 10,
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler('heartbeat.run_template', handler);

    const phases: string[] = [];
    eventBus.on('agent.post_turn.action.telemetry', ({ phase }) => {
      phases.push(phase);
    });

    await eventBus.emit('agent.post_turn.actions.inferred', {
      message: makeMessage(),
      response: makeResponse(),
      actions: [makeAction({ id: 'blocked-action', dedupeKey: 'blocked:key' })],
    });

    await scheduler.tick();
    await Promise.resolve();

    expect(handler).not.toHaveBeenCalled();
    expect(runtime.listQueued()).toHaveLength(0);
    expect(phases).toContain('failed');
    expect(handoffEvents).toHaveLength(1);
    expect(handoffEvents[0]).toMatchObject({
      noticeBuffered: false,
      handoff: expect.objectContaining({
        status: 'blocked',
        blocker: expect.objectContaining({ reason: 'eligibility_denied' }),
        privacy: expect.objectContaining({
          partnerNotification: 'companion_mediated_only',
        }),
      }),
    });
  });
});
