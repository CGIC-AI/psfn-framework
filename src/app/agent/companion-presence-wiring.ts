import { registerCompanionRoomEntryNotes } from '../../core/agent/companion-room-entry.js';
import { createCompanionRoomContentWindowPort } from '../../core/agent/companion-room-window.js';
import type {
  CompanionPresenceRuntime,
  CompanionPresenceTurnPort,
} from '../../core/agent/companion-presence-runtime.js';
import { createComponentLogger } from '../../shared/logger.js';

const log = createComponentLogger('CompanionPresenceWiring');

type RoomEntryOptions = Parameters<typeof registerCompanionRoomEntryNotes>[0];
type RoomWindowOptions = Parameters<typeof createCompanionRoomContentWindowPort>[0];

export interface CompanionPresenceWiringInput {
  agentLoop: { companionPresence: CompanionPresenceTurnPort | null };
  presenceRuntime: CompanionPresenceRuntime | null;
  eventBus: RoomEntryOptions['eventBus'];
  sessionManager: RoomEntryOptions['sink'] & {
    setRoomContentWindowPort(
      port: ReturnType<typeof createCompanionRoomContentWindowPort>,
    ): void;
  };
  placesRegistry: RoomWindowOptions['placesRegistry'];
}

/**
 * Attach presence to turn context and room sessions without adding an
 * auto-greeting or any other triggered-turn path.
 */
export function wireCompanionPresenceContext(input: CompanionPresenceWiringInput): void {
  input.agentLoop.companionPresence = input.presenceRuntime;
  const presence = input.presenceRuntime;
  if (!presence) return;

  registerCompanionRoomEntryNotes({
    eventBus: input.eventBus,
    sink: input.sessionManager,
    placesRegistry: input.placesRegistry,
    coPresence: (place) => presence.getCoPresent(place),
  });
  input.sessionManager.setRoomContentWindowPort(createCompanionRoomContentWindowPort({
    placesRegistry: input.placesRegistry,
    presence,
  }));
  log.info('Companion room-entry notes and content window wired to presence');
}
