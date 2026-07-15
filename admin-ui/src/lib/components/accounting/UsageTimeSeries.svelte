<script lang="ts">
  import type { ModelUsageTimeBucket } from '../../../../../src/shared/telemetry/model-usage.js';
  import { formatInteger, formatTimestamp, formatUsd } from '$lib/accounting/format';

  interface Props {
    buckets: ModelUsageTimeBucket[];
    timezone: string;
  }

  type ChartMetric = 'totalTokens' | 'effectiveCost' | 'calls';

  let { buckets, timezone }: Props = $props();
  let metric = $state<ChartMetric>('effectiveCost');
  const values = $derived(buckets.map(bucket => metric === 'effectiveCost'
    ? bucket.effectiveCost.totalUsd
    : bucket[metric]));
  const maximum = $derived(Math.max(0, ...values));

  function metricLabel(value: number): string {
    if (metric === 'effectiveCost') return formatUsd(value);
    return formatInteger(value);
  }
</script>

<section class="card-garden overflow-hidden" aria-labelledby="usage-over-time-heading">
  <div class="flex flex-wrap items-start justify-between gap-3 border-b border-bark-300 px-5 py-4">
    <div>
      <h3 id="usage-over-time-heading" class="font-serif text-lg font-semibold text-shadow-900">Usage over time</h3>
      <p class="mt-1 text-sm text-shadow-600">Calendar buckets use {timezone}. The exact values remain available in the table.</p>
    </div>
    <label class="text-sm text-shadow-700">
      <span class="sr-only">Chart metric</span>
      <select
        value={metric}
        onchange={(event) => metric = (event.currentTarget as HTMLSelectElement).value as ChartMetric}
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
    <div class="overflow-x-auto px-5 py-5">
      <div
        class="flex h-52 min-w-max items-end gap-2 border-b border-bark-300"
        role="img"
        aria-label={`${metric} by time bucket in ${timezone}`}
      >
        {#each buckets as bucket, index (bucket.startMs)}
          {@const height = maximum === 0 ? 2 : Math.max(2, (values[index] ?? 0) / maximum * 100)}
          <div class="flex h-full w-10 flex-col justify-end gap-1" title={`${formatTimestamp(bucket.startMs, timezone)}: ${metricLabel(values[index] ?? 0)}`}>
            <span class="sr-only">{formatTimestamp(bucket.startMs, timezone)}: {metricLabel(values[index] ?? 0)}</span>
            <div class="w-full rounded-t bg-gold-400 transition-[height]" style={`height: ${height}%`}></div>
            <span class="block truncate text-center text-[0.65rem] text-shadow-500" aria-hidden="true">
              {new Date(bucket.startMs).toLocaleDateString('en-US', { timeZone: timezone, month: 'short', day: 'numeric' })}
            </span>
          </div>
        {/each}
      </div>
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
