import { describe, expect, it } from 'vitest';

import { loadAutomataPolicySeedDefaults } from '../../../system/config/automata-policy-config.js';
import type { ProductionAutomataClassId } from '../registry-contract.js';
import { AutomataRunRegistry, InMemoryAutomataRunStore } from '../run-registry.js';
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
