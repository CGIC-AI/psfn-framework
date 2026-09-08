import { describe, expect, it } from 'vitest';
import {
  hashHealthEventSubject,
  validateHealthEvent,
  type HealthEvent,
  type HealthEventPublisher,
  type HealthEventSource,
} from '../../contracts/health-event.js';
import { DEFAULT_HEALTH_DETECTORS_CONFIG } from '../../../system/config/scheduler-config/health-detectors.js';
import { createHealthDetectorCycle } from './cycle.js';
import {
  createStuckJobDetector,
  type StuckJobRunView,
  type StuckJobTaskView,
} from './stuck-jobs.js';

const NOW_MS = 1_800_000_000_000;
const MINUTE_MS = 60_000;
const BUDGET = DEFAULT_HEALTH_DETECTORS_CONFIG.stuckJobs;
const SOURCE: HealthEventSource = { owner: { kind: 'system' }, process: 'agent' };

function harness(state: {
  runs?: StuckJobRunView[];
  tasks?: StuckJobTaskView[];
  ignoreTaskIds?: readonly string[];
}): { runAt: (nowMs: number) => Promise<void>; events: HealthEvent[] } {
  const events: HealthEvent[] = [];
  const publisher: HealthEventPublisher = {
    async emit(_name, data) {
      events.push(validateHealthEvent(data.event));
    },
  };
  let clock = NOW_MS;
  const cycle = createHealthDetectorCycle({
    detectors: [createStuckJobDetector({
      config: BUDGET,
      listRuns: () => state.runs ?? [],
      listTasks: () => state.tasks ?? [],
      ...(state.ignoreTaskIds ? { ignoreTaskIds: state.ignoreTaskIds } : {}),
    })],
    stream: {
      async listRecent(query = {}) {
        const sinceMs = query.sinceMs ?? 0;
        return events
          .filter(event => event.recordedAtMs >= sinceMs)
          .sort((left, right) => right.recordedAtMs - left.recordedAtMs)
          .slice(0, query.limit ?? events.length);
      },
    },
    publisher,
    source: SOURCE,
    policy: {
      incidentWindowMs: DEFAULT_HEALTH_DETECTORS_CONFIG.incidentWindowMs,
      cooldownMs: DEFAULT_HEALTH_DETECTORS_CONFIG.cooldownMs,
      incidentScanLimit: DEFAULT_HEALTH_DETECTORS_CONFIG.incidentScanLimit,
    },
    now: () => clock,
  });
  return {
    events,
    async runAt(nowMs) {
      clock = nowMs;
      await cycle.run();
    },
  };
}

describe('stuck automata run and scheduler task detector', () => {
  it('stays silent for a long run that is still inside its budget', async () => {
    const detector = harness({
      runs: [{ runId: 'run-slow', status: 'running', createdAtMs: NOW_MS, startedAtMs: NOW_MS }],
    });
    // Exactly at the budget is still within it: the incident needs the budget
    // to be exceeded, so an operator's number means what it says.
    await detector.runAt(NOW_MS + BUDGET.automataRunBudgetMs);
    expect(detector.events).toEqual([]);
  });

  it('stays silent for a long scheduler task that is still inside its budget', async () => {
    const detector = harness({
      tasks: [{ id: 'nightly-consolidation', state: 'active', lastRunAt: NOW_MS }],
    });
    await detector.runAt(NOW_MS + BUDGET.schedulerTaskBudgetMs);
    expect(detector.events).toEqual([]);
  });

  it('opens exactly one incident per stuck run carrying its digest and elapsed time', async () => {
    const state = {
      runs: [{
        runId: 'run-wedged',
        status: 'running',
        createdAtMs: NOW_MS - MINUTE_MS,
        startedAtMs: NOW_MS,
      }],
    };
    const detector = harness(state);
    for (let step = 1; step <= 20; step += 1) {
      await detector.runAt(NOW_MS + BUDGET.automataRunBudgetMs + step * MINUTE_MS);
    }
    const opened = detector.events.filter(event => event.code === 'stuck_runtime_job_opened');
    expect(opened.length).toBeGreaterThan(0);
    expect(new Set(opened.map(event => event.correlationId)).size).toBe(1);

    const first = opened[0]!;
    expect(first.provenance.component).toBe('automata');
    // The run is identified only by a digest; the run id never reaches the stream.
    expect(first.provenance.subjectHash).toBe(hashHealthEventSubject('automata_run:run-wedged'));
    expect(JSON.stringify(first)).not.toContain('run-wedged');
    expect(first.evidence.elapsedMs).toBe(BUDGET.automataRunBudgetMs + MINUTE_MS);
    expect(first.evidence.jobAgeMs).toBe(BUDGET.automataRunBudgetMs + 2 * MINUTE_MS);
    expect(first.firstObservedAtMs).toBe(NOW_MS);
  });

  it('closes the episode when the run completes late', async () => {
    const state: { runs: StuckJobRunView[] } = {
      runs: [{ runId: 'run-late', status: 'running', createdAtMs: NOW_MS, startedAtMs: NOW_MS }],
    };
    const detector = harness(state);
    await detector.runAt(NOW_MS + BUDGET.automataRunBudgetMs + MINUTE_MS);
    state.runs[0]!.status = 'completed';
    await detector.runAt(NOW_MS + BUDGET.automataRunBudgetMs + 2 * MINUTE_MS);
    await detector.runAt(NOW_MS + BUDGET.automataRunBudgetMs + 3 * MINUTE_MS);

    const closed = detector.events.filter(event => event.code === 'stuck_runtime_job_closed');
    expect(closed).toHaveLength(1);
    const opened = detector.events.filter(event => event.code === 'stuck_runtime_job_opened');
    expect(closed[0]!.correlationId).toBe(opened[0]!.correlationId);
    expect(closed[0]!.evidence.durationMs).toBe(BUDGET.automataRunBudgetMs + 2 * MINUTE_MS);
  });

  it('closes the episode when a purged run leaves the retained view', async () => {
    const state: { runs: StuckJobRunView[] } = {
      runs: [{ runId: 'run-purged', status: 'running', createdAtMs: NOW_MS, startedAtMs: NOW_MS }],
    };
    const detector = harness(state);
    await detector.runAt(NOW_MS + BUDGET.automataRunBudgetMs + MINUTE_MS);
    state.runs.length = 0;
    await detector.runAt(NOW_MS + BUDGET.automataRunBudgetMs + 2 * MINUTE_MS);
    expect(detector.events.filter(event => event.code === 'stuck_runtime_job_closed'))
      .toHaveLength(1);
  });

  it('reports a wedged scheduler task but never the detector task itself', async () => {
    const detector = harness({
      tasks: [
        { id: 'runtime-health-detectors', state: 'active', lastRunAt: NOW_MS },
        { id: 'background-work-supervisor', state: 'active', lastRunAt: NOW_MS },
        { id: 'idle-task', state: 'idle', lastRunAt: NOW_MS },
        { id: 'never-run', state: 'active' },
      ],
      ignoreTaskIds: ['runtime-health-detectors'],
    });
    await detector.runAt(NOW_MS + BUDGET.schedulerTaskBudgetMs + MINUTE_MS);
    const opened = detector.events.filter(event => event.code === 'stuck_runtime_job_opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]!.provenance.component).toBe('scheduler');
    expect(opened[0]!.provenance.subjectHash)
      .toBe(hashHealthEventSubject('scheduler_task:background-work-supervisor'));
  });

  it('keeps two stuck jobs as two independent incidents', async () => {
    const detector = harness({
      runs: [
        { runId: 'run-a', status: 'running', createdAtMs: NOW_MS, startedAtMs: NOW_MS },
        { runId: 'run-b', status: 'queued', createdAtMs: NOW_MS },
      ],
    });
    await detector.runAt(NOW_MS + BUDGET.automataRunBudgetMs + MINUTE_MS);
    const opened = detector.events.filter(event => event.code === 'stuck_runtime_job_opened');
    expect(opened).toHaveLength(2);
    expect(new Set(opened.map(event => event.correlationId)).size).toBe(2);
  });
});
