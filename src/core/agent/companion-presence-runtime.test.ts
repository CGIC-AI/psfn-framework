// ── Unit tests for the cross-companion presence runtime (sprint 10, W5a) ──
// Drives the writer/co-presence/co-location contract against an in-memory
// store and a recording event bus: own-row upsert on situated turns, arrival
// events exactly once per arrival (never on refreshes), staleness filtering,
// place-move resets, and no shared-schema traffic for unsituated turns.

import { describe, expect, it, vi } from 'vitest';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';
import type { EventBus } from '../../shared/event-bus.js';
import {
  CompanionPresenceRuntime,
  DEFAULT_COMPANION_PRESENCE_STALE_TTL_MS,
} from './companion-presence-runtime.js';
import type {
  CompanionPresenceRecord,
  CompanionPresenceStorePort,
  CompanionPresenceUpsertInput,
} from './companion-presence-store-port.js';

const SELF_ID = '11111111-1111-4111-8111-111111111111';
const PEER_A = '22222222-2222-4222-8222-222222222222';
const PEER_B = '33333333-3333-4333-8333-333333333333';

const NOW = new Date('2026-07-08T12:00:00.000Z');

const PLACES_REGISTRY: PlacesRegistryConfig = {
  schemaVersion: 1,
  sites: [{ siteId: 'site.home', displayName: 'Home', kind: 'physical' }],
  places: [
    {
      placeId: 'place.living-room',
      siteId: 'site.home',
      displayName: 'Living Room',
      kind: 'physical',
      affordances: [],
    },
    {
      placeId: 'place.kitchen',
      siteId: 'site.home',
      displayName: 'Kitchen',
      kind: 'physical',
      affordances: [],
    },
  ],
};

function makeMessage(placeId?: string): SubstrateMessage {
  return {
    id: 'msg-presence-1',
    channelId: 'satellite:living-room',
    channelType: 'api',
    authorId: 'user-neutral',
    authorName: 'Neutral',
    content: 'hello',
    timestamp: NOW,
    ...(placeId
      ? { routing: { satellite: { placeId } } as unknown as SubstrateMessage['routing'] }
      : {}),
  };
}

class FakePresenceStore implements CompanionPresenceStorePort {
  rows = new Map<string, CompanionPresenceRecord>();
  upsertCalls: CompanionPresenceUpsertInput[] = [];
  deleteCalls: string[] = [];
  closed = false;
  failNext: Error | null = null;

  seed(record: CompanionPresenceRecord): void {
    this.rows.set(record.companionId, record);
  }

  async upsertPresence(input: CompanionPresenceUpsertInput): Promise<CompanionPresenceRecord> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    this.upsertCalls.push({ ...input });
    const previous = this.rows.get(input.companionId);
    const samePlace = previous
      && previous.siteId === input.siteId
      && previous.placeId === input.placeId;
    const record: CompanionPresenceRecord = {
      companionId: input.companionId,
      siteId: input.siteId,
      placeId: input.placeId,
      kind: input.kind,
      since: samePlace ? previous.since : NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    this.rows.set(input.companionId, record);
    return record;
  }

  async listByPlace(siteId: string, placeId: string): Promise<CompanionPresenceRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.siteId === siteId && row.placeId === placeId);
  }

  async listAll(): Promise<CompanionPresenceRecord[]> {
    return [...this.rows.values()];
  }

  async deletePresence(companionId: string): Promise<boolean> {
    this.deleteCalls.push(companionId);
    return this.rows.delete(companionId);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function makeEventBus(): { bus: EventBus; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn(async () => undefined);
  return { bus: { emit } as unknown as EventBus, emit };
}

function peerRecord(
  companionId: string,
  overrides: Partial<CompanionPresenceRecord> = {},
): CompanionPresenceRecord {
  return {
    companionId,
    siteId: 'site.home',
    placeId: 'place.living-room',
    kind: 'physical',
    since: new Date(NOW.getTime() - 60_000).toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function makeRuntime(store: FakePresenceStore, bus: EventBus): CompanionPresenceRuntime {
  return new CompanionPresenceRuntime({
    store,
    companionId: SELF_ID,
    eventBus: bus,
    placesRegistry: PLACES_REGISTRY,
    now: () => NOW,
  });
}

describe('CompanionPresenceRuntime', () => {
  it('fails closed on a non-UUID companion id', () => {
    const store = new FakePresenceStore();
    const { bus } = makeEventBus();
    expect(() => new CompanionPresenceRuntime({
      store,
      companionId: 'flagship',
      eventBus: bus,
    })).toThrow('lowercase RFC-4122 UUID');
  });

  it('does nothing for a turn with no situated place (no shared-schema traffic)', async () => {
    const store = new FakePresenceStore();
    const { bus, emit } = makeEventBus();
    const runtime = makeRuntime(store, bus);

    await runtime.observeTurnPlace(makeMessage());
    await runtime.observeTurnPlace(makeMessage('place.nowhere'));

    expect(store.upsertCalls).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('writes its own row for a situated turn with the resolved place coordinates', async () => {
    const store = new FakePresenceStore();
    const { bus } = makeEventBus();
    const runtime = makeRuntime(store, bus);

    await runtime.observeTurnPlace(makeMessage('place.living-room'));

    expect(store.upsertCalls).toEqual([{
      companionId: SELF_ID,
      siteId: 'site.home',
      placeId: 'place.living-room',
      kind: 'physical',
    }]);
  });

  it('emits co-location for companions already present when it arrives, once each', async () => {
    const store = new FakePresenceStore();
    store.seed(peerRecord(PEER_A));
    const { bus, emit } = makeEventBus();
    const runtime = makeRuntime(store, bus);

    await runtime.observeTurnPlace(makeMessage('place.living-room'));

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('presence.companion.co_located', {
      companionId: PEER_A,
      observerCompanionId: SELF_ID,
      siteId: 'site.home',
      placeId: 'place.living-room',
      kind: 'physical',
      since: peerRecord(PEER_A).since,
      timestamp: NOW.getTime(),
    });

    // Refresh of the same arrival: no re-emit.
    await runtime.observeTurnPlace(makeMessage('place.living-room'));
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('emits only for the NEW arrival on a later refresh, not the known one', async () => {
    const store = new FakePresenceStore();
    store.seed(peerRecord(PEER_A));
    const { bus, emit } = makeEventBus();
    const runtime = makeRuntime(store, bus);

    await runtime.observeTurnPlace(makeMessage('place.living-room'));
    expect(emit).toHaveBeenCalledTimes(1);

    store.seed(peerRecord(PEER_B));
    await runtime.observeTurnPlace(makeMessage('place.living-room'));
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith(
      'presence.companion.co_located',
      expect.objectContaining({ companionId: PEER_B, observerCompanionId: SELF_ID }),
    );
  });

  it('treats rows older than the staleness TTL as gone (no event, no snapshot)', async () => {
    const store = new FakePresenceStore();
    store.seed(peerRecord(PEER_A, {
      updatedAt: new Date(
        NOW.getTime() - DEFAULT_COMPANION_PRESENCE_STALE_TTL_MS - 1,
      ).toISOString(),
    }));
    const { bus, emit } = makeEventBus();
    const runtime = makeRuntime(store, bus);

    await runtime.observeTurnPlace(makeMessage('place.living-room'));

    expect(emit).not.toHaveBeenCalled();
    expect(runtime.getCoPresent({
      siteId: 'site.home',
      placeId: 'place.living-room',
      kind: 'physical',
    })).toEqual([]);
  });

  it('serves the co-presence snapshot for the current place only', async () => {
    const store = new FakePresenceStore();
    store.seed(peerRecord(PEER_A));
    const { bus } = makeEventBus();
    const runtime = makeRuntime(store, bus);

    await runtime.observeTurnPlace(makeMessage('place.living-room'));

    expect(runtime.getCoPresent({
      siteId: 'site.home',
      placeId: 'place.living-room',
      kind: 'physical',
    })).toEqual([{ companionId: PEER_A, displayName: PEER_A }]);
    expect(runtime.getCoPresent({
      siteId: 'site.home',
      placeId: 'place.kitchen',
      kind: 'physical',
    })).toEqual([]);
  });

  it('resets the arrival dedupe set on a place move', async () => {
    const store = new FakePresenceStore();
    store.seed(peerRecord(PEER_A));
    const { bus, emit } = makeEventBus();
    const runtime = makeRuntime(store, bus);

    await runtime.observeTurnPlace(makeMessage('place.living-room'));
    expect(emit).toHaveBeenCalledTimes(1);

    // Move to the kitchen (empty), then back: PEER_A is a fresh co-location.
    await runtime.observeTurnPlace(makeMessage('place.kitchen'));
    expect(emit).toHaveBeenCalledTimes(1);
    await runtime.observeTurnPlace(makeMessage('place.living-room'));
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('never throws out of observeTurnPlace on store failure (logged, turn survives)', async () => {
    const store = new FakePresenceStore();
    store.failNext = new Error('shared schema unavailable');
    const { bus, emit } = makeEventBus();
    const runtime = makeRuntime(store, bus);

    await expect(runtime.observeTurnPlace(makeMessage('place.living-room')))
      .resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });

  it('deletes its own row and closes the store on graceful shutdown', async () => {
    const store = new FakePresenceStore();
    const { bus } = makeEventBus();
    const runtime = makeRuntime(store, bus);

    await runtime.observeTurnPlace(makeMessage('place.living-room'));
    await runtime.shutdown();

    expect(store.deleteCalls).toEqual([SELF_ID]);
    expect(store.rows.has(SELF_ID)).toBe(false);
    expect(store.closed).toBe(true);
  });
});
