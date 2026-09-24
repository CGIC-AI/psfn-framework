import { describe, expect, it } from 'vitest';

import {
  buildEffectiveAutomataClassManifest,
  type AutomataRunRecord,
  type EffectiveAutomataClassDescriptor,
} from '../../../faculties/automata/registry-contract.js';
import { loadAutomataPolicySeedDefaults } from '../../../system/config/automata-policy-config.js';
import {
  buildAutomataCoverage,
  selectAutomataCoverageRuns,
  selectAutomataHandoffProbeRunIds,
  type AdminAutomataClassActivityRead,
} from './automata-coverage.js';

const policy = loadAutomataPolicySeedDefaults();
const HEALTH = { activityWindowMs: 1_000, emptyRunThreshold: 3 };
const WINDOW_START_MS = 10_000;

function run(overrides: Partial<AutomataRunRecord> & Pick<AutomataRunRecord, 'runId'>): AutomataRunRecord {
  return {
    companionId: 'companion-a',
    automatonClass: 'subagent.bounded',
    workerId: 'worker',
    workerGeneration: 1,
    taskId: 'task',
    taskLabel: 'label',
    taskSummary: 'private task summary',
    sessionIds: [],
    artifacts: [],
    status: 'completed',
    statusReason: 'automata_run_completed',
    outcome: 'completed',
    promotionState: 'not_requested',
    foldState: 'not_required',
    createdAtMs: WINDOW_START_MS + 1,
    finishedAtMs: WINDOW_START_MS + 2,
    retentionDeadlineMs: WINDOW_START_MS + 100_000,
    ...overrides,
  };
}

function activity(
  classes: AdminAutomataClassActivityRead['classes'],
  handoffRunIds: readonly string[] = [],
): AdminAutomataClassActivityRead {
  return {
    companionId: 'companion-a',
    windowStart: new Date(WINDOW_START_MS).toISOString(),
    classes,
    handoffRunIds,
  };
}

function viewOf(coverage: ReturnType<typeof buildAutomataCoverage>, id: string) {
  const view = coverage.classes.find(entry => entry.automatonClass === id);
  if (!view) throw new Error(`missing coverage view ${id}`);
  return view;
}

describe('Automata Bus coverage projection', () => {
  const classes = buildEffectiveAutomataClassManifest(policy);

  it('reports every eligible production class as wired and every excluded class as excluded', () => {
    const coverage = buildAutomataCoverage({
      classes,
      runs: [],
      activity: activity([]),
      policy: HEALTH,
      windowStartMs: WINDOW_START_MS,
    });
    expect(coverage.eligibleCount).toBe(policy.bus.eligibleClasses.length);
    expect(coverage.wiredCount).toBe(coverage.eligibleCount);
    expect(viewOf(coverage, 'memory.retrieval')).toMatchObject({ health: 'excluded', wired: false });
    expect(viewOf(coverage, 'memory.extraction')).toMatchObject({ busMode: 'bounded_loop', exclusion: null });
    expect(viewOf(coverage, 'scheduler.free_time')).toMatchObject({
      busMode: 'single_pass',
      exclusion: 'companion_identity_turn',
      health: 'idle',
    });
    expect(coverage.degradationReasons).toEqual([]);
  });

  it('degrades an eligible class that has no governed adapter', () => {
    const unwired: EffectiveAutomataClassDescriptor = {
      ...classes.find(entry => entry.id === 'subagent.bounded')!,
      id: 'test.unwired_worker',
    };
    const coverage = buildAutomataCoverage({
      classes: [...classes, unwired],
      runs: [],
      activity: activity([]),
      policy: HEALTH,
      windowStartMs: WINDOW_START_MS,
    });
    expect(viewOf(coverage, 'test.unwired_worker')).toMatchObject({
      wired: false,
      health: 'degraded',
      degradationReasons: ['unwired'],
    });
    expect(coverage.wiredCount).toBe(coverage.eligibleCount - 1);
    expect(coverage.degradationReasons).toEqual(['unwired']);
  });

  it('degrades a class whose recent terminal handoffs left nothing useful', () => {
    const coverage = buildAutomataCoverage({
      classes,
      runs: [],
      activity: activity([
        {
          automatonClass: 'memory.extraction',
          usefulHandoffs: 4,
          noFindingHandoffs: 3,
          workerFindings: 2,
          lastUsefulAt: '2026-09-01T00:00:00.000Z',
          emptyStreak: 3,
        },
        {
          automatonClass: 'subagent.bounded',
          usefulHandoffs: 1,
          noFindingHandoffs: 2,
          workerFindings: 1,
          lastUsefulAt: '2026-09-02T00:00:00.000Z',
          emptyStreak: 2,
        },
      ]),
      policy: HEALTH,
      windowStartMs: WINDOW_START_MS,
    });
    expect(viewOf(coverage, 'memory.extraction')).toMatchObject({
      health: 'degraded',
      degradationReasons: ['empty_useful_streak'],
      handoffs: { usefulHandoffs: 4, emptyStreak: 3, lastUsefulAt: '2026-09-01T00:00:00.000Z' },
    });
    // Below the owner threshold stays healthy.
    expect(viewOf(coverage, 'subagent.bounded')).toMatchObject({ health: 'healthy', degradationReasons: [] });
    expect(coverage.degradationReasons).toEqual(['empty_useful_streak']);
  });

  it('counts registry-terminal runs with no Bus terminal handoff as terminalization gaps', () => {
    const runs = [
      run({ runId: 'run-ok' }),
      run({ runId: 'run-orphan', status: 'failed', statusReason: 'automata_run_orphaned', outcome: 'blocked' }),
      run({ runId: 'run-live', status: 'running', outcome: undefined, finishedAtMs: undefined }),
    ];
    const probe = selectAutomataHandoffProbeRunIds(runs);
    expect(probe).toEqual(['run-ok', 'run-orphan']);
    const coverage = buildAutomataCoverage({
      classes,
      runs,
      activity: activity([], ['run-ok']),
      policy: HEALTH,
      windowStartMs: WINDOW_START_MS,
    });
    expect(viewOf(coverage, 'subagent.bounded')).toMatchObject({
      runs: { total: 3, active: 1, completed: 1, failed: 1, cancelled: 0 },
      outcomes: { completed: 1, blocked: 1 },
      failureReasons: { automata_run_orphaned: 1 },
      terminalizationGaps: 1,
      health: 'degraded',
      degradationReasons: ['terminalization_gap'],
    });
    expect(JSON.stringify(coverage)).not.toContain('private task summary');
  });

  it('never infers health when the Bus aggregate is unavailable', () => {
    const coverage = buildAutomataCoverage({
      classes,
      runs: [run({ runId: 'run-1' })],
      activity: null,
      policy: HEALTH,
      windowStartMs: WINDOW_START_MS,
    });
    expect(coverage.available).toBe(false);
    expect(viewOf(coverage, 'subagent.bounded')).toMatchObject({
      handoffs: null,
      terminalizationGaps: null,
      health: 'unknown',
    });
    expect(coverage.degradationReasons).toEqual([]);
  });

  it('keeps only runs inside the owner window, plus every still-active run', () => {
    const runs = [
      run({ runId: 'old', finishedAtMs: WINDOW_START_MS - 1 }),
      run({ runId: 'new' }),
      run({ runId: 'stuck', status: 'running', createdAtMs: 1, finishedAtMs: undefined }),
    ];
    expect(selectAutomataCoverageRuns(runs, WINDOW_START_MS).map(entry => entry.runId))
      .toEqual(['new', 'stuck']);
  });
});
