import { describe, expect, it } from 'vitest';
import {
  createScreeningPool,
  ScreeningPoolCancelledError,
  ScreeningPoolDeadlineError,
  ScreeningPoolDisposedError,
  type ScreeningPoolTelemetryEvent,
} from './screening-pool.js';

// ── Test helpers ──

/** A promise the test resolves/rejects to release a gated work item. */
interface Gate {
  readonly promise: Promise<void>;
  release(): void;
  fail(error: unknown): void;
  isReleased: boolean;
}
function createGate(): Gate {
  let releaseFn: () => void = () => {};
  let failFn: (error: unknown) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    releaseFn = resolve;
    failFn = reject;
  });
  return {
    promise,
    release: () => releaseFn(),
    fail: (error) => failFn(error),
    isReleased: false,
  };
}

/** A gated work item that records its start and only settles when released. */
function gatedWork(gate: Gate, log: string[], label: string) {
  return (): Promise<string> => {
    log.push(`start:${label}`);
    return gate.promise.then(
      () => {
        log.push(`end:${label}`);
        return label;
      },
      (error) => {
        log.push(`end:${label}`);
        throw error;
      },
    );
  };
}

/** Resolves after a macrotask so the pool's microtask scheduler settles. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('createScreeningPool', () => {
  it('rejects invalid concurrency and queue depth at construction', () => {
    expect(() => createScreeningPool({ concurrency: 0, maxQueueDepth: 4 })).toThrow(/concurrency/);
    expect(() => createScreeningPool({ concurrency: 2, maxQueueDepth: 0 })).toThrow(/maxQueueDepth/);
  });

  it('bounds concurrent work to the worker count across independent streams', async () => {
    const concurrency = 3;
    let live = 0;
    let maxLive = 0;
    const gates = Array.from({ length: 6 }, () => createGate());
    const pool = createScreeningPool({ concurrency, maxQueueDepth: 16 });

    const works = gates.map((gate, index) => () => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      return gate.promise.then(() => {
        live -= 1;
        return index;
      });
    });

    // Six independent streams, each one item.
    const promises = works.map((work, index) => pool.run(`c${index}`, work));
    await flush();

    // Exactly `concurrency` are running; the rest are queued, never overlapping.
    expect(pool.stats().busyWorkers).toBe(concurrency);
    expect(maxLive).toBe(concurrency);
    expect(pool.stats().queueDepth).toBe(6 - concurrency);

    gates.forEach((gate) => gate.release());
    const results = await Promise.all(promises);
    expect(results.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pool.stats().busyWorkers).toBe(0);
    expect(pool.stats().queueDepth).toBe(0);
    await pool.dispose();
  });

  it('keeps same-stream decision and delivery order strictly serial', async () => {
    const pool = createScreeningPool({ concurrency: 4, maxQueueDepth: 16 });
    const log: string[] = [];
    const gates = ['A', 'B', 'C'].map((label) => {
      const gate = createGate();
      return { label, gate, work: gatedWork(gate, log, label) };
    });

    // Submit three items to ONE stream; they must start and finish in order even
    // though the pool has 4 free workers.
    const promises = gates.map((entry) => pool.run('same-stream', entry.work));
    await flush();

    // Only the first runs; the other two wait for their stream turn.
    expect(pool.stats().busyWorkers).toBe(1);
    expect(log).toEqual(['start:A']);

    gates[0].gate.release();
    await flush();
    expect(log).toEqual(['start:A', 'end:A', 'start:B']);
    gates[1].gate.release();
    await flush();
    expect(log).toEqual(['start:A', 'end:A', 'start:B', 'end:B', 'start:C']);
    gates[2].gate.release();
    const results = await Promise.all(promises);
    expect(results).toEqual(['A', 'B', 'C']);
    await pool.dispose();
  });

  it('schedules fairly: a flooding stream cannot block another stream worker', async () => {
    const pool = createScreeningPool({ concurrency: 2, maxQueueDepth: 32 });
    const floodGate = createGate();
    const otherGate = createGate();
    const started: string[] = [];

    // Flood stream A with several items; they serialize behind A1.
    const floodPromises = Array.from({ length: 4 }, (_, i) => pool.run('flood', () => {
      started.push(`flood${i}`);
      return floodGate.promise.then(() => `flood${i}`);
    }));
    await flush();
    // A1 holds the only flood slot; the rest are queued behind it.
    expect(started).toEqual(['flood0']);

    // A different companion submits one item; it must start on the free worker
    // immediately rather than waiting behind the queued flood items.
    const otherPromise = pool.run('other', () => {
      started.push('other');
      return otherGate.promise.then(() => 'other');
    });
    await flush();
    expect(started).toEqual(['flood0', 'other']);

    floodGate.release();
    otherGate.release();
    await Promise.all([...floodPromises, otherPromise]);
    expect(pool.stats().busyWorkers).toBe(0);
    await pool.dispose();
  });

  it('isolates a worker crash to the failing item only', async () => {
    const pool = createScreeningPool({ concurrency: 2, maxQueueDepth: 8 });
    const goodLog: string[] = [];
    const goodGate = createGate();

    const crash = pool.run('crash-stream', () => Promise.reject(new Error('boom')));
    const good = pool.run('good-stream', gatedWork(goodGate, goodLog, 'good'));

    await expect(crash).rejects.toThrow('boom');
    await flush();
    // The good stream is unaffected and holds a worker.
    expect(goodLog).toEqual(['start:good']);
    expect(pool.stats().busyWorkers).toBe(1);

    goodGate.release();
    await expect(good).resolves.toBe('good');
    expect(pool.stats().busyWorkers).toBe(0);
    await pool.dispose();
  });

  it('fails an item on deadline while keeping the pool drained and others running', async () => {
    const pool = createScreeningPool({ concurrency: 1, maxQueueDepth: 8 });
    const slowGate = createGate();

    // One worker held by a slow item; a second item (same stream) queues behind.
    const slow = pool.run('s', () => slowGate.promise.then(() => 'slow'));
    const timed = pool.run('s', () => Promise.resolve('timed'), { deadlineMs: 20 });
    await flush();

    // The queued item hits its deadline before it can run (worker is held).
    await expect(timed).rejects.toBeInstanceOf(ScreeningPoolDeadlineError);
    await flush();
    expect(pool.stats().queueDepth).toBe(0);
    expect(pool.stats().busyWorkers).toBe(1);

    slowGate.release();
    await expect(slow).resolves.toBe('slow');
    expect(pool.stats().busyWorkers).toBe(0);
    await pool.dispose();
  });

  it('cancels a queued item via signal without leaking a slot', async () => {
    const pool = createScreeningPool({ concurrency: 1, maxQueueDepth: 8 });
    const holdGate = createGate();
    const controller = new AbortController();

    const hold = pool.run('s', () => holdGate.promise.then(() => 'hold'));
    await flush();
    expect(pool.stats().busyWorkers).toBe(1);

    const cancelled = pool.run('s', () => Promise.resolve('never'), { signal: controller.signal });
    await flush();
    expect(pool.stats().queueDepth).toBe(1);

    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(ScreeningPoolCancelledError);
    await flush();
    expect(pool.stats().queueDepth).toBe(0);
    expect(pool.stats().busyWorkers).toBe(1);

    holdGate.release();
    await expect(hold).resolves.toBe('hold');
    await pool.dispose();
  });

  it('dispose drains running work and rejects queued items with no orphaned holds', async () => {
    const pool = createScreeningPool({ concurrency: 2, maxQueueDepth: 8 });
    const gateA = createGate();
    const gateB = createGate();

    const runningA = pool.run('a', () => gateA.promise.then(() => 'a'));
    const runningB = pool.run('b', () => gateB.promise.then(() => 'b'));
    // Same stream as A, so queued behind it.
    const queued = pool.run('a', () => Promise.resolve('queued'));
    await flush();
    expect(pool.stats().busyWorkers).toBe(2);
    expect(pool.stats().queueDepth).toBe(1);

    const disposed = pool.dispose();
    // The queued item is rejected synchronously with disposal.
    await expect(queued).rejects.toBeInstanceOf(ScreeningPoolDisposedError);
    await flush();
    // New work is refused while disposing.
    await expect(pool.run('c', () => Promise.resolve('c'))).rejects.toBeInstanceOf(ScreeningPoolDisposedError);

    // Release the in-flight work so dispose resolves (no hard kill → no orphan).
    gateA.release();
    gateB.release();
    await expect(disposed).resolves.toBeUndefined();
    await expect(runningA).resolves.toBe('a');
    await expect(runningB).resolves.toBe('b');
    expect(pool.stats().disposed).toBe(true);
    expect(pool.stats().busyWorkers).toBe(0);
    expect(pool.stats().queueDepth).toBe(0);
    expect(pool.stats().waitingForAdmission).toBe(0);
  });

  it('backpressures admission past the queue cap and emits backpressure telemetry', async () => {
    const events: ScreeningPoolTelemetryEvent[] = [];
    const pool = createScreeningPool({
      concurrency: 1,
      maxQueueDepth: 2,
      onTelemetry: (event) => events.push(event),
    });
    const gate = createGate();
    // capacity = concurrency + maxQueueDepth = 3 outstanding.
    const hold = pool.run('s', () => gate.promise.then(() => 'hold'));
    const q1 = pool.run('s', () => Promise.resolve('q1'));
    const q2 = pool.run('s', () => Promise.resolve('q2'));
    await flush();
    expect(pool.stats().outstanding).toBe(3); // 1 running + 2 queued
    // A fourth would exceed the cap; run() backpressures (does not reject).
    let admitted = false;
    const overflow = pool.run('s', () => { admitted = true; return Promise.resolve('overflow'); });
    await flush();
    expect(admitted).toBe(false);
    expect(pool.stats().waitingForAdmission).toBe(1);
    expect(events.some((event) => event.kind === 'backpressure')).toBe(true);

    gate.release();
    await expect(hold).resolves.toBe('hold');
    await expect(q1).resolves.toBe('q1');
    await expect(q2).resolves.toBe('q2');
    await expect(overflow).resolves.toBe('overflow');
    await pool.dispose();
  });

  it('emits content-free queue depth, wait/service time and saturation telemetry', async () => {
    const events: ScreeningPoolTelemetryEvent[] = [];
    const pool = createScreeningPool({
      concurrency: 2,
      maxQueueDepth: 8,
      onTelemetry: (event) => events.push(event),
    });
    const gate = createGate();
    const done = pool.run('s', () => gate.promise.then(() => 'done'));
    await flush();
    gate.release();
    await expect(done).resolves.toBe('done');

    const started = events.find((event) => event.kind === 'started');
    const completed = events.find((event) => event.kind === 'completed');
    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    expect(started?.waitMs).toBeGreaterThanOrEqual(0);
    expect(started?.busyWorkers).toBeLessThanOrEqual(2);
    expect(started?.concurrency).toBe(2);
    expect(typeof started?.queueDepth).toBe('number');
    expect(typeof started?.outstanding).toBe('number');
    expect(completed?.serviceMs).toBeGreaterThanOrEqual(0);
    expect(completed?.outcome).toBe('ok');
    await pool.dispose();
  });

  it('reports the deadline outcome on telemetry for a deadlined running item', async () => {
    const events: ScreeningPoolTelemetryEvent[] = [];
    const pool = createScreeningPool({
      concurrency: 1,
      maxQueueDepth: 4,
      onTelemetry: (event) => events.push(event),
    });
    // A running item that observes its abort signal: when the deadline fires the
    // work settles and completeWork emits a 'completed' event with outcome
    // 'deadline' (the fail-closed adapter path consumes this).
    const timed = pool.run(
      's',
      (ctx) => new Promise<string>((_resolve, reject) => {
        if (ctx.signal.aborted) reject(ctx.signal.reason);
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
      }),
      { deadlineMs: 15 },
    );
    await expect(timed).rejects.toBeInstanceOf(ScreeningPoolDeadlineError);
    await flush();
    const completed = events.filter((event) => event.kind === 'completed');
    expect(completed.some((event) => event.outcome === 'deadline')).toBe(true);
    expect(pool.stats().busyWorkers).toBe(0);
    await pool.dispose();
  });
});
