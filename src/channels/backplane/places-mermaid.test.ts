import { describe, expect, it } from 'vitest';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';
import type { SatelliteRegistryConfig } from '../../shared/contracts/satellite-registry.js';
import { EMPTY_PLACES_REGISTRY_CONFIG } from './places-registry.js';
import { EMPTY_SATELLITE_REGISTRY_CONFIG } from './satellite-registry.js';
import { renderPlacesMermaid } from './places-mermaid.js';

const SAMPLE_REGISTRY: PlacesRegistryConfig = {
  schemaVersion: 1,
  sites: [
    { siteId: 'home', displayName: 'Home', kind: 'physical' },
    { siteId: 'grove', displayName: 'The Grove', kind: 'virtual' },
  ],
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
          displayName: 'Living Room Lights',
          entityId: 'light.living_room',
          control: ['on', 'off'],
        },
        {
          affordanceId: 'lr_presence',
          role: 'perceiver',
          kind: 'presence',
          backend: 'ha',
          displayName: 'Living Room Presence',
          entityId: 'binary_sensor.lr_mmwave',
        },
      ],
    },
    {
      placeId: 'atrium',
      siteId: 'grove',
      displayName: 'Atrium',
      kind: 'virtual',
      affordances: [
        {
          affordanceId: 'atrium_orb',
          role: 'effector',
          kind: 'virtual_object',
          backend: 'vr',
          displayName: 'Floating Orb',
        },
      ],
    },
  ],
};

const SAMPLE_SATELLITES: SatelliteRegistryConfig = {
  schemaVersion: 1,
  enabled: true,
  satellites: [
    {
      satelliteId: 'desk_unit',
      displayName: 'Desk Unit',
      mobility: 'static',
      placeId: 'living_room',
      endpoints: [],
    },
    {
      satelliteId: 'roamer',
      displayName: 'Roamer',
      mobility: 'mobile',
      // No placeId: must not appear anywhere in the map.
      endpoints: [],
    },
  ],
};

describe('renderPlacesMermaid', () => {
  it('renders sites and places as nested subgraphs with kind labels', () => {
    const mermaid = renderPlacesMermaid(SAMPLE_REGISTRY);
    expect(mermaid.startsWith('flowchart TB\n')).toBe(true);
    // Sorted by siteId: grove (site_0) before home (site_1).
    expect(mermaid).toContain('subgraph site_0["The Grove (virtual)"]');
    expect(mermaid).toContain('subgraph site_1["Home (physical)"]');
    expect(mermaid).toContain('· physical"]');
    expect(mermaid).toContain('· virtual"]');
    // Every subgraph is closed.
    const opens = (mermaid.match(/subgraph /g) ?? []).length;
    const ends = (mermaid.match(/^\s*end$/gm) ?? []).length;
    expect(opens).toBe(ends);
  });

  it('styles affordances by role and shows displayName + kind + backend', () => {
    const mermaid = renderPlacesMermaid(SAMPLE_REGISTRY);
    // Effector: rectangle; perceiver: stadium. Multi-line labels use a literal
    // `\n` separator, matching the house convention in docs/architecture-diagram.mmd.
    expect(mermaid).toContain('["Living Room Lights\\nlight · ha"]');
    expect(mermaid).toContain('(["Living Room Presence\\npresence · ha"])');
    expect(mermaid).toContain('["Floating Orb\\nvirtual_object · vr"]');
    // The separator is a real backslash-n, never any <br form.
    expect(mermaid).toContain('\\n');
    expect(mermaid).not.toContain('<br');
    expect(mermaid).not.toContain('&lt;br');
    expect(mermaid).not.toContain('&amp;lt;br');
    // classDef + class assignment lines for both roles.
    expect(mermaid).toContain('classDef perceiver ');
    expect(mermaid).toContain('classDef effector ');
    expect(mermaid).toMatch(/class [^\n]+ perceiver/);
    expect(mermaid).toMatch(/class [^\n]+ effector/);
  });

  it('renders satellites bound by placeId as nodes inside their place and drops unbound satellites', () => {
    const mermaid = renderPlacesMermaid(SAMPLE_REGISTRY, SAMPLE_SATELLITES);
    expect(mermaid).toContain('{{"Desk Unit\\nstatic"}}');
    expect(mermaid).toContain('classDef satellite ');
    expect(mermaid).toMatch(/class [^\n]+ satellite/);
    // Unbound satellite never appears.
    expect(mermaid).not.toContain('Roamer');
  });

  it('renders a minimal valid diagram for an empty registry', () => {
    const mermaid = renderPlacesMermaid(EMPTY_PLACES_REGISTRY_CONFIG, EMPTY_SATELLITE_REGISTRY_CONFIG);
    expect(mermaid).toBe(
      'flowchart TB\n'
      + '  %% PSFN world map — sites, places, affordances, and bound satellites.\n'
      + '  %% Generated from places.json (+ satellites.json) by renderPlacesMermaid\n'
      + '  %% (src/channels/backplane/places-mermaid.ts). Regenerate with: npm run map:places.\n'
      + '  empty["No places configured"]\n',
    );
    // No dangling subgraph / class artifacts.
    expect(mermaid).not.toContain('subgraph');
    expect(mermaid).not.toContain('classDef');
  });

  it('neutralizes quotes and backslashes so a name cannot break out of the label', () => {
    // `Room "A"\\ evil` is the string  Room "A"\ evil  (one literal backslash);
    // both the quotes and the backslash are injection vectors for a quoted,
    // `\n`-delimited label and must be neutralized.
    const hostile: PlacesRegistryConfig = {
      schemaVersion: 1,
      sites: [{ siteId: 'home', displayName: 'Ho"me', kind: 'physical' }],
      places: [
        {
          placeId: 'lr',
          siteId: 'home',
          displayName: 'Room "A"\\ evil',
          kind: 'physical',
          affordances: [
            {
              affordanceId: 'x',
              role: 'effector',
              kind: 'light',
              backend: 'ha',
              displayName: 'Lamp "1"',
            },
          ],
        },
      ],
    };
    const mermaid = renderPlacesMermaid(hostile);
    // Double-quotes are replaced with ' so the quoted label cannot be closed early.
    expect(mermaid).not.toContain('Ho"me');
    expect(mermaid).not.toContain('Room "A"');
    expect(mermaid).not.toContain('Lamp "1"');
    expect(mermaid).toContain("Room 'A'");
    expect(mermaid).toContain("Lamp '1'");
    // A user backslash becomes '/', so it can never inject its own `\n` break.
    expect(mermaid).not.toContain('Room \'A\'\\');
    // No <br / entity artifacts of any form appear anywhere in the output.
    expect(mermaid).not.toContain('<br');
    expect(mermaid).not.toContain('&lt;br');
    expect(mermaid).not.toContain('&amp;lt;br');
    // Node ids remain synthetic and Mermaid-safe.
    expect(mermaid).toContain('subgraph place_0[');
  });

  it('renders twin links only when a twin field resolves to a known place', () => {
    const withoutTwin = renderPlacesMermaid(SAMPLE_REGISTRY);
    expect(withoutTwin).not.toContain('-.->|twin|');

    // Inject a forward-compatible twin field (vinz.29 `twinOf`) defensively.
    const twinned = structuredClone(SAMPLE_REGISTRY);
    (twinned.places[1] as unknown as Record<string, unknown>).twinOf = 'living_room';
    const withTwin = renderPlacesMermaid(twinned);
    expect(withTwin).toContain('-.->|twin|');

    // A twin field pointing at a non-existent place renders no link.
    const dangling = structuredClone(SAMPLE_REGISTRY);
    (dangling.places[1] as unknown as Record<string, unknown>).mirrorsPlaceId = 'nowhere';
    expect(renderPlacesMermaid(dangling)).not.toContain('-.->|twin|');
  });

  it('is deterministic regardless of input ordering', () => {
    const shuffled: PlacesRegistryConfig = {
      schemaVersion: 1,
      sites: [...SAMPLE_REGISTRY.sites].reverse(),
      places: [...SAMPLE_REGISTRY.places].reverse().map((place) => ({
        ...place,
        affordances: [...place.affordances].reverse(),
      })),
    };
    expect(renderPlacesMermaid(shuffled, SAMPLE_SATELLITES))
      .toBe(renderPlacesMermaid(SAMPLE_REGISTRY, SAMPLE_SATELLITES));
  });

  it('throws on a malformed top-level registry (fail closed)', () => {
    expect(() => renderPlacesMermaid(null as unknown as PlacesRegistryConfig)).toThrow(/malformed/);
    expect(() => renderPlacesMermaid({ schemaVersion: 1 } as unknown as PlacesRegistryConfig)).toThrow(/malformed/);
  });
});
