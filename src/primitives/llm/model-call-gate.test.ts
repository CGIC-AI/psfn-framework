import { describe, expect, it, vi } from 'vitest';

import {
  ModelCallGate,
  ModelCallPreemptedError,
  type ModelCallGateCapacity,
  type ModelCallPreemptionTelemetry,
} from './model-call-gate.js';
import {
  BACKGROUND_CONTINUATION_RUNTIME_CLASS,
  FOREGROUND_CHAT_RUNTIME_CLASS,
  MAINTENANCE_REFLECTION_RUNTIME_CLASS,
  POST_TURN_APPRAISAL_RUNTIME_CLASS,
} from '../../core/agent/worker-lanes.js';

const RESOURCE = 'registered_model::local_endpoint';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

/**
 * An execute body that signals when it has started, then blocks until either it
 * is released or its gate-owned preempt signal aborts.
 */
function blockingExecute(): {
  started: Promise<void>;
  release: () => void;
  aborted: () => boolean;
  abortReason: () => unknown;
  run: (preemptSignal: AbortSignal) => Promise<string>;
} {
  const startedDeferred = deferred();
  const releaseDeferred = deferred();
  let abortReason: unknown;
  return {
    started: startedDeferred.promise,
    release: () => releaseDeferred.resolve(),
    aborted: () => abortReason !== undefined,
    abortReason: () => abortReason,
    run: async (preemptSignal: AbortSignal) => {
      startedDeferred.resolve();
      await new Promise<void>((resolve, reject) => {
        void releaseDeferred.promise.then(resolve);
        if (preemptSignal.aborted) {
          abortReason = preemptSignal.reason;
          reject(preemptSignal.reason);
          return;
        }
        preemptSignal.addEventListener('abort', () => {
          abortReason = preemptSignal.reason;
          reject(preemptSignal.reason);
        }, { once: true });
      });
      return 'completed';
    },
  };
}

describe('ModelCallGate preemption and capacity', () => {
  // Regression (mmo9.5.1): before capacity/preemption, acquire() granted only
  // when the single boolean slot was free, so a foreground voice acquire waited
  // behind an in-flight background extraction. This asserts the foreground call
  // STARTS AND COMPLETES before the (blocked) background call completes.
  it('preempts an in-flight background call so foreground starts before background completes', async () => {
    const gate = new ModelCallGate();
    const background = blockingExecute();
    const backgroundPromise = gate.run(
      { resourceKey: RESOURCE, runtimeClass: BACKGROUND_CONTINUATION_RUNTIME_CLASS },
      background.run,
    );
    await background.started;

    let foregroundStarted = false;
    const foregroundResult = await gate.run(
      { resourceKey: RESOURCE, runtimeClass: FOREGROUND_CHAT_RUNTIME_CLASS },
      async () => { foregroundStarted = true; return 'foreground'; },
    );

    expect(foregroundStarted).toBe(true);
    expect(foregroundResult).toBe('foreground');
    // The background call is aborted with the typed preemption error (never a
    // generic abort), so callers can map it to a supervisor defer.
    await expect(backgroundPromise).rejects.toBeInstanceOf(ModelCallPreemptedError);
    expect(background.aborted()).toBe(true);
  });

  it('emits preemption telemetry with reason, resourceKey and preempted lane', async () => {
    const events: ModelCallPreemptionTelemetry[] = [];
    const gate = new ModelCallGate({ onPreemption: (event) => events.push(event) });
    const background = blockingExecute();
    const backgroundPromise = gate.run(
      { resourceKey: RESOURCE, runtimeClass: BACKGROUND_CONTINUATION_RUNTIME_CLASS },
      background.run,
    );
    await background.started;
    await gate.run(
      { resourceKey: RESOURCE, runtimeClass: FOREGROUND_CHAT_RUNTIME_CLASS },
      async () => 'foreground',
    );
    await expect(backgroundPromise).rejects.toBeInstanceOf(ModelCallPreemptedError);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: 'higher_priority_acquire',
      resourceKey: RESOURCE,
      preemptedRuntimeClass: BACKGROUND_CONTINUATION_RUNTIME_CLASS,
      preemptorRuntimeClass: FOREGROUND_CHAT_RUNTIME_CLASS,
    });
    expect(typeof events[0]!.waitedMs).toBe('number');
  });

  // mmo9.7.4: a welfare-escalated background call declares preemptionProtected so
  // the gate does not abort it — this is what breaks the preempt→defer→preempt
  // starvation loop. It is a per-call override of the SINGLE preemptable check,
  // not a second preemption policy (Law 12.4).
  it('does not preempt a preemption-protected background call (welfare escalation)', async () => {
    const gate = new ModelCallGate();
    const background = blockingExecute();
    const backgroundPromise = gate.run(
      { resourceKey: RESOURCE, runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS, preemptionProtected: true },
      background.run,
    );
    await background.started;

    // A foreground acquire that would normally preempt a maintenance-reflection
    // call now cannot; it parks behind the single slot instead of aborting the
    // aged welfare job.
    let foregroundStarted = false;
    const foregroundPromise = gate.run(
      { resourceKey: RESOURCE, runtimeClass: FOREGROUND_CHAT_RUNTIME_CLASS },
      async () => { foregroundStarted = true; return 'foreground'; },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(foregroundStarted).toBe(false);
    expect(background.aborted()).toBe(false);

    // The protected call runs to completion, then the parked foreground proceeds.
    background.release();
    await expect(backgroundPromise).resolves.toBe('completed');
    await expect(foregroundPromise).resolves.toBe('foreground');
    expect(background.aborted()).toBe(false);
  });

  // Control: the very same lane WITHOUT the per-call flag is still preemptable,
  // proving the override is per-call and not a lane policy change.
  it('still preempts an unprotected maintenance-reflection call in the same lane', async () => {
    const gate = new ModelCallGate();
    const background = blockingExecute();
    const backgroundPromise = gate.run(
      { resourceKey: RESOURCE, runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS },
      background.run,
    );
    await background.started;
    await gate.run(
      { resourceKey: RESOURCE, runtimeClass: FOREGROUND_CHAT_RUNTIME_CLASS },
      async () => 'foreground',
    );
    await expect(backgroundPromise).rejects.toBeInstanceOf(ModelCallPreemptedError);
    expect(background.aborted()).toBe(true);
  });

  it('grants a reserved foreground slot without preempting background (capacity 2, reserve 1)', async () => {
    const capacity: ModelCallGateCapacity = { capacity: 2, reservedForegroundSlots: 1 };
    const gate = new ModelCallGate();
    const background = blockingExecute();
    const backgroundPromise = gate.run(
      { resourceKey: RESOURCE, runtimeClass: BACKGROUND_CONTINUATION_RUNTIME_CLASS, capacity },
      background.run,
    );
    await background.started;

    // Foreground takes the reserved slot concurrently; background is untouched.
    const foregroundResult = await gate.run(
      { resourceKey: RESOURCE, runtimeClass: FOREGROUND_CHAT_RUNTIME_CLASS, capacity },
      async () => 'foreground',
    );
    expect(foregroundResult).toBe('foreground');
    expect(background.aborted()).toBe(false);

    background.release();
    await expect(backgroundPromise).resolves.toBe('completed');
  });

  it('parks a second background behind the reserved slot instead of using it (capacity 2, reserve 1)', async () => {
    const capacity: ModelCallGateCapacity = { capacity: 2, reservedForegroundSlots: 1 };
    const gate = new ModelCallGate();
    const first = blockingExecute();
    const firstPromise = gate.run(
      { resourceKey: RESOURCE, runtimeClass: BACKGROUND_CONTINUATION_RUNTIME_CLASS, capacity },
      first.run,
    );
    await first.started;

    let secondStarted = false;
    const secondPromise = gate.run(
      { resourceKey: RESOURCE, runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS, capacity },
      async () => { secondStarted = true; return 'second'; },
    );
    // Give the microtask queue a chance; the reserved slot must stay free.
    await Promise.resolve();
    expect(secondStarted).toBe(false);

    first.release();
    await expect(firstPromise).resolves.toBe('completed');
    await expect(secondPromise).resolves.toBe('second');
    expect(secondStarted).toBe(true);
  });

  it('never preempts a foreground call; a background acquire parks behind it', async () => {
    const gate = new ModelCallGate();
    const foreground = blockingExecute();
    const foregroundPromise = gate.run(
      { resourceKey: RESOURCE, runtimeClass: FOREGROUND_CHAT_RUNTIME_CLASS },
      foreground.run,
    );
    await foreground.started;

    let backgroundStarted = false;
    const backgroundPromise = gate.run(
      { resourceKey: RESOURCE, runtimeClass: BACKGROUND_CONTINUATION_RUNTIME_CLASS },
      async () => { backgroundStarted = true; return 'background'; },
    );
    await Promise.resolve();
    expect(backgroundStarted).toBe(false);
    expect(foreground.aborted()).toBe(false);

    foreground.release();
    await expect(foregroundPromise).resolves.toBe('completed');
    await expect(backgroundPromise).resolves.toBe('background');
    expect(backgroundStarted).toBe(true);
  });

  it('never preempts a non-preemptable lane (post_turn_appraisal) even for a higher-priority acquire', async () => {
    const gate = new ModelCallGate();
    const appraisal = blockingExecute();
    const appraisalPromise = gate.run(
      { resourceKey: RESOURCE, runtimeClass: POST_TURN_APPRAISAL_RUNTIME_CLASS },
      appraisal.run,
    );
    await appraisal.started;

    let foregroundStarted = false;
    const foregroundPromise = gate.run(
      { resourceKey: RESOURCE, runtimeClass: FOREGROUND_CHAT_RUNTIME_CLASS },
      async () => { foregroundStarted = true; return 'foreground'; },
    );
    await Promise.resolve();
    // post_turn_appraisal is not preemptable, so foreground must wait for it.
    expect(foregroundStarted).toBe(false);
    expect(appraisal.aborted()).toBe(false);

    appraisal.release();
    await expect(appraisalPromise).resolves.toBe('completed');
    await expect(foregroundPromise).resolves.toBe('foreground');
  });

  it('preempts the lowest-priority preemptable active call for a higher-priority background acquire', async () => {
    // capacity 1: a maintenance_reflection call is in-flight; a higher-priority
    // background_continuation acquire preempts it (both preemptable lanes).
    const gate = new ModelCallGate();
    const maintenance = blockingExecute();
    const maintenancePromise = gate.run(
      { resourceKey: RESOURCE, runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS },
      maintenance.run,
    );
    await maintenance.started;

    const continuationResult = await gate.run(
      { resourceKey: RESOURCE, runtimeClass: BACKGROUND_CONTINUATION_RUNTIME_CLASS },
      async () => 'continuation',
    );
    expect(continuationResult).toBe('continuation');
    await expect(maintenancePromise).rejects.toBeInstanceOf(ModelCallPreemptedError);
  });

  it('runs ungated (no resourceKey) calls immediately and concurrently', async () => {
    const gate = new ModelCallGate();
    const first = blockingExecute();
    const second = blockingExecute();
    const firstPromise = gate.run({ runtimeClass: BACKGROUND_CONTINUATION_RUNTIME_CLASS }, first.run);
    const secondPromise = gate.run({ runtimeClass: BACKGROUND_CONTINUATION_RUNTIME_CLASS }, second.run);
    await Promise.all([first.started, second.started]);
    // Both run without gating; releasing completes them.
    first.release();
    second.release();
    await expect(firstPromise).resolves.toBe('completed');
    await expect(secondPromise).resolves.toBe('completed');
  });

  it('rejects a waiting acquire when its caller signal aborts', async () => {
    const gate = new ModelCallGate();
    const foreground = blockingExecute();
    const foregroundPromise = gate.run(
      { resourceKey: RESOURCE, runtimeClass: FOREGROUND_CHAT_RUNTIME_CLASS },
      foreground.run,
    );
    await foreground.started;

    const controller = new AbortController();
    const waiting = blockingExecute();
    const waitingRun = vi.fn(waiting.run);
    const waitingPromise = gate.run(
      { resourceKey: RESOURCE, runtimeClass: FOREGROUND_CHAT_RUNTIME_CLASS, signal: controller.signal },
      waitingRun,
    );
    controller.abort();
    await expect(waitingPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(waitingRun).not.toHaveBeenCalled();

    foreground.release();
    await expect(foregroundPromise).resolves.toBe('completed');
  });
});
