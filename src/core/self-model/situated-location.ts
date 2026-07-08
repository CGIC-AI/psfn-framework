// ── Durable situated-location resolver (S10, Workstream B3) ──
// Resolves the companion's last-known location for a turn and makes it durable:
// when a turn carries a fresh routing signal (a satellite bound to a place, or
// honest presence hints), the location is (re)confirmed with a fresh
// `updatedAt`; when a turn carries no signal, the prior location is carried
// forward UNCHANGED so it honestly ages. This is the carry-forward merge that
// lets InternalState.situated persist across turn boundaries and continuity
// gaps (reloads) without a new routing signal.
//
// Fail-closed: with neither a resolvable place, an honest presence hint, nor a
// prior location, the resolved location is null (no fabricated place, ever).
//
// This module is PURE (no clock, I/O, or randomness): the caller supplies
// `now`. It reads `placeId` structurally off satellite routing so it does not
// depend on the sibling A2 contract change landing on another branch.

import { isRecord } from '../../shared/utils/types.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type {
  PlaceConfig,
  PlacesRegistryConfig,
  SiteConfig,
} from '../../shared/contracts/places-registry.js';
import type { SituatedLocation } from './state.js';

export interface ResolveTurnSituatedLocationInput {
  message: SubstrateMessage;
  /** Places soft-registry; undefined behaves as an empty registry. */
  placesRegistry?: PlacesRegistryConfig;
  /** The prior durable location to carry forward when this turn has no signal. */
  priorLocation?: SituatedLocation | null;
  /** Turn time; the fresh-confirmation timestamp when a signal is present. */
  now: Date;
}

/** Structural, type-safe read of an optional `placeId` off satellite routing. */
function readSatellitePlaceId(satellite: unknown): string | undefined {
  if (!isRecord(satellite)) return undefined;
  const placeId = satellite.placeId;
  if (typeof placeId !== 'string') return undefined;
  const trimmed = placeId.trim();
  return trimmed ? trimmed : undefined;
}

function resolvePlace(
  registry: PlacesRegistryConfig | undefined,
  placeId: string | undefined,
): PlaceConfig | undefined {
  if (!registry || !placeId) return undefined;
  return registry.places.find((place) => place.placeId === placeId);
}

function resolveSite(
  registry: PlacesRegistryConfig | undefined,
  siteId: string,
): SiteConfig | undefined {
  if (!registry) return undefined;
  return registry.sites.find((site) => site.siteId === siteId);
}

/**
 * Resolve this turn's durable situated location. Returns the freshly-confirmed
 * location (fresh `updatedAt`) when a routing signal resolves, the unchanged
 * `priorLocation` when it does not, or null when nothing honest is known.
 */
export function resolveTurnSituatedLocation(
  input: ResolveTurnSituatedLocationInput,
): SituatedLocation | null {
  const registry = input.placesRegistry;
  const routing = input.message.routing;
  const placeId = readSatellitePlaceId(routing?.satellite);
  const place = resolvePlace(registry, placeId);
  const presence = routing?.presence;
  const nowIso = input.now.toISOString();

  if (place) {
    return {
      placeId: place.placeId,
      siteId: place.siteId,
      label: place.displayName.trim() || place.placeId,
      kind: place.kind,
      updatedAt: nowIso,
    };
  }

  // No bound place resolved: fall back to honest presence-derived hints only.
  const presenceLabel = presence?.label?.trim();
  const presenceSiteId = presence?.siteId?.trim();
  if (presenceLabel || presenceSiteId) {
    const site = presenceSiteId ? resolveSite(registry, presenceSiteId) : undefined;
    const label = presenceLabel || site?.displayName.trim() || presenceSiteId || '';
    if (label) {
      return {
        placeId: null,
        siteId: presenceSiteId ?? null,
        label,
        kind: site?.kind ?? null,
        updatedAt: nowIso,
      };
    }
  }

  // No fresh signal this turn: carry the prior location forward unchanged so it
  // ages honestly (its original updatedAt is preserved).
  return input.priorLocation ?? null;
}

/**
 * Situated location older than this reads as stale — a best-guess to hold
 * lightly rather than a fresh reading. Mirrors the internal-state rehydration
 * window (6h): a location unconfirmed for that long usually means continuity
 * broke around her rather than she simply stayed put.
 */
export const SITUATED_LOCATION_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/** True when the location was last confirmed longer ago than the stale window. */
export function isSituatedLocationStale(
  location: SituatedLocation,
  now: Date,
): boolean {
  const updatedAtMs = Date.parse(location.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return true;
  return now.getTime() - updatedAtMs > SITUATED_LOCATION_STALE_THRESHOLD_MS;
}

/**
 * Human-readable age of a situated location ("just now", "about 3 hours ago").
 * Deterministic given `now`; used so the rendered reminder always carries how
 * long ago the location was confirmed and is never presented as current fact.
 */
export function describeSituatedLocationAge(
  location: SituatedLocation,
  now: Date,
): string {
  const updatedAtMs = Date.parse(location.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return 'at an unknown time';
  const deltaMs = Math.max(0, now.getTime() - updatedAtMs);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `about ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `about ${days} day${days === 1 ? '' : 's'} ago`;
}
