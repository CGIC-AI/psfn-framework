import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { AgentResponse, InferredPostTurnAction, SubstrateMessage } from '../types.js';
import { EventBus } from '../event-bus.js';
import { createEligibilityGate } from '../capabilities/eligibility.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { wirePostTurnActionRuntime } from './post-turn-actions.js';

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

function readPersistedQueue(path: string): { version: number; entries: unknown[] } {
  return JSON.parse(readFileSync(path, 'utf-8')) as { version: number; entries: unknown[] };
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
      await scheduler.tick();
      expect(handler).not.toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
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
