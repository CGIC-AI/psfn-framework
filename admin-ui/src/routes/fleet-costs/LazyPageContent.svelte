<script lang="ts">
  import { onMount } from 'svelte';
  import {
    accountingStateFromSearchParams,
    buildModelUsageQuery,
    createDefaultAccountingState,
    type AccountingQueryState,
  } from '$lib/accounting/query-state';
  import {
    EMPTY_VALUE,
    formatInteger,
    formatPercent,
    formatUsd,
    labelDimension,
    shortId,
  } from '$lib/accounting/format';
  import {
    getFleetModelUsage,
    type FleetModelUsageData,
    type FleetModelUsageCompanion,
    type FleetModelUsageQuery,
  } from '$lib/api/endpoints/fleet-model-usage';
  import UsageMetricCards from '$lib/components/accounting/UsageMetricCards.svelte';
  import TokenCompositionChart from '$lib/components/accounting/TokenCompositionChart.svelte';
  import {
    buildFleetCompanionCostPath,
    FLEET_COST_RANGE_OPTIONS,
    normalizeFleetCostRange,
    sortFleetCompanions,
    type FleetCostSortDirection,
    type FleetCostSortKey,
  } from '$lib/fleet/fleet-costs';
  import {
    fetchFleetPortalProjection,
  } from '$lib/fleet/portal';
  import { MODEL_USAGE_BUCKETS } from '../../../../src/shared/telemetry/model-usage.js';

  let queryState = $state<AccountingQueryState>(createDefaultAccountingState());
  let appliedState = $state<AccountingQueryState>(createDefaultAccountingState());
  let data = $state<FleetModelUsageData | null>(null);
  let companionNames = $state<Record<string, string>>({});
  let loading = $state(true);
  let refreshing = $state(false);
  let errorMessage = $state('');
  let sortKey = $state<FleetCostSortKey>('effectiveCostUsd');
  let sortDirection = $state<FleetCostSortDirection>('desc');
  let loadGeneration = 0;

  const sortedRows = $derived(
    data ? sortFleetCompanions(data.perCompanion, sortKey, sortDirection) : [],
  );
  const fleetSpend = $derived(data?.totals?.effectiveCost.totalUsd ?? null);

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
    url.search = params.toString();
    window.history.replaceState(window.history.state, '', url);
  }

  async function loadUsage(state: AccountingQueryState, replaceUrl: boolean): Promise<void> {
    const generation = ++loadGeneration;
    errorMessage = '';
    refreshing = data !== null;
    if (data === null) loading = true;
    try {
      const query = fleetQuery(state);
      if (replaceUrl) updateUrl(state);
      const result = await getFleetModelUsage(query);
      if (generation !== loadGeneration) return;
      appliedState = cloneState(state);
      data = result;
    } catch (error) {
      if (generation !== loadGeneration) return;
      errorMessage = error instanceof Error
        ? error.message
        : 'Fleet cost telemetry is temporarily unavailable.';
    } finally {
      if (generation === loadGeneration) {
        loading = false;
        refreshing = false;
      }
    }
  }

  async function loadCompanionNames(): Promise<void> {
    try {
      const projection = await fetchFleetPortalProjection();
      companionNames = Object.fromEntries(projection.companions.map(companion => [
        companion.companionId,
        companion.displayName,
      ]));
    } catch {
      // Companion IDs remain safe, stable labels when the bounded portal projection is unavailable.
    }
  }

  function patchState(change: Partial<AccountingQueryState>): void {
    queryState = { ...queryState, ...change };
  }

  function applyView(): void {
    void loadUsage(cloneState(queryState), true);
  }

  function toggleSort(nextKey: FleetCostSortKey): void {
    if (sortKey === nextKey) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      return;
    }
    sortKey = nextKey;
    sortDirection = 'desc';
  }

  function sortIndicator(key: FleetCostSortKey): string {
    if (sortKey !== key) return '';
    return sortDirection === 'asc' ? ' ↑' : ' ↓';
  }

  function ariaSort(key: FleetCostSortKey): 'ascending' | 'descending' | 'none' {
    if (sortKey !== key) return 'none';
    return sortDirection === 'asc' ? 'ascending' : 'descending';
  }

  function companionLabel(row: FleetModelUsageCompanion): string {
    return companionNames[row.companionId] ?? shortId(row.companionId);
  }

  function spendShare(row: Extract<FleetModelUsageCompanion, { status: 'available' }>): number | null {
    if (fleetSpend === null || fleetSpend <= 0) return null;
    return (row.totals.effectiveCost.totalUsd / fleetSpend) * 100;
  }

  function companionCostPath(companionId: string): string {
    if (!data) throw new Error('Fleet cost links require loaded deployment scope');
    return buildFleetCompanionCostPath(companionId, appliedState, data.deployment);
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
    void Promise.all([
      loadUsage(cloneState(queryState), false),
      loadCompanionNames(),
    ]);
    return () => {
      loadGeneration += 1;
    };
  });
</script>

<svelte:head>
  <title>Fleet Costs · Garden</title>
</svelte:head>

<div class="space-y-6 p-4 sm:p-6 lg:p-8">
  <header class="flex flex-wrap items-end justify-between gap-4">
    <div>
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-gold-700">Fleet accounting</p>
      <h1 class="mt-1 font-serif text-3xl font-semibold text-shadow-900">Fleet Costs</h1>
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

  {#if errorMessage}
    <section class="card-garden border-l-4 border-l-wilt-400 p-5" role="alert">
      <h2 class="font-serif text-lg font-semibold text-shadow-900">Fleet costs unavailable</h2>
      <p class="mt-1 text-sm text-wilt-700">{errorMessage}</p>
      <button
        type="button"
        class="mt-4 rounded-lg border border-bark-300 px-3 py-1.5 text-sm font-medium text-shadow-700 hover:bg-bark-100"
        onclick={() => void loadUsage(cloneState(appliedState), false)}
      >Retry</button>
    </section>
  {:else if loading}
    <section class="card-garden p-8" aria-busy="true" aria-live="polite">
      <p class="text-sm text-shadow-600">Loading fleet model usage…</p>
    </section>
  {:else if data}
    {#if !data.coverage.complete}
      <section class="rounded-xl border border-gold-300 bg-gold-50 p-4" role="status">
        <p class="text-sm font-medium text-shadow-800">Partial fleet totals</p>
        <p class="mt-1 text-sm text-shadow-600">
          {data.coverage.unavailable} companion{data.coverage.unavailable === 1 ? ' is' : 's are'} unavailable.
          Their usage is excluded from the headline totals and they remain listed below.
        </p>
      </section>
    {/if}

    {#if data.totals}
      <UsageMetricCards totals={data.totals} timeSeries={[...data.timeSeries]} />
      <TokenCompositionChart buckets={[...data.timeSeries]} timezone={data.resolvedRange.timezone} />
    {:else}
      <section class="card-garden p-8">
        <h2 class="font-serif text-lg font-semibold text-shadow-900">No fleet totals available</h2>
        <p class="mt-1 text-sm text-shadow-600">Every registered companion is currently unavailable.</p>
      </section>
    {/if}

    <section class="card-garden overflow-hidden" aria-labelledby="fleet-leaderboard-heading">
      <div class="border-b border-bark-300 px-5 py-4">
        <h2 id="fleet-leaderboard-heading" class="font-serif text-lg font-semibold text-shadow-900">Companion leaderboard</h2>
        <p class="mt-1 text-sm text-shadow-600">
          Rows use operator-visible usage. Fleet spend share uses the privacy-preserving headline total as its denominator.
        </p>
      </div>
      <div class="overflow-x-auto">
        <table class="min-w-full divide-y divide-bark-300 text-sm">
          <thead class="bg-bark-100 text-left text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500">
            <tr>
              <th scope="col" class="px-4 py-3">Companion</th>
              <th scope="col" class="px-4 py-3 text-right" aria-sort={ariaSort('calls')}>
                <button type="button" onclick={() => toggleSort('calls')}>Calls{sortIndicator('calls')}</button>
              </th>
              <th scope="col" class="px-4 py-3 text-right" aria-sort={ariaSort('inputTokens')}>
                <button type="button" onclick={() => toggleSort('inputTokens')}>Input{sortIndicator('inputTokens')}</button>
              </th>
              <th scope="col" class="px-4 py-3 text-right" aria-sort={ariaSort('outputTokens')}>
                <button type="button" onclick={() => toggleSort('outputTokens')}>Output{sortIndicator('outputTokens')}</button>
              </th>
              <th scope="col" class="px-4 py-3 text-right" aria-sort={ariaSort('cacheReadTokens')}>
                <button type="button" onclick={() => toggleSort('cacheReadTokens')}>Cache read{sortIndicator('cacheReadTokens')}</button>
              </th>
              <th scope="col" class="px-4 py-3 text-right" aria-sort={ariaSort('effectiveCostUsd')}>
                <button type="button" onclick={() => toggleSort('effectiveCostUsd')}>Effective cost{sortIndicator('effectiveCostUsd')}</button>
              </th>
              <th scope="col" class="px-4 py-3 text-right" aria-sort={ariaSort('spendShare')}>
                <button type="button" onclick={() => toggleSort('spendShare')}>Fleet spend{sortIndicator('spendShare')}</button>
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-bark-200 bg-bark-50">
            {#each sortedRows as row (row.companionId)}
              <tr class:opacity-65={row.status === 'unavailable'}>
                <th scope="row" class="px-4 py-3 text-left font-medium text-shadow-900">
                  <a href={companionCostPath(row.companionId)} class="text-gold-700 hover:text-gold-800 hover:underline">
                    {companionLabel(row)}
                  </a>
                  <span class="mt-0.5 block font-mono text-[0.68rem] font-normal text-shadow-500">{shortId(row.companionId)}</span>
                  {#if row.status === 'available' && row.topModel}
                    <span class="mt-1 block max-w-64 truncate text-xs font-normal text-shadow-500" title={row.topModel.key}>
                      Top model: {row.topModel.key}
                    </span>
                  {:else if row.status === 'unavailable'}
                    <span class="mt-1 block text-xs font-normal text-wilt-600">Unavailable</span>
                  {/if}
                </th>
                {#if row.status === 'available'}
                  <td class="px-4 py-3 text-right tabular-nums text-shadow-700">{formatInteger(row.totals.calls)}</td>
                  <td class="px-4 py-3 text-right tabular-nums text-shadow-700">{formatInteger(row.totals.inputTokens)}</td>
                  <td class="px-4 py-3 text-right tabular-nums text-shadow-700">{formatInteger(row.totals.outputTokens)}</td>
                  <td class="px-4 py-3 text-right tabular-nums text-shadow-700">{formatInteger(row.totals.cacheReadTokens)}</td>
                  <td class="px-4 py-3 text-right font-medium tabular-nums text-gold-700">{formatUsd(row.totals.effectiveCost.totalUsd)}</td>
                  <td class="px-4 py-3 text-right tabular-nums text-shadow-700">
                    {spendShare(row) === null ? EMPTY_VALUE : formatPercent(spendShare(row) ?? undefined)}
                  </td>
                {:else}
                  <td class="px-4 py-3 text-right text-shadow-400">{EMPTY_VALUE}</td>
                  <td class="px-4 py-3 text-right text-shadow-400">{EMPTY_VALUE}</td>
                  <td class="px-4 py-3 text-right text-shadow-400">{EMPTY_VALUE}</td>
                  <td class="px-4 py-3 text-right text-shadow-400">{EMPTY_VALUE}</td>
                  <td class="px-4 py-3 text-right text-shadow-400">{EMPTY_VALUE}</td>
                  <td class="px-4 py-3 text-right text-shadow-400">{EMPTY_VALUE}</td>
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}
</div>
