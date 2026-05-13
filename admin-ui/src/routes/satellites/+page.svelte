<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getSatellites,
    type AdminSatelliteRegistryView,
  } from '$lib/api/endpoints/satellites';

  const EMPTY_LABEL = 'None';

  let data = $state<AdminSatelliteRegistryView | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let errorMessage = $state('');

  let endpoints = $derived.by(() => (
    data?.satellites.flatMap(satellite => (
      satellite.endpoints.map(endpoint => ({ satellite, endpoint }))
    )) ?? []
  ));

  let effectiveCapabilityCount = $derived.by(() => (
    new Set(endpoints.flatMap(({ endpoint }) => endpoint.maxCapabilities)).size
  ));

  async function loadData(): Promise<void> {
    errorMessage = '';
    try {
      data = await getSatellites();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Failed to load satellite registry.';
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  async function refreshData(): Promise<void> {
    refreshing = true;
    await loadData();
  }

  function labelize(value: string): string {
    return value
      .replace(/_/g, ' ')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, char => char.toUpperCase());
  }

  function joinLabels(values: string[]): string {
    return values.length > 0 ? values.map(labelize).join(', ') : EMPTY_LABEL;
  }

  onMount(() => {
    void loadData();
  });
</script>

<div class="space-y-8">
  <div class="flex items-start justify-between gap-4 flex-wrap">
    <div>
      <p class="text-xs uppercase tracking-[0.2em] text-shadow-500">Emanation Ports</p>
      <h1 class="mt-1 text-2xl font-serif font-bold text-shadow-900">Satellites</h1>
      <p class="mt-1 max-w-3xl text-sm text-shadow-600">
        Registered satellite embodiments and endpoint claim ceilings. This page shows framework authority, not device-reported wishes.
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

  <section class="space-y-4" aria-labelledby="satellite-overview-heading">
    <div>
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Registry</p>
      <h2 id="satellite-overview-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
        Claim authority
      </h2>
      <p class="mt-1 text-sm text-shadow-600">
        Unknown satellites, endpoints, claim types, and capabilities fail closed before the turn reaches the companion.
      </p>
    </div>

    <div class="grid gap-4 md:grid-cols-4">
      <div class="card-garden p-5">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Registry</p>
        <p
          class="mt-3 text-3xl font-serif font-bold"
          class:text-petal-600={data?.enabled}
          class:text-wilt-500={!data?.enabled}
        >
          {loading ? '-' : data?.enabled ? 'Enabled' : 'Disabled'}
        </p>
        <p class="mt-2 text-sm text-shadow-600">Authority file: satellites.json.</p>
      </div>
      <div class="card-garden p-5">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Satellites</p>
        <p class="mt-3 text-4xl font-serif font-bold text-shadow-900">{data?.satelliteCount ?? '-'}</p>
        <p class="mt-2 text-sm text-shadow-600">Embodiment nodes registered for this companion.</p>
      </div>
      <div class="card-garden p-5">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Endpoints</p>
        <p class="mt-3 text-4xl font-serif font-bold text-gold-600">{data?.endpointCount ?? '-'}</p>
        <p class="mt-2 text-sm text-shadow-600">Claimable surfaces bound to auth and policy.</p>
      </div>
      <div class="card-garden p-5">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Capability Kinds</p>
        <p class="mt-3 text-4xl font-serif font-bold text-petal-500">{loading ? '-' : effectiveCapabilityCount}</p>
        <p class="mt-2 text-sm text-shadow-600">Distinct capability ceilings in the registry.</p>
      </div>
    </div>
  </section>

  <section class="space-y-4" aria-labelledby="satellite-live-heading">
    <div class="card-garden border-l-4 border-l-gold-400 p-5">
      <div class="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Live Observation</p>
          <h2 id="satellite-live-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
            Endpoint heartbeat is not wired yet
          </h2>
          <p class="mt-2 max-w-3xl text-sm text-shadow-600">
            {data?.liveObservationDetail ?? 'Live endpoint heartbeat and last-seen telemetry are not available yet.'}
          </p>
        </div>
        <span class="rounded-full bg-gold-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-gold-700">
          {data?.liveObservationStatus ? labelize(data.liveObservationStatus) : 'Not Implemented'}
        </span>
      </div>
    </div>
  </section>

  <section class="space-y-5" aria-labelledby="satellite-endpoints-heading">
    <div class="flex items-baseline gap-3">
      <div>
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Endpoints</p>
        <h2 id="satellite-endpoints-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
          Capability-mapped ports
        </h2>
      </div>
      <span class="text-sm text-shadow-600">{endpoints.length} endpoints</span>
    </div>

    {#if loading}
      <div class="grid gap-4 lg:grid-cols-2">
        {#each Array(2) as _}
          <div class="card-garden animate-pulse p-5">
            <div class="h-4 w-32 rounded bg-bark-200"></div>
            <div class="mt-3 h-8 w-48 rounded bg-bark-100"></div>
            <div class="mt-4 h-3 w-full rounded bg-bark-100"></div>
            <div class="mt-2 h-3 w-3/4 rounded bg-bark-100"></div>
          </div>
        {/each}
      </div>
    {:else if endpoints.length === 0}
      <div class="card-garden p-5">
        <p class="text-sm text-shadow-500">No satellites are registered.</p>
      </div>
    {:else}
      <div class="grid gap-4 lg:grid-cols-2">
        {#each endpoints as item}
          <article class="card-garden overflow-hidden p-5">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">
                  {item.satellite.displayName} / {labelize(item.satellite.mobility)}
                </p>
                <h3 class="mt-1 text-xl font-serif font-semibold text-shadow-900">
                  {item.endpoint.displayName}
                </h3>
                <p class="mt-1 text-xs font-mono text-shadow-500">
                  {item.satellite.satelliteId}:{item.endpoint.endpointId}
                </p>
              </div>
              <span class="rounded-full bg-bark-100 px-3 py-1 text-xs font-semibold text-shadow-700">
                {labelize(item.endpoint.auth.mode)}
              </span>
            </div>

            <dl class="mt-5 grid gap-3 text-sm md:grid-cols-2">
              <div>
                <dt class="text-xs uppercase tracking-[0.14em] text-shadow-500">Claim Types</dt>
                <dd class="mt-1 font-medium text-shadow-800">{joinLabels(item.endpoint.claimTypes)}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase tracking-[0.14em] text-shadow-500">Prompt Channel</dt>
                <dd class="mt-1 font-medium text-shadow-800">{labelize(item.endpoint.promptChannelType)}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase tracking-[0.14em] text-shadow-500">Identity</dt>
                <dd class="mt-1 text-shadow-700">
                  {item.endpoint.defaultIdentity.authorName} / {labelize(item.endpoint.defaultIdentity.channelPrivacy)}
                </dd>
              </div>
              <div>
                <dt class="text-xs uppercase tracking-[0.14em] text-shadow-500">Location</dt>
                <dd class="mt-1 text-shadow-700">{item.satellite.staticLocationLabel ?? labelize(item.satellite.mobility)}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase tracking-[0.14em] text-shadow-500">Auth Bindings</dt>
                <dd class="mt-1 text-shadow-700">
                  {item.endpoint.auth.certBound ? 'Certificate-bound' : 'API key'} /
                  {item.endpoint.auth.allowedPrincipalCount} principals /
                  {joinLabels(item.endpoint.auth.certBindingTypes)}
                </dd>
              </div>
              <div>
                <dt class="text-xs uppercase tracking-[0.14em] text-shadow-500">Live State</dt>
                <dd class="mt-1 text-shadow-700">{labelize(item.endpoint.live.status)}</dd>
              </div>
            </dl>

            <div class="mt-5 space-y-3">
              <div>
                <p class="text-xs uppercase tracking-[0.14em] text-shadow-500">Capability Ceiling</p>
                <div class="mt-2 flex flex-wrap gap-2">
                  {#each item.endpoint.maxCapabilities as capability}
                    <span class="rounded-full bg-petal-50 px-2.5 py-1 text-xs font-semibold text-petal-700">
                      {labelize(capability)}
                    </span>
                  {/each}
                </div>
              </div>
              <div>
                <p class="text-xs uppercase tracking-[0.14em] text-shadow-500">Telemetry Scopes</p>
                <p class="mt-1 text-sm text-shadow-700">{joinLabels(item.endpoint.telemetryScopes)}</p>
              </div>
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </section>
</div>
