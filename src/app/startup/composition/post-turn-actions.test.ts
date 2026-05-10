import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { AgentResponse, InferredPostTurnAction, SubstrateMessage } from '../../../shared/contracts/runtime.js';
import { EventBus } from '../../../shared/event-bus.js';
import {
  BACKGROUND_CONTINUATION_RUNTIME_CLASS,
  MAINTENANCE_REFLECTION_RUNTIME_CLASS,
} from '../../../core/agent/worker-lanes.js';
import { createEligibilityGate } from '../../../system/capabilities/eligibility.js';
import { Scheduler } from '../../../core/scheduler/scheduler.js';
import {
  POST_TURN_SUBAGENT_SPAWN_ACTION_KIND,
  registerPostTurnSubagentSpawnRuntime,
  wirePostTurnActionRuntime,
} from './post-turn-actions.js';

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

  it('runs background-capable handlers without waiting for agent idle', async () => {
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

    const phases: string[] = [];
    eventBus.on('agent.post_turn.action.telemetry', ({ phase }) => {
      phases.push(phase);
    });

    await eventBus.emit('agent.post_turn.actions.inferred', {
      message: makeMessage(),
      response: makeResponse(),
      actions: [makeAction({ id: 'background-action', dedupeKey: 'background:key' })],
    });

    await scheduler.tick();

    expect(agentLoop.waitForIdle).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(runtime.listQueued()).toHaveLength(0);
    expect(phases).toEqual(expect.arrayContaining(['queued', 'started', 'succeeded']));
  });

  it('drops oldest maintenance work when the maintenance lane queue budget is exceeded', async () => {
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
      runtime.registerHandler('heartbeat.run_template', vi.fn().mockResolvedValue(undefined), {
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
        'maintenance:1',
        'maintenance:2',
        'maintenance:3',
      ]);
      expect(runtime.listQueued().map((entry) => entry.runtimeClass)).toEqual([
        MAINTENANCE_REFLECTION_RUNTIME_CLASS,
        MAINTENANCE_REFLECTION_RUNTIME_CLASS,
        MAINTENANCE_REFLECTION_RUNTIME_CLASS,
      ]);
      expect(phases).toEqual(expect.arrayContaining([
        expect.objectContaining({
          phase: 'dropped_budget',
          dedupeKey: 'maintenance:0',
          runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
          chargeLane: 'maintenance',
        }),
      ]));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps queue status truthful when back-pressure rejects a newly inferred action', async () => {
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
      ]);
      expect(telemetry).toEqual(expect.arrayContaining([
        expect.objectContaining({
          phase: 'dropped_budget',
          dedupeKey: 'maintenance:old',
          queueDepth: 3,
        }),
      ]));
      expect(telemetry).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          phase: 'queued',
          dedupeKey: 'maintenance:old',
        }),
      ]));

      const maintenanceLane = runtime.getStatus().lanes.find(
        (lane) => lane.runtimeClass === MAINTENANCE_REFLECTION_RUNTIME_CLASS,
      );
      expect(runtime.getStatus()).toMatchObject({
        queueDepth: 3,
        maxQueueDepth: 19,
        saturated: true,
        backPressure: {
          droppedCount: 1,
          recentDrops: [
            expect.objectContaining({
              dedupeKey: 'maintenance:old',
              queueDepth: 3,
              maxQueuedActions: 3,
              backPressureMode: 'defer_until_idle',
            }),
          ],
        },
      });
      expect(maintenanceLane).toMatchObject({
        queueDepth: 3,
        maxQueuedActions: 3,
        availableSlots: 0,
        saturated: true,
        droppedCount: 1,
        lastDrop: expect.objectContaining({
          dedupeKey: 'maintenance:old',
        }),
      });
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
      runtime.registerHandler('tool_handoff.continue', vi.fn(async (action) => {
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
            kind: 'tool_handoff.continue',
            dedupeKey: 'continuation:one',
          }),
          makeAction({
            id: 'continuation-2',
            kind: 'tool_handoff.continue',
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
        .mockRejectedValueOnce(new Error('second failure'));
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
              error: 'Error: second failure',
            }),
          ],
        },
      });
    } finally {
      nowSpy.mockRestore();
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

  it('persists queued actions and reloads them on runtime restart', async () => {
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
        actions: [
          makeAction({
            id: 'persisted-action',
            dedupeKey: 'persisted:key',
            runAt: 1_700_000_200_300,
          }),
        ],
      });

      const persistedBeforeRestart = readPersistedQueue(persistencePath);
      expect(persistedBeforeRestart.version).toBe(1);
      expect(persistedBeforeRestart.entries).toHaveLength(1);

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

      expect(secondRuntime.listQueued()).toHaveLength(1);
      expect(secondRuntime.listQueued()[0]?.nextRunAt).toBe(1_700_000_200_300);

      nowSpy.mockReturnValue(1_700_000_200_250);
      await secondScheduler.tick();
      expect(secondHandler).toHaveBeenCalledTimes(0);

      nowSpy.mockReturnValue(1_700_000_200_301);
      await secondScheduler.tick();
      expect(secondHandler).toHaveBeenCalledTimes(1);

      const persistedAfterDrain = readPersistedQueue(persistencePath);
      expect(persistedAfterDrain.entries).toHaveLength(0);
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
      expect(readPersistedQueue(persistencePath).entries).toHaveLength(1);

      await scheduler.tick();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(runtime.listQueued()).toHaveLength(0);
    } finally {
      nowSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('routes post-turn subagent spawn actions through explicit policy and records status', async () => {
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
    const executeSubagent = vi.fn(async () => ({
      subagentId: 'subagent-1',
      name: 'research',
      content: 'finished',
      model: 'mock-model',
      inputTokens: 11,
      outputTokens: 13,
      durationMs: 37,
      turns: 2,
      lifecycleState: 'ready' as const,
      health: 'healthy' as const,
      stateReason: 'completed',
      capabilities: ['analysis'],
      requiredCapabilities: ['analysis'],
    }));
    registerPostTurnSubagentSpawnRuntime({
      postTurnActions: runtime,
      subagentExecutionPort: { executeSubagent },
    });

    await eventBus.emit('agent.post_turn.actions.inferred', {
      message: makeMessage(),
      response: makeResponse(),
      actions: [makeSubagentSpawnAction()],
    });

    expect(runtime.listQueued()).toEqual([
      expect.objectContaining({
        actionId: 'spawn-action-1',
        actionKind: POST_TURN_SUBAGENT_SPAWN_ACTION_KIND,
        capability: 'subagent_spawn',
        runtimeClass: BACKGROUND_CONTINUATION_RUNTIME_CLASS,
      }),
    ]);
    expect(runtime.getActionStatus('spawn-action-1')).toMatchObject({
      state: 'ready',
      cancellable: true,
      capability: 'subagent_spawn',
      queuedSubagentSpawn: {
        requestName: 'research',
        policyMode: 'post_turn_action_pipe',
        policyAllowed: true,
        budgetMaxTurns: 2,
        requestedMaxTurns: 2,
      },
    });

    await scheduler.tick();

    expect(executeSubagent).toHaveBeenCalledWith({
      name: 'research',
      task: 'inspect the logs',
      maxTurns: 2,
      capabilities: ['analysis'],
      requiredCapabilities: ['analysis'],
    });
    expect(runtime.listQueued()).toHaveLength(0);
    expect(runtime.getActionStatus('spawn-action-1')).toMatchObject({
      state: 'succeeded',
      cancellable: false,
      detail: 'subagent research completed with ready/healthy',
      subagentSpawn: {
        subagentId: 'subagent-1',
        name: 'research',
        lifecycleState: 'ready',
        health: 'healthy',
        stateReason: 'completed',
        model: 'mock-model',
        inputTokens: 11,
        outputTokens: 13,
        durationMs: 37,
        turns: 2,
      },
    });
    expect(runtime.getStatus()).toMatchObject({
      completions: {
        completedCount: 1,
        recentCompletions: [
          expect.objectContaining({
            actionId: 'spawn-action-1',
            capability: 'subagent_spawn',
            subagentSpawn: expect.objectContaining({
              subagentId: 'subagent-1',
            }),
          }),
        ],
      },
    });
  });

  it('rejects malformed post-turn subagent spawn actions without invoking the port', async () => {
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
    const executeSubagent = vi.fn();
    registerPostTurnSubagentSpawnRuntime({
      postTurnActions: runtime,
      subagentExecutionPort: { executeSubagent },
    });

    await eventBus.emit('agent.post_turn.actions.inferred', {
      message: makeMessage(),
      response: makeResponse(),
      actions: [
        makeSubagentSpawnAction({
          id: 'spawn-missing-policy',
          dedupeKey: `${POST_TURN_SUBAGENT_SPAWN_ACTION_KIND}:missing-policy`,
          payload: {
            request: {
              name: 'research',
              task: 'inspect the logs',
            },
          },
        }),
      ],
    });

    await scheduler.tick();

    expect(executeSubagent).not.toHaveBeenCalled();
    expect(runtime.listQueued()).toHaveLength(0);
    expect(runtime.getActionStatus('spawn-missing-policy')).toMatchObject({
      state: 'failed',
      capability: 'subagent_spawn',
      detail: 'Error: Post-turn subagent spawn requires explicit policy.',
    });
    expect(runtime.getStatus()).toMatchObject({
      failures: {
        failedCount: 1,
        recentFailures: [
          expect.objectContaining({
            actionId: 'spawn-missing-policy',
            capability: 'subagent_spawn',
            reason: 'retries_exhausted',
          }),
        ],
      },
    });
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
    const executeSubagent = vi.fn();
    registerPostTurnSubagentSpawnRuntime({
      postTurnActions: runtime,
      subagentExecutionPort: { executeSubagent },
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

    expect(executeSubagent).not.toHaveBeenCalled();
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

    expect(handler).not.toHaveBeenCalled();
    expect(runtime.listQueued()).toHaveLength(0);
    expect(phases).toContain('failed');
  });
});
