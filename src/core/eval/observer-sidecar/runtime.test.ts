import { describe, expect, it, vi } from 'vitest';
import type { TurnID } from '../../turns/types.js';
import {
  dispatchObserverEvalTurn,
  drainObserverEvalSidecarQueue,
  getObserverEvalSidecarHealthSnapshot,
  shutdownObserverEvalSidecar,
} from './runtime.js';
import type {
  ObserverEvalInput,
  ObserverEvalInputPayload,
  ObserverEvalLifecycleState,
  ObserverEvalSidecarRuntime,
} from './types.js';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

function makeInput(sequence = 1): ObserverEvalInputPayload {
  return {
    schemaVersion: 1,
    turn: {
      turnId: `turn-${sequence}` as TurnID,
      requestId: `request-${sequence}`,
      sourceMessageId: `message-${sequence}`,
      channelId: 'channel-1',
      channelType: 'api',
      messageTimestampMs: 1_774_115_200_000 + sequence,
    },
    source: {
      routingSource: 'api',
      isDirectMessage: true,
      channelPrivacy: 'private',
    },
    emotion: {
      snapshot: null,
      appraisalEntryCount: 0,
    },
    metadata: {
      trustLevel: 'regular',
      speakerRole: 'user',
      contactResolved: true,
      contentLength: 12,
      attachmentCount: 0,
      hasVisionInput: false,
    },
    provenance: {
      seam: 'substrate-agent.pre-turn.emotion-observed',
      capturedAt: 1_774_115_200_000 + sequence,
      emotionSessionId: 'channel-1',
      emotionSnapshotSource: 'observeEmotionState',
      correlation: {
        callType: 'chat',
        purpose: 'agent.turn',
      },
    },
  };
}

describe('observer eval sidecar queue runtime', () => {
  it('enqueues and returns before observer work settles', async () => {
    const observerCompletion = createDeferred<void>();
    const observeTurn = vi.fn((_input: ObserverEvalInput) => observerCompletion.promise);
    const runtime: ObserverEvalSidecarRuntime = {
      config: { enabled: true, sidecarId: 'observer-test' },
      observer: { observeTurn },
    };

    const state = await dispatchObserverEvalTurn({
      sidecarRuntime: runtime,
      input: makeInput(),
    });

    expect(state).toMatchObject({
      status: 'enabled',
      sidecarId: 'observer-test',
      reason: 'queued',
    });
    expect(observeTurn).not.toHaveBeenCalled();

    let drainSettled = false;
    const drainPromise = drainObserverEvalSidecarQueue(runtime).then(snapshot => {
      drainSettled = true;
      return snapshot;
    });
    await flushAsyncWork();

    expect(observeTurn).toHaveBeenCalledTimes(1);
    expect(drainSettled).toBe(false);

    observerCompletion.resolve();
    const snapshot = await drainPromise;

    expect(snapshot.status).toBe('enabled');
    expect(snapshot.counts).toMatchObject({
      accepted: 1,
      completed: 1,
      dropped: 0,
      failed: 0,
      timedOut: 0,
    });
  });

  it('records observer throws as degraded sidecar health without rejecting dispatch', async () => {
    const lifecycleStates: ObserverEvalLifecycleState[] = [];
    const observeTurn = vi.fn(() => {
      throw new Error('sidecar exploded');
    });
    const runtime: ObserverEvalSidecarRuntime = {
      config: { enabled: true, sidecarId: 'observer-test' },
      observer: { observeTurn },
      onLifecycleState: vi.fn((state: ObserverEvalLifecycleState) => {
        lifecycleStates.push(state);
      }),
    };

    await expect(dispatchObserverEvalTurn({
      sidecarRuntime: runtime,
      input: makeInput(),
    })).resolves.toMatchObject({ status: 'enabled', reason: 'queued' });
    const snapshot = await drainObserverEvalSidecarQueue(runtime);

    expect(observeTurn).toHaveBeenCalledTimes(1);
    expect(snapshot.status).toBe('degraded');
    expect(snapshot.counts.failed).toBe(1);
    expect(snapshot.failureCounts.observer_failed).toBe(1);
    expect(snapshot.lastFailure).toMatchObject({
      reason: 'observer_failed',
      message: 'Observer eval sidecar error redacted',
      requestId: 'request-1',
    });
    expect(lifecycleStates.map(state => state.reason)).toEqual([
      'queued',
      'observer_failed',
    ]);
  });

  it('records observer timeouts as degraded health', async () => {
    const lifecycleStates: ObserverEvalLifecycleState[] = [];
    const observeTurn = vi.fn(() => new Promise<void>(() => undefined));
    const runtime: ObserverEvalSidecarRuntime = {
      config: {
        enabled: true,
        sidecarId: 'observer-test',
        queue: { observerTimeoutMs: 0 },
      },
      observer: { observeTurn },
      onLifecycleState: vi.fn((state: ObserverEvalLifecycleState) => {
        lifecycleStates.push(state);
      }),
    };

    await dispatchObserverEvalTurn({
      sidecarRuntime: runtime,
      input: makeInput(),
    });
    const snapshot = await drainObserverEvalSidecarQueue(runtime);

    expect(observeTurn).toHaveBeenCalledTimes(1);
    expect(snapshot.status).toBe('degraded');
    expect(snapshot.counts.timedOut).toBe(1);
    expect(snapshot.failureCounts.observer_timeout).toBe(1);
    expect(snapshot.lastFailure).toMatchObject({
      reason: 'observer_timeout',
      requestId: 'request-1',
    });
    expect(lifecycleStates.at(-1)).toMatchObject({
      status: 'degraded',
      reason: 'observer_timeout',
    });
  });

  it('drops overflow observations and keeps drop reasons in health', async () => {
    const observeTurn = vi.fn();
    const runtime: ObserverEvalSidecarRuntime = {
      config: {
        enabled: true,
        sidecarId: 'observer-test',
        queue: { maxQueuedTurns: 1 },
      },
      observer: { observeTurn },
    };

    const accepted = await dispatchObserverEvalTurn({
      sidecarRuntime: runtime,
      input: makeInput(1),
    });
    const dropped = await dispatchObserverEvalTurn({
      sidecarRuntime: runtime,
      input: makeInput(2),
    });

    expect(accepted).toMatchObject({ status: 'enabled', reason: 'queued' });
    expect(dropped).toMatchObject({
      status: 'degraded',
      reason: 'queue_full',
      drop: { reason: 'queue_full', droppedCount: 1 },
    });
    expect(observeTurn).not.toHaveBeenCalled();

    const snapshot = await drainObserverEvalSidecarQueue(runtime);

    expect(observeTurn).toHaveBeenCalledTimes(1);
    expect(snapshot.status).toBe('degraded');
    expect(snapshot.counts).toMatchObject({
      accepted: 1,
      completed: 1,
      dropped: 1,
    });
    expect(snapshot.dropCounts.queue_full).toBe(1);
    expect(snapshot.lastDrop).toMatchObject({
      reason: 'queue_full',
      requestId: 'request-2',
    });
  });

  it('reports disabled and unavailable runtimes without creating queue work', async () => {
    const observeTurn = vi.fn();
    const disabledRuntime: ObserverEvalSidecarRuntime = {
      config: { enabled: false, sidecarId: 'disabled-sidecar' },
      observer: { observeTurn },
    };
    const unavailableRuntime: ObserverEvalSidecarRuntime = {
      config: { enabled: true, sidecarId: 'missing-sidecar' },
      observer: null,
    };

    await expect(dispatchObserverEvalTurn({
      sidecarRuntime: disabledRuntime,
      input: makeInput(),
    })).resolves.toMatchObject({
      status: 'disabled',
      reason: 'config_disabled',
    });
    await expect(dispatchObserverEvalTurn({
      sidecarRuntime: unavailableRuntime,
      input: makeInput(),
    })).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'observer_not_configured',
    });

    expect(observeTurn).not.toHaveBeenCalled();
    expect(getObserverEvalSidecarHealthSnapshot(disabledRuntime)).toMatchObject({
      status: 'disabled',
      counts: { accepted: 0 },
    });
    expect(getObserverEvalSidecarHealthSnapshot(unavailableRuntime)).toMatchObject({
      status: 'unavailable',
      counts: { accepted: 0 },
    });
  });

  it('drains queued observations during shutdown and drops later enqueue attempts', async () => {
    const firstCompletion = createDeferred<void>();
    const secondCompletion = createDeferred<void>();
    let observerCallIndex = 0;
    const observeTurn = vi.fn(() => {
      observerCallIndex += 1;
      if (observerCallIndex === 1) {
        return firstCompletion.promise;
      }
      return secondCompletion.promise;
    });
    const runtime: ObserverEvalSidecarRuntime = {
      config: {
        enabled: true,
        sidecarId: 'observer-test',
        queue: { maxQueuedTurns: 2 },
      },
      observer: { observeTurn },
    };

    await dispatchObserverEvalTurn({
      sidecarRuntime: runtime,
      input: makeInput(1),
    });
    await dispatchObserverEvalTurn({
      sidecarRuntime: runtime,
      input: makeInput(2),
    });

    const shutdownPromise = shutdownObserverEvalSidecar(runtime, { drain: true, timeoutMs: 1_000 });
    await flushAsyncWork();

    expect(observeTurn).toHaveBeenCalledTimes(1);
    firstCompletion.resolve();

    await vi.waitFor(() => {
      expect(observeTurn).toHaveBeenCalledTimes(2);
    });
    secondCompletion.resolve();

    const shutdownSnapshot = await shutdownPromise;
    expect(shutdownSnapshot).toMatchObject({
      status: 'unavailable',
      accepting: false,
      queue: {
        queuedCount: 0,
        runningCount: 0,
        shuttingDown: true,
      },
      counts: {
        accepted: 2,
        completed: 2,
        dropped: 0,
      },
    });

    const droppedAfterShutdown = await dispatchObserverEvalTurn({
      sidecarRuntime: runtime,
      input: makeInput(3),
    });
    const finalSnapshot = getObserverEvalSidecarHealthSnapshot(runtime);

    expect(droppedAfterShutdown).toMatchObject({
      status: 'degraded',
      reason: 'shutting_down',
      drop: { reason: 'shutting_down', droppedCount: 1 },
    });
    expect(finalSnapshot.status).toBe('degraded');
    expect(finalSnapshot.dropCounts.shutting_down).toBe(1);
  });
});
