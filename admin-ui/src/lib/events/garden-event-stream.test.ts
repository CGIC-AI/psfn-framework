import { describe, expect, it, vi } from 'vitest';
import {
  createGardenEventStream,
  GARDEN_EVENT_PERSIST_COALESCE_MS,
  type GardenEventStreamTimer,
  type GardenEventStreamTimerHandle,
} from './garden-event-stream';
import type { GardenEventEnvelope } from './envelope';

function envelope(
  type: string,
  timestamp: number,
  data: unknown = {},
): GardenEventEnvelope {
  return { type, timestamp, correlation: {}, data };
}

/** Deterministic fake timer: callbacks only run when the clock advances. */
function fakeTimer(): GardenEventStreamTimer & {
  advance(ms: number): void;
  pendingCount(): number;
} {
  const tasks = new Map<GardenEventStreamTimerHandle, { fn: () => void; fireAt: number }>();
  let now = 0;
  let nextHandle = 0;
  return {
    setTimeout(fn, ms) {
      const handle = ++nextHandle as unknown as GardenEventStreamTimerHandle;
      tasks.set(handle, { fn, fireAt: now + ms });
      return handle;
    },
    clearTimeout(handle) {
      tasks.delete(handle);
    },
    advance(ms) {
      now += ms;
      for (const [handle, task] of [...tasks]) {
        if (task.fireAt <= now) {
          tasks.delete(handle);
          task.fn();
        }
      }
    },
    pendingCount() {
      return tasks.size;
    },
  };
}

describe('createGardenEventStream — ingest (dedup)', () => {
  it('publishes the first sighting of each distinct revision', () => {
    const stream = createGardenEventStream({}, vi.fn());
    expect(stream.ingest(envelope('a', 1))).toBe(true);
    expect(stream.ingest(envelope('a', 2))).toBe(true);
    expect(stream.ingest(envelope('b', 1))).toBe(true);
  });

  it('drops repeated identical snapshots without publishing', () => {
    const stream = createGardenEventStream({}, vi.fn());
    const event = envelope('system.heartbeat', 100, { ok: true });
    expect(stream.ingest(event)).toBe(true);
    expect(stream.ingest(event)).toBe(false);
    expect(stream.ingest(event)).toBe(false);
  });

  it('publishes every event in a bursty distinct-revision stream', () => {
    const stream = createGardenEventStream({}, vi.fn());
    for (let i = 0; i < 100; i++) {
      expect(stream.ingest(envelope('agent.turn', i, { i }))).toBe(true);
    }
  });

  it('seed prevents a reconnect replay from republishing cached events', () => {
    const stream = createGardenEventStream({}, vi.fn());
    const cached = [envelope('a', 1), envelope('a', 2)];
    stream.seed(cached);
    expect(stream.ingest(cached[0])).toBe(false);
    expect(stream.ingest(cached[1])).toBe(false);
    expect(stream.ingest(envelope('a', 3))).toBe(true);
  });

  it('reset forgets revisions and cancels state for a clean teardown', () => {
    const stream = createGardenEventStream({}, vi.fn());
    const event = envelope('a', 1);
    expect(stream.ingest(event)).toBe(true);
    stream.reset();
    expect(stream.ingest(event)).toBe(true);
  });
});

describe('createGardenEventStream — coalesced persist', () => {
  it('coalesces a burst of schedules into one bounded write', () => {
    const timer = fakeTimer();
    const persist = vi.fn();
    const stream = createGardenEventStream({ timer, persistCoalesceMs: 50 }, persist);

    for (let i = 0; i < 25; i++) stream.schedulePersist();
    expect(timer.pendingCount()).toBe(1);
    expect(persist).not.toHaveBeenCalled();

    timer.advance(50);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(timer.pendingCount()).toBe(0);

    // A later burst schedules a fresh single write.
    for (let i = 0; i < 10; i++) stream.schedulePersist();
    expect(timer.pendingCount()).toBe(1);
    timer.advance(50);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('flushPersist writes immediately and cancels the pending coalesced write', () => {
    const timer = fakeTimer();
    const persist = vi.fn();
    const stream = createGardenEventStream({ timer, persistCoalesceMs: 50 }, persist);

    stream.schedulePersist();
    expect(timer.pendingCount()).toBe(1);
    stream.flushPersist();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(timer.pendingCount()).toBe(0);
    // Advancing the original window must not fire a second time.
    timer.advance(50);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('reset cancels the pending coalesced write (deterministic teardown)', () => {
    const timer = fakeTimer();
    const persist = vi.fn();
    const stream = createGardenEventStream({ timer, persistCoalesceMs: 50 }, persist);

    stream.schedulePersist();
    expect(timer.pendingCount()).toBe(1);
    stream.reset();
    expect(timer.pendingCount()).toBe(0);
    timer.advance(100);
    expect(persist).not.toHaveBeenCalled();
  });

  it('survives a persist rejection without unhandedly rejecting (error recovery)', async () => {
    const timer = fakeTimer();
    let callCount = 0;
    const persist = vi.fn(() => {
      callCount += 1;
      return callCount === 1 ? Promise.reject(new Error('cache down')) : Promise.resolve();
    });
    const stream = createGardenEventStream({ timer, persistCoalesceMs: 10 }, persist);

    stream.schedulePersist();
    timer.advance(10);
    await Promise.resolve();
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(1);
    // A subsequent write after recovery still runs.
    stream.schedulePersist();
    timer.advance(10);
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('survives a synchronous persist throw', () => {
    const timer = fakeTimer();
    const persist = vi.fn(() => {
      throw new Error('boom');
    });
    const stream = createGardenEventStream({ timer, persistCoalesceMs: 10 }, persist);
    stream.schedulePersist();
    expect(() => timer.advance(10)).not.toThrow();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('exposes a coalesce window that bounds writes without delaying delivery', () => {
    expect(GARDEN_EVENT_PERSIST_COALESCE_MS).toBeGreaterThan(0);
    const timer = fakeTimer();
    const persist = vi.fn();
    const stream = createGardenEventStream({ timer, persistCoalesceMs: GARDEN_EVENT_PERSIST_COALESCE_MS }, persist);
    // Ingest decisions are synchronous and unaffected by the persist window.
    expect(stream.ingest(envelope('a', 1))).toBe(true);
    expect(stream.persistPending).toBe(false);
    stream.schedulePersist();
    expect(stream.persistPending).toBe(true);
  });
});
