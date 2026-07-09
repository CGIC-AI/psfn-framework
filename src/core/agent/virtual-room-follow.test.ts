// ── Unit tests for virtual-activity presence follow (vinz.21) ──
// Drives the follower over fakes: trusted-partner activity in a place-bound
// virtual companion-room pulls the companion's virtual presence there through
// the deliberate-move port path with arrival semantics (room-entry note +
// audit event); physical-origin turns, untrusted/MI/system authors, unknown
// or physical rooms, already-present turns, and debounced repeats all no-op;
// flag-off (null port) the move stays local with the note still delivered.

import { describe, expect, it, vi } from 'vitest';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { CompanionPresenceTurnPort } from './companion-presence-runtime.js';
import type { SituatedPlaceRef } from './substrate-agent/runtime-context-sections/situated-presence.js';
import {
  createVirtualRoomFollower,
  DEFAULT_VIRTUAL_FOLLOW_DEBOUNCE_MS,
  type VirtualFollowAuthorContext,
} from './virtual-room-follow.js';

const NOW_MS = Date.parse('2026-07-08T12:00:00.000Z');
const ROOM_CHANNEL = 'companion-room:place.mud-tavern';

const PLACES_REGISTRY: PlacesRegistryConfig = {
  schemaVersion: 1,
  sites: [
    { siteId: 'site.home', displayName: 'Home', kind: 'physical' },
    { siteId: 'site.mud', displayName: 'The MUD', kind: 'virtual' },
  ],
  places: [
    {
      placeId: 'place.living-room',
      siteId: 'site.home',
      displayName: 'Living Room',
      kind: 'physical',
      affordances: [],
    },
    {
      placeId: 'place.mud-tavern',
      siteId: 'site.mud',
      displayName: 'The Rusty Tankard',
      kind: 'virtual',
      description: 'A dim tavern that smells of pixels and ale.',
      affordances: [],
    },
  ],
};

function makeMessage(overrides: Partial<SubstrateMessage> = {}): SubstrateMessage {
  return {
    id: 'msg-1',
    channelId: ROOM_CHANNEL,
    channelType: 'api',
    authorId: 'user-partner',
    authorName: 'Pierre',
    content: 'hello from the tavern',
    timestamp: new Date(NOW_MS),
    ...overrides,
  } as SubstrateMessage;
}

function makeAuthor(overrides: Partial<VirtualFollowAuthorContext> = {}): VirtualFollowAuthorContext {
  return {
    trustLevel: 'primary',
    speakerRole: 'user',
    speakingWithIsMachineIntelligence: false,
    canonicalContactKey: 'contact-partner',
    ...overrides,
  };
}

function makePort(): { port: CompanionPresenceTurnPort; moves: SituatedPlaceRef[]; failNext: { error: Error | null } } {
  const moves: SituatedPlaceRef[] = [];
  const failNext: { error: Error | null } = { error: null };
  const port: CompanionPresenceTurnPort = {
    observeTurnPlace: async () => undefined,
    refreshOwnPresence: async () => undefined,
    recordDeliberateMove: async (place) => {
      if (failNext.error) {
        const error = failNext.error;
        failNext.error = null;
        throw error;
      }
      moves.push({ ...place });
    },
    getCoPresent: () => [],
  };
  return { port, moves, failNext };
}

function makeEventBus(): { bus: EventBus; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn(async () => undefined);
  return { bus: { emit } as unknown as EventBus, emit };
}

const silentLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

interface HarnessOptions {
  port?: CompanionPresenceTurnPort | null;
  now?: () => number;
  currentPlaceId?: string | undefined;
}

function makeHarness(options: HarnessOptions = {}) {
  const { bus, emit } = makeEventBus();
  const applyVirtualMove = vi.fn();
  const notes: Array<{ channelId: string; note: string; source: string }> = [];
  const follower = createVirtualRoomFollower({
    placesRegistry: PLACES_REGISTRY,
    getCompanionPresence: () => options.port ?? null,
    applyVirtualMove,
    resolveSituatedFallbackPlaceId: () => options.currentPlaceId,
    roomEntryNoteSink: {
      appendContextSystemNote: (channelId, note, source) => {
        notes.push({ channelId, note, source });
      },
    },
    eventBus: bus,
    now: options.now ?? (() => NOW_MS),
    logger: silentLogger,
  });
  return { follower, emit, applyVirtualMove, notes };
}

describe('createVirtualRoomFollower (vinz.21 virtual follow)', () => {
  it('pulls virtual presence to the room for trusted partner activity (port write + local move + entry note + event)', async () => {
    const { port, moves } = makePort();
    const { follower, emit, applyVirtualMove, notes } = makeHarness({
      port,
      currentPlaceId: 'place.living-room',
    });

    await follower.maybeFollow(makeMessage(), makeAuthor());

    // Same port path a deliberate move uses (arrival semantics inside).
    expect(moves).toEqual([{ siteId: 'site.mud', placeId: 'place.mud-tavern', kind: 'virtual' }]);
    // Local overlay through the same seam the world tool uses.
    expect(applyVirtualMove).toHaveBeenCalledWith('place.mud-tavern');
    // W5 room-entry note lands in the room channel's session.
    expect(notes).toHaveLength(1);
    expect(notes[0].channelId).toBe(ROOM_CHANNEL);
    expect(notes[0].source).toBe('room_entry');
    expect(notes[0].note).toContain('The Rusty Tankard');
    // Audit event: an operator can see WHY she moved.
    expect(emit).toHaveBeenCalledWith('presence.emanation.follow', expect.objectContaining({
      trigger: 'virtual_activity',
      contactId: 'contact-partner',
      channelId: ROOM_CHANNEL,
      fromPlaceId: 'place.living-room',
      toPlaceId: 'place.mud-tavern',
      siteId: 'site.mud',
      kind: 'virtual',
    }));
  });

  it('never follows on a physical-origin turn (physical outranks, vinz.29)', async () => {
    const { port, moves } = makePort();
    const { follower, applyVirtualMove } = makeHarness({ port });

    await follower.maybeFollow(
      makeMessage({
        routing: { satellite: { satelliteId: 'sat-1', placeId: 'place.living-room' } } as unknown as SubstrateMessage['routing'],
      }),
      makeAuthor(),
    );

    expect(moves).toHaveLength(0);
    expect(applyVirtualMove).not.toHaveBeenCalled();
  });

  it('ignores channels that are not companion rooms', async () => {
    const { port, moves } = makePort();
    const { follower, applyVirtualMove } = makeHarness({ port });

    await follower.maybeFollow(makeMessage({ channelId: 'discord:general' }), makeAuthor());
    await follower.maybeFollow(makeMessage({ channelId: 'companion-dm:a:b' }), makeAuthor());

    expect(moves).toHaveLength(0);
    expect(applyVirtualMove).not.toHaveBeenCalled();
  });

  it('fails closed on unknown or non-virtual room places', async () => {
    const { port, moves } = makePort();
    const { follower, applyVirtualMove } = makeHarness({ port });

    await follower.maybeFollow(makeMessage({ channelId: 'companion-room:place.nowhere' }), makeAuthor());
    await follower.maybeFollow(makeMessage({ channelId: 'companion-room:place.living-room' }), makeAuthor());

    expect(moves).toHaveLength(0);
    expect(applyVirtualMove).not.toHaveBeenCalled();
  });

  it('never follows system-role, machine-intelligence, or below-trusted authors', async () => {
    const { port, moves } = makePort();
    const { follower, applyVirtualMove } = makeHarness({ port });

    await follower.maybeFollow(makeMessage(), makeAuthor({ speakerRole: 'system' }));
    await follower.maybeFollow(makeMessage(), makeAuthor({ speakingWithIsMachineIntelligence: true }));
    await follower.maybeFollow(makeMessage(), makeAuthor({ trustLevel: 'regular' }));
    await follower.maybeFollow(makeMessage(), makeAuthor({ trustLevel: 'public' }));

    expect(moves).toHaveLength(0);
    expect(applyVirtualMove).not.toHaveBeenCalled();
  });

  it('is a no-op when the turn already resolves the companion to that room', async () => {
    const { port, moves } = makePort();
    const { follower, applyVirtualMove, emit } = makeHarness({
      port,
      currentPlaceId: 'place.mud-tavern',
    });

    await follower.maybeFollow(makeMessage(), makeAuthor());

    expect(moves).toHaveLength(0);
    expect(applyVirtualMove).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('debounces: two rapid partner messages produce exactly one move', async () => {
    const { port, moves } = makePort();
    let nowMs = NOW_MS;
    let currentPlaceId: string | undefined = 'place.living-room';
    const { bus, emit } = makeEventBus();
    const follower = createVirtualRoomFollower({
      placesRegistry: PLACES_REGISTRY,
      getCompanionPresence: () => port,
      applyVirtualMove: (placeId) => {
        currentPlaceId = placeId;
      },
      resolveSituatedFallbackPlaceId: () => currentPlaceId,
      eventBus: bus,
      now: () => nowMs,
      logger: silentLogger,
    });

    await follower.maybeFollow(makeMessage(), makeAuthor());
    // Simulate leaving again (fallback resolves elsewhere) inside the window.
    currentPlaceId = 'place.living-room';
    nowMs += 5_000;
    await follower.maybeFollow(makeMessage(), makeAuthor());

    expect(moves).toHaveLength(1);

    // After the window passes, the follow resumes.
    nowMs += DEFAULT_VIRTUAL_FOLLOW_DEBOUNCE_MS;
    await follower.maybeFollow(makeMessage(), makeAuthor());
    expect(moves).toHaveLength(2);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('aborts on a failed shared write: no local move, no note, no event, no throw', async () => {
    const { port, moves, failNext } = makePort();
    const { follower, applyVirtualMove, notes, emit } = makeHarness({
      port,
      currentPlaceId: 'place.living-room',
    });
    failNext.error = new Error('shared schema down');

    await expect(follower.maybeFollow(makeMessage(), makeAuthor())).resolves.toBeUndefined();

    expect(moves).toHaveLength(0);
    expect(applyVirtualMove).not.toHaveBeenCalled();
    expect(notes).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
    expect(silentLogger.error).toHaveBeenCalled();
  });

  it('flag-off (null port): the virtual follow still works local-only with the entry note', async () => {
    const { follower, applyVirtualMove, notes, emit } = makeHarness({
      port: null,
      currentPlaceId: 'place.living-room',
    });

    await follower.maybeFollow(makeMessage(), makeAuthor());

    expect(applyVirtualMove).toHaveBeenCalledWith('place.mud-tavern');
    expect(notes).toHaveLength(1);
    expect(emit).toHaveBeenCalledWith('presence.emanation.follow', expect.objectContaining({
      trigger: 'virtual_activity',
      toPlaceId: 'place.mud-tavern',
    }));
  });
});
