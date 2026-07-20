// ── Garden places/affordances service (S10 Workstream F1) ──
// Operator-facing READ surface over the places soft-registry (`places.json`)
// joined to the satellite security registry (`satellites.json`), plus the
// mutation the location/topology model allows: a static place binding.
//
// Read-first: every request reads both owner files fresh from `dataDir` so the
// view reflects the current on-disk registries (including a just-applied
// re-bind). This is DATA only — sites, places, affordances, and which satellite
// binds to each place. It is never routed into prompt content, and it carries
// no biometric payload (biometrics live at the Hub, never in core).
//
// Static re-bind is the ONLY path that changes a satellite's `placeId` or
// There is no runtime auto-rebinding. Shared-device authorities are edited as
// one governed satellites.json policy, never as a legacy single-owner field.

import {
  loadPlacesRegistryConfig,
  resolvePlaceById,
} from '../../../channels/backplane/places-registry.js';
import { renderPlacesMermaid } from '../../../channels/backplane/places-mermaid.js';
import {
  loadSatelliteRegistryConfig,
  saveSatelliteRegistryConfig,
} from '../../../channels/backplane/satellite-registry.js';
import type {
  AffordanceBackend,
  AffordanceKind,
  AffordanceRole,
  PlaceKind,
  SiteConfig,
} from '../../../shared/contracts/places-registry.js';
import type {
  SatelliteSharedDevicePolicy,
  SatelliteMobility,
  SatelliteRegistryConfig,
} from '../../../shared/contracts/satellite-registry.js';
import {
  type CompanionId,
} from '../../../shared/routing/companion-id.js';

export interface AdminAffordanceView {
  affordanceId: string;
  role: AffordanceRole;
  kind: AffordanceKind;
  backend: AffordanceBackend;
  displayName?: string;
  entityId?: string;
  control?: string[];
}

/** A satellite bound to a place (identity + mobility only — no auth/claim data). */
export interface AdminBoundSatelliteView {
  satelliteId: string;
  displayName: string;
  mobility: SatelliteMobility;
  staticLocationLabel?: string;
  sharedDevice?: SatelliteSharedDevicePolicy;
}

export interface AdminPlaceView {
  placeId: string;
  siteId: string;
  displayName: string;
  kind: PlaceKind;
  haAreaId?: string;
  description?: string;
  /** Authored directional link, present on virtual mirror places. */
  mirrorsPlaceId?: string;
  /** Symmetric twin lookup for either side of an authored overlap. */
  twinPlaceId?: string;
  affordances: AdminAffordanceView[];
  /** Satellites whose static `placeId` resolves to this place. */
  satellites: AdminBoundSatelliteView[];
}

/** A satellite bound to a `placeId` that does not exist in `places.json`. */
export interface AdminDanglingSatelliteView extends AdminBoundSatelliteView {
  placeId: string;
}

export interface AdminPlacesData {
  schemaVersion: 1;
  sites: SiteConfig[];
  places: AdminPlaceView[];
  /** Satellites with no `placeId` binding at all. */
  unboundSatellites: AdminBoundSatelliteView[];
  /** Satellites bound to a placeId absent from `places.json` (fail-closed surfacing). */
  danglingSatellites: AdminDanglingSatelliteView[];
}

export interface AdminSatelliteRebindInput {
  satelliteId: string;
  /** Target place, or `null` to clear the binding (unbind). */
  placeId?: string | null;
}

export interface AdminSatelliteRebindResult {
  ok: true;
  satelliteId: string;
  placeId: string | null;
  places: AdminPlacesData;
}

export interface AdminPlacesService {
  listPlaces(): Promise<AdminPlacesData>;
  rebindSatellite(input: AdminSatelliteRebindInput): Promise<AdminSatelliteRebindResult>;
  /**
   * Render the current places registry (+ satellite bindings) as a Mermaid
   * `flowchart TB`. Read-first like `listPlaces`: both owner files are read
   * fresh from `dataDir`. DATA only — never routed into prompt content.
   */
  renderMermaidMap(): Promise<string>;
}

function toBoundSatelliteView(satellite: {
  satelliteId: string;
  displayName: string;
  mobility: SatelliteMobility;
  staticLocationLabel?: string;
  sharedDevice?: SatelliteSharedDevicePolicy;
}): AdminBoundSatelliteView {
  return {
    satelliteId: satellite.satelliteId,
    displayName: satellite.displayName,
    mobility: satellite.mobility,
    ...(satellite.staticLocationLabel ? { staticLocationLabel: satellite.staticLocationLabel } : {}),
    ...(satellite.sharedDevice ? { sharedDevice: satellite.sharedDevice } : {}),
  };
}

function buildPlacesData(dataDir: string): AdminPlacesData {
  const places = loadPlacesRegistryConfig(dataDir);
  const satellites = loadSatelliteRegistryConfig(dataDir);

  const placeIds = new Set(places.places.map((place) => place.placeId));
  const twinPlaceIdByPlaceId = new Map<string, string>();
  for (const place of places.places) {
    if (!place.mirrorsPlaceId) continue;
    twinPlaceIdByPlaceId.set(place.placeId, place.mirrorsPlaceId);
    twinPlaceIdByPlaceId.set(place.mirrorsPlaceId, place.placeId);
  }

  const placeViews: AdminPlaceView[] = places.places.map((place) => ({
    placeId: place.placeId,
    siteId: place.siteId,
    displayName: place.displayName,
    kind: place.kind,
    ...(place.haAreaId ? { haAreaId: place.haAreaId } : {}),
    ...(place.description ? { description: place.description } : {}),
    ...(place.mirrorsPlaceId ? { mirrorsPlaceId: place.mirrorsPlaceId } : {}),
    ...(twinPlaceIdByPlaceId.get(place.placeId)
      ? { twinPlaceId: twinPlaceIdByPlaceId.get(place.placeId) }
      : {}),
    affordances: place.affordances.map((affordance) => ({
      affordanceId: affordance.affordanceId,
      role: affordance.role,
      kind: affordance.kind,
      backend: affordance.backend,
      ...(affordance.displayName ? { displayName: affordance.displayName } : {}),
      ...(affordance.entityId ? { entityId: affordance.entityId } : {}),
      ...(affordance.control ? { control: [...affordance.control] } : {}),
    })),
    satellites: [],
  }));

  const placeViewsById = new Map(placeViews.map((view) => [view.placeId, view]));
  const unboundSatellites: AdminBoundSatelliteView[] = [];
  const danglingSatellites: AdminDanglingSatelliteView[] = [];

  for (const satellite of satellites.satellites) {
    if (satellite.placeId === undefined) {
      unboundSatellites.push(toBoundSatelliteView(satellite));
      continue;
    }
    const target = placeViewsById.get(satellite.placeId);
    if (target) {
      target.satellites.push(toBoundSatelliteView(satellite));
    } else if (!placeIds.has(satellite.placeId)) {
      danglingSatellites.push({ ...toBoundSatelliteView(satellite), placeId: satellite.placeId });
    }
  }

  return {
    schemaVersion: 1,
    sites: places.sites.map((site) => ({ ...site })),
    places: placeViews,
    unboundSatellites,
    danglingSatellites,
  };
}

export function createAdminPlacesService(options: {
  dataDir: string;
  fleetCompanionIds: readonly CompanionId[];
}): AdminPlacesService {
  const { dataDir } = options;
  void options.fleetCompanionIds;

  return {
    async listPlaces(): Promise<AdminPlacesData> {
      return buildPlacesData(dataDir);
    },

    async renderMermaidMap(): Promise<string> {
      const places = loadPlacesRegistryConfig(dataDir);
      const satellites = loadSatelliteRegistryConfig(dataDir);
      return renderPlacesMermaid(places, satellites);
    },

    async rebindSatellite(input: AdminSatelliteRebindInput): Promise<AdminSatelliteRebindResult> {
      const satelliteId = input.satelliteId.trim();
      if (!satelliteId) {
        throw new Error('satelliteId is required to re-bind a satellite');
      }
      if (input.placeId === undefined) {
        throw new Error('A placeId binding change is required');
      }
      const targetPlaceId = input.placeId === null ? null : input.placeId.trim();
      if (targetPlaceId !== null && !targetPlaceId) {
        throw new Error('placeId must be a non-empty string, or null to unbind');
      }
      const registry = loadSatelliteRegistryConfig(dataDir);
      const satellite = registry.satellites.find((candidate) => candidate.satelliteId === satelliteId);
      if (!satellite) {
        throw new Error(`unknown satellite "${satelliteId}"`);
      }

      // Fail closed on an unknown place, mirroring assertSatellitePlaceBindings:
      // the ONLY valid bind target is a place that exists in places.json.
      if (targetPlaceId !== null) {
        const places = loadPlacesRegistryConfig(dataDir);
        const targetPlace = resolvePlaceById(places, targetPlaceId);
        if (!targetPlace) {
          throw new Error(
            `cannot bind satellite "${satelliteId}" to placeId "${targetPlaceId}" which does not exist in places.json`,
          );
        }
        if (targetPlace.kind !== 'physical') {
          throw new Error(
            `cannot bind satellite "${satelliteId}" to placeId "${targetPlaceId}": satellite places must be physical`,
          );
        }
      }

      const nextRegistry: SatelliteRegistryConfig = {
        ...registry,
        satellites: registry.satellites.map((candidate) => {
          if (candidate.satelliteId !== satelliteId) return candidate;
          const { placeId: _dropPlaceId, ...withoutPlaceId } = candidate;
          void _dropPlaceId;
          return targetPlaceId === null
            ? withoutPlaceId
            : { ...withoutPlaceId, placeId: targetPlaceId };
        }),
      };

      saveSatelliteRegistryConfig(dataDir, nextRegistry);

      return {
        ok: true,
        satelliteId,
        placeId: targetPlaceId,
        places: buildPlacesData(dataDir),
      };
    },
  };
}
