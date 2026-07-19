<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    fetchFleetPortalProjection,
    type FleetPortalProjection,
  } from '$lib/fleet/portal';

  let projection = $state<FleetPortalProjection | null>(null);
  let loading = $state(true);
  let errorMessage = $state('');
  let controller: AbortController | null = null;

  async function loadFleet(): Promise<void> {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    loading = true;
    errorMessage = '';
    projection = null;
    try {
      const result = await fetchFleetPortalProjection(request.signal);
      if (controller !== request) return;
      projection = result;
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

  function availabilityLabel(value: string): string {
    return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
  }

  function availabilityClass(value: string): string {
    if (value === 'online') return 'bg-moss-50 text-moss-700 border-moss-200';
    if (value === 'degraded') return 'bg-gold-50 text-gold-700 border-gold-200';
    if (value === 'offline') return 'bg-wilt-50 text-wilt-700 border-wilt-200';
    return 'bg-bark-100 text-shadow-600 border-bark-300';
  }
</script>

<svelte:head>
  <title>Fleet · Garden</title>
</svelte:head>

<div class="min-h-screen bg-bark-100 px-4 py-8 sm:px-6 lg:px-8">
  <main class="mx-auto max-w-6xl">
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
          contains only bounded connection health for companions your session may reach.
        </p>
      </div>
      {#if projection}
        <p class="text-xs text-shadow-500">
          Updated {new Date(projection.generatedAt).toLocaleString()}
        </p>
      {/if}
    </header>

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
          <article class="card-garden flex min-h-52 flex-col p-5">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h2 class="truncate font-serif text-xl font-semibold text-shadow-900">
                  {companion.displayName}
                </h2>
                <p class="mt-1 truncate font-mono text-[0.68rem] text-shadow-500">
                  {companion.companionId}
                </p>
              </div>
              <span
                class={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${availabilityClass(companion.availability)}`}
              >
                {availabilityLabel(companion.availability)}
              </span>
            </div>

            <div class="mt-auto pt-7">
              {#if !companion.gardenPath}
                <p class="text-sm text-shadow-500">Garden access unavailable.</p>
              {:else if companion.availability === 'offline' || companion.availability === 'unknown'}
                <span
                  class="inline-flex cursor-not-allowed rounded-lg border border-bark-300 px-4 py-2 text-sm font-medium text-shadow-500"
                  aria-disabled="true"
                >
                  {companion.availability === 'offline' ? 'Garden is offline' : 'Garden is not ready'}
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
    {/if}
  </main>
</div>
