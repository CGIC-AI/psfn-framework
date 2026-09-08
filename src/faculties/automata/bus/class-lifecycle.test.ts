import { describe, expect, it } from 'vitest';

import { loadAutomataPolicySeedDefaults } from '../../../system/config/automata-policy-config.js';
import type { ProductionAutomataClassId } from '../registry-contract.js';
import { AutomataRunRegistry, InMemoryAutomataRunStore } from '../run-registry.js';
import {
  buildAutomataTerminalHandoffKey,
  type AutomataTerminalLifecyclePort,
  type CommittedAutomataTerminalHandoff,
} from '../terminal-lifecycle.js';
import {
  createAutomataClassRunPort,
  runGovernedAutomataClass,
  type AutomataClassRunSpec,
} from './class-lifecycle.js';

const COMPANION_ID = 'companion-public-example';

async function createRegistry(store = new InMemoryAutomataRunStore()): Promise<{
  registry: AutomataRunRegistry;
  store: InMemoryAutomataRunStore;
}> {
  const registry = await AutomataRunRegistry.hydrate({
    companionId: COMPANION_ID,
    policy: loadAutomataPolicySeedDefaults(),
    store,
  });
  return { registry, store };
}

function spec(overrides: Partial<AutomataClassRunSpec> = {}): AutomataClassRunSpec {
  return {
    automatonClass: 'scheduler.reflection',
    runId: 'run-governed-1',
    workerId: 'reflection-worker',
    taskId: 'reflection-template',
    taskLabel: 'Deferred reflection template',
    taskSummary: 'Run one policy-owned deferred reflection template.',
    sessionIds: ['session-governed-1'],
    ...overrides,
  };
}

/**
 * A terminal-lifecycle port holding exactly the handoffs the Bus already
 * committed, keyed the way the durable adapter keys them.
 */
function terminalPortWithCommitted(
  committed: ReadonlyMap<string, CommittedAutomataTerminalHandoff>,
  observed: string[] = [],
): AutomataTerminalLifecyclePort {
  return {
    recordTerminalHandoff: async () => {
      throw new Error('this test must not record a terminal handoff');
    },
    readTerminalHandoff: async input => {
      observed.push(input.lineage.runId);
      return committed.get(input.idempotencyKey) ?? null;
    },
    inspectRun: async () => {
      throw new Error('this test must not inspect a run');
    },
  };
}

function committedTerminal(
  input: AutomataClassRunSpec,
  outcome: CommittedAutomataTerminalHandoff['outcome'],
  occurredAtMs: number,
): [string, CommittedAutomataTerminalHandoff] {
  const idempotencyKey = buildAutomataTerminalHandoffKey({
    automatonClass: input.automatonClass,
    runId: input.runId,
    attempt: 1,
  });
  return [idempotencyKey, {
    handoffRef: `automata-bus-terminal:${idempotencyKey}`,
    occurredAtMs,
    outcome,
    findingRefs: [`automata-bus-terminal:${idempotencyKey}`],
    evidenceRefs: [`automata-run:${input.runId}`],
  }];
}

describe('governed automata class run port', () => {
  it('registers, starts, and terminalizes one durable run', async () => {
    const { registry } = await createRegistry();
    const port = createAutomataClassRunPort(registry, spec());

    const binding = await port.begin();
    expect(binding).toMatchObject({
      companionId: COMPANION_ID,
      attempt: 1,
      execute: true,
    });
    expect(binding.lineage.automatonClass).toBe('scheduler.reflection');
    expect(registry.getRun('run-governed-1')?.status).toBe('running');

    await port.terminalize({
      lifecycleState: 'completed',
      outcome: 'completed',
      stateReason: 'automata_run_completed',
      atMs: 10,
    });
    expect(registry.getRun('run-governed-1')).toMatchObject({
      status: 'completed',
      outcome: 'completed',
    });
  });

  it('re-enters its own run instead of forking one, and replays a completed run', async () => {
    const { registry, store } = await createRegistry();
    const port = createAutomataClassRunPort(registry, spec());
    await port.begin();

    // A restart rehydrates the same durable run from the same store.
    const restarted = await AutomataRunRegistry.hydrate({
      companionId: COMPANION_ID,
      policy: loadAutomataPolicySeedDefaults(),
      store,
    });
    const restartedPort = createAutomataClassRunPort(restarted, spec());
    expect(await restartedPort.begin()).toMatchObject({ attempt: 1, execute: true });

    await restartedPort.terminalize({
      lifecycleState: 'completed',
      outcome: 'completed',
      stateReason: 'automata_run_completed',
      atMs: 20,
    });
    // A completed run is a replay: no execution, no second terminal.
    expect(await restartedPort.begin()).toMatchObject({ execute: false });
    await restartedPort.terminalize({
      lifecycleState: 'completed',
      outcome: 'completed',
      stateReason: 'automata_run_completed',
      atMs: 30,
    });
    expect(restarted.getRun('run-governed-1')?.finishedAtMs).toBe(20);
  });

  it('fails closed on a terminal failed run rather than reporting a false replay', async () => {
    const { registry } = await createRegistry();
    const port = createAutomataClassRunPort(registry, spec());
    await port.begin();
    await port.terminalize({
      lifecycleState: 'failed',
      outcome: 'blocked',
      stateReason: 'automata_run_failed',
      failureReason: 'worker exploded',
      atMs: 10,
    });

    // A retry that reused the failed run id would otherwise look like a replay
    // and let the caller report success without doing the work.
    await expect(port.begin()).rejects.toThrow('already a terminal failed run');
  });

  it('rejects a run id already bound to another class or task', async () => {
    const { registry } = await createRegistry();
    await createAutomataClassRunPort(registry, spec()).begin();

    const otherClass: ProductionAutomataClassId = 'scheduler.free_time';
    await expect(
      createAutomataClassRunPort(registry, spec({ automatonClass: otherClass })).begin(),
    ).rejects.toThrow();
    await expect(
      createAutomataClassRunPort(registry, spec({ taskId: 'another-task' })).begin(),
    ).rejects.toThrow();
  });
});

describe('runGovernedAutomataClass', () => {
  it('settles a failed worker as a failed run and never swallows the error', async () => {
    const { registry } = await createRegistry();
    await expect(runGovernedAutomataClass({
      runtime: { registry },
      spec: spec(),
      briefingQuery: 'deferred reflection template run',
      work: async () => { throw new Error('template exploded'); },
    })).rejects.toThrow('template exploded');
    expect(registry.getRun('run-governed-1')).toMatchObject({
      status: 'failed',
      outcome: 'blocked',
      failureReason: 'template exploded',
    });
  });

  it('reports both errors when settling a failed worker also fails (8n40k)', async () => {
    const store = new InMemoryAutomataRunStore();
    // The registry write that TERMINALIZES the run fails (the run still starts),
    // so `settle()` throws from inside the failure path. The work error must
    // survive that instead of being replaced.
    const failingStore = Object.create(store) as InMemoryAutomataRunStore;
    failingStore.update = async (record, previousStatus) => {
      if (record.status !== 'running') throw new Error('registry write failed');
      return await store.update(record, previousStatus);
    };
    const failingRegistry = await AutomataRunRegistry.hydrate({
      companionId: COMPANION_ID,
      policy: loadAutomataPolicySeedDefaults(),
      store: failingStore,
    });

    const settled = await runGovernedAutomataClass({
      runtime: { registry: failingRegistry },
      spec: spec({ runId: 'run-governed-dual-error' }),
      briefingQuery: 'deferred reflection template run',
      work: async () => { throw new Error('template exploded'); },
    }).catch((error: unknown) => error);

    expect(settled).toBeInstanceOf(AggregateError);
    const aggregate = settled as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    // Loggers read `.message`, so both causes have to be legible there too.
    expect(aggregate.message).toContain('template exploded');
    expect(aggregate.message).toContain('registry write failed');
    expect((aggregate.errors[0] as Error).message).toBe('template exploded');
  });

  it('runs the class work unchanged when no durable Automata runtime is composed', async () => {
    const outcome = await runGovernedAutomataClass<string>({
      spec: spec(),
      briefingQuery: 'deferred reflection template run',
      work: async (run) => {
        expect(run).toBeNull();
        return { value: 'ran' };
      },
    });
    expect(outcome).toEqual({ status: 'executed', value: 'ran' });
  });

  it('carries a class-authored terminal outcome for work that finished without doing its job', async () => {
    const { registry } = await createRegistry();
    const outcome = await runGovernedAutomataClass({
      runtime: { registry },
      spec: spec({ automatonClass: 'memory.sleeptime', runId: 'run-governed-yield' }),
      briefingQuery: 'sleeptime memory consolidation pass',
      work: async () => ({
        value: 'waiting',
        lifecycleState: 'cancelled' as const,
        outcome: 'cancelled' as const,
        resultKind: 'none' as const,
      }),
    });
    expect(outcome).toEqual({ status: 'executed', value: 'waiting' });
    expect(registry.getRun('run-governed-yield')).toMatchObject({
      status: 'cancelled',
      outcome: 'cancelled',
    });
  });
});

describe('crash-window execution guard (psfn-framework-8n40k)', () => {
  it('skips work and converges on the durable terminal when the Bus already committed one', async () => {
    const { registry, store } = await createRegistry();
    // Crash: the run started, its work finished, its Bus terminal committed —
    // and the process died before the registry transition.
    await createAutomataClassRunPort(registry, spec()).begin();
    expect(registry.getRun('run-governed-1')?.status).toBe('running');

    const restarted = await AutomataRunRegistry.hydrate({
      companionId: COMPANION_ID,
      policy: loadAutomataPolicySeedDefaults(),
      store,
    });
    const terminal = terminalPortWithCommitted(new Map([committedTerminal(
      spec(),
      { lifecycleState: 'completed', outcome: 'completed', stateReason: 'automata_run_completed' },
      4_242,
    )]));

    let executions = 0;
    const outcome = await runGovernedAutomataClass({
      runtime: { registry: restarted, terminal },
      spec: spec(),
      briefingQuery: 'deferred reflection template run',
      work: async () => {
        executions += 1;
        return { value: 'ran again' };
      },
    });

    expect(outcome).toEqual({ status: 'replayed' });
    expect(executions).toBe(0);
    expect(restarted.getRun('run-governed-1')).toMatchObject({
      status: 'completed',
      outcome: 'completed',
      finishedAtMs: 4_242,
    });
  });

  it('converges a crash-window FAILED terminal without re-running the work', async () => {
    const { registry, store } = await createRegistry();
    await createAutomataClassRunPort(registry, spec()).begin();
    const restarted = await AutomataRunRegistry.hydrate({
      companionId: COMPANION_ID,
      policy: loadAutomataPolicySeedDefaults(),
      store,
    });
    const terminal = terminalPortWithCommitted(new Map([committedTerminal(
      spec(),
      {
        lifecycleState: 'failed',
        outcome: 'blocked',
        stateReason: 'automata_run_failed',
        failureReason: 'the first attempt failed',
      },
      777,
    )]));

    let executions = 0;
    const outcome = await runGovernedAutomataClass({
      runtime: { registry: restarted, terminal },
      spec: spec(),
      briefingQuery: 'deferred reflection template run',
      work: async () => {
        executions += 1;
        return { value: 'ran again' };
      },
    });

    expect(outcome).toEqual({ status: 'replayed' });
    expect(executions).toBe(0);
    expect(restarted.getRun('run-governed-1')).toMatchObject({
      status: 'failed',
      outcome: 'blocked',
      failureReason: 'the first attempt failed',
      finishedAtMs: 777,
    });
  });

  it('executes when the ledger holds no terminal for the interrupted run', async () => {
    const { registry, store } = await createRegistry();
    await createAutomataClassRunPort(registry, spec()).begin();
    const restarted = await AutomataRunRegistry.hydrate({
      companionId: COMPANION_ID,
      policy: loadAutomataPolicySeedDefaults(),
      store,
    });

    let executions = 0;
    const outcome = await runGovernedAutomataClass({
      runtime: {
        registry: restarted,
        terminal: terminalPortWithCommitted(new Map()),
      },
      spec: spec(),
      briefingQuery: 'deferred reflection template run',
      work: async () => {
        executions += 1;
        return { value: 'ran' };
      },
    });

    expect(outcome).toEqual({ status: 'executed', value: 'ran' });
    expect(executions).toBe(1);
  });

  it('does not consult the ledger for a run it started itself', async () => {
    const { registry } = await createRegistry();
    const observed: string[] = [];
    const binding = await createAutomataClassRunPort(
      registry,
      spec(),
      terminalPortWithCommitted(new Map(), observed),
    ).begin();
    expect(binding.execute).toBe(true);
    expect(observed).toEqual([]);
  });

  it('does not consult the ledger for an already-completed run', async () => {
    const { registry } = await createRegistry();
    const observed: string[] = [];
    const port = createAutomataClassRunPort(
      registry,
      spec(),
      terminalPortWithCommitted(new Map(), observed),
    );
    await port.begin();
    await port.terminalize({
      lifecycleState: 'completed',
      outcome: 'completed',
      stateReason: 'automata_run_completed',
      atMs: 11,
    });
    const replay = await port.begin();
    expect(replay).toMatchObject({ execute: false });
    expect(replay.replayTerminal).toBeUndefined();
    expect(observed).toEqual([]);
  });

  it('fails closed when the durable ledger cannot be read', async () => {
    const { registry, store } = await createRegistry();
    await createAutomataClassRunPort(registry, spec()).begin();
    const restarted = await AutomataRunRegistry.hydrate({
      companionId: COMPANION_ID,
      policy: loadAutomataPolicySeedDefaults(),
      store,
    });
    const terminal: AutomataTerminalLifecyclePort = {
      ...terminalPortWithCommitted(new Map()),
      readTerminalHandoff: async () => { throw new Error('bus ledger unavailable'); },
    };

    let executions = 0;
    await expect(runGovernedAutomataClass({
      runtime: { registry: restarted, terminal },
      spec: spec(),
      briefingQuery: 'deferred reflection template run',
      work: async () => {
        executions += 1;
        return { value: 'ran' };
      },
    })).rejects.toThrow('bus ledger unavailable');
    // Unproven absence of a terminal never licenses a second chargeable run.
    expect(executions).toBe(0);
  });
});
