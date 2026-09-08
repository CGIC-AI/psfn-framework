// ── Runtime health-detector scheduler lane (beads psfn-framework-7qeo1.24.2-.4) ──
//
// The detectors are driven by the process's EXISTING scheduler task registry,
// not a lane of their own: one registered task, one owner-file cadence, and the
// same eligibility, failure, and Garden-visibility semantics every other
// scheduled task already has. A detector cycle that throws therefore surfaces as
// `schedule.task.failed` and as a `scheduler_task_failed` health event, exactly
// like any other broken task — the health plane does not get a private,
// unobservable execution path.

import type { Scheduler } from './scheduler.js';
import type { HealthDetectorCycle } from '../../shared/observability/health-detectors/cycle.js';

export const RUNTIME_HEALTH_DETECTOR_TASK_ID = 'runtime-health-detectors';

const RUNTIME_HEALTH_DETECTOR_SCHEDULE_SOURCE =
  'scheduler.json > healthDetectors.intervalMs';

export function registerRuntimeHealthDetectorTask(input: {
  scheduler: Scheduler;
  cycle: HealthDetectorCycle;
  intervalMs: number;
}): void {
  input.scheduler.register({
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
}
