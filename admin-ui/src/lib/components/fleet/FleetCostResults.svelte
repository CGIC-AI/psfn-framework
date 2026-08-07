<script lang="ts">
  import type { FleetModelUsageData } from '$lib/api/endpoints/fleet-model-usage';
  import UsageMetricCards from '$lib/components/accounting/UsageMetricCards.svelte';
  import TokenCompositionChart from '$lib/components/accounting/TokenCompositionChart.svelte';
  import {
    companionDisplayLabel,
    companionTechnicalLabel,
  } from '$lib/fleet/companion-display';
  interface Props {
    data: FleetModelUsageData | null;
    loading: boolean;
    errorMessage: string;
    companionNames: Record<string, string>;
    retry: () => void;
  }

  let {
    data,
    loading,
    errorMessage,
    companionNames,
    retry,
  }: Props = $props();
  const displayCompanions = $derived(Object.entries(companionNames).map(
    ([companionId, displayName]) => ({ companionId, displayName }),
  ));
  const unavailableCompanions = $derived(
    data?.perCompanion
      .filter(companion => companion.status === 'unavailable')
      ?? [],
  );
  const unavailableCompanionNames = $derived(
    unavailableCompanions.map(companion => (
      companionDisplayLabel(displayCompanions, companion.companionId)
    )),
  );
</script>

{#if errorMessage}
  <section class="card-garden border-l-4 border-l-wilt-400 p-5" role="alert">
    <h2 class="font-serif text-lg font-semibold text-shadow-900">Cluster costs unavailable</h2>
    <p class="mt-1 text-sm text-wilt-700">{errorMessage}</p>
    <button
      type="button"
      class="mt-4 rounded-lg border border-bark-300 px-3 py-1.5 text-sm font-medium text-shadow-700 hover:bg-bark-100"
      onclick={retry}
    >Retry</button>
  </section>
{:else if loading}
  <section class="card-garden p-8" aria-busy="true" aria-live="polite">
    <p class="text-sm text-shadow-600">Loading cluster model usage…</p>
  </section>
{:else if data}
  {#if !data.coverage.complete}
    <section class="rounded-xl border border-gold-300 bg-gold-50 p-4" role="status">
      <p class="text-sm font-medium text-shadow-800">Partial cluster totals</p>
      <p class="mt-1 text-sm text-shadow-600">
        {data.coverage.unavailable} companion{data.coverage.unavailable === 1 ? ' is' : 's are'} unavailable.
        Their usage is excluded from the headline totals.
        {#if unavailableCompanionNames.length > 0}
          Unavailable: {unavailableCompanionNames.join(', ')}.
        {/if}
      </p>
      {#if unavailableCompanions.length > 0}
        <ul class="mt-2 space-y-2 text-sm text-shadow-600">
          {#each unavailableCompanions as companion (companion.companionId)}
            <li>
              <p>{companionDisplayLabel(displayCompanions, companion.companionId)}</p>
              <details class="mt-1 text-xs text-shadow-500">
                <summary class="cursor-pointer">Technical details</summary>
                <p class="mt-1 break-all font-mono">{companionTechnicalLabel(companion.companionId)}</p>
              </details>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#if data.totals}
    <UsageMetricCards totals={data.totals} timeSeries={[...data.timeSeries]} />
    <TokenCompositionChart buckets={[...data.timeSeries]} timezone={data.resolvedRange.timezone} />
  {:else}
    <section class="card-garden p-8">
      <h2 class="font-serif text-lg font-semibold text-shadow-900">No cluster totals available</h2>
      <p class="mt-1 text-sm text-shadow-600">Every registered companion is currently unavailable.</p>
    </section>
  {/if}
{/if}
