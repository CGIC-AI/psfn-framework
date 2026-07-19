<script lang="ts">
  import type { ModelUsageTimeBucket } from '../../../../../src/shared/telemetry/model-usage.js';
  import { formatInteger } from '$lib/accounting/format';
  import StackedBars from './charts/StackedBars.svelte';
  import { seriesColor } from './charts/chart-colors';
  import { buildTokenCompositionBuckets } from './charts/usage-series';

  interface Props {
    buckets: ModelUsageTimeBucket[];
    timezone: string;
  }

  const tokenSeries = [
    { key: 'input', label: 'Input', colorClass: seriesColor(0) },
    { key: 'cacheRead', label: 'Cache read', colorClass: seriesColor(1) },
    { key: 'cacheWrite', label: 'Cache write', colorClass: seriesColor(2) },
    { key: 'output', label: 'Output', colorClass: seriesColor(3) },
  ];

  let { buckets, timezone }: Props = $props();
  const chartBuckets = $derived(buildTokenCompositionBuckets(buckets));
</script>

<section class="card-garden overflow-hidden" aria-labelledby="token-composition-heading">
  <div class="border-b border-bark-300 px-5 py-4">
    <h3 id="token-composition-heading" class="font-serif text-lg font-semibold text-shadow-900">Token composition</h3>
    <p class="mt-1 text-sm text-shadow-600">Input, cache-read, cache-write, and output tokens per {timezone} calendar bucket. Cache reads highlight reused context.</p>
  </div>

  {#if buckets.length === 0}
    <p class="px-5 py-8 text-center text-sm text-shadow-600">No persisted usage falls in this time range.</p>
  {:else}
    <div class="px-5 py-5">
      <StackedBars
        buckets={chartBuckets}
        series={tokenSeries}
        {timezone}
        valueFormatter={formatInteger}
      />
    </div>
  {/if}
</section>
