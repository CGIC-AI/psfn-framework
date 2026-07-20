<script lang="ts">
  import type { AccountingQueryState } from '$lib/accounting/query-state';
  import {
    EMPTY_VALUE,
    formatInteger,
    formatPercent,
    formatUsd,
    shortId,
  } from '$lib/accounting/format';
  import type {
    FleetModelUsageCompanion,
    FleetModelUsageData,
  } from '$lib/api/endpoints/fleet-model-usage';
  import UsageMetricCards from '$lib/components/accounting/UsageMetricCards.svelte';
  import TokenCompositionChart from '$lib/components/accounting/TokenCompositionChart.svelte';
  import {
    buildFleetCompanionCostPath,
    fleetSpendShare,
    sortFleetCompanions,
    type FleetCostSortDirection,
    type FleetCostSortKey,
  } from '$lib/fleet/fleet-costs';

  interface Props {
    data: FleetModelUsageData | null;
    loading: boolean;
    errorMessage: string;
    appliedState: AccountingQueryState;
    companionNames: Record<string, string>;
    retry: () => void;
  }

  let {
    data,
    loading,
    errorMessage,
    appliedState,
    companionNames,
    retry,
  }: Props = $props();
  let sortKey = $state<FleetCostSortKey>('effectiveCostUsd');
  let sortDirection = $state<FleetCostSortDirection>('desc');
  const sortedRows = $derived(
    data ? sortFleetCompanions(data.perCompanion, sortKey, sortDirection) : [],
  );
  const fleetSpend = $derived(data?.totals?.effectiveCost.totalUsd ?? null);

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

  function spendShare(
    row: Extract<FleetModelUsageCompanion, { status: 'available' }>,
  ): number | null {
    return fleetSpendShare(row, fleetSpend);
  }

  function companionCostPath(companionId: string): string {
    if (!data) throw new Error('Fleet cost links require loaded deployment scope');
    return buildFleetCompanionCostPath(companionId, appliedState, data.deployment);
  }
</script>

{#if errorMessage}
  <section class="card-garden border-l-4 border-l-wilt-400 p-5" role="alert">
    <h2 class="font-serif text-lg font-semibold text-shadow-900">Fleet costs unavailable</h2>
    <p class="mt-1 text-sm text-wilt-700">{errorMessage}</p>
    <button
      type="button"
      class="mt-4 rounded-lg border border-bark-300 px-3 py-1.5 text-sm font-medium text-shadow-700 hover:bg-bark-100"
      onclick={retry}
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
