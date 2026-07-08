// ── Direct unit tests for the situated-presence section producer (S10 B1) ──
// Pins the producer contract: where-am-I / what's-here / who-else-is-here in,
// a <runtime_situated_presence> block (or nothing) out. Fixtures are neutral
// ("Living Room", "operator") — no real people names.

import { describe, expect, it } from 'vitest';
import type { SubstrateMessage } from '../../../../shared/contracts/runtime.js';
import type { PlacesRegistryConfig } from '../../../../shared/contracts/places-registry.js';
import { resolveWikiRetrievalPlan } from '../../../../faculties/wiki/retrieval.js';
import type { CompanionPresenceMetadata } from '../../presence-metadata.js';
import {
  buildSituatedPresenceContextBlock,
  resolveSituatedPlaceRef,
  resolveSituatedSiteId,
} from './situated-presence.js';
import { SituatedEmanationTracker } from './situated-emanation.js';

const PLACES_REGISTRY: PlacesRegistryConfig = {
  schemaVersion: 1,
  sites: [
    { siteId: 'site.home', displayName: 'Home', kind: 'physical' },
    { siteId: 'site.mud', displayName: 'The MUD', kind: 'virtual' },
    { siteId: 'site.mindspace', displayName: 'Home Mindspace', kind: 'virtual' },
  ],
  places: [
    {
      placeId: 'place.living-room',
      siteId: 'site.home',
      displayName: 'Living Room',
      kind: 'physical',
      description: 'A cozy room with a couch and a reading nook.',
      affordances: [
        {
          affordanceId: 'aff.presence',
          role: 'perceiver',
          kind: 'presence',
          backend: 'satellite',
          displayName: 'Presence Sensor',
        },
        {
          affordanceId: 'aff.lamp',
          role: 'effector',
          kind: 'light',
          backend: 'ha',
          displayName: 'Floor Lamp',
          control: ['on', 'off'],
        },
      ],
    },
    {
      placeId: 'place.kitchen',
      siteId: 'site.home',
      displayName: 'Kitchen',
      kind: 'physical',
      affordances: [
        {
          affordanceId: 'aff.kitchen-light',
          role: 'effector',
          kind: 'light',
          backend: 'ha',
          displayName: 'Ceiling Light',
          control: ['on', 'off'],
        },
      ],
    },
    {
      placeId: 'place.mud-tavern',
      siteId: 'site.mud',
      displayName: 'The Rusty Tankard',
      kind: 'virtual',
      description: 'A low-beamed virtual tavern; a fire crackles in the hearth.',
      affordances: [],
    },
    {
      placeId: 'place.living-room-twin',
      siteId: 'site.mindspace',
      displayName: 'Living Room (Twin)',
      kind: 'virtual',
      description: 'A shared reflection of the living room.',
      mirrorsPlaceId: 'place.living-room',
      affordances: [],
    },
  ],
};

const KITCHEN_PRESENCE: CompanionPresenceMetadata = {
  kind: 'satellite',
  satelliteId: 'sat.kitchen',
  companionId: 'companion.self',
  siteId: 'site.home',
  label: 'Kitchen satellite',
};

const SATELLITE_PRESENCE: CompanionPresenceMetadata = {
  kind: 'satellite',
  satelliteId: 'sat.living-room',
  companionId: 'companion.self',
  siteId: 'site.home',
  label: 'Living Room satellite',
};

function makeMessage(overrides: Partial<SubstrateMessage> = {}): SubstrateMessage {
  return {
    id: 'msg-situated-1',
    channelId: 'satellite:living-room:evening',
    channelType: 'api',
    authorId: 'user-neutral',
    authorName: 'Neutral',
    content: 'where am I?',
    timestamp: new Date('2026-07-01T16:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Builds routing with an optional satellite `placeId` (a field a sibling
 * workstream adds to the declared type on a different branch) plus optional
 * presence, cast structurally so this branch never touches the satellite
 * contract.
 */
function routing(input: {
  placeId?: string;
  presence?: CompanionPresenceMetadata;
}): SubstrateMessage['routing'] {
  return {
    ...(input.presence ? { presence: input.presence } : {}),
    ...(input.placeId ? { satellite: { placeId: input.placeId } } : {}),
  } as unknown as SubstrateMessage['routing'];
}

describe('situated-presence producer', () => {
  it('renders nothing when there is no presence and no place', () => {
    expect(buildSituatedPresenceContextBlock({ message: makeMessage() })).toBe('');
    // Empty registry + placeId that resolves to nothing is still fully empty.
    expect(
      buildSituatedPresenceContextBlock({
        message: makeMessage({ routing: routing({ placeId: 'place.nowhere' }) }),
        placesRegistry: PLACES_REGISTRY,
      }),
    ).toBe('');
  });

  it('renders the block from a resolved place plus presence', () => {
    const block = buildSituatedPresenceContextBlock({
      message: makeMessage({
        routing: routing({ placeId: 'place.living-room', presence: SATELLITE_PRESENCE }),
      }),
      placesRegistry: PLACES_REGISTRY,
    });
    expect(block).toContain('<runtime_situated_presence>');
    expect(block).toContain('Here: Living Room (physical place)');
    expect(block).toContain('Site: Home');
    expect(block).toContain('Surroundings: A cozy room with a couch and a reading nook.');
  });

  it('lists affordances by role with display name / kind / role only', () => {
    const block = buildSituatedPresenceContextBlock({
      message: makeMessage({ routing: routing({ placeId: 'place.living-room' }) }),
      placesRegistry: PLACES_REGISTRY,
    });
    expect(block).toContain('Perceivers here (what can sense this place):');
    expect(block).toContain('- Presence Sensor (presence, perceiver)');
    expect(block).toContain('Effectors here');
    expect(block).toContain('- Floor Lamp (light, effector)');
    // No control verbs leak into the rendered affordance lines.
    expect(block).not.toContain('on, off');
    expect(block).toContain('world tool');
  });

  it('falls back to the presence label when no place resolves (presence is now a consumer)', () => {
    const block = buildSituatedPresenceContextBlock({
      message: makeMessage({ routing: routing({ presence: SATELLITE_PRESENCE }) }),
    });
    expect(block).toContain('<runtime_situated_presence>');
    expect(block).toContain('Here: Living Room satellite');
    expect(block).not.toContain('Perceivers here');
  });

  it('renders an honest not-modeled line when presence carries no location hint', () => {
    const block = buildSituatedPresenceContextBlock({
      message: makeMessage({
        routing: routing({
          presence: { kind: 'satellite', satelliteId: 'sat.x', companionId: 'companion.self' },
        }),
      }),
    });
    expect(block).toContain('Here: (location not modeled)');
  });

  it('includes the who-else line only when co-present companions are provided', () => {
    const base = {
      message: makeMessage({ routing: routing({ placeId: 'place.living-room' }) }),
      placesRegistry: PLACES_REGISTRY,
    };
    const without = buildSituatedPresenceContextBlock(base);
    expect(without).not.toContain('Also here:');

    const withCoPresent = buildSituatedPresenceContextBlock({
      ...base,
      coPresent: [{ companionId: 'companion.operator', displayName: 'operator' }],
    });
    expect(withCoPresent).toContain('Also here: operator');
  });

  it('renders byte-identically with an empty coPresent and with none (flag-off parity)', () => {
    const base = {
      message: makeMessage({
        routing: routing({ placeId: 'place.living-room', presence: SATELLITE_PRESENCE }),
      }),
      placesRegistry: PLACES_REGISTRY,
    };
    const withoutInput = buildSituatedPresenceContextBlock(base);
    const withEmpty = buildSituatedPresenceContextBlock({ ...base, coPresent: [] });
    expect(withEmpty).toBe(withoutInput);
  });

  it('matches the rendered snapshot for a full place + presence + co-present turn', () => {
    const block = buildSituatedPresenceContextBlock({
      message: makeMessage({
        routing: routing({ placeId: 'place.living-room', presence: SATELLITE_PRESENCE }),
      }),
      placesRegistry: PLACES_REGISTRY,
      coPresent: [{ companionId: 'companion.operator', displayName: 'operator' }],
    });
    expect(block).toMatchInlineSnapshot(`
      "<runtime_situated_presence>
      [Situated presence]
      Here: Living Room (physical place)
      Site: Home
      Surroundings: A cozy room with a couch and a reading nook.
      Perceivers here (what can sense this place):
      - Presence Sensor (presence, perceiver)
      Effectors here (control is mediated by the world tool, not wired into this block):
      - Floor Lamp (light, effector)
      Also here: operator
      </runtime_situated_presence>"
    `);
  });
});

describe('resolveSituatedPlaceRef (W5a presence coordinates)', () => {
  it('resolves the same place coordinates the block renders from', () => {
    const ref = resolveSituatedPlaceRef(
      makeMessage({ routing: routing({ placeId: 'place.living-room' }) }),
      PLACES_REGISTRY,
    );
    expect(ref).toEqual({
      siteId: 'site.home',
      placeId: 'place.living-room',
      kind: 'physical',
    });
  });

  it('resolves nothing without a registry, without a satellite placeId, or for an unknown place', () => {
    expect(resolveSituatedPlaceRef(
      makeMessage({ routing: routing({ placeId: 'place.living-room' }) }),
      undefined,
    )).toBeUndefined();
    expect(resolveSituatedPlaceRef(makeMessage(), PLACES_REGISTRY)).toBeUndefined();
    expect(resolveSituatedPlaceRef(
      makeMessage({ routing: routing({ placeId: 'place.nowhere' }) }),
      PLACES_REGISTRY,
    )).toBeUndefined();
  });
});

describe('situated-presence producer — active-emanation integration (B2)', () => {
  it('foregrounds the current active emanation on a placeless (non-satellite) turn', () => {
    const tracker = new SituatedEmanationTracker();
    // A satellite turn establishes the emanation into the living room.
    buildSituatedPresenceContextBlock({
      message: makeMessage({
        routing: routing({ placeId: 'place.living-room', presence: SATELLITE_PRESENCE }),
      }),
      placesRegistry: PLACES_REGISTRY,
      emanationTracker: tracker,
    });
    // A subsequent Discord/Telegram turn carries no place of its own, yet the
    // block still foregrounds the living room from the active emanation.
    const block = buildSituatedPresenceContextBlock({
      message: makeMessage(),
      placesRegistry: PLACES_REGISTRY,
      emanationTracker: tracker,
    });
    expect(block).toContain('Here: Living Room (physical place)');
    expect(block).toContain('- Floor Lamp (light, effector)');
  });

  it('updates the active emanation when a satellite turn establishes location', () => {
    const tracker = new SituatedEmanationTracker();
    buildSituatedPresenceContextBlock({
      message: makeMessage({
        routing: routing({ placeId: 'place.living-room', presence: SATELLITE_PRESENCE }),
      }),
      placesRegistry: PLACES_REGISTRY,
      emanationTracker: tracker,
    });
    expect(tracker.resolvePlaceId()).toBe('place.living-room');
  });

  it('switching active emanation between two satellites changes the foregrounded place', () => {
    const tracker = new SituatedEmanationTracker();
    // Emanate into the living room, then read it on a placeless turn.
    buildSituatedPresenceContextBlock({
      message: makeMessage({
        routing: routing({ placeId: 'place.living-room', presence: SATELLITE_PRESENCE }),
      }),
      placesRegistry: PLACES_REGISTRY,
      emanationTracker: tracker,
    });
    const first = buildSituatedPresenceContextBlock({
      message: makeMessage(),
      placesRegistry: PLACES_REGISTRY,
      emanationTracker: tracker,
    });
    expect(first).toContain('Here: Living Room (physical place)');

    // Hand off to the kitchen satellite; the next placeless turn foregrounds it.
    buildSituatedPresenceContextBlock({
      message: makeMessage({
        routing: routing({ placeId: 'place.kitchen', presence: KITCHEN_PRESENCE }),
      }),
      placesRegistry: PLACES_REGISTRY,
      emanationTracker: tracker,
    });
    const second = buildSituatedPresenceContextBlock({
      message: makeMessage(),
      placesRegistry: PLACES_REGISTRY,
      emanationTracker: tracker,
    });
    expect(second).toContain('Here: Kitchen (physical place)');
    expect(second).not.toContain('Living Room');
  });

  it('falls back to the honest empty block when nothing has established a place', () => {
    const tracker = new SituatedEmanationTracker();
    // Placeless turn, empty tracker, no presence → no fabricated location.
    const block = buildSituatedPresenceContextBlock({
      message: makeMessage(),
      placesRegistry: PLACES_REGISTRY,
      emanationTracker: tracker,
    });
    expect(block).toBe('');
  });
});

// ── Deliberate virtual `move` wire-through (vinz.26, contract s10wm) ──
// Proves the world tool's move — which only touches the emanation tracker's
// virtual overlay + the presence port — actually swaps what the NEXT turn
// renders and retrieves, with no additional plumbing.
describe('situated-presence + wiki scope after a virtual move (vinz.26)', () => {
  function trackerEmanatedThenMoved(): SituatedEmanationTracker {
    const tracker = new SituatedEmanationTracker();
    // Physically emanated into the living room…
    buildSituatedPresenceContextBlock({
      message: makeMessage({
        routing: routing({ placeId: 'place.living-room', presence: SATELLITE_PRESENCE }),
      }),
      placesRegistry: PLACES_REGISTRY,
      emanationTracker: tracker,
    });
    // …then the world tool's move action walks into the virtual tavern.
    tracker.moveToVirtualPlace('place.mud-tavern');
    return tracker;
  }

  it('renders the virtual destination in the Here: block on the following placeless turn', () => {
    const block = buildSituatedPresenceContextBlock({
      message: makeMessage(),
      placesRegistry: PLACES_REGISTRY,
      emanationTracker: trackerEmanatedThenMoved(),
    });
    expect(block).toContain('Here: The Rusty Tankard (virtual place)');
    expect(block).toContain('Site: The MUD');
    expect(block).toContain('Surroundings: A low-beamed virtual tavern; a fire crackles in the hearth.');
    expect(block).not.toContain('Living Room');
  });

  it('keeps physical-turn behavior intact: a satellite turn still renders its own place', () => {
    const tracker = trackerEmanatedThenMoved();
    const block = buildSituatedPresenceContextBlock({
      message: makeMessage({
        routing: routing({ placeId: 'place.kitchen', presence: KITCHEN_PRESENCE }),
      }),
      placesRegistry: PLACES_REGISTRY,
      emanationTracker: tracker,
    });
    expect(block).toContain('Here: Kitchen (physical place)');
    // …and the physical arrival superseded the virtual move (latest wins).
    expect(tracker.resolveVirtualMovePlaceId()).toBeUndefined();
  });

  it('resolves the same place/site coordinates for co-presence and wiki via the fallback', () => {
    const tracker = trackerEmanatedThenMoved();
    const placelessTurn = makeMessage();

    const ref = resolveSituatedPlaceRef(placelessTurn, PLACES_REGISTRY, tracker.resolvePlaceId());
    expect(ref).toEqual({ siteId: 'site.mud', placeId: 'place.mud-tavern', kind: 'virtual' });

    const siteId = resolveSituatedSiteId(placelessTurn, PLACES_REGISTRY, tracker.resolvePlaceId());
    expect(siteId).toBe('site.mud');
  });

  it('swaps the wiki shared-world retrieval scope to the destination site (integration)', () => {
    const tracker = trackerEmanatedThenMoved();
    const currentSiteId = resolveSituatedSiteId(makeMessage(), PLACES_REGISTRY, tracker.resolvePlaceId());
    const plan = resolveWikiRetrievalPlan({
      settings: {
        enabled: true,
        chatTokenCap: 1000,
        groupTokenCap: 500,
        focusTokenCap: 2000,
        similarityThreshold: 0.4,
        groupSimilarityThreshold: 0.5,
      },
      isDirectMessage: true,
      focusActive: false,
      multiCompanion: true,
      currentSiteId,
    });
    expect(plan?.allowedScopes).toContain('shared_world:site.mud');
    expect(plan?.allowedScopes).toContain('personal');
    expect(plan?.allowedScopes).not.toContain('shared_world:site.home');
  });

  it('the turn place still outranks the fallback for wiki scope (physical turn intact)', () => {
    const tracker = trackerEmanatedThenMoved();
    const satelliteTurn = makeMessage({
      routing: routing({ placeId: 'place.kitchen', presence: KITCHEN_PRESENCE }),
    });
    expect(
      resolveSituatedSiteId(satelliteTurn, PLACES_REGISTRY, tracker.resolvePlaceId()),
    ).toBe('site.home');
  });
});

// ── Dual presence: mindspace twin foregrounding + display label (vinz.29) ──
// The agent resolves the situated fallback per turn (classification lives in
// turn-presence-mode.ts, tested there); these tests pin what the BLOCK does
// with it: a mindspace turn renders the twin place, the operator's
// character-facing label comes in from companion-data (never hardcoded — the
// label strings below are test-local fixtures), and physical turns outrank.
describe('situated-presence producer — mindspace twin (vinz.29)', () => {
  const TWIN_FALLBACK = { situatedFallbackPlaceId: 'place.living-room-twin' };

  it('foregrounds the twin place on a placeless turn via the situated fallback', () => {
    const block = buildSituatedPresenceContextBlock({
      message: makeMessage(),
      placesRegistry: PLACES_REGISTRY,
      ...TWIN_FALLBACK,
    });
    expect(block).toContain('Here: Living Room (Twin) (virtual place)');
    expect(block).toContain('Site: Home Mindspace');
    expect(block).toContain('Surroundings: A shared reflection of the living room.');
    // Default label = the twin place's own displayName; grounded on the mirror.
    expect(block).toContain('Shared mindspace: Living Room (Twin) (virtual twin of Living Room)');
  });

  it('renders the operator-authored label from companion-data when configured', () => {
    const block = buildSituatedPresenceContextBlock({
      message: makeMessage(),
      placesRegistry: PLACES_REGISTRY,
      ...TWIN_FALLBACK,
      mindspaceLabel: 'Our Shared Loft',
    });
    expect(block).toContain('Shared mindspace: Our Shared Loft (virtual twin of Living Room)');
    expect(block).not.toContain('Shared mindspace: Living Room (Twin)');
  });

  it('never renders the mindspace line for non-twin places', () => {
    const physical = buildSituatedPresenceContextBlock({
      message: makeMessage({ routing: routing({ placeId: 'place.living-room' }) }),
      placesRegistry: PLACES_REGISTRY,
      mindspaceLabel: 'Our Shared Loft',
    });
    expect(physical).not.toContain('Shared mindspace:');
    expect(physical).not.toContain('Our Shared Loft');

    const plainVirtual = buildSituatedPresenceContextBlock({
      message: makeMessage(),
      placesRegistry: PLACES_REGISTRY,
      situatedFallbackPlaceId: 'place.mud-tavern',
      mindspaceLabel: 'Our Shared Loft',
    });
    expect(plainVirtual).toContain('Here: The Rusty Tankard (virtual place)');
    expect(plainVirtual).not.toContain('Shared mindspace:');
  });

  it('a satellite turn outranks the mindspace fallback (physical always wins)', () => {
    const block = buildSituatedPresenceContextBlock({
      message: makeMessage({
        routing: routing({ placeId: 'place.kitchen', presence: KITCHEN_PRESENCE }),
      }),
      placesRegistry: PLACES_REGISTRY,
      ...TWIN_FALLBACK,
    });
    expect(block).toContain('Here: Kitchen (physical place)');
    expect(block).not.toContain('Shared mindspace:');
  });

  it('the situated fallback outranks the tracker fallback (twin over physical emanation)', () => {
    const tracker = new SituatedEmanationTracker();
    // Physically emanated into the living room earlier…
    buildSituatedPresenceContextBlock({
      message: makeMessage({
        routing: routing({ placeId: 'place.living-room', presence: SATELLITE_PRESENCE }),
      }),
      placesRegistry: PLACES_REGISTRY,
      emanationTracker: tracker,
    });
    // …then a plain-chat turn foregrounds the mindspace twin instead.
    const block = buildSituatedPresenceContextBlock({
      message: makeMessage(),
      placesRegistry: PLACES_REGISTRY,
      emanationTracker: tracker,
      ...TWIN_FALLBACK,
    });
    expect(block).toContain('Here: Living Room (Twin) (virtual place)');
    expect(block).not.toContain('Here: Living Room (physical place)');
  });

  it('co-presence coordinates agree with the rendered twin (shared resolution)', () => {
    const ref = resolveSituatedPlaceRef(makeMessage(), PLACES_REGISTRY, 'place.living-room-twin');
    expect(ref).toEqual({
      siteId: 'site.mindspace',
      placeId: 'place.living-room-twin',
      kind: 'virtual',
    });
    expect(resolveSituatedSiteId(makeMessage(), PLACES_REGISTRY, 'place.living-room-twin'))
      .toBe('site.mindspace');
  });
});
