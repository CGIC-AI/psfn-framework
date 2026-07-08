// ── places.json room-privacy field (psfn-framework-s10rm) ──
// The place registry entry is the canonical home of room privacy: absent
// means `public` (zero behavior change anywhere), `private` opts the place's
// companion room into presence-windowed delivery, and anything else fails
// closed at parse time.

import { describe, expect, it } from 'vitest';
import { parsePlacesRegistryConfig } from './places-registry.js';
import { resolvePlacePrivacy } from '../../shared/contracts/places-registry.js';

function registryWithPlace(place: Record<string, unknown>): unknown {
  return {
    schemaVersion: 1,
    sites: [{ siteId: 'vhome', displayName: 'Virtual Home', kind: 'virtual' }],
    places: [{
      placeId: 'den',
      siteId: 'vhome',
      displayName: 'The Den',
      kind: 'virtual',
      affordances: [],
      ...place,
    }],
  };
}

describe('places registry room privacy (psfn-framework-s10rm)', () => {
  it('defaults to public when the field is absent (zero behavior change)', () => {
    const config = parsePlacesRegistryConfig(registryWithPlace({}));
    expect(config.places[0].privacy).toBeUndefined();
    expect(resolvePlacePrivacy(config.places[0])).toBe('public');
  });

  it('parses explicit public and private classifications', () => {
    const publicConfig = parsePlacesRegistryConfig(registryWithPlace({ privacy: 'public' }));
    expect(publicConfig.places[0].privacy).toBe('public');
    expect(resolvePlacePrivacy(publicConfig.places[0])).toBe('public');

    const privateConfig = parsePlacesRegistryConfig(registryWithPlace({ privacy: 'private' }));
    expect(privateConfig.places[0].privacy).toBe('private');
    expect(resolvePlacePrivacy(privateConfig.places[0])).toBe('private');
  });

  it('fails closed on an unknown privacy value (a typo must never demote a private room)', () => {
    expect(() => parsePlacesRegistryConfig(registryWithPlace({ privacy: 'privte' })))
      .toThrow(/privacy must be one of: public, private/);
    expect(() => parsePlacesRegistryConfig(registryWithPlace({ privacy: 42 })))
      .toThrow(/privacy must be a string/);
    expect(() => parsePlacesRegistryConfig(registryWithPlace({ privacy: '' })))
      .toThrow(/privacy must not be empty/);
  });
});
