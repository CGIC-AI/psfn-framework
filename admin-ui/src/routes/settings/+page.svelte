<script lang="ts">
  import { onMount } from 'svelte';
  import { getSettings, updateSettings } from '$lib/api/endpoints/settings';
  import type { AdminSettingsData } from '$lib/types';

  type ViewMode = 'simple' | 'advanced' | 'raw';

  let data = $state<AdminSettingsData | null>(null);
  let loading = $state(true);
  let error = $state('');
  let mode = $state<ViewMode>('simple');
  let rawJson = $state('');
  let saving = $state(false);
  let saveMessage = $state('');

  // Simple mode fields
  let primaryModel = $state('');
  let extractionModel = $state('');
  let retrievalLimit = $state(15);
  let contextWindow = $state(128000);

  onMount(async () => {
    try {
      data = await getSettings();
      rawJson = JSON.stringify(data.config, null, 2);
      // Populate simple mode
      const c = data.config as Record<string, unknown>;
      primaryModel = String(c.primaryModel ?? '');
      extractionModel = String(c.extractionModel ?? '');
      retrievalLimit = Number(c.memoryRetrievalLimit ?? 15);
      contextWindow = Number(c.defaultContextWindow ?? 128000);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load settings';
    } finally {
      loading = false;
    }
  });

  async function saveSimple() {
    saving = true;
    saveMessage = '';
    try {
      const result = await updateSettings({
        primaryModel,
        extractionModel,
        memoryRetrievalLimit: retrievalLimit,
        defaultContextWindow: contextWindow,
      });
      saveMessage = result.message || 'Settings saved';
    } catch (e) {
      saveMessage = e instanceof Error ? e.message : 'Failed to save';
    } finally {
      saving = false;
    }
  }

  async function saveRaw() {
    saving = true;
    saveMessage = '';
    try {
      const parsed = JSON.parse(rawJson);
      const result = await updateSettings(parsed);
      saveMessage = result.message || 'Settings saved';
    } catch (e) {
      saveMessage = e instanceof Error ? e.message : 'Invalid JSON or save failed';
    } finally {
      saving = false;
    }
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-800 dark:text-bark-200">The Climate</h1>
      <p class="text-sm text-shadow-400 dark:text-shadow-500 mt-1">Runtime configuration</p>
    </div>

    <!-- Mode switcher -->
    <div class="flex rounded-lg border border-bark-300 dark:border-shadow-600 overflow-hidden">
      {#each (['simple', 'advanced', 'raw'] as const) as m}
        <button
          onclick={() => mode = m}
          class="px-3 py-1.5 text-xs font-medium capitalize transition-colors
            {mode === m
              ? 'bg-gold-600 text-white'
              : 'bg-bark-50 dark:bg-shadow-800 text-shadow-500 dark:text-shadow-400 hover:bg-bark-100 dark:hover:bg-shadow-700'}"
        >
          {m}
        </button>
      {/each}
    </div>
  </div>

  {#if loading}
    <div class="card-garden p-6 animate-pulse space-y-4">
      {#each Array(4) as _}
        <div class="h-10 bg-bark-200 dark:bg-shadow-700 rounded"></div>
      {/each}
    </div>
  {:else if error}
    <div class="card-garden p-6 text-center text-wilt-600">{error}</div>
  {:else if mode === 'simple'}
    <div class="card-garden p-6 space-y-5">
      <div>
        <label class="block text-sm font-medium text-shadow-700 dark:text-bark-300 mb-1.5">Primary Model</label>
        <input type="text" bind:value={primaryModel}
          class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300" />
      </div>
      <div>
        <label class="block text-sm font-medium text-shadow-700 dark:text-bark-300 mb-1.5">Extraction Model</label>
        <input type="text" bind:value={extractionModel}
          class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300" />
      </div>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-sm font-medium text-shadow-700 dark:text-bark-300 mb-1.5">Retrieval Limit</label>
          <input type="number" bind:value={retrievalLimit} min="1" max="100"
            class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300" />
        </div>
        <div>
          <label class="block text-sm font-medium text-shadow-700 dark:text-bark-300 mb-1.5">Context Window</label>
          <input type="number" bind:value={contextWindow} step="1000"
            class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300" />
        </div>
      </div>

      <div class="flex items-center gap-3 pt-2">
        <button onclick={saveSimple} disabled={saving}
          class="px-4 py-2 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors">
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
        {#if saveMessage}
          <span class="text-sm text-moss-600">{saveMessage}</span>
        {/if}
      </div>
    </div>
  {:else if mode === 'advanced'}
    <div class="card-garden p-6">
      <p class="text-sm text-shadow-500 dark:text-shadow-400 mb-4">
        Full settings organized by category. Use the Raw JSON tab to view and edit the complete config.
      </p>
      {#if data}
        {#each Object.entries(data.config as Record<string, unknown>) as [key, value]}
          <div class="flex items-center justify-between py-2 border-b border-bark-100 dark:border-shadow-800">
            <span class="text-xs font-mono text-shadow-600 dark:text-shadow-400">{key}</span>
            <span class="text-xs text-shadow-500 dark:text-shadow-400 max-w-xs truncate">{JSON.stringify(value)}</span>
          </div>
        {/each}
      {/if}
    </div>
  {:else}
    <div class="card-garden p-4">
      <textarea
        bind:value={rawJson}
        rows="30"
        class="w-full font-mono text-xs text-shadow-600 dark:text-shadow-400 bg-bark-50 dark:bg-shadow-900 border border-bark-200 dark:border-shadow-700 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-gold-300 resize-y"
        spellcheck="false"
      ></textarea>
      <div class="flex items-center gap-3 mt-3">
        <button onclick={saveRaw} disabled={saving}
          class="px-4 py-2 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors">
          {saving ? 'Saving...' : 'Save Raw Config'}
        </button>
        {#if saveMessage}
          <span class="text-sm text-moss-600">{saveMessage}</span>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Environment info -->
  {#if data?.env}
    <div class="card-garden p-5">
      <h2 class="text-sm font-serif font-semibold text-shadow-600 dark:text-shadow-400 mb-2">Environment</h2>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-shadow-500 dark:text-shadow-400">
        <div>Node: <span class="font-mono">{data.env.nodeVersion}</span></div>
        <div>Platform: <span class="font-mono">{data.env.platform}/{data.env.arch}</span></div>
        <div>Uptime: {Math.floor(data.env.uptime / 3600)}h {Math.floor((data.env.uptime % 3600) / 60)}m</div>
        <div>Heap: {(data.env.memoryUsage.heapUsed / 1_048_576).toFixed(0)}MB / {(data.env.memoryUsage.heapTotal / 1_048_576).toFixed(0)}MB</div>
      </div>
    </div>
  {/if}
</div>
