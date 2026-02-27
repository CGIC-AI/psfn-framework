<script lang="ts">
  import { onMount } from 'svelte';
  import { listPrompts, togglePrompt } from '$lib/api/endpoints/prompts';
  import type { PromptLayer, PromptRegistryEntry } from '$lib/types';

  let layers = $state<PromptLayer[]>([]);
  let staticPrompts = $state<PromptRegistryEntry[]>([]);
  let loading = $state(true);
  let error = $state('');
  let expandedLayer = $state<string | null>(null);

  const LAYER_BADGE: Record<string, string> = {
    base:     'bg-bark-700 text-bark-100',
    operator: 'bg-gold-600 text-white',
    runtime:  'bg-moss-600 text-white',
    channel:  'bg-blue-600 text-white',
    task:     'bg-petal-600 text-white',
  };

  onMount(async () => {
    try {
      const data = await listPrompts();
      layers = data.layers;
      staticPrompts = data.staticPrompts;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load prompts';
    } finally {
      loading = false;
    }
  });

  async function handleToggle(layerId: string) {
    try {
      await togglePrompt(layerId);
      const data = await listPrompts();
      layers = data.layers;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to toggle layer';
    }
  }

  function isProtected(layer: PromptLayer): boolean {
    return layer.type === 'base' || layer.type === 'operator';
  }
</script>

<div class="space-y-4">
  <div>
    <h1 class="text-2xl font-serif font-bold text-shadow-800 dark:text-bark-200">The Soil</h1>
    <p class="text-sm text-shadow-400 dark:text-bark-500 mt-1">Layered prompt stack — {layers.length} layers</p>
  </div>

  {#if loading}
    <div class="space-y-2">
      {#each Array(5) as _}
        <div class="card-garden p-4 animate-pulse h-16"></div>
      {/each}
    </div>
  {:else if error}
    <div class="card-garden p-6 text-center text-wilt-600">{error}</div>
  {:else}
    <!-- Dynamic layers -->
    <div class="space-y-2">
      {#each layers as layer (layer.id)}
        <div class="card-garden overflow-hidden {!layer.enabled ? 'opacity-50' : ''}">
          <button
            class="w-full text-left px-4 py-3 flex items-center gap-3"
            onclick={() => expandedLayer = expandedLayer === layer.id ? null : layer.id}
          >
            <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide {LAYER_BADGE[layer.type] || 'bg-bark-300 text-bark-700'}">
              {layer.type}
            </span>
            <span class="flex-1 text-sm font-medium text-shadow-700 dark:text-bark-300">{layer.name}</span>
            {#if layer.identifier}
              <span class="text-[11px] font-mono text-shadow-300 dark:text-bark-500">{layer.identifier}</span>
            {/if}
            <span class="text-[11px] text-shadow-400 dark:text-bark-500">p{layer.priority}</span>
            {#if !isProtected(layer)}
              <button
                onclick={(e) => { e.stopPropagation(); handleToggle(layer.id); }}
                class="px-2 py-1 text-[11px] rounded {layer.enabled ? 'text-moss-600 hover:bg-moss-50' : 'text-wilt-500 hover:bg-wilt-50'} transition-colors"
              >
                {layer.enabled ? 'ON' : 'OFF'}
              </button>
            {:else}
              <svg class="w-4 h-4 text-shadow-300 dark:text-bark-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            {/if}
          </button>

          {#if expandedLayer === layer.id}
            <div class="px-4 pb-4 border-t border-bark-100 dark:border-shadow-800">
              <pre class="mt-3 text-xs font-mono text-shadow-600 dark:text-bark-400 whitespace-pre-wrap bg-bark-50 dark:bg-shadow-900 p-3 rounded-lg max-h-64 overflow-y-auto">{layer.content}</pre>
              <div class="flex items-center gap-4 mt-3 text-[11px] text-shadow-400 dark:text-bark-500">
                <span>v{layer.version}</span>
                <span>Updated {new Date(layer.updatedAt).toLocaleString()}</span>
                <span>by {layer.updatedBy}</span>
                <span class="font-mono">{layer.checksum.slice(0, 8)}</span>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <!-- Static prompts -->
    {#if staticPrompts.length > 0}
      <div class="mt-6">
        <h2 class="text-lg font-serif font-semibold text-shadow-700 dark:text-bark-300 mb-3">Static Prompt Registry</h2>
        <div class="space-y-2">
          {#each staticPrompts as sp (sp.key)}
            <div class="card-garden px-4 py-3 {!sp.enabled ? 'opacity-50' : ''}">
              <div class="flex items-center gap-3">
                <span class="text-sm font-medium text-shadow-700 dark:text-bark-300">{sp.name}</span>
                <span class="text-[11px] font-mono text-shadow-300 dark:text-bark-500">{sp.key}</span>
                <div class="flex-1"></div>
                <span class="text-[11px] text-shadow-400 dark:text-bark-500">v{sp.version}</span>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>
