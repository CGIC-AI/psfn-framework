<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getEvents } from '$lib/stores/telemetry.svelte';
  import { getDashboard } from '$lib/api/endpoints/dashboard';
  import type { TelemetryEvent } from '$lib/types';

  // ── Types ──
  interface ShardView {
    id: string;
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
          task: (data?.task as string) || (data?.description as string) || 'Unknown task',
          status: 'active',
          startedAt: event.timestamp,
        });
      }

      const shard = map.get(shardId)!;

      if (event.type === 'shard.completed' || event.type === 'shard.done') {
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
  let completedShards = $derived(shards.filter(s => s.status === 'completed'));
  let failedShards = $derived(shards.filter(s => s.status === 'failed'));

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

  // ── Status styling ──
  const STATUS_BORDER: Record<ShardView['status'], string> = {
    active:    'border-l-4 border-l-gold-400',
    completed: 'border-l-4 border-l-moss-400',
    failed:    'border-l-4 border-l-wilt-400',
  };

  const STATUS_BADGE: Record<ShardView['status'], string> = {
    active:    'bg-gold-100 text-gold-700',
    completed: 'bg-moss-100 text-moss-700',
    failed:    'bg-wilt-100 text-wilt-700',
  };

  const STATUS_DOT: Record<ShardView['status'], string> = {
    active:    'bg-gold-400',
    completed: 'bg-moss-400',
    failed:    'bg-wilt-400',
  };

  // ── Lifecycle ──
  onMount(async () => {
    tickInterval = setInterval(() => { now = Date.now(); }, 1000);

    try {
      const data = await getDashboard();
      dashboardShardCount = data.stats.activeShards;
    } catch (e) {
      dashboardError = e instanceof Error ? e.message : 'Failed to load';
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
  <div>
    <h1 class="text-2xl font-serif font-bold text-shadow-900">The Blooms</h1>
    <p class="text-sm text-shadow-700 mt-1">Active shards -- ephemeral sub-agents spawned for parallel work</p>
  </div>

  <!-- Active Shards Counter -->
  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
    <!-- Main counter -->
    <div class="card-garden p-6 text-center md:col-span-1">
      <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-2">Active Blooms</p>
      {#if dashboardLoading}
        <div class="h-16 flex items-center justify-center">
          <div class="w-8 h-8 rounded-full bg-bark-200 animate-pulse"></div>
        </div>
      {:else}
        <p class="text-5xl font-serif font-bold text-gold-600">{displayCount}</p>
        {#if displayCount > 0}
          <div class="flex justify-center gap-1 mt-3">
            {#each Array(Math.min(displayCount, 5)) as _, i}
              <span class="inline-block w-3 h-3 rounded-full bg-gold-400 animate-pulse" style="animation-delay: {i * 200}ms"></span>
            {/each}
            {#if displayCount > 5}
              <span class="text-xs text-shadow-600 self-center ml-1">+{displayCount - 5}</span>
            {/if}
          </div>
        {:else}
          <p class="text-xs text-shadow-600 mt-2">The garden rests</p>
        {/if}
      {/if}
    </div>

    <!-- Stats summary -->
    <div class="card-garden p-6 md:col-span-2">
      <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-3">Shard Overview</p>
      <div class="grid grid-cols-3 gap-4">
        <div>
          <div class="flex items-center gap-2 mb-1">
            <span class="w-2.5 h-2.5 rounded-full bg-gold-400 animate-pulse"></span>
            <span class="text-sm font-medium text-shadow-800">Active</span>
          </div>
          <p class="text-2xl font-serif font-bold text-shadow-900 pl-[18px]">{activeShards.length}</p>
        </div>
        <div>
          <div class="flex items-center gap-2 mb-1">
            <span class="w-2.5 h-2.5 rounded-full bg-moss-400"></span>
            <span class="text-sm font-medium text-shadow-800">Completed</span>
          </div>
          <p class="text-2xl font-serif font-bold text-shadow-900 pl-[18px]">{completedShards.length}</p>
        </div>
        <div>
          <div class="flex items-center gap-2 mb-1">
            <span class="w-2.5 h-2.5 rounded-full bg-wilt-400"></span>
            <span class="text-sm font-medium text-shadow-800">Failed</span>
          </div>
          <p class="text-2xl font-serif font-bold text-shadow-900 pl-[18px]">{failedShards.length}</p>
        </div>
      </div>
      <p class="text-xs text-shadow-600 mt-3">{shardEvents.length} shard events captured from telemetry</p>
    </div>
  </div>

  <!-- Shard cards -->
  {#if shards.length === 0}
    <div class="card-garden p-12 text-center">
      <svg class="w-16 h-16 mx-auto text-bark-300 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v4m0 12v4m10-10h-4M6 12H2m15.07-7.07l-2.83 2.83M9.76 14.24l-2.83 2.83m0-10.14l2.83 2.83m4.48 4.48l2.83 2.83" />
      </svg>
      <p class="font-serif text-lg text-shadow-700 mb-1">No blooms in the garden</p>
      <p class="text-sm text-shadow-600">
        Shards will appear here when spawned via the <code class="font-mono text-xs bg-bark-100 px-1.5 py-0.5 rounded text-gold-700">spawn_shard</code> tool.
        Connect telemetry to see real-time shard events.
      </p>
    </div>
  {:else}
    <div>
      <h2 class="text-base font-serif font-semibold text-shadow-900 mb-3">Bloom Cards</h2>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {#each shards as shard (shard.id)}
          <div class="card-garden p-4 {STATUS_BORDER[shard.status]}">
            <!-- Header row -->
            <div class="flex items-center justify-between mb-2">
              <code class="text-xs font-mono text-shadow-600" title={shard.id}>
                {shortId(shard.id)}
              </code>
              <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-sm font-medium {STATUS_BADGE[shard.status]}">
                {#if shard.status === 'active'}
                  <span class="w-1.5 h-1.5 rounded-full {STATUS_DOT.active} animate-pulse"></span>
                {/if}
                {shard.status}
              </span>
            </div>

            <!-- Task description -->
            <p class="text-sm text-shadow-800 mb-3 line-clamp-2 leading-relaxed">{shard.task}</p>

            <!-- Footer: timing -->
            <div class="flex items-center justify-between text-xs text-shadow-600 pt-2 border-t border-bark-100">
              <span>{formatTime(shard.startedAt)}</span>
              <span class="font-mono">
                {#if shard.status === 'active'}
                  <span class="text-gold-600 font-medium">{elapsed(shard.startedAt)}</span>
                {:else}
                  {elapsed(shard.startedAt, shard.completedAt)}
                {/if}
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
          <div class="flex items-start gap-4 py-1.5 px-1 text-xs font-mono border-b border-bark-50 hover:bg-bark-50 transition-colors">
            <span class="text-shadow-600 shrink-0 w-20">
              {formatTime(event.timestamp)}
            </span>
            <span class="shrink-0 w-36">
              <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium bg-petal-100 text-petal-700">
                {event.type}
              </span>
            </span>
            <span class="text-shadow-700 truncate flex-1" title={typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}>
              {#if shardId}
                <span class="text-shadow-800">{shortId(shardId)}</span>
                {#if data?.task}
                  <span class="text-shadow-600"> -- </span>{data.task}
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
