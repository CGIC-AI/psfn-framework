<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import { getDashboard } from '$lib/api/endpoints/dashboard';
  import type { DashboardStats, TelemetryEvent } from '$lib/types';
  import { getEvents } from '$lib/stores/telemetry.svelte';

  let stats = $state<DashboardStats | null>(null);
  let loading = $state(true);
  let error = $state('');

  const MEMORY_TYPE_COLORS: Record<string, string> = {
    episodic: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    semantic: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    emotional: 'bg-petal-100 text-petal-700 dark:bg-petal-900/30 dark:text-petal-300',
    procedural: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    boundary: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    reflection: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
    relational: 'bg-gold-100 text-gold-700 dark:bg-gold-900/30 dark:text-gold-300',
  };

  const NAV_CARDS = [
    { path: '/memory', name: 'The Roots', desc: 'Browse memories', color: 'border-moss-300 hover:border-moss-400' },
    { path: '/sessions', name: 'The Branches', desc: 'View conversations', color: 'border-gold-300 hover:border-gold-400' },
    { path: '/contacts', name: 'The Visitors', desc: 'Manage contacts', color: 'border-petal-300 hover:border-petal-400' },
    { path: '/settings', name: 'The Climate', desc: 'Configuration', color: 'border-shadow-300 hover:border-shadow-400' },
    { path: '/telemetry', name: 'The Sap', desc: 'Live events', color: 'border-blue-300 hover:border-blue-400' },
    { path: '/chat', name: 'The Canopy', desc: 'Talk to Purrsephone', color: 'border-gold-300 hover:border-gold-400' },
  ];

  onMount(async () => {
    try {
      const data = await getDashboard();
      stats = data.stats;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load dashboard';
    } finally {
      loading = false;
    }
  });

  function formatNumber(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  function formatCost(usd: number): string {
    if (usd < 0.01) return '<$0.01';
    return `$${usd.toFixed(2)}`;
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-serif font-bold text-shadow-800 dark:text-bark-200">The Trunk</h1>
    <p class="text-sm text-shadow-400 dark:text-shadow-500 mt-1">Dashboard overview of Purrsephone's mind</p>
  </div>

  {#if loading}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {#each Array(4) as _}
        <div class="card-garden p-5 animate-pulse">
          <div class="h-4 bg-bark-200 rounded w-24 mb-3"></div>
          <div class="h-8 bg-bark-200 rounded w-16"></div>
        </div>
      {/each}
    </div>
  {:else if error}
    <div class="card-garden p-6 text-center">
      <p class="text-wilt-600">{error}</p>
      <button onclick={() => location.reload()} class="mt-3 text-sm text-gold-600 hover:text-gold-700">
        Retry
      </button>
    </div>
  {:else if stats}
    <!-- Stats row -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="card-garden p-5">
        <p class="text-xs font-medium text-shadow-400 dark:text-shadow-500 uppercase tracking-wide">Total Memories</p>
        <p class="text-3xl font-serif font-bold text-shadow-800 dark:text-bark-200 mt-1">{formatNumber(stats.memoryTotal)}</p>
        <p class="text-xs text-shadow-400 dark:text-shadow-500 mt-1">Avg salience: {(stats.avgSalience * 100).toFixed(0)}%</p>
      </div>

      <div class="card-garden p-5">
        <p class="text-xs font-medium text-shadow-400 dark:text-shadow-500 uppercase tracking-wide">Sessions</p>
        <p class="text-3xl font-serif font-bold text-shadow-800 dark:text-bark-200 mt-1">{stats.sessionCount}</p>
        <p class="text-xs text-shadow-400 dark:text-shadow-500 mt-1">{stats.sessionUsage.turns} turns this session</p>
      </div>

      <div class="card-garden p-5">
        <p class="text-xs font-medium text-shadow-400 dark:text-shadow-500 uppercase tracking-wide">Token Usage</p>
        <p class="text-3xl font-serif font-bold text-shadow-800 dark:text-bark-200 mt-1">{formatNumber(stats.sessionUsage.inputTokens + stats.sessionUsage.outputTokens)}</p>
        <p class="text-xs text-shadow-400 dark:text-shadow-500 mt-1">
          {formatNumber(stats.sessionUsage.inputTokens)} in / {formatNumber(stats.sessionUsage.outputTokens)} out
        </p>
      </div>

      <div class="card-garden p-5">
        <p class="text-xs font-medium text-shadow-400 dark:text-shadow-500 uppercase tracking-wide">Session Cost</p>
        <p class="text-3xl font-serif font-bold text-shadow-800 dark:text-bark-200 mt-1">{formatCost(stats.sessionUsage.estimatedCostUsd)}</p>
        <p class="text-xs text-shadow-400 dark:text-shadow-500 mt-1">
          {stats.sessionUsage.llmCalls} LLM calls, {stats.sessionUsage.toolCalls} tool calls
        </p>
      </div>
    </div>

    <!-- Memory types + activity -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- Memory by type -->
      <div class="card-garden p-5">
        <h2 class="text-base font-serif font-semibold text-shadow-700 dark:text-bark-300 mb-3">Memory Garden</h2>
        <div class="space-y-2">
          {#each Object.entries(stats.memoryByType) as [type, count]}
            {@const pct = stats.memoryTotal > 0 ? (count / stats.memoryTotal) * 100 : 0}
            <div class="flex items-center gap-3">
              <span class="text-xs font-medium w-20 text-shadow-500 dark:text-shadow-400 capitalize">{type}</span>
              <div class="flex-1 h-5 bg-bark-100 dark:bg-shadow-800 rounded-full overflow-hidden">
                <div
                  class="h-full rounded-full transition-all duration-500 {MEMORY_TYPE_COLORS[type]?.split(' ')[0] || 'bg-bark-300'}"
                  style="width: {Math.max(pct, 2)}%"
                ></div>
              </div>
              <span class="text-xs text-shadow-500 dark:text-shadow-400 w-10 text-right">{count}</span>
            </div>
          {/each}
        </div>
      </div>

      <!-- Recent activity -->
      <div class="card-garden p-5">
        <h2 class="text-base font-serif font-semibold text-shadow-700 dark:text-bark-300 mb-3">Recent Activity</h2>
        <div class="space-y-2 max-h-64 overflow-y-auto">
          {#each getEvents().slice(-10).reverse() as event}
            <div class="flex items-start gap-2 text-xs">
              <span class="text-shadow-300 dark:text-shadow-600 shrink-0 mt-0.5">
                {new Date(event.timestamp).toLocaleTimeString()}
              </span>
              <span class="text-shadow-600 dark:text-shadow-400 font-mono">{event.type}</span>
            </div>
          {:else}
            <p class="text-xs text-shadow-400 dark:text-shadow-500 italic">No recent events — connect telemetry to see live activity</p>
          {/each}
        </div>
      </div>
    </div>

    <!-- Quick nav cards -->
    <div>
      <h2 class="text-base font-serif font-semibold text-shadow-700 dark:text-bark-300 mb-3">Explore the Garden</h2>
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {#each NAV_CARDS as card}
          <a href="{base}{card.path}" class="card-garden p-4 text-center border-l-4 {card.color} transition-colors group">
            <p class="font-serif text-sm font-medium text-shadow-700 dark:text-bark-300 group-hover:text-gold-700 dark:group-hover:text-gold-400">{card.name}</p>
            <p class="text-[11px] text-shadow-400 dark:text-shadow-500 mt-0.5">{card.desc}</p>
          </a>
        {/each}
      </div>
    </div>

    <!-- Think traces -->
    {#if stats.recentThinkTraces.length > 0}
      <div class="card-garden p-5">
        <h2 class="text-base font-serif font-semibold text-shadow-700 dark:text-bark-300 mb-3">Recent Think Traces</h2>
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead>
              <tr class="text-left text-shadow-400 dark:text-shadow-500 border-b border-bark-200 dark:border-shadow-700">
                <th class="pb-2 pr-4 font-medium">Channel</th>
                <th class="pb-2 pr-4 font-medium">Iterations</th>
                <th class="pb-2 pr-4 font-medium">Tokens</th>
                <th class="pb-2 pr-4 font-medium">Duration</th>
                <th class="pb-2 pr-4 font-medium">Evidence</th>
                <th class="pb-2 font-medium">Time</th>
              </tr>
            </thead>
            <tbody>
              {#each stats.recentThinkTraces as trace}
                <tr class="border-b border-bark-100 dark:border-shadow-800">
                  <td class="py-2 pr-4 font-mono text-shadow-600 dark:text-shadow-400">{trace.channelId}</td>
                  <td class="py-2 pr-4">{trace.iterations}</td>
                  <td class="py-2 pr-4">{formatNumber(trace.tokens)}</td>
                  <td class="py-2 pr-4">{(trace.durationMs / 1000).toFixed(1)}s</td>
                  <td class="py-2 pr-4">{trace.evidenceCount}</td>
                  <td class="py-2 text-shadow-400 dark:text-shadow-500">{new Date(trace.timestamp).toLocaleTimeString()}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
  {/if}
</div>
