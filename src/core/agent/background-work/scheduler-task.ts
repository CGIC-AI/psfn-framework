import type { Scheduler } from '../../scheduler/scheduler.js';

export const BACKGROUND_WORK_SUPERVISOR_TASK_ID = 'background-work-supervisor';

export interface DurableBackgroundWorkAgent {
  hasDurableBackgroundWorkSupervisor(): boolean;
  tickBackgroundWork(): Promise<void>;
}

export function registerDurableBackgroundWorkSupervisorTask(input: {
  agentLoop: DurableBackgroundWorkAgent;
  intervalMs: number;
  scheduler: Scheduler;
}): void {
  if (!input.agentLoop.hasDurableBackgroundWorkSupervisor()) {
    throw new Error('Agent scheduler requires a durable background work supervisor');
  }
  input.scheduler.register({
    id: BACKGROUND_WORK_SUPERVISOR_TASK_ID,
    name: 'Durable Background Work Supervisor',
    type: 'every',
    intervalMs: input.intervalMs,
    availability: 'do_not_disturb',
    handler: () => input.agentLoop.tickBackgroundWork(),
    state: 'idle',
  });
}
