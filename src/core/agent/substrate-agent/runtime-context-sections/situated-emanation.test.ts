// ── Unit tests for the active-emanation → situated-place tracker (S10 B2) ──
// Pins the handoff-aware contract: a place-bearing turn establishes the current
// emanation; a placeless turn consumes it; switching satellites moves the place.
// Fixtures are neutral ("Living Room" / "Kitchen") — no real people names.

import { describe, expect, it } from 'vitest';
import type { SubstrateMessage } from '../../../../shared/contracts/runtime.js';
import type { CompanionPresenceMetadata } from '../../presence-metadata.js';
import { SituatedEmanationTracker } from './situated-emanation.js';

function satellitePresence(satelliteId: string, label: string): CompanionPresenceMetadata {
  return { kind: 'satellite', satelliteId, companionId: 'companion.self', siteId: 'site.home', label };
}

function makeTurn(input: {
  placeId?: string;
  presence?: CompanionPresenceMetadata;
}): SubstrateMessage {
  return {
    id: 'msg-emanation',
    channelId: 'channel:test',
    channelType: 'api',
    authorId: 'author-neutral',
    authorName: 'Neutral',
    content: 'hi',
    timestamp: new Date('2026-07-01T16:00:00.000Z'),
    routing: {
      ...(input.presence ? { presence: input.presence } : {}),
      ...(input.placeId ? { satellite: { placeId: input.placeId } } : {}),
    } as unknown as SubstrateMessage['routing'],
  } as SubstrateMessage;
}

describe('SituatedEmanationTracker', () => {
  it('starts empty and resolves nothing', () => {
    const tracker = new SituatedEmanationTracker();
    expect(tracker.resolvePlaceId()).toBeUndefined();
    expect(tracker.resolvePresence()).toBeUndefined();
    expect(tracker.snapshot()).toBeUndefined();
  });

  it('establishes the current emanation from a place-bearing satellite turn', () => {
    const tracker = new SituatedEmanationTracker();
    const presence = satellitePresence('sat.living-room', 'Living Room satellite');
    tracker.observe(makeTurn({ placeId: 'place.living-room', presence }));
    expect(tracker.resolvePlaceId()).toBe('place.living-room');
    expect(tracker.resolvePresence()).toEqual(presence);
  });

  it('leaves the current emanation untouched on a placeless turn', () => {
    const tracker = new SituatedEmanationTracker();
    tracker.observe(makeTurn({
      placeId: 'place.living-room',
      presence: satellitePresence('sat.living-room', 'Living Room satellite'),
    }));
    // A later placeless (Discord/Telegram) turn must not clear the place.
    tracker.observe(makeTurn({}));
    expect(tracker.resolvePlaceId()).toBe('place.living-room');
  });

  it('moves the foregrounded place when emanation switches between two satellites', () => {
    const tracker = new SituatedEmanationTracker();
    tracker.observe(makeTurn({
      placeId: 'place.living-room',
      presence: satellitePresence('sat.living-room', 'Living Room satellite'),
    }));
    expect(tracker.resolvePlaceId()).toBe('place.living-room');

    tracker.observe(makeTurn({
      placeId: 'place.kitchen',
      presence: satellitePresence('sat.kitchen', 'Kitchen satellite'),
    }));
    expect(tracker.resolvePlaceId()).toBe('place.kitchen');
    expect(tracker.resolvePresence()).toEqual(satellitePresence('sat.kitchen', 'Kitchen satellite'));
  });

  it('never establishes a location from a conflicting/unresolvable presence', () => {
    const tracker = new SituatedEmanationTracker();
    // A satellite record that also claims to be the active/primary emanation is
    // conflicting metadata; resolveActiveEmanationState rejects it.
    const conflicting = {
      kind: 'satellite',
      satelliteId: 'sat.bad',
      companionId: 'companion.self',
      isActive: true,
    } as unknown as CompanionPresenceMetadata;
    tracker.observe(makeTurn({ placeId: 'place.living-room', presence: conflicting }));
    expect(tracker.resolvePlaceId()).toBeUndefined();
  });
});
