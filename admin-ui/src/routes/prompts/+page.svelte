<script lang="ts">
  import { onMount } from 'svelte';
  import { listPrompts } from '$lib/api/endpoints/prompts';
  import type { AdminPromptListData } from '$lib/types';

  let data = $state<AdminPromptListData | null>(null);
  let error = $state('');
  let loading = $state(true);
  let expandedLayer = $state<string | null>(null);

  onMount(async () => {
    try {
      data = await listPrompts();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load prompts';
    } finally {
      loading = false;
    }
  });

  function layerTypeColor(type: string): string {
    const colors: Record<string, string> = {
      base: 'bg-gold-100 text-gold-700 border-gold-300',
      operator: 'bg-moss-50 text-moss-600 border-moss-200',
      runtime: 'bg-bark-200 text-shadow-600 border-bark-300',
      channel: 'bg-petal-50 text-petal-500 border-petal-200',
      task: 'bg-shadow-50 text-shadow-500 border-shadow-200',
    };
    return colors[type] ?? 'bg-bark-200 text-shadow-500 border-bark-300';
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="font-serif text-2xl text-shadow-900 font-semibold">The Soil</h1>
    <p class="text-shadow-400 text-sm mt-1">Prompt Layer Management</p>
  </div>

  {#if loading}
    <div class="space-y-3">
      {#each Array(4) as _}
        <div class="card p-4 animate-pulse">
          <div class="h-4 bg-bark-200 rounded w-40 mb-2"></div>
          <div class="h-3 bg-bark-200 rounded w-full"></div>
        </div>
      {/each}
    </div>
  {:else if error}
    <div class="card p-6 border-wilt-200">
      <p class="text-wilt-600 font-medium">Failed to load prompts</p>
      <p class="text-shadow-400 text-sm mt-1">{error}</p>
    </div>
  {:else if data}
    <!-- Prompt Layers -->
    <div class="space-y-3">
      <h2 class="font-serif text-lg text-shadow-800">Active Layers</h2>
      {#each data.layers as layer (layer.id)}
        <div class="card p-4" class:opacity-50={!layer.enabled}>
          <div class="flex items-center gap-3">
            <span class="px-2 py-0.5 text-xs rounded border {layerTypeColor(layer.type)}">
              {layer.type}
            </span>
            <h3 class="text-shadow-800 font-medium text-sm flex-1">{layer.name}</h3>
            <span class="text-xs text-shadow-400">Priority: {layer.priority}</span>
            <span class="text-xs {layer.enabled ? 'text-moss-600' : 'text-shadow-400'}">
              {layer.enabled ? 'Active' : 'Disabled'}
            </span>
            <button
              onclick={() => expandedLayer = expandedLayer === layer.id ? null : layer.id}
              class="text-xs text-gold-600 hover:text-gold-700"
            >
              {expandedLayer === layer.id ? 'Collapse' : 'Expand'}
            </button>
          </div>

          {#if expandedLayer === layer.id}
            <div class="mt-3 pt-3 border-t border-bark-200">
              <pre class="text-xs bg-bark-100 p-3 rounded overflow-x-auto text-shadow-600 whitespace-pre-wrap max-h-64">{layer.content}</pre>
              {#if layer.metadata && Object.keys(layer.metadata).length > 0}
                <div class="mt-2">
                  <p class="text-xs text-shadow-400 mb-1">Metadata:</p>
                  <pre class="text-xs bg-bark-100 p-2 rounded text-shadow-500">{JSON.stringify(layer.metadata, null, 2)}</pre>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}

      {#if data.layers.length === 0}
        <div class="card p-6 text-center">
          <p class="text-shadow-400">No prompt layers configured.</p>
        </div>
      {/if}
    </div>

    <!-- Static Prompts -->
    {#if data.staticPrompts.length > 0}
      <div class="space-y-3 mt-6">
        <h2 class="font-serif text-lg text-shadow-800">Static Prompts</h2>
        {#each data.staticPrompts as prompt (prompt.key)}
          <div class="card p-4">
            <div class="flex items-center justify-between">
              <div>
                <h3 class="text-shadow-800 font-medium text-sm">{prompt.name}</h3>
                {#if prompt.description}
                  <p class="text-xs text-shadow-400 mt-0.5">{prompt.description}</p>
                {/if}
              </div>
              <span class="text-xs text-shadow-300 font-mono">{prompt.key}</span>
            </div>
            <pre class="mt-2 text-xs bg-bark-100 p-3 rounded overflow-x-auto text-shadow-600 whitespace-pre-wrap max-h-32">{prompt.content.slice(0, 500)}{prompt.content.length > 500 ? '...' : ''}</pre>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
