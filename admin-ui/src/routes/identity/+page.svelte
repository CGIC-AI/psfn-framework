<script lang="ts">
  import { onMount } from 'svelte';
  import { getIdentity } from '$lib/api/endpoints/identity';
  import type { AdminIdentityData } from '$lib/types';

  let data = $state<AdminIdentityData | null>(null);
  let error = $state('');
  let loading = $state(true);
  let showRaw = $state(false);

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

<div class="space-y-6">
  <div>
    <h1 class="font-serif text-2xl text-shadow-900 font-semibold">The Seeds</h1>
    <p class="text-shadow-400 text-sm mt-1">Identity / Character Card</p>
  </div>

  {#if loading}
    <div class="card p-6 animate-pulse">
      <div class="h-4 bg-bark-200 rounded w-48 mb-4"></div>
      <div class="h-3 bg-bark-200 rounded w-full mb-2"></div>
      <div class="h-3 bg-bark-200 rounded w-3/4 mb-2"></div>
      <div class="h-3 bg-bark-200 rounded w-1/2"></div>
    </div>
  {:else if error}
    <div class="card p-6 border-wilt-200">
      <p class="text-wilt-600 font-medium">Failed to load identity</p>
      <p class="text-shadow-400 text-sm mt-1">{error}</p>
    </div>
  {:else if data}
    <!-- Character overview -->
    <div class="card p-6">
      <div class="flex items-start justify-between">
        <div>
          <h2 class="font-serif text-xl text-shadow-900">{data.card.data.name}</h2>
          <p class="text-shadow-400 text-sm mt-1">
            v{data.card.data.character_version} by {data.card.data.creator}
          </p>
          <p class="text-shadow-400 text-xs mt-0.5">
            Spec: {data.card.spec} {data.card.spec_version}
          </p>
        </div>
        <div class="text-right">
          <p class="text-xs text-shadow-400">Version {data.version}</p>
          {#if data.checksum}
            <p class="text-xs text-shadow-300 font-mono">{data.checksum.slice(0, 12)}...</p>
          {/if}
        </div>
      </div>

      {#if data.card.data.tags.length > 0}
        <div class="flex flex-wrap gap-1 mt-3">
          {#each data.card.data.tags as tag}
            <span class="px-2 py-0.5 text-xs rounded bg-gold-50 text-gold-700 border border-gold-200">
              {tag}
            </span>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Character fields -->
    <div class="grid grid-cols-1 gap-4">
      {#each [
        { label: 'Description', value: data.card.data.description },
        { label: 'Personality', value: data.card.data.personality },
        { label: 'Scenario', value: data.card.data.scenario },
        { label: 'First Message', value: data.card.data.first_mes },
        { label: 'Example Messages', value: data.card.data.mes_example },
        { label: 'System Prompt', value: data.card.data.system_prompt },
        { label: 'Post-History Instructions', value: data.card.data.post_history_instructions },
        { label: 'Creator Notes', value: data.card.data.creator_notes },
      ] as field}
        {#if field.value && field.value.trim()}
          <div class="card p-4">
            <h3 class="text-sm font-medium text-shadow-600 mb-2">{field.label}</h3>
            <p class="text-sm text-shadow-700 whitespace-pre-wrap leading-relaxed">{field.value}</p>
          </div>
        {/if}
      {/each}
    </div>

    <!-- Version history -->
    {#if data.history.length > 0}
      <div class="card p-4">
        <h3 class="text-sm font-medium text-shadow-600 mb-2">Version History</h3>
        <div class="space-y-1">
          {#each data.history as entry}
            <div class="flex items-center gap-3 text-sm text-shadow-500">
              <span class="font-mono text-xs bg-bark-200 px-1.5 py-0.5 rounded">v{entry.version}</span>
              <span>{new Date(entry.timestamp).toLocaleString()}</span>
              {#if entry.checksum}
                <span class="text-xs text-shadow-300 font-mono">{entry.checksum.slice(0, 8)}</span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Raw JSON toggle -->
    <div class="card p-4">
      <button
        onclick={() => showRaw = !showRaw}
        class="text-sm text-gold-600 hover:text-gold-700"
      >
        {showRaw ? 'Hide' : 'Show'} Raw Data
      </button>
      {#if showRaw}
        <pre class="mt-3 text-xs bg-bark-100 p-3 rounded overflow-x-auto text-shadow-600 max-h-96">{JSON.stringify(data, null, 2)}</pre>
      {/if}
    </div>
  {/if}
</div>
