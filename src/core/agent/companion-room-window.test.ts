// ── Companion-room content window port (psfn-framework-s10rm) ──
// Maps channel ids to serve windows: only a PRIVATE place's companion room is
// ever windowed (floor = own presence `since`); everything else is
// unwindowed, and a private room without verifiable own presence is CLOSED.
// Also pins CompanionPresenceRuntime.getOwnPresenceWindow — the single source
// of the floor (the presence row's `since`, no second clock).

import { describe, expect, it, vi } from 'vitest';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';
import type { EventBus } from '../../shared/event-bus.js';
import { CompanionPresenceRuntime } from './companion-presence-runtime.js';
import type {
  CompanionPresenceRecord,
  CompanionPresenceStorePort,
  CompanionPresenceUpsertInput,
} from './companion-presence-store-port.js';
import { createCompanionRoomContentWindowPort } from './companion-room-window.js';

const SELF_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-07-08T12:00:00.000Z');
const SINCE = new Date(NOW.getTime() - 5 * 60_000).toISOString();

const PLACES: PlacesRegistryConfig = {
  schemaVersion: 1,
  sites: [{ siteId: 'vhome', displayName: 'Virtual Home', kind: 'virtual' }],
  places: [
    {
      placeId: 'living_room',
      siteId: 'vhome',
      displayName: 'Living Room',
      kind: 'virtual',
      affordances: [],
    },
    {
      placeId: 'den',
      siteId: 'vhome',
      displayName: 'The Den',
      kind: 'virtual',
      privacy: 'private',
      affordances: [],
    },
  ],
};

function makePort(window: { place: { siteId: string; placeId: string; kind: 'virtual' }; sinceMs: number } | null) {
  return createCompanionRoomContentWindowPort({
    placesRegistry: PLACES,
    presence: { getOwnPresenceWindow: () => window },
  });
}

const PRESENT_IN_DEN = {
  place: { siteId: 'vhome', placeId: 'den', kind: 'virtual' as const },
  sinceMs: Date.parse(SINCE),
};

describe('createCompanionRoomContentWindowPort', () => {
  it('leaves non-room channels unwindowed (discord/telegram/api/DM untouched)', () => {
    const port = makePort(PRESENT_IN_DEN);
    for (const channelId of [
      'discord:123456',
      'telegram:42',
      'api:test',
      `companion-dm:${SELF_ID}:22222222-2222-4222-8222-222222222222`,
    ]) {
      expect(port.resolveWindow(channelId)).toEqual({ kind: 'unwindowed' });
    }
  });

  it('leaves a public place room unwindowed (default privacy = zero change)', () => {
    const port = makePort(PRESENT_IN_DEN);
    expect(port.resolveWindow('companion-room:living_room')).toEqual({ kind: 'unwindowed' });
  });

  it('windows a private room to the own presence since when present there', () => {
    const port = makePort(PRESENT_IN_DEN);
    expect(port.resolveWindow('companion-room:den')).toEqual({
      kind: 'windowed',
      floorMs: Date.parse(SINCE),
    });
  });

  it('closes a private room when present elsewhere or presence unknown (fail closed)', () => {
    const elsewhere = makePort({
      place: { siteId: 'vhome', placeId: 'living_room', kind: 'virtual' },
      sinceMs: Date.parse(SINCE),
    });
    expect(elsewhere.resolveWindow('companion-room:den')).toEqual({ kind: 'closed' });

    const unknown = makePort(null);
    expect(unknown.resolveWindow('companion-room:den')).toEqual({ kind: 'closed' });
  });

  it('closes a room whose place the registry does not know (fail closed)', () => {
    const port = makePort(PRESENT_IN_DEN);
    expect(port.resolveWindow('companion-room:ghost_room')).toEqual({ kind: 'closed' });
  });
});

// ── getOwnPresenceWindow (the floor source) ──

class FakePresenceStore implements CompanionPresenceStorePort {
  failNext: Error | null = null;
  sinceIso: string = SINCE;

  async upsertPresence(input: CompanionPresenceUpsertInput): Promise<CompanionPresenceRecord> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    return {
      companionId: input.companionId,
      siteId: input.siteId,
      placeId: input.placeId,
      kind: input.kind,
      since: this.sinceIso,
      updatedAt: NOW.toISOString(),
    };
  }

  async listByPlace(): Promise<CompanionPresenceRecord[]> {
    return [];
  }

  async listAll(): Promise<CompanionPresenceRecord[]> {
    return [];
  }

  async deletePresence(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

function makeRuntime(store: FakePresenceStore): CompanionPresenceRuntime {
  const emit = vi.fn(async () => undefined);
  return new CompanionPresenceRuntime({
    store,
    companionId: SELF_ID,
    eventBus: { emit } as unknown as EventBus,
    placesRegistry: PLACES,
    now: () => NOW,
  });
}

function situatedMessage(placeId: string): SubstrateMessage {
  return {
    id: 'msg-1',
    channelId: 'satellite:den',
    channelType: 'api',
    authorId: 'user-1',
    authorName: 'User',
    content: 'hello',
    timestamp: NOW,
    routing: { satellite: { placeId } } as unknown as SubstrateMessage['routing'],
  };
}

describe('CompanionPresenceRuntime.getOwnPresenceWindow', () => {
  it('is null before any situated write and reflects since after one', async () => {
    const store = new FakePresenceStore();
    const runtime = makeRuntime(store);
    expect(runtime.getOwnPresenceWindow()).toBeNull();

    await runtime.observeTurnPlace(situatedMessage('den'));
    expect(runtime.getOwnPresenceWindow()).toEqual({
      place: { siteId: 'vhome', placeId: 'den', kind: 'virtual' },
      sinceMs: Date.parse(SINCE),
    });
  });

  it('tracks a store-issued NEW window on refresh (stale re-arm semantics)', async () => {
    const store = new FakePresenceStore();
    const runtime = makeRuntime(store);
    await runtime.observeTurnPlace(situatedMessage('den'));

    const rearmed = new Date(NOW.getTime() - 1_000).toISOString();
    store.sinceIso = rearmed;
    await runtime.refreshOwnPresence();
    expect(runtime.getOwnPresenceWindow()?.sinceMs).toBe(Date.parse(rearmed));
  });

  it('fails closed to null on a write failure and after shutdown', async () => {
    const store = new FakePresenceStore();
    const runtime = makeRuntime(store);
    await runtime.observeTurnPlace(situatedMessage('den'));
    expect(runtime.getOwnPresenceWindow()).not.toBeNull();

    store.failNext = new Error('shared schema down');
    await runtime.refreshOwnPresence();
    expect(runtime.getOwnPresenceWindow()).toBeNull();

    await runtime.observeTurnPlace(situatedMessage('den'));
    expect(runtime.getOwnPresenceWindow()).not.toBeNull();
    await runtime.shutdown();
    expect(runtime.getOwnPresenceWindow()).toBeNull();
  });

  it('recordDeliberateMove updates the window and clears it on a failed move', async () => {
    const store = new FakePresenceStore();
    const runtime = makeRuntime(store);
    await runtime.recordDeliberateMove({ siteId: 'vhome', placeId: 'den', kind: 'virtual' });
    expect(runtime.getOwnPresenceWindow()).toEqual({
      place: { siteId: 'vhome', placeId: 'den', kind: 'virtual' },
      sinceMs: Date.parse(SINCE),
    });

    store.failNext = new Error('write refused');
    await expect(
      runtime.recordDeliberateMove({ siteId: 'vhome', placeId: 'living_room', kind: 'virtual' }),
    ).rejects.toThrow('write refused');
    expect(runtime.getOwnPresenceWindow()).toBeNull();
  });
});
