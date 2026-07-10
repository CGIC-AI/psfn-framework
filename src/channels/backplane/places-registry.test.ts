import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSatellitePlaceBindings,
  EMPTY_PLACES_REGISTRY_CONFIG,
  loadPlacesRegistryConfig,
  parsePlacesRegistryConfig,
  resolveAffordancesForPlace,
  resolvePlaceById,
  resolveSiteById,
} from './places-registry.js';
import { parseSatelliteRegistryConfig } from './satellite-registry.js';
import { resolveTwinPlaceOf } from '../../shared/contracts/places-registry.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function exampleRegistry(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sites: [{ siteId: 'home', displayName: 'Home', kind: 'physical' }],
    places: [
      {
        placeId: 'living_room',
        siteId: 'home',
        displayName: 'Living Room',
        kind: 'physical',
        haAreaId: 'living_room',
        affordances: [
          {
            affordanceId: 'lr_lights',
            role: 'effector',
            kind: 'light',
            backend: 'ha',
            entityId: 'light.living_room',
            control: ['on', 'off', 'brightness'],
          },
          {
            affordanceId: 'lr_presence',
            role: 'perceiver',
            kind: 'presence',
            backend: 'ha',
            entityId: 'binary_sensor.living_room_mmwave',
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('parsePlacesRegistryConfig', () => {
  it('parses a valid registry and preserves site/place/affordance data', () => {
    const config = parsePlacesRegistryConfig(exampleRegistry());
    expect(config.schemaVersion).toBe(1);
    expect(config.sites).toHaveLength(1);
    expect(config.places).toHaveLength(1);
    const place = config.places[0]!;
    expect(place.placeId).toBe('living_room');
    expect(place.kind).toBe('physical');
    expect(place.affordances).toHaveLength(2);
    expect(place.affordances[0]!.role).toBe('effector');
    expect(place.affordances[0]!.control).toEqual(['on', 'off', 'brightness']);
    expect(place.affordances[1]!.role).toBe('perceiver');
  });

  it('treats absent sites/places as empty arrays', () => {
    const config = parsePlacesRegistryConfig({ schemaVersion: 1 });
    expect(config.sites).toEqual([]);
    expect(config.places).toEqual([]);
  });

  it('rejects a wrong schemaVersion naming the field', () => {
    expect(() => parsePlacesRegistryConfig({ schemaVersion: 2 })).toThrow(/schemaVersion must be 1/u);
  });

  it('rejects a non-object root', () => {
    expect(() => parsePlacesRegistryConfig('nope')).toThrow(/must contain a JSON object/u);
  });

  it('rejects an unknown affordance kind naming the field path', () => {
    const raw = exampleRegistry();
    (raw.places as any)[0].affordances[0].kind = 'teleporter';
    expect(() => parsePlacesRegistryConfig(raw)).toThrow(
      /places\[0\]\.affordances\[0\]\.kind contains unknown affordance kind "teleporter"/u,
    );
  });

  it('rejects an unknown affordance backend', () => {
    const raw = exampleRegistry();
    (raw.places as any)[0].affordances[0].backend = 'zigbee';
    expect(() => parsePlacesRegistryConfig(raw)).toThrow(/backend must be one of: ha, satellite, vr/u);
  });

  it('rejects an unknown place kind', () => {
    const raw = exampleRegistry();
    (raw.places as any)[0].kind = 'astral';
    expect(() => parsePlacesRegistryConfig(raw)).toThrow(/kind must be one of: physical, virtual/u);
  });

  it('rejects a duplicate affordanceId within a place', () => {
    const raw = exampleRegistry();
    (raw.places as any)[0].affordances[1].affordanceId = 'lr_lights';
    expect(() => parsePlacesRegistryConfig(raw)).toThrow(/duplicate affordanceId "lr_lights"/u);
  });

  it('rejects a duplicate placeId', () => {
    const raw = exampleRegistry();
    (raw.places as any).push({ ...(raw.places as any)[0] });
    expect(() => parsePlacesRegistryConfig(raw)).toThrow(/duplicate placeId "living_room"/u);
  });

  it('rejects a duplicate siteId', () => {
    const raw = exampleRegistry();
    (raw.sites as any).push({ siteId: 'home', displayName: 'Home 2', kind: 'physical' });
    expect(() => parsePlacesRegistryConfig(raw)).toThrow(/duplicate siteId "home"/u);
  });

  it('rejects a place referencing an unknown siteId', () => {
    const raw = exampleRegistry();
    (raw.places as any)[0].siteId = 'ghost_site';
    expect(() => parsePlacesRegistryConfig(raw)).toThrow(
      /references unknown siteId "ghost_site"/u,
    );
  });

  it('rejects an unknown key on a place naming the key (H9/T1)', () => {
    const raw = exampleRegistry();
    (raw.places as any)[0].privicy = 'private'; // typo for privacy
    expect(() => parsePlacesRegistryConfig(raw)).toThrow(/unknown key\(s\): "privicy"/u);
  });

  it('rejects an unknown key on a site', () => {
    const raw = exampleRegistry();
    (raw.sites as any)[0].displyName = 'Home'; // typo
    expect(() => parsePlacesRegistryConfig(raw)).toThrow(/unknown key\(s\): "displyName"/u);
  });

  it('rejects an unknown key on an affordance', () => {
    const raw = exampleRegistry();
    (raw.places as any)[0].affordances[0].entiyId = 'light.x'; // typo
    expect(() => parsePlacesRegistryConfig(raw)).toThrow(/unknown key\(s\): "entiyId"/u);
  });

  it('rejects an unknown root-level key', () => {
    expect(() => parsePlacesRegistryConfig({ schemaVersion: 1, placess: [] }))
      .toThrow(/unknown key\(s\): "placess"/u);
  });
});

describe('twin links (mirrorsPlaceId, vinz.29)', () => {
  function twinRegistry(overrides: {
    twinKind?: string;
    mirrors?: string;
    extraTwin?: boolean;
  } = {}) {
    const raw = exampleRegistry({
      sites: [
        { siteId: 'home', displayName: 'Home', kind: 'physical' },
        { siteId: 'home_mindspace', displayName: 'Home Mindspace', kind: 'virtual' },
      ],
    });
    (raw.places as any).push({
      placeId: 'living_room_twin',
      siteId: 'home_mindspace',
      displayName: 'Living Room (Twin)',
      kind: overrides.twinKind ?? 'virtual',
      mirrorsPlaceId: overrides.mirrors ?? 'living_room',
      affordances: [],
    });
    if (overrides.extraTwin) {
      (raw.places as any).push({
        placeId: 'living_room_twin_2',
        siteId: 'home_mindspace',
        displayName: 'Living Room (Second Twin)',
        kind: 'virtual',
        mirrorsPlaceId: 'living_room',
        affordances: [],
      });
    }
    return raw;
  }

  it('accepts a virtual place mirroring an existing physical place', () => {
    const config = parsePlacesRegistryConfig(twinRegistry());
    const twin = resolvePlaceById(config, 'living_room_twin');
    expect(twin?.mirrorsPlaceId).toBe('living_room');
    expect(twin?.kind).toBe('virtual');
  });

  it('resolves the twin of a physical place via resolveTwinPlaceOf', () => {
    const config = parsePlacesRegistryConfig(twinRegistry());
    expect(resolveTwinPlaceOf(config, 'living_room')?.placeId).toBe('living_room_twin');
    expect(resolveTwinPlaceOf(config, 'nowhere')).toBeUndefined();
    expect(resolveTwinPlaceOf(undefined, 'living_room')).toBeUndefined();
  });

  it('fails closed when a physical place declares mirrorsPlaceId', () => {
    expect(() => parsePlacesRegistryConfig(twinRegistry({ twinKind: 'physical' }))).toThrow(
      /mirrorsPlaceId is only allowed on virtual places/u,
    );
  });

  it('fails closed on a dangling twin target', () => {
    expect(() => parsePlacesRegistryConfig(twinRegistry({ mirrors: 'ghost_room' }))).toThrow(
      /"living_room_twin" mirrors unknown placeId "ghost_room"/u,
    );
  });

  it('fails closed when the twin target is not a physical place', () => {
    const raw = twinRegistry();
    (raw.places as any).push({
      placeId: 'tavern',
      siteId: 'home_mindspace',
      displayName: 'Tavern',
      kind: 'virtual',
      affordances: [],
    });
    (raw.places as any).find((p: any) => p.placeId === 'living_room_twin').mirrorsPlaceId = 'tavern';
    expect(() => parsePlacesRegistryConfig(raw)).toThrow(
      /mirrors "tavern" which is not a physical place/u,
    );
  });

  it('fails closed when a physical place has more than one twin', () => {
    expect(() => parsePlacesRegistryConfig(twinRegistry({ extraTwin: true }))).toThrow(
      /physical place "living_room" has more than one twin/u,
    );
  });
});

describe('resolvers', () => {
  const config = parsePlacesRegistryConfig(exampleRegistry());

  it('resolves a place by id and its affordances', () => {
    expect(resolvePlaceById(config, 'living_room')?.displayName).toBe('Living Room');
    expect(resolveAffordancesForPlace(config, 'living_room')).toHaveLength(2);
    expect(resolveSiteById(config, 'home')?.displayName).toBe('Home');
  });

  it('returns undefined/empty for an unknown place', () => {
    expect(resolvePlaceById(config, 'nowhere')).toBeUndefined();
    expect(resolveAffordancesForPlace(config, 'nowhere')).toEqual([]);
  });
});

describe('loadPlacesRegistryConfig', () => {
  it('returns the empty registry when the file is absent (soft registry, no boot failure)', () => {
    const config = loadPlacesRegistryConfig('/tmp/psfn-nonexistent-places-dir-xyz');
    expect(config).toBe(EMPTY_PLACES_REGISTRY_CONFIG);
    expect(config.places).toEqual([]);
  });
});

describe('config/places.seed.json', () => {
  it('parses cleanly with the 4-room reference scenario plus a mindspace twin', () => {
    const text = readFileSync(join(REPO_ROOT, 'config', 'places.seed.json'), 'utf8');
    const config = parsePlacesRegistryConfig(JSON.parse(text), 'places.seed.json');
    expect(config.places.map((place) => place.placeId)).toEqual([
      'living_room',
      'kitchen',
      'office',
      'bedroom',
      'living_room_twin',
    ]);
    for (const place of config.places.filter((entry) => entry.kind === 'physical')) {
      expect(place.siteId).toBe('home');
    }
    // The seed's twin example (vinz.29): a virtual mirror of the living room.
    expect(resolveTwinPlaceOf(config, 'living_room')?.placeId).toBe('living_room_twin');
  });
});

describe('assertSatellitePlaceBindings', () => {
  function satelliteRegistry(placeId?: string) {
    return parseSatelliteRegistryConfig({
      schemaVersion: 1,
      enabled: true,
      satellites: [
        {
          satelliteId: 'pi-voice',
          displayName: 'Living Room Voice Pi',
          mobility: 'static',
          ...(placeId ? { placeId } : {}),
          endpoints: [
            {
              endpointId: 'wyoming-voice',
              displayName: 'Wyoming Voice Endpoint',
              claimTypes: ['voice-pi'],
              promptChannelType: 'voice_satellite',
              auth: { mode: 'api_key' },
              defaultIdentity: {
                authorId: 'operator',
                authorName: 'Operator',
                canonicalContactId: 'contact-operator',
                channelPrivacy: 'private',
              },
              maxCapabilities: ['text'],
            },
          ],
        },
      ],
    });
  }

  const places = parsePlacesRegistryConfig(exampleRegistry());

  it('accepts a satellite bound to a place that exists', () => {
    expect(() => assertSatellitePlaceBindings(satelliteRegistry('living_room'), places)).not.toThrow();
  });

  it('is a no-op when no satellite declares a placeId, even with an empty places registry', () => {
    expect(() => assertSatellitePlaceBindings(satelliteRegistry(), EMPTY_PLACES_REGISTRY_CONFIG)).not.toThrow();
  });

  it('fails closed when a bound placeId does not exist in places.json', () => {
    expect(() => assertSatellitePlaceBindings(satelliteRegistry('ghost_room'), places)).toThrow(
      /satellite "pi-voice" binds to placeId "ghost_room" which does not exist/u,
    );
  });

  it('fails closed when a satellite binds a placeId but places.json is absent (empty registry)', () => {
    expect(() => assertSatellitePlaceBindings(satelliteRegistry('living_room'), EMPTY_PLACES_REGISTRY_CONFIG)).toThrow(
      /binds to placeId "living_room" which does not exist/u,
    );
  });
});
