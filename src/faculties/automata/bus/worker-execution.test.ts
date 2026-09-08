import { describe, expect, it, vi } from 'vitest';

import { loadAutomataPolicySeedDefaults } from '../../../system/config/automata-policy-config.js';
import type { ProductionAutomataClassId } from '../registry-contract.js';
import {
  buildAutomataTerminalHandoffKey,
  type AutomataTerminalLifecyclePort,
  type RecordAutomataTerminalHandoffInput,
} from '../terminal-lifecycle.js';
import {
  AUTOMATA_BUS_WORKER_BRIEFING_SCHEMA_VERSION,
  type AutomataBusWorkerAccess,
  type AutomataBusWorkerBounds,
  type AutomataBusWorkerPort,
} from './worker-access.js';
import {
  AUTOMATA_WORKER_DEGRADE_POLICY,
  AUTOMATA_WORKER_LIFECYCLE_STAGES,
  openAutomataBusWorkerRun,
  type AutomataWorkerFailurePolicy,
  type AutomataWorkerLifecycleEvent,
  type AutomataWorkerOutcome,
  type AutomataWorkerRunBinding,
  type AutomataWorkerRunPort,
  type AutomataWorkerTerminalRequest,
} from './worker-execution.js';

const BOUNDS: AutomataBusWorkerBounds = {
  maxQueryChars: 120,
  maxTextChars: 240,
  maxArrayItems: 8,
  maxSearchResults: 10,
  maxRunResults: 20,
  maxBriefingChars: 400,
  maxBriefingItems: 4,
  maxToolResultChars: 2_000,
};

const COMPANION_ID = 'companion-public-example';

function briefing(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: AUTOMATA_BUS_WORKER_BRIEFING_SCHEMA_VERSION,
    text: 'Automata Bus briefing',
    itemCount: 1,
    diagnostics: {
      cache: 'miss',
      semanticPath: 'exact-fallback',
      indexState: 'ready',
      reindexState: 'current',
      modelIdentity: null,
      indexingLag: { pendingCount: 0 },
    },
    ...overrides,
  };
}

function createAccess(overrides: Partial<AutomataBusWorkerPort> = {}): AutomataBusWorkerAccess {
  const ok = async (): Promise<unknown> => ({ ok: true });
  return {
    bounds: BOUNDS,
    identity: {
      companionId: COMPANION_ID,
      audience: 'eligible-automata',
      maxSensitivity: 'personal',
    },
    port: {
      isClassEligible: () => true,
      brief: vi.fn(async () => briefing()),
      search: vi.fn(ok),
      append: vi.fn(ok),
      correct: vi.fn(ok),
      handoff: vi.fn(ok),
      runs: vi.fn(ok),
      inspect: vi.fn(ok),
      ...overrides,
    },
  };
}

interface RunPortHarness {
  port: AutomataWorkerRunPort;
  terminals: AutomataWorkerTerminalRequest[];
}

function createRunPort(input: {
  automatonClass: ProductionAutomataClassId;
  runId: string;
  taskId: string;
  attempt?: number;
  execute?: boolean;
  terminalizeError?: Error;
}): RunPortHarness {
  const terminals: AutomataWorkerTerminalRequest[] = [];
  const binding: AutomataWorkerRunBinding = {
    companionId: COMPANION_ID,
    lineage: {
      automatonClass: input.automatonClass,
      runId: input.runId,
      taskId: input.taskId,
      workerId: `${input.automatonClass}:worker`,
      sessionIds: [`session:${input.runId}`],
    },
    attempt: input.attempt ?? 1,
    execute: input.execute ?? true,
  };
  return {
    terminals,
    port: {
      begin: async () => binding,
      terminalize: async request => {
        if (input.terminalizeError) throw input.terminalizeError;
        terminals.push(request);
      },
    },
  };
}

interface TerminalHarness {
  port: AutomataTerminalLifecyclePort;
  recorded: RecordAutomataTerminalHandoffInput[];
}

function createTerminalPort(options: { fail?: Error; inserted?: boolean } = {}): TerminalHarness {
  const recorded: RecordAutomataTerminalHandoffInput[] = [];
  return {
    recorded,
    port: {
      recordTerminalHandoff: async input => {
        if (options.fail) throw options.fail;
        recorded.push(input);
        return {
          handoffRef: `automata-bus-terminal:${input.idempotencyKey}`,
          inserted: options.inserted ?? true,
          findingRefs: [`automata-bus-terminal:${input.idempotencyKey}`],
          evidenceRefs: [`automata-run:${input.lineage.runId}`],
          artifactRefs: [],
        };
      },
      inspectRun: async lineage => ({
        runId: lineage.runId,
        taskId: lineage.taskId,
        sessionIds: [...lineage.sessionIds],
        findingRefs: [],
        evidenceRefs: [],
        artifactRefs: [],
        handoffRefs: [],
      }),
    },
  };
}

function completedOutcome(overrides: Partial<AutomataWorkerOutcome> = {}): AutomataWorkerOutcome {
  return {
    lifecycleState: 'completed',
    outcome: 'completed',
    stateReason: 'completed',
    resultKind: 'final',
    atMs: 1_700_000_000_000,
    ...overrides,
  };
}

function stageTrace(events: readonly AutomataWorkerLifecycleEvent[]): string[] {
  return events.map(event => `${event.stage}:${event.status}`);
}

/**
 * Drive one class end to end through the governed lifecycle. Both production
 * classes reach the Bus only through this same sequence of calls.
 */
async function runClass(input: {
  automatonClass: ProductionAutomataClassId;
  runId: string;
  access?: AutomataBusWorkerAccess;
  policy?: AutomataWorkerFailurePolicy;
  callBusWrite?: boolean;
  outcome?: Partial<AutomataWorkerOutcome>;
  execute?: boolean;
  attempt?: number;
  terminalOptions?: { fail?: Error; inserted?: boolean };
  terminalizeError?: Error;
}) {
  const events: AutomataWorkerLifecycleEvent[] = [];
  const run = createRunPort({
    automatonClass: input.automatonClass,
    runId: input.runId,
    taskId: `task:${input.runId}`,
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    ...(input.execute === undefined ? {} : { execute: input.execute }),
    ...(input.terminalizeError ? { terminalizeError: input.terminalizeError } : {}),
  });
  const terminal = createTerminalPort(input.terminalOptions ?? {});
  const session = await openAutomataBusWorkerRun({
    access: input.access ?? createAccess(),
    run: run.port,
    terminal: terminal.port,
    briefingQuery: `bounded work for ${input.automatonClass}`,
    ...(input.policy ? { policy: input.policy } : {}),
    telemetry: event => events.push(event),
  });
  if (input.callBusWrite) {
    await session.tool!.execute('call-1', {
      action: 'append',
      claim: 'A reusable process lesson.',
      provenance: 'computed',
      evidence: [{ kind: 'artifact', reference: 'artifact-1', summary: 'evidence' }],
      artifact_refs: [],
      verification_status: 'pending',
    }, undefined);
  }
  const settlement = await session.settle(completedOutcome(input.outcome ?? {}));
  return { events, session, settlement, run, terminal };
}

describe('governed Automata Bus worker lifecycle', () => {
  const eligibleClasses = loadAutomataPolicySeedDefaults().bus.eligibleClasses;

  it.each(eligibleClasses)(
    'runs %s through the identical begin/brief/tool/handoff/terminal order',
    async (automatonClass) => {
      const governed = await runClass({
        automatonClass,
        runId: `conformance-${automatonClass}`,
        // One class-authored summary stands in for every class's process line,
        // so the assertion is about ordering, not about what a class reports.
        outcome: { summary: `${automatonClass} process result` },
      });

      // The expected order is the exported stage contract itself, not a copy.
      expect(stageTrace(governed.events))
        .toEqual(AUTOMATA_WORKER_LIFECYCLE_STAGES.map(stage => `${stage}:ok`));
      expect(governed.terminal.recorded).toHaveLength(1);
      expect(governed.run.terminals).toHaveLength(1);
      // Every class binds its own authoritative identity, never another's.
      expect(governed.terminal.recorded[0]?.lineage.automatonClass).toBe(automatonClass);
      expect(governed.settlement.handoffKind).toBe('useful');
    },
  );

  it.each(eligibleClasses)(
    'records a typed no-finding terminal for %s when nothing reports a finding',
    async (automatonClass) => {
      const silent = await runClass({
        automatonClass,
        runId: `conformance-silent-${automatonClass}`,
      });
      expect(silent.session.observedBusWrites).toBe(0);
      expect(silent.settlement.handoffKind).toBe('no_finding');
      expect(silent.terminal.recorded[0]?.handoffKind).toBe('no_finding');
      // Never silent: the deterministic terminal event is still recorded.
      expect(stageTrace(silent.events)).toContain('handoff:ok');
    },
  );

  it.each(eligibleClasses)(
    'never duplicates %s terminal effects however many times a retried caller settles',
    async (automatonClass) => {
      const run = createRunPort({
        automatonClass,
        runId: `conformance-retry-${automatonClass}`,
        taskId: `task-${automatonClass}`,
      });
      const terminal = createTerminalPort();
      const session = await openAutomataBusWorkerRun({
        access: createAccess(),
        run: run.port,
        terminal: terminal.port,
        briefingQuery: `bounded work for ${automatonClass}`,
      });
      const first = await session.settle(completedOutcome());
      expect(await session.settle(completedOutcome({ stateReason: 'different' }))).toBe(first);
      expect(terminal.recorded).toHaveLength(1);
      expect(run.terminals).toHaveLength(1);
    },
  );

  it('records a typed no-finding terminal when the model never calls the Bus tool', async () => {
    const silent = await runClass({ automatonClass: 'subagent.bounded', runId: 'subagent-2' });
    expect(silent.session.observedBusWrites).toBe(0);
    expect(silent.settlement.handoffKind).toBe('no_finding');
    expect(silent.terminal.recorded[0]?.handoffKind).toBe('no_finding');
    // Never silent: the deterministic terminal event is still recorded.
    expect(stageTrace(silent.events)).toContain('handoff:ok');

    const wrote = await runClass({
      automatonClass: 'subagent.bounded',
      runId: 'subagent-3',
      callBusWrite: true,
    });
    expect(wrote.session.observedBusWrites).toBe(1);
    expect(wrote.settlement.handoffKind).toBe('useful');

    // A rejected write is not a finding.
    const rejected = await runClass({
      automatonClass: 'subagent.bounded',
      runId: 'subagent-4',
      access: createAccess({ append: vi.fn(async () => { throw new Error('append rejected'); }) }),
      callBusWrite: true,
    });
    expect(rejected.session.observedBusWrites).toBe(0);
    expect(rejected.settlement.handoffKind).toBe('no_finding');
  });

  it('binds the terminal idempotency key to class, run, and attempt', async () => {
    const first = await runClass({ automatonClass: 'subagent.bounded', runId: 'run-shared' });
    const otherClass = await runClass({ automatonClass: 'memory.extraction', runId: 'run-shared' });
    const retry = await runClass({
      automatonClass: 'subagent.bounded',
      runId: 'run-shared',
      attempt: 2,
    });
    const keys = [first, otherClass, retry].map(entry => entry.terminal.recorded[0]?.idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toBe(buildAutomataTerminalHandoffKey({
      automatonClass: 'subagent.bounded',
      runId: 'run-shared',
      attempt: 1,
    }));
  });

  it('settles exactly once however many times a retried caller asks', async () => {
    const run = createRunPort({
      automatonClass: 'subagent.bounded',
      runId: 'subagent-5',
      taskId: 'task-5',
    });
    const terminal = createTerminalPort();
    const session = await openAutomataBusWorkerRun({
      access: createAccess(),
      run: run.port,
      terminal: terminal.port,
      briefingQuery: 'bounded work',
    });
    const first = await session.settle(completedOutcome());
    const second = await session.settle(completedOutcome({ stateReason: 'different' }));
    expect(second).toBe(first);
    expect(terminal.recorded).toHaveLength(1);
    expect(run.terminals).toHaveLength(1);
  });

  it('skips execution and terminalization for a run that is already terminal', async () => {
    const replayed = await runClass({
      automatonClass: 'memory.extraction',
      runId: 'extraction-2',
      execute: false,
    });
    expect(stageTrace(replayed.events)).toEqual([
      'begin:replayed',
      'brief:skipped',
      'tool:skipped',
      'handoff:replayed',
      'terminal:replayed',
    ]);
    expect(replayed.terminal.recorded).toEqual([]);
    expect(replayed.run.terminals).toEqual([]);
    expect(replayed.settlement.terminalized).toBe(false);
  });

  it('fails a briefing version mismatch with actionable version telemetry, then still terminalizes', async () => {
    const drifted = await runClass({
      automatonClass: 'subagent.bounded',
      runId: 'subagent-6',
      access: createAccess({ brief: vi.fn(async () => briefing({ schemaVersion: 99 })) }),
    });
    const briefEvent = drifted.events.find(event => event.stage === 'brief');
    expect(briefEvent?.status).toBe('degraded');
    expect(briefEvent?.briefingSchema).toEqual({
      expected: AUTOMATA_BUS_WORKER_BRIEFING_SCHEMA_VERSION,
      received: '99',
      field: 'briefing.schemaVersion',
    });
    expect(briefEvent?.detail).toContain('schema mismatch');
    // Degraded, not dead: no prompt block, but the tool and the run survive.
    expect(drifted.session.promptBlock).toBeNull();
    expect(drifted.session.tool).not.toBeNull();
    expect(drifted.run.terminals).toHaveLength(1);
  });

  it('honours a fail disposition for a briefing failure', async () => {
    const run = createRunPort({
      automatonClass: 'subagent.bounded',
      runId: 'subagent-7',
      taskId: 'task-7',
    });
    await expect(openAutomataBusWorkerRun({
      access: createAccess({ brief: vi.fn(async () => { throw new Error('bus down'); }) }),
      run: run.port,
      terminal: createTerminalPort().port,
      briefingQuery: 'bounded work',
      policy: () => 'fail',
    })).rejects.toThrow('bus down');
    expect(run.terminals).toEqual([]);
  });

  it('retries a recoverable stage for exactly as long as the policy asks', async () => {
    let attempts = 0;
    const brief = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient bus failure');
      return briefing();
    });
    const retryTwice: AutomataWorkerFailurePolicy = failure => (
      failure.attemptIndex < 2 ? 'retry' : 'degrade'
    );
    const recovered = await runClass({
      automatonClass: 'memory.extraction',
      runId: 'extraction-3',
      access: createAccess({ brief }),
      policy: retryTwice,
    });
    expect(attempts).toBe(3);
    expect(stageTrace(recovered.events)).toEqual([
      'begin:ok',
      'brief:failed',
      'brief:failed',
      'brief:ok',
      'tool:ok',
      'handoff:ok',
      'terminal:ok',
    ]);
    expect(recovered.run.terminals).toHaveLength(1);
  });

  it('degrades a failed terminal handoff without orphaning the durable run', async () => {
    const degraded = await runClass({
      automatonClass: 'subagent.bounded',
      runId: 'subagent-8',
      terminalOptions: { fail: new Error('bus append unavailable') },
    });
    expect(stageTrace(degraded.events)).toEqual([
      'begin:ok',
      'brief:ok',
      'tool:ok',
      'handoff:degraded',
      'terminal:ok',
    ]);
    expect(degraded.settlement.handoff).toMatchObject({
      status: 'failed',
      error: 'bus append unavailable',
    });
    // The run reaches its true terminal state even with no Bus event.
    expect(degraded.run.terminals).toEqual([expect.objectContaining({
      lifecycleState: 'completed',
      outcome: 'completed',
    })]);
  });

  it('reports a replayed terminal handoff instead of claiming a fresh one', async () => {
    const replayed = await runClass({
      automatonClass: 'subagent.bounded',
      runId: 'subagent-9',
      terminalOptions: { inserted: false },
    });
    expect(stageTrace(replayed.events)).toContain('handoff:replayed');
    expect(replayed.settlement.handoff).toMatchObject({ status: 'recorded', replay: true });
    expect(replayed.run.terminals).toHaveLength(1);
  });

  it('lets a caller retry after a failed terminalization without duplicating the handoff', async () => {
    let failNext = true;
    const terminal = createTerminalPort();
    const terminals: AutomataWorkerTerminalRequest[] = [];
    const session = await openAutomataBusWorkerRun({
      access: createAccess(),
      run: {
        begin: async () => ({
          companionId: COMPANION_ID,
          lineage: {
            automatonClass: 'subagent.bounded',
            runId: 'subagent-10',
            taskId: 'task-10',
            workerId: 'subagent-10',
            sessionIds: ['session:subagent-10'],
          },
          attempt: 1,
          execute: true,
        }),
        terminalize: async request => {
          if (failNext) {
            failNext = false;
            throw new Error('run store unavailable');
          }
          terminals.push(request);
        },
      },
      terminal: terminal.port,
      briefingQuery: 'bounded work',
    });
    await expect(session.settle(completedOutcome())).rejects.toThrow('run store unavailable');
    const settlement = await session.settle(completedOutcome());
    expect(settlement.terminalized).toBe(true);
    expect(terminals).toHaveLength(1);
    // The retried handoff carries the same key, so the Bus stays exactly-once.
    const keys = new Set(terminal.recorded.map(entry => entry.idempotencyKey));
    expect(keys.size).toBe(1);
  });

  it('never swallows a failed terminalization', async () => {
    const terminalizeError = new Error('run store unavailable');
    await expect(runClass({
      automatonClass: 'memory.extraction',
      runId: 'extraction-4',
      terminalizeError,
    })).rejects.toThrow('run store unavailable');
  });

  it('ships a degrade-by-default production policy', () => {
    expect(AUTOMATA_WORKER_DEGRADE_POLICY({
      stage: 'brief',
      attemptIndex: 0,
      error: new Error('x'),
    })).toBe('degrade');
    expect(AUTOMATA_WORKER_DEGRADE_POLICY({
      stage: 'handoff',
      attemptIndex: 3,
      error: new Error('x'),
    })).toBe('degrade');
  });
});
