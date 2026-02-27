<script lang="ts">
  import { onMount } from 'svelte';
  import { getIdentity } from '$lib/api/endpoints/identity';
  import type { AdminIdentityData } from '$lib/types';

  let data = $state<AdminIdentityData | null>(null);
  let loading = $state(true);
  let error = $state('');
  let showJson = $state(false);

  onMount(async () => {
    try {
      data = await getIdentity();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load identity';
    } finally {
      loading = false;
    }
  });
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-800 dark:text-bark-200">The Seeds</h1>
      <p class="text-sm text-shadow-400 dark:text-shadow-500 mt-1">Character identity and card data</p>
    </div>
    <button
      onclick={() => showJson = !showJson}
      class="text-xs px-3 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600 text-shadow-500 dark:text-shadow-400 hover:bg-bark-100 dark:hover:bg-shadow-800 transition-colors"
    >
      {showJson ? 'Card View' : 'Raw JSON'}
    </button>
  </div>

  {#if loading}
    <div class="card-garden p-6 animate-pulse space-y-4">
      <div class="h-8 bg-bark-200 dark:bg-shadow-700 rounded w-48"></div>
      <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded w-3/4"></div>
      <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded w-1/2"></div>
    </div>
  {:else if error}
    <div class="card-garden p-6 text-center text-wilt-600">{error}</div>
  {:else if data}
    {#if showJson}
      <div class="card-garden p-4">
        <pre class="text-xs font-mono text-shadow-600 dark:text-shadow-400 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(data.card, null, 2)}</pre>
      </div>
    {:else}
      <div class="space-y-4">
        <!-- Name card -->
        <div class="card-garden p-6">
          <div class="flex items-center gap-4">
            <div class="w-16 h-16 rounded-full bg-gold-100 dark:bg-gold-900/30 flex items-center justify-center">
              <span class="text-2xl font-serif font-bold text-gold-700 dark:text-gold-400">{data.card.data.name[0]}</span>
            </div>
            <div>
              <h2 class="text-xl font-serif font-bold text-shadow-800 dark:text-bark-200">{data.card.data.name}</h2>
              <p class="text-xs text-shadow-400 dark:text-shadow-500">
                v{data.version} &middot; {data.card.spec} {data.card.spec_version}
                {#if data.checksum}
                  &middot; <span class="font-mono">{data.checksum.slice(0, 8)}</span>
                {/if}
              </p>
            </div>
          </div>
        </div>

        <!-- Character fields -->
        {#each [
          { label: 'Description', value: data.card.data.description },
          { label: 'Personality', value: data.card.data.personality },
          { label: 'Scenario', value: data.card.data.scenario },
          { label: 'First Message', value: data.card.data.first_mes },
          { label: 'Example Dialogue', value: data.card.data.mes_example },
          { label: 'System Prompt', value: data.card.data.system_prompt },
          { label: 'Post-History Instructions', value: data.card.data.post_history_instructions },
        ] as field}
          {#if field.value && field.value.trim()}
            <div class="card-garden p-5">
              <h3 class="text-sm font-serif font-semibold text-shadow-600 dark:text-shadow-400 mb-2">{field.label}</h3>
              <div class="text-sm text-shadow-800 dark:text-bark-200 whitespace-pre-wrap leading-relaxed">{field.value}</div>
            </div>
          {/if}
        {/each}

        <!-- Tags -->
        {#if data.card.data.tags && data.card.data.tags.length > 0}
          <div class="card-garden p-5">
            <h3 class="text-sm font-serif font-semibold text-shadow-600 dark:text-shadow-400 mb-2">Tags</h3>
            <div class="flex flex-wrap gap-2">
              {#each data.card.data.tags as tag}
                <span class="px-2.5 py-1 rounded-full text-xs bg-bark-100 dark:bg-shadow-800 text-shadow-600 dark:text-shadow-400">{tag}</span>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Version history -->
        {#if data.history && data.history.length > 0}
          <div class="card-garden p-5">
            <h3 class="text-sm font-serif font-semibold text-shadow-600 dark:text-shadow-400 mb-2">Version History</h3>
            <div class="space-y-2">
              {#each data.history as entry}
                <div class="flex items-center gap-3 text-xs text-shadow-500 dark:text-shadow-400">
                  <span class="font-mono">v{entry.version}</span>
                  <span>{new Date(entry.timestamp).toLocaleString()}</span>
                  <span class="text-shadow-300 dark:text-shadow-600">{entry.changedBy}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>
