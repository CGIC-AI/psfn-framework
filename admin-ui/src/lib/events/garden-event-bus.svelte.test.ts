// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Integration test for the Garden event-bus store wiring: the socket message
 * handler must drop replayed identical snapshots, coalesce the durable cache
 * write under bursts, still broadcast every distinct event, recover from a
 * failed write, and tear down cleanly. The dedup/coalesce primitives
 * themselves are covered by garden-event-dedup.test.ts and
 * garden-event-stream.test.ts; this file locks the wiring inside
 * garden-event-bus.svelte.ts.
 */

interface WireMessage { data: unknown }
interface CapturedSocket {
  emit(message: unknown): void;
  setConnected(connected: boolean): void;
}
interface CacheSpy {
  write: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  clearScope: ReturnType<typeof vi.fn>;
}

// Module-level capture state shared with the mocked constructors below. Reset
// per test so each loadBus() lifecycle is isolated.
let activeSocket: CapturedSocket | null = null;
let activeCache: CacheSpy | null = null;

interface FakeSocketInstance {
  connected: boolean;
  connectionError: null;
  onMessage(handler: (message: WireMessage) => void): () => void;
  onConnectionChange(handler: (connected: boolean) => void): () => void;
  onConnectionError(): () => void;
  connect(): void;
  close(): void;
}

function FakeReconnectingWebSocket(this: FakeSocketInstance): void {
  this.connected = false;
  this.connectionError = null;
  const messageHandlers = new Set<(message: WireMessage) => void>();
  const connectionHandlers = new Set<(connected: boolean) => void>();
  this.onMessage = (handler) => {
    messageHandlers.add(handler);
    return () => messageHandlers.delete(handler);
  };
  this.onConnectionChange = (handler) => {
    connectionHandlers.add(handler);
    return () => connectionHandlers.delete(handler);
  };
  this.onConnectionError = () => () => {};
  this.connect = () => {
    this.connected = true;
    activeSocket = {
      emit: (data: unknown) => {
        for (const handler of messageHandlers) handler({ data });
      },
      setConnected: (connected: boolean) => {
        this.connected = connected;
        for (const handler of connectionHandlers) handler(connected);
      },
    };
  };
  this.close = () => { this.connected = false; };
}

function FakeCache(this: CacheSpy): void {
  this.write = vi.fn(async () => {});
  this.read = vi.fn(async () => []);
  this.clear = vi.fn(async () => {});
  this.clearScope = vi.fn(async () => {});
  activeCache = {
    write: this.write,
    read: this.read,
    clear: this.clear,
    clearScope: this.clearScope,
  };
}

type EventBusStore = typeof import('./garden-event-bus.svelte');

async function loadBus(): Promise<{ bus: EventBusStore; socket: CapturedSocket; cache: CacheSpy }> {
  vi.resetModules();
  activeSocket = null;
  activeCache = null;

  vi.doMock('$lib/stores/auth.svelte', () => ({ getToken: () => null }));
  vi.doMock('$lib/api/websocket', () => ({ ReconnectingWebSocket: FakeReconnectingWebSocket }));
  vi.doMock('$lib/cache/telemetry-cache', () => ({
    MAX_CACHED_GARDEN_EVENTS: 750,
    GardenTelemetryCache: FakeCache,
  }));

  const bus = await import('./garden-event-bus.svelte');
  bus.connectGardenEventBus();
  const socket = activeSocket;
  const cache = activeCache;
  if (!socket) throw new Error('WebSocket capture was not wired');
  if (!cache) throw new Error('Telemetry cache was not constructed');
  return { bus, socket, cache };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function message(type: string, timestamp: number, data: unknown = {}): string {
  return JSON.stringify({ type, timestamp, correlation: {}, data });
}

describe('Garden event-bus store wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    activeSocket = null;
    activeCache = null;
    vi.doUnmock('$lib/stores/auth.svelte');
    vi.doUnmock('$lib/api/websocket');
    vi.doUnmock('$lib/cache/telemetry-cache');
  });

  it('drops repeated identical snapshots and broadcasts each distinct revision', async () => {
    const { bus, socket, cache } = await loadBus();
    const received: string[] = [];
    bus.subscribeGardenEvents((event) => received.push(event.type));

    socket.emit(message('agent.heartbeat', 1_000, { ok: true }));
    socket.emit(message('agent.heartbeat', 1_000, { ok: true })); // duplicate
    socket.emit(message('agent.heartbeat', 1_000, { ok: true })); // duplicate
    socket.emit(message('agent.heartbeat', 1_001, { ok: true })); // distinct ts

    expect(bus.getGardenEvents()).toHaveLength(2);
    expect(received).toEqual(['agent.heartbeat', 'agent.heartbeat']);
    // No persist has fired within the coalesce window.
    expect(cache.write).not.toHaveBeenCalled();
  });

  it('coalesces a burst of distinct events into one bounded cache write', async () => {
    const { bus, socket, cache } = await loadBus();

    for (let i = 0; i < 40; i++) {
      socket.emit(message('agent.turn', i, { i }));
    }
    expect(bus.getGardenEvents()).toHaveLength(40);
    // Persist is debounced: no write yet within the coalesce window.
    expect(cache.write).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(cache.write).toHaveBeenCalledTimes(1);
    // The single coalesced write captured all 40 events.
    expect((cache.write.mock.calls[0] as unknown[])[0]).toHaveLength(40);
  });

  it('recovers from a failed cache write and persists on the next window', async () => {
    const { bus, socket, cache } = await loadBus();
    cache.write.mockRejectedValueOnce(new Error('indexeddb locked'));

    socket.emit(message('system.snapshot', 10, { v: 1 }));
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(cache.write).toHaveBeenCalledTimes(1);
    expect(bus.getGardenEventCacheError()).toBe('indexeddb locked');

    socket.emit(message('system.snapshot', 11, { v: 2 }));
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(cache.write).toHaveBeenCalledTimes(2);
    expect(bus.getGardenEventCacheError()).toBeNull();
  });

  it('seeds the deduper on hydrate so a reconnect replay does not double-append', async () => {
    const { bus, socket, cache } = await loadBus();
    const replayed = { type: 'agent.replay', timestamp: 5, correlation: {}, data: { n: 1 } };
    cache.read.mockResolvedValueOnce([replayed]);

    await bus.hydrateGardenEventBus();
    expect(bus.getGardenEvents()).toHaveLength(1);

    // The live socket now replays the same event after reconnect.
    socket.emit(message('agent.replay', 5, { n: 1 }));
    expect(bus.getGardenEvents()).toHaveLength(1); // deduped, not doubled
    socket.emit(message('agent.replay', 6, { n: 2 }));
    expect(bus.getGardenEvents()).toHaveLength(2);
  });

  it('clears the buffer and tears down cleanly', async () => {
    const { bus, socket, cache } = await loadBus();
    socket.emit(message('a', 1));
    socket.emit(message('a', 2));
    expect(bus.getGardenEvents()).toHaveLength(2);

    bus.clearGardenEventBus();
    expect(bus.getGardenEvents()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    // clear cancels the pending coalesced write and clears the cache instead.
    expect(cache.write).not.toHaveBeenCalled();
    expect(cache.clear).toHaveBeenCalledTimes(1);

    bus.disconnectGardenEventBus();
    expect(bus.isGardenEventBusConnected()).toBe(false);
  });
});
