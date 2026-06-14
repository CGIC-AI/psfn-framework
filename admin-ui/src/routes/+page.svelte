<script lang="ts">
  import { onMount } from 'svelte';
  import { getDashboard } from '$lib/api/endpoints/dashboard';
  import {
    DASHBOARD_COST_WINDOW_OPTIONS,
    resolveDashboardCostWindow,
    resolveSelectedDashboardCostWindowUsage,
  } from '$lib/dashboard/cost-window';
  import { resolveSessionContextPressureView } from '$lib/dashboard/session-context-pressure';
  import type { AdminDashboardData, DashboardCostWindow } from '$lib/types';

  let data = $state<AdminDashboardData | null>(null);
  let error = $state('');
  let loading = $state(true);
  let selectedCostWindow = $state<DashboardCostWindow>('today');
  let costWindowLoading = $state(false);
  let costWindowRefreshError = $state('');
  let latestDashboardRequestId = 0;

  function costWindowHint(window: DashboardCostWindow): string {
    const hints: Record<DashboardCostWindow, string> = {
      today: 'today',
      week: 'this week',
      month: 'this month',
    };
    return hints[window];
  }

  async function loadDashboard(costWindow: DashboardCostWindow, mode: 'initial' | 'refresh'): Promise<void> {
    const requestId = ++latestDashboardRequestId;
    if (mode === 'initial') {
      error = '';
    } else {
      costWindowLoading = true;
      costWindowRefreshError = '';
    }

    try {
      const payload = await getDashboard(costWindow);
      if (requestId !== latestDashboardRequestId) return;
      data = payload;
      selectedCostWindow = resolveDashboardCostWindow(
        payload.stats?.sessionUsage?.costWindows?.selected ?? costWindow,
      );
    } catch (e) {
      if (requestId !== latestDashboardRequestId) return;
      const message = e instanceof Error ? e.message : 'Failed to load dashboard';
      if (mode === 'initial') {
        error = message;
      } else {
        costWindowRefreshError = message;
      }
    } finally {
      if (requestId !== latestDashboardRequestId) return;
      if (mode === 'initial') {
        loading = false;
      } else {
        costWindowLoading = false;
      }
    }
  }

  function selectCostWindow(window: DashboardCostWindow): void {
    if (window === selectedCostWindow || costWindowLoading) return;
    selectedCostWindow = window;
    void loadDashboard(window, 'refresh');
  }

  onMount(() => {
    void loadDashboard(selectedCostWindow, 'initial');
  });

  function formatTokens(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
  }

  function formatCost(n: number): string {
    return '$' + n.toFixed(4);
  }

  function formatDuration(ms: number): string {
    if (ms >= 60_000) return (ms / 60_000).toFixed(1) + 'm';
    if (ms >= 1_000) return (ms / 1_000).toFixed(1) + 's';
    return ms + 'ms';
  }

  function formatOptionalDuration(ms: number | null | undefined): string {
    return typeof ms === 'number' && Number.isFinite(ms)
      ? formatDuration(Math.round(ms))
      : '—';
  }

  function toolStatusColor(status: string): string {
    const colors: Record<string, string> = {
      healthy: 'bg-moss-50 text-moss-700 border-moss-300',
      degraded: 'bg-gold-50 text-gold-700 border-gold-300',
      unavailable: 'bg-wilt-50 text-wilt-700 border-wilt-300',
      not_applicable: 'bg-bark-100 text-shadow-600 border-bark-300',
    };
    return colors[status] ?? 'bg-bark-100 text-shadow-700 border-bark-300';
  }

  function toolStatusLabel(status: string): string {
    if (status === 'not_applicable') return 'n/a';
    return status;
  }

  function memoryTypeColor(type: string): string {
    const colors: Record<string, string> = {
      episodic: 'bg-moss-50 text-moss-700 border-moss-300',
      semantic: 'bg-gold-50 text-gold-700 border-gold-300',
      emotional: 'bg-petal-50 text-petal-500 border-petal-300',
      procedural: 'bg-bark-200 text-shadow-700 border-bark-400',
      reflection: 'bg-shadow-50 text-shadow-700 border-shadow-200',
      relational: 'bg-petal-100 text-petal-500 border-petal-300',
    };
    return colors[type] ?? 'bg-bark-200 text-shadow-700 border-bark-400';
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="font-serif text-2xl text-bark-900 font-semibold">The Trunk</h1>
    <p class="text-bark-700 text-sm mt-1">Dashboard overview</p>
  </div>

  {#if loading}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {#each Array(4) as _}
        <div class="card-garden p-5 animate-pulse">
          <div class="h-4 bg-bark-300 rounded w-24 mb-3"></div>
          <div class="h-8 bg-bark-300 rounded w-16"></div>
        </div>
      {/each}
    </div>
  {:else if error}
    <div class="card-garden p-6 border-wilt-400">
      <p class="text-wilt-600 font-medium">Failed to load dashboard</p>
      <p class="text-shadow-600 text-sm mt-1">{error}</p>
    </div>
  {:else if data}
    {@const stats = data.stats}
    {@const selectedCostWindowUsage = resolveSelectedDashboardCostWindowUsage(
      stats.sessionUsage?.costWindows?.byWindow,
      selectedCostWindow,
    )}
    {@const sessionContextPressure = resolveSessionContextPressureView(stats.sessionUsage?.activeSessionContextPressure)}
    <!-- Stat cards -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <a href="/memory" class="card-garden p-5 hover:border-gold-400 hover:shadow-md transition-all cursor-pointer block">
        <p class="text-sm text-shadow-700 uppercase tracking-wide font-medium">Memories</p>
        <p class="text-2xl font-serif text-shadow-900 mt-1">{stats.memoryTotal.toLocaleString()}</p>
        <p class="text-sm text-shadow-600 mt-1">Avg salience: {(stats.avgSalience * 100).toFixed(0)}%</p>
      </a>

      <a href="/sessions" class="card-garden p-5 hover:border-gold-400 hover:shadow-md transition-all cursor-pointer block">
        <p class="text-sm text-shadow-700 uppercase tracking-wide font-medium">Sessions</p>
        <p class="text-2xl font-serif text-shadow-900 mt-1">{stats.sessionCount}</p>
        <p class="text-sm text-shadow-600 mt-1">{stats.sessionUsage.turns} turns total</p>
      </a>

      <div class="card-garden p-5">
        <p class="text-sm text-shadow-700 uppercase tracking-wide font-medium">Total Tokens <span class="text-shadow-600 normal-case font-normal">(current session)</span></p>
        <p class="text-2xl font-serif text-shadow-900 mt-1">
          {formatTokens(stats.sessionUsage.inputTokens + stats.sessionUsage.outputTokens)}
        </p>
        <p class="text-sm text-shadow-600 mt-1">
          {formatTokens(stats.sessionUsage.inputTokens)} in / {formatTokens(stats.sessionUsage.outputTokens)} out
        </p>
      </div>

      <div class="card-garden p-5">
        <p class="text-sm text-shadow-700 uppercase tracking-wide font-medium">
          Estimated Cost <span class="text-shadow-600 normal-case font-normal">({costWindowHint(selectedCostWindow)})</span>
        </p>
        <p class="text-2xl font-serif text-shadow-900 mt-1">
          {formatCost(selectedCostWindowUsage.estimatedCostUsd)}
        </p>
        {#if selectedCostWindowUsage.turns > 0}
          <p class="text-sm text-shadow-600 mt-1">
            {selectedCostWindowUsage.llmCalls} LLM calls, {selectedCostWindowUsage.toolCalls} tool calls over {selectedCostWindowUsage.turns} turns
          </p>
        {:else}
          <p class="text-sm text-shadow-600 mt-1">No telemetry in this window yet.</p>
        {/if}
        <div class="mt-3">
          <div class="inline-flex rounded-lg border border-bark-300 bg-bark-100 p-1 gap-1">
            {#each DASHBOARD_COST_WINDOW_OPTIONS as option (option.value)}
              <button
                type="button"
                class="px-2.5 py-1 text-xs font-medium rounded-md transition-colors disabled:opacity-60 disabled:cursor-not-allowed {option.value === selectedCostWindow ? 'bg-gold-300 text-shadow-900' : 'text-shadow-700 hover:bg-bark-200'}"
                aria-pressed={option.value === selectedCostWindow}
                disabled={costWindowLoading}
                onclick={() => selectCostWindow(option.value)}
              >
                {option.label}
              </button>
            {/each}
          </div>
          {#if costWindowRefreshError}
            <p class="text-xs text-wilt-600 mt-2">{costWindowRefreshError}</p>
          {/if}
        </div>
      </div>
    </div>

    <div class="card-garden p-5">
      <div class="flex items-center justify-between gap-3 mb-3">
        <h2 class="font-serif text-lg text-shadow-900">Tool Status</h2>
        <a href="/tools" class="text-sm font-medium text-gold-700 hover:text-gold-800">Open Tools</a>
      </div>
      {#if stats.toolStatus.length > 0}
        <div class="flex flex-wrap gap-2">
          {#each stats.toolStatus.slice(0, 28) as tool}
            <span
              class="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs font-medium {toolStatusColor(tool.status)}"
              title={tool.detail ?? tool.status}
            >
              <span>{tool.name}</span>
              <span class="font-mono opacity-80">{toolStatusLabel(tool.status)}</span>
            </span>
          {/each}
        </div>
      {:else}
        <p class="text-sm text-shadow-600">No tool health snapshot is available yet.</p>
      {/if}
    </div>

    <!-- Memory breakdown + Token usage -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <!-- Memory by type -->
      <div class="card-garden p-5">
        <h2 class="font-serif text-lg text-shadow-900 mb-3">Memory Breakdown</h2>
        <div class="space-y-2">
          {#each Object.entries(stats.memoryByType) as [type, count]}
            <a href="/memory?type={encodeURIComponent(type)}"
              class="flex items-center gap-3 hover:bg-bark-50 rounded-lg px-1 py-0.5 -mx-1 transition-colors cursor-pointer">
              <span class="px-2 py-0.5 text-sm rounded border {memoryTypeColor(type)} min-w-24 text-center">
                {type}
              </span>
              <div class="flex-1 h-2 bg-bark-300 rounded-full overflow-hidden">
                <div
                  class="h-full bg-gold-400 rounded-full transition-all"
                  style="width: {stats.memoryTotal > 0 ? ((count as number) / stats.memoryTotal * 100) : 0}%"
                ></div>
              </div>
              <span class="text-sm text-shadow-800 tabular-nums w-12 text-right font-medium">{count}</span>
            </a>
          {/each}
        </div>
      </div>

      <!-- Token usage breakdown (current session) -->
      <div class="card-garden p-5">
        <h2 class="font-serif text-lg text-shadow-900 mb-3">Token Usage</h2>
        {#if stats.sessionUsage.turns > 0}
          <div class="space-y-4">
            <div class="grid grid-cols-2 gap-3">
              <div class="bg-bark-100 rounded-lg p-3">
                <span class="text-sm text-shadow-600 block">Input Tokens</span>
                <span class="text-lg font-serif text-shadow-900">{formatTokens(stats.sessionUsage.inputTokens)}</span>
              </div>
              <div class="bg-bark-100 rounded-lg p-3">
                <span class="text-sm text-shadow-600 block">Output Tokens</span>
                <span class="text-lg font-serif text-shadow-900">{formatTokens(stats.sessionUsage.outputTokens)}</span>
              </div>
              <div class="bg-bark-100 rounded-lg p-3">
                <span class="text-sm text-shadow-600 block">Cache Read Tokens</span>
                <span class="text-lg font-serif text-shadow-900">{formatTokens(stats.sessionUsage.cacheReadTokens)}</span>
              </div>
              <div class="bg-bark-100 rounded-lg p-3">
                <span class="text-sm text-shadow-600 block">Avg per Turn</span>
                <span class="text-lg font-serif text-shadow-900">
                  {formatTokens(Math.round((stats.sessionUsage.inputTokens + stats.sessionUsage.outputTokens) / stats.sessionUsage.turns))}
                </span>
              </div>
              <div class="bg-bark-100 rounded-lg p-3">
                <span class="text-sm text-shadow-600 block">Last TTFT</span>
                <span class="text-lg font-serif text-shadow-900">{formatOptionalDuration(stats.sessionUsage.lastTtftMs)}</span>
              </div>
              <div class="bg-bark-100 rounded-lg p-3">
                <span class="text-sm text-shadow-600 block">Avg TTFT</span>
                <span class="text-lg font-serif text-shadow-900">{formatOptionalDuration(stats.sessionUsage.averageTtftMs)}</span>
              </div>
            </div>
            <p class="text-sm text-shadow-600">
              Current-session telemetry is shown here. Persisted per-model usage is available on Charge / Budget.
            </p>
          </div>
        {:else}
          <div class="text-center py-6">
            <p class="text-sm text-shadow-600">No turns recorded yet. Token usage will appear here after the first conversation turn.</p>
          </div>
        {/if}
      </div>
    </div>

    <!-- Recent Analysis Workbench Traces -->
    {#if stats.recentAnalysisWorkbenchTraces.length > 0}
      <div class="card-garden p-5">
        <h2 class="font-serif text-lg text-shadow-900 mb-3">Recent Analysis Workbench Traces</h2>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-bark-300">
                <th class="text-left py-2 text-shadow-700 font-medium">Task</th>
                <th class="text-right py-2 text-shadow-700 font-medium">Iterations</th>
                <th class="text-right py-2 text-shadow-700 font-medium">Tokens</th>
                <th class="text-right py-2 text-shadow-700 font-medium">Duration</th>
                <th class="text-right py-2 text-shadow-700 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {#each stats.recentAnalysisWorkbenchTraces.slice(0, 10) as trace}
                <tr class="border-b border-bark-200 hover:bg-bark-100 transition-colors">
                  <td class="py-2 text-shadow-800 max-w-xs truncate">{trace.task}</td>
                  <td class="py-2 text-shadow-700 text-right tabular-nums">{trace.iterations}</td>
                  <td class="py-2 text-shadow-700 text-right tabular-nums">{formatTokens(trace.totalTokens)}</td>
                  <td class="py-2 text-shadow-700 text-right tabular-nums">{formatDuration(trace.durationMs)}</td>
                  <td class="py-2 text-shadow-600 text-right text-sm">
                    {new Date(trace.timestamp).toLocaleString()}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}

    <!-- Additional stats -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <a href="/scheduler" class="card-garden p-5 hover:border-gold-400 hover:shadow-md transition-all cursor-pointer block">
        <p class="text-sm text-shadow-700 uppercase tracking-wide font-medium">Scheduler Tasks</p>
        <p class="text-2xl font-serif text-shadow-900 mt-1">{stats.schedulerTasks}</p>
      </a>
      <div class="card-garden p-5">
        <p class="text-sm text-shadow-700 uppercase tracking-wide font-medium">Active Shards</p>
        <p class="text-2xl font-serif text-shadow-900 mt-1">{stats.activeShards}</p>
      </div>
      <div class="card-garden p-5">
        <p class="text-sm text-shadow-700 uppercase tracking-wide font-medium">
          Session Context Pressure <span class="text-shadow-600 normal-case font-normal">(active session)</span>
        </p>
        {#if sessionContextPressure.hasTelemetry && sessionContextPressure.isOverLimit}
          <p class="text-2xl font-serif mt-1 text-wilt-600">{sessionContextPressure.utilizationPct.toFixed(0)}%</p>
          <p class="text-sm text-wilt-600 mt-1">Exceeds 100% -- check context window configuration</p>
        {:else if sessionContextPressure.hasTelemetry}
          <p class="text-2xl font-serif mt-1 text-shadow-900">
            {sessionContextPressure.utilizationPct.toFixed(0)}%
          </p>
        {:else}
          <p class="text-2xl font-serif mt-1 text-shadow-900">0%</p>
          <p class="text-sm text-shadow-600 mt-1">No telemetry for the active session yet.</p>
        {/if}
      </div>
    </div>
  {/if}
</div>
