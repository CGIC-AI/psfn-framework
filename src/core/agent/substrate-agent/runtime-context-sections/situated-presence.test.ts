// ── Direct unit tests for the situated-presence section producer (S10 B1) ──
// Pins the producer contract: where-am-I / what's-here / who-else-is-here in,
// a <runtime_situated_presence> block (or nothing) out. Fixtures are neutral
// ("Living Room", "operator") — no real people names.

import { describe, expect, it } from 'vitest';
import type { SubstrateMessage } from '../../../../shared/contracts/runtime.js';
import type { PlacesRegistryConfig } from '../../../../shared/contracts/places-registry.js';
import type { CompanionPresenceMetadata } from '../../presence-metadata.js';
import { buildSituatedPresenceContextBlock, resolveSituatedPlaceRef } from './situated-presence.js';

const PLACES_REGISTRY: PlacesRegistryConfig = {
  schemaVersion: 1,
  sites: [{ siteId: 'site.home', displayName: 'Home', kind: 'physical' }],
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
  ],
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
