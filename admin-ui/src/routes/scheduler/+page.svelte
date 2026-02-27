<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getSchedulerData } from '$lib/api/endpoints/scheduler';
  import { getDashboard } from '$lib/api/endpoints/dashboard';
  import type { ScheduledTask } from '$lib/types';

  // ── State ──
  let tasks = $state<ScheduledTask[]>([]);
  let loading = $state(true);
  let error = $state('');
  let dashboardTaskCount = $state<number | null>(null);
  let useFallback = $state(false);

  // ── Task state styling ──
  const STATE_BADGE: Record<string, string> = {
    idle:     'bg-bark-200 text-shadow-700',
    active:   'bg-moss-100 text-moss-700',
    paused:   'bg-gold-100 text-gold-700',
    complete: 'bg-bark-200 text-shadow-600',
  };

  const STATE_DOT: Record<string, string> = {
    idle:     'bg-bark-400',
    active:   'bg-moss-400',
    paused:   'bg-gold-400',
    complete: 'bg-shadow-300',
  };

  const TYPE_BADGE: Record<string, string> = {
    every:      'bg-gold-100 text-gold-700',
    'one-shot': 'bg-petal-100 text-petal-500',
  };

  function formatInterval(task: ScheduledTask): string {
    if (task.type === 'every') {
      const secs = Math.round(task.intervalMs / 1000);
      if (secs < 60) return `${secs}s`;
      if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      return `${h}h ${m}m`;
    }
    if (task.runAt) {
      return new Date(task.runAt).toLocaleString();
    }
    return '--';
  }

  async function loadData() {
    loading = true;
    error = '';

    // Try the dedicated scheduler API endpoint first
    try {
      const data = await getSchedulerData();
      tasks = data.tasks;
      useFallback = false;
      loading = false;
      return;
    } catch {
      // Endpoint may not exist yet -- fall back to dashboard stats
    }

    // Fallback: get task count from dashboard
    try {
      const dashData = await getDashboard();
      dashboardTaskCount = dashData.stats.schedulerTasks;
      useFallback = true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load scheduler data';
    } finally {
      loading = false;
    }
  }

  // ── Auto-refresh every 30s ──
  let refreshInterval: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    loadData();
    refreshInterval = setInterval(loadData, 30_000);
  });

  onDestroy(() => {
    if (refreshInterval) clearInterval(refreshInterval);
  });
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">The Rhythms</h1>
      <p class="text-sm text-shadow-600 mt-1">Scheduled tasks -- heartbeats, maintenance, and one-shot work</p>
    </div>
    <button
      onclick={loadData}
      disabled={loading}
      class="text-sm px-3 py-1.5 rounded-lg border border-bark-300
             text-shadow-600 hover:bg-bark-100
             transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
    >
      {loading ? 'Loading...' : 'Refresh'}
    </button>
  </div>

  {#if loading}
    <div class="card-garden p-12 text-center">
      <div class="w-8 h-8 mx-auto rounded-full bg-bark-200 animate-pulse mb-4"></div>
      <p class="text-sm text-shadow-600">Loading scheduler data...</p>
    </div>
  {:else if error}
    <div class="card-garden p-6 border-l-4 border-l-wilt-400">
      <p class="text-sm text-shadow-800">{error}</p>
    </div>
  {:else if useFallback}
    <!-- Fallback: only dashboard task count available -->
    <div class="card-garden p-6">
      <div class="flex items-start gap-3">
        <svg class="w-5 h-5 text-bark-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div>
          <p class="text-sm text-shadow-800">
            Requires gateway connection
          </p>
          <p class="text-sm text-shadow-600 mt-2">
            The scheduler task list is available when the agent is running with an active gateway.
            Dashboard reports <strong class="text-shadow-900 font-serif text-lg">{dashboardTaskCount}</strong> scheduled tasks registered.
          </p>
        </div>
      </div>
    </div>

    <!-- Placeholder task types -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="card-garden p-5 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-2">Registered</p>
        <p class="text-3xl font-serif font-bold text-gold-600">{dashboardTaskCount ?? 0}</p>
      </div>
      <div class="card-garden p-5 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-2">Type: Every</p>
        <p class="text-sm text-shadow-700">Recurring interval tasks (heartbeat, decay, maintenance)</p>
      </div>
      <div class="card-garden p-5 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-2">Type: One-Shot</p>
        <p class="text-sm text-shadow-700">Single-fire tasks (scheduled by agent)</p>
      </div>
    </div>
  {:else if tasks.length === 0}
    <div class="card-garden p-12 text-center">
      <svg class="w-16 h-16 mx-auto text-bark-300 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      <p class="font-serif text-lg text-shadow-700 mb-1">No scheduled tasks</p>
      <p class="text-sm text-shadow-600">Tasks will appear here when the scheduler registers heartbeats, maintenance, and agent-scheduled work.</p>
    </div>
  {:else}
    <!-- Task summary -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div class="card-garden p-4 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Total</p>
        <p class="text-2xl font-serif font-bold text-shadow-900">{tasks.length}</p>
      </div>
      <div class="card-garden p-4 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Active</p>
        <p class="text-2xl font-serif font-bold text-moss-600">{tasks.filter(t => t.state === 'active').length}</p>
      </div>
      <div class="card-garden p-4 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Idle</p>
        <p class="text-2xl font-serif font-bold text-shadow-700">{tasks.filter(t => t.state === 'idle').length}</p>
      </div>
      <div class="card-garden p-4 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Paused</p>
        <p class="text-2xl font-serif font-bold text-gold-600">{tasks.filter(t => t.state === 'paused').length}</p>
      </div>
    </div>

    <!-- Task table -->
    <div class="card-garden overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-bark-200 bg-bark-100">
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Name</th>
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Type</th>
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">Interval / Run At</th>
              <th class="text-left px-4 py-3 font-semibold text-shadow-800">State</th>
            </tr>
          </thead>
          <tbody>
            {#each tasks as task (task.id)}
              <tr class="border-b border-bark-100 hover:bg-bark-50 transition-colors">
                <td class="px-4 py-3">
                  <code class="text-sm font-mono text-shadow-800">{task.name}</code>
                </td>
                <td class="px-4 py-3">
                  <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium {TYPE_BADGE[task.type] || 'bg-bark-200 text-shadow-600'}">
                    {task.type}
                  </span>
                </td>
                <td class="px-4 py-3 text-sm text-shadow-700 font-mono">
                  {formatInterval(task)}
                </td>
                <td class="px-4 py-3">
                  <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-sm font-medium {STATE_BADGE[task.state] || 'bg-bark-200 text-shadow-600'}">
                    <span class="w-1.5 h-1.5 rounded-full {STATE_DOT[task.state] || 'bg-bark-400'}" class:animate-pulse={task.state === 'active'}></span>
                    {task.state}
                  </span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>
