import type { EventBus } from '../../../event-bus.js';
import type { MemoryStore } from '../../../memory/store.js';
import type { Scheduler } from '../../../scheduler/scheduler.js';
import type { SessionStore } from '../../../session/store.js';
import type { ShardManager } from '../../../shards/manager.js';
import type { ThinkTraceView } from '../types.js';
import type { AdminDashboardData, AdminDashboardService } from './types.js';

interface UsageTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  llmCalls: number;
  toolCalls: number;
  contextUtilizationSum: number;
  estimatedCostUsd: number;
}

export class AdminDashboardDataService implements AdminDashboardService {
  private usageTotals: UsageTotals = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    llmCalls: 0,
    toolCalls: 0,
    contextUtilizationSum: 0,
    estimatedCostUsd: 0,
  };

  private thinkTraces: ThinkTraceView[] = [];

  constructor(private readonly deps: {
    memoryStore: MemoryStore;
    sessionStore: SessionStore;
    scheduler: Scheduler;
    shardManager: ShardManager;
    eventBus: EventBus;
  }) {
    this.deps.eventBus.on('agent.turn.usage', ({ usage }) => {
      this.usageTotals.turns += 1;
      this.usageTotals.inputTokens += usage.inputTokens;
      this.usageTotals.outputTokens += usage.outputTokens;
      this.usageTotals.cacheReadTokens += usage.cacheReadTokens;
      this.usageTotals.llmCalls += usage.llmCalls;
      this.usageTotals.toolCalls += usage.toolCalls;
      this.usageTotals.contextUtilizationSum += usage.contextUtilization;
      this.usageTotals.estimatedCostUsd += usage.estimatedCostUsd ?? 0;
    });

    this.deps.eventBus.on('agent.think.trace', ({ timestamp, task, result }) => {
      const trace: ThinkTraceView = {
        timestamp,
        task,
        iterations: result.iterations,
        totalTokens: result.totalInputTokens + result.totalOutputTokens,
        durationMs: result.durationMs,
        truncated: result.truncated,
        budgetStop: result.budgetStop,
        steps: result.steps.map(step => ({
          iteration: step.iteration,
          inputTokens: step.inputTokens,
          outputTokens: step.outputTokens,
          cumulativeTokens: step.cumulativeTokens,
          durationMs: step.durationMs,
          code: step.code,
          output: step.output,
          error: step.error,
          variablesChanged: step.variablesChanged,
        })),
      };
      this.thinkTraces.unshift(trace);
      if (this.thinkTraces.length > 5) this.thinkTraces.length = 5;
    });
  }

  getDashboardData(): AdminDashboardData {
    const memStats = this.deps.memoryStore.getStats();
    const channels = this.deps.sessionStore.listChannels();
    return {
      stats: {
        memoryTotal: memStats.total,
        memoryByType: memStats.byType,
        avgSalience: memStats.avgSalience,
        sessionCount: channels.length,
        schedulerTasks: this.deps.scheduler.taskCount,
        activeShards: this.deps.shardManager.getActiveCount(),
        sessionUsage: {
          turns: this.usageTotals.turns,
          inputTokens: this.usageTotals.inputTokens,
          outputTokens: this.usageTotals.outputTokens,
          cacheReadTokens: this.usageTotals.cacheReadTokens,
          llmCalls: this.usageTotals.llmCalls,
          toolCalls: this.usageTotals.toolCalls,
          avgContextUtilization: this.usageTotals.turns > 0
            ? this.usageTotals.contextUtilizationSum / this.usageTotals.turns
            : 0,
          estimatedCostUsd: this.usageTotals.estimatedCostUsd,
        },
        recentThinkTraces: this.thinkTraces,
      },
    };
  }
}
