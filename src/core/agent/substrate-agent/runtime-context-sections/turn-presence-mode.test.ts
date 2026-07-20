// ── Dual-presence classification + mindspace twin default (vinz.29) ──
// Pins decisions 9-13: per-turn device-origin classification (satellite origin
// = physical emanation; plain chat = mindspace), and the situated fallback
// chain on mindspace turns (deliberate virtual move → session assertion twin →
// twin of the durable last-known physical room). Fixtures are neutral;
// any character-facing mindspace name is companion-data, never committed here.

import { describe, expect, it } from 'vitest';
import type { SubstrateMessage } from '../../../../shared/contracts/runtime.js';
import type { PlacesRegistryConfig } from '../../../../shared/contracts/places-registry.js';
import type { SituatedLocation } from '../../../self-model/state.js';
import {
  classifyTurnPresenceMode,
  resolveTurnSituatedFallbackPlaceId,
} from './turn-presence-mode.js';

const REGISTRY: PlacesRegistryConfig = {
  schemaVersion: 1,
  sites: [
    { siteId: 'site.home', displayName: 'Home', kind: 'physical' },
    { siteId: 'site.mindspace', displayName: 'Home Mindspace', kind: 'virtual' },
  ],
  places: [
    {
      placeId: 'place.bedroom',
      siteId: 'site.home',
      displayName: 'Bedroom',
      kind: 'physical',
      affordances: [],
    },
    {
      placeId: 'place.office',
      siteId: 'site.home',
      displayName: 'Office',
      kind: 'physical',
      affordances: [],
    },
    {
      placeId: 'place.bedroom-twin',
      siteId: 'site.mindspace',
      displayName: 'Bedroom (Twin)',
      kind: 'virtual',
      mirrorsPlaceId: 'place.bedroom',
      affordances: [],
    },
    {
      placeId: 'place.office-twin',
      siteId: 'site.mindspace',
      displayName: 'Office (Twin)',
      kind: 'virtual',
      mirrorsPlaceId: 'place.office',
      affordances: [],
    },
  ],
};

function makeMessage(routing?: SubstrateMessage['routing']): SubstrateMessage {
  return {
    id: 'msg-mode-1',
    channelId: 'discord:dm:1',
    channelType: 'text',
    authorId: 'user-neutral',
    authorName: 'Neutral',
    content: 'hello',
    timestamp: new Date('2026-07-08T12:00:00.000Z'),
    ...(routing ? { routing } : {}),
  } as SubstrateMessage;
}

function physicalDurableLocation(placeId = 'place.bedroom'): SituatedLocation {
  return {
    placeId,
    siteId: 'site.home',
    label: 'Bedroom',
    kind: 'physical',
    updatedAt: '2026-07-08T11:00:00.000Z',
  };
}

describe('classifyTurnPresenceMode', () => {
  it('classifies satellite routing as physical emanation', () => {
    const message = makeMessage({
      satellite: { placeId: 'place.bedroom' } as unknown as NonNullable<SubstrateMessage['routing']>['satellite'],
    });
    expect(classifyTurnPresenceMode(message)).toBe('physical');
  });

  it('classifies structured wyoming voice-endpoint routing as physical emanation', () => {
    expect(classifyTurnPresenceMode(makeMessage({ wyoming: { satelliteId: 'sat.1' } }))).toBe('physical');
  });

  it('does not let source strings or physical presence hints override a chat origin', () => {
    expect(classifyTurnPresenceMode(makeMessage({ source: 'satellite' }))).toBe('mindspace');
    expect(classifyTurnPresenceMode(makeMessage({ source: 'wyoming' }))).toBe('mindspace');
    expect(classifyTurnPresenceMode(makeMessage({
      source: 'discord',
      presence: { kind: 'satellite', satelliteId: 'sat.1', companionId: 'c1' },
    }))).toBe('mindspace');
    expect(classifyTurnPresenceMode(makeMessage({
      source: 'api',
      presence: { kind: 'embodiment', embodimentId: 'emb.1', companionId: 'c1' },
    }))).toBe('mindspace');
  });

  it('classifies plain chat origins (discord/telegram/api, no routing) as mindspace', () => {
    expect(classifyTurnPresenceMode(makeMessage())).toBe('mindspace');
    expect(classifyTurnPresenceMode(makeMessage({ source: 'discord' }))).toBe('mindspace');
    expect(classifyTurnPresenceMode(makeMessage({ source: 'api' }))).toBe('mindspace');
    expect(classifyTurnPresenceMode(makeMessage({
      source: 'discord',
      presence: { kind: 'emanation', emanationId: 'em.1', companionId: 'c1' },
    }))).toBe('mindspace');
  });
});

describe('resolveTurnSituatedFallbackPlaceId', () => {
  it('defaults a plain-chat turn to the twin of the durable last-known physical room', () => {
    expect(resolveTurnSituatedFallbackPlaceId({
      message: makeMessage({ source: 'discord' }),
      placesRegistry: REGISTRY,
      emanationPlaceId: 'place.bedroom',
      durableLocation: physicalDurableLocation(),
    })).toBe('place.bedroom-twin');
  });

  it('lets a deliberate virtual move outrank the default twin', () => {
    expect(resolveTurnSituatedFallbackPlaceId({
      message: makeMessage({ source: 'discord' }),
      placesRegistry: REGISTRY,
      virtualMovePlaceId: 'place.office-twin-elsewhere',
      emanationPlaceId: 'place.bedroom',
      durableLocation: physicalDurableLocation(),
    })).toBe('place.office-twin-elsewhere');
  });

  it('lets a session-scoped narrative assertion override the mirrored default', () => {
    expect(resolveTurnSituatedFallbackPlaceId({
      message: makeMessage({ source: 'discord' }),
      placesRegistry: REGISTRY,
      sessionOverridePhysicalPlaceId: 'place.office',
      emanationPlaceId: 'place.bedroom',
      durableLocation: physicalDurableLocation(),
    })).toBe('place.office-twin');
  });

  it('keeps a deliberate virtual move above a session narrative override', () => {
    expect(resolveTurnSituatedFallbackPlaceId({
      message: makeMessage({ source: 'discord' }),
      placesRegistry: REGISTRY,
      virtualMovePlaceId: 'place.office-twin-elsewhere',
      sessionOverridePhysicalPlaceId: 'place.office',
      durableLocation: physicalDurableLocation(),
    })).toBe('place.office-twin-elsewhere');
  });

  it('ignores a virtual move for a physical-origin turn and keeps the physical fallback', () => {
    expect(resolveTurnSituatedFallbackPlaceId({
      message: makeMessage({
        satellite: { placeId: 'place.bedroom' } as unknown as NonNullable<SubstrateMessage['routing']>['satellite'],
      }),
      placesRegistry: REGISTRY,
      virtualMovePlaceId: 'place.office-twin-elsewhere',
      emanationPlaceId: 'place.bedroom',
      durableLocation: physicalDurableLocation(),
    })).toBe('place.bedroom');
  });

  it('does not present a physical emanation as the place of a plain-chat turn when no twin exists', () => {
    expect(resolveTurnSituatedFallbackPlaceId({
      message: makeMessage({ source: 'discord' }),
      placesRegistry: REGISTRY,
      emanationPlaceId: 'place.unmapped',
      durableLocation: physicalDurableLocation('place.unmapped'),
    })).toBeUndefined();
  });

  it('never twins a virtual or presence-hint-only durable location', () => {
    expect(resolveTurnSituatedFallbackPlaceId({
      message: makeMessage({ source: 'discord' }),
      placesRegistry: REGISTRY,
      durableLocation: {
        placeId: 'place.bedroom-twin',
        siteId: 'site.mindspace',
        label: 'Bedroom (Twin)',
        kind: 'virtual',
        updatedAt: '2026-07-08T11:00:00.000Z',
      },
    })).toBeUndefined();
    expect(resolveTurnSituatedFallbackPlaceId({
      message: makeMessage({ source: 'discord' }),
      placesRegistry: REGISTRY,
      durableLocation: {
        placeId: null,
        siteId: 'site.home',
        label: 'Somewhere at home',
        kind: null,
        updatedAt: '2026-07-08T11:00:00.000Z',
      },
    })).toBeUndefined();
  });

  it('keeps the legacy chain on physical-origin turns (no twin substitution)', () => {
    expect(resolveTurnSituatedFallbackPlaceId({
      message: makeMessage({ wyoming: { satelliteId: 'sat.1' } }),
      placesRegistry: REGISTRY,
      emanationPlaceId: 'place.bedroom',
      durableLocation: physicalDurableLocation(),
    })).toBe('place.bedroom');
  });

  it('resolves nothing with no inputs (fail closed, no fabrication)', () => {
    expect(resolveTurnSituatedFallbackPlaceId({
      message: makeMessage({ source: 'discord' }),
      placesRegistry: REGISTRY,
    })).toBeUndefined();
  });
});
