import { describe, expect, it } from 'vitest';
import {
  createGardenEventDeduper,
  gardenEventRevision,
  GARDEN_EVENT_DEDUP_CAPACITY,
  stableSerializeEvent,
} from './garden-event-dedup';
import type { GardenEventEnvelope } from './envelope';

function envelope(
  type: string,
  timestamp: number,
  data: unknown = {},
  correlation: Record<string, unknown> = {},
): GardenEventEnvelope {
  return { type, timestamp, correlation: correlation as never, data };
}

describe('stableSerializeEvent', () => {
  it('is unaffected by object key order', () => {
    expect(stableSerializeEvent({ a: 1, b: 2 })).toBe(stableSerializeEvent({ b: 2, a: 1 }));
  });

  it('distinguishes arrays by order and length', () => {
    expect(stableSerializeEvent([1, 2])).not.toBe(stableSerializeEvent([2, 1]));
    expect(stableSerializeEvent([1, 2])).not.toBe(stableSerializeEvent([1, 2, 3]));
  });

  it('distinguishes primitives by type and value', () => {
    expect(stableSerializeEvent(1)).not.toBe(stableSerializeEvent('1'));
    expect(stableSerializeEvent(true)).not.toBe(stableSerializeEvent('true'));
  });
});

describe('gardenEventRevision', () => {
  it('collides only for byte-identical snapshots', () => {
    const base = envelope('system.heartbeat', 1_000, { ok: true, n: 3 });
    expect(gardenEventRevision(base)).toBe(
      gardenEventRevision(envelope('system.heartbeat', 1_000, { n: 3, ok: true })),
    );
  });

  it('differs when type, timestamp, or payload changes', () => {
    const base = envelope('system.heartbeat', 1_000, { ok: true });
    expect(gardenEventRevision(base)).not.toBe(
      gardenEventRevision(envelope('system.heartbeat', 1_001, { ok: true })),
    );
    expect(gardenEventRevision(base)).not.toBe(
      gardenEventRevision(envelope('system.status', 1_000, { ok: true })),
    );
    expect(gardenEventRevision(base)).not.toBe(
      gardenEventRevision(envelope('system.heartbeat', 1_000, { ok: false })),
    );
  });
});

describe('createGardenEventDeduper', () => {
  it('reports the first sighting of a revision as new and repeats as duplicates', () => {
    const deduper = createGardenEventDeduper();
    const event = envelope('agent.turn', 5, { turnId: 't1' });
    expect(deduper.isDuplicate(event)).toBe(false);
    expect(deduper.isDuplicate(event)).toBe(true);
    expect(deduper.size).toBe(1);
  });

  it('publishes every distinct revision in a bursty stream', () => {
    const deduper = createGardenEventDeduper();
    for (let i = 0; i < 50; i++) {
      expect(deduper.isDuplicate(envelope('agent.turn', i, { i }))).toBe(false);
    }
    // Replaying the same burst is fully deduped.
    for (let i = 0; i < 50; i++) {
      expect(deduper.isDuplicate(envelope('agent.turn', i, { i }))).toBe(true);
    }
    expect(deduper.size).toBe(50);
  });

  it('evicts the oldest revision once capacity is exceeded', () => {
    const deduper = createGardenEventDeduper(3);
    const first = envelope('a', 1);
    const second = envelope('a', 2);
    const third = envelope('a', 3);
    expect(deduper.isDuplicate(first)).toBe(false);
    expect(deduper.isDuplicate(second)).toBe(false);
    expect(deduper.isDuplicate(third)).toBe(false);
    // Capacity is 3; the fourth insertion evicts `first`.
    expect(deduper.isDuplicate(envelope('a', 4))).toBe(false);
    expect(deduper.size).toBe(3);
    expect(deduper.isDuplicate(first)).toBe(false);
    expect(deduper.isDuplicate(third)).toBe(true);
  });

  it('uses the documented default capacity', () => {
    expect(GARDEN_EVENT_DEDUP_CAPACITY).toBeGreaterThan(0);
    const deduper = createGardenEventDeduper();
    expect(deduper.size).toBe(0);
  });

  it('seed remembers revisions without treating them as a publish decision', () => {
    const deduper = createGardenEventDeduper();
    const replayed = envelope('system.snapshot', 10, { v: 1 });
    deduper.seed([replayed]);
    expect(deduper.size).toBe(1);
    // A reconnect that replays the seeded event is treated as a duplicate.
    expect(deduper.isDuplicate(replayed)).toBe(true);
    // A genuinely new event is still published.
    expect(deduper.isDuplicate(envelope('system.snapshot', 11, { v: 2 }))).toBe(false);
  });

  it('reset forgets every remembered revision', () => {
    const deduper = createGardenEventDeduper();
    deduper.isDuplicate(envelope('a', 1));
    deduper.isDuplicate(envelope('a', 2));
    expect(deduper.size).toBe(2);
    deduper.reset();
    expect(deduper.size).toBe(0);
    expect(deduper.isDuplicate(envelope('a', 1))).toBe(false);
  });
});
