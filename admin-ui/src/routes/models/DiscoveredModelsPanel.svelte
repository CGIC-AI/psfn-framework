<script lang="ts">
  import { tick } from 'svelte';
  import type { DiscoveredModel } from '$lib/types';
  import {
    discoveryLimitSummary,
    discoveryZdrProviderSummary,
  } from './page-helpers';
  import { resolveDiscoveredModelWindow } from './discovered-model-window';

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

  let viewport = $state<HTMLDivElement | null>(null);
  let modelGrid = $state<HTMLDivElement | null>(null);
  let scrollLeft = $state(0);
  let viewportWidth = $state(0);
  let columnPitch = $state(0);

  const virtualWindow = $derived(resolveDiscoveredModelWindow({
    itemCount: filteredDiscoveredModels.length,
    scrollLeft,
    viewportWidth,
    columnPitch,
    itemsPerColumn: 2,
    overscanColumns: 1,
    bootstrapColumns: 3,
  }));
  const visibleModels = $derived(filteredDiscoveredModels.slice(
    virtualWindow.startItem,
    virtualWindow.endItem,
  ));

  function updateViewportGeometry(): void {
    if (!viewport) return;
    viewportWidth = viewport.clientWidth;
    scrollLeft = viewport.scrollLeft;
    const firstCard = modelGrid?.querySelector<HTMLElement>('[data-discovered-model-card]');
    if (!firstCard || !modelGrid) return;
    const gap = Number.parseFloat(window.getComputedStyle(modelGrid).columnGap);
    const measuredPitch = firstCard.getBoundingClientRect().width
      + (Number.isFinite(gap) ? gap : 0);
    if (measuredPitch > 0) columnPitch = measuredPitch;
  }

  $effect(() => {
    const currentViewport = viewport;
    if (!currentViewport) return;
    void tick().then(updateViewportGeometry);
    const observer = new ResizeObserver(updateViewportGeometry);
    observer.observe(currentViewport);
    return () => observer.disconnect();
  });

  $effect(() => {
    void discoverySearch;
    void filteredDiscoveredModels;
    scrollLeft = 0;
    if (viewport) viewport.scrollLeft = 0;
    void tick().then(updateViewportGeometry);
  });
</script>

<section class="garden-section card-garden space-y-4 p-5" aria-labelledby="discovered-models-heading">
  <div class="garden-section-header flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
    <div>
      <p class="text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-shadow-500">Provider metadata</p>
      <h2 id="discovered-models-heading" class="garden-section-title mt-1 font-serif text-lg font-semibold text-shadow-900">Discovered models</h2>
      <p class="garden-section-description text-sm text-shadow-600 mt-1">
        Discovery uses OpenRouter model metadata. ZDR tags come from OpenRouter endpoint metadata.
      </p>
    </div>
    <div class="garden-field w-full lg:w-80">
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
        class="w-full rounded border border-bark-300 bg-bark-50 px-3 py-2 text-sm text-shadow-800"
        placeholder="model, provider, vision, zdr"
      />
    </div>
  </div>
  {#if discoveryError}
    <p class="garden-error rounded-lg border border-wilt-200 bg-wilt-50 px-3 py-2 text-sm text-wilt-700">{discoveryError}</p>
  {/if}
  {#if !hasDiscoveredModels}
    <p class="garden-empty rounded-lg border border-dashed border-bark-300 bg-bark-50 p-6 text-center text-sm text-shadow-500">No models discovered yet.</p>
  {:else if filteredDiscoveredModels.length === 0}
    <p class="garden-empty rounded-lg border border-dashed border-bark-300 bg-bark-50 p-6 text-center text-sm text-shadow-500">No discovered models match the current search.</p>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      bind:this={viewport}
      onscroll={updateViewportGeometry}
      class="max-w-full overflow-x-auto pb-1"
      role="region"
      aria-label="Discovered model results"
      tabindex="0"
    >
      <div
        class="relative"
        style:width={virtualWindow.totalWidthPx === null ? undefined : `${virtualWindow.totalWidthPx}px`}
      >
        <div
          bind:this={modelGrid}
          class="grid w-max grid-flow-col grid-rows-2 auto-cols-[minmax(16rem,22rem)] gap-3"
          style:transform={`translateX(${virtualWindow.offsetPx}px)`}
          role="list"
          aria-label={`${filteredDiscoveredModels.length} discovered models`}
        >
        {#each visibleModels as discovered, visibleIndex (discovered.id)}
          <article
            data-discovered-model-card
            role="listitem"
            aria-setsize={filteredDiscoveredModels.length}
            aria-posinset={virtualWindow.startItem + visibleIndex + 1}
            class="flex min-w-0 flex-col rounded-xl border border-bark-200 bg-bark-50 px-3 py-3 transition-colors hover:border-gold-300"
          >
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
                <span class="rounded-full border border-bark-300 bg-bark-50 px-2 py-0.5 text-[11px] text-shadow-600">vision</span>
              {/if}
              {#if discovered.supportsReasoning}
                <span class="rounded-full border border-bark-300 bg-bark-50 px-2 py-0.5 text-[11px] text-shadow-600">reasoning</span>
              {/if}
              {#if discovered.zdrAvailable}
                <span class="rounded-full border border-moss-200 bg-bark-50 px-2 py-0.5 text-[11px] text-moss-700">
                  {discoveryZdrProviderSummary(discovered)}
                </span>
              {/if}
            </div>
            <p class="mt-2 text-xs text-shadow-500">{discoveryLimitSummary(discovered)}</p>
            <button
              onclick={() => addDiscoveredModel(discovered)}
              class="garden-action mt-auto self-start rounded border border-gold-400 px-2.5 py-1.5 text-xs font-medium text-gold-700 transition-colors hover:bg-gold-100"
            >
              + Add + Autofill
            </button>
          </article>
        {/each}
        </div>
      </div>
    </div>
  {/if}
</section>
