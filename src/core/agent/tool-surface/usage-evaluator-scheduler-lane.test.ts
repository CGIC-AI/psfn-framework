import { describe, expect, it, vi } from 'vitest';
import type { Scheduler } from '../../scheduler/scheduler.js';
import type { SubstrateAgent } from '../substrate-agent.js';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import {
  registerToolUsageEvaluatorTask,
  TOOL_USAGE_EVALUATOR_TASK_ID,
} from './usage-evaluator-scheduler-lane.js';
import type { ToolUsageEvaluatorConfig } from '../../../system/config/scheduler-config.js';

function turnRecordWithTools(
  startedAt: number,
  tools: Array<{ toolName: string; isError?: boolean }>,
): TurnRecord {
  return {
    startedAt,
    toolCalls: tools.map(tool => ({ toolName: tool.toolName, ...(tool.isError !== undefined ? { isError: tool.isError } : {}) })),
  } as unknown as TurnRecord;
}

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
      turnRecordAccess: null,
      getMemoryWriter: () => undefined,
      config: { ...CONFIG, enabled: false },
    });
    expect(tasks).toHaveLength(0);
  });

  it('registers an every-task wired to the agent ranking + durable turn records when enabled', async () => {
    const { scheduler, tasks } = fakeScheduler();
    const setToolUsageRanking = vi.fn();
    // Deterministic tool (repo) invoked in a real turn record — the whole point:
    // the old model_usage source never saw this; the turn-record source does.
    // Fixed time a minute ago: safely inside the 'month' window and strictly
    // before the evaluator's now (untilMs = now + 1), avoiding read-time drift.
    const recordTime = Date.now() - 60_000;
    const readRecentTurnRecords = vi.fn((): TurnRecord[] => [
      turnRecordWithTools(recordTime, [{ toolName: 'repo' }, { toolName: 'repo' }]),
    ]);
    const agent = {
      getToolCatalog: () => ({ core: [], extended: [{ name: 'repo' }] }),
      getPromotedExtendedTools: () => [],
      getPromotedExtendedToolsLimit: () => 4,
      setToolUsageRanking,
    } as unknown as SubstrateAgent;

    registerToolUsageEvaluatorTask({
      scheduler,
      agent,
      turnRecordAccess: {
        listChannelKeys: () => ['session-1'],
        readRecentTurnRecords,
      },
      getMemoryWriter: () => undefined,
      config: CONFIG,
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe(TOOL_USAGE_EVALUATOR_TASK_ID);
    expect(tasks[0]?.intervalMs).toBe(CONFIG.intervalMs);

    await tasks[0]?.handler();
    expect(readRecentTurnRecords).toHaveBeenCalled();
    expect(setToolUsageRanking).toHaveBeenCalledOnce();
    const applied = setToolUsageRanking.mock.calls[0]?.[0] as {
      rankedToolNames: string[];
      stats: Map<string, { successes: number }>;
    };
    expect(applied.rankedToolNames).toEqual(['repo']);
    expect(applied.stats.get('repo')?.successes).toBe(2);
  });

  it('does not double-register if the task already exists', () => {
    const { scheduler, tasks } = fakeScheduler();
    tasks.push({ id: TOOL_USAGE_EVALUATOR_TASK_ID, intervalMs: 1, handler: () => undefined });
    registerToolUsageEvaluatorTask({
      scheduler,
      agent: {} as unknown as SubstrateAgent,
      turnRecordAccess: null,
      getMemoryWriter: () => undefined,
      config: CONFIG,
    });
    expect(tasks).toHaveLength(1);
  });
});
