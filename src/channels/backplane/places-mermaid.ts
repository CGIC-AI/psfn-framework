// ── places.json → Mermaid world-map generator (Sprint 10, vinz.31) ──
//
// Interim world visualization ahead of the full map editor (vinz.22): a PURE,
// deterministic renderer that projects the places soft-registry (`places.json`)
// plus optional satellite bindings (`satellites.json`) into a Mermaid
// `flowchart TB`. It is the "render" half of the eventual editor.
//
// Structure: each SITE is a subgraph; each PLACE is a subgraph within its site
// (label carries physical|virtual); each AFFORDANCE is a node styled by role
// (perceiver vs effector) via `classDef`, with a label of displayName + kind +
// backend; each satellite bound to a place (by `placeId`, when a satellite
// registry is supplied) is a node inside that place.
//
// Twin/overlap links between a physical place and its virtual twin render ONLY
// when a twin field is present on the place config. This is forward-compatible
// with vinz.29's future `twinOf`/`mirrorsPlaceId`: the field is PROBED
// defensively and the current schema declares none, so today no twin links
// render. This module never adds the twin field to the schema.
//
// Fail-closed: malformed top-level input throws; a valid-but-EMPTY registry
// renders a single "no places configured" node (never invalid Mermaid). All ids
// are synthetic (stable-sorted) so arbitrary place/affordance names can never
// break Mermaid node syntax. Multi-line labels use a literal `\n` separator to
// match the house convention in `docs/architecture-diagram.mmd` (which renders
// in the project's pipeline); each user-content segment is neutralized so it
// cannot break out of the quoted label or inject its own line break.

import type {
  AffordanceConfig,
  PlaceConfig,
  PlacesRegistryConfig,
} from '../../shared/contracts/places-registry.js';
import type {
  SatelliteConfig,
  SatelliteRegistryConfig,
} from '../../shared/contracts/satellite-registry.js';

/**
 * Place-level fields probed for a physical↔virtual twin binding. Forward-
 * compatible with vinz.29 (`twinOf` / `mirrorsPlaceId`). The current schema
 * declares none of these; they are read defensively off the raw object.
 */
const TWIN_PLACE_FIELDS = Object.freeze(['twinOf', 'mirrorsPlaceId'] as const);

const CLASS_DEF_LINES = Object.freeze([
  'classDef perceiver fill:#e3f2fd,stroke:#1565c0,color:#0d47a1;',
  'classDef effector fill:#fff3e0,stroke:#e65100,color:#bf360c;',
  'classDef satellite fill:#f3e5f5,stroke:#6a1b9a,color:#4a148c;',
] as const);

const HEADER_COMMENT_LINES = Object.freeze([
  '%% PSFN world map — sites, places, affordances, and bound satellites.',
  '%% Generated from places.json (+ satellites.json) by renderPlacesMermaid',
  '%% (src/channels/backplane/places-mermaid.ts). Regenerate with: npm run map:places.',
] as const);

function isPlacesRegistryShape(value: unknown): value is PlacesRegistryConfig {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PlacesRegistryConfig>;
  return Array.isArray(candidate.sites) && Array.isArray(candidate.places);
}

/**
 * Neutralize one text segment for a quoted, `\n`-delimited Mermaid label (the
 * house convention in `docs/architecture-diagram.mmd`). We escape/strip exactly
 * the characters that can break such a label: double-quotes (would close the
 * label early), backslashes (a user-supplied `\n` would inject its own line
 * break), and control characters (real newlines/tabs). No HTML is involved, so
 * `<`/`>` are left as plain text.
 */
function sanitizeSegment(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .replace(/"/g, "'")
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Join ALREADY-sanitized label segments into a multi-line Mermaid label.
 *
 * Contract («sanitize THEN join»): callers must neutralize each user-content
 * segment via `sanitizeSegment` BEFORE passing it here. The `\n` separator is
 * structural Mermaid markup that WE insert — the two literal characters
 * backslash + `n`, exactly like `GW_RPC["GatewayServer\nNDJSON ..."]` in
 * `docs/architecture-diagram.mmd`. `sanitizeSegment` has already turned any
 * backslash in user text into `/`, so no caller segment can inject a `\n`.
 */
function multilineLabel(segments: string[]): string {
  return segments.filter((segment) => segment.length > 0).join('\\n');
}

function compareById<T>(select: (item: T) => string) {
  return (a: T, b: T): number => {
    const left = select(a);
    const right = select(b);
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  };
}

function affordanceLabel(affordance: AffordanceConfig): string {
  const name = affordance.displayName?.trim() || affordance.affordanceId;
  return multilineLabel([
    sanitizeSegment(name),
    sanitizeSegment(`${affordance.kind} · ${affordance.backend}`),
  ]);
}

function satelliteLabel(satellite: SatelliteConfig): string {
  const name = satellite.displayName.trim() || satellite.satelliteId;
  return multilineLabel([
    sanitizeSegment(name),
    sanitizeSegment(satellite.mobility),
  ]);
}

function probeTwinTargets(place: PlaceConfig): string[] {
  const raw = place as unknown as Record<string, unknown>;
  const targets: string[] = [];
  for (const field of TWIN_PLACE_FIELDS) {
    const value = raw[field];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) targets.push(trimmed);
    }
  }
  return targets;
}

interface RenderState {
  lines: string[];
  perceiverNodeIds: string[];
  effectorNodeIds: string[];
  satelliteNodeIds: string[];
}

function renderAffordances(
  place: PlaceConfig,
  placeNodeId: string,
  indent: string,
  state: RenderState,
): void {
  const affordances = [...place.affordances].sort(compareById((a) => a.affordanceId));
  affordances.forEach((affordance, index) => {
    const nodeId = `${placeNodeId}_aff_${String(index)}`;
    const label = affordanceLabel(affordance);
    if (affordance.role === 'perceiver') {
      // Stadium shape as a visual cue for sensors, plus the `perceiver` class.
      state.lines.push(`${indent}${nodeId}(["${label}"])`);
      state.perceiverNodeIds.push(nodeId);
    } else {
      state.lines.push(`${indent}${nodeId}["${label}"]`);
      state.effectorNodeIds.push(nodeId);
    }
  });
}

function renderSatellites(
  satellites: SatelliteConfig[],
  placeNodeId: string,
  indent: string,
  state: RenderState,
): void {
  const sorted = [...satellites].sort(compareById((s) => s.satelliteId));
  sorted.forEach((satellite, index) => {
    const nodeId = `${placeNodeId}_sat_${String(index)}`;
    // Hexagon shape distinguishes device satellites from affordances.
    state.lines.push(`${indent}${nodeId}{{"${satelliteLabel(satellite)}"}}`);
    state.satelliteNodeIds.push(nodeId);
  });
}

function renderPlace(
  place: PlaceConfig,
  placeNodeId: string,
  satellites: SatelliteConfig[],
  indent: string,
  state: RenderState,
): void {
  const title = sanitizeSegment(`${place.displayName} · ${place.kind}`);
  state.lines.push(`${indent}subgraph ${placeNodeId}["${title}"]`);
  renderSatellites(satellites, placeNodeId, `${indent}  `, state);
  renderAffordances(place, placeNodeId, `${indent}  `, state);
  if (place.affordances.length === 0 && satellites.length === 0) {
    // Keep the subgraph non-empty so Mermaid always has a valid body.
    state.lines.push(`${indent}  ${placeNodeId}_empty["(no affordances)"]`);
  }
  state.lines.push(`${indent}end`);
}

/**
 * Render a places registry (+ optional satellite bindings) as a Mermaid
 * `flowchart TB`. Pure and deterministic: identical inputs always produce
 * byte-identical output. Node ids are synthetic and stable-sorted; label text
 * is entity-escaped. Throws on a malformed top-level registry; an EMPTY
 * registry yields a minimal valid diagram.
 */
export function renderPlacesMermaid(
  places: PlacesRegistryConfig,
  satellites?: SatelliteRegistryConfig,
): string {
  if (!isPlacesRegistryShape(places)) {
    throw new Error('renderPlacesMermaid: malformed places registry (expected { sites: [], places: [] })');
  }

  const lines: string[] = ['flowchart TB', ...HEADER_COMMENT_LINES.map((line) => `  ${line}`)];

  if (places.sites.length === 0 && places.places.length === 0) {
    lines.push('  empty["No places configured"]');
    return `${lines.join('\n')}\n`;
  }

  const state: RenderState = {
    lines,
    perceiverNodeIds: [],
    effectorNodeIds: [],
    satelliteNodeIds: [],
  };

  // Synthetic, collision-free node ids assigned by stable sort order.
  const sortedSites = [...places.sites].sort(compareById((site) => site.siteId));
  const siteNodeIdBySiteId = new Map<string, string>();
  sortedSites.forEach((site, index) => siteNodeIdBySiteId.set(site.siteId, `site_${String(index)}`));

  const sortedPlaces = [...places.places].sort(compareById((place) => place.placeId));
  const placeNodeIdByPlaceId = new Map<string, string>();
  sortedPlaces.forEach((place, index) => placeNodeIdByPlaceId.set(place.placeId, `place_${String(index)}`));

  // Group satellites (with a resolvable placeId binding) under their place.
  const satellitesByPlaceId = new Map<string, SatelliteConfig[]>();
  for (const satellite of satellites?.satellites ?? []) {
    if (satellite.placeId === undefined) continue;
    if (!placeNodeIdByPlaceId.has(satellite.placeId)) continue;
    const bucket = satellitesByPlaceId.get(satellite.placeId);
    if (bucket) bucket.push(satellite);
    else satellitesByPlaceId.set(satellite.placeId, [satellite]);
  }

  const placesBySiteId = new Map<string, PlaceConfig[]>();
  const orphanPlaces: PlaceConfig[] = [];
  for (const place of sortedPlaces) {
    if (siteNodeIdBySiteId.has(place.siteId)) {
      const bucket = placesBySiteId.get(place.siteId);
      if (bucket) bucket.push(place);
      else placesBySiteId.set(place.siteId, [place]);
    } else {
      // Loader guarantees every place references a known site; a hand-built
      // config may not. Surface such places rather than dropping them.
      orphanPlaces.push(place);
    }
  }

  for (const site of sortedSites) {
    const siteNodeId = siteNodeIdBySiteId.get(site.siteId)!;
    const title = sanitizeSegment(`${site.displayName} (${site.kind})`);
    lines.push(`  subgraph ${siteNodeId}["${title}"]`);
    for (const place of placesBySiteId.get(site.siteId) ?? []) {
      const placeNodeId = placeNodeIdByPlaceId.get(place.placeId)!;
      renderPlace(place, placeNodeId, satellitesByPlaceId.get(place.placeId) ?? [], '    ', state);
    }
    lines.push('  end');
  }

  if (orphanPlaces.length > 0) {
    lines.push('  subgraph unsited["Unsited places"]');
    for (const place of orphanPlaces) {
      const placeNodeId = placeNodeIdByPlaceId.get(place.placeId)!;
      renderPlace(place, placeNodeId, satellitesByPlaceId.get(place.placeId) ?? [], '    ', state);
    }
    lines.push('  end');
  }

  // Twin/overlap links — rendered ONLY when a probed twin field resolves to a
  // known place. Deduplicated and stable-sorted (undirected pair key).
  const twinPairs = new Set<string>();
  for (const place of sortedPlaces) {
    const sourceNodeId = placeNodeIdByPlaceId.get(place.placeId)!;
    for (const targetPlaceId of probeTwinTargets(place)) {
      const targetNodeId = placeNodeIdByPlaceId.get(targetPlaceId);
      if (!targetNodeId || targetNodeId === sourceNodeId) continue;
      const [a, b] = [sourceNodeId, targetNodeId].sort();
      twinPairs.add(`${a}|${b}`);
    }
  }
  const twinLinkLines = [...twinPairs].sort().map((pair) => {
    const [a, b] = pair.split('|');
    return `  ${a} -.->|twin| ${b}`;
  });

  lines.push('');
  for (const line of CLASS_DEF_LINES) lines.push(`  ${line}`);
  if (state.perceiverNodeIds.length > 0) {
    lines.push(`  class ${state.perceiverNodeIds.join(',')} perceiver`);
  }
  if (state.effectorNodeIds.length > 0) {
    lines.push(`  class ${state.effectorNodeIds.join(',')} effector`);
  }
  if (state.satelliteNodeIds.length > 0) {
    lines.push(`  class ${state.satelliteNodeIds.join(',')} satellite`);
  }
  for (const line of twinLinkLines) lines.push(line);

  return `${lines.join('\n')}\n`;
}
