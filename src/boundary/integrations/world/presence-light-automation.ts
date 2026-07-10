import type { PlacesRegistryConfig } from '../../../shared/contracts/places-registry.js';
import type { EventBus } from '../../../shared/event-bus.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { WorldOperations } from './ops.js';

const log = createComponentLogger('PresenceLightAutomation');

export interface PresenceLightAutomationOptions {
  eventBus: EventBus;
  placesRegistry: PlacesRegistryConfig;
  operations: WorldOperations;
  enabled: boolean;
  logger?: Pick<typeof log, 'info' | 'warn'>;
}

/**
 * Deterministic pre-LLM light cue for trusted physical presence transitions.
 * The source event is emitted only after identity resolution and presence-follow
 * debounce; gateway registry validation and autonomous-tier policy still apply.
 */
export function registerPresenceLightAutomation(options: PresenceLightAutomationOptions): () => void {
  if (!options.enabled) return () => undefined;
  const logger = options.logger ?? log;

  async function setRoomLights(placeId: string, command: 'on' | 'off', intent: 'presence_enter' | 'presence_exit'): Promise<void> {
    const place = options.placesRegistry.places.find((entry) => entry.placeId === placeId);
    if (!place || place.kind !== 'physical') return;
    const lights = place.affordances.filter((affordance) => (
      affordance.role === 'effector'
      && affordance.backend === 'ha'
      && affordance.kind === 'light'
      && Boolean(affordance.entityId)
      && (!affordance.control || affordance.control.includes(command))
    ));
    for (const light of lights) {
      const entityId = light.entityId;
      if (!entityId) continue;
      try {
        await options.operations.callService({
          domain: entityId.split('.')[0],
          service: command === 'on' ? 'turn_on' : 'turn_off',
          placeId,
          affordanceId: light.affordanceId,
          entityId,
          intent,
          reason: command === 'on'
            ? `Trusted operator entered ${place.displayName}`
            : `Trusted operator exited ${place.displayName}`,
        });
        logger.info('Applied autonomous presence light cue', { placeId, affordanceId: light.affordanceId, command });
      } catch (error) {
        logger.warn('Autonomous presence light cue failed closed', {
          placeId,
          affordanceId: light.affordanceId,
          command,
          error: toErrorMessage(error),
        });
      }
    }
  }

  return options.eventBus.on('presence.emanation.follow', async (event) => {
    if (event.trigger !== 'physical_presence') return;
    if (event.fromPlaceId) await setRoomLights(event.fromPlaceId, 'off', 'presence_exit');
    await setRoomLights(event.toPlaceId, 'on', 'presence_enter');
  });
}
