import type { AffordanceConfig, PlaceKind } from '../../shared/contracts/places-registry.js';

// ── Room-entry system-note helper (Sprint 10, W5 "Entry event" contract) ──
//
// Implements the working_docs/sprint-10-multi-companion.md §4 W5 decision:
// "a companion entering a room receives a system-only message: room ID,
// surroundings, who else is present." This module is the single deterministic
// composer for that note plus a thin append wrapper that delivers it through
// the existing context-system-note lane (the same lane temporal wakeups use).
//
// The composer is PURE: no LLM, no clock, no I/O, no randomness. Given the same
// input it always returns the same string. Delivery is deliberately factored
// out behind a narrow structural sink so single-companion locations work
// (conversation-follows-you, G1) and future multi-companion entry events can
// call the same helper with their own session handle without dragging in
// SessionManager internals.

/**
 * Distinct source tag for the session-lane `system_note` envelope, matching the
 * `snake_case` convention used by temporal-wakeup note sources
 * (TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE = 'temporal_wakeup_morning', etc.).
 */
export const ROOM_ENTRY_NOTE_SOURCE = 'room_entry';

const ROOM_ENTRY_TAG = '[Room entry]';

/**
 * Structural view of a place for note composition. `PlaceConfig` is
 * structurally assignable to this (it carries every field plus `affordances`),
 * so callers may pass a resolved `PlaceConfig` directly. Kept narrow so the
 * helper never depends on the full registry shape.
 */
export interface RoomEntryPlace {
  placeId: string;
  siteId: string;
  displayName: string;
  kind: PlaceKind;
  /** Optional operator-authored surroundings summary. */
  description?: string;
}

/** A co-present occupant of the room, as the session's presence view sees it. */
export interface RoomEntryOccupant {
  displayName: string;
  kind: 'human' | 'companion';
}

export interface RoomEntryNoteInput {
  /** The room's channel/room ID (part of the world ID; see W5). */
  roomChannelId: string;
  /** The place bound to this room, when the soft places registry resolves one. */
  place?: RoomEntryPlace;
  /** Affordances present in the place (perceivers/effectors). */
  affordances?: readonly AffordanceConfig[];
  /** Everyone else the session currently sees present in the room. */
  present: readonly RoomEntryOccupant[];
}

/**
 * Narrow structural sink for delivery. `SessionManager.appendContextSystemNote`
 * satisfies this (its `source` parameter has a default, which is assignable to a
 * required parameter here), so the helper never imports SessionManager.
 */
export interface RoomEntryNoteSink {
  appendContextSystemNote(channelId: string, note: string, source: string): void;
}

/** `media_player` → `media player`, `virtual_object` → `virtual object`, etc. */
function humanizeAffordanceKind(kind: AffordanceConfig['kind']): string {
  return kind.replace(/_/g, ' ');
}

function affordanceLabel(affordance: AffordanceConfig): string {
  return affordance.displayName?.trim() || humanizeAffordanceKind(affordance.kind);
}

/** Deterministic natural-language list join (Oxford comma for 3+). */
function formatList(items: readonly string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/**
 * Compose the system-only room-entry note (W5 entry event). Pure and
 * deterministic. Returns a multi-line string carrying: the room/channel ID, the
 * bound place name and whether it is physical or virtual, a surroundings summary
 * (operator description plus perceivers/effectors phrased naturally), and who
 * else is present ("No one else is here." when the room is otherwise empty).
 */
export function composeRoomEntryNote(input: RoomEntryNoteInput): string {
  const lines: string[] = [ROOM_ENTRY_TAG];

  const { place } = input;
  const placeSuffix = place ? ` — ${place.displayName} (${place.kind})` : '';
  lines.push(`You have entered room ${input.roomChannelId}${placeSuffix}.`);

  const description = place?.description?.trim();
  if (description) lines.push(description);

  const affordances = input.affordances ?? [];
  const perceivers = affordances
    .filter((affordance) => affordance.role === 'perceiver')
    .map(affordanceLabel);
  const effectors = affordances
    .filter((affordance) => affordance.role === 'effector')
    .map(affordanceLabel);

  if (perceivers.length > 0) {
    lines.push(`This space can perceive you through ${formatList(perceivers)}.`);
  }
  if (effectors.length > 0) {
    lines.push(`You can act on ${formatList(effectors)} here.`);
  }

  if (input.present.length === 0) {
    lines.push('No one else is here.');
  } else {
    const rendered = input.present.map((occupant) => `${occupant.displayName} (${occupant.kind})`);
    lines.push(`Also present: ${formatList(rendered)}.`);
  }

  return lines.join('\n');
}

/**
 * Compose and deliver the room-entry note through the context-system-note lane.
 * Delivery targets `input.roomChannelId` under the `ROOM_ENTRY_NOTE_SOURCE` tag.
 * The internal frame update is the whole job here — callers that also drive an
 * outward phase should sequence it after this returns (see temporal-wakeup).
 */
export function appendRoomEntryNote(sink: RoomEntryNoteSink, input: RoomEntryNoteInput): void {
  const note = composeRoomEntryNote(input);
  sink.appendContextSystemNote(input.roomChannelId, note, ROOM_ENTRY_NOTE_SOURCE);
}
