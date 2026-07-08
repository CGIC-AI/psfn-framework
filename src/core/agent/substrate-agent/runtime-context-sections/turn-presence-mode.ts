// ── Dual-presence turn classification + mindspace twin default (vinz.29) ──
//
// Sprint-10 decisions 9-13 (SPRINT_10_LOCATIONS.md §7): every turn is
// classified by its DEVICE ORIGIN into one of two presence modes.
//
//  * `physical`  — the inbound device is a classified satellite (or a physical
//    voice endpoint): the companion is physically emanating into that room;
//    the turn's own place binding (routing.satellite.placeId) foregrounds
//    that room's REAL place. Satellite turns always outrank everything else.
//  * `mindspace` — the inbound origin is a plain chat channel
//    (Discord/Telegram/API/…): the companion is co-located with the partner in
//    a VIRTUAL TWIN of the physical space. The mindspace room defaults to the
//    twin of the LAST-KNOWN physical room (the durable situated state, vinz.7)
//    and is overridable by a deliberate virtual `move` (vinz.26) — the v1
//    narrative cue. Free-text narrative-cue detection is a tracked follow-up,
//    not implemented here.
//
// The mode is picked PER TURN from origin classification, never from a global
// flag; a companion can serve both modes across consecutive turns.
//
// Both functions are PURE (no clock, I/O, or state): the caller supplies the
// tracker/durable-state inputs. Fail closed: with no twin configured for the
// last-known physical place, the mindspace default resolves nothing extra and
// the legacy fallback chain (deliberate virtual move → active physical
// emanation) applies unchanged, so registries without twin links render
// byte-identically to pre-vinz.29 behavior.

import type { SubstrateMessage } from '../../../../shared/contracts/runtime.js';
import type { PlacesRegistryConfig } from '../../../../shared/contracts/places-registry.js';
import { resolveTwinPlaceOf } from '../../../../shared/contracts/places-registry.js';
import type { SituatedLocation } from '../../../self-model/state.js';

/** The two per-turn presence modes (decision 9). */
export type TurnPresenceMode = 'physical' | 'mindspace';

/**
 * Classify a turn's presence mode from its routing/channel origin.
 *
 * Physical-emanation origin = any device-bound signal: satellite routing
 * metadata (the security-classified satellite claim spine), a Wyoming voice
 * endpoint, a satellite/wyoming routing source, or a satellite/embodiment
 * presence claim. Everything else (Discord/Telegram/plain API chat, internal
 * turns) is mindspace-eligible.
 */
export function classifyTurnPresenceMode(message: SubstrateMessage): TurnPresenceMode {
  const routing = message.routing;
  if (!routing) return 'mindspace';
  if (routing.satellite) return 'physical';
  if (routing.wyoming) return 'physical';
  if (routing.source === 'satellite' || routing.source === 'wyoming') return 'physical';
  const presenceKind = routing.presence?.kind;
  if (presenceKind === 'satellite' || presenceKind === 'embodiment') return 'physical';
  return 'mindspace';
}

export interface ResolveTurnSituatedFallbackPlaceIdInput {
  message: SubstrateMessage;
  /** Places soft-registry; undefined behaves as an empty registry (no twins). */
  placesRegistry?: PlacesRegistryConfig;
  /** Deliberate virtual-move overlay (vinz.26) — outranks the mindspace default. */
  virtualMovePlaceId?: string;
  /** The tracker's current physical emanation place (legacy fallback terminal). */
  emanationPlaceId?: string;
  /** Durable last-known situated location (vinz.7); twin source when physical. */
  durableLocation?: SituatedLocation | null;
}

/**
 * The twin place of the durable last-known PHYSICAL location, when both exist.
 * A durable location that is virtual, presence-hint-only (no placeId), or has
 * no declared twin resolves nothing — never a fabricated mindspace room.
 */
function resolveMindspaceDefaultPlaceId(
  registry: PlacesRegistryConfig | undefined,
  durableLocation: SituatedLocation | null | undefined,
): string | undefined {
  if (!durableLocation || durableLocation.kind !== 'physical' || !durableLocation.placeId) {
    return undefined;
  }
  return resolveTwinPlaceOf(registry, durableLocation.placeId)?.placeId;
}

/**
 * Resolve the situated FALLBACK place for a turn — the place foregrounded when
 * the turn itself carries no place binding. This extends (does not fork) the
 * pre-vinz.29 fallback chain (deliberate virtual move → active physical
 * emanation, i.e. `SituatedEmanationTracker.resolvePlaceId()`):
 *
 *  * physical-origin turns: chain unchanged. (A satellite turn's own
 *    routing.placeId outranks any fallback at every call site anyway.)
 *  * mindspace turns: the twin of the durable last-known physical room slots
 *    in between — deliberate virtual move → mindspace twin → physical
 *    emanation. The move overlay outranks the default twin (decision 13's v1
 *    narrative-cue override); the no-twin terminal keeps legacy behavior.
 */
export function resolveTurnSituatedFallbackPlaceId(
  input: ResolveTurnSituatedFallbackPlaceIdInput,
): string | undefined {
  if (input.virtualMovePlaceId) return input.virtualMovePlaceId;
  if (classifyTurnPresenceMode(input.message) === 'mindspace') {
    const mindspacePlaceId = resolveMindspaceDefaultPlaceId(
      input.placesRegistry,
      input.durableLocation,
    );
    if (mindspacePlaceId) return mindspacePlaceId;
  }
  return input.emanationPlaceId;
}
