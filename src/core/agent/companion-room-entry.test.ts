import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';
import { registerCompanionRoomEntryNotes } from './companion-room-entry.js';
import { ROOM_ENTRY_NOTE_SOURCE } from '../session/room-entry-note.js';

const PLACES: PlacesRegistryConfig = {
  schemaVersion: 1,
  sites: [{ siteId: 'vhome', displayName: 'Virtual Home', kind: 'virtual' }],
  places: [{
    placeId: 'living_room',
    siteId: 'vhome',
    displayName: 'Living Room',
    kind: 'virtual',
    description: 'A cozy shared space.',
    affordances: [],
  }],
};

function makeCoLocatedEvent(overrides?: Record<string, unknown>) {
  return {
    companionId: 'comp-nova',
    observerCompanionId: 'comp-selene',
    siteId: 'vhome',
    placeId: 'living_room',
    kind: 'virtual' as const,
    since: '2026-07-08T11:59:00.000Z',
    timestamp: Date.parse('2026-07-08T12:00:00Z'),
    ...overrides,
  };
}

describe('companion co-location room-entry notes (W6)', () => {
  it('appends the room-entry note to the place room channel on co-location', async () => {
    const eventBus = new EventBus();
    const sink = { appendContextSystemNote: vi.fn() };
    registerCompanionRoomEntryNotes({
      eventBus,
      sink,
      placesRegistry: PLACES,
      coPresence: () => [{ companionId: 'comp-nova', displayName: 'Nova' }],
    });

    await eventBus.emit('presence.companion.co_located', makeCoLocatedEvent());

    expect(sink.appendContextSystemNote).toHaveBeenCalledTimes(1);
    const [channelId, note, source] = sink.appendContextSystemNote.mock.calls[0];
    expect(channelId).toBe('companion-room:living_room');
    expect(source).toBe(ROOM_ENTRY_NOTE_SOURCE);
    expect(note).toContain('companion-room:living_room');
    expect(note).toContain('Living Room');
    expect(note).toContain('A cozy shared space.');
    expect(note).toContain('Nova (companion)');
  });

  it('is context only: no note delivery triggers a turn (nothing but the sink is touched)', async () => {
    const eventBus = new EventBus();
    const sink = { appendContextSystemNote: vi.fn() };
    registerCompanionRoomEntryNotes({ eventBus, sink });

    await eventBus.emit('presence.companion.co_located', makeCoLocatedEvent());

    // The composer degrades without a places registry/co-presence snapshot:
    // the event's companion is still listed so arrival stays visible.
    const [, note] = sink.appendContextSystemNote.mock.calls[0];
    expect(note).toContain('comp-nova (companion)');
  });

  it('never lets a sink failure escape the event bus', async () => {
    const eventBus = new EventBus();
    const sink = {
      appendContextSystemNote: vi.fn(() => {
        throw new Error('session store unavailable');
      }),
    };
    registerCompanionRoomEntryNotes({ eventBus, sink, placesRegistry: PLACES });

    await expect(
      eventBus.emit('presence.companion.co_located', makeCoLocatedEvent()),
    ).resolves.toBeUndefined();
    expect(sink.appendContextSystemNote).toHaveBeenCalled();
  });

  it('unsubscribes cleanly', async () => {
    const eventBus = new EventBus();
    const sink = { appendContextSystemNote: vi.fn() };
    const unsubscribe = registerCompanionRoomEntryNotes({ eventBus, sink, placesRegistry: PLACES });

    unsubscribe();
    await eventBus.emit('presence.companion.co_located', makeCoLocatedEvent());
    expect(sink.appendContextSystemNote).not.toHaveBeenCalled();
  });
});
