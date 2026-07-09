<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getPlaces,
    rebindSatellite,
    type AdminPlacesData,
    type AdminPlaceView,
    type AdminAffordanceView,
    type AdminBoundSatelliteView,
  } from '$lib/api/endpoints/places';
  import { pushToast } from '$lib/stores/toast.svelte';

  let data = $state<AdminPlacesData | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let errorMessage = $state('');

  // Per-satellite pending re-bind selection ('' = unbind) and in-flight guard.
  let pendingBinding = $state<Record<string, string>>({});
  let savingSat = $state('');

  function labelize(value: string): string {
    return value
      .replace(/_/g, ' ')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  // Twin (physical<->virtual overlap) is naming-convention only until vinz.29
  // lands a formal link: strip a `latent_`/`virtual_` prefix and pair a physical
  // place with a virtual place that normalizes to the same key.
  function twinKey(placeId: string): string {
    return placeId.replace(/^(latent|virtual)[_-]/i, '').toLowerCase();
  }

  let twinById = $derived.by(() => {
    const map = new Map<string, AdminPlaceView>();
    const byKey = new Map<string, AdminPlaceView[]>();
    for (const place of data?.places ?? []) {
      const key = twinKey(place.placeId);
      const bucket = byKey.get(key) ?? [];
      bucket.push(place);
      byKey.set(key, bucket);
    }
    for (const bucket of byKey.values()) {
      if (bucket.length < 2) continue;
      const physical = bucket.find((p) => p.kind === 'physical');
      const virtual = bucket.find((p) => p.kind === 'virtual');
      if (physical && virtual) {
        map.set(physical.placeId, virtual);
        map.set(virtual.placeId, physical);
      }
    }
    return map;
  });

  let placesBySite = $derived.by(() => {
    const groups = new Map<string, { siteId: string; displayName: string; kind: string; places: AdminPlaceView[] }>();
    for (const site of data?.sites ?? []) {
      groups.set(site.siteId, { siteId: site.siteId, displayName: site.displayName, kind: site.kind, places: [] });
    }
    for (const place of data?.places ?? []) {
      const group = groups.get(place.siteId);
      if (group) group.places.push(place);
    }
    return [...groups.values()];
  });

  let stats = $derived.by(() => {
    const places = data?.places ?? [];
    return {
      sites: data?.sites.length ?? 0,
      places: places.length,
      physical: places.filter((p) => p.kind === 'physical').length,
      virtual: places.filter((p) => p.kind === 'virtual').length,
      affordances: places.reduce((sum, p) => sum + p.affordances.length, 0),
      overlaps: twinById.size / 2,
      unbound: data?.unboundSatellites.length ?? 0,
      dangling: data?.danglingSatellites.length ?? 0,
    };
  });

  async function loadData(): Promise<void> {
    errorMessage = '';
    try {
      const next = await getPlaces();
      applyData(next);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Failed to load places registry.';
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  function applyData(next: AdminPlacesData): void {
    data = next;
    const bindings: Record<string, string> = {};
    for (const place of next.places) {
      for (const sat of place.satellites) bindings[sat.satelliteId] = place.placeId;
    }
    for (const sat of next.unboundSatellites) bindings[sat.satelliteId] = '';
    for (const sat of next.danglingSatellites) bindings[sat.satelliteId] = '';
    pendingBinding = bindings;
  }

  async function refreshData(): Promise<void> {
    refreshing = true;
    await loadData();
  }

  async function saveBinding(satelliteId: string): Promise<void> {
    if (savingSat) return;
    savingSat = satelliteId;
    const target = pendingBinding[satelliteId] || null;
    try {
      const result = await rebindSatellite(satelliteId, target);
      applyData(result.places);
      pushToast(
        target ? `Bound ${satelliteId} → ${target}` : `Unbound ${satelliteId}`,
        'success'
      );
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Re-bind failed', 'error');
    } finally {
      savingSat = '';
    }
  }

  function affordanceTone(affordance: AdminAffordanceView): string {
    return affordance.role === 'effector'
      ? 'bg-petal-50 text-petal-700'
      : 'bg-gold-50 text-gold-700';
  }

  onMount(() => {
    void loadData();
  });
</script>

<div class="space-y-8">
  <div class="flex items-start justify-between gap-4 flex-wrap">
    <div>
      <p class="text-xs uppercase tracking-[0.2em] text-shadow-500">World Model</p>
      <h1 class="mt-1 text-2xl font-serif font-bold text-shadow-900">Places</h1>
      <p class="mt-1 max-w-3xl text-sm text-shadow-600">
        Sites, places, and affordances joined to the satellite registry. Physical places carry Home
        Assistant areas; virtual places live in the latent space. Re-binding a satellite is the only
        write here — it fails closed on an unknown place.
      </p>
    </div>
    <button
      onclick={refreshData}
      disabled={refreshing}
      class="rounded-xl border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {refreshing ? 'Refreshing...' : 'Refresh'}
    </button>
  </div>

  {#if errorMessage}
    <div class="card-garden border-l-4 border-l-wilt-400 p-4">
      <p class="text-sm font-medium text-wilt-700">{errorMessage}</p>
    </div>
  {/if}

  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
    <div class="card-garden p-5">
      <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Places</p>
      <p class="mt-3 text-4xl font-serif font-bold text-shadow-900">{loading ? '-' : stats.places}</p>
      <p class="mt-2 text-sm text-shadow-600">Across {stats.sites} sites.</p>
    </div>
    <div class="card-garden p-5">
      <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Physical / Virtual</p>
      <p class="mt-3 text-4xl font-serif font-bold text-moss-600">
        {loading ? '-' : stats.physical}<span class="text-shadow-400"> / </span><span class="text-petal-500">{loading ? '-' : stats.virtual}</span>
      </p>
      <p class="mt-2 text-sm text-shadow-600">{stats.overlaps} twinned overlap{stats.overlaps === 1 ? '' : 's'}.</p>
    </div>
    <div class="card-garden p-5">
      <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Affordances</p>
      <p class="mt-3 text-4xl font-serif font-bold text-gold-600">{loading ? '-' : stats.affordances}</p>
      <p class="mt-2 text-sm text-shadow-600">Perceivers and effectors.</p>
    </div>
    <div class="card-garden p-5" class:border-l-4={stats.dangling > 0} class:border-l-wilt-400={stats.dangling > 0}>
      <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Satellites</p>
      <p class="mt-3 text-4xl font-serif font-bold" class:text-wilt-600={stats.dangling > 0} class:text-shadow-900={stats.dangling === 0}>
        {loading ? '-' : stats.unbound + stats.dangling}
      </p>
      <p class="mt-2 text-sm text-shadow-600">{stats.unbound} unbound · {stats.dangling} dangling.</p>
    </div>
  </div>

  {#if loading && !data}
    <div class="grid gap-4 lg:grid-cols-2">
      {#each Array(2) as _}
        <div class="card-garden animate-pulse p-5">
          <div class="h-4 w-32 rounded bg-bark-200"></div>
          <div class="mt-3 h-8 w-48 rounded bg-bark-100"></div>
          <div class="mt-4 h-3 w-full rounded bg-bark-100"></div>
        </div>
      {/each}
    </div>
  {:else if data}
    {#each placesBySite as site}
      <section class="space-y-4" aria-label={`Site ${site.displayName}`}>
        <div class="flex items-baseline gap-3 flex-wrap">
          <h2 class="text-lg font-serif font-semibold text-shadow-900">{site.displayName}</h2>
          <span
            class="rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-[0.14em]"
            class:bg-moss-50={site.kind === 'physical'}
            class:text-moss-700={site.kind === 'physical'}
            class:bg-petal-50={site.kind === 'virtual'}
            class:text-petal-700={site.kind === 'virtual'}
          >{site.kind}</span>
          <span class="text-sm text-shadow-500">{site.places.length} place{site.places.length === 1 ? '' : 's'}</span>
        </div>

        {#if site.places.length === 0}
          <div class="card-garden p-5"><p class="text-sm text-shadow-500">No places in this site.</p></div>
        {:else}
          <div class="grid gap-4 lg:grid-cols-2">
            {#each site.places as place (place.placeId)}
              {@const twin = twinById.get(place.placeId)}
              <article class="card-garden p-5 space-y-4">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <div class="flex items-center gap-2 flex-wrap">
                      <h3 class="text-xl font-serif font-semibold text-shadow-900">{place.displayName}</h3>
                      <span
                        class="rounded-full px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.12em]"
                        class:bg-moss-50={place.kind === 'physical'}
                        class:text-moss-700={place.kind === 'physical'}
                        class:bg-petal-50={place.kind === 'virtual'}
                        class:text-petal-700={place.kind === 'virtual'}
                      >{place.kind}</span>
                    </div>
                    <p class="mt-1 text-xs font-mono text-shadow-500">{place.placeId}</p>
                  </div>
                  {#if twin}
                    <span
                      class="shrink-0 rounded-full bg-gold-50 px-2.5 py-1 text-xs font-semibold text-gold-700"
                      title={`Naming-convention twin of ${twin.placeId} (formal link pending vinz.29)`}
                    >⇄ {twin.displayName}</span>
                  {/if}
                </div>

                {#if place.description}
                  <p class="text-sm text-shadow-600">{place.description}</p>
                {/if}

                <dl class="grid gap-3 text-sm sm:grid-cols-2">
                  {#if place.haAreaId}
                    <div>
                      <dt class="text-xs uppercase tracking-[0.14em] text-shadow-500">HA Area</dt>
                      <dd class="mt-1 font-mono text-shadow-700">{place.haAreaId}</dd>
                    </div>
                  {/if}
                  <div>
                    <dt class="text-xs uppercase tracking-[0.14em] text-shadow-500">Site</dt>
                    <dd class="mt-1 text-shadow-700">{place.siteId}</dd>
                  </div>
                </dl>

                <div>
                  <p class="text-xs uppercase tracking-[0.14em] text-shadow-500">Affordances</p>
                  {#if place.affordances.length === 0}
                    <p class="mt-1 text-sm text-shadow-400">None</p>
                  {:else}
                    <div class="mt-2 flex flex-wrap gap-2">
                      {#each place.affordances as affordance}
                        <span
                          class={`rounded-full px-2.5 py-1 text-xs font-medium ${affordanceTone(affordance)}`}
                          title={`${affordance.role} · ${affordance.backend}${affordance.entityId ? ` · ${affordance.entityId}` : ''}${affordance.control?.length ? ` · ${affordance.control.join(', ')}` : ''}`}
                        >
                          {affordance.displayName ?? labelize(affordance.kind)}
                          <span class="opacity-60">· {affordance.role}</span>
                        </span>
                      {/each}
                    </div>
                  {/if}
                </div>

                <div>
                  <p class="text-xs uppercase tracking-[0.14em] text-shadow-500">Bound Satellites</p>
                  {#if place.satellites.length === 0}
                    <p class="mt-1 text-sm text-shadow-400">None</p>
                  {:else}
                    <ul class="mt-2 space-y-3">
                      {#each place.satellites as sat (sat.satelliteId)}
                        <li class="rounded-lg border border-bark-200 p-3">
                          <div class="flex items-center justify-between gap-2">
                            <div>
                              <p class="text-sm font-medium text-shadow-800">{sat.displayName}</p>
                              <p class="text-xs font-mono text-shadow-500">{sat.satelliteId} · {labelize(sat.mobility)}</p>
                            </div>
                          </div>
                          <div class="mt-2 flex items-center gap-2">
                            <select
                              bind:value={pendingBinding[sat.satelliteId]}
                              class="min-w-0 flex-1 rounded-lg border border-bark-300 bg-bark-50 px-2 py-1.5 text-sm text-shadow-800"
                            >
                              <option value="">— Unbound —</option>
                              {#each placesBySite as optSite}
                                <optgroup label={optSite.displayName}>
                                  {#each optSite.places as optPlace}
                                    <option value={optPlace.placeId}>{optPlace.displayName}</option>
                                  {/each}
                                </optgroup>
                              {/each}
                            </select>
                            <button
                              onclick={() => saveBinding(sat.satelliteId)}
                              disabled={savingSat === sat.satelliteId || pendingBinding[sat.satelliteId] === place.placeId}
                              class="rounded-lg border border-bark-300 px-3 py-1.5 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {savingSat === sat.satelliteId ? 'Saving...' : 'Re-bind'}
                            </button>
                          </div>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              </article>
            {/each}
          </div>
        {/if}
      </section>
    {/each}

    {#if data.unboundSatellites.length > 0}
      <section class="space-y-4" aria-label="Unbound satellites">
        <h2 class="text-lg font-serif font-semibold text-shadow-900">Unbound Satellites</h2>
        <p class="text-sm text-shadow-600">Registered satellites with no static place binding. Bind them to a place below.</p>
        <div class="grid gap-3 lg:grid-cols-2">
          {#each data.unboundSatellites as sat (sat.satelliteId)}
            <div class="card-garden p-4">
              <div class="flex items-center justify-between gap-2">
                <div>
                  <p class="text-sm font-medium text-shadow-800">{sat.displayName}</p>
                  <p class="text-xs font-mono text-shadow-500">{sat.satelliteId} · {labelize(sat.mobility)}</p>
                </div>
              </div>
              <div class="mt-3 flex items-center gap-2">
                <select
                  bind:value={pendingBinding[sat.satelliteId]}
                  class="min-w-0 flex-1 rounded-lg border border-bark-300 bg-bark-50 px-2 py-1.5 text-sm text-shadow-800"
                >
                  <option value="">— Unbound —</option>
                  {#each placesBySite as optSite}
                    <optgroup label={optSite.displayName}>
                      {#each optSite.places as optPlace}
                        <option value={optPlace.placeId}>{optPlace.displayName}</option>
                      {/each}
                    </optgroup>
                  {/each}
                </select>
                <button
                  onclick={() => saveBinding(sat.satelliteId)}
                  disabled={savingSat === sat.satelliteId || !pendingBinding[sat.satelliteId]}
                  class="rounded-lg border border-bark-300 px-3 py-1.5 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {savingSat === sat.satelliteId ? 'Saving...' : 'Bind'}
                </button>
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    {#if data.danglingSatellites.length > 0}
      <section class="space-y-4" aria-label="Dangling satellites">
        <div class="flex items-baseline gap-3">
          <h2 class="text-lg font-serif font-semibold text-wilt-700">Dangling Satellites</h2>
          <span class="text-sm text-shadow-500">Fail-closed surfacing</span>
        </div>
        <p class="text-sm text-shadow-600">
          These satellites are bound to a <code class="font-mono">placeId</code> that is absent from
          <code class="font-mono">places.json</code>. Re-bind each to an existing place to clear the
          dangling reference.
        </p>
        <div class="grid gap-3 lg:grid-cols-2">
          {#each data.danglingSatellites as sat (sat.satelliteId)}
            <div class="card-garden border-l-4 border-l-wilt-400 p-4">
              <div class="flex items-center justify-between gap-2">
                <div>
                  <p class="text-sm font-medium text-shadow-800">{sat.displayName}</p>
                  <p class="text-xs font-mono text-shadow-500">{sat.satelliteId} · {labelize(sat.mobility)}</p>
                </div>
                <span class="shrink-0 rounded-full bg-wilt-50 px-2.5 py-1 text-xs font-semibold text-wilt-700">
                  missing: {sat.placeId}
                </span>
              </div>
              <div class="mt-3 flex items-center gap-2">
                <select
                  bind:value={pendingBinding[sat.satelliteId]}
                  class="min-w-0 flex-1 rounded-lg border border-bark-300 bg-bark-50 px-2 py-1.5 text-sm text-shadow-800"
                >
                  <option value="">— Unbind —</option>
                  {#each placesBySite as optSite}
                    <optgroup label={optSite.displayName}>
                      {#each optSite.places as optPlace}
                        <option value={optPlace.placeId}>{optPlace.displayName}</option>
                      {/each}
                    </optgroup>
                  {/each}
                </select>
                <button
                  onclick={() => saveBinding(sat.satelliteId)}
                  disabled={savingSat === sat.satelliteId}
                  class="rounded-lg border border-bark-300 px-3 py-1.5 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {savingSat === sat.satelliteId ? 'Saving...' : 'Fix'}
                </button>
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}
  {/if}
</div>
