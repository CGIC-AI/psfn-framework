<script lang="ts">
  import { onMount } from 'svelte';
  import {
    accountingStateFromSearchParams,
    buildModelUsageQuery,
    createDefaultAccountingState,
    type AccountingQueryState,
  } from '$lib/accounting/query-state';
  import {
    labelDimension,
  } from '$lib/accounting/format';
  import {
    getAuthorizedFleetModelUsage,
    getFleetModelUsage,
    type FleetModelUsageData,
    type FleetModelUsageQuery,
  } from '$lib/api/endpoints/fleet-model-usage';
  import { serializeModelUsageQuery } from '$lib/api/endpoints/model-usage-query';
  import FleetCostResults from './FleetCostResults.svelte';
  import {
    FLEET_COST_RANGE_OPTIONS,
    normalizeFleetCostRange,
    selectFleetCostGardenPath,
  } from '$lib/fleet/fleet-costs';
  import {
    fetchFleetPortalProjection,
    type FleetPortalProjection,
  } from '$lib/fleet/portal';
  import { MODEL_USAGE_BUCKETS } from '../../../../../src/shared/telemetry/model-usage.js';

  interface Props {
    mode?: 'garden' | 'fleet';
    projection?: FleetPortalProjection;
  }

  let { mode = 'garden', projection }: Props = $props();
  let queryState = $state<AccountingQueryState>(createDefaultAccountingState());
  let appliedState = $state<AccountingQueryState>(createDefaultAccountingState());
  let data = $state<FleetModelUsageData | null>(null);
  let companionNames = $state<Record<string, string>>({});
  let companionNamesUnavailable = $state(false);
  let loading = $state(true);
  let refreshing = $state(false);
  let errorMessage = $state('');
  let loadGeneration = 0;
  let controller: AbortController | null = null;

  const authorizedGardenPath = $derived(
    projection ? selectFleetCostGardenPath(projection.companions) : null,
  );
  const projectedCompanionNames = $derived(
    projection
      ? Object.fromEntries(projection.companions.map(companion => [
          companion.companionId,
          companion.displayName,
        ]))
      : companionNames,
  );

  function cloneState(state: AccountingQueryState): AccountingQueryState {
    return {
      ...state,
      groupBy: [...state.groupBy],
      filters: { ...state.filters },
    };
  }

  function fleetQuery(state: AccountingQueryState): FleetModelUsageQuery {
    const query = buildModelUsageQuery(state);
    return {
      range: normalizeFleetCostRange(query.range ?? 'all'),
      timezone: query.timezone,
      bucket: query.bucket,
      ...(query.sinceMs !== undefined ? { sinceMs: query.sinceMs } : {}),
      ...(query.untilMs !== undefined ? { untilMs: query.untilMs } : {}),
    };
  }

  function updateUrl(state: AccountingQueryState): void {
    const params = new URLSearchParams({
      range: state.range,
      timezone: state.timezone,
      bucket: state.bucket,
    });
    if (state.range === 'custom') {
      params.set('since', state.customSinceDate);
      params.set('until', state.customUntilDate);
    }
    const url = new URL(window.location.href);
    url.search = serializeModelUsageQuery(params);
    window.history.replaceState(window.history.state, '', url);
  }

  function requireAuthorizedGardenPath(): string {
    if (!authorizedGardenPath) {
      throw new Error('No authorized companion Garden is available for fleet costs');
    }
    return authorizedGardenPath;
  }

  async function loadUsage(state: AccountingQueryState, replaceUrl: boolean): Promise<void> {
    const generation = ++loadGeneration;
    controller?.abort();
    const request = new AbortController();
    controller = request;
    errorMessage = '';
    refreshing = data !== null;
    if (data === null) loading = true;
    try {
      const query = fleetQuery(state);
      if (replaceUrl) updateUrl(state);
      const result = mode === 'garden'
        ? await getFleetModelUsage(query)
        : await getAuthorizedFleetModelUsage(
            requireAuthorizedGardenPath(),
            query,
            request.signal,
          );
      if (request.signal.aborted || generation !== loadGeneration) return;
      appliedState = cloneState(state);
      data = result;
    } catch (error) {
      if (request.signal.aborted || generation !== loadGeneration) return;
      errorMessage = error instanceof Error
        ? error.message
        : 'Fleet cost telemetry is temporarily unavailable.';
    } finally {
      if (controller === request) controller = null;
      if (generation === loadGeneration) {
        loading = false;
        refreshing = false;
      }
    }
  }

  async function loadCompanionNames(): Promise<void> {
    companionNamesUnavailable = false;
    try {
      const projection = await fetchFleetPortalProjection();
      companionNames = Object.fromEntries(projection.companions.map(companion => [
        companion.companionId,
        companion.displayName,
      ]));
    } catch {
      companionNamesUnavailable = true;
    }
  }

  function patchState(change: Partial<AccountingQueryState>): void {
    queryState = { ...queryState, ...change };
  }

  function applyView(): void {
    void loadUsage(cloneState(queryState), true);
  }

  onMount(() => {
    const initialState = accountingStateFromSearchParams(
      new URLSearchParams(window.location.search),
    );
    queryState = {
      ...initialState,
      range: normalizeFleetCostRange(initialState.range),
    };
    appliedState = cloneState(queryState);
    void loadUsage(cloneState(queryState), false);
    if (mode === 'garden') void loadCompanionNames();
    return () => {
      loadGeneration += 1;
      controller?.abort();
      controller = null;
    };
  });
</script>

<svelte:head>
  <title>{mode === 'fleet' ? 'Fleet Usage · Garden' : 'Fleet Costs · Garden'}</title>
</svelte:head>

<div id={mode === 'fleet' ? 'fleet-costs' : undefined} class="space-y-6 {mode === 'fleet' ? 'pt-10' : 'p-4 sm:p-6 lg:p-8'}">
  <header class="flex flex-wrap items-end justify-between gap-4">
    <div>
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-gold-700">Fleet accounting</p>
      {#if mode === 'fleet'}
        <h2 class="mt-1 font-serif text-3xl font-semibold text-shadow-900">Fleet costs</h2>
      {:else}
        <h1 class="mt-1 font-serif text-3xl font-semibold text-shadow-900">Fleet Costs</h1>
      {/if}
      <p class="mt-2 max-w-3xl text-sm text-shadow-600">
        Aggregated model usage across every registered companion. Private usage contributes to fleet
        headline totals only; companion rows contain operator-visible usage.
      </p>
    </div>
    {#if data}
      <p class="text-sm text-shadow-500">
        {data.coverage.available} of {data.perCompanion.length} companions available
      </p>
    {/if}
  </header>
  {#if companionNamesUnavailable}
    <p class="rounded-lg border border-gold-300 bg-gold-50 px-4 py-3 text-sm text-shadow-700" role="status">
      Companion names are unavailable; showing stable companion IDs.
    </p>
  {/if}

  <form
    class="card-garden overflow-hidden"
    aria-labelledby="fleet-range-heading"
    onsubmit={(event) => { event.preventDefault(); applyView(); }}
  >
    <div class="border-b border-bark-300 px-5 py-4">
      <h2 id="fleet-range-heading" class="font-serif text-lg font-semibold text-shadow-900">Analysis range</h2>
      <p class="mt-1 text-sm text-shadow-600">All companions use the same resolved calendar window and bucket boundaries.</p>
    </div>
    <div class="space-y-4 p-5">
      <div class="flex flex-wrap gap-2" aria-label="Fleet cost range">
        {#each FLEET_COST_RANGE_OPTIONS as option (option.value)}
          <button
            type="button"
            aria-pressed={queryState.range === option.value}
            onclick={() => patchState({ range: option.value })}
            class="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors {queryState.range === option.value ? 'bg-shadow-900 text-bark-50' : 'border border-bark-300 text-shadow-700 hover:bg-bark-100'}"
          >
            {option.label}
          </button>
        {/each}
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <label class="text-sm text-shadow-700">
          <span class="mb-1 block text-xs font-semibold uppercase tracking-[0.14em] text-shadow-500">Timezone</span>
          <input
            value={queryState.timezone}
            oninput={(event) => patchState({ timezone: event.currentTarget.value })}
            autocomplete="off"
            class="w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 focus:border-gold-400 focus:outline-none"
          />
        </label>
        <label class="text-sm text-shadow-700">
          <span class="mb-1 block text-xs font-semibold uppercase tracking-[0.14em] text-shadow-500">Bucket</span>
          <select
            value={queryState.bucket}
            onchange={(event) => patchState({ bucket: event.currentTarget.value as AccountingQueryState['bucket'] })}
            class="w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 focus:border-gold-400 focus:outline-none"
          >
            {#each MODEL_USAGE_BUCKETS as bucket}
              <option value={bucket}>{labelDimension(bucket)}</option>
            {/each}
          </select>
        </label>
      </div>

      {#if queryState.range === 'custom'}
        <div class="grid gap-4 rounded-xl border border-gold-300 bg-gold-50 p-4 sm:grid-cols-2">
          <label class="text-sm text-shadow-700">
            <span class="mb-1 block font-medium">Start date</span>
            <input
              type="date"
              value={queryState.customSinceDate}
              oninput={(event) => patchState({ customSinceDate: event.currentTarget.value })}
              class="w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 focus:border-gold-400 focus:outline-none"
            />
          </label>
          <label class="text-sm text-shadow-700">
            <span class="mb-1 block font-medium">Through date</span>
            <input
              type="date"
              value={queryState.customUntilDate}
              oninput={(event) => patchState({ customUntilDate: event.currentTarget.value })}
              class="w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 focus:border-gold-400 focus:outline-none"
            />
          </label>
        </div>
      {/if}

      <button
        type="submit"
        disabled={loading || refreshing}
        class="rounded-lg bg-gold-600 px-4 py-2 text-sm font-semibold text-white hover:bg-gold-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {refreshing ? 'Refreshing…' : 'Apply range'}
      </button>
    </div>
  </form>

  <FleetCostResults
    {data}
    {loading}
    {errorMessage}
    {appliedState}
    companionNames={projectedCompanionNames}
    retry={() => void loadUsage(cloneState(appliedState), false)}
  />
</div>
