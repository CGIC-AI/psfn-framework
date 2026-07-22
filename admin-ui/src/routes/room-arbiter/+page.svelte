<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { getRoomArbiterData, type RoomArbiterData } from '$lib/api/endpoints/room-arbiter';
  import { createVisibilityAwarePoller } from '$lib/polling/visibility-aware-poller';

  let data = $state<RoomArbiterData | null>(null);
  let loading = $state(true);
  let error = $state('');

  const available = $derived(data?.available ?? false);

  const BREAKER_META: Record<string, { label: string; badge: string }> = {
    closed: { label: 'Closed (live)', badge: 'bg-moss-100 text-moss-700' },
    half_open: { label: 'Half-open (probe)', badge: 'bg-gold-100 text-gold-700' },
    open: { label: 'Open (suppressed)', badge: 'bg-wilt-100 text-wilt-600' },
  };

  function breakerMeta(state: string) {
    return BREAKER_META[state] ?? { label: state, badge: 'bg-bark-100 text-shadow-500' };
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
    return `${Math.floor(hours / 24)}d ago`;
  }

  function shortId(value: string | null): string {
    if (!value) return '--';
    return value.length > 12 ? `${value.slice(0, 12)}…` : value;
  }

  async function loadData(): Promise<void> {
    loading = true;
    error = '';
    try {
      data = await getRoomArbiterData();
    } catch (loadError) {
      error = loadError instanceof Error
        ? loadError.message
        : 'Room arbiter telemetry is temporarily unavailable';
    } finally {
      loading = false;
    }
  }

  const poller = createVisibilityAwarePoller({
    refresh: loadData,
    intervalMs: 15_000,
  });

  onMount(() => {
    void loadData();
    poller.start();
  });

  onDestroy(() => {
    poller.stop();
  });
</script>

<svelte:head>
  <title>Cluster Command · Garden</title>
</svelte:head>

<div class="min-h-screen bg-bark-100 px-4 py-8 sm:px-6 lg:px-8">
  <main class="mx-auto max-w-6xl space-y-6">
    <header class="space-y-1">
      <h1 class="text-2xl font-semibold text-shadow-800">Cluster Command</h1>
      <p class="text-sm text-shadow-600">
        Room-state and arbitration telemetry. Content-free by contract: ids, enums, counts,
        and timestamps only &mdash; no room or message text is collected.
      </p>
    </header>

    {#if loading && data === null}
      <p class="text-sm text-shadow-500">Loading room arbiter telemetry&hellip;</p>
    {:else if error}
      <div class="rounded-lg border border-wilt-200 bg-wilt-50 p-4 text-sm text-wilt-700">
        {error}
      </div>
    {:else if !available}
      <div class="rounded-lg border border-bark-300 bg-bark-50 p-4 text-sm text-shadow-600">
        The speaking arbiter is not active for this deployment. Room arbitration telemetry is
        only available in multi-companion mode.
      </div>
    {:else if data}
      <section class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="rounded-lg border border-bark-300 bg-white p-3">
          <div class="text-xs uppercase tracking-wide text-shadow-500">Open episodes</div>
          <div class="text-xl font-semibold text-shadow-800">{data.summary.openEpisodeCount}</div>
        </div>
        <div class="rounded-lg border border-bark-300 bg-white p-3">
          <div class="text-xs uppercase tracking-wide text-shadow-500">Suppressed</div>
          <div class="text-xl font-semibold text-wilt-600">{data.summary.suppressedEpisodeCount}</div>
        </div>
        <div class="rounded-lg border border-bark-300 bg-white p-3">
          <div class="text-xs uppercase tracking-wide text-shadow-500">Active reservations</div>
          <div class="text-xl font-semibold text-shadow-800">{data.summary.activeReservationCount}</div>
        </div>
        <div class="rounded-lg border border-bark-300 bg-white p-3">
          <div class="text-xs uppercase tracking-wide text-shadow-500">Held leases</div>
          <div class="text-xl font-semibold text-shadow-800">{data.summary.heldLeaseCount}</div>
        </div>
      </section>

      <section class="space-y-3">
        <h2 class="text-lg font-semibold text-shadow-800">Room episodes</h2>
        {#if data.episodes.length === 0}
          <p class="text-sm text-shadow-500">No room episodes recorded.</p>
        {:else}
          <div class="overflow-x-auto rounded-lg border border-bark-300 bg-white">
            <table class="min-w-full text-sm">
              <thead class="bg-bark-100 text-left text-xs uppercase tracking-wide text-shadow-500">
                <tr>
                  <th class="px-3 py-2">Channel</th>
                  <th class="px-3 py-2">Status</th>
                  <th class="px-3 py-2">Pressure</th>
                  <th class="px-3 py-2">Auto turns</th>
                  <th class="px-3 py-2">Suppression (Law 36)</th>
                  <th class="px-3 py-2">Participants</th>
                  <th class="px-3 py-2">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {#each data.episodes as episode (episode.episodeId)}
                  <tr class="border-t border-bark-200 align-top">
                    <td class="px-3 py-2 font-mono text-xs text-shadow-700">{episode.channelId}</td>
                    <td class="px-3 py-2">{episode.status}</td>
                    <td class="px-3 py-2 tabular-nums">{episode.pressure.toFixed(2)}</td>
                    <td class="px-3 py-2 tabular-nums">{episode.consecutiveAutonomousTurns}</td>
                    <td class="px-3 py-2">
                      <span class={`inline-block rounded px-2 py-0.5 text-xs ${breakerMeta(episode.suppression.breakerState).badge}`}>
                        {breakerMeta(episode.suppression.breakerState).label}
                      </span>
                      {#if episode.suppression.suppressed}
                        <div class="mt-1 text-xs text-shadow-500">
                          reset path: {episode.suppression.resetPath.join(' → ')}
                        </div>
                      {/if}
                    </td>
                    <td class="px-3 py-2">
                      {#if episode.participants.length === 0}
                        <span class="text-xs text-shadow-400">--</span>
                      {:else}
                        <div class="space-y-0.5">
                          {#each episode.participants as participant (participant.companionId)}
                            <div class="text-xs text-shadow-600">
                              <span class="font-mono">{shortId(participant.companionId)}</span>
                              &middot; {participant.speakCount} spoke &middot; {formatRelative(participant.lastSpokeAtMs)}
                            </div>
                          {/each}
                        </div>
                      {/if}
                    </td>
                    <td class="px-3 py-2 text-xs text-shadow-500">{formatRelative(episode.lastActivityAtMs)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>

      <section class="grid gap-6 lg:grid-cols-2">
        <div class="space-y-3">
          <h2 class="text-lg font-semibold text-shadow-800">Reservations</h2>
          {#if data.reservations.length === 0}
            <p class="text-sm text-shadow-500">No reservations recorded.</p>
          {:else}
            <div class="overflow-x-auto rounded-lg border border-bark-300 bg-white">
              <table class="min-w-full text-sm">
                <thead class="bg-bark-100 text-left text-xs uppercase tracking-wide text-shadow-500">
                  <tr>
                    <th class="px-3 py-2">Companion</th>
                    <th class="px-3 py-2">Status</th>
                    <th class="px-3 py-2">Reason</th>
                    <th class="px-3 py-2">Reserved</th>
                  </tr>
                </thead>
                <tbody>
                  {#each data.reservations as reservation (reservation.reservationId)}
                    <tr class="border-t border-bark-200">
                      <td class="px-3 py-2 font-mono text-xs">{shortId(reservation.companionId)}</td>
                      <td class="px-3 py-2">{reservation.status}</td>
                      <td class="px-3 py-2 text-xs text-shadow-600">{reservation.reason ?? '--'}</td>
                      <td class="px-3 py-2 text-xs text-shadow-500">{formatRelative(reservation.reservedAtMs)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </div>

        <div class="space-y-3">
          <h2 class="text-lg font-semibold text-shadow-800">Egress leases</h2>
          {#if data.leases.length === 0}
            <p class="text-sm text-shadow-500">No leases recorded.</p>
          {:else}
            <div class="overflow-x-auto rounded-lg border border-bark-300 bg-white">
              <table class="min-w-full text-sm">
                <thead class="bg-bark-100 text-left text-xs uppercase tracking-wide text-shadow-500">
                  <tr>
                    <th class="px-3 py-2">Companion</th>
                    <th class="px-3 py-2">Status</th>
                    <th class="px-3 py-2">Reason</th>
                    <th class="px-3 py-2">Units</th>
                    <th class="px-3 py-2">Acquired</th>
                  </tr>
                </thead>
                <tbody>
                  {#each data.leases as lease (lease.leaseId)}
                    <tr class="border-t border-bark-200">
                      <td class="px-3 py-2 font-mono text-xs">{shortId(lease.companionId)}</td>
                      <td class="px-3 py-2">{lease.status}</td>
                      <td class="px-3 py-2 text-xs text-shadow-600">{lease.reason ?? '--'}</td>
                      <td class="px-3 py-2 tabular-nums text-xs">{lease.chargedUnits}</td>
                      <td class="px-3 py-2 text-xs text-shadow-500">{formatRelative(lease.acquiredAtMs)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </div>
      </section>

      <section class="grid gap-6 lg:grid-cols-2">
        <div class="space-y-3">
          <h2 class="text-lg font-semibold text-shadow-800">Participation</h2>
          {#if data.participation.length === 0}
            <p class="text-sm text-shadow-500">No participation recorded.</p>
          {:else}
            <div class="overflow-x-auto rounded-lg border border-bark-300 bg-white">
              <table class="min-w-full text-sm">
                <thead class="bg-bark-100 text-left text-xs uppercase tracking-wide text-shadow-500">
                  <tr>
                    <th class="px-3 py-2">Companion</th>
                    <th class="px-3 py-2">Episodes</th>
                    <th class="px-3 py-2">Total spoke</th>
                    <th class="px-3 py-2">Last spoke</th>
                  </tr>
                </thead>
                <tbody>
                  {#each data.participation as row (row.companionId)}
                    <tr class="border-t border-bark-200">
                      <td class="px-3 py-2 font-mono text-xs">{shortId(row.companionId)}</td>
                      <td class="px-3 py-2 tabular-nums">{row.episodeCount}</td>
                      <td class="px-3 py-2 tabular-nums">{row.totalSpeakCount}</td>
                      <td class="px-3 py-2 text-xs text-shadow-500">{formatRelative(row.lastSpokeAtMs)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </div>

        <div class="space-y-3">
          <h2 class="text-lg font-semibold text-shadow-800">Reason codes</h2>
          {#if data.reasonCounts.length === 0}
            <p class="text-sm text-shadow-500">No reason codes recorded.</p>
          {:else}
            <ul class="space-y-1">
              {#each data.reasonCounts as entry (entry.reason)}
                <li class="flex items-center justify-between rounded border border-bark-200 bg-white px-3 py-2 text-sm">
                  <span class="font-mono text-xs text-shadow-700">{entry.reason}</span>
                  <span class="tabular-nums text-shadow-600">{entry.count}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </section>
    {/if}
  </main>
</div>
