// Perception → context-visible note delivery (Sprint 10, Workstream D3 — bead .14).
//
// This module turns a resolved presence (bead .13) or a raw presence
// detected/cleared PerceptionEvent (bead .11) into a natural, context-visible
// `[Presence] ...` system note and delivers it through the SAME async note lane
// temporal-wakeup and room-entry use: SessionManager.appendContextSystemNote,
// posted to the ACTIVE satellite session channel so the note lands in that
// place's session scope (sessions are channel-keyed).
//
// It is deliberately thin: PURE composition plus one append call. No new
// delivery mechanism, no LLM, no clock, no I/O. Trust gating is inherited from
// the .13 resolver — a `known` presence names the enrolled contact, an
// `anonymous` presence stays generic and NEVER fabricates an identity.
//
// Fail-closed / no-noise posture:
//   - a presence event with no session channel scope delivers NOTHING (there is
//     no place session to post into);
//   - a `cleared` event with no prior `detected`/arrival for that channel
//     delivers NOTHING (never announces a departure that never had an arrival);
//   - a repeated `detected` while a channel is already occupied is de-duped so a
//     flapping presence sensor cannot spam the session.

import type { ResolvedPresence, ResolvedPresenceSink } from './identity-claim-resolver.js';
import type { PerceptionEvent, PerceptionEventSink } from './sensor-cognition-bridge.js';

/**
 * Distinct source tag for the session-lane `system_note` envelope, matching the
 * `snake_case` convention used by temporal-wakeup / room-entry note sources
 * (TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE = 'temporal_wakeup_morning', etc.).
 */
export const PERCEPTION_PRESENCE_NOTE_SOURCE = 'perception';

const PRESENCE_TAG = '[Presence]';

/**
 * Narrow structural sink for delivery. `SessionManager.appendContextSystemNote`
 * satisfies this (its `source` parameter has a default, which is assignable to a
 * required parameter here), so this module never imports SessionManager.
 */
export interface PerceptionNoteSink {
  appendContextSystemNote(channelId: string, note: string, source: string): void;
}

/**
 * Compose the arrival note for a KNOWN, owner-enrolled contact. Names the
 * contact (trust already gated upstream by the .13 resolver) and the place.
 */
export function composeKnownArrivalNote(displayName: string, placeDisplayName: string): string {
  return `${PRESENCE_TAG} ${displayName} just entered the ${placeDisplayName}.`;
}

/**
 * Compose the generic presence note for an UNRECOGNIZED presence. Never names or
 * guesses an identity — this is the fail-closed, trust-gated phrasing.
 */
export function composeAnonymousPresenceNote(placeDisplayName: string): string {
  return `${PRESENCE_TAG} Someone is present in the ${placeDisplayName}.`;
}

/** Compose the departure note delivered when an occupied place clears. */
export function composeDepartureNote(placeDisplayName: string): string {
  return `${PRESENCE_TAG} The ${placeDisplayName} is now empty.`;
}

/**
 * A delivery sink that consumes both resolved presences (identity claims) and
 * raw presence detected/cleared events, and delivers context-visible notes.
 * Implements {@link ResolvedPresenceSink} (the .13 seam) AND
 * {@link PerceptionEventSink} (the bridge's passthrough seam for non-identity
 * events), so a single instance can be wired into both.
 */
export type PerceptionNoteDeliverer = ResolvedPresenceSink & PerceptionEventSink;

/**
 * Build a {@link PerceptionNoteDeliverer} over a note sink. Tracks per-channel
 * occupancy so `cleared`-without-`detected` and flapping `detected` events do
 * not produce spurious or duplicate notes.
 */
export function createPerceptionNoteDeliverer(sink: PerceptionNoteSink): PerceptionNoteDeliverer {
  // Per-session-channel occupancy. An entry is present only while the channel is
  // believed occupied; departure delivery clears it. Bounded implicitly: entries
  // are added on arrival and removed on the matching clear.
  const occupied = new Set<string>();

  function handleResolvedPresence(presence: ResolvedPresence): void {
    const { channelId, placeDisplayName } = presence.event;
    // No session scope to post into — fail closed, deliver nothing.
    if (!channelId) return;

    const note = presence.kind === 'known'
      ? composeKnownArrivalNote(presence.displayName, placeDisplayName)
      : composeAnonymousPresenceNote(placeDisplayName);
    // An identity observation implies the place is now occupied, so a later
    // `cleared` can legitimately announce the departure.
    occupied.add(channelId);
    sink.appendContextSystemNote(channelId, note, PERCEPTION_PRESENCE_NOTE_SOURCE);
  }

  function handlePerceptionEvent(event: PerceptionEvent): void {
    // Identity claims are handled through handleResolvedPresence (the .13 seam);
    // this passthrough seam only carries non-identity presence events.
    if (event.kind !== 'presence') return;
    const { channelId, placeDisplayName } = event;
    if (!channelId) return;

    if (event.action === 'detected') {
      // De-dup a flapping sensor: only the transition into occupancy speaks.
      if (occupied.has(channelId)) return;
      occupied.add(channelId);
      sink.appendContextSystemNote(
        channelId,
        composeAnonymousPresenceNote(placeDisplayName),
        PERCEPTION_PRESENCE_NOTE_SOURCE,
      );
      return;
    }

    // action === 'cleared': a clear with no prior arrival announces nothing.
    if (!occupied.has(channelId)) return;
    occupied.delete(channelId);
    sink.appendContextSystemNote(
      channelId,
      composeDepartureNote(placeDisplayName),
      PERCEPTION_PRESENCE_NOTE_SOURCE,
    );
  }

  return { handleResolvedPresence, handlePerceptionEvent };
}
