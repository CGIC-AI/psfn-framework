import type { GardenEventEnvelope } from './envelope';
import {
  createGardenEventDeduper,
  type GardenEventDeduper,
} from './garden-event-dedup';

/**
 * Coalesce window for persisting the live event buffer to the telemetry cache.
 * A burst of events collapses into a single IndexedDB write of the latest
 * buffer, bounding main-thread I/O while preserving durability for real
 * changes. Prompt delivery to subscribers is unaffected: append and notify
 * stay synchronous; only the cache write is debounced.
 */
export const GARDEN_EVENT_PERSIST_COALESCE_MS = 200;

export interface GardenEventStreamTimer {
  setTimeout(fn: () => void, ms: number): GardenEventStreamTimerHandle;
  clearTimeout(handle: GardenEventStreamTimerHandle): void;
}

export type GardenEventStreamTimerHandle = ReturnType<typeof setTimeout>;

export interface GardenEventStreamPersist {
  /** Persist the current event buffer. Serialized by the caller if needed. */
  (): Promise<void> | void;
}

export interface GardenEventStreamOptions {
  persistCoalesceMs?: number;
  dedupCapacity?: number;
  /** Injectable for tests; defaults to the host timer. */
  timer?: GardenEventStreamTimer;
}

export interface GardenEventStream {
  /**
   * Record an incoming event's revision. Returns true when the event is a new
   * semantic revision (the caller should append, persist, and broadcast it)
   * and false when it revises an already-seen snapshot (skip entirely).
   */
  ingest(event: GardenEventEnvelope): boolean;
  /** Remember many revisions without broadcasting (hydrate/reconnect seed). */
  seed(events: readonly GardenEventEnvelope[]): void;
  /** Schedule a coalesced persist; collapses to one write per window. */
  schedulePersist(): void;
  /** Persist immediately, cancelling any pending coalesced write. */
  flushPersist(): void;
  /** Cancel the pending persist and forget every remembered revision. */
  reset(): void;
  readonly dedup: GardenEventDeduper;
  /** True when a coalesced persist is pending. */
  readonly persistPending: boolean;
}

const hostTimer: GardenEventStreamTimer = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * Narrow shared seam between the Garden WebSocket and the reactive event
 * store. Owns two concerns that previously churned on every incoming message:
 *
 *  1. Duplicate snapshot detection — identical retransmitted/replayed events
 *     are dropped before they can re-append, re-persist, or re-render.
 *  2. Coalesced persistence — a burst of distinct events produces one bounded
 *     cache write instead of one write per message.
 *
 * The stream never delays event delivery to subscribers and never touches
 * emotional state; it only decides whether an event revises the buffer and
 * when the buffer is flushed to durable cache.
 */
export function createGardenEventStream(
  options: GardenEventStreamOptions,
  persist: GardenEventStreamPersist,
): GardenEventStream {
  const timer = options.timer ?? hostTimer;
  const coalesceMs = options.persistCoalesceMs ?? GARDEN_EVENT_PERSIST_COALESCE_MS;
  const dedup = createGardenEventDeduper(options.dedupCapacity);
  let pending: GardenEventStreamTimerHandle | null = null;

  function clearPending(): void {
    if (pending !== null) {
      timer.clearTimeout(pending);
      pending = null;
    }
  }

  function runPersist(): void {
    pending = null;
    try {
      void Promise.resolve(persist()).catch(() => {
        // The persist callback owns its own error state; swallow here so a
        // failed write cannot unhandedly reject the timer promise.
      });
    } catch {
      // Same as above: the callback reports its own failures.
    }
  }

  return {
    ingest(event) {
      return !dedup.isDuplicate(event);
    },
    seed(events) {
      dedup.seed(events);
    },
    schedulePersist() {
      if (pending !== null) return;
      pending = timer.setTimeout(runPersist, coalesceMs);
    },
    flushPersist() {
      clearPending();
      runPersist();
    },
    reset() {
      clearPending();
      dedup.reset();
    },
    dedup,
    get persistPending() {
      return pending !== null;
    },
  };
}
