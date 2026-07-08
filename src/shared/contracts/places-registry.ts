// ── places.json soft-registry contract (Sprint 10, Workstream A1) ──
//
// `places.json` owns the Site → Place → Affordance model. It is a SOFT registry:
// loaded-if-present, absent file degrades to an EMPTY registry (no boot gate),
// exactly like `satellites.json`. It is deliberately kept SEPARATE from
// `satellites.json`, which remains the security-authoritative claim spine for
// what an external endpoint may advertise. A satellite binds to a place by a
// `placeId` foreign key (see satellite-registry `SatelliteConfig.placeId`);
// places never grant device authority.
//
// STABLE ID CONTRACT (load-bearing for multi-companion):
//   `placeId` and `siteId` are stable string identifiers. The multi-companion
//   substrate keys its shared `companion_presence` table on `siteId`/`placeId`
//   (see working_docs/sprint-10-multi-companion.md §4 W5). Do NOT recycle or
//   re-mint these IDs across renames — a display name may change freely, the ID
//   must not. Treat them like primary keys.
//
// An affordance is either a PERCEIVER (sensor: presence, face, mic, camera) or
// an EFFECTOR (actuator: light, media_player, switch, climate, virtual_object).
// Physical affordances resolve to Home Assistant entities (`backend: 'ha'`) or
// a satellite-local capability (`backend: 'satellite'`); virtual affordances
// resolve to virtual-object ids (`backend: 'vr'`). One namespaced vocabulary,
// multiple backends.

export const PLACES_REGISTRY_FILE_NAME = 'places.json';

export type PlaceKind = 'physical' | 'virtual';

export type AffordanceRole = 'perceiver' | 'effector';

export type AffordanceBackend = 'ha' | 'satellite' | 'vr';

/**
 * Frozen allowlist of affordance kinds. Unknown kinds fail closed at parse time.
 * `presence`, `face`, `mic`, `camera` are typically perceivers; `light`,
 * `media_player`, `switch`, `climate`, `virtual_object` are typically effectors.
 * The role is declared explicitly per affordance and is not inferred from kind.
 */
export const AFFORDANCE_KINDS = Object.freeze([
  'light',
  'media_player',
  'switch',
  'climate',
  'presence',
  'face',
  'mic',
  'camera',
  'virtual_object',
] as const);

export type AffordanceKind = typeof AFFORDANCE_KINDS[number];

export interface AffordanceConfig {
  affordanceId: string;
  role: AffordanceRole;
  kind: AffordanceKind;
  backend: AffordanceBackend;
  displayName?: string;
  /** Backend-resolved handle (HA `entity_id`, virtual-object id). Optional for satellite-local sensors. */
  entityId?: string;
  /** Effector-only: control verbs this affordance accepts (e.g. on/off/brightness). Display-only for now. */
  control?: string[];
}

export interface SiteConfig {
  siteId: string;
  displayName: string;
  kind: PlaceKind;
}

export interface PlaceConfig {
  placeId: string;
  siteId: string;
  displayName: string;
  kind: PlaceKind;
  /** Physical-only: Home Assistant area binding. Absent for virtual places. */
  haAreaId?: string;
  /** Optional operator-authored place description (surroundings summary). */
  description?: string;
  affordances: AffordanceConfig[];
}

export interface PlacesRegistryConfig {
  schemaVersion: 1;
  sites: SiteConfig[];
  places: PlaceConfig[];
}
