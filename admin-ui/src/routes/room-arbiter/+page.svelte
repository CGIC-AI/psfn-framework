<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { getRoomArbiterData, type RoomArbiterData } from '$lib/api/endpoints/room-arbiter';
  import { createVisibilityAwarePoller } from '$lib/polling/visibility-aware-poller';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import {
    companionDisplayLabel,
    companionTechnicalLabel,
  } from '$lib/fleet/companion-display';
  import {
    fetchFleetPortalProjection,
    type FleetPortalCompanion,
  } from '$lib/fleet/portal';

  let data = $state<RoomArbiterData | null>(null);
  let loading = $state(true);
  let error = $state('');
  let displayCompanions = $state<readonly FleetPortalCompanion[]>([]);

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

  async function loadData(): Promise<void> {
    loading = true;
    error = '';
    try {
      const [nextData, projection] = await Promise.all([
        getRoomArbiterData(),
        fetchFleetPortalProjection().catch(() => null),
      ]);
      data = nextData;
      if (projection) displayCompanions = projection.companions;
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

<div class="garden-page space-y-6">
    <GardenPageHeader
      eyebrow="Live Operations"
      title="Cluster Command"
      description="Room-state and arbitration telemetry. Content-free by contract: identifiers, enums, counts, and timestamps only."
    >
      {#snippet actions()}
        <span class="garden-status garden-status--success inline-flex min-h-9 items-center rounded-full border border-bark-300 bg-bark-50 px-3 text-xs font-medium text-shadow-600">
          Auto-refresh · 15s
        </span>
      {/snippet}
    </GardenPageHeader>

    {#if loading && data === null}
      <div class="garden-loading card-garden animate-pulse p-8 text-center text-sm text-shadow-500" aria-busy="true">Loading room arbiter telemetry&hellip;</div>
    {:else if error}
      <div class="garden-error card-garden border-l-4 border-l-wilt-400 p-4 text-sm text-wilt-700" role="alert">
        {error}
      </div>
    {:else if !available}
      <div class="garden-empty card-garden p-6 text-center">
        <p class="font-serif text-lg text-shadow-900">Speaking arbiter inactive</p>
        <p class="mt-1 text-sm text-shadow-600">Room arbitration telemetry is available only in multi-companion mode.</p>
      </div>
    {:else if data}
      <section class="garden-metric-grid grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Arbiter summary">
        <div class="garden-metric card-garden p-4">
          <div class="text-xs uppercase tracking-wide text-shadow-500">Open episodes</div>
          <div class="mt-2 font-serif text-2xl font-semibold text-shadow-900">{data.summary.openEpisodeCount}</div>
        </div>
        <div class="garden-metric card-garden p-4">
          <div class="text-xs uppercase tracking-wide text-shadow-500">Suppressed</div>
          <div class="mt-2 font-serif text-2xl font-semibold text-wilt-600">{data.summary.suppressedEpisodeCount}</div>
        </div>
        <div class="garden-metric card-garden p-4">
          <div class="text-xs uppercase tracking-wide text-shadow-500">Active reservations</div>
          <div class="mt-2 font-serif text-2xl font-semibold text-shadow-900">{data.summary.activeReservationCount}</div>
        </div>
        <div class="garden-metric card-garden p-4">
          <div class="text-xs uppercase tracking-wide text-shadow-500">Held leases</div>
          <div class="mt-2 font-serif text-2xl font-semibold text-shadow-900">{data.summary.heldLeaseCount}</div>
        </div>
      </section>

      <section class="garden-section garden-table-shell card-garden overflow-hidden" aria-labelledby="room-episodes-heading">
        <div class="garden-section-header border-b border-bark-300 px-4 py-3">
          <h2 id="room-episodes-heading" class="font-serif text-lg font-semibold text-shadow-900">Room episodes</h2>
          <p class="mt-1 text-xs text-shadow-600">Pressure, participation, and Law 36 suppression state.</p>
        </div>
        {#if data.episodes.length === 0}
          <p class="garden-empty p-6 text-center text-sm text-shadow-500">No room episodes recorded.</p>
        {:else}
          <div class="garden-table-scroll overflow-x-auto">
            <table class="garden-table min-w-full text-sm">
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
                              <span>{companionDisplayLabel(displayCompanions, participant.companionId)}</span>
                              &middot; {participant.speakCount} spoke &middot; {formatRelative(participant.lastSpokeAtMs)}
                              <details class="mt-0.5 text-shadow-500">
                                <summary class="cursor-pointer">Technical details</summary>
                                <span class="break-all font-mono">{companionTechnicalLabel(participant.companionId)}</span>
                              </details>
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

      <section class="grid gap-4 lg:grid-cols-2">
        <div class="garden-section garden-table-shell card-garden overflow-hidden">
          <h2 class="border-b border-bark-300 px-4 py-3 font-serif text-lg font-semibold text-shadow-900">Reservations</h2>
          {#if data.reservations.length === 0}
            <p class="garden-empty p-6 text-center text-sm text-shadow-500">No reservations recorded.</p>
          {:else}
            <div class="garden-table-scroll overflow-x-auto">
              <table class="garden-table min-w-full text-sm">
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
                      <td class="px-3 py-2 text-xs"><p>{companionDisplayLabel(displayCompanions, reservation.companionId)}</p><details class="mt-1 text-shadow-500"><summary class="cursor-pointer">Technical details</summary><p class="break-all font-mono">{companionTechnicalLabel(reservation.companionId)}</p></details></td>
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

        <div class="garden-section garden-table-shell card-garden overflow-hidden">
          <h2 class="border-b border-bark-300 px-4 py-3 font-serif text-lg font-semibold text-shadow-900">Egress leases</h2>
          {#if data.leases.length === 0}
            <p class="garden-empty p-6 text-center text-sm text-shadow-500">No leases recorded.</p>
          {:else}
            <div class="garden-table-scroll overflow-x-auto">
              <table class="garden-table min-w-full text-sm">
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
                      <td class="px-3 py-2 text-xs"><p>{companionDisplayLabel(displayCompanions, lease.companionId)}</p><details class="mt-1 text-shadow-500"><summary class="cursor-pointer">Technical details</summary><p class="break-all font-mono">{companionTechnicalLabel(lease.companionId)}</p></details></td>
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

      <section class="grid gap-4 lg:grid-cols-2">
        <div class="garden-section garden-table-shell card-garden overflow-hidden">
          <h2 class="border-b border-bark-300 px-4 py-3 font-serif text-lg font-semibold text-shadow-900">Participation</h2>
          {#if data.participation.length === 0}
            <p class="garden-empty p-6 text-center text-sm text-shadow-500">No participation recorded.</p>
          {:else}
            <div class="garden-table-scroll overflow-x-auto">
              <table class="garden-table min-w-full text-sm">
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
                      <td class="px-3 py-2 text-xs"><p>{companionDisplayLabel(displayCompanions, row.companionId)}</p><details class="mt-1 text-shadow-500"><summary class="cursor-pointer">Technical details</summary><p class="break-all font-mono">{companionTechnicalLabel(row.companionId)}</p></details></td>
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

        <div class="garden-section card-garden p-4">
          <h2 class="font-serif text-lg font-semibold text-shadow-900">Reason codes</h2>
          {#if data.reasonCounts.length === 0}
            <p class="garden-empty mt-4 rounded-lg border border-dashed border-bark-300 p-6 text-center text-sm text-shadow-500">No reason codes recorded.</p>
          {:else}
            <ul class="mt-3 space-y-1">
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
</div>
