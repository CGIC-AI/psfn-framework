import type { Scheduler } from '../scheduler/scheduler.js';
import type {
  ConcernCandidateWorker,
  ConcernCandidateWorkerRunResult,
} from './concern-candidates.js';

export const CONCERN_REVIEW_SUPERVISOR_TASK_ID = 'concern-review-supervisor';
const CONCERN_REVIEW_SUPERVISOR_TASK_NAME = 'Deadline-Aware Concern Review';
const CONCERN_REVIEW_SUPERVISOR_SCHEDULE_SOURCE = 'scheduler.json > tickIntervalMs';

export interface ConcernReviewSupervisorWorkerPort {
  retireStaleCandidates(): Promise<number>;
  reviewTemporalPending(): ConcernCandidateWorkerRunResult;
  waitForInFlight(): ReturnType<ConcernCandidateWorker['waitForInFlight']>;
}

export function registerConcernReviewSupervisorTask(input: {
  scheduler: Scheduler;
  worker: ConcernReviewSupervisorWorkerPort;
  intervalMs: number;
}): void {
  input.scheduler.register({
    id: CONCERN_REVIEW_SUPERVISOR_TASK_ID,
    name: CONCERN_REVIEW_SUPERVISOR_TASK_NAME,
    description:
      'Reviews durable time-bound concern candidates before their deadline; '
      + 'the review chooses a disposition and never sends a message itself.',
    scheduleSource: CONCERN_REVIEW_SUPERVISOR_SCHEDULE_SOURCE,
    type: 'every',
    intervalMs: input.intervalMs,
    state: 'idle',
    handler: async () => {
      await input.worker.retireStaleCandidates();
      const started = input.worker.reviewTemporalPending();
      if (started.status === 'started' || started.reason === 'already_running') {
        await input.worker.waitForInFlight();
      }
    },
  });
}
