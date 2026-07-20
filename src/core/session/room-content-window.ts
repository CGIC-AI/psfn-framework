// ── Presence-windowed room content gate (bead s10rm) ──
//
// Privacy for PRIVATE rooms is enforced at DELIVERY time, never by filtering
// memory extraction: an occupant receives room chat only from their join
// until their exit, so their L0 session naturally contains only what they
// witnessed. This port is the agent-side half of that mechanism — it tells
// the session layer which time window of a room channel's content may be
// SERVED back into context right now.
//
// Semantics per channel:
//  - `unwindowed`  — serve everything (public rooms, every non-room channel;
//                    the default when no port is wired: byte-identical).
//  - `windowed`    — serve only content with timestamp >= floorMs. The floor
//                    is the recipient's CURRENT presence window start (their
//                    `companion_presence.since` — the join time; one clock,
//                    no second bookkeeping). Rejoining a room opens a NEW
//                    window: content from earlier windows and from the gap is
//                    not served, even though earlier-window content was
//                    legitimately witnessed (it lives on in extracted memory,
//                    not in the live room context).
//  - `closed`      — serve nothing (not present at the room's place, presence
//                    unknown/stale, or unresolvable room). Fail closed.
//
// HUMAN-MEMBERED ROOMS (future hook): Discord/Telegram group channels are
// PUBLIC rooms today and never resolve through an implementation of this port
// — their history behavior is untouched. A future private human room would
// (a) mark its place/channel `private` and (b) provide a port implementation
// for that channel family whose floor comes from the human member's join
// event on that channel (invitation flows are explicitly out of scope here).
// The session layer is already shaped for it: it consults this port for EVERY
// resolved channel and gates purely on the returned window.

export type RoomContentWindow =
  | { kind: 'unwindowed' }
  | { kind: 'windowed'; floorMs: number }
  | { kind: 'closed' };

export interface RoomContentWindowPort {
  /**
   * Resolve the servable content window for a RESOLVED session channel id.
   * Must be cheap and synchronous — it runs inside context capture.
   */
  resolveWindow(channelId: string): RoomContentWindow;
}

export const UNWINDOWED_ROOM_CONTENT_WINDOW: RoomContentWindow = Object.freeze({
  kind: 'unwindowed',
});

/**
 * Collapse a window to a single numeric serve floor:
 * unwindowed → -Infinity (everything), windowed → floorMs, closed → +Infinity
 * (nothing). Comparisons are `timestamp >= floor`.
 */
export function roomContentWindowFloorMs(window: RoomContentWindow): number {
  switch (window.kind) {
    case 'unwindowed':
      return Number.NEGATIVE_INFINITY;
    case 'windowed':
      return window.floorMs;
    case 'closed':
      return Number.POSITIVE_INFINITY;
  }
}

/**
 * Compose several ports into one so a single manager slot can serve multiple
 * independent channel families (e.g. the companion-room window and the
 * Discord-voice window). The FIRST port whose window is not `unwindowed` wins;
 * if every port returns `unwindowed`, the composite is `unwindowed`.
 *
 * Each port MUST own a disjoint channel family — returning `unwindowed` for any
 * channel it does not own — so ordering only picks the default and can never
 * silently override one owner's `closed`/`windowed` verdict with another's.
 */
export function composeRoomContentWindowPorts(
  ports: readonly RoomContentWindowPort[],
): RoomContentWindowPort {
  return {
    resolveWindow(channelId: string): RoomContentWindow {
      for (const port of ports) {
        const window = port.resolveWindow(channelId);
        if (window.kind !== 'unwindowed') return window;
      }
      return { kind: 'unwindowed' };
    },
  };
}
