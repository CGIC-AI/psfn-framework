import { describe, expect, it } from 'vitest';
import { SubagentTaskRegistry } from './task-registry.js';

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
        transition();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/Unknown automaton task "missing-task"/);
      expect(message).not.toMatch(/\bsubagent\b/iu);
    }
  });

  it('fails closed on invalid lifecycle transitions', () => {
    const registry = new SubagentTaskRegistry();
    registry.register({
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
    registry.register({
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
});
