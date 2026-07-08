<script lang="ts">
  import type { DiscoveredModel } from '$lib/types';
  import {
    discoveryLimitSummary,
    discoveryZdrProviderSummary,
  } from './page-helpers';

  let {
    discoveryError,
    discoverySearch,
    filteredDiscoveredModels,
    hasDiscoveredModels,
    setDiscoverySearch,
    addDiscoveredModel,
  } = $props<{
    discoveryError: string;
    discoverySearch: string;
    filteredDiscoveredModels: DiscoveredModel[];
    hasDiscoveredModels: boolean;
    setDiscoverySearch: (value: string) => void;
    addDiscoveredModel: (discovered: DiscoveredModel) => void;
  }>();
</script>

<section class="card-garden p-4 space-y-3" aria-labelledby="discovered-models-heading">
  <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
    <div>
      <h2 id="discovered-models-heading" class="text-sm font-serif font-semibold text-shadow-800">Discovered Models</h2>
      <p class="text-sm text-shadow-600 mt-1">
        Discovery uses OpenRouter model metadata. ZDR tags come from OpenRouter endpoint metadata.
      </p>
    </div>
    <div class="w-full lg:w-80">
      <label class="block text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500 mb-1" for="discovered-model-search">
        Search
      </label>
      <input
        id="discovered-model-search"
        type="search"
        value={discoverySearch}
        oninput={(event) => {
          setDiscoverySearch((event.currentTarget as HTMLInputElement).value);
        }}
        class="w-full rounded border border-bark-300 bg-white px-3 py-2 text-sm text-shadow-800"
        placeholder="model, provider, vision, zdr"
      />
    </div>
  </div>
  {#if discoveryError}
    <p class="text-sm text-wilt-600">{discoveryError}</p>
  {/if}
  {#if !hasDiscoveredModels}
    <p class="text-sm text-shadow-500">No models discovered yet.</p>
  {:else if filteredDiscoveredModels.length === 0}
    <p class="text-sm text-shadow-500">No discovered models match the current search.</p>
  {:else}
    <div class="overflow-x-auto pb-1">
      <div class="flex min-w-full gap-3">
        {#each filteredDiscoveredModels as discovered}
          <article class="min-w-[18rem] max-w-[22rem] rounded-lg border border-bark-200 bg-bark-50 px-3 py-2">
            <div class="flex items-start justify-between gap-2">
              <p class="font-mono text-xs text-shadow-800 break-all">{discovered.id}</p>
              {#if discovered.zdrAvailable}
                <span class="shrink-0 rounded-full border border-moss-300 bg-moss-50 px-2 py-0.5 text-[11px] font-semibold text-moss-700">
                  ZDR {discovered.zdrEndpointCount ?? 1}
                </span>
              {:else}
                <span class="shrink-0 rounded-full border border-wilt-200 bg-wilt-50 px-2 py-0.5 text-[11px] font-semibold text-wilt-600">
                  no ZDR
                </span>
              {/if}
            </div>
            {#if discovered.description}
              <p class="mt-1 line-clamp-2 text-xs text-shadow-600">{discovered.description}</p>
            {/if}
            <div class="mt-2 flex flex-wrap gap-1.5">
              {#if discovered.supportsVision}
                <span class="rounded-full border border-bark-300 bg-white px-2 py-0.5 text-[11px] text-shadow-600">vision</span>
              {/if}
              {#if discovered.supportsReasoning}
                <span class="rounded-full border border-bark-300 bg-white px-2 py-0.5 text-[11px] text-shadow-600">reasoning</span>
              {/if}
              {#if discovered.zdrAvailable}
                <span class="rounded-full border border-moss-200 bg-white px-2 py-0.5 text-[11px] text-moss-700">
                  {discoveryZdrProviderSummary(discovered)}
                </span>
              {/if}
            </div>
            <p class="mt-2 text-xs text-shadow-500">{discoveryLimitSummary(discovered)}</p>
            <button
              onclick={() => addDiscoveredModel(discovered)}
              class="mt-3 px-2.5 py-1 text-xs font-medium rounded border border-gold-400 text-gold-700 hover:bg-gold-100 transition-colors"
            >
              + Add + Autofill
            </button>
          </article>
        {/each}
      </div>
    </div>
  {/if}
</section>
