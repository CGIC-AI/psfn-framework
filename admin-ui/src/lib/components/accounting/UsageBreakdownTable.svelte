<script lang="ts">
  import type {
    ModelUsageAttributionCoverage,
    ModelUsageGroup,
    ModelUsageGroupDimension,
    ModelUsageGroupSort,
    ModelUsageSortDirection,
  } from '../../../../../src/shared/telemetry/model-usage.js';
  import { formatDurationMs, formatInteger, formatPercent, formatUsd, labelDimension, shortId } from '$lib/accounting/format';

  interface Props {
    groups: ModelUsageGroup[];
    groupedBy: readonly ModelUsageGroupDimension[];
    coverage: ModelUsageAttributionCoverage;
    sortBy: ModelUsageGroupSort;
    sortDirection: ModelUsageSortDirection;
    onSort: (sort: ModelUsageGroupSort) => void;
    onDrilldown: (dimension: ModelUsageGroupDimension, value: string) => void;
  }

  let { groups, groupedBy, coverage, sortBy, sortDirection, onSort, onDrilldown }: Props = $props();

  function sortLabel(sort: ModelUsageGroupSort): string {
    return sortBy === sort ? (sortDirection === 'desc' ? 'sorted descending' : 'sorted ascending') : 'not sorted';
  }

  function dimensions(group: ModelUsageGroup): [ModelUsageGroupDimension, string][] {
    return Object.entries(group.dimensions)
      .filter((entry): entry is [ModelUsageGroupDimension, string] => Boolean(entry[1]));
  }
</script>

<section class="card-garden overflow-hidden" aria-labelledby="usage-breakdown-heading">
  <div class="border-b border-bark-300 px-5 py-4">
    <h3 id="usage-breakdown-heading" class="font-serif text-lg font-semibold text-shadow-900">Grouped breakdown</h3>
    <p class="mt-1 text-sm text-shadow-600">Select a dimension value to drill into it. Sorting is performed by the canonical analytics query.</p>
    <div class="mt-3 flex flex-wrap gap-2" aria-label="Attribution coverage for selected dimensions">
      {#each groupedBy as dimension (dimension)}
        {@const dimensionCoverage = coverage.byDimension[dimension]}
        <span class="rounded-full border border-bark-300 bg-bark-50 px-3 py-1 text-xs text-shadow-700">
          {labelDimension(dimension)} coverage {formatPercent(dimensionCoverage.coveragePercent)}
          <span class="text-shadow-500">({formatInteger(dimensionCoverage.knownCalls)} known / {formatInteger(dimensionCoverage.unknownCalls)} unknown)</span>
        </span>
      {/each}
    </div>
  </div>

  <div class="max-h-[32rem] overflow-auto">
    <table class="min-w-full divide-y divide-bark-200 text-left text-sm">
      <thead class="sticky top-0 bg-bark-50 text-xs uppercase tracking-[0.14em] text-shadow-500">
        <tr>
          <th class="px-5 py-3 font-semibold">Dimensions</th>
          <th class="px-3 py-3 text-right font-semibold">
            <button type="button" onclick={() => onSort('calls')} class="hover:text-shadow-900" aria-label={`Sort by calls; ${sortLabel('calls')}`}>Calls {sortBy === 'calls' ? (sortDirection === 'desc' ? '↓' : '↑') : ''}</button>
          </th>
          <th class="px-3 py-3 text-right font-semibold">
            <button type="button" onclick={() => onSort('totalTokens')} class="hover:text-shadow-900" aria-label={`Sort by tokens; ${sortLabel('totalTokens')}`}>Tokens {sortBy === 'totalTokens' ? (sortDirection === 'desc' ? '↓' : '↑') : ''}</button>
          </th>
          <th class="px-3 py-3 text-right font-semibold">
            <button type="button" onclick={() => onSort('effectiveCostUsd')} class="hover:text-shadow-900" aria-label={`Sort by effective cost; ${sortLabel('effectiveCostUsd')}`}>Cost {sortBy === 'effectiveCostUsd' ? (sortDirection === 'desc' ? '↓' : '↑') : ''}</button>
          </th>
          <th class="px-3 py-3 text-right font-semibold">
            <button type="button" onclick={() => onSort('averageDurationMs')} class="hover:text-shadow-900" aria-label={`Sort by duration; ${sortLabel('averageDurationMs')}`}>Duration {sortBy === 'averageDurationMs' ? (sortDirection === 'desc' ? '↓' : '↑') : ''}</button>
          </th>
          <th class="px-5 py-3 text-right font-semibold">
            <button type="button" onclick={() => onSort('averageTtftMs')} class="hover:text-shadow-900" aria-label={`Sort by time to first token; ${sortLabel('averageTtftMs')}`}>TTFT {sortBy === 'averageTtftMs' ? (sortDirection === 'desc' ? '↓' : '↑') : ''}</button>
          </th>
        </tr>
      </thead>
      <tbody class="divide-y divide-bark-200">
        {#each groups as group, index (`${index}-${JSON.stringify(group.dimensions)}`)}
          <tr>
            <td class="px-5 py-3">
              <div class="flex min-w-52 flex-wrap gap-1.5">
                {#if group.isOther}
                  <span class="rounded bg-bark-200 px-2 py-1 text-xs font-medium text-shadow-700">Other groups</span>
                {:else}
                  {#each dimensions(group) as [dimension, value] (`${dimension}:${value}`)}
                    <button
                      type="button"
                      onclick={() => onDrilldown(dimension, value)}
                      class="rounded border border-bark-300 bg-bark-50 px-2 py-1 text-left text-xs text-shadow-700 hover:border-gold-400 hover:bg-gold-50"
                      title={`Filter ${labelDimension(dimension)} to ${value}`}
                    >
                      <span class="text-shadow-500">{labelDimension(dimension)}</span> {shortId(value)}
                    </button>
                  {/each}
                {/if}
              </div>
            </td>
            <td class="px-3 py-3 text-right text-shadow-700">{formatInteger(group.metrics.calls)}</td>
            <td class="px-3 py-3 text-right text-shadow-700">{formatInteger(group.metrics.totalTokens)}</td>
            <td class="px-3 py-3 text-right font-semibold text-shadow-900">{formatUsd(group.metrics.effectiveCost.totalUsd)}</td>
            <td class="px-3 py-3 text-right text-shadow-600">{formatDurationMs(group.metrics.averageDurationMs)}</td>
            <td class="px-5 py-3 text-right text-shadow-600">{formatDurationMs(group.metrics.averageTtftMs)}</td>
          </tr>
        {:else}
          <tr><td colspan="6" class="px-5 py-8 text-center text-shadow-600">No groups match this view.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
