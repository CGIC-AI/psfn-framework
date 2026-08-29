import {
  type FleetMaintenanceCoordinator,
} from '../../../core/scheduler/fleet-maintenance-coordinator.js';
import { RUNTIME_LANE_CLASSES } from '../../../shared/contracts/runtime-lanes.js';
import type { EventBus } from '../../../shared/event-bus.js';

/**
 * Foreground work never acquires or waits for the maintenance baton. Its turn
 * start only marks a held local baton for cooperative yield; the heavy runner
 * observes that request on its next fenced checkpoint boundary.
 */
export function wireFleetMaintenanceForegroundPreemption(input: {
  eventBus: EventBus;
  coordinator: Pick<FleetMaintenanceCoordinator, 'requestForegroundPreemption'>;
  now?: () => number;
  onError?: (error: unknown) => void;
}): () => void {
  const now = input.now ?? Date.now;
  return input.eventBus.on('agent.turn.start', async payload => {
    if (payload.runtimeLaneClass !== RUNTIME_LANE_CLASSES.foregroundChat) return;
    try {
      await input.coordinator.requestForegroundPreemption({ nowMs: now() });
    } catch (error) {
      if (!input.onError) throw error;
      input.onError(error);
    }
  });
}
