// ── Unit tests for physical conversation-follows-you (vinz.20) ──
// Drives the presence-follow decorator over fakes: a fresh, trusted identity
// claim at another satellite-bound physical place hands the emanation off
// (shared write through the port + local handoff + audit event), every
// fail-closed case is a no-op that still delivers the presence note, the
// debounce bound collapses rapid events into one move, and flag-off (null
// port) keeps the follow local-only.

import { describe, expect, it, vi } from 'vitest';
import type { PlacesRegistryConfig } from '../../../shared/contracts/places-registry.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { CompanionPresenceTurnPort } from '../companion-presence-runtime.js';
import type { SituatedPlaceRef } from '../substrate-agent/runtime-context-sections/situated-presence.js';
import type {
  AnonymousResolvedPresence,
  KnownResolvedPresence,
} from './identity-claim-resolver.js';
import type { IdentityClaimPerceptionEvent } from './sensor-cognition-bridge.js';
import {
  createPresenceFollowSink,
  DEFAULT_PRESENCE_FOLLOW_DEBOUNCE_MS,
  DEFAULT_PRESENCE_FOLLOW_FRESHNESS_MS,
  type EmanationFollowTarget,
} from './presence-follow.js';

const NOW_MS = Date.parse('2026-07-08T12:00:00.000Z');

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
      placeId: 'place.kitchen',
      siteId: 'site.home',
      displayName: 'Kitchen',
      kind: 'physical',
      affordances: [],
    },
    {
      placeId: 'place.mud-tavern',
      siteId: 'site.mud',
      displayName: 'The Rusty Tankard',
      kind: 'virtual',
      affordances: [],
    },
  ],
};

function makeClaimEvent(
  overrides: Partial<IdentityClaimPerceptionEvent> = {},
): IdentityClaimPerceptionEvent {
  return {
    kind: 'identity_claim',
    action: 'observed',
    eventId: 'evt-1',
    rawEventType: 'face.identity-claim.observed',
    source: 'sat-kitchen',
    occurredAt: new Date(NOW_MS - 1_000).toISOString(),
    receivedAt: new Date(NOW_MS - 500).toISOString(),
    scope: 'face',
    satelliteId: 'sat-kitchen',
    siteId: 'site.home',
    placeId: 'place.kitchen',
    placeDisplayName: 'Kitchen',
    channelId: 'satellite:kitchen',
    hubIdentityId: 'hub-abc',
    confidence: 0.95,
    claimSource: 'face',
    ...overrides,
  };
}

function makeKnown(
  overrides: Partial<KnownResolvedPresence> = {},
  eventOverrides: Partial<IdentityClaimPerceptionEvent> = {},
): KnownResolvedPresence {
  return {
    kind: 'known',
    event: makeClaimEvent(eventOverrides),
    hubIdentityId: 'hub-abc',
    confidence: 0.95,
    contactId: 'contact-partner',
    displayName: 'Pierre',
    trustLevel: 'primary' as TrustLevel,
    relationshipType: 'partner',
    isMachineIntelligence: false,
    ...overrides,
  };
}

function makeAnonymous(
  eventOverrides: Partial<IdentityClaimPerceptionEvent> = {},
): AnonymousResolvedPresence {
  return {
    kind: 'anonymous',
    reason: 'unenrolled',
    event: makeClaimEvent(eventOverrides),
    hubIdentityId: 'hub-unknown',
    confidence: 0.9,
  };
}

class FakeTarget implements EmanationFollowTarget {
  currentPlaceId: string | undefined = 'place.living-room';
  handoffs: Array<{ placeId: string; siteId: string; placeDisplayName: string }> = [];

  resolveCurrentEmanationPlaceId(): string | undefined {
    return this.currentPlaceId;
  }

  applyEmanationFollowHandoff(input: {
    placeId: string;
    siteId: string;
    placeDisplayName: string;
  }): void {
    this.handoffs.push({ ...input });
    this.currentPlaceId = input.placeId;
  }
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

function makeInner(): { inner: { handleResolvedPresence: ReturnType<typeof vi.fn> }; delivered: unknown[] } {
  const delivered: unknown[] = [];
  const handleResolvedPresence = vi.fn((presence: unknown) => {
    delivered.push(presence);
  });
  return { inner: { handleResolvedPresence }, delivered };
}

const silentLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

interface HarnessOptions {
  port?: CompanionPresenceTurnPort | null;
  now?: () => number;
  registry?: PlacesRegistryConfig;
}

function makeHarness(options: HarnessOptions = {}) {
  const target = new FakeTarget();
  const { bus, emit } = makeEventBus();
  const { inner, delivered } = makeInner();
  const sink = createPresenceFollowSink({
    inner,
    target,
    getCompanionPresence: () => options.port ?? null,
    placesRegistry: options.registry ?? PLACES_REGISTRY,
    eventBus: bus,
    now: options.now ?? (() => NOW_MS),
    logger: silentLogger,
  });
  return { sink, target, emit, delivered };
}

describe('createPresenceFollowSink (vinz.20 physical follow)', () => {
  it('hands the emanation off for a fresh primary-trust claim at another physical place', async () => {
    const { port, moves } = makePort();
    const { sink, target, emit, delivered } = makeHarness({ port });

    await sink.handleResolvedPresence(makeKnown());

    // Shared write through the SAME port path a deliberate move uses.
    expect(moves).toEqual([{ siteId: 'site.home', placeId: 'place.kitchen', kind: 'physical' }]);
    // Local handoff applied with the registry coordinates.
    expect(target.handoffs).toEqual([{
      placeId: 'place.kitchen',
      siteId: 'site.home',
      placeDisplayName: 'Kitchen',
    }]);
    // Audit event: an operator can see WHY she moved.
    expect(emit).toHaveBeenCalledWith('presence.emanation.follow', expect.objectContaining({
      trigger: 'physical_presence',
      contactId: 'contact-partner',
      satelliteId: 'sat-kitchen',
      fromPlaceId: 'place.living-room',
      toPlaceId: 'place.kitchen',
      siteId: 'site.home',
      kind: 'physical',
    }));
    // Note delivery still happens downstream.
    expect(delivered).toHaveLength(1);
  });

  it('follows for trusted-tier contacts and establishes a first emanation when never situated', async () => {
    const { port, moves } = makePort();
    const { sink, target } = makeHarness({ port });
    target.currentPlaceId = undefined;

    await sink.handleResolvedPresence(makeKnown({ trustLevel: 'trusted' }));

    expect(moves).toHaveLength(1);
    expect(target.handoffs).toHaveLength(1);
  });

  it('never moves for an anonymous presence but still delivers the note', async () => {
    const { port, moves } = makePort();
    const { sink, target, emit, delivered } = makeHarness({ port });

    await sink.handleResolvedPresence(makeAnonymous());

    expect(moves).toHaveLength(0);
    expect(target.handoffs).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
    expect(delivered).toHaveLength(1);
  });

  it('never moves for contacts below primary/trusted', async () => {
    const { port, moves } = makePort();
    const { sink, target } = makeHarness({ port });

    await sink.handleResolvedPresence(makeKnown({ trustLevel: 'regular' }));
    await sink.handleResolvedPresence(makeKnown({ trustLevel: 'public' }));

    expect(moves).toHaveLength(0);
    expect(target.handoffs).toHaveLength(0);
  });

  it('never moves for a machine-intelligence contact', async () => {
    const { port, moves } = makePort();
    const { sink, target } = makeHarness({ port });

    await sink.handleResolvedPresence(makeKnown({ isMachineIntelligence: true }));

    expect(moves).toHaveLength(0);
    expect(target.handoffs).toHaveLength(0);
  });

  it('never moves on a stale or unparsable occurredAt (freshness bound)', async () => {
    const { port, moves } = makePort();
    const { sink, target } = makeHarness({ port });

    await sink.handleResolvedPresence(makeKnown({}, {
      occurredAt: new Date(NOW_MS - DEFAULT_PRESENCE_FOLLOW_FRESHNESS_MS - 1).toISOString(),
    }));
    await sink.handleResolvedPresence(makeKnown({}, { occurredAt: 'not-a-timestamp' }));

    expect(moves).toHaveLength(0);
    expect(target.handoffs).toHaveLength(0);
  });

  it('never moves to an unknown or non-physical place', async () => {
    const { port, moves } = makePort();
    const { sink, target } = makeHarness({ port });

    await sink.handleResolvedPresence(makeKnown({}, { placeId: 'place.nowhere' }));
    await sink.handleResolvedPresence(makeKnown({}, {
      placeId: 'place.mud-tavern',
      siteId: 'site.mud',
    }));

    expect(moves).toHaveLength(0);
    expect(target.handoffs).toHaveLength(0);
  });

  it('is a no-op when already emanating at the claimed place', async () => {
    const { port, moves } = makePort();
    const { sink, target, emit } = makeHarness({ port });
    target.currentPlaceId = 'place.kitchen';

    await sink.handleResolvedPresence(makeKnown());

    expect(moves).toHaveLength(0);
    expect(target.handoffs).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('debounces: two rapid trusted events produce exactly one move', async () => {
    const { port, moves } = makePort();
    let nowMs = NOW_MS;
    const { sink, target } = makeHarness({ port, now: () => nowMs });

    await sink.handleResolvedPresence(makeKnown());
    // Second event 5s later at a DIFFERENT place, still inside the window.
    nowMs += 5_000;
    await sink.handleResolvedPresence(makeKnown({}, {
      placeId: 'place.living-room',
      placeDisplayName: 'Living Room',
      satelliteId: 'sat-living-room',
      occurredAt: new Date(nowMs - 1_000).toISOString(),
    }));

    expect(moves).toHaveLength(1);
    expect(target.handoffs).toHaveLength(1);

    // After the window passes, the follow resumes.
    nowMs += DEFAULT_PRESENCE_FOLLOW_DEBOUNCE_MS;
    await sink.handleResolvedPresence(makeKnown({}, {
      placeId: 'place.living-room',
      placeDisplayName: 'Living Room',
      satelliteId: 'sat-living-room',
      occurredAt: new Date(nowMs - 1_000).toISOString(),
    }));
    expect(moves).toHaveLength(2);
    expect(target.handoffs).toHaveLength(2);
  });

  it('aborts the move when the shared presence write fails (no local divergence), note still delivers', async () => {
    const { port, moves, failNext } = makePort();
    const { sink, target, emit, delivered } = makeHarness({ port });
    failNext.error = new Error('shared schema down');

    await sink.handleResolvedPresence(makeKnown());

    expect(moves).toHaveLength(0);
    expect(target.handoffs).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
    expect(delivered).toHaveLength(1);
    expect(silentLogger.error).toHaveBeenCalled();
  });

  it('flag-off (null port): the physical follow still works local-only', async () => {
    const { sink, target, emit } = makeHarness({ port: null });

    await sink.handleResolvedPresence(makeKnown());

    expect(target.handoffs).toEqual([{
      placeId: 'place.kitchen',
      siteId: 'site.home',
      placeDisplayName: 'Kitchen',
    }]);
    expect(emit).toHaveBeenCalledWith('presence.emanation.follow', expect.objectContaining({
      trigger: 'physical_presence',
      toPlaceId: 'place.kitchen',
    }));
  });
});
