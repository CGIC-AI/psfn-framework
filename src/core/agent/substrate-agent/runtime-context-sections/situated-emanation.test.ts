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

  // ── Deliberate virtual navigation overlay (vinz.26, contract s10wm) ──

  it('foregrounds a deliberate virtual move without clobbering the physical emanation', () => {
    const tracker = new SituatedEmanationTracker();
    const presence = satellitePresence('sat.living-room', 'Living Room satellite');
    tracker.observe(makeTurn({ placeId: 'place.living-room', presence }));

    tracker.moveToVirtualPlace('place.mud-tavern');

    // Placeless turns now foreground the virtual destination …
    expect(tracker.resolvePlaceId()).toBe('place.mud-tavern');
    expect(tracker.resolveVirtualMovePlaceId()).toBe('place.mud-tavern');
    // … while the PHYSICAL emanation is untouched (not clobbered): the
    // established place and its presence survive the virtual move intact.
    expect(tracker.snapshot()).toEqual({ presence, placeId: 'place.living-room' });
    expect(tracker.resolvePresence()).toEqual(presence);
  });

  it('foregrounds a virtual move even when no physical emanation was ever established', () => {
    const tracker = new SituatedEmanationTracker();
    tracker.moveToVirtualPlace('place.mud-tavern');
    expect(tracker.resolvePlaceId()).toBe('place.mud-tavern');
    expect(tracker.snapshot()).toBeUndefined();
  });

  it('supersedes a virtual move with the next place-bearing physical turn (latest event wins)', () => {
    const tracker = new SituatedEmanationTracker();
    tracker.moveToVirtualPlace('place.mud-tavern');

    tracker.observe(makeTurn({
      placeId: 'place.kitchen',
      presence: satellitePresence('sat.kitchen', 'Kitchen satellite'),
    }));

    // Decision 13 blend default: a fresh physical emanation resets the
    // foregrounded place; the deliberate virtual position is cleared.
    expect(tracker.resolvePlaceId()).toBe('place.kitchen');
    expect(tracker.resolveVirtualMovePlaceId()).toBeUndefined();
  });

  it('keeps a virtual move across placeless turns (they are not departures)', () => {
    const tracker = new SituatedEmanationTracker();
    tracker.moveToVirtualPlace('place.mud-tavern');
    tracker.observe(makeTurn({}));
    expect(tracker.resolvePlaceId()).toBe('place.mud-tavern');
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

  // ── Presence-driven emanation handoff (conversation-follows-you, vinz.20) ──

  it('hands the emanation off to a new place without a turn (presence follow)', () => {
    const tracker = new SituatedEmanationTracker();
    tracker.observe(makeTurn({
      placeId: 'place.living-room',
      presence: satellitePresence('sat.living-room', 'Living Room satellite'),
    }));

    tracker.handoffToPlace('place.kitchen');

    expect(tracker.resolvePlaceId()).toBe('place.kitchen');
    expect(tracker.snapshot()?.placeId).toBe('place.kitchen');
    // The old satellite's presence metadata does not survive the handoff —
    // only a real device turn can honestly carry presence for the new place.
    expect(tracker.resolvePresence()).toBeUndefined();
  });

  it('establishes a first emanation via handoff when never situated', () => {
    const tracker = new SituatedEmanationTracker();
    tracker.handoffToPlace('place.kitchen');
    expect(tracker.resolvePlaceId()).toBe('place.kitchen');
  });

  it('supersedes a deliberate virtual move on handoff (fresh physical emanation wins)', () => {
    const tracker = new SituatedEmanationTracker();
    tracker.observe(makeTurn({
      placeId: 'place.living-room',
      presence: satellitePresence('sat.living-room', 'Living Room satellite'),
    }));
    tracker.moveToVirtualPlace('place.mud-tavern');
    expect(tracker.resolvePlaceId()).toBe('place.mud-tavern');

    tracker.handoffToPlace('place.kitchen');

    expect(tracker.resolveVirtualMovePlaceId()).toBeUndefined();
    expect(tracker.resolvePlaceId()).toBe('place.kitchen');
  });

  it('keeps a handed-off place across placeless turns until superseded', () => {
    const tracker = new SituatedEmanationTracker();
    tracker.handoffToPlace('place.kitchen');
    tracker.observe(makeTurn({}));
    expect(tracker.resolvePlaceId()).toBe('place.kitchen');

    // The next place-bearing satellite turn supersedes the handoff normally.
    tracker.observe(makeTurn({
      placeId: 'place.living-room',
      presence: satellitePresence('sat.living-room', 'Living Room satellite'),
    }));
    expect(tracker.resolvePlaceId()).toBe('place.living-room');
  });
});
