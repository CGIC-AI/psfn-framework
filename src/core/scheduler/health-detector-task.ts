// ── Runtime health-detector scheduler lane (beads psfn-framework-7qeo1.24.2-.4) ──
//
// The detectors use a dedicated instance of the existing scheduler, so a stuck
// work task cannot prevent its own overrun from being observed. The owner-file
// cadence, failure events, and task-state projection stay shared. A cycle that
// throws surfaces as
// `schedule.task.failed` and as a `scheduler_task_failed` health event, exactly
// like any other broken task — the health plane does not get a private,
// unobservable execution path.

import { Scheduler } from './scheduler.js';
import type { HealthDetectorCycle } from '../../shared/observability/health-detectors/cycle.js';
import type { HealthEventSource } from '../../shared/contracts/health-event.js';
import type { EventBus } from '../../shared/event-bus.js';

const RUNTIME_HEALTH_DETECTOR_TASK_ID = 'runtime-health-detectors';

const RUNTIME_HEALTH_DETECTOR_SCHEDULE_SOURCE =
  'scheduler.json > healthDetectors.intervalMs';

export function createRuntimeHealthDetectorScheduler(input: {
  eventBus: EventBus;
  source: HealthEventSource;
  cycle: HealthDetectorCycle;
  intervalMs: number;
}): Scheduler {
  const scheduler = new Scheduler(input.eventBus, {
    tickIntervalMs: input.intervalMs,
    heartbeatIntervalMs: input.intervalMs,
  }, { healthEventSource: input.source });
  scheduler.register({
    id: RUNTIME_HEALTH_DETECTOR_TASK_ID,
    name: 'Runtime Health Detectors',
    description:
      'Samples live runtime pressure, rebuilds open incidents from the persisted health '
      + 'stream, and emits one correlated incident per episode with an explicit close on '
      + 'recovery. A healthy runtime emits nothing.',
    scheduleSource: RUNTIME_HEALTH_DETECTOR_SCHEDULE_SOURCE,
    type: 'every',
    intervalMs: input.intervalMs,
    state: 'idle',
    handler: () => input.cycle.run(),
    // Skips the registration-time run: at startup the stream has not yet been
    // written by this boot, and a first cycle before the process finished
    // wiring its pools would sample an authority set that is still forming.
  }, { skipFirstRun: true });
  return scheduler;
}
