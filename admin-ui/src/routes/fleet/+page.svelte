<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    fetchFleetCardDetails,
    fetchFleetPortalProjection,
    resolveFleetCardHealth,
    type FleetCardDetails,
    type FleetPortalProjection,
  } from '$lib/fleet/portal';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import FleetCostUsage from '$lib/components/fleet/FleetCostUsage.svelte';
  import FleetUsageSummary from '$lib/components/fleet/FleetUsageSummary.svelte';

  let projection = $state<FleetPortalProjection | null>(null);
  let cardDetails = $state<Record<string, FleetCardDetails>>({});
  let loading = $state(true);
  let errorMessage = $state('');
  let controller: AbortController | null = null;
  const companionNames = $derived(
    projection
      ? Object.fromEntries(projection.companions.map(companion => [
          companion.companionId,
          companion.displayName,
        ]))
      : {},
  );
  const fleetSummary = $derived.by(() => {
    if (!projection) {
      return { authorized: 0, reachable: 0, healthy: 0, attention: 0 };
    }
    let reachable = 0;
    let healthy = 0;
    let attention = 0;
    for (const companion of projection.companions) {
      const health = resolveFleetCardHealth(companion, cardDetails[companion.companionId]);
      if (companion.gardenPath && health.adminTransport === 'up') reachable += 1;
      if (health.agentRpc === 'up' && health.adminTransport === 'up' && health.channels === 'up') {
        healthy += 1;
      } else if (health.agentRpc === 'down' || health.adminTransport === 'down' || health.channels === 'down') {
        attention += 1;
      }
    }
    return {
      authorized: projection.companions.length,
      reachable,
      healthy,
      attention,
    };
  });

  async function loadFleet(): Promise<void> {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    loading = true;
    errorMessage = '';
    projection = null;
    cardDetails = {};
    try {
      const result = await fetchFleetPortalProjection(request.signal);
      if (controller !== request) return;
      projection = result;
      const details = await Promise.all(result.companions.map(async companion => (
        [companion.companionId, await fetchFleetCardDetails(companion, request.signal)] as const
      )));
      if (controller !== request) return;
      cardDetails = Object.fromEntries(details);
    } catch (error) {
      if (request.signal.aborted || controller !== request) return;
      errorMessage = error instanceof Error
        ? error.message
        : 'Cluster status is temporarily unavailable';
    } finally {
      if (controller === request) loading = false;
    }
  }

  onMount(() => {
    void loadFleet();
  });

  onDestroy(() => {
    controller?.abort();
    controller = null;
  });

  function displayLabel(value: string): string {
    return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
  }

  function healthClass(value: string): string {
    if (value === 'up') return 'bg-moss-50 text-moss-700 border-moss-200';
    if (value === 'down') return 'bg-wilt-50 text-wilt-700 border-wilt-200';
    return 'bg-bark-100 text-shadow-600 border-bark-300';
  }

  function companionInitial(displayName: string): string {
    return displayName.trim().slice(0, 1).toUpperCase() || '?';
  }

  function discardBrokenAvatar(companionId: string): void {
    const details = cardDetails[companionId];
    if (!details?.avatarUrl) return;
    cardDetails = {
      ...cardDetails,
      [companionId]: { adminTransport: details.adminTransport },
    };
  }

  function postureClass(value: string): string {
    if (value === 'clear') return 'text-moss-700';
    if (value === 'pressured') return 'text-gold-700';
    return 'text-wilt-700';
  }

</script>

<svelte:head>
  <title>Cluster · Garden</title>
</svelte:head>

<div class="console-page-frame min-h-screen pb-12">
  <div class="mx-auto max-w-[100rem] px-4 pt-4 sm:px-6 lg:px-8">
      {#snippet clusterActions()}
        {#if projection}
          <span class="garden-status garden-status--success rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-xs text-shadow-600">
            Updated {new Date(projection.generatedAt).toLocaleString()}
          </span>
        {/if}
        <button
          type="button"
          class="garden-action rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm font-medium text-shadow-700 transition-colors hover:border-gold-300 hover:text-shadow-900 disabled:opacity-50"
          disabled={loading}
          onclick={() => void loadFleet()}
        >
          {loading ? 'Refreshing…' : 'Refresh cluster'}
        </button>
      {/snippet}
      <GardenPageHeader
        eyebrow="Garden Cluster · All companions"
        title="The Grove"
        description="Aggregate health, posture, usage, and cost across every companion this fleet session is authorized to reach."
        actions={clusterActions}
      />
  </div>

  <main class="mx-auto max-w-[100rem] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    {#if projection}
      <section class="garden-metric-grid grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Cluster health summary">
        <article class="garden-metric card-garden p-4">
          <p class="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-shadow-500">Authorized</p>
          <p class="mt-2 font-serif text-3xl font-semibold tabular-nums text-shadow-900">{fleetSummary.authorized}</p>
          <p class="mt-1 text-xs text-shadow-500">companions visible to this session</p>
        </article>
        <article class="garden-metric card-garden p-4">
          <p class="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-shadow-500">Gardens reachable</p>
          <p class="mt-2 font-serif text-3xl font-semibold tabular-nums text-moss-700">{fleetSummary.reachable}</p>
          <p class="mt-1 text-xs text-shadow-500">admin transport confirmed up</p>
        </article>
        <article class="garden-metric card-garden p-4">
          <p class="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-shadow-500">Fully healthy</p>
          <p class="mt-2 font-serif text-3xl font-semibold tabular-nums text-gold-700">{fleetSummary.healthy}</p>
          <p class="mt-1 text-xs text-shadow-500">agent, admin, and channels up</p>
        </article>
        <article class="garden-metric card-garden p-4">
          <p class="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-shadow-500">Needs attention</p>
          <p class="mt-2 font-serif text-3xl font-semibold tabular-nums {fleetSummary.attention > 0 ? 'text-wilt-600' : 'text-shadow-900'}">{fleetSummary.attention}</p>
          <p class="mt-1 text-xs text-shadow-500">one or more dimensions confirmed down</p>
        </article>
      </section>
    {/if}

    <FleetUsageSummary {companionNames} />

    {#if loading}
      <section class="garden-loading card-garden p-8" aria-busy="true" aria-live="polite">
        <p class="text-sm text-shadow-600">Loading authorized companions…</p>
      </section>
    {:else if errorMessage}
      <section class="garden-error card-garden border-wilt-200 p-8" role="alert">
        <h2 class="font-serif text-xl font-semibold text-shadow-900">Cluster view unavailable</h2>
        <p class="mt-2 text-sm text-shadow-600">{errorMessage}</p>
        <button
          type="button"
          class="garden-action garden-action--primary mt-5 rounded-lg bg-gold-600 px-4 py-2 text-sm font-medium text-white hover:bg-gold-700"
          onclick={() => void loadFleet()}
        >
          Try again
        </button>
      </section>
    {:else if projection?.companions.length === 0}
      <section class="garden-empty card-garden p-8">
        <h2 class="font-serif text-xl font-semibold text-shadow-900">No Garden access</h2>
        <p class="mt-2 text-sm text-shadow-600">
          No companions are currently available to this account.
        </p>
      </section>
    {:else if projection}
      <section class="garden-section" aria-labelledby="companion-health-heading">
        <div class="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <p class="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-shadow-500">Live projection</p>
            <h2 id="companion-health-heading" class="font-serif text-xl font-semibold text-shadow-900">Companion health</h2>
          </div>
          <p class="text-xs text-shadow-500">Health is dimension-specific; unknown is not treated as down.</p>
        </div>
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {#each projection.companions as companion (companion.companionId)}
          {@const details = cardDetails[companion.companionId]}
          {@const health = resolveFleetCardHealth(companion, details)}
          <article class="card-garden flex min-h-64 flex-col overflow-hidden">
            <div class="h-1 bg-gradient-to-r from-gold-300 via-gold-500 to-transparent"></div>
            <div class="flex flex-1 flex-col p-5">
            <div class="flex items-start gap-3">
              {#if details?.avatarUrl}
                <img
                  src={details.avatarUrl}
                  alt=""
                  class="h-14 w-14 shrink-0 rounded-xl border border-bark-200 object-cover"
                  onerror={() => discardBrokenAvatar(companion.companionId)}
                />
              {:else}
                <div
                  class="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-bark-200 bg-bark-100 font-serif text-xl font-semibold text-gold-700"
                  aria-hidden="true"
                >
                  {companionInitial(companion.displayName)}
                </div>
              {/if}
              <div class="min-w-0">
                <h2 class="truncate font-serif text-xl font-semibold text-shadow-900">
                  {companion.displayName}
                </h2>
                <details class="mt-1 text-[0.68rem] text-shadow-500">
                  <summary class="cursor-pointer">Technical details</summary>
                  <p class="mt-1 break-all font-mono">Companion ID {companion.companionId}</p>
                </details>
              </div>
            </div>

            <div class="mt-4 flex flex-wrap gap-2 border-t border-bark-200 pt-4" aria-label="Companion health">
              <span class={`rounded-full border px-2.5 py-1 text-xs font-medium ${healthClass(health.agentRpc)}`}>
                Agent {displayLabel(health.agentRpc)}
              </span>
              <span class={`rounded-full border px-2.5 py-1 text-xs font-medium ${healthClass(health.adminTransport)}`}>
                Admin {health.adminTransport === 'down' ? 'Unreachable' : displayLabel(health.adminTransport)}
              </span>
              <span class={`rounded-full border px-2.5 py-1 text-xs font-medium ${healthClass(health.channels)}`}>
                Channels {displayLabel(health.channels)}
              </span>
            </div>

            <div class="mt-4 border-t border-bark-200 pt-4">
              {#if companion.posture.status === 'unavailable'}
                <p class="text-sm font-medium text-shadow-600">Posture unavailable</p>
                <p class="mt-1 text-xs text-shadow-500">
                  No bounded charge or fatigue report has arrived.
                </p>
              {:else}
                <div class="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p class="text-xs uppercase tracking-wide text-shadow-500">Charge</p>
                    <p class={`mt-1 font-medium ${postureClass(companion.posture.charge.state)}`}>
                      {displayLabel(companion.posture.charge.state)}
                      · {companion.posture.charge.utilizationPercent}%
                    </p>
                  </div>
                  <div>
                    <p class="text-xs uppercase tracking-wide text-shadow-500">Fatigue</p>
                    <p class={`mt-1 font-medium ${postureClass(companion.posture.fatigue.state)}`}>
                      {displayLabel(companion.posture.fatigue.state)}
                      · {companion.posture.fatigue.utilizationPercent}%
                    </p>
                  </div>
                </div>
                <p
                  class={`mt-3 text-xs ${companion.posture.status === 'stale' ? 'font-medium text-wilt-700' : 'text-shadow-500'}`}
                >
                  {companion.posture.status === 'stale' ? 'Stale report' : 'Posture updated'}
                  · {new Date(companion.posture.updatedAt).toLocaleString()}
                </p>
              {/if}
            </div>

            <div class="mt-auto border-t border-bark-200 pt-4">
              {#if !companion.gardenPath}
                <p class="text-sm text-shadow-500">Garden access unavailable.</p>
              {:else if health.adminTransport !== 'up'}
                <span
                  class="inline-flex cursor-not-allowed rounded-lg border border-bark-300 px-4 py-2 text-sm font-medium text-shadow-500"
                  aria-disabled="true"
                >
                  {health.adminTransport === 'down'
                    ? 'Admin transport unreachable'
                    : 'Garden reachability unknown'}
                </span>
              {:else}
                <a
                  href={companion.gardenPath}
                  class="garden-action garden-action--primary inline-flex min-h-10 w-full items-center justify-center rounded-lg bg-gold-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gold-700"
                >
                  Open Garden
                </a>
              {/if}
            </div>
            </div>
          </article>
        {/each}
        </div>
      </section>
      <FleetCostUsage mode="fleet" {projection} />
    {/if}
  </main>
</div>
