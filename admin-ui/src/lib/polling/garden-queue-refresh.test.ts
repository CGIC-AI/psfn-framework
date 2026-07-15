import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GardenEventEnvelope, GardenEventFilter } from '../events/envelope';
import {
  createGardenQueueRefresh,
  type GardenQueueRefreshBus,
} from './garden-queue-refresh';
import type { VisibilityDocument } from './visibility-aware-poller';

class FakeVisibilityDocument implements VisibilityDocument {
  hidden = false;
  private readonly listeners = new Set<() => void>();

  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of this.listeners) listener();
  }
}

class FakeGardenBus implements GardenQueueRefreshBus {
  connected = true;
  connect = vi.fn();
  disconnect = vi.fn();
  private eventListener: ((event: GardenEventEnvelope) => void) | undefined;
  private connectionListener: ((connected: boolean) => void) | undefined;

  isConnected(): boolean {
    return this.connected;
  }

  subscribeEvents(
    listener: (event: GardenEventEnvelope) => void,
    _filter?: GardenEventFilter,
  ): () => void {
    this.eventListener = listener;
    return () => {
      this.eventListener = undefined;
    };
  }

  subscribeConnection(listener: (connected: boolean) => void): () => void {
    this.connectionListener = listener;
    return () => {
      this.connectionListener = undefined;
    };
  }

  emitQueue(queue: string): void {
    this.eventListener?.({
      type: 'garden.queue.changed',
      timestamp: Date.now(),
      correlation: {},
      data: { queue },
    });
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    this.connectionListener?.(connected);
  }
}

async function flushRefresh(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createGardenQueueRefresh', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses coarse socket signals while connected and coalesces bursts by queue', async () => {
    const bus = new FakeGardenBus();
    const refresh = vi.fn();
    const controller = createGardenQueueRefresh({
      bus,
      documentRef: new FakeVisibilityDocument(),
      intervalMs: 15_000,
      queue: 'contact-approvals',
      refresh,
    });

    controller.start();
    await flushRefresh();
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    bus.emitQueue('confirmations');
    bus.emitQueue('contact-approvals');
    bus.emitQueue('contact-approvals');
    await flushRefresh();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('immediately resumes interval polling when the socket becomes unavailable', async () => {
    const bus = new FakeGardenBus();
    const refresh = vi.fn();
    const controller = createGardenQueueRefresh({
      bus,
      documentRef: new FakeVisibilityDocument(),
      intervalMs: 15_000,
      queue: 'graph-proposals',
      refresh,
    });

    controller.start();
    await flushRefresh();
    bus.setConnected(false);
    await flushRefresh();
    expect(refresh).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).toHaveBeenCalledTimes(3);

    controller.stop();
    bus.setConnected(true);
    bus.emitQueue('graph-proposals');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(bus.disconnect).toHaveBeenCalledTimes(1);
  });

  it('refetches exactly once after reconnect and leaves the fallback timer stopped', async () => {
    const bus = new FakeGardenBus();
    const documentRef = new FakeVisibilityDocument();
    const refresh = vi.fn();
    const controller = createGardenQueueRefresh({
      bus,
      documentRef,
      intervalMs: 15_000,
      queue: 'intake-quarantine',
      refresh,
    });

    controller.start();
    await flushRefresh();
    expect(refresh).toHaveBeenCalledTimes(1);

    bus.setConnected(false);
    await flushRefresh();
    expect(refresh).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).toHaveBeenCalledTimes(3);

    // A queue mutation may land after the last fallback poll but before the
    // socket reconnects, so reconnect itself must invalidate the snapshot.
    bus.setConnected(true);
    await flushRefresh();
    expect(refresh).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it('defers the reconnect refetch while hidden and performs it once on visibility', async () => {
    const bus = new FakeGardenBus();
    const documentRef = new FakeVisibilityDocument();
    const refresh = vi.fn();
    const controller = createGardenQueueRefresh({
      bus,
      documentRef,
      intervalMs: 15_000,
      queue: 'confirmations',
      refresh,
    });

    controller.start();
    await flushRefresh();
    bus.setConnected(false);
    await flushRefresh();
    expect(refresh).toHaveBeenCalledTimes(2);

    documentRef.setHidden(true);
    bus.setConnected(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);

    documentRef.setHidden(false);
    await flushRefresh();
    expect(refresh).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
