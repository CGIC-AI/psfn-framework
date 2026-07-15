import { describe, expect, it, vi } from 'vitest';
import type { Scheduler } from '../../scheduler/scheduler.js';
import type { SubstrateAgent } from '../substrate-agent.js';
import type { ModelUsageData, ModelUsageQueryPort } from '../../../shared/telemetry/model-usage.js';
import {
  registerToolUsageEvaluatorTask,
  TOOL_USAGE_EVALUATOR_TASK_ID,
} from './usage-evaluator-scheduler-lane.js';
import type { ToolUsageEvaluatorConfig } from '../../../system/config/scheduler-config.js';

interface CapturedTask {
  id: string;
  intervalMs: number;
  handler: () => Promise<void> | void;
}

function fakeScheduler(): { scheduler: Scheduler; tasks: CapturedTask[] } {
  const tasks: CapturedTask[] = [];
  const scheduler = {
    getTask: (id: string) => tasks.find(task => task.id === id),
    register: (task: CapturedTask) => { tasks.push(task); },
  } as unknown as Scheduler;
  return { scheduler, tasks };
}

const CONFIG: ToolUsageEvaluatorConfig = {
  enabled: true,
  intervalMs: 21_600_000,
  usageWindow: 'month',
  minPinSuggestionInvocations: 5,
};

describe('registerToolUsageEvaluatorTask', () => {
  it('does not register when disabled (fail-closed opt-in)', () => {
    const { scheduler, tasks } = fakeScheduler();
    registerToolUsageEvaluatorTask({
      scheduler,
      agent: {} as unknown as SubstrateAgent,
      getModelUsageQuery: () => null,
      getMemoryWriter: () => undefined,
      config: { ...CONFIG, enabled: false },
    });
    expect(tasks).toHaveLength(0);
  });

  it('registers an every-task wired to the agent ranking + durable query when enabled', async () => {
    const { scheduler, tasks } = fakeScheduler();
    const setToolUsageRanking = vi.fn();
    const getUsageData = vi.fn(async () => ({
      groups: [{ dimensions: { toolName: 'repo' }, isOther: false, metrics: { calls: 9, successfulCalls: 9, failedCalls: 0 } }],
    } as unknown as ModelUsageData));
    const query: ModelUsageQueryPort = { getUsageData };
    const agent = {
      getToolCatalog: () => ({ core: [], extended: [{ name: 'repo' }] }),
      getPromotedExtendedTools: () => [],
      getPromotedExtendedToolsLimit: () => 4,
      setToolUsageRanking,
    } as unknown as SubstrateAgent;

    registerToolUsageEvaluatorTask({
      scheduler,
      agent,
      getModelUsageQuery: () => query,
      getMemoryWriter: () => undefined,
      config: CONFIG,
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe(TOOL_USAGE_EVALUATOR_TASK_ID);
    expect(tasks[0]?.intervalMs).toBe(CONFIG.intervalMs);

    await tasks[0]?.handler();
    expect(getUsageData).toHaveBeenCalledOnce();
    expect(setToolUsageRanking).toHaveBeenCalledOnce();
    const applied = setToolUsageRanking.mock.calls[0]?.[0] as { rankedToolNames: string[] };
    expect(applied.rankedToolNames).toEqual(['repo']);
  });

  it('does not double-register if the task already exists', () => {
    const { scheduler, tasks } = fakeScheduler();
    tasks.push({ id: TOOL_USAGE_EVALUATOR_TASK_ID, intervalMs: 1, handler: () => undefined });
    registerToolUsageEvaluatorTask({
      scheduler,
      agent: {} as unknown as SubstrateAgent,
      getModelUsageQuery: () => null,
      getMemoryWriter: () => undefined,
      config: CONFIG,
    });
    expect(tasks).toHaveLength(1);
  });
});
