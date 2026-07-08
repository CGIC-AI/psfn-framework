// ── Companion-room implementation of the room content window port ──
// (psfn-framework-s10rm, presence-windowed private-room delivery)
//
// Maps a resolved session channel id to a servable content window:
//
//  - not a companion channel, or a companion DM      → unwindowed
//  - `companion-room:<placeId>` with a PUBLIC place  → unwindowed
//    (default; byte-identical to pre-privacy behavior)
//  - PRIVATE place, own presence at that place       → windowed from our own
//    `companion_presence.since` (the join time — the one clock)
//  - PRIVATE place, not present / presence unknown /
//    unknown place                                   → closed (fail closed)
//
// The gateway fan-out is the other half of the mechanism: it only delivers
// room messages to companions present at the place (and, for private rooms,
// only within their window), so the session store already holds nothing a
// companion did not witness. This port additionally guarantees that REJOINING
// a private room opens a NEW window — earlier-window content persists in the
// store and in extracted memory but is never served back into the live room
// context.
//
// Human-membered rooms: Discord/Telegram group channels never parse as
// companion channels, so they resolve `unwindowed` here — untouched. A future
// private HUMAN room would add a sibling port implementation for its channel
// family (floor = the member's join event on that channel) and compose it
// with this one; the session layer consumes only the RoomContentWindowPort
// shape (see src/core/session/room-content-window.ts).

import {
  parseCompanionChannelId,
} from '../../shared/contracts/companion-channels.js';
import {
  resolvePlacePrivacy,
  type PlacesRegistryConfig,
} from '../../shared/contracts/places-registry.js';
import type {
  RoomContentWindow,
  RoomContentWindowPort,
} from '../session/room-content-window.js';
import type { OwnPresenceWindow } from './companion-presence-runtime.js';

/** Narrow view over CompanionPresenceRuntime — only the own-window read. */
export interface OwnPresenceWindowSource {
  getOwnPresenceWindow(): OwnPresenceWindow | null;
}

export interface CompanionRoomContentWindowOptions {
  /** Places soft-registry (privacy lives on the place entry). */
  placesRegistry: Pick<PlacesRegistryConfig, 'places'>;
  presence: OwnPresenceWindowSource;
}

export function createCompanionRoomContentWindowPort(
  options: CompanionRoomContentWindowOptions,
): RoomContentWindowPort {
  return {
    resolveWindow(channelId: string): RoomContentWindow {
      const parsed = parseCompanionChannelId(channelId);
      if (!parsed || parsed.kind !== 'room') {
        // Non-room channels (including companion DMs) are never windowed.
        return { kind: 'unwindowed' };
      }
      const place = options.placesRegistry.places.find(
        (entry) => entry.placeId === parsed.placeId,
      );
      if (!place) {
        // A room session for a place the registry no longer knows: fail
        // closed. The gateway would not deliver here either.
        return { kind: 'closed' };
      }
      if (resolvePlacePrivacy(place) !== 'private') {
        return { kind: 'unwindowed' };
      }
      const own = options.presence.getOwnPresenceWindow();
      if (!own || own.place.placeId !== place.placeId || own.place.siteId !== place.siteId) {
        // Not (verifiably) present at this private place right now: the
        // window is closed and nothing is served.
        return { kind: 'closed' };
      }
      return { kind: 'windowed', floorMs: own.sinceMs };
    },
  };
}
