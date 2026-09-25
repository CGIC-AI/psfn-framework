import {
  type FleetMaintenanceCoordinator,
} from '../../../core/scheduler/fleet-maintenance-coordinator.js';
import { RUNTIME_LANE_CLASSES } from '../../../shared/contracts/runtime-lanes.js';
import type { EventBus } from '../../../shared/event-bus.js';

/**
 * Foreground work never acquires or waits for the maintenance baton. At turn
 * start it asks the current holder to yield: a baton this instance holds is
 * marked in memory, one held by another instance through the shared row on
 * its own connection lane. The heavy runner observes the request at its next
 * fenced checkpoint boundary. The signal is best-effort and never delays the
 * turn (psfn-framework-jrki1).
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
