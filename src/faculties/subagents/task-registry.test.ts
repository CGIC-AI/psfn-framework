import { describe, expect, it } from 'vitest';
import { SubagentTaskRegistry } from './task-registry.js';
import {
  PRODUCTION_AUTOMATA_CLASSES,
  parseAutomataOwnerPolicy,
} from '../automata/registry-contract.js';
import { AutomataRunRegistry, InMemoryAutomataRunStore } from '../automata/run-registry.js';

function automataPolicy() {
  return parseAutomataOwnerPolicy({
    schemaVersion: 1,
    bus: {
      eligibleClasses: PRODUCTION_AUTOMATA_CLASSES
        .filter(entry => entry.id !== 'memory.retrieval')
        .map(entry => entry.id),
      excludedClasses: ['memory.retrieval'],
    },
    retentionMs: { ephemeral: 1_000, standard: 10_000, extended: 20_000 },
    recentRunLimit: 25,
    operatorMutationLimit: 100,
  });
}

describe('SubagentTaskRegistry', () => {
  it('tracks active and completed tasks on the subagent worker lane', () => {
    const registry = new SubagentTaskRegistry();

    const queued = registry.register({
      subagentId: 'subagent-1',
      name: 'investigate',
      task: 'check runtime wiring',
      channelId: 'subagent:subagent-1',
      capabilities: ['general'],
      requiredCapabilities: ['general'],
      createdAt: 100,
    });

    expect(queued.lifecycleState).toBe('queued');
    expect(queued.workerLane).toBe('subagent');
    expect(registry.getActiveCount()).toBe(1);

    const running = registry.markRunning('subagent-1', 'agent_initialized', 125);
    expect(running.lifecycleState).toBe('running');
    expect(running.startedAt).toBe(125);

    const completed = registry.markCompleted('subagent-1', 'completed', 150);
    expect(completed.lifecycleState).toBe('completed');
    expect(completed.finishedAt).toBe(150);
    expect(registry.getActiveCount()).toBe(0);
    expect(registry.getRecentTasks(1)).toEqual([
      expect.objectContaining({
        subagentId: 'subagent-1',
        lifecycleState: 'completed',
        workerLane: 'subagent',
      }),
    ]);
  });

  // Register guard (rqn1.9): unknown-task transition errors propagate through
  // the subagent-tool catch into companion-visible failure text, so they must
  // read in the automata register (charter 6.28/8.12), never "subagent".
  it('names unknown-task transitions in the automata register (rqn1.9)', () => {
    const registry = new SubagentTaskRegistry();

    for (const transition of [
      () => registry.markRunning('missing-task', 'agent_initialized', 100),
      () => registry.markCompleted('missing-task', 'completed', 150),
    ]) {
      let message = '';
      try {
        void transition();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/Unknown automaton task "missing-task"/);
      expect(message).not.toMatch(/\bsubagent\b/iu);
    }
  });

  it('fails closed on invalid lifecycle transitions', () => {
    const registry = new SubagentTaskRegistry();
    void registry.register({
      subagentId: 'subagent-2',
      name: 'research',
      task: 'collect notes',
      channelId: 'subagent:subagent-2',
      capabilities: ['general'],
      requiredCapabilities: [],
    });

    expect(() => registry.markCompleted('subagent-2', 'completed')).toThrow(
      'Invalid automaton task transition for subagent-2: queued -> completed.',
    );
  });

  it('tracks explicit cancellation as a terminal bounded-worker state', () => {
    const registry = new SubagentTaskRegistry();
    void registry.register({
      subagentId: 'subagent-3',
      name: 'cancelled-task',
      task: 'wait here',
      channelId: 'subagent:subagent-3',
      capabilities: ['general'],
      requiredCapabilities: [],
    });

    const cancelled = registry.markCancelled('subagent-3', 'cancel_requested', 200, 'operator_cancelled');

    expect(cancelled.lifecycleState).toBe('cancelled');
    expect(cancelled.finishedAt).toBe(200);
    expect(cancelled.failureReason).toBe('operator_cancelled');
    expect(registry.getActiveCount()).toBe(0);
  });

  it('uses the durable registry for lineage, task discovery, and linked references', async () => {
    const runRegistry = await AutomataRunRegistry.hydrate({
      companionId: 'companion-a',
      policy: automataPolicy(),
      store: new InMemoryAutomataRunStore(),
      nowMs: 100,
    });
    const registry = new SubagentTaskRegistry({ runRegistry });
    const task = await registry.register({
      subagentId: 'subagent-durable',
      name: 'Lineage investigator',
      task: 'Inspect session and evidence links',
      channelId: 'subagent:durable',
      capabilities: ['general'],
      requiredCapabilities: [],
      taskId: 'task-durable',
      parentRunId: 'run-parent',
      sourceRunId: 'run-root',
      sessionIds: ['subagent:durable', 'session-parent'],
      createdAt: 100,
    });
    expect(task.lineage).toEqual({
      runId: 'subagent-durable',
      taskId: 'task-durable',
      workerId: 'subagent-durable',
      parentRunId: 'run-parent',
      sourceRunId: 'run-root',
      sessionIds: ['subagent:durable', 'session-parent'],
    });
    expect(registry.findByTaskDescription('evidence links')).toHaveLength(1);
    await registry.linkReferences('subagent-durable', [{
      kind: 'automata_bus_evidence',
      ref: 'evidence:one',
      custody: 'durable',
    }]);
    expect(runRegistry.getRun('subagent-durable')?.artifacts).toEqual([{
      kind: 'automata_bus_evidence',
      ref: 'evidence:one',
      custody: 'durable',
    }]);
  });
});
