import { registerCompanionRoomEntryNotes } from '../../core/agent/companion-room-entry.js';
import { createCompanionRoomContentWindowPort } from '../../core/agent/companion-room-window.js';
import type {
  CompanionPresenceRuntime,
  CompanionPresenceTurnPort,
} from '../../core/agent/companion-presence-runtime.js';
import { composeRoomContentWindowPorts } from '../../core/session/room-content-window.js';
import type { RoomContentWindowPort } from '../../core/session/room-content-window.js';
import {
  createVoicePresenceWindowPort,
  registerVoicePresenceWindow,
} from '../../core/session/voice-presence-window.js';
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

  // Discord voice channels are Location-scoped (bible §17/§20.5, adjudication
  // 2026-07-19): presence-windowed regardless of multi-companion mode, so this
  // is wired unconditionally — before the `presence`-only companion-room path.
  const voiceWindowPort = createVoicePresenceWindowPort();
  registerVoicePresenceWindow({ eventBus: input.eventBus, port: voiceWindowPort });
  const windowPorts: RoomContentWindowPort[] = [voiceWindowPort];

  if (presence) {
    registerCompanionRoomEntryNotes({
      eventBus: input.eventBus,
      sink: input.sessionManager,
      placesRegistry: input.placesRegistry,
      coPresence: (place) => presence.getCoPresent(place),
    });
    windowPorts.push(createCompanionRoomContentWindowPort({
      placesRegistry: input.placesRegistry,
      presence,
    }));
  }

  input.sessionManager.setRoomContentWindowPort(
    composeRoomContentWindowPorts(windowPorts),
  );
  log.info('Room content window wired', {
    voice: true,
    companionRoom: presence != null,
  });
}
