<script lang="ts">
  import { getEvents } from '$lib/stores/telemetry.svelte';
  import type { TelemetryEvent } from '$lib/types';

  interface ShardView {
    id: string;
    task: string;
    status: 'active' | 'completed' | 'failed';
    startedAt: number;
    completedAt?: number;
  }

  function getShardEvents(): TelemetryEvent[] {
    return getEvents().filter(e =>
      e.type.startsWith('shard.') ||
      (typeof e.data === 'object' && e.data !== null && 'shardId' in (e.data as Record<string, unknown>))
    );
  }

  function buildShardViews(): ShardView[] {
    const shards = new Map<string, ShardView>();

    for (const event of getShardEvents()) {
      const data = event.data as Record<string, unknown> | null;
      const shardId = data && typeof data === 'object'
        ? (data.shardId as string) || (data.id as string) || ''
        : '';
      if (!shardId) continue;

      if (!shards.has(shardId)) {
        shards.set(shardId, {
          id: shardId,
          task: (data?.task as string) || (data?.description as string) || 'Unknown task',
          status: 'active',
          startedAt: event.timestamp,
        });
      }

      const shard = shards.get(shardId)!;

      if (event.type === 'shard.completed' || event.type === 'shard.done') {
        shard.status = 'completed';
        shard.completedAt = event.timestamp;
      } else if (event.type === 'shard.error' || event.type === 'shard.failed') {
        shard.status = 'failed';
        shard.completedAt = event.timestamp;
      }
    }

    return [...shards.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  function elapsed(startMs: number, endMs?: number): string {
    const ms = (endMs || Date.now()) - startMs;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  }

  function statusBadge(status: ShardView['status']): string {
    switch (status) {
      case 'active':    return 'bg-moss-100 text-moss-700 dark:bg-moss-900/30 dark:text-moss-300';
      case 'completed': return 'bg-bark-200 text-shadow-500 dark:bg-shadow-800 dark:text-shadow-400';
      case 'failed':    return 'bg-wilt-100 text-wilt-700 dark:bg-wilt-900/30 dark:text-wilt-300';
    }
  }

  let shards = $derived(buildShardViews());
  let activeCount = $derived(shards.filter(s => s.status === 'active').length);
  let totalEvents = $derived(getShardEvents().length);
</script>

<div class="space-y-6">
  <!-- Header -->
  <div>
    <h1 class="text-2xl font-serif font-bold text-shadow-800 dark:text-bark-200">The Blooms</h1>
    <p class="text-sm text-shadow-400 dark:text-shadow-500 mt-1">Active shards — ephemeral sub-agents spawned for parallel work</p>
  </div>

  <!-- Stats -->
  <div class="flex items-center gap-6 text-sm">
    <div class="flex items-center gap-2">
      <span class="w-2.5 h-2.5 rounded-full bg-moss-400"></span>
      <span class="text-shadow-600 dark:text-shadow-400">{activeCount} active</span>
    </div>
    <div class="flex items-center gap-2">
      <span class="text-shadow-400 dark:text-shadow-500">{shards.length} total shards</span>
    </div>
    <div class="flex items-center gap-2">
      <span class="text-shadow-400 dark:text-shadow-500">{totalEvents} shard events</span>
    </div>
  </div>

  {#if shards.length === 0}
    <!-- Empty state -->
    <div class="card-garden p-12 text-center">
      <svg class="w-16 h-16 mx-auto text-bark-300 dark:text-shadow-700 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 2v4m0 12v4m10-10h-4M6 12H2m15.07-7.07l-2.83 2.83M9.76 14.24l-2.83 2.83m0-10.14l2.83 2.83m4.48 4.48l2.83 2.83" />
      </svg>
      <p class="font-serif text-lg text-shadow-500 dark:text-shadow-400 mb-1">No active blooms</p>
      <p class="text-sm text-shadow-400 dark:text-shadow-500">The garden rests — shards will appear here when spawned via the <code class="font-mono text-xs">spawn_shard</code> tool</p>
    </div>
  {:else}
    <!-- Shard grid -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each shards as shard}
        <div class="card-garden p-4 {shard.status === 'active' ? 'border-l-4 border-l-moss-400' : shard.status === 'failed' ? 'border-l-4 border-l-wilt-400' : ''}">
          <!-- Header -->
          <div class="flex items-center justify-between mb-2">
            <code class="text-xs font-mono text-shadow-400 dark:text-shadow-500 truncate" title={shard.id}>
              {shard.id.length > 12 ? shard.id.slice(0, 12) + '...' : shard.id}
            </code>
            <span class="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium {statusBadge(shard.status)}">
              {shard.status}
            </span>
          </div>

          <!-- Task -->
          <p class="text-sm text-shadow-700 dark:text-bark-300 mb-3 line-clamp-2">{shard.task}</p>

          <!-- Timing -->
          <div class="flex items-center justify-between text-xs text-shadow-400 dark:text-shadow-500">
            <span>{new Date(shard.startedAt).toLocaleTimeString()}</span>
            <span class="font-mono">
              {#if shard.status === 'active'}
                <span class="text-moss-600 dark:text-moss-400">{elapsed(shard.startedAt)}</span>
              {:else}
                {elapsed(shard.startedAt, shard.completedAt)}
              {/if}
            </span>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Recent shard events log -->
  {#if getShardEvents().length > 0}
    <div class="card-garden p-5">
      <h2 class="text-base font-serif font-semibold text-shadow-700 dark:text-bark-300 mb-3">Shard Event Log</h2>
      <div class="space-y-1 max-h-64 overflow-y-auto font-mono text-xs">
        {#each getShardEvents().slice(-20).reverse() as event}
          <div class="flex items-start gap-3 py-1 border-b border-bark-100 dark:border-shadow-800">
            <span class="text-shadow-300 dark:text-shadow-600 shrink-0">
              {new Date(event.timestamp).toLocaleTimeString()}
            </span>
            <span class="text-petal-600 dark:text-petal-400 shrink-0">{event.type}</span>
            <span class="text-shadow-500 dark:text-shadow-400 truncate">
              {typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}
            </span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>
