import type { EventBus } from '../../../shared/event-bus.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { ShardExecutionPort } from '../../../faculties/shards/port.js';
import type {
  AnalysisWorkbenchTraceView,
  DashboardCostWindow,
  DashboardModelUsageProjection,
  DashboardSessionContextPressure,
  DashboardToolStatus,
} from '../types.js';
import type {
  AdminAdaptiveToolsService,
  AdminDashboardData,
  AdminDashboardService,
  AdminModelUsageService,
} from './types.js';
import {
  DASHBOARD_MODEL_USAGE_REFRESH_INTERVAL_MS,
  mapModelUsageTimeSeriesToDashboardSparkline,
  mapModelUsageTotalsToDashboardUsage,
  resolveDashboardCostWindowBucket,
  resolveDashboardCostWindowRange,
} from './dashboard-cost-windows.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { TurnPerformanceTracker } from '../../../shared/telemetry/turn-performance.js';
import type { AnalysisWorkbenchTraceStorePort } from '../../../persistence/postgres/analysis-workbench-trace-store.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { GardenRequestContext } from '../garden-request-context.js';
import type { PendingFollowUpStorePort } from '../../../core/intention/pending-follow-up-store-port.js';
import { MAX_LIST_LIMIT as INTENTION_EVIDENCE_LIMIT } from '../../../core/intention/list-limit.js';
import type { ScheduledPromptStorePort } from '../../../core/scheduler/scheduled-prompt-store-port.js';

interface CachedDashboardModelUsage {
  usage: NonNullable<DashboardModelUsageProjection['usage']>;
  sparkline: DashboardModelUsageProjection['sparkline'];
  sinceMs: number;
  refreshedAtMs: number;
  dataThroughMs: number;
  latestEventAtMs: number | null;
}

const log = createComponentLogger('AdminDashboardDataService');

export class AdminDashboardDataService implements AdminDashboardService {
  private transientTurnsSinceOperatorStart = 0;

  private modelUsageRequestSequence = 0;

  private readonly latestModelUsageRequestByWindow = new Map<DashboardCostWindow, number>();

  private readonly lastSuccessfulModelUsageByWindow = new Map<DashboardCostWindow, CachedDashboardModelUsage>();

  private readonly sessionContextUtilizationBySession = new Map<string, number>();

  private latestUsageSessionId: string | null = null;
  private latestTtftMs: number | null = null;
  private ttftTotalMs = 0;
  private ttftSampleCount = 0;

  private readonly turnPerformance = new TurnPerformanceTracker();

  private static readonly ANALYSIS_WORKBENCH_TRACE_LIMIT = 50;
  private static readonly ANALYSIS_WORKBENCH_DASHBOARD_LIMIT = 5;

  private analysisWorkbenchTraces: AnalysisWorkbenchTraceView[] = [];

  constructor(private readonly deps: {
    getMemoryStatsForRequest: (
      context: GardenRequestContext | undefined,
    ) => ReturnType<MemoryStorePort['getStats']>;
    sessionStore: SessionStore;
    sessionManager?: SessionManager;
    scheduler: Scheduler;
    shardManager: ShardExecutionPort;
    eventBus: EventBus;
    modelUsageService?: AdminModelUsageService | null;
    adaptiveToolsService?: AdminAdaptiveToolsService | null;
    analysisWorkbenchTraceStore?: AnalysisWorkbenchTraceStorePort | null;
    resolveLastActiveSessionId?: () => string | null;
    now?: () => number;
    intentionFollowUpRuntime?: {
      nearTermHorizonMs: number;
      pendingFollowUpStore: Pick<PendingFollowUpStorePort, 'list'>;
      scheduledPromptStore: Pick<ScheduledPromptStorePort, 'listPending'>;
    } | null;
  }) {
    this.deps.eventBus.on('agent.turn.usage', ({ message, usage }) => {
      const contextUtilization = AdminDashboardDataService.normalizeContextUtilization(usage.contextUtilization);
      this.transientTurnsSinceOperatorStart += 1;

      const usageSessionId = this.resolveUsageSessionId(message.channelId);
      if (usageSessionId) {
        this.sessionContextUtilizationBySession.set(usageSessionId, contextUtilization);
        this.latestUsageSessionId = usageSessionId;
      }

    });

    this.deps.eventBus.on('agent.turn.stage', (payload) => {
      if (payload.stage !== 'first-token') return;
      const ttftMs = AdminDashboardDataService.normalizeOptionalDuration(payload.ttftMs);
      if (ttftMs === null) return;
      this.latestTtftMs = ttftMs;
      this.ttftTotalMs += ttftMs;
      this.ttftSampleCount += 1;
    });

    this.deps.eventBus.on('agent.turn.performance', (payload) => {
      this.turnPerformance.observe(payload);
    });

    this.deps.eventBus.on('agent.analysis_workbench.trace', ({ timestamp, task, result }) => {
      const trace: AnalysisWorkbenchTraceView = {
        timestamp,
        task,
        outcome: result.outcome,
        continuation: result.continuation,
        sessionCostUsd: result.sessionCostUsd,
        limitPolicy: result.limitPolicy,
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
      if (this.analysisWorkbenchTraces.length > AdminDashboardDataService.ANALYSIS_WORKBENCH_TRACE_LIMIT) {
        this.analysisWorkbenchTraces.length = AdminDashboardDataService.ANALYSIS_WORKBENCH_TRACE_LIMIT;
      }
      this.persistAnalysisWorkbenchTrace(trace);
    });

    // vb11: rehydrate the ring from durable storage so traces recorded before a
    // Garden/agent restart remain visible on the /analysis-workbench page.
    void this.hydrateAnalysisWorkbenchTraces();
  }

  /** Recent REPL traces with full step detail for the workbench drill-down page. */
  listAnalysisWorkbenchTraces(): AnalysisWorkbenchTraceView[] {
    return [...this.analysisWorkbenchTraces];
  }

  private persistAnalysisWorkbenchTrace(trace: AnalysisWorkbenchTraceView): void {
    const store = this.deps.analysisWorkbenchTraceStore;
    if (!store) return;
    store.record(trace).catch((error) => {
      log.error('Failed to persist analysis-workbench trace', { error: toErrorMessage(error) });
    });
  }

  private async hydrateAnalysisWorkbenchTraces(): Promise<void> {
    const store = this.deps.analysisWorkbenchTraceStore;
    if (!store) return;
    try {
      const persisted = await store.listRecent(AdminDashboardDataService.ANALYSIS_WORKBENCH_TRACE_LIMIT);
      // Live traces that arrived during hydration stay at the front; append the
      // durable, older traces behind them (deduped by timestamp) and re-bound.
      const seen = new Set(this.analysisWorkbenchTraces.map((trace) => trace.timestamp));
      const merged = [
        ...this.analysisWorkbenchTraces,
        ...persisted.filter((trace) => !seen.has(trace.timestamp)),
      ];
      merged.sort((a, b) => b.timestamp - a.timestamp);
      this.analysisWorkbenchTraces = merged.slice(0, AdminDashboardDataService.ANALYSIS_WORKBENCH_TRACE_LIMIT);
    } catch (error) {
      log.error('Failed to hydrate analysis-workbench traces from durable storage', {
        error: toErrorMessage(error),
      });
    }
  }

  private static normalizeContextUtilization(value: number): number {
    return Number.isFinite(value) && value > 0
      ? value
      : 0;
  }

  private static normalizeOptionalDuration(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : null;
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

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private static earliestTimestamp(
    values: readonly (string | undefined)[],
  ): number | null {
    let earliest: number | null = null;
    for (const value of values) {
      if (!value) continue;
      const timestamp = Date.parse(value);
      if (!Number.isFinite(timestamp)) continue;
      earliest = earliest === null ? timestamp : Math.min(earliest, timestamp);
    }
    return earliest;
  }

  private async getIntentionFollowUpRouting() {
    const observedAtMs = this.now();
    const runtime = this.deps.intentionFollowUpRuntime;
    if (!runtime) {
      return {
        horizonSource: 'unavailable' as const,
        nearTermHorizonMs: null,
        evidenceLimit: INTENTION_EVIDENCE_LIMIT,
        observedAtMs,
        handoff: {
          disposition: 'handoff' as const,
          reason: 'active_pending_follow_up' as const,
          available: false,
          observedCount: null,
          earliestDueAtMs: null,
          atReadLimit: false,
        },
        scheduled: {
          disposition: 'scheduled' as const,
          reason: 'pending_intention_scheduled_prompt' as const,
          available: false,
          observedCount: null,
          earliestDueAtMs: null,
          atReadLimit: false,
        },
      };
    }

    const [handoffResult, scheduledResult] = await Promise.allSettled([
      runtime.pendingFollowUpStore.list({
        includeActivated: false,
        includeExpired: false,
        asOf: new Date(observedAtMs).toISOString(),
        limit: INTENTION_EVIDENCE_LIMIT,
      }),
      runtime.scheduledPromptStore.listPending({
        source: 'intention_appraisal',
        limit: INTENTION_EVIDENCE_LIMIT,
      }),
    ]);
    if (handoffResult.status === 'rejected') {
      log.warn('Failed to read pending intention handoff evidence', {
        error: toErrorMessage(handoffResult.reason),
      });
    }
    if (scheduledResult.status === 'rejected') {
      log.warn('Failed to read scheduled intention evidence', {
        error: toErrorMessage(scheduledResult.reason),
      });
    }
    const handoffs = handoffResult.status === 'fulfilled' ? handoffResult.value : null;
    const pendingScheduledPrompts = scheduledResult.status === 'fulfilled'
      ? scheduledResult.value
      : null;

    return {
      horizonSource: 'effective_scheduler_config' as const,
      nearTermHorizonMs: runtime.nearTermHorizonMs,
      evidenceLimit: INTENTION_EVIDENCE_LIMIT,
      observedAtMs,
      handoff: {
        disposition: 'handoff' as const,
        reason: 'active_pending_follow_up' as const,
        available: handoffs !== null,
        observedCount: handoffs?.length ?? null,
        earliestDueAtMs: handoffs
          ? AdminDashboardDataService.earliestTimestamp(handoffs.map(record => record.dueAt))
          : null,
        atReadLimit: handoffs?.length === INTENTION_EVIDENCE_LIMIT,
      },
      scheduled: {
        disposition: 'scheduled' as const,
        reason: 'pending_intention_scheduled_prompt' as const,
        available: pendingScheduledPrompts !== null,
        observedCount: pendingScheduledPrompts?.length ?? null,
        earliestDueAtMs: pendingScheduledPrompts
          ? AdminDashboardDataService.earliestTimestamp(
            pendingScheduledPrompts.map(record => record.runAt),
          )
          : null,
        atReadLimit: scheduledResult.status === 'fulfilled'
          && scheduledResult.value.length === INTENTION_EVIDENCE_LIMIT,
      },
    };
  }

  private unavailableModelUsage(selected: DashboardCostWindow): DashboardModelUsageProjection {
    return {
      selected,
      usage: null,
      sparkline: [],
      freshness: {
        state: 'unavailable',
        source: 'postgres_model_usage',
        refreshedAtMs: null,
        dataThroughMs: null,
        latestEventAtMs: null,
        refreshIntervalMs: DASHBOARD_MODEL_USAGE_REFRESH_INTERVAL_MS,
        message: 'Durable model-usage storage is unavailable.',
      },
    };
  }

  private staleModelUsage(
    selected: DashboardCostWindow,
    cached: CachedDashboardModelUsage,
  ): DashboardModelUsageProjection {
    return {
      selected,
      usage: cached.usage,
      sparkline: cached.sparkline,
      freshness: {
        state: 'stale',
        source: 'postgres_model_usage',
        refreshedAtMs: cached.refreshedAtMs,
        dataThroughMs: cached.dataThroughMs,
        latestEventAtMs: cached.latestEventAtMs,
        refreshIntervalMs: DASHBOARD_MODEL_USAGE_REFRESH_INTERVAL_MS,
        message: 'Latest refresh failed; showing the last successful durable snapshot.',
      },
    };
  }

  private async getModelUsage(selected: DashboardCostWindow): Promise<DashboardModelUsageProjection> {
    if (!this.deps.modelUsageService) {
      return this.unavailableModelUsage(selected);
    }

    const dataThroughMs = this.now();
    const range = resolveDashboardCostWindowRange(selected, dataThroughMs);
    const requestSequence = ++this.modelUsageRequestSequence;
    this.latestModelUsageRequestByWindow.set(selected, requestSequence);

    try {
      const data = await this.deps.modelUsageService.getModelUsageData({
        ...range,
        bucket: resolveDashboardCostWindowBucket(selected),
        limit: 1,
      });
      const snapshot: CachedDashboardModelUsage = {
        usage: mapModelUsageTotalsToDashboardUsage(data.totals),
        sparkline: mapModelUsageTimeSeriesToDashboardSparkline(data.timeSeries),
        sinceMs: range.sinceMs,
        refreshedAtMs: this.now(),
        dataThroughMs,
        latestEventAtMs: data.recentEvents[0]?.recordedAtMs ?? null,
      };
      if (this.latestModelUsageRequestByWindow.get(selected) === requestSequence) {
        this.lastSuccessfulModelUsageByWindow.set(selected, snapshot);
      }
      return {
        selected,
        usage: snapshot.usage,
        sparkline: snapshot.sparkline,
        freshness: {
          state: 'fresh',
          source: 'postgres_model_usage',
          refreshedAtMs: snapshot.refreshedAtMs,
          dataThroughMs: snapshot.dataThroughMs,
          latestEventAtMs: snapshot.latestEventAtMs,
          refreshIntervalMs: DASHBOARD_MODEL_USAGE_REFRESH_INTERVAL_MS,
        },
      };
    } catch (error) {
      log.warn('Failed to refresh dashboard model usage from durable storage', {
        selected,
        error: error instanceof Error ? error.message : String(error),
      });
      const cached = this.lastSuccessfulModelUsageByWindow.get(selected);
      return cached?.sinceMs === range.sinceMs
        ? this.staleModelUsage(selected, cached)
        : this.unavailableModelUsage(selected);
    }
  }

  async getDashboardData(
    options: { costWindow?: DashboardCostWindow } = {},
    context?: GardenRequestContext,
  ): Promise<AdminDashboardData> {
    const selectedCostWindow = options.costWindow ?? 'today';
    const [modelUsage, memStats, toolStatus, intentionFollowUpRouting] = await Promise.all([
      this.getModelUsage(selectedCostWindow),
      this.deps.getMemoryStatsForRequest(context),
      this.getToolStatus(),
      this.getIntentionFollowUpRouting(),
    ]);
    const channels = this.deps.sessionStore.listChannels();
    return {
      stats: {
        memoryTotal: memStats.total,
        memoryByType: memStats.byType,
        avgSalience: memStats.avgSalience,
        sessionCount: channels.length,
        schedulerTasks: this.deps.scheduler.taskCount,
        activeShards: this.deps.shardManager.getActiveCount(),
        modelUsage,
        transientSessionTelemetry: {
          source: 'live_event_bus',
          turnsSinceOperatorStart: this.transientTurnsSinceOperatorStart,
          lastTtftMs: this.latestTtftMs,
          averageTtftMs: this.ttftSampleCount > 0
            ? this.ttftTotalMs / this.ttftSampleCount
            : null,
          latencyPercentiles: this.turnPerformance.snapshot(),
          recentLatencyWaterfalls: this.turnPerformance.recentWaterfalls(),
          activeSessionContextPressure: this.getActiveSessionContextPressure(),
        },
        intentionFollowUpRouting,
        toolStatus,
        recentAnalysisWorkbenchTraces: this.analysisWorkbenchTraces.slice(
          0,
          AdminDashboardDataService.ANALYSIS_WORKBENCH_DASHBOARD_LIMIT,
        ),
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
