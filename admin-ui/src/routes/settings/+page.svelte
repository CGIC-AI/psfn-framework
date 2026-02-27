<script lang="ts">
  import { onMount } from 'svelte';
  import { getSettings } from '$lib/api/endpoints/settings';
  import type { AdminSettingsData } from '$lib/types';

  let data = $state<AdminSettingsData | null>(null);
  let error = $state('');
  let loading = $state(true);
  let activeTab = $state<'config' | 'env' | 'editors'>('config');

  onMount(async () => {
    try {
      data = await getSettings();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load settings';
    } finally {
      loading = false;
    }
  });
</script>

<div class="space-y-6">
  <div>
    <h1 class="font-serif text-2xl text-shadow-900 font-semibold">The Climate</h1>
    <p class="text-shadow-400 text-sm mt-1">Runtime Settings</p>
  </div>

  {#if loading}
    <div class="card p-6 animate-pulse">
      <div class="h-4 bg-bark-200 rounded w-32 mb-4"></div>
      <div class="h-64 bg-bark-200 rounded"></div>
    </div>
  {:else if error}
    <div class="card p-6 border-wilt-200">
      <p class="text-wilt-600 font-medium">Failed to load settings</p>
      <p class="text-shadow-400 text-sm mt-1">{error}</p>
    </div>
  {:else if data}
    <!-- Tab bar -->
    <div class="flex gap-1 border-b border-bark-300">
      {#each (['config', 'env', 'editors'] as const) as tab}
        <button
          onclick={() => activeTab = tab}
          class="px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px"
          class:border-gold-400={activeTab === tab}
          class:text-gold-700={activeTab === tab}
          class:border-transparent={activeTab !== tab}
          class:text-shadow-500={activeTab !== tab}
          class:hover:text-shadow-700={activeTab !== tab}
        >
          {tab.charAt(0).toUpperCase() + tab.slice(1)}
        </button>
      {/each}
    </div>

    <div class="card p-4">
      {#if activeTab === 'config'}
        <h3 class="text-sm font-medium text-shadow-600 mb-3">Runtime Configuration</h3>
        <div class="space-y-2">
          {#each Object.entries(data.config) as [key, value]}
            <div class="flex items-start justify-between py-1.5 border-b border-bark-200 last:border-b-0">
              <span class="text-sm text-shadow-600 font-mono">{key}</span>
              <span class="text-sm text-shadow-700 text-right max-w-md truncate">
                {typeof value === 'object' ? JSON.stringify(value) : String(value)}
              </span>
            </div>
          {/each}
        </div>
      {:else if activeTab === 'env'}
        <h3 class="text-sm font-medium text-shadow-600 mb-3">Environment Variables</h3>
        <div class="space-y-2">
          {#each Object.entries(data.env) as [key, value]}
            <div class="flex items-start justify-between py-1.5 border-b border-bark-200 last:border-b-0">
              <span class="text-sm text-shadow-600 font-mono">{key}</span>
              <span class="text-sm text-shadow-700 text-right max-w-md truncate">
                {String(value)}
              </span>
            </div>
          {/each}
        </div>
      {:else}
        <h3 class="text-sm font-medium text-shadow-600 mb-3">Configuration Editors</h3>
        <pre class="text-xs bg-bark-100 p-3 rounded overflow-x-auto text-shadow-600 max-h-96">{JSON.stringify(data.editors, null, 2)}</pre>
      {/if}
    </div>
  {/if}
</div>
