<script lang="ts">
  import { deriveCacheHitRateTrend } from '$lib/accounting/cache-hit-rate';
  import { formatInteger, formatPercent, formatTimestamp } from '$lib/accounting/format';
  import Sparkline from './charts/Sparkline.svelte';
  import { seriesColor } from './charts/chart-colors';
  import type {
    ModelUsageTimeBucket,
    ModelUsageTotals,
  } from '../../../../../src/shared/telemetry/model-usage.js';

  interface Props {
    buckets: ModelUsageTimeBucket[];
    totals: ModelUsageTotals;
    timezone: string;
  }

  let { buckets, totals, timezone }: Props = $props();

  const trend = $derived(deriveCacheHitRateTrend(buckets, totals));
  const chartLabel = $derived(
    `Cache hit rate by time bucket: ${trend.ratePercents.map(formatPercent).join(', ') || 'no buckets'}`,
  );
</script>

<section class="card-garden overflow-hidden" aria-labelledby="cache-hit-rate-heading">
  <div class="flex flex-wrap items-start justify-between gap-3 border-b border-bark-300 px-5 py-4">
    <div>
      <p class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Prompt caching</p>
      <h3 id="cache-hit-rate-heading" class="mt-1 font-serif text-lg font-semibold text-shadow-900">Cache hit rate</h3>
      <p class="mt-1 text-sm text-shadow-600">Cache reads ÷ (input + cache reads) in each {timezone} bucket.</p>
    </div>
    <div class="text-right">
      <p class="font-serif text-3xl font-bold text-moss-700">{formatPercent(trend.aggregateRatePercent)}</p>
      <p class="text-xs text-shadow-500">range aggregate</p>
    </div>
  </div>

  <div class="px-5 py-5">
    {#if buckets.length === 0}
      <p class="py-12 text-center text-sm text-shadow-600">No persisted usage falls in this time range.</p>
    {:else}
      <div class="flex min-h-44 items-center justify-center" style={`color: ${seriesColor(1)}`}>
        <Sparkline
          values={trend.ratePercents}
          width={640}
          height={160}
          padding={6}
          strokeClass="stroke-current"
          fillClass="fill-current"
          ariaLabel={chartLabel}
        />
      </div>
      <div class="mt-2 flex items-center justify-between gap-4 text-xs text-shadow-500">
        <span>{formatTimestamp(buckets[0]?.startMs, timezone)}</span>
        <span>{formatTimestamp(buckets.at(-1)?.startMs, timezone)}</span>
      </div>
    {/if}
  </div>

  <div class="grid grid-cols-2 gap-3 border-t border-bark-200 bg-bark-50/50 px-5 py-3 text-sm">
    <p><span class="font-semibold text-shadow-900">{formatInteger(totals.cacheReadTokens)}</span> <span class="text-shadow-500">cache-read tokens</span></p>
    <p class="text-right"><span class="font-semibold text-shadow-900">{formatInteger(totals.cacheWriteTokens)}</span> <span class="text-shadow-500">cache-write tokens</span></p>
  </div>
</section>
