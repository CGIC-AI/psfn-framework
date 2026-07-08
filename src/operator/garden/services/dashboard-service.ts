import type { EventBus } from '../../../shared/event-bus.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { ShardExecutionPort } from '../../../faculties/shards/port.js';
import type {
  AnalysisWorkbenchTraceView,
  DashboardCostWindow,
  DashboardSessionContextPressure,
  DashboardToolStatus,
} from '../types.js';
import type { AdminAdaptiveToolsService, AdminDashboardData, AdminDashboardService } from './types.js';
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
    estimatedCostUsd: 0,
  };

  private usageSamples: DashboardUsageSample[] = [];

  private readonly sessionContextUtilizationBySession = new Map<string, number>();

  private latestUsageSessionId: string | null = null;
  private latestTtftMs: number | null = null;
  private ttftTotalMs = 0;
  private ttftSampleCount = 0;

  private analysisWorkbenchTraces: AnalysisWorkbenchTraceView[] = [];

  constructor(private readonly deps: {
    memoryStore: MemoryStorePort;
    sessionStore: SessionStore;
    sessionManager?: SessionManager;
    scheduler: Scheduler;
    shardManager: ShardExecutionPort;
    eventBus: EventBus;
    adaptiveToolsService?: AdminAdaptiveToolsService | null;
    resolveLastActiveSessionId?: () => string | null;
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
      this.usageTotals.estimatedCostUsd += estimatedCostUsd;

      const usageSessionId = this.resolveUsageSessionId(message.channelId);
      if (usageSessionId) {
        this.sessionContextUtilizationBySession.set(usageSessionId, contextUtilization);
        this.latestUsageSessionId = usageSessionId;
      }

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

    this.deps.eventBus.on('agent.turn.stage', (payload) => {
      if (payload.stage !== 'first-token') return;
      const ttftMs = AdminDashboardDataService.normalizeOptionalDuration(payload.ttftMs);
      if (ttftMs === null) return;
      this.latestTtftMs = ttftMs;
      this.ttftTotalMs += ttftMs;
      this.ttftSampleCount += 1;
    });

    this.deps.eventBus.on('agent.analysis_workbench.trace', ({ timestamp, task, result }) => {
      const trace: AnalysisWorkbenchTraceView = {
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
      this.analysisWorkbenchTraces.unshift(trace);
      if (this.analysisWorkbenchTraces.length > 5) this.analysisWorkbenchTraces.length = 5;
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

  private static normalizeOptionalDuration(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : null;
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

  private static normalizeSessionId(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private resolveUsageSessionId(channelId: string): string | null {
    const resolvedChannelId = this.deps.sessionManager
      ? this.deps.sessionManager.resolveSessionChannelId(channelId)
      : channelId;
    return AdminDashboardDataService.normalizeSessionId(resolvedChannelId);
  }

  private resolveActiveSessionId(): string | null {
    const activeContextSessionId = AdminDashboardDataService.normalizeSessionId(
      this.deps.sessionManager?.getActiveContextSession(),
    );
    if (activeContextSessionId) {
      return activeContextSessionId;
    }

    const latestSessionId = AdminDashboardDataService.normalizeSessionId(
      this.deps.resolveLastActiveSessionId?.(),
    );
    if (latestSessionId) {
      return latestSessionId;
    }

    return this.latestUsageSessionId;
  }

  private getActiveSessionContextPressure(): DashboardSessionContextPressure {
    const sessionId = this.resolveActiveSessionId();
    if (!sessionId) {
      return { sessionId: null, utilizationPct: 0, hasTelemetry: false };
    }

    const utilizationPct = this.sessionContextUtilizationBySession.get(sessionId);
    if (typeof utilizationPct !== 'number' || !Number.isFinite(utilizationPct) || utilizationPct < 0) {
      return { sessionId, utilizationPct: 0, hasTelemetry: false };
    }

    return { sessionId, utilizationPct, hasTelemetry: true };
  }

  private async getToolStatus(): Promise<DashboardToolStatus[]> {
    if (!this.deps.adaptiveToolsService) {
      return [];
    }
    const data = await this.deps.adaptiveToolsService.getAdaptiveToolsData();
    return data.toolHealth
      .map(tool => ({
        name: tool.name,
        status: tool.health.status,
        detail: tool.health.detail,
      }))
      .sort((left, right) => (
        toolStatusWeight(right.status) - toolStatusWeight(left.status)
        || left.name.localeCompare(right.name)
      ));
  }

  async getDashboardData(options: { costWindow?: DashboardCostWindow } = {}): Promise<AdminDashboardData> {
    const selectedCostWindow = options.costWindow ?? 'today';
    const nowMs = Date.now();
    this.pruneUsageSamples(nowMs);
    const costByWindow = this.usageSamples.length > 0
      ? aggregateDashboardCostWindows(this.usageSamples, nowMs)
      : createEmptyDashboardCostWindowTotals();
    const memStats = await this.deps.memoryStore.getStats();
    const channels = this.deps.sessionStore.listChannels();
    const toolStatus = await this.getToolStatus();
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
          lastTtftMs: this.latestTtftMs,
          averageTtftMs: this.ttftSampleCount > 0
            ? this.ttftTotalMs / this.ttftSampleCount
            : null,
          activeSessionContextPressure: this.getActiveSessionContextPressure(),
          estimatedCostUsd: this.usageTotals.estimatedCostUsd,
          costWindows: {
            selected: selectedCostWindow,
            byWindow: costByWindow,
          },
        },
        toolStatus,
        recentAnalysisWorkbenchTraces: this.analysisWorkbenchTraces,
      },
    };
  }
}

function toolStatusWeight(status: DashboardToolStatus['status']): number {
  switch (status) {
    case 'unavailable':
      return 4;
    case 'degraded':
      return 3;
    case 'not_applicable':
      return 2;
    case 'healthy':
    default:
      return 1;
  }
}
