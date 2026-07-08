// ── Co-location → room-entry note wiring (sprint 10, W6) ──
//
// When the presence runtime observes a co-location
// (`presence.companion.co_located`: a companion newly present at our place,
// including everyone already there when WE arrive), append the W5 room-entry
// system note to the place's companion-room channel session so the arrival is
// visible in-context.
//
// CONVERSATION INITIATION POLICY (documented decision, W6): an arrival note is
// CONTEXT, not a triggered turn. No model call, no auto-greeting — the note
// sits in the room session and informs whatever turn happens next. A free-time
// or outreach lane deliberately choosing to speak into a room is future work.

import type { EventBus } from '../../shared/event-bus.js';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';
import { composeCompanionRoomChannelId } from '../../shared/contracts/companion-channels.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  appendRoomEntryNote,
  type RoomEntryNoteSink,
  type RoomEntryOccupant,
} from '../session/room-entry-note.js';
import type {
  CoPresentCompanion,
  SituatedPlaceRef,
} from './substrate-agent/runtime-context-sections/situated-presence.js';

const log = createComponentLogger('CompanionRoomEntry');

export interface RegisterCompanionRoomEntryNotesOptions {
  eventBus: EventBus;
  /** SessionManager satisfies this (appendContextSystemNote). */
  sink: RoomEntryNoteSink;
  /** Places soft-registry for the place name/description/affordances. */
  placesRegistry?: PlacesRegistryConfig;
  /** Co-presence snapshot reader (CompanionPresenceRuntime.getCoPresent). */
  coPresence?: (place: SituatedPlaceRef) => ReadonlyArray<CoPresentCompanion>;
}

/**
 * Subscribe co-location events to room-entry notes. Returns the unsubscribe
 * handle. Multi-companion only — flag-off nothing emits the event, so callers
 * simply do not register this.
 */
export function registerCompanionRoomEntryNotes(
  options: RegisterCompanionRoomEntryNotesOptions,
): () => void {
  return options.eventBus.on('presence.companion.co_located', (event) => {
    try {
      const roomChannelId = composeCompanionRoomChannelId(event.placeId);
      const place = options.placesRegistry?.places.find(
        (entry) => entry.placeId === event.placeId,
      );

      const present: RoomEntryOccupant[] = [];
      const seen = new Set<string>();
      const coPresent = options.coPresence?.({
        siteId: event.siteId,
        placeId: event.placeId,
        kind: event.kind,
      }) ?? [];
      for (const companion of coPresent) {
        if (seen.has(companion.companionId)) continue;
        seen.add(companion.companionId);
        present.push({ displayName: companion.displayName, kind: 'companion' });
      }
      // The event's companion is always present even if the render snapshot
      // has not caught up yet (emit happens during the refresh that builds it).
      if (!seen.has(event.companionId)) {
        present.push({ displayName: event.companionId, kind: 'companion' });
      }

      appendRoomEntryNote(options.sink, {
        roomChannelId,
        ...(place ? { place, affordances: place.affordances } : {}),
        present,
      });
      log.info('Appended companion room-entry note', {
        roomChannelId,
        arrivedCompanionId: event.companionId,
        presentCount: present.length,
      });
    } catch (error) {
      // Loud, never silent: a failed note must not take down the event bus.
      log.error('Failed to append companion room-entry note', {
        placeId: event.placeId,
        companionId: event.companionId,
        error: toErrorMessage(error),
      });
    }
  });
}
