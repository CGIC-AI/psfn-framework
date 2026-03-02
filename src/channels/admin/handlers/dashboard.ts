import type { LegacyAdminHandlers } from '../handlers-legacy.js';
import type { DashboardStats } from '../types.js';
import * as tpl from '../templates.js';

export class AdminDashboardHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  dashboard(): string {
    const legacy = this.legacy as any;
    const memStats = legacy.memoryStore.getStats();
    const channels = legacy.sessionStore.listChannels();
    const stats: DashboardStats = {
      memoryTotal: memStats.total,
      memoryByType: memStats.byType,
      avgSalience: memStats.avgSalience,
      sessionCount: channels.length,
      schedulerTasks: legacy.scheduler.taskCount,
      activeShards: legacy.shardManager.getActiveCount(),
      sessionUsage: {
        turns: legacy.usageTotals.turns,
        inputTokens: legacy.usageTotals.inputTokens,
        outputTokens: legacy.usageTotals.outputTokens,
        cacheReadTokens: legacy.usageTotals.cacheReadTokens,
        llmCalls: legacy.usageTotals.llmCalls,
        toolCalls: legacy.usageTotals.toolCalls,
        avgContextUtilization: legacy.usageTotals.turns > 0
          ? legacy.usageTotals.contextUtilizationSum / legacy.usageTotals.turns
          : 0,
        estimatedCostUsd: legacy.usageTotals.estimatedCostUsd,
      },
      recentThinkTraces: legacy.thinkTraces,
    };
    return tpl.layout('Dashboard', tpl.dashboardPage(stats), 'dashboard');
  }
}
