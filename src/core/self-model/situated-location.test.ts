import { describe, expect, it } from 'vitest';
import {
  describeSituatedLocationAge,
  isSituatedLocationStale,
  resolveTurnSituatedLocation,
  SITUATED_LOCATION_STALE_THRESHOLD_MS,
} from './situated-location.js';
import type { SituatedLocation } from './state.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';

const NOW = new Date('2026-07-08T18:00:00.000Z');

function makeMessage(routing?: Record<string, unknown>): SubstrateMessage {
  return { routing } as unknown as SubstrateMessage;
}

const REGISTRY: PlacesRegistryConfig = {
  schemaVersion: 1,
  sites: [{ siteId: 'home', displayName: 'Home', kind: 'physical' }],
  places: [
    {
      placeId: 'living-room',
      siteId: 'home',
      displayName: 'the living room',
      kind: 'physical',
      affordances: [],
    },
  ],
};

describe('resolveTurnSituatedLocation', () => {
  it('resolves a bound place into a freshly-confirmed durable location', () => {
    const location = resolveTurnSituatedLocation({
      message: makeMessage({ satellite: { placeId: 'living-room' } }),
      placesRegistry: REGISTRY,
      priorLocation: null,
      now: NOW,
    });

    expect(location).toEqual({
      placeId: 'living-room',
      siteId: 'home',
      label: 'the living room',
      kind: 'physical',
      updatedAt: NOW.toISOString(),
    });
  });

  it('falls back to honest presence hints when no place is bound (no fabrication)', () => {
    const location = resolveTurnSituatedLocation({
      message: makeMessage({ presence: { label: 'the kitchen satellite', siteId: 'home' } }),
      placesRegistry: REGISTRY,
      priorLocation: null,
      now: NOW,
    });

    expect(location).toEqual({
      placeId: null,
      siteId: 'home',
      label: 'the kitchen satellite',
      kind: 'physical', // site resolved for kind
      updatedAt: NOW.toISOString(),
    });
  });

  it('carries the prior location forward UNCHANGED when the turn has no signal (durability)', () => {
    const prior: SituatedLocation = {
      placeId: 'living-room',
      siteId: 'home',
      label: 'the living room',
      kind: 'physical',
      updatedAt: '2026-07-08T12:00:00.000Z',
    };

    const location = resolveTurnSituatedLocation({
      message: makeMessage(),
      placesRegistry: REGISTRY,
      priorLocation: prior,
      now: NOW,
    });

    // Same object contents, ORIGINAL updatedAt preserved so it ages honestly.
    expect(location).toEqual(prior);
    expect(location?.updatedAt).toBe('2026-07-08T12:00:00.000Z');
  });

  it('refreshes updatedAt when the same place is reconfirmed by a fresh signal', () => {
    const prior: SituatedLocation = {
      placeId: 'living-room',
      siteId: 'home',
      label: 'the living room',
      kind: 'physical',
      updatedAt: '2026-07-08T12:00:00.000Z',
    };

    const location = resolveTurnSituatedLocation({
      message: makeMessage({ satellite: { placeId: 'living-room' } }),
      placesRegistry: REGISTRY,
      priorLocation: prior,
      now: NOW,
    });

    expect(location?.updatedAt).toBe(NOW.toISOString());
  });

  it('resolves to null when there is no signal and no prior location', () => {
    expect(
      resolveTurnSituatedLocation({
        message: makeMessage(),
        placesRegistry: REGISTRY,
        priorLocation: null,
        now: NOW,
      }),
    ).toBeNull();
  });

  it('ignores an unresolvable placeId and carries the prior forward', () => {
    const prior: SituatedLocation = {
      placeId: 'bedroom',
      siteId: 'home',
      label: 'the bedroom',
      kind: 'physical',
      updatedAt: '2026-07-08T09:00:00.000Z',
    };
    const location = resolveTurnSituatedLocation({
      message: makeMessage({ satellite: { placeId: 'unknown-place' } }),
      placesRegistry: REGISTRY,
      priorLocation: prior,
      now: NOW,
    });
    expect(location).toEqual(prior);
  });
});

describe('situated-location age/staleness helpers', () => {
  const fresh: SituatedLocation = {
    placeId: 'living-room',
    siteId: 'home',
    label: 'the living room',
    kind: 'physical',
    updatedAt: NOW.toISOString(),
  };

  it('describes a just-confirmed location as "just now" and not stale', () => {
    expect(describeSituatedLocationAge(fresh, NOW)).toBe('just now');
    expect(isSituatedLocationStale(fresh, NOW)).toBe(false);
  });

  it('describes hours and days of age', () => {
    const twoHoursAgo: SituatedLocation = {
      ...fresh,
      updatedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    };
    expect(describeSituatedLocationAge(twoHoursAgo, NOW)).toBe('about 2 hours ago');
  });

  it('flags a location older than the stale window', () => {
    const stale: SituatedLocation = {
      ...fresh,
      updatedAt: new Date(NOW.getTime() - SITUATED_LOCATION_STALE_THRESHOLD_MS - 1000).toISOString(),
    };
    expect(isSituatedLocationStale(stale, NOW)).toBe(true);
  });
});
