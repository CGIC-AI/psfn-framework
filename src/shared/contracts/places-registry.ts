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
  /**
   * Twin link (S10 vinz.29, decisions 9-13): a VIRTUAL place may declare that
   * it is the shared-mindspace mirror ("twin") of exactly one PHYSICAL place.
   * `mirrorsPlaceId` is the chosen canonical identifier for this link (over
   * the `twinOf` alternate) — neutral and directional: this virtual place
   * mirrors that physical placeId. The registry loader fails closed when the
   * declaring place is not virtual, the target does not exist, the target is
   * not physical, or a physical place is mirrored by more than one twin.
   *
   * Any character-facing name for the mindspace concept (e.g. what the
   * operator calls the shared virtual layer) is a DISPLAY LABEL living in
   * companion-data (character card extensions), never a code identifier here.
   */
  mirrorsPlaceId?: string;
  affordances: AffordanceConfig[];
}

export interface PlacesRegistryConfig {
  schemaVersion: 1;
  sites: SiteConfig[];
  places: PlaceConfig[];
}

/**
 * Canonical validation rule for a `siteId` / `placeId` / `affordanceId` token.
 * This is the single source of truth for the ID grammar the registry loaders
 * (`channels/backplane/places-registry`, `satellite-registry`) enforce: a
 * leading alphanumeric, then letters/numbers/dot/underscore/dash/colon, ≤128
 * chars. Other subsystems that must reference a place/site ID out of band (e.g.
 * the wiki `shared_world:<siteId>` scope) reuse {@link isValidPlaceIdToken} so
 * the grammar cannot drift between producers and consumers.
 */
export const PLACE_ID_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** True when `value` is a syntactically valid place/site/affordance ID token. */
export function isValidPlaceIdToken(value: string): boolean {
  return PLACE_ID_TOKEN_PATTERN.test(value);
}

/**
 * Resolve the virtual mindspace twin of a physical place: the (at most one,
 * loader-enforced) virtual place whose `mirrorsPlaceId` names `physicalPlaceId`.
 * Pure lookup over the parsed registry — usable from core modules without a
 * value-level dependency on the `channels` loader. Returns undefined when the
 * physical place has no declared twin.
 */
export function resolveTwinPlaceOf(
  registry: PlacesRegistryConfig | undefined,
  physicalPlaceId: string,
): PlaceConfig | undefined {
  if (!registry) return undefined;
  return registry.places.find(
    (place) => place.kind === 'virtual' && place.mirrorsPlaceId === physicalPlaceId,
  );
}
