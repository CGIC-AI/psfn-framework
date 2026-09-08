// ── Stuck automata run / scheduler task detector (bead psfn-framework-7qeo1.24.4) ──
//
// Every other failure in this plane announces itself: a job fails, a task
// throws, a pool queues. A stuck job announces nothing at all — it started, and
// then simply never finished. Nothing in the runtime notices, because there is
// no event to notice.
//
// So this detector is the one that reads STATE rather than the stream. Each
// cycle it asks the run registry and the scheduler what they currently hold and
// compares elapsed time against an owner-file budget:
//
//   * an automata run in a non-terminal status (`queued` or `running`) whose
//     age exceeds `automataRunBudgetMs`;
//   * a scheduler task in `active` — inside its handler — whose current attempt
//     exceeds `schedulerTaskBudgetMs`.
//
// A long job that is still inside its budget is silent, which is the point: the
// budget is the definition of "too long", and it belongs to the operator.
//
// Recovery needs no separate rule. When the run reaches a terminal status,
// leaves the retained window, or the task returns to idle, it stops appearing
// here, the condition stops being true, and the cycle closes the episode. A run
// that completes LATE therefore closes its own incident, which is exactly the
// behavior bead .4 asks for.
//
// Both inputs are narrow structural ports rather than the concrete registry and
// `Scheduler`. The run-lifecycle owner can reshape its record freely as long as
// the wiring site still projects these four fields, and a test needs no
// registry at all.

import { hashHealthEventSubject } from '../../contracts/health-event.js';
import type { StuckJobDetectorConfig } from '../../../system/config/scheduler-config/health-detectors.js';
import type {
  HealthDetector,
  HealthDetectorCondition,
  HealthDetectorInput,
  HealthDetectorResult,
} from './contracts.js';

/**
 * The part of an automata run this detector reads. Projected at the wiring
 * site from the registry's public runtime read API.
 */
export interface StuckJobRunView {
  runId: string;
  status: string;
  createdAtMs: number;
  startedAtMs?: number;
}

/** The part of a scheduler task this detector reads. */
export interface StuckJobTaskView {
  id: string;
  state: string;
  lastRunAt?: number;
}

/**
 * Statuses that are still going somewhere. Anything else is terminal and its
 * elapsed time no longer accumulates, so it can never be stuck.
 */
const NON_TERMINAL_RUN_STATUSES: readonly string[] = ['queued', 'running'];

export interface StuckJobDetectorOptions {
  config: StuckJobDetectorConfig;
  /** Absent when the process runs no automata (the gateway). */
  listRuns?: () => readonly StuckJobRunView[];
  /** Absent when the process exposes no scheduler task state. */
  listTasks?: () => readonly StuckJobTaskView[];
  /**
   * Task ids never reported as stuck. The detector cycle runs AS a scheduler
   * task, so its own task is `active` for the entire evaluation and would
   * otherwise report itself the moment its budget was exceeded.
   */
  ignoreTaskIds?: readonly string[];
}

export function createStuckJobDetector(options: StuckJobDetectorOptions): HealthDetector {
  const ignoredTaskIds = new Set(options.ignoreTaskIds ?? []);

  return {
    id: 'stuck-runtime-jobs',
    family: 'stuck_runtime_job',
    async detect(input: HealthDetectorInput): Promise<HealthDetectorResult> {
      const conditions: HealthDetectorCondition[] = [];

      for (const run of options.listRuns?.() ?? []) {
        if (!NON_TERMINAL_RUN_STATUSES.includes(run.status)) continue;
        // A queued run has no start time yet; its wait is still elapsed time an
        // operator cares about, so it is measured from registration.
        const startedAtMs = run.startedAtMs ?? run.createdAtMs;
        const elapsedMs = input.nowMs - startedAtMs;
        if (elapsedMs <= options.config.automataRunBudgetMs) continue;
        conditions.push({
          subjectHash: hashHealthEventSubject(`automata_run:${run.runId}`),
          component: 'automata',
          severity: 'degraded',
          startedAtMs,
          evidence: { elapsedMs, jobAgeMs: input.nowMs - run.createdAtMs },
        });
      }

      for (const task of options.listTasks?.() ?? []) {
        if (task.state !== 'active') continue;
        if (ignoredTaskIds.has(task.id)) continue;
        // `lastRunAt` is stamped as the handler is entered. Without one the task
        // has no measurable attempt, and guessing an age would invent a fault.
        if (task.lastRunAt === undefined) continue;
        const elapsedMs = input.nowMs - task.lastRunAt;
        if (elapsedMs <= options.config.schedulerTaskBudgetMs) continue;
        conditions.push({
          subjectHash: hashHealthEventSubject(`scheduler_task:${task.id}`),
          component: 'scheduler',
          severity: 'degraded',
          startedAtMs: task.lastRunAt,
          evidence: { elapsedMs },
        });
      }

      // No samples: a stuck job leaves no trace of its own, which is why this
      // detector reads live state instead of counting stream observations.
      return { samples: [], conditions };
    },
  };
}
