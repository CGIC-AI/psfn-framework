import type { EventBus } from '../../../event-bus.js';
import type { MemoryStore } from '../../../memory/store.js';
import type { Scheduler } from '../../../scheduler/scheduler.js';
import type { SessionStore } from '../../../session/store.js';
import type { ShardManager } from '../../../shards/manager.js';
import type { DashboardCostWindow, ThinkTraceView } from '../types.js';
import type { AdminDashboardData, AdminDashboardService } from './types.js';
import {
  aggregateDashboardCostWindows,
  createEmptyDashboardCostWindowTotals,
  startOfDashboardUtcMonth,
  type DashboardUsageSample,
} from './dashboard-cost-windows.js';

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

  private usageSamples: DashboardUsageSample[] = [];

  private thinkTraces: ThinkTraceView[] = [];

  constructor(private readonly deps: {
    memoryStore: MemoryStore;
    sessionStore: SessionStore;
    scheduler: Scheduler;
    shardManager: ShardManager;
    eventBus: EventBus;
  }) {
    this.deps.eventBus.on('agent.turn.usage', ({ message, usage }) => {
      const inputTokens = AdminDashboardDataService.normalizeCount(usage.inputTokens);
      const outputTokens = AdminDashboardDataService.normalizeCount(usage.outputTokens);
      const cacheReadTokens = AdminDashboardDataService.normalizeCount(usage.cacheReadTokens);
      const llmCalls = AdminDashboardDataService.normalizeCount(usage.llmCalls);
      const toolCalls = AdminDashboardDataService.normalizeCount(usage.toolCalls);
      const contextUtilization = AdminDashboardDataService.normalizeContextUtilization(usage.contextUtilization);
      const estimatedCostUsd = AdminDashboardDataService.normalizeCost(usage.estimatedCostUsd);

      this.usageTotals.turns += 1;
      this.usageTotals.inputTokens += inputTokens;
      this.usageTotals.outputTokens += outputTokens;
      this.usageTotals.cacheReadTokens += cacheReadTokens;
      this.usageTotals.llmCalls += llmCalls;
      this.usageTotals.toolCalls += toolCalls;
      this.usageTotals.contextUtilizationSum += contextUtilization;
      this.usageTotals.estimatedCostUsd += estimatedCostUsd;

      const timestampMs = AdminDashboardDataService.normalizeTimestamp(message.timestamp);
      if (timestampMs === null) {
        return;
      }

      this.usageSamples.push({
        timestampMs,
        llmCalls,
        toolCalls,
        estimatedCostUsd,
      });
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

  private static normalizeTimestamp(timestamp: Date): number | null {
    const value = timestamp.getTime();
    return Number.isFinite(value) ? value : null;
  }

  private static normalizeCount(value: number): number {
    return Number.isFinite(value) && value > 0
      ? Math.trunc(value)
      : 0;
  }

  private static normalizeContextUtilization(value: number): number {
    return Number.isFinite(value) && value > 0
      ? value
      : 0;
  }

  private static normalizeCost(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value
      : 0;
  }

  private pruneUsageSamples(nowMs: number): void {
    const monthStartMs = startOfDashboardUtcMonth(nowMs);
    let removeCount = 0;
    for (const sample of this.usageSamples) {
      if (sample.timestampMs >= monthStartMs) break;
      removeCount += 1;
    }
    if (removeCount > 0) {
      this.usageSamples.splice(0, removeCount);
    }
  }

  getDashboardData(options: { costWindow?: DashboardCostWindow } = {}): AdminDashboardData {
    const selectedCostWindow = options.costWindow ?? 'today';
    const nowMs = Date.now();
    this.pruneUsageSamples(nowMs);
    const costByWindow = this.usageSamples.length > 0
      ? aggregateDashboardCostWindows(this.usageSamples, nowMs)
      : createEmptyDashboardCostWindowTotals();
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
          costWindows: {
            selected: selectedCostWindow,
            byWindow: costByWindow,
          },
        },
        recentThinkTraces: this.thinkTraces,
      },
    };
  }
}
