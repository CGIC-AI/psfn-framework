<script lang="ts">
  import { onMount } from 'svelte';
  import { getDashboard } from '$lib/api/endpoints/dashboard';
  import {
    beginDashboardCostWindowSelection,
    commitDashboardCostWindowSelection,
    createDashboardCostWindowSelection,
    DASHBOARD_COST_WINDOW_OPTIONS,
    DASHBOARD_MODEL_USAGE_POLL_INTERVAL_MS,
    buildDashboardAccountingPath,
    rejectDashboardCostWindowSelection,
    resolveDashboardCostWindow,
    shouldPublishDashboardResponse,
    shouldSurfaceDashboardRequestError,
  } from '$lib/dashboard/cost-window';
  import { resolveSessionContextPressureView } from '$lib/dashboard/session-context-pressure';
  import { scopeGardenPath } from '$lib/fleet/companion-scope';
  import type { AdminDashboardData, DashboardCostWindow } from '$lib/types';
  import ActiveConcernsCard from '$lib/components/garden/ActiveConcernsCard.svelte';
  import Sparkline from '$lib/components/accounting/charts/Sparkline.svelte';
  import AnalysisTracesTable from '$lib/components/dashboard/AnalysisTracesTable.svelte';
  import ContextAllocationPanel from '$lib/components/dashboard/ContextAllocationPanel.svelte';
  import DashboardHeader from '$lib/components/dashboard/DashboardHeader.svelte';
  import DashboardStatCard from '$lib/components/dashboard/DashboardStatCard.svelte';
  import LatencyWaterfalls from '$lib/components/dashboard/LatencyWaterfalls.svelte';
  import MemoryBreakdownPanel from '$lib/components/dashboard/MemoryBreakdownPanel.svelte';
  import RuntimeStrip from '$lib/components/dashboard/RuntimeStrip.svelte';
  import TokenUsagePanel from '$lib/components/dashboard/TokenUsagePanel.svelte';
  import ToolStatusPanel from '$lib/components/dashboard/ToolStatusPanel.svelte';

  let data = $state<AdminDashboardData | null>(null);
  let error = $state('');
  let loading = $state(true);
  let costWindowSelection = $state(createDashboardCostWindowSelection('today'));
  let costWindowLoading = $state(false);
  let backgroundRefreshLoading = $state(false);
  let costWindowRefreshError = $state('');
  let latestDashboardRequestId = 0;

  function costWindowHint(window: DashboardCostWindow): string {
    const hints: Record<DashboardCostWindow, string> = {
      today: 'today',
      week: 'this week',
      month: 'this month',
      quarter: 'this quarter',
    };
    return hints[window];
  }

  async function loadDashboard(costWindow: DashboardCostWindow, mode: 'initial' | 'refresh' | 'poll'): Promise<void> {
    const requestId = ++latestDashboardRequestId;
    if (mode === 'initial') {
      error = '';
    } else if (mode === 'refresh') {
      costWindowLoading = true;
      costWindowRefreshError = '';
    } else {
      backgroundRefreshLoading = true;
    }

    try {
      const payload = await getDashboard(costWindow);
      if (!shouldPublishDashboardResponse(requestId, latestDashboardRequestId)) return;
      data = payload;
      costWindowSelection = commitDashboardCostWindowSelection(
        costWindowSelection,
        resolveDashboardCostWindow(payload.stats?.modelUsage?.selected ?? costWindow),
      );
      costWindowRefreshError = '';
    } catch (e) {
      if (!shouldSurfaceDashboardRequestError(e, requestId, latestDashboardRequestId)) return;
      const message = e instanceof Error ? e.message : 'Failed to load dashboard';
      if (mode === 'initial') {
        error = message;
      } else {
        costWindowRefreshError = message;
        if (mode === 'refresh') {
          costWindowSelection = rejectDashboardCostWindowSelection(costWindowSelection);
        }
      }
    } finally {
      if (mode === 'poll') backgroundRefreshLoading = false;
      if (!shouldPublishDashboardResponse(requestId, latestDashboardRequestId)) return;
      if (mode === 'initial') {
        loading = false;
      } else if (mode === 'refresh') {
        costWindowLoading = false;
      }
    }
  }

  function selectCostWindow(window: DashboardCostWindow): void {
    if (window === costWindowSelection.committed || costWindowLoading) return;
    costWindowSelection = beginDashboardCostWindowSelection(costWindowSelection, window);
    void loadDashboard(window, 'refresh');
  }

  onMount(() => {
    void loadDashboard(costWindowSelection.committed, 'initial');
    const refreshTimer = window.setInterval(() => {
      if (!loading && !costWindowLoading && !backgroundRefreshLoading) {
        void loadDashboard(costWindowSelection.committed, 'poll');
      }
    }, DASHBOARD_MODEL_USAGE_POLL_INTERVAL_MS);
    return () => window.clearInterval(refreshTimer);
  });

  function formatTokens(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return String(value);
  }

  function formatCost(value: number): string {
    return `$${value.toFixed(4)}`;
  }

  function formatDuration(value: number): string {
    if (value >= 60_000) return `${(value / 60_000).toFixed(1)}m`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}s`;
    return `${value}ms`;
  }

  function formatOptionalDuration(value: number | null | undefined): string {
    return typeof value === 'number' && Number.isFinite(value) ? formatDuration(Math.round(value)) : '—';
  }

  function formatFreshnessTimestamp(value: number | null): string {
    return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toLocaleTimeString() : 'never';
  }
</script>

<div class="space-y-4">
  <DashboardHeader
    options={DASHBOARD_COST_WINDOW_OPTIONS}
    selectedWindow={costWindowSelection.committed}
    loading={loading || costWindowLoading || backgroundRefreshLoading}
    controlsDisabled={loading || costWindowLoading || !data}
    freshnessState={loading ? 'loading' : data?.stats.modelUsage.freshness.state ?? 'unavailable'}
    refreshedAt={data ? formatFreshnessTimestamp(data.stats.modelUsage.freshness.refreshedAtMs) : 'awaiting first response'}
    freshnessMessage={data?.stats.modelUsage.freshness.message}
    refreshError={costWindowRefreshError || error}
    onSelectWindow={selectCostWindow}
  />

  {#if loading}
    <section aria-label="Loading dashboard" aria-busy="true" class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {#each Array(4) as _, index (index)}
        <div class="card-garden min-h-40 animate-pulse p-4">
          <div class="h-3 w-24 rounded bg-bark-300"></div>
          <div class="mt-5 h-8 w-28 rounded bg-bark-300"></div>
          <div class="mt-3 h-3 w-40 max-w-full rounded bg-bark-200"></div>
        </div>
      {/each}
    </section>
  {:else if error}
    <section class="card-garden border-wilt-400 p-6" role="alert">
      <h2 class="font-serif text-lg text-wilt-800">Failed to load dashboard</h2>
      <p class="mt-1 text-sm text-wilt-700">{error}</p>
    </section>
  {:else if data}
    {@const stats = data.stats}
    {@const committedCostWindow = costWindowSelection.committed}
    {@const selectedCostWindowUsage = stats.modelUsage.usage}
    {@const modelUsageTokenTrend = stats.modelUsage.sparkline.map((point) => point.totalTokens)}
    {@const modelUsageCostTrend = stats.modelUsage.sparkline.map((point) => point.effectiveCostUsd)}
    {@const modelUsageFreshness = stats.modelUsage.freshness}
    {@const transientSessionTelemetry = stats.transientSessionTelemetry}
    {@const sessionContextPressure = resolveSessionContextPressureView(transientSessionTelemetry.activeSessionContextPressure)}

    <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      Durable model usage is {modelUsageFreshness.state}.
      {#if modelUsageFreshness.state !== 'fresh' && modelUsageFreshness.message}
        {modelUsageFreshness.message}
      {/if}
    </p>

    {#if !selectedCostWindowUsage}
      <p class="sr-only">Unavailable</p>
    {/if}

    <section
      id="overview"
      aria-label="Dashboard overview"
      aria-busy={costWindowLoading || backgroundRefreshLoading}
      class="scroll-mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
    >
      <DashboardStatCard
        label="Memories"
        value={stats.memoryTotal.toLocaleString()}
        hint={`Average salience ${(stats.avgSalience * 100).toFixed(0)}%`}
        href={scopeGardenPath('/memory')}
      />
      <DashboardStatCard
        label="Sessions"
        value={stats.sessionCount.toLocaleString()}
        hint={`${transientSessionTelemetry.turnsSinceOperatorStart.toLocaleString()} live turn events since operator start`}
        href={scopeGardenPath('/sessions')}
      />
      <DashboardStatCard
        label={`Total tokens · ${costWindowHint(committedCostWindow)}`}
        value={selectedCostWindowUsage ? formatTokens(selectedCostWindowUsage.totalTokens) : 'Unavailable'}
        hint={selectedCostWindowUsage
          ? `${formatTokens(selectedCostWindowUsage.inputTokens)} in / ${formatTokens(selectedCostWindowUsage.outputTokens)} out`
          : 'Durable usage storage could not be read.'}
        href={scopeGardenPath(buildDashboardAccountingPath(committedCostWindow))}
        actionLabel="Analyze"
        busy={costWindowLoading || backgroundRefreshLoading}
        unavailable={!selectedCostWindowUsage}
      >
        <div class="text-petal-500">
          <Sparkline
            values={modelUsageTokenTrend}
            width={220}
            height={32}
            ariaLabel={`Total token usage trend for ${costWindowHint(committedCostWindow)}`}
          />
        </div>
      </DashboardStatCard>
      <DashboardStatCard
        label={`Model cost · ${costWindowHint(committedCostWindow)}`}
        value={selectedCostWindowUsage ? formatCost(selectedCostWindowUsage.effectiveCostUsd) : 'Unavailable'}
        hint={selectedCostWindowUsage
          ? selectedCostWindowUsage.calls > 0
            ? `${selectedCostWindowUsage.calls.toLocaleString()} calls · provider ${formatCost(selectedCostWindowUsage.providerCostUsd)} · estimated ${formatCost(selectedCostWindowUsage.estimatedCostUsd)}`
            : 'No durable model usage in this window yet.'
          : 'Durable usage storage could not be read.'}
        href={scopeGardenPath(buildDashboardAccountingPath(committedCostWindow))}
        actionLabel="Analyze"
        busy={costWindowLoading || backgroundRefreshLoading}
        unavailable={!selectedCostWindowUsage}
      >
        <div class="text-gold-600">
          <Sparkline
            values={modelUsageCostTrend}
            width={220}
            height={32}
            ariaLabel={`Effective model cost trend for ${costWindowHint(committedCostWindow)}`}
          />
        </div>
      </DashboardStatCard>
    </section>

    <div class="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div class="min-w-0 space-y-4">
        <ToolStatusPanel tools={stats.toolStatus} />

        <div class="grid items-start gap-4 xl:grid-cols-2">
          <MemoryBreakdownPanel
            memoryByType={stats.memoryByType}
            total={stats.memoryTotal}
            avgSalience={stats.avgSalience}
          />
          <TokenUsagePanel
            usage={selectedCostWindowUsage}
            window={committedCostWindow}
            loading={costWindowLoading || backgroundRefreshLoading}
            transientTelemetry={transientSessionTelemetry}
            {formatTokens}
            {formatCost}
            formatDuration={formatOptionalDuration}
          />
        </div>

        <LatencyWaterfalls
          waterfalls={transientSessionTelemetry.recentLatencyWaterfalls}
          {formatDuration}
          formatTimestamp={formatFreshnessTimestamp}
        />

        <AnalysisTracesTable
          traces={stats.recentAnalysisWorkbenchTraces}
          {formatTokens}
          {formatDuration}
        />
      </div>

      <aside class="space-y-4" aria-label="Runtime and companion context">
        <RuntimeStrip
          schedulerTasks={stats.schedulerTasks}
          activeShards={stats.activeShards}
          contextPressure={sessionContextPressure}
          lastTtft={formatOptionalDuration(transientSessionTelemetry.lastTtftMs)}
          averageTtft={formatOptionalDuration(transientSessionTelemetry.averageTtftMs)}
        />
        <ContextAllocationPanel />
        <ActiveConcernsCard />
      </aside>
    </div>
  {/if}
</div>
