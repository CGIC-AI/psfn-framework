<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    getEvents,
    isConnected,
    connectTelemetry,
    disconnectTelemetry,
  } from '$lib/stores/telemetry.svelte';
  import { getDashboard } from '$lib/api/endpoints/dashboard';

  // ── Types ──
  interface ShardView {
    id: string;
    name: string;
    task: string;
    status: 'active' | 'completed' | 'failed';
    startedAt: number;
    completedAt?: number;
  }

  // ── Dashboard state ──
  let dashboardShardCount = $state<number | null>(null);
  let dashboardLoading = $state(true);
  let dashboardError = $state('');

  // ── Elapsed time ticker ──
  let now = $state(Date.now());
  let tickInterval: ReturnType<typeof setInterval> | undefined;

  // ── Shard extraction from telemetry events ──
  let shardEvents = $derived(
    getEvents().filter(e =>
      e.type.startsWith('shard.') ||
      (typeof e.data === 'object' && e.data !== null && 'shardId' in (e.data as Record<string, unknown>))
    )
  );

  let shards = $derived.by(() => {
    const map = new Map<string, ShardView>();

    for (const event of shardEvents) {
      const data = event.data as Record<string, unknown> | null;
      const shardId = data && typeof data === 'object'
        ? (data.shardId as string) || (data.id as string) || ''
        : '';
      if (!shardId) continue;

      if (!map.has(shardId)) {
        map.set(shardId, {
          id: shardId,
          name: (data?.name as string) || shortId(shardId),
          task: (data?.task as string) || (data?.description as string) || 'Unknown task',
          status: 'active',
          startedAt: event.timestamp,
        });
      }

      const shard = map.get(shardId)!;

      // Update task/name if available from later events
      if (data?.task && shard.task === 'Unknown task') {
        shard.task = data.task as string;
      }
      if (data?.name && shard.name === shortId(shardId)) {
        shard.name = data.name as string;
      }

      if (event.type === 'shard.completed' || event.type === 'shard.done' || event.type === 'shard.end') {
        shard.status = 'completed';
        shard.completedAt = event.timestamp;
      } else if (event.type === 'shard.error' || event.type === 'shard.failed') {
        shard.status = 'failed';
        shard.completedAt = event.timestamp;
      }
    }

    return [...map.values()].sort((a, b) => b.startedAt - a.startedAt);
  });

  let activeShards = $derived(shards.filter(s => s.status === 'active'));
  let completedShards = $derived(shards.filter(s => s.status !== 'active'));

  // Use dashboard count if available, otherwise derive from telemetry
  let displayCount = $derived(dashboardShardCount ?? activeShards.length);

  // ── Formatting ──
  function elapsed(startMs: number, endMs?: number): string {
    const ms = (endMs || now) - startMs;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function shortId(id: string): string {
    return id.length > 8 ? id.slice(0, 8) : id;
  }

  // ── Lifecycle ──
  onMount(async () => {
    tickInterval = setInterval(() => { now = Date.now(); }, 1000);

    try {
      const data = await getDashboard();
      dashboardShardCount = data.stats.activeShards;
    } catch (e) {
      dashboardError = e instanceof Error
        ? `Dashboard unavailable: ${e.message}`
        : 'Dashboard unavailable: using telemetry-only shard counts.';
    } finally {
      dashboardLoading = false;
    }
  });

  onDestroy(() => {
    if (tickInterval) clearInterval(tickInterval);
  });
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between flex-wrap gap-3">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">The Blooms</h1>
      <p class="text-sm text-shadow-600 mt-1">Active shards -- ephemeral sub-agents spawned for parallel work</p>
    </div>

    <!-- Connection indicator + controls -->
    <div class="flex items-center gap-3">
      {#if isConnected()}
        <span class="relative flex h-2.5 w-2.5">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-moss-400 opacity-75"></span>
          <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-moss-500"></span>
        </span>
        <span class="text-sm text-moss-700 font-medium">Telemetry active</span>
        <button
          onclick={() => disconnectTelemetry()}
          class="text-sm px-3 py-1.5 rounded-lg border border-bark-300 text-shadow-600
                 hover:bg-bark-100 font-medium transition-colors"
        >
          Disconnect
        </button>
      {:else}
        <span class="inline-flex rounded-full h-2.5 w-2.5 bg-wilt-400"></span>
        <span class="text-sm text-wilt-600 font-medium">Disconnected</span>
        <button
          onclick={() => connectTelemetry()}
          class="text-sm px-3 py-1.5 rounded-lg border border-moss-300 bg-moss-50 text-moss-700
                 hover:bg-moss-100 font-medium transition-colors"
        >
          Connect
        </button>
      {/if}
    </div>
  </div>

  <!-- Active Shards Counter + Overview -->
  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
    <!-- Main counter -->
    <div class="card-garden p-6 text-center md:col-span-1">
      <p class="text-sm font-medium text-shadow-600 uppercase tracking-wide mb-2">Active Blooms</p>
      {#if dashboardLoading}
        <div class="h-16 flex items-center justify-center">
          <div class="w-8 h-8 rounded-full bg-bark-200 animate-pulse"></div>
        </div>
      {:else}
        <p class="text-5xl font-serif font-bold text-petal-500">{displayCount}</p>
        {#if displayCount > 0}
          <div class="flex justify-center gap-1 mt-3">
            {#each Array(Math.min(displayCount, 5)) as _, i}
              <span class="inline-block w-3 h-3 rounded-full bg-petal-400 animate-pulse" style="animation-delay: {i * 200}ms"></span>
            {/each}
            {#if displayCount > 5}
              <span class="text-sm text-shadow-600 self-center ml-1">+{displayCount - 5}</span>
            {/if}
          </div>
        {:else}
          <p class="text-sm text-shadow-600 mt-2">The garden rests</p>
        {/if}
      {/if}
    </div>

    <!-- Stats summary -->
    <div class="card-garden p-6 md:col-span-2">
      <p class="text-sm font-medium text-shadow-600 uppercase tracking-wide mb-3">Shard Overview</p>
      <div class="grid grid-cols-3 gap-4">
        <div>
          <div class="flex items-center gap-2 mb-1">
            <span class="w-2.5 h-2.5 rounded-full bg-petal-400 animate-pulse"></span>
            <span class="text-sm font-medium text-shadow-800">Active</span>
          </div>
          <p class="text-2xl font-serif font-bold text-shadow-900 pl-[18px]">{activeShards.length}</p>
        </div>
        <div>
          <div class="flex items-center gap-2 mb-1">
            <span class="w-2.5 h-2.5 rounded-full bg-moss-400"></span>
            <span class="text-sm font-medium text-shadow-800">Completed</span>
          </div>
          <p class="text-2xl font-serif font-bold text-shadow-900 pl-[18px]">{completedShards.filter(s => s.status === 'completed').length}</p>
        </div>
        <div>
          <div class="flex items-center gap-2 mb-1">
            <span class="w-2.5 h-2.5 rounded-full bg-wilt-400"></span>
            <span class="text-sm font-medium text-shadow-800">Failed</span>
          </div>
          <p class="text-2xl font-serif font-bold text-shadow-900 pl-[18px]">{completedShards.filter(s => s.status === 'failed').length}</p>
        </div>
      </div>
      <p class="text-sm text-shadow-600 mt-3">{shardEvents.length} shard events captured from telemetry</p>
    </div>
  </div>

  {#if dashboardError}
    <div class="card-garden p-4 border-l-4 border-l-wilt-300 flex items-start justify-between gap-3">
      <p class="text-sm text-shadow-700">{dashboardError}</p>
      <button
        data-esc-close
        onclick={() => dashboardError = ''}
        class="text-shadow-500 hover:text-shadow-700 leading-none text-lg"
        aria-label="Dismiss dashboard warning"
      >
        &times;
      </button>
    </div>
  {/if}

  <!-- No connection notice -->
  {#if !isConnected() && shards.length === 0}
    <div class="card-garden p-12 text-center">
      <svg class="w-16 h-16 mx-auto text-bark-300 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v4m0 12v4m10-10h-4M6 12H2m15.07-7.07l-2.83 2.83M9.76 14.24l-2.83 2.83m0-10.14l2.83 2.83m4.48 4.48l2.83 2.83" />
      </svg>
      <p class="font-serif text-lg text-shadow-800 mb-1">No blooms in the garden</p>
      <p class="text-sm text-shadow-600 mb-4">
        Shard monitoring requires a live telemetry connection. Shards are ephemeral sub-agents
        spawned via the <code class="font-mono text-sm bg-bark-100 px-1.5 py-0.5 rounded text-gold-700">spawn_shard</code> tool
        and are only visible through the event stream.
      </p>
      <button
        onclick={() => connectTelemetry()}
        class="text-sm px-5 py-2.5 rounded-lg border border-moss-300 bg-moss-50 text-moss-700
               hover:bg-moss-100 font-medium transition-colors"
      >
        Connect telemetry
      </button>
    </div>
  {:else if shards.length === 0 && isConnected()}
    <div class="card-garden p-12 text-center">
      <svg class="w-16 h-16 mx-auto text-bark-300 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v4m0 12v4m10-10h-4M6 12H2m15.07-7.07l-2.83 2.83M9.76 14.24l-2.83 2.83m0-10.14l2.83 2.83m4.48 4.48l2.83 2.83" />
      </svg>
      <p class="font-serif text-lg text-shadow-800 mb-1">Listening for blooms...</p>
      <p class="text-sm text-shadow-600">
        Telemetry connected. Shards will appear here when spawned via the
        <code class="font-mono text-sm bg-bark-100 px-1.5 py-0.5 rounded text-gold-700">spawn_shard</code> tool.
      </p>
    </div>
  {/if}

  <!-- Active Shards Section -->
  {#if activeShards.length > 0}
    <div>
      <h2 class="text-base font-serif font-semibold text-shadow-900 mb-3">
        Active Blooms
        <span class="text-sm font-sans font-normal text-shadow-600 ml-2">({activeShards.length})</span>
      </h2>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {#each activeShards as shard (shard.id)}
          <div class="card-garden p-4 border-l-4 border-l-petal-400" style="background: linear-gradient(90deg, var(--color-petal-50) 0%, white 20%);">
            <!-- Header row -->
            <div class="flex items-center justify-between mb-2">
              <strong class="text-sm text-shadow-900 truncate">{shard.name}</strong>
              <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-sm font-medium bg-petal-100 text-petal-500">
                <span class="w-1.5 h-1.5 rounded-full bg-petal-400 animate-pulse"></span>
                active
              </span>
            </div>

            <!-- Task description -->
            <p class="text-sm text-shadow-800 mb-3 line-clamp-3 leading-relaxed">{shard.task.slice(0, 200)}</p>

            <!-- Footer: timing -->
            <div class="flex items-center justify-between text-sm text-shadow-600 pt-2 border-t border-bark-100">
              <span>{formatTime(shard.startedAt)}</span>
              <span class="font-mono text-petal-500 font-medium">{elapsed(shard.startedAt)}</span>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Completed Shards Section -->
  {#if completedShards.length > 0}
    <div>
      <h2 class="text-base font-serif font-semibold text-shadow-900 mb-3">
        Recent Blooms
        <span class="text-sm font-sans font-normal text-shadow-600 ml-2">({completedShards.length})</span>
      </h2>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {#each completedShards as shard (shard.id)}
          <div class="card-garden p-4 border-l-4 {shard.status === 'completed' ? 'border-l-moss-400' : 'border-l-wilt-400'} opacity-80">
            <!-- Header row -->
            <div class="flex items-center justify-between mb-2">
              <strong class="text-sm text-shadow-800 truncate">{shard.name}</strong>
              <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-sm font-medium
                    {shard.status === 'completed' ? 'bg-moss-100 text-moss-700' : 'bg-wilt-100 text-wilt-600'}">
                {shard.status}
              </span>
            </div>

            <!-- Task description -->
            <p class="text-sm text-shadow-600 mb-3 line-clamp-2 leading-relaxed">{shard.task.slice(0, 200)}</p>

            <!-- Footer: timing -->
            <div class="flex items-center justify-between text-sm text-shadow-600 pt-2 border-t border-bark-100">
              <span>{formatTime(shard.startedAt)}</span>
              <span class="font-mono">
                {elapsed(shard.startedAt, shard.completedAt)}
              </span>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Shard Event Log -->
  {#if shardEvents.length > 0}
    <div class="card-garden p-5">
      <h2 class="text-base font-serif font-semibold text-shadow-900 mb-3">Shard Event Log</h2>
      <div class="space-y-0.5 max-h-80 overflow-y-auto">
        <div class="sticky top-0 bg-white z-10 pb-2 mb-1 border-b border-bark-200">
          <div class="flex items-center gap-4 text-sm font-medium text-shadow-600 uppercase tracking-wide px-1">
            <span class="w-20">Time</span>
            <span class="w-36">Event</span>
            <span class="flex-1">Details</span>
          </div>
        </div>
        {#each [...shardEvents].reverse().slice(0, 50) as event}
          {@const data = event.data as Record<string, unknown> | null}
          {@const shardId = data && typeof data === 'object' ? ((data.shardId as string) || (data.id as string) || '') : ''}
          <div class="flex items-start gap-4 py-1.5 px-1 text-sm font-mono border-b border-bark-50 hover:bg-bark-50 transition-colors">
            <span class="text-shadow-600 shrink-0 w-20">
              {formatTime(event.timestamp)}
            </span>
            <span class="shrink-0 w-36">
              <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium bg-petal-100 text-petal-500">
                {event.type}
              </span>
            </span>
            <span class="text-shadow-600 truncate flex-1" title={typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}>
              {#if shardId}
                <span class="text-shadow-800">{shortId(shardId)}</span>
                {#if data?.task}
                  <span class="text-shadow-600"> -- </span><span class="text-shadow-800">{data.task}</span>
                {/if}
              {:else}
                {typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}
              {/if}
            </span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>
