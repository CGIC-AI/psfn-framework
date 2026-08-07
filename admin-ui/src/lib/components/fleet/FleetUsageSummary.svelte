<script lang="ts">
  import { onMount } from 'svelte';
  import { createDefaultAccountingState } from '$lib/accounting/query-state';
  import { formatInteger } from '$lib/accounting/format';
  import {
    companionDisplayLabel,
    companionTechnicalLabel,
  } from '$lib/fleet/companion-display';
  import {
    fetchFleetModelUsageProjection,
    resolveFleetUsageViewState,
    type FleetModelUsageProjection,
  } from '$lib/fleet/model-usage-summary';

  interface Props {
    companionNames?: Record<string, string>;
  }

  let { companionNames = {} }: Props = $props();
  let projection = $state<FleetModelUsageProjection | null>(null);
  let loading = $state(true);
  let errorMessage = $state('');
  let controller: AbortController | null = null;
  const displayCompanions = $derived(Object.entries(companionNames).map(
    ([companionId, displayName]) => ({ companionId, displayName }),
  ));
  const viewState = $derived(resolveFleetUsageViewState({
    loading,
    errorMessage,
    projection,
  }));

  async function loadUsage(): Promise<void> {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    loading = true;
    errorMessage = '';
    try {
      const query = createDefaultAccountingState();
      const result = await fetchFleetModelUsageProjection({
        range: 'today',
        timezone: query.timezone,
      }, request.signal);
      if (controller !== request) return;
      projection = result;
    } catch (error) {
      if (request.signal.aborted || controller !== request) return;
      errorMessage = error instanceof Error
        ? error.message
        : 'Cluster usage is temporarily unavailable.';
    } finally {
      if (controller === request) loading = false;
    }
  }

  onMount(() => {
    void loadUsage();
    return () => {
      controller?.abort();
      controller = null;
    };
  });
</script>

<section id="fleet-usage" class="mb-10 space-y-4 pt-10" aria-labelledby="fleet-usage-summary-heading">
  <div>
    <h3 id="fleet-usage-summary-heading" class="font-serif text-xl font-semibold text-shadow-900">
      Authorized companion usage
    </h3>
    <p class="mt-1 text-sm text-shadow-600">
      Today's dashboard-grade request and token totals from the fleet-principal projection.
    </p>
  </div>
  {#if viewState === 'unavailable'}
    <div class="card-garden border-l-4 border-l-wilt-400 p-5" role="alert">
      <p class="font-medium text-shadow-900">Cluster usage unavailable</p>
      <p class="mt-1 text-sm text-wilt-700">
        {errorMessage || 'Cluster usage returned no authorized projection.'}
      </p>
      <button
        type="button"
        class="mt-4 rounded-lg border border-bark-300 px-3 py-1.5 text-sm font-medium text-shadow-700 hover:bg-bark-100"
        onclick={() => void loadUsage()}
      >Retry</button>
    </div>
  {:else if viewState === 'loading'}
    <div class="card-garden p-6" aria-busy="true" aria-live="polite">
      <p class="text-sm text-shadow-600">Loading authorized cluster usage…</p>
    </div>
  {:else if viewState === 'ready' && projection}
    <div class="grid gap-3 sm:grid-cols-2">
      <article class="card-garden p-5">
        <p class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Requests</p>
        <p class="mt-2 font-serif text-3xl font-bold tabular-nums text-petal-500">
          {formatInteger(projection.combined.calls)}
        </p>
      </article>
      <article class="card-garden p-5">
        <p class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Total tokens</p>
        <p class="mt-2 font-serif text-3xl font-bold tabular-nums text-petal-500">
          {formatInteger(projection.combined.totalTokens)}
        </p>
        <p class="mt-1 text-xs text-shadow-500">
          {formatInteger(projection.combined.inputTokens)} input ·
          {formatInteger(projection.combined.outputTokens)} output ·
          {formatInteger(projection.combined.cacheReadTokens)} cache read ·
          {formatInteger(projection.combined.cacheWriteTokens)} cache write
        </p>
      </article>
    </div>
    <div class="card-garden overflow-x-auto">
      <table class="min-w-full divide-y divide-bark-300 text-sm">
        <thead class="bg-bark-100 text-left text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500">
          <tr>
            <th scope="col" class="px-4 py-3">Companion</th>
            <th scope="col" class="px-4 py-3 text-right">Requests</th>
            <th scope="col" class="px-4 py-3 text-right">Total tokens</th>
            <th scope="col" class="px-4 py-3 text-right">Input</th>
            <th scope="col" class="px-4 py-3 text-right">Output</th>
            <th scope="col" class="px-4 py-3 text-right">Cache read</th>
            <th scope="col" class="px-4 py-3 text-right">Cache write</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-bark-200 bg-bark-50">
          {#each projection.companions as companion (companion.companionId)}
            <tr>
              <th scope="row" class="px-4 py-3 text-left font-medium text-shadow-900">
                <p>{companionDisplayLabel(displayCompanions, companion.companionId)}</p>
                <details class="mt-1 text-xs font-normal text-shadow-500">
                  <summary class="cursor-pointer">Technical details</summary>
                  <p class="mt-1 break-all font-mono">{companionTechnicalLabel(companion.companionId)}</p>
                </details>
              </th>
              <td class="px-4 py-3 text-right tabular-nums text-shadow-700">{formatInteger(companion.usage.calls)}</td>
              <td class="px-4 py-3 text-right tabular-nums text-shadow-700">{formatInteger(companion.usage.totalTokens)}</td>
              <td class="px-4 py-3 text-right tabular-nums text-shadow-700">{formatInteger(companion.usage.inputTokens)}</td>
              <td class="px-4 py-3 text-right tabular-nums text-shadow-700">{formatInteger(companion.usage.outputTokens)}</td>
              <td class="px-4 py-3 text-right tabular-nums text-shadow-700">{formatInteger(companion.usage.cacheReadTokens)}</td>
              <td class="px-4 py-3 text-right tabular-nums text-shadow-700">{formatInteger(companion.usage.cacheWriteTokens)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
