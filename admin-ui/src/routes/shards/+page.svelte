<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { base } from '$app/paths';
  import {
    getEvents,
    getTelemetryConnectionError,
    isConnected,
    connectTelemetry,
    disconnectTelemetry,
  } from '$lib/stores/telemetry.svelte';
  import { getDashboard } from '$lib/api/endpoints/dashboard';
  import { listParentShards } from '$lib/api/endpoints/shards';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import type {
    AdminShardFoldReviewListData,
  } from '../../../../src/operator/garden/services/types/shards.js';

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
  let parentShardData = $state<AdminShardFoldReviewListData | null>(null);
  let parentShardError = $state('');

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
      const [dashboard, shardData] = await Promise.all([
        getDashboard(),
        listParentShards(),
      ]);
      dashboardShardCount = dashboard.stats.activeShards;
      parentShardData = shardData;
    } catch (e) {
      dashboardError = e instanceof Error
        ? `Dashboard unavailable: ${e.message}`
        : 'Dashboard unavailable: using telemetry-only shard counts.';
      try {
        parentShardData = await listParentShards();
      } catch (shardError) {
        parentShardError = shardError instanceof Error
          ? shardError.message
          : 'Parent-scoped shard list unavailable';
      }
    } finally {
      dashboardLoading = false;
    }
  });

  onDestroy(() => {
    if (tickInterval) clearInterval(tickInterval);
  });
</script>

<div class="garden-page space-y-6 pb-10">
  <GardenPageHeader
    eyebrow="Runtime & Tools · Shards"
    title="The Blooms"
    description="Parent-owned shard activity, runtime-only overrides, fold reviews, and the live telemetry trail."
    class="border-b border-bark-300 pb-4"
  >
    {#snippet actions()}
    <div class="garden-toolbar flex flex-wrap items-center gap-2">
      {#if isConnected()}
        <span class="relative flex h-2.5 w-2.5">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-moss-400 opacity-75"></span>
          <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-moss-500"></span>
        </span>
        <span class="garden-status garden-status--success rounded-full border border-moss-300 bg-moss-50 px-2.5 py-1 text-xs font-semibold text-moss-700">Telemetry active</span>
        <button
          onclick={() => disconnectTelemetry()}
          class="garden-action text-sm px-3 py-1.5 rounded-lg border border-bark-300 text-shadow-600
                 hover:bg-bark-100 font-medium transition-colors"
        >
          Disconnect
        </button>
      {:else}
        <span class="inline-flex rounded-full h-2.5 w-2.5 bg-wilt-400"></span>
        <span class="garden-status garden-status--danger rounded-full border border-wilt-300 bg-wilt-50 px-2.5 py-1 text-xs font-semibold text-wilt-700">Disconnected</span>
        {#if getTelemetryConnectionError()}
          <span class="text-xs text-wilt-600" role="status">
            {#if getTelemetryConnectionError()?.code !== null}
              Code {getTelemetryConnectionError()?.code}:
            {/if}
            {getTelemetryConnectionError()?.reason}
          </span>
        {/if}
        <button
          onclick={() => connectTelemetry()}
          class="garden-action text-sm px-3 py-1.5 rounded-lg border border-moss-300 bg-moss-50 text-moss-700
                 hover:bg-moss-100 font-medium transition-colors"
        >
          Connect
        </button>
      {/if}
    </div>
    {/snippet}
  </GardenPageHeader>

  <!-- Active Shards Counter + Overview -->
  <div class="garden-metric-grid grid grid-cols-1 gap-4 md:grid-cols-3">
    <!-- Main counter -->
    <div class="garden-metric card-garden p-5 text-center md:col-span-1">
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
    <div class="garden-metric card-garden p-5 md:col-span-2">
      <p class="text-sm font-medium text-shadow-600 uppercase tracking-wide mb-3">Shard Overview</p>
      <div class="grid grid-cols-3 gap-2 sm:gap-4">
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
    <div class="garden-error card-garden p-4 border-l-4 border-l-wilt-300 flex items-start justify-between gap-3">
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

  <section class="garden-section card-garden p-5" aria-labelledby="parent-shard-tree-heading">
    <div class="garden-section-header flex items-start justify-between gap-3 mb-4">
      <div>
        <p class="text-sm uppercase tracking-wide text-shadow-500">Parent companion</p>
        <h2 id="parent-shard-tree-heading" class="garden-section-title text-lg font-serif font-semibold text-shadow-900">
          Shards
        </h2>
        <p class="text-sm text-shadow-600 mt-1">
          Each shard remains nested under this companion. Open an active shard for its inherited,
          override, and effective runtime snapshot.
        </p>
      </div>
      <span class="rounded-full bg-bark-100 px-3 py-1 text-sm text-shadow-700">
        {parentShardData?.shards.length ?? 0} active
      </span>
    </div>

    {#if parentShardError}
      <p class="rounded-lg border border-wilt-200 bg-wilt-50 p-3 text-sm text-wilt-700">
        {parentShardError}
      </p>
    {:else if parentShardData === null}
      <p class="text-sm text-shadow-600">Loading parent-owned shards...</p>
    {:else if parentShardData.shards.length === 0}
      <p class="garden-empty rounded-lg border border-bark-200 bg-bark-50 p-4 text-sm text-shadow-600">
        No mutable shard subviews are active. Completed shard fold reviews remain listed below.
      </p>
    {:else}
      <div class="space-y-2">
        {#each parentShardData.shards as shard (shard.shardId)}
          <a
            href={`${base}/shards/${encodeURIComponent(shard.shardId)}`}
            class="block rounded-xl border border-bark-200 p-4 transition-colors hover:border-gold-400 hover:bg-gold-50"
          >
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="font-medium text-shadow-900 truncate">{shard.name}</p>
                <p class="text-sm text-shadow-600 truncate">{shard.task}</p>
              </div>
              <span class="shrink-0 rounded-full bg-moss-100 px-2.5 py-1 text-sm text-moss-700">
                {shard.state} / {shard.health}
              </span>
            </div>
          </a>
        {/each}
      </div>
    {/if}

    {#if parentShardData && parentShardData.reviews.length > 0}
      <div class="mt-5 border-t border-bark-200 pt-4">
        <h3 class="text-sm font-medium uppercase tracking-wide text-shadow-600">Fold review lineage</h3>
        <div class="mt-2 space-y-2">
          {#each parentShardData.reviews as review (review.shardId)}
            <a
              href={`${base}/shards/${encodeURIComponent(review.shardId)}`}
              class="flex items-center justify-between gap-3 rounded-lg bg-bark-50 px-3 py-2 text-sm hover:bg-bark-100"
            >
              <span class="truncate text-shadow-800">{review.task}</span>
              <span class="shrink-0 text-shadow-600">{review.reviewState}</span>
            </a>
          {/each}
        </div>
      </div>
    {/if}
  </section>

  <!-- No connection notice -->
  {#if !isConnected() && shards.length === 0}
    <div class="garden-empty card-garden p-10 text-center">
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
        class="garden-action text-sm px-5 py-2.5 rounded-lg border border-moss-300 bg-moss-50 text-moss-700
               hover:bg-moss-100 font-medium transition-colors"
      >
        Connect telemetry
      </button>
    </div>
  {:else if shards.length === 0 && isConnected()}
    <div class="garden-empty card-garden p-10 text-center">
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
    <section class="garden-section">
      <h2 class="text-base font-serif font-semibold text-shadow-900 mb-3">
        Active Blooms
        <span class="text-sm font-sans font-normal text-shadow-600 ml-2">({activeShards.length})</span>
      </h2>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {#each activeShards as shard (shard.id)}
          <div class="card-garden border-l-4 border-l-petal-400 p-4" style="background: linear-gradient(90deg, var(--color-petal-50) 0%, var(--color-surface) 20%);">
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
    </section>
  {/if}

  <!-- Completed Shards Section -->
  {#if completedShards.length > 0}
    <section class="garden-section">
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
    </section>
  {/if}

  <!-- Shard Event Log -->
  {#if shardEvents.length > 0}
    <section class="garden-section garden-table-shell card-garden overflow-hidden p-5">
      <h2 class="garden-section-title text-base font-serif font-semibold text-shadow-900 mb-3">Shard Event Log</h2>
      <div class="space-y-0.5 max-h-80 overflow-y-auto">
        <div class="sticky top-0 bg-bark-50 z-10 pb-2 mb-1 border-b border-bark-200">
          <div class="hidden items-center gap-4 px-1 text-sm font-medium uppercase tracking-wide text-shadow-600 sm:flex">
            <span class="w-20">Time</span>
            <span class="w-36">Event</span>
            <span class="flex-1">Details</span>
          </div>
        </div>
        {#each [...shardEvents].reverse().slice(0, 50) as event}
          {@const data = event.data as Record<string, unknown> | null}
          {@const shardId = data && typeof data === 'object' ? ((data.shardId as string) || (data.id as string) || '') : ''}
          <div class="grid gap-1 border-b border-bark-100 px-1 py-2 text-sm font-mono transition-colors hover:bg-bark-50 sm:flex sm:items-start sm:gap-4">
            <span class="text-shadow-600 shrink-0 sm:w-20">
              {formatTime(event.timestamp)}
            </span>
            <span class="shrink-0 sm:w-36">
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
    </section>
  {/if}
</div>
