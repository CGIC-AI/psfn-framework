// Emits docs/world-map.mmd from a places registry (+ optional satellite
// bindings) via renderPlacesMermaid. This is the "interim visual" ahead of the
// full map editor (vinz.22).
//
// Run: npm run map:places
//
//   Sources (first match wins):
//     places      — CLI arg 1 | $PLACES_JSON | $DATA_DIR/places.json | config/places.seed.json
//     satellites  — CLI arg 2 | $SATELLITES_JSON | $DATA_DIR/satellites.json | config/satellites.seed.json
//   Output:
//     $WORLD_MAP_OUT | docs/world-map.mmd  (also printed to stdout)
//
// With no arguments it renders the committed seed so docs/world-map.mmd stays a
// faithful, checked-in projection of config/places.seed.json.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  parsePlacesRegistryConfig,
  EMPTY_PLACES_REGISTRY_CONFIG,
} from '../src/channels/backplane/places-registry.js';
import {
  parseSatelliteRegistryConfig,
  EMPTY_SATELLITE_REGISTRY_CONFIG,
} from '../src/channels/backplane/satellite-registry.js';
import { renderPlacesMermaid } from '../src/channels/backplane/places-mermaid.js';

const projectRoot = process.cwd();
const dataDir = process.env.DATA_DIR?.trim() || process.env.COMPANION_DATA_DIR?.trim();

function firstExistingPath(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

const placesPath = firstExistingPath([
  process.argv[2],
  process.env.PLACES_JSON?.trim(),
  dataDir ? join(dataDir, 'places.json') : undefined,
  join(projectRoot, 'config', 'places.seed.json'),
]);

const satellitesPath = firstExistingPath([
  process.argv[3],
  process.env.SATELLITES_JSON?.trim(),
  dataDir ? join(dataDir, 'satellites.json') : undefined,
  join(projectRoot, 'config', 'satellites.seed.json'),
]);

const places = placesPath
  ? parsePlacesRegistryConfig(JSON.parse(readFileSync(placesPath, 'utf8')), placesPath)
  : EMPTY_PLACES_REGISTRY_CONFIG;

const satellites = satellitesPath
  ? parseSatelliteRegistryConfig(JSON.parse(readFileSync(satellitesPath, 'utf8')), satellitesPath)
  : EMPTY_SATELLITE_REGISTRY_CONFIG;

const mermaid = renderPlacesMermaid(places, satellites);

const outputPath = process.env.WORLD_MAP_OUT?.trim() || join(projectRoot, 'docs', 'world-map.mmd');
writeFileSync(resolve(outputPath), mermaid);

process.stdout.write(mermaid);
process.stderr.write(
  `\nWrote ${outputPath}`
  + `\n  places:     ${placesPath ?? '(none — empty registry)'}`
  + `\n  satellites: ${satellitesPath ?? '(none)'}\n`,
);
