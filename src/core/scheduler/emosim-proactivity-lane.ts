import type { ObserverEvalSidecarRuntime } from '../eval/observer-sidecar/types.js';
import { EMOSIM_MIN_READ_CADENCE_MS } from '../eval/observer-sidecar/emosim-server-adapter.js';
import type { Scheduler } from './scheduler.js';

export function registerEmoSimProactivitySampling(
  scheduler: Pick<Scheduler, 'getTask' | 'register'>,
  runtime: ObserverEvalSidecarRuntime,
): void {
  const sampling = runtime.proactivitySampling;
  const taskId = 'emotion.emosim-live-state';
  if (!sampling || scheduler.getTask(taskId)) return;
  scheduler.register({
    id: taskId,
    name: 'EmoSim live-state observation',
    description: 'Read fresh emotional-source state and offer qualifying impulses to the companion choice funnel.',
    scheduleSource: 'settings.json emosimProactivity.thresholdProfile.samplingIntervalMs',
    type: 'every',
    intervalMs: Math.max(EMOSIM_MIN_READ_CADENCE_MS, sampling.intervalMs),
    state: 'idle',
    // Source observation has no send authority. Choice and every outbound
    // eligibility/quiet-hours gate remain in the existing disposition funnel.
    handler: () => sampling.sample(),
  });
}
