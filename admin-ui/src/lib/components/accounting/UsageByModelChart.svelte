<script lang="ts">
  import type {
    ModelUsageDimensionTimeBucket,
    ModelUsageTimeBucket,
  } from '../../../../../src/shared/telemetry/model-usage.js';
  import { formatInteger, formatTimestamp, formatUsd } from '$lib/accounting/format';
  import StackedBars from './charts/StackedBars.svelte';
  import { seriesColor } from './charts/chart-colors';
  import { OTHER_SERIES_KEY } from './charts/chart-scale';
  import {
    buildUsageByModelChartData,
    type UsageChartMetric,
  } from './charts/usage-series';

  interface Props {
    buckets: ModelUsageTimeBucket[];
    modelSeries: ModelUsageDimensionTimeBucket[];
    timezone: string;
  }

  let { buckets, modelSeries, timezone }: Props = $props();
  let metric = $state<UsageChartMetric>('effectiveCost');
  const chartData = $derived(buildUsageByModelChartData(buckets, modelSeries, metric, 5));
  const chartSeries = $derived(chartData.seriesKeys.map((key, index) => ({
    key,
    label: key === OTHER_SERIES_KEY ? 'Other' : key,
    colorClass: seriesColor(index),
  })));

  function metricLabel(value: number): string {
    return metric === 'effectiveCost' ? formatUsd(value) : formatInteger(value);
  }
</script>

<section class="card-garden overflow-hidden" aria-labelledby="usage-by-model-heading">
  <div class="flex flex-wrap items-start justify-between gap-3 border-b border-bark-300 px-5 py-4">
    <div>
      <h3 id="usage-by-model-heading" class="font-serif text-lg font-semibold text-shadow-900">Usage by model</h3>
      <p class="mt-1 text-sm text-shadow-600">Calendar buckets use {timezone}. Model stacks show operator-visible detail; the table retains full-ledger aggregate totals.</p>
    </div>
    <label class="text-sm text-shadow-700">
      <span class="sr-only">Chart metric</span>
      <select
        value={metric}
        onchange={(event) => metric = (event.currentTarget as HTMLSelectElement).value as UsageChartMetric}
        class="rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm focus:border-gold-400 focus:outline-none"
      >
        <option value="effectiveCost">Effective cost</option>
        <option value="totalTokens">Total tokens</option>
        <option value="calls">Calls</option>
      </select>
    </label>
  </div>

  {#if buckets.length === 0}
    <p class="px-5 py-8 text-center text-sm text-shadow-600">No persisted usage falls in this time range.</p>
  {:else}
    <div class="px-5 py-5">
      {#if chartSeries.length > 0}
        <StackedBars
          buckets={chartData.buckets}
          series={chartSeries}
          {timezone}
          valueFormatter={metricLabel}
        />
      {:else}
        <p class="py-8 text-center text-sm text-shadow-600">No operator-visible model detail falls in this time range.</p>
      {/if}
    </div>

    <details class="border-t border-bark-200 px-5 py-3">
      <summary class="cursor-pointer text-sm font-medium text-shadow-700">Time-series data table</summary>
      <div class="mt-3 overflow-x-auto">
        <table class="min-w-full divide-y divide-bark-200 text-left text-sm">
          <thead class="text-xs uppercase tracking-[0.14em] text-shadow-500">
            <tr>
              <th class="px-3 py-2 font-semibold">Bucket</th>
              <th class="px-3 py-2 text-right font-semibold">Calls</th>
              <th class="px-3 py-2 text-right font-semibold">Tokens</th>
              <th class="px-3 py-2 text-right font-semibold">Effective cost</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-bark-200">
            {#each buckets as bucket (bucket.startMs)}
              <tr>
                <td class="whitespace-nowrap px-3 py-2 text-shadow-700">{formatTimestamp(bucket.startMs, timezone)}</td>
                <td class="px-3 py-2 text-right text-shadow-600">{formatInteger(bucket.calls)}</td>
                <td class="px-3 py-2 text-right text-shadow-600">{formatInteger(bucket.totalTokens)}</td>
                <td class="px-3 py-2 text-right font-medium text-shadow-800">{formatUsd(bucket.effectiveCost.totalUsd)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </details>
  {/if}
</section>
