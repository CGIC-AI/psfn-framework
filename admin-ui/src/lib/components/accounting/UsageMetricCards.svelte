<script lang="ts">
  import type {
    ModelUsagePeriodComparison,
    ModelUsageTimeBucket,
    ModelUsageTotals,
  } from '../../../../../src/shared/telemetry/model-usage.js';
  import {
    blendedCostPerMillionTokens,
    cacheHitRatePercent,
  } from '$lib/accounting/derived-metrics';
  import {
    EMPTY_VALUE,
    formatDurationMs,
    formatInteger,
    formatPercent,
    formatUsd,
  } from '$lib/accounting/format';
  import Sparkline from './charts/Sparkline.svelte';
  import TrendDelta from './charts/TrendDelta.svelte';

  interface Props {
    totals: ModelUsageTotals;
    timeSeries: ModelUsageTimeBucket[];
    previousPeriod?: ModelUsagePeriodComparison;
  }

  let { totals, timeSeries, previousPeriod }: Props = $props();

  const cacheHitRate = $derived(cacheHitRatePercent(totals));
  const blendedCost = $derived(blendedCostPerMillionTokens(totals));
  const previousCacheHitRate = $derived(
    previousPeriod ? cacheHitRatePercent(previousPeriod.totals) : null,
  );
  const previousBlendedCost = $derived(
    previousPeriod ? blendedCostPerMillionTokens(previousPeriod.totals) : null,
  );

  const spendTrend = $derived(timeSeries.map(bucket => bucket.effectiveCost.totalUsd));
  const requestTrend = $derived(timeSeries.map(bucket => bucket.calls));
  const tokenTrend = $derived(timeSeries.map(bucket => bucket.totalTokens));
  const cacheHitTrend = $derived(
    timeSeries.map(bucket => cacheHitRatePercent(bucket) ?? 0),
  );
  const blendedCostTrend = $derived(
    timeSeries.map(bucket => blendedCostPerMillionTokens(bucket) ?? 0),
  );
  const latencyTrend = $derived(
    timeSeries.map(bucket => bucket.averageDurationMs ?? 0),
  );
</script>

<section class="space-y-3" aria-labelledby="usage-totals-heading">
  <div>
    <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Canonical persisted usage</p>
    <h3 id="usage-totals-heading" class="mt-1 font-serif text-lg font-semibold text-shadow-900">Usage at a glance</h3>
  </div>

  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
    <article class="card-garden flex min-h-44 flex-col overflow-hidden p-4" aria-labelledby="effective-spend-heading">
      <p id="effective-spend-heading" class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Effective spend</p>
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <p class="font-serif text-2xl font-bold tabular-nums text-gold-700">{formatUsd(totals.effectiveCost.totalUsd)}</p>
        {#if previousPeriod}
          <TrendDelta
            current={totals.effectiveCost.totalUsd}
            previous={previousPeriod.totals.effectiveCost.totalUsd}
            invertPolarity
          />
        {/if}
      </div>
      <p class="mt-1 text-xs text-shadow-500">Provider cost where known, estimate otherwise</p>
      <div class="mt-auto pt-3 text-gold-600">
        <Sparkline values={spendTrend} width={180} height={40} ariaLabel="Effective spend current-period trend" />
      </div>
    </article>

    <article class="card-garden flex min-h-44 flex-col overflow-hidden p-4" aria-labelledby="requests-heading">
      <p id="requests-heading" class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Requests</p>
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <p class="font-serif text-2xl font-bold tabular-nums text-petal-500">{formatInteger(totals.calls)}</p>
        {#if previousPeriod}
          <TrendDelta current={totals.calls} previous={previousPeriod.totals.calls} />
        {/if}
      </div>
      <p class="mt-1 text-xs text-shadow-500">
        {formatInteger(totals.successfulCalls)} succeeded · {formatInteger(totals.failedCalls)} failed
      </p>
      <div class="mt-auto pt-3 text-petal-500">
        <Sparkline values={requestTrend} width={180} height={40} ariaLabel="Request volume current-period trend" />
      </div>
    </article>

    <article class="card-garden flex min-h-44 flex-col overflow-hidden p-4" aria-labelledby="token-volume-heading">
      <p id="token-volume-heading" class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Token volume</p>
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <p class="font-serif text-2xl font-bold tabular-nums text-petal-500">{formatInteger(totals.totalTokens)}</p>
        {#if previousPeriod}
          <TrendDelta current={totals.totalTokens} previous={previousPeriod.totals.totalTokens} />
        {/if}
      </div>
      <p class="mt-1 text-xs text-shadow-500">
        {formatInteger(totals.inputTokens)} input · {formatInteger(totals.outputTokens)} output
      </p>
      <div class="mt-auto pt-3 text-petal-500">
        <Sparkline values={tokenTrend} width={180} height={40} ariaLabel="Token volume current-period trend" />
      </div>
    </article>

    <article class="card-garden flex min-h-44 flex-col overflow-hidden p-4" aria-labelledby="cache-hit-heading">
      <p id="cache-hit-heading" class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Cache hit rate</p>
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <p class="font-serif text-2xl font-bold tabular-nums text-moss-700">
          {cacheHitRate === null ? EMPTY_VALUE : formatPercent(cacheHitRate)}
        </p>
        {#if previousPeriod}
          <TrendDelta
            current={cacheHitRate ?? Number.NaN}
            previous={previousCacheHitRate}
          />
        {/if}
      </div>
      <p class="mt-1 text-xs text-shadow-500">
        {formatInteger(totals.cacheReadTokens)} cache read · {formatInteger(totals.cacheWriteTokens)} cache write
      </p>
      <div class="mt-auto pt-3 text-moss-600">
        <Sparkline values={cacheHitTrend} width={180} height={40} ariaLabel="Cache hit rate current-period trend" />
      </div>
    </article>

    <article class="card-garden flex min-h-44 flex-col overflow-hidden p-4" aria-labelledby="blended-cost-heading">
      <p id="blended-cost-heading" class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Blended $/1M</p>
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <p class="font-serif text-2xl font-bold tabular-nums text-gold-700">
          {blendedCost === null ? EMPTY_VALUE : formatUsd(blendedCost)}
        </p>
        {#if previousPeriod}
          <TrendDelta
            current={blendedCost ?? Number.NaN}
            previous={previousBlendedCost}
            invertPolarity
          />
        {/if}
      </div>
      <p class="mt-1 text-xs text-shadow-500">
        {formatUsd(totals.providerCost.totalUsd)} provider · {formatUsd(totals.estimatedCost.totalUsd)} estimated
      </p>
      <div class="mt-auto pt-3 text-gold-600">
        <Sparkline values={blendedCostTrend} width={180} height={40} ariaLabel="Blended cost current-period trend" />
      </div>
    </article>

    <article class="card-garden flex min-h-44 flex-col overflow-hidden p-4" aria-labelledby="latency-heading">
      <p id="latency-heading" class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Latency</p>
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <p class="font-serif text-2xl font-bold tabular-nums text-shadow-900">{formatDurationMs(totals.averageDurationMs)}</p>
        {#if previousPeriod}
          <TrendDelta
            current={totals.averageDurationMs ?? Number.NaN}
            previous={previousPeriod.totals.averageDurationMs}
            invertPolarity
          />
        {/if}
      </div>
      <p class="mt-1 text-xs text-shadow-500">{formatDurationMs(totals.averageTtftMs)} avg TTFT · avg duration shown</p>
      <div class="mt-auto pt-3 text-shadow-600">
        <Sparkline values={latencyTrend} width={180} height={40} ariaLabel="Average duration current-period trend" />
      </div>
    </article>
  </div>
</section>
