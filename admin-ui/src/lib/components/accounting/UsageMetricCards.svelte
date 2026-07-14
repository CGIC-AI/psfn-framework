<script lang="ts">
  import type { ModelUsageTotals } from '../../../../../src/shared/telemetry/model-usage.js';
  import { formatDurationMs, formatInteger, formatUsd } from '$lib/accounting/format';

  interface Props {
    totals: ModelUsageTotals;
  }

  let { totals }: Props = $props();

  const tokenComponents = $derived([
    {
      label: 'Input',
      tokens: totals.inputTokens,
      cost: totals.effectiveCost.inputUsd,
      knownCalls: totals.effectiveCost.inputKnownCalls,
    },
    {
      label: 'Cache read',
      tokens: totals.cacheReadTokens,
      cost: totals.effectiveCost.cacheReadUsd,
      knownCalls: totals.effectiveCost.cacheReadKnownCalls,
    },
    {
      label: 'Cache write',
      tokens: totals.cacheWriteTokens,
      cost: totals.effectiveCost.cacheWriteUsd,
      knownCalls: totals.effectiveCost.cacheWriteKnownCalls,
    },
    {
      label: 'Output',
      tokens: totals.outputTokens,
      cost: totals.effectiveCost.outputUsd,
      knownCalls: totals.effectiveCost.outputKnownCalls,
    },
  ]);
</script>

<section class="space-y-4" aria-labelledby="usage-totals-heading">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Canonical persisted usage</p>
      <h3 id="usage-totals-heading" class="mt-1 font-serif text-lg font-semibold text-shadow-900">Tokens and effective model cost</h3>
    </div>
    <p class="text-sm text-shadow-600">
      {formatInteger(totals.calls)} calls · {formatInteger(totals.successfulCalls)} succeeded · {formatInteger(totals.failedCalls)} failed
    </p>
  </div>

  <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    {#each tokenComponents as component (component.label)}
      <article class="card-garden p-4">
        <p class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">{component.label}</p>
        <p class="mt-2 font-serif text-2xl font-bold text-shadow-900">{formatInteger(component.tokens)}</p>
        <p class="mt-1 text-sm font-semibold text-gold-700">{formatUsd(component.cost)}</p>
        <p class="mt-1 text-xs text-shadow-500">effective cost known for {formatInteger(component.knownCalls)} calls</p>
      </article>
    {/each}
  </div>

  <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
    <article class="card-garden p-4">
      <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Total tokens</p>
      <p class="mt-2 font-serif text-2xl font-bold text-petal-500">{formatInteger(totals.totalTokens)}</p>
      <p class="mt-1 text-xs text-shadow-500">All four token components above</p>
    </article>
    <article class="card-garden p-4">
      <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Effective cost</p>
      <p class="mt-2 font-serif text-2xl font-bold text-gold-700">{formatUsd(totals.effectiveCost.totalUsd)}</p>
      <p class="mt-1 text-xs text-shadow-500">Provider where known, estimate otherwise</p>
    </article>
    <article class="card-garden p-4">
      <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Cost sources</p>
      <p class="mt-2 text-sm font-semibold text-shadow-900">{formatUsd(totals.providerCost.totalUsd)} provider</p>
      <p class="mt-1 text-sm text-shadow-600">{formatUsd(totals.estimatedCost.totalUsd)} estimated</p>
    </article>
    <article class="card-garden p-4">
      <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Latency</p>
      <p class="mt-2 text-sm font-semibold text-shadow-900">{formatDurationMs(totals.averageTtftMs)} avg TTFT</p>
      <p class="mt-1 text-sm text-shadow-600">{formatDurationMs(totals.averageDurationMs)} avg duration</p>
    </article>
  </div>
</section>
