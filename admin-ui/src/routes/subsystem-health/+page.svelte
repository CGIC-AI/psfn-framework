<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import { getSubsystemHealth } from '$lib/api/endpoints/subsystem-health';
  import { createVisibilityAwarePoller } from '$lib/polling/visibility-aware-poller';
  import type {
    SubsystemHealthSnapshot,
    SubsystemLaneHealth,
    SubsystemLaneStatus,
  } from '$lib/types';

  // ── State ──
  let snapshot = $state<SubsystemHealthSnapshot | null>(null);
  let loading = $state(true);
  let error = $state('');
  let unavailable = $state(false);
  let lastLoadedAt = $state<number | null>(null);

  const eventLanes = $derived(
    (snapshot?.lanes ?? []).filter(lane => lane.source === 'event_bus'),
  );
  const schedulerLanes = $derived(
    (snapshot?.lanes ?? []).filter(lane => lane.source === 'scheduler'),
  );
  const watermarkLanes = $derived(
    (snapshot?.lanes ?? []).filter(lane => lane.source === 'watermark'),
  );
  const postTurnQueueLanes = $derived(
    (snapshot?.lanes ?? []).filter(lane => lane.source === 'post_turn_queue'),
  );

  // ── Status presentation (honest: never/stale/failed are visually distinct) ──
  const STATUS_META: Record<SubsystemLaneStatus, { label: string; badge: string; accent: string }> = {
    ok: { label: 'OK', badge: 'bg-moss-100 text-moss-700', accent: 'border-l-moss-400' },
    skipped: { label: 'Skipped', badge: 'bg-gold-100 text-gold-700', accent: 'border-l-gold-300' },
    degraded: { label: 'Degraded', badge: 'bg-gold-100 text-gold-700', accent: 'border-l-gold-400' },
    failed: { label: 'Failed', badge: 'bg-wilt-100 text-wilt-600', accent: 'border-l-wilt-400' },
    stale: { label: 'Stale', badge: 'bg-gold-100 text-gold-700', accent: 'border-l-gold-400' },
    paused: { label: 'Paused', badge: 'bg-bark-200 text-shadow-700', accent: 'border-l-bark-300' },
    never: { label: 'No data', badge: 'bg-bark-100 text-shadow-500', accent: 'border-l-bark-300' },
  };

  function statusMeta(status: SubsystemLaneStatus) {
    return STATUS_META[status] ?? STATUS_META.never;
  }

  function formatRelative(ts: number | null): string {
    if (ts === null || !Number.isFinite(ts)) return '--';
    const deltaMs = Date.now() - ts;
    if (deltaMs < 0) return 'in the future';
    const secs = Math.floor(deltaMs / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function formatClock(ts: number | null): string {
    if (ts === null || !Number.isFinite(ts)) return '--';
    return new Date(ts).toLocaleString();
  }

  function formatInterval(intervalMs: number | undefined): string {
    if (!intervalMs || !Number.isFinite(intervalMs)) return '--';
    const hours = intervalMs / 3_600_000;
    return hours >= 24 && Number.isInteger(hours / 24)
      ? `${hours / 24}d`
      : `${hours}h`;
  }

  function countEntries(counts: Record<string, number>): Array<[string, number]> {
    return Object.entries(counts);
  }

  function neverFiredNote(lane: SubsystemLaneHealth): string {
    return lane.source === 'event_bus'
      ? 'No data since process start'
      : 'Never run';
  }

  async function loadData() {
    loading = true;
    error = '';
    unavailable = false;
    try {
      snapshot = await getSubsystemHealth();
      lastLoadedAt = Date.now();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load subsystem health';
      if (message.includes('503')) {
        unavailable = true;
      } else {
        error = message;
      }
    } finally {
      loading = false;
    }
  }

  const poller = createVisibilityAwarePoller({
    refresh: loadData,
    intervalMs: 15_000,
  });

  onMount(() => {
    poller.start();
  });

  onDestroy(() => {
    poller.stop();
  });
</script>

<div class="garden-page space-y-5">
  <GardenPageHeader
    eyebrow="Operations · Runtime posture"
    title="Subsystem Health"
    description="Live health from durable deferred work, event-bus lanes, episodic watermarks, and scheduled work. Process-local history is labelled separately from durable state."
  >
    {#snippet actions()}
      <button
      onclick={loadData}
      disabled={loading}
      class="text-sm px-3 py-1.5 rounded-lg border border-bark-300
             text-shadow-600 hover:bg-bark-100
             transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
      >
        {loading ? 'Loading...' : 'Refresh'}
      </button>
    {/snippet}
  </GardenPageHeader>

  {#if loading && !snapshot}
    <div class="garden-loading card-garden p-12 text-center">
      <div class="w-8 h-8 mx-auto rounded-full bg-bark-200 animate-pulse mb-4"></div>
      <p class="text-sm text-shadow-600">Loading subsystem health...</p>
    </div>
  {:else if error}
    <div class="garden-error card-garden p-6 border-l-4 border-l-wilt-400">
      <p class="text-sm text-shadow-800">{error}</p>
    </div>
  {:else if unavailable}
    <div class="garden-empty card-garden p-6 border-l-4 border-l-bark-300">
      <p class="text-sm text-shadow-800">Subsystem health backend unavailable</p>
      <p class="text-sm text-shadow-600 mt-2">
        The health service is wired when the agent runs with an active gateway. No fabricated
        status is shown while it is offline.
      </p>
    </div>
  {:else if snapshot}
    {#if snapshot.operatorAlerting?.status === 'unconfigured'}
      <div
        class="card-garden p-5 border-l-4 border-l-wilt-400 bg-wilt-50"
        role="alert"
        aria-live="assertive"
      >
        <p class="text-sm font-semibold text-wilt-700">Operator alerting is unconfigured</p>
        <p class="text-sm text-shadow-700 mt-1">
          {snapshot.operatorAlerting.warning}
          Configure ntfy and/or the Telegram operator chat destination in channels.json.
        </p>
      </div>
    {/if}

    <!-- Process-start context -->
    <div class="garden-toolbar card-garden p-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
      <span class="text-shadow-600">
        <span class="font-medium text-shadow-800">Process started:</span>
        {formatClock(snapshot.processStartedAt)} ({formatRelative(snapshot.processStartedAt)})
      </span>
      <span class="text-shadow-600">
        <span class="font-medium text-shadow-800">Snapshot:</span>
        {formatRelative(lastLoadedAt)}
      </span>
      <span class="text-xs text-shadow-500">Auto-refreshes every 15s</span>
    </div>

    <!-- Content-free PostgreSQL ownership and pressure. No URLs, SQL, or row data. -->
    <section class="space-y-3">
      <h2 class="text-base font-serif font-semibold text-shadow-900">
        PostgreSQL connection pools
        <span class="text-xs font-sans font-normal text-shadow-500">(process lifecycle)</span>
      </h2>
      {#if snapshot.postgresPools.length === 0}
        <div class="card-garden p-4 text-sm text-shadow-500 italic">
          No lifecycle-owned PostgreSQL pools are active in this process.
        </div>
      {:else}
        <div class="space-y-4">
          {#each snapshot.postgresPools as poolOwner (poolOwner.process)}
            <article class="card-garden overflow-hidden">
              <div class="px-5 py-3 bg-bark-50 border-b border-bark-100 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
                <span class="font-semibold text-shadow-900">{poolOwner.process}</span>
                <span class="text-shadow-600">physical pools: {poolOwner.physicalPoolCount}</span>
                <span class="text-shadow-600">capacity: {poolOwner.totalCapacity}</span>
                <span class="text-shadow-600">active: {poolOwner.active}</span>
                <span class="text-shadow-600">idle: {poolOwner.idle}</span>
                <span class={poolOwner.waiting > 0 ? 'text-wilt-600 font-semibold' : 'text-shadow-600'}>
                  waiting: {poolOwner.waiting}
                </span>
                <span class="text-shadow-600">high-water: {poolOwner.highWaterConnections}</span>
              </div>
              <div class="divide-y divide-bark-100">
                {#each poolOwner.authorities as authority (authority.authorityIndex)}
                  <div class="px-5 py-3 text-xs space-y-1">
                    <div class="flex flex-wrap gap-x-4 gap-y-1 text-shadow-700">
                      <span class="font-mono">authority-{authority.authorityIndex}</span>
                      <span>{authority.authorityClass}</span>
                      <span>{authority.readOnly ? 'read only' : 'read/write'}</span>
                      <span>stores: {authority.logicalStoreCount}</span>
                      <span>active/idle/waiting: {authority.active}/{authority.idle}/{authority.waiting}</span>
                      <span>high-water active/connections/waiting: {authority.highWaterActive}/{authority.highWaterConnections}/{authority.highWaterWaiting}</span>
                    </div>
                    <p class="font-mono text-shadow-500 break-words">
                      {authority.applicationNames.join(', ')}
                    </p>
                  </div>
                {/each}
              </div>
            </article>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Durable post-turn action demand -->
    {#if postTurnQueueLanes.length > 0}
      <section class="space-y-3">
        <h2 class="text-base font-serif font-semibold text-shadow-900">
          Deferred action queue
          <span class="text-xs font-sans font-normal text-shadow-500">(durable demand)</span>
        </h2>
        <div class="grid grid-cols-1 gap-4">
          {#each postTurnQueueLanes as lane (lane.id)}
            {@const meta = statusMeta(lane.status)}
            <article class="card-garden overflow-hidden border-l-4 {meta.accent}">
              <div class="px-5 py-3 bg-bark-50 border-b border-bark-100 flex items-center justify-between gap-2">
                <div>
                  <p class="text-sm font-semibold text-shadow-900">{lane.label}</p>
                  <p class="text-xs text-shadow-500 mt-0.5">{lane.description}</p>
                </div>
                <span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold shrink-0 {meta.badge}">
                  {meta.label}
                </span>
              </div>
              <div class="px-5 py-4 space-y-2 text-sm">
                <p class="text-shadow-700">
                  <span class="text-shadow-500">Last progress:</span>
                  {formatRelative(lane.lastRunAt ?? lane.lastEventAt)}
                </p>
                {#if lane.lastReason}
                  <p class="text-gold-700 font-mono">{lane.lastReason}</p>
                {/if}
                {#if lane.lastError}
                  <p class="text-wilt-600 font-mono break-words">{lane.lastError}</p>
                {/if}
                <div class="flex flex-wrap gap-1.5 pt-1">
                  {#each countEntries(lane.counts) as [key, value] (key)}
                    <span class="inline-block px-2 py-0.5 rounded bg-bark-100 text-shadow-700 text-xs font-mono">
                      {key}: {value}
                    </span>
                  {/each}
                </div>
              </div>
            </article>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Event-bus lanes -->
    <section class="space-y-3">
      <h2 class="text-base font-serif font-semibold text-shadow-900">
        Event-bus lanes
        <span class="text-xs font-sans font-normal text-shadow-500">(since process start)</span>
      </h2>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {#each eventLanes as lane (lane.id)}
          {@const meta = statusMeta(lane.status)}
          <article class="card-garden overflow-hidden border-l-4 {meta.accent}">
            <div class="px-5 py-3 bg-bark-50 border-b border-bark-100 flex items-center justify-between gap-2">
              <div>
                <p class="text-sm font-semibold text-shadow-900">{lane.label}</p>
                <p class="text-xs text-shadow-500 mt-0.5">{lane.description}</p>
              </div>
              <span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold shrink-0 {meta.badge}">
                {meta.label}
              </span>
            </div>
            <div class="px-5 py-4 space-y-2 text-sm">
              {#if lane.status === 'never'}
                <p class="text-shadow-500 italic">{neverFiredNote(lane)}</p>
              {:else}
                <p class="text-shadow-700">
                  <span class="text-shadow-500">Last observed:</span>
                  {formatRelative(lane.lastEventAt)} ({formatClock(lane.lastEventAt)})
                </p>
                <p class="text-shadow-700">
                  <span class="text-shadow-500">Observations:</span> {lane.observedEventCount}
                </p>
                {#if lane.lastReason}
                  <p class="text-gold-700">
                    <span class="text-shadow-500">Skip reason:</span>
                    <span class="font-mono">{lane.lastReason}</span>
                  </p>
                {/if}
                {#if lane.lastError}
                  <p class="text-wilt-600">
                    <span class="text-shadow-500">Error:</span>
                    <span class="font-mono break-words">{lane.lastError}</span>
                  </p>
                {/if}
                {#if countEntries(lane.counts).length > 0}
                  <div class="flex flex-wrap gap-1.5 pt-1">
                    {#each countEntries(lane.counts) as [key, value] (key)}
                      <span class="inline-block px-2 py-0.5 rounded bg-bark-100 text-shadow-700 text-xs font-mono">
                        {key}: {value}
                      </span>
                    {/each}
                  </div>
                {/if}
              {/if}
            </div>
          </article>
        {/each}
      </div>
    </section>

    <!-- Durable episodic processor watermarks -->
    <section class="space-y-3">
      <h2 class="text-base font-serif font-semibold text-shadow-900">
        Episodic processor watermarks
        <span class="text-xs font-sans font-normal text-shadow-500">(durable progress)</span>
      </h2>
      {#if watermarkLanes.length === 0}
        <div class="card-garden p-6 text-sm text-shadow-500">
          No durable episodic watermark state available.
        </div>
      {:else}
        <div class="garden-table-shell card-garden overflow-hidden">
          <table class="garden-table w-full text-sm">
            <thead>
              <tr class="bg-bark-50 border-b border-bark-100 text-left text-xs text-shadow-500 uppercase tracking-wide">
                <th class="px-4 py-2 font-medium">Processor</th>
                <th class="px-4 py-2 font-medium">Status</th>
                <th class="px-4 py-2 font-medium">Last advance</th>
                <th class="px-4 py-2 font-medium">Expected cadence</th>
                <th class="px-4 py-2 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {#each watermarkLanes as lane (lane.id)}
                {@const meta = statusMeta(lane.status)}
                <tr class="border-b border-bark-100 last:border-b-0">
                  <td class="px-4 py-2">
                    <p class="text-shadow-800">{lane.label}</p>
                    <p class="text-xs text-shadow-500">{lane.description}</p>
                  </td>
                  <td class="px-4 py-2">
                    <span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold {meta.badge}">
                      {meta.label}
                    </span>
                  </td>
                  <td class="px-4 py-2 text-shadow-600">
                    {#if lane.status === 'never'}
                      <span class="italic text-shadow-500">{neverFiredNote(lane)}</span>
                    {:else}
                      {formatRelative(lane.lastRunAt ?? lane.lastEventAt)}
                    {/if}
                  </td>
                  <td class="px-4 py-2 text-shadow-600">{formatInterval(lane.intervalMs)}</td>
                  <td class="px-4 py-2">
                    {#if lane.lastError}
                      <span class="text-wilt-600 font-mono break-words">{lane.lastError}</span>
                    {:else if lane.status === 'stale' && lane.nextRunDueAt}
                      <span class="text-gold-700">overdue since {formatRelative(lane.nextRunDueAt)}</span>
                    {:else if (lane.counts.blockedScopeCount ?? 0) > 0}
                      <span class="text-wilt-600">
                        {lane.counts.blockedScopeCount} blocked scope(s)
                      </span>
                    {:else}
                      <span class="text-shadow-500">
                        {lane.counts.scopeCount ?? 0} scope(s)
                      </span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <!-- Scheduler lanes -->
    <section class="space-y-3">
      <h2 class="text-base font-serif font-semibold text-shadow-900">
        Scheduler lanes
        <span class="text-xs font-sans font-normal text-shadow-500">(live scheduler state)</span>
      </h2>
      {#if schedulerLanes.length === 0}
        <div class="card-garden p-6 text-sm text-shadow-500">
          No scheduler state available.
        </div>
      {:else}
        <div class="garden-table-shell card-garden overflow-hidden">
          <table class="garden-table w-full text-sm">
            <thead>
              <tr class="bg-bark-50 border-b border-bark-100 text-left text-xs text-shadow-500 uppercase tracking-wide">
                <th class="px-4 py-2 font-medium">Lane</th>
                <th class="px-4 py-2 font-medium">Status</th>
                <th class="px-4 py-2 font-medium">Last run</th>
                <th class="px-4 py-2 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {#each schedulerLanes as lane (lane.id)}
                {@const meta = statusMeta(lane.status)}
                <tr class="border-b border-bark-100 last:border-b-0">
                  <td class="px-4 py-2 text-shadow-800">{lane.label}</td>
                  <td class="px-4 py-2">
                    <span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold {meta.badge}">
                      {meta.label}
                    </span>
                  </td>
                  <td class="px-4 py-2 text-shadow-600">
                    {#if lane.status === 'never'}
                      <span class="italic text-shadow-500">{neverFiredNote(lane)}</span>
                    {:else}
                      {formatRelative(lane.lastRunAt ?? lane.lastEventAt)}
                    {/if}
                  </td>
                  <td class="px-4 py-2">
                    {#if lane.lastError}
                      <span class="text-wilt-600 font-mono break-words">{lane.lastError}</span>
                    {:else if lane.lastReason}
                      <span class="text-gold-700 font-mono">{lane.lastReason}</span>
                    {:else if lane.status === 'stale' && lane.nextRunDueAt}
                      <span class="text-shadow-500">overdue since {formatRelative(lane.nextRunDueAt)}</span>
                    {:else}
                      <span class="text-shadow-400">--</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {/if}
</div>
