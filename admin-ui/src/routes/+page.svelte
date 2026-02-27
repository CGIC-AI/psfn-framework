<script lang="ts">
  import { onMount } from 'svelte';
  import { getDashboard } from '$lib/api/endpoints/dashboard';
  import type { AdminDashboardData } from '$lib/types';

  let data = $state<AdminDashboardData | null>(null);
  let error = $state('');
  let loading = $state(true);

  onMount(async () => {
    try {
      data = await getDashboard();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load dashboard';
    } finally {
      loading = false;
    }
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
    <h1 class="font-serif text-2xl text-shadow-900 font-semibold">The Trunk</h1>
    <p class="text-shadow-600 text-sm mt-1">Dashboard overview</p>
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
    <!-- Stat cards -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="card-garden p-5">
        <p class="text-sm text-shadow-700 uppercase tracking-wide font-medium">Memories</p>
        <p class="text-2xl font-serif text-shadow-900 mt-1">{stats.memoryTotal.toLocaleString()}</p>
        <p class="text-sm text-shadow-600 mt-1">Avg salience: {(stats.avgSalience * 100).toFixed(0)}%</p>
      </div>

      <div class="card-garden p-5">
        <p class="text-sm text-shadow-700 uppercase tracking-wide font-medium">Sessions</p>
        <p class="text-2xl font-serif text-shadow-900 mt-1">{stats.sessionCount}</p>
        <p class="text-sm text-shadow-600 mt-1">{stats.sessionUsage.turns} turns total</p>
      </div>

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
        <p class="text-sm text-shadow-700 uppercase tracking-wide font-medium">Estimated Cost <span class="text-shadow-600 normal-case font-normal">(since restart)</span></p>
        <p class="text-2xl font-serif text-shadow-900 mt-1">
          {formatCost(stats.sessionUsage.estimatedCostUsd)}
        </p>
        <p class="text-sm text-shadow-600 mt-1">
          {stats.sessionUsage.llmCalls} LLM calls, {stats.sessionUsage.toolCalls} tool calls
        </p>
      </div>
    </div>

    <!-- Memory breakdown + Token usage -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <!-- Memory by type -->
      <div class="card-garden p-5">
        <h2 class="font-serif text-lg text-shadow-900 mb-3">Memory Breakdown</h2>
        <div class="space-y-2">
          {#each Object.entries(stats.memoryByType) as [type, count]}
            <div class="flex items-center gap-3">
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
            </div>
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
            </div>
            <p class="text-sm text-shadow-600">
              Token usage tracking per model requires persistent storage (coming in a future release).
              Current data reflects the active session since last restart.
            </p>
          </div>
        {:else}
          <div class="text-center py-6">
            <p class="text-sm text-shadow-600">No turns recorded yet. Token usage will appear here after the first conversation turn.</p>
          </div>
        {/if}
      </div>
    </div>

    <!-- Recent Think Traces -->
    {#if stats.recentThinkTraces.length > 0}
      <div class="card-garden p-5">
        <h2 class="font-serif text-lg text-shadow-900 mb-3">Recent Think Traces</h2>
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
              {#each stats.recentThinkTraces.slice(0, 10) as trace}
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
      <div class="card-garden p-5">
        <p class="text-sm text-shadow-700 uppercase tracking-wide font-medium">Scheduler Tasks</p>
        <p class="text-2xl font-serif text-shadow-900 mt-1">{stats.schedulerTasks}</p>
      </div>
      <div class="card-garden p-5">
        <p class="text-sm text-shadow-700 uppercase tracking-wide font-medium">Active Shards</p>
        <p class="text-2xl font-serif text-shadow-900 mt-1">{stats.activeShards}</p>
      </div>
      <div class="card-garden p-5">
        <p class="text-sm text-shadow-700 uppercase tracking-wide font-medium">Context Utilization <span class="text-shadow-600 normal-case font-normal">(since restart)</span></p>
        {#if stats.sessionUsage.avgContextUtilization > 100}
          <p class="text-2xl font-serif mt-1 text-wilt-600">
            {stats.sessionUsage.avgContextUtilization.toFixed(0)}%
          </p>
          <p class="text-sm text-wilt-600 mt-1">Exceeds 100% -- check context window configuration</p>
        {:else}
          <p class="text-2xl font-serif mt-1 text-shadow-900">
            {stats.sessionUsage.avgContextUtilization.toFixed(0)}%
          </p>
        {/if}
      </div>
    </div>
  {/if}
</div>
