// ── Dual-presence turn classification + mindspace twin default (vinz.29) ──
//
// The locations contract in docs/architecture.md and the situated-presence
// lifecycle in docs/chat-turn-lifecycle.md require every turn to be classified
// by its DEVICE ORIGIN into one of two presence modes.
//
//  * `physical`  — the inbound device is a classified satellite (or a physical
//    voice endpoint): the companion is physically emanating into that room;
//    the turn's own place binding (routing.satellite.placeId) foregrounds
//    that room's REAL place. Satellite turns always outrank everything else.
//  * `mindspace` — the inbound origin is a plain chat channel
//    (Discord/Telegram/API/…): the companion is co-located with the partner in
//    a VIRTUAL TWIN of the physical space. The mindspace room defaults to the
//    twin of the LAST-KNOWN physical room (the durable situated state, vinz.7)
//    and is overridable by a validated, session-scoped narrative assertion.
//    A deliberate virtual `move` (vinz.26) remains the highest-precedence
//    overlay. Free-text assertion extraction is deliberately outside this
//    deterministic seam.
//
// The mode is picked PER TURN from origin classification, never from a global
// flag; a companion can serve both modes across consecutive turns.
//
// Both functions are PURE (no clock, I/O, or state): the caller supplies the
// tracker/durable-state inputs. Fail closed: with no twin configured for the
// last-known physical place, a mindspace turn remains unsituated rather than
// borrowing the active physical emanation's room.

import type { SubstrateMessage } from '../../../../shared/contracts/runtime.js';
import type { PlacesRegistryConfig } from '../../../../shared/contracts/places-registry.js';
import { resolveTwinPlaceOf } from '../../../../shared/contracts/places-registry.js';
import type { SituatedLocation } from '../../../self-model/state.js';

/** The two per-turn presence modes (decision 9). */
export type TurnPresenceMode = 'physical' | 'mindspace';

/**
 * Classify a turn's presence mode from its routing/channel origin.
 *
 * Physical-emanation origin = structured device routing: satellite metadata
 * from the authenticated satellite claim spine, or a Wyoming voice endpoint.
 * Source strings and presence hints are observations, not origin proof; they
 * cannot turn a Discord/API message into a physical emanation. Everything else
 * (Discord/Telegram/plain API chat, internal turns) is mindspace-eligible.
 */
export function classifyTurnPresenceMode(message: SubstrateMessage): TurnPresenceMode {
  const routing = message.routing;
  if (!routing) return 'mindspace';
  if (routing.satellite) return 'physical';
  if (routing.wyoming) return 'physical';
  return 'mindspace';
}

export interface ResolveTurnSituatedFallbackPlaceIdInput {
  message: SubstrateMessage;
  /** Places soft-registry; undefined behaves as an empty registry (no twins). */
  placesRegistry?: PlacesRegistryConfig;
  /** Deliberate virtual-move overlay (vinz.26) — outranks the mindspace default. */
  virtualMovePlaceId?: string;
  /** Validated physical place asserted in this logical session. */
  sessionOverridePhysicalPlaceId?: string;
  /** The tracker's current physical emanation place (physical-origin fallback only). */
  emanationPlaceId?: string;
  /** Durable last-known situated location (vinz.7); twin source when physical. */
  durableLocation?: SituatedLocation | null;
}

/**
 * The twin place of the durable last-known PHYSICAL location, when both exist.
 * A durable location that is virtual, presence-hint-only (no placeId), or has
 * no declared twin resolves nothing — never a fabricated mindspace room.
 */
function resolveMindspaceTwinPlaceId(
  registry: PlacesRegistryConfig | undefined,
  physicalPlaceId: string | null | undefined,
): string | undefined {
  if (!physicalPlaceId) return undefined;
  return resolveTwinPlaceOf(registry, physicalPlaceId)?.placeId;
}

/**
 * Resolve the situated FALLBACK place for a turn — the place foregrounded when
 * the turn itself carries no place binding. This extends (does not fork) the
 * pre-vinz.29 fallback chain (deliberate virtual move → active physical
 * emanation, i.e. `SituatedEmanationTracker.resolvePlaceId()`):
 *
 *  * physical-origin turns: chain unchanged. (A satellite turn's own
 *    routing.placeId outranks any fallback at every call site anyway.)
 *  * mindspace turns: deliberate virtual move → session assertion's twin →
 *    durable last-known physical room's twin. There is deliberately no
 *    physical-emanation terminal: a plain-chat turn with no configured twin
 *    must remain unsituated instead of claiming physical co-location.
 */
export function resolveTurnSituatedFallbackPlaceId(
  input: ResolveTurnSituatedFallbackPlaceIdInput,
): string | undefined {
  if (classifyTurnPresenceMode(input.message) === 'mindspace') {
    if (input.virtualMovePlaceId) return input.virtualMovePlaceId;
    const sessionOverridePlaceId = resolveMindspaceTwinPlaceId(
      input.placesRegistry,
      input.sessionOverridePhysicalPlaceId,
    );
    if (sessionOverridePlaceId) return sessionOverridePlaceId;
    const mindspacePlaceId = resolveMindspaceTwinPlaceId(
      input.placesRegistry,
      input.durableLocation?.kind === 'physical' ? input.durableLocation.placeId : undefined,
    );
    if (mindspacePlaceId) return mindspacePlaceId;
    return undefined;
  }
  return input.emanationPlaceId;
}
