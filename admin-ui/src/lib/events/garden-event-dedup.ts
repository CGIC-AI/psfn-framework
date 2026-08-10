import type { GardenEventEnvelope } from './envelope';

/**
 * Maximum number of recent event revisions retained for duplicate detection.
 * The bounded ring is large enough to absorb a reconnect/replay burst (the
 * backend may retransmit recent status/turn events) without holding an
 * unbounded set, and small enough that a legitimately repeated event after a
 * long run of distinct events is published again as expected.
 */
export const GARDEN_EVENT_DEDUP_CAPACITY = 256;

/**
 * Deterministic serialization of a wire event payload for deduplication.
 * Object keys are sorted so two payloads with the same content in different
 * key order collide; arrays and primitives serialize positionally. Event data
 * arrives from `JSON.parse`, so it is acyclic; the depth guard keeps a
 * malformed nested payload from blowing the stack instead of failing closed.
 */
export function stableSerializeEvent(value: unknown, depth = 0): string {
  if (depth > 64) return '…';
  if (value === null) return 'n';
  if (typeof value === 'string') return `s${value.length}:${value}`;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${typeof value}:${value}`;
  }
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ',';
      out += stableSerializeEvent(value[i], depth + 1);
    }
    return `${out}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  let out = '{';
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (i > 0) out += ',';
    out += `${stableSerializeEvent(key, depth + 1)}:${stableSerializeEvent(record[key], depth + 1)}`;
  }
  return `${out}}`;
}

/**
 * Content-addressed semantic revision for a Garden event. Two events share a
 * revision only when they are byte-identical snapshots (same type, timestamp,
 * and payload) — i.e. a replayed or retransmitted status/heartbeat/turn event.
 * Distinct events always differ.
 */
export function gardenEventRevision(event: GardenEventEnvelope): string {
  return `${event.type}\u0000${event.timestamp}\u0000${stableSerializeEvent(event.data)}`;
}

export interface GardenEventDeduper {
  /** Returns true when the event revises a recently seen revision (a duplicate). */
  isDuplicate(event: GardenEventEnvelope): boolean;
  /** Records revisions without treating them as newly published (hydrate/reconnect). */
  seed(events: readonly GardenEventEnvelope[]): void;
  /** Clears all remembered revisions. */
  reset(): void;
  /** Number of revisions currently remembered. */
  readonly size: number;
}

/**
 * Bounded FIFO ring of recent event revisions. Insertion order is preserved so
 * the oldest revision is evicted first once the capacity is exceeded.
 */
export function createGardenEventDeduper(
  capacity: number = GARDEN_EVENT_DEDUP_CAPACITY,
): GardenEventDeduper {
  const seen = new Set<string>();

  function evict(): void {
    while (seen.size > capacity) {
      const oldest = seen.values().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  }

  return {
    isDuplicate(event) {
      const revision = gardenEventRevision(event);
      if (seen.has(revision)) return true;
      seen.add(revision);
      evict();
      return false;
    },
    seed(events) {
      for (const event of events) {
        seen.add(gardenEventRevision(event));
      }
      evict();
    },
    reset() {
      seen.clear();
    },
    get size() {
      return seen.size;
    },
  };
}
