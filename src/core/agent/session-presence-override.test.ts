import { describe, expect, it } from 'vitest';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';
import { SessionPresenceOverrideState } from './session-presence-override.js';

const REGISTRY: PlacesRegistryConfig = {
  schemaVersion: 1,
  sites: [
    { siteId: 'site.home', displayName: 'Home', kind: 'physical' },
    { siteId: 'site.overlay', displayName: 'Home Overlay', kind: 'virtual' },
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
      placeId: 'place.bedroom-overlay',
      siteId: 'site.overlay',
      displayName: 'Bedroom Overlay',
      kind: 'virtual',
      mirrorsPlaceId: 'place.bedroom',
      affordances: [],
    },
  ],
};

describe('SessionPresenceOverrideState', () => {
  it('keeps asserted physical locations isolated by logical session', () => {
    const state = new SessionPresenceOverrideState(REGISTRY);
    state.set('session:one', 'place.bedroom');

    expect(state.resolvePhysicalPlaceId('session:one')).toBe('place.bedroom');
    expect(state.resolvePhysicalPlaceId('session:two')).toBeUndefined();
  });

  it('clears an override without affecting other sessions', () => {
    const state = new SessionPresenceOverrideState(REGISTRY);
    state.set('session:one', 'place.bedroom');
    state.set('session:two', 'place.bedroom');

    state.set('session:one', null);

    expect(state.resolvePhysicalPlaceId('session:one')).toBeUndefined();
    expect(state.resolvePhysicalPlaceId('session:two')).toBe('place.bedroom');
  });

  it('fails closed for blank sessions, virtual targets, unknown places, and physical places without twins', () => {
    const state = new SessionPresenceOverrideState(REGISTRY);

    expect(() => state.set(' ', 'place.bedroom')).toThrow(/logical session id/u);
    expect(() => state.set('session:one', 'place.bedroom-overlay')).toThrow(/physical place/u);
    expect(() => state.set('session:one', 'place.unknown')).toThrow(/unknown placeId/u);
    expect(() => state.set('session:one', 'place.office')).toThrow(/has no virtual twin/u);
  });
});
