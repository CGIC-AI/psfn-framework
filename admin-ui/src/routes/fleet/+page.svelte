<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    fetchFleetCardDetails,
    fetchFleetPortalProjection,
    resolveFleetCardHealth,
    type FleetCardDetails,
    type FleetPortalProjection,
  } from '$lib/fleet/portal';
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
        : 'Fleet status is temporarily unavailable';
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
  <title>Fleet · Garden</title>
</svelte:head>

<div class="min-h-screen bg-bark-100 px-4 py-8 sm:px-6 lg:px-8">
  <main class="mx-auto max-w-7xl">
    <header class="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="text-xs font-semibold uppercase tracking-[0.22em] text-gold-700">
          Garden control plane
        </p>
        <h1 class="mt-2 font-serif text-3xl font-semibold text-shadow-900">
          Authorized fleet
        </h1>
        <p class="mt-2 max-w-2xl text-sm text-shadow-600">
          Choose a companion to open their server-authorized Garden. This view
          separates agent, Garden transport, and channel health, with redacted
          welfare posture and
          authorized usage and cost totals for companions your session may reach.
        </p>
      </div>
      {#if projection}
        <p class="text-xs text-shadow-500">
          Updated {new Date(projection.generatedAt).toLocaleString()}
        </p>
      {/if}
    </header>

    <FleetUsageSummary {companionNames} />

    {#if loading}
      <section class="card-garden p-8" aria-busy="true" aria-live="polite">
        <p class="text-sm text-shadow-600">Loading authorized companions…</p>
      </section>
    {:else if errorMessage}
      <section class="card-garden border-wilt-200 p-8" role="alert">
        <h2 class="font-serif text-xl font-semibold text-shadow-900">Fleet view unavailable</h2>
        <p class="mt-2 text-sm text-shadow-600">{errorMessage}</p>
        <button
          type="button"
          class="mt-5 rounded-lg bg-gold-400 px-4 py-2 text-sm font-medium text-bark-50 hover:bg-gold-500"
          onclick={() => void loadFleet()}
        >
          Try again
        </button>
      </section>
    {:else if projection?.companions.length === 0}
      <section class="card-garden p-8">
        <h2 class="font-serif text-xl font-semibold text-shadow-900">No Garden access</h2>
        <p class="mt-2 text-sm text-shadow-600">
          No companions are currently available to this account.
        </p>
      </section>
    {:else if projection}
      <section
        class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
        aria-label="Authorized companions"
      >
        {#each projection.companions as companion (companion.companionId)}
          {@const details = cardDetails[companion.companionId]}
          {@const health = resolveFleetCardHealth(companion, details)}
          <article class="card-garden flex min-h-64 flex-col p-5">
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
                <p class="mt-1 truncate font-mono text-[0.68rem] text-shadow-500">
                  {companion.companionId}
                </p>
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

            <div class="mt-auto pt-6">
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
                  class="inline-flex rounded-lg bg-gold-400 px-4 py-2 text-sm font-medium text-bark-50 transition-colors hover:bg-gold-500"
                >
                  Open Garden
                </a>
              {/if}
            </div>
          </article>
        {/each}
      </section>
      <FleetCostUsage mode="fleet" {projection} />
    {/if}
  </main>
</div>
