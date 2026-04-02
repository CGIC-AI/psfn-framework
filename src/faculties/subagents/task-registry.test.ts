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
      'Invalid subagent task transition for subagent-2: queued -> completed.',
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
