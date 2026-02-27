<script lang="ts">
  import { onMount } from 'svelte';
  import { apiGet } from '$lib/api/client';

  let data = $state<unknown>(null);
  let error = $state('');
  let loading = $state(true);

  onMount(async () => {
    try {
      data = await apiGet('/api/admin/dashboard');
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load data';
    } finally {
      loading = false;
    }
  });
</script>

<div class="space-y-6">
  <div>
    <h1 class="font-serif text-2xl text-shadow-900 font-semibold">The Blooms</h1>
    <p class="text-shadow-400 text-sm mt-1">Active Shards</p>
  </div>

  {#if loading}
    <div class="card p-6 animate-pulse">
      <div class="h-4 bg-bark-200 rounded w-48 mb-4"></div>
      <div class="h-32 bg-bark-200 rounded"></div>
    </div>
  {:else if error}
    <div class="card p-6 border-wilt-200">
      <p class="text-wilt-600 font-medium">Failed to load shards</p>
      <p class="text-shadow-400 text-sm mt-1">{error}</p>
    </div>
  {:else if data}
    <div class="card p-6">
      <p class="text-shadow-500 text-sm mb-4">
        Shard monitoring is coming soon. Below is the current runtime state with shard information:
      </p>
      <pre class="text-xs bg-bark-100 p-3 rounded overflow-x-auto text-shadow-600 max-h-96">{JSON.stringify(data, null, 2)}</pre>
    </div>
  {/if}
</div>
