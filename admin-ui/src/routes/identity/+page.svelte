<script lang="ts">
  import { onMount } from 'svelte';
  import { getIdentity, importIdentityCard, rollbackIdentityCard, previewIdentityCardDiff } from '$lib/api/endpoints/identity';
  import type { AdminIdentityData, CharacterCardV2 } from '$lib/types';

  let data = $state<AdminIdentityData | null>(null);
  let loading = $state(true);
  let error = $state('');
  let showJson = $state(false);

  // Import
  let importPath = $state('');
  let importing = $state(false);
  let importMessage = $state('');

  // Rollback
  let rollingBack = $state<number | null>(null);
  let rollbackMessage = $state('');

  // Diff
  let diffVersion = $state<number | null>(null);
  let diffLoading = $state(false);
  let diffCurrent = $state<CharacterCardV2 | null>(null);
  let diffTarget = $state<CharacterCardV2 | null>(null);

  onMount(async () => {
    try {
      data = await getIdentity();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load identity';
    } finally {
      loading = false;
    }
  });

  async function handleImport() {
    if (!importPath.trim()) return;
    importing = true;
    importMessage = '';
    try {
      const result = await importIdentityCard(importPath.trim());
      importMessage = result.message || 'Import successful';
      data = await getIdentity();
      importPath = '';
    } catch (e) {
      importMessage = e instanceof Error ? e.message : 'Import failed';
    } finally {
      importing = false;
    }
  }

  async function handleRollback(version: number) {
    if (!confirm(`Roll back to version ${version}? This will replace the current card.`)) return;
    rollingBack = version;
    rollbackMessage = '';
    try {
      const result = await rollbackIdentityCard(version);
      rollbackMessage = result.message || 'Rollback successful';
      data = await getIdentity();
    } catch (e) {
      rollbackMessage = e instanceof Error ? e.message : 'Rollback failed';
    } finally {
      rollingBack = null;
    }
  }

  async function showDiff(version: number) {
    if (diffVersion === version) {
      diffVersion = null;
      diffCurrent = null;
      diffTarget = null;
      return;
    }
    diffVersion = version;
    diffLoading = true;
    try {
      const result = await previewIdentityCardDiff(version);
      diffCurrent = result.current;
      diffTarget = result.target;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load diff';
      diffVersion = null;
    } finally {
      diffLoading = false;
    }
  }

  const DIFF_FIELDS: Array<{ key: keyof CharacterCardV2['data']; label: string }> = [
    { key: 'name', label: 'Name' },
    { key: 'description', label: 'Description' },
    { key: 'personality', label: 'Personality' },
    { key: 'scenario', label: 'Scenario' },
    { key: 'first_mes', label: 'First Message' },
    { key: 'mes_example', label: 'Example Dialogue' },
    { key: 'system_prompt', label: 'System Prompt' },
    { key: 'post_history_instructions', label: 'Post-History Instructions' },
  ];

  function fieldsDiffer(a: CharacterCardV2, b: CharacterCardV2, key: keyof CharacterCardV2['data']): boolean {
    const va = String(a.data[key] ?? '');
    const vb = String(b.data[key] ?? '');
    return va !== vb;
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-800 dark:text-bark-200">The Seeds</h1>
      <p class="text-sm text-shadow-400 dark:text-bark-500 mt-1">Character identity and card data</p>
    </div>
    <button
      onclick={() => showJson = !showJson}
      class="text-xs px-3 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600 text-shadow-500 dark:text-bark-400 hover:bg-bark-100 dark:hover:bg-shadow-800 transition-colors"
    >
      {showJson ? 'Card View' : 'Raw JSON'}
    </button>
  </div>

  {#if error}
    <div class="card-garden p-4 text-wilt-600 dark:text-wilt-400 text-sm">{error}</div>
  {/if}

  {#if loading}
    <div class="card-garden p-6 animate-pulse space-y-4">
      <div class="h-8 bg-bark-200 dark:bg-shadow-700 rounded w-48"></div>
      <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded w-3/4"></div>
      <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded w-1/2"></div>
    </div>
  {:else if data}
    {#if showJson}
      <div class="card-garden p-4">
        <pre class="text-xs font-mono text-shadow-600 dark:text-bark-400 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(data.card, null, 2)}</pre>
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
              <p class="text-xs text-shadow-400 dark:text-bark-500">
                v{data.version} &middot; {data.card.spec} {data.card.spec_version}
                {#if data.checksum}
                  &middot; <span class="font-mono">{data.checksum.slice(0, 8)}</span>
                {/if}
              </p>
            </div>
          </div>
        </div>

        <!-- Import from path -->
        <div class="card-garden p-5">
          <h3 class="text-sm font-serif font-semibold text-shadow-600 dark:text-bark-400 mb-3">Import Character Card</h3>
          <form onsubmit={(e) => { e.preventDefault(); handleImport(); }} class="flex gap-2">
            <input
              type="text"
              bind:value={importPath}
              placeholder="/path/to/character.json"
              class="flex-1 px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm
                placeholder:text-shadow-300 dark:placeholder:text-shadow-600
                focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
            />
            <button
              type="submit"
              disabled={importing || !importPath.trim()}
              class="px-4 py-2 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors"
            >
              {importing ? 'Importing...' : 'Import'}
            </button>
          </form>
          {#if importMessage}
            <p class="mt-2 text-xs text-shadow-500 dark:text-bark-400">{importMessage}</p>
          {/if}
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
              <h3 class="text-sm font-serif font-semibold text-shadow-600 dark:text-bark-400 mb-2">{field.label}</h3>
              <div class="text-sm text-shadow-800 dark:text-bark-200 whitespace-pre-wrap leading-relaxed">{field.value}</div>
            </div>
          {/if}
        {/each}

        <!-- Tags -->
        {#if data.card.data.tags && data.card.data.tags.length > 0}
          <div class="card-garden p-5">
            <h3 class="text-sm font-serif font-semibold text-shadow-600 dark:text-bark-400 mb-2">Tags</h3>
            <div class="flex flex-wrap gap-2">
              {#each data.card.data.tags as tag}
                <span class="px-2.5 py-1 rounded-full text-xs bg-bark-100 dark:bg-shadow-800 text-shadow-600 dark:text-bark-400">{tag}</span>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Version history with rollback + diff -->
        {#if data.history && data.history.length > 0}
          <div class="card-garden p-5">
            <h3 class="text-sm font-serif font-semibold text-shadow-600 dark:text-bark-400 mb-3">Version History</h3>
            {#if rollbackMessage}
              <p class="mb-3 text-xs text-shadow-500 dark:text-bark-400">{rollbackMessage}</p>
            {/if}
            <div class="space-y-2">
              {#each data.history as entry (entry.version)}
                {@const isCurrent = entry.version === data.version}
                <div class="rounded-lg border border-bark-200 dark:border-shadow-700 overflow-hidden">
                  <div class="flex items-center gap-3 px-4 py-2.5 bg-bark-50 dark:bg-shadow-800/50">
                    <span class="font-mono text-xs text-shadow-600 dark:text-bark-400">v{entry.version}</span>
                    <span class="text-xs text-shadow-500 dark:text-bark-400">{new Date(entry.timestamp).toLocaleString()}</span>
                    <span class="text-xs text-shadow-300 dark:text-bark-500">{entry.changedBy}</span>
                    {#if isCurrent}
                      <span class="ml-auto px-2 py-0.5 rounded-full text-[10px] font-medium bg-gold-100 text-gold-700 dark:bg-gold-900/30 dark:text-gold-400">current</span>
                    {:else}
                      <div class="ml-auto flex gap-1.5">
                        <button
                          onclick={() => showDiff(entry.version)}
                          class="px-2.5 py-1 text-[11px] font-medium rounded border border-bark-300 dark:border-shadow-600 text-shadow-500 dark:text-bark-400 hover:bg-bark-100 dark:hover:bg-shadow-800 transition-colors"
                        >
                          {diffVersion === entry.version ? 'Hide Diff' : 'Diff'}
                        </button>
                        <button
                          onclick={() => handleRollback(entry.version)}
                          disabled={rollingBack === entry.version}
                          class="px-2.5 py-1 text-[11px] font-medium rounded border border-wilt-300 dark:border-wilt-700 text-wilt-600 dark:text-wilt-400 hover:bg-wilt-50 dark:hover:bg-wilt-900/20 transition-colors disabled:opacity-50"
                        >
                          {rollingBack === entry.version ? 'Rolling back...' : 'Rollback'}
                        </button>
                      </div>
                    {/if}
                  </div>

                  <!-- Diff panel -->
                  {#if diffVersion === entry.version}
                    <div class="border-t border-bark-100 dark:border-shadow-800 p-4">
                      {#if diffLoading}
                        <div class="animate-pulse space-y-2">
                          <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded w-1/3"></div>
                          <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded w-2/3"></div>
                        </div>
                      {:else if diffCurrent && diffTarget}
                        <p class="text-xs text-shadow-400 dark:text-bark-500 mb-3">
                          Comparing current (v{data.version}) with v{entry.version}
                        </p>
                        <div class="space-y-3">
                          {#each DIFF_FIELDS as df (df.key)}
                            {@const differs = fieldsDiffer(diffCurrent, diffTarget, df.key)}
                            {#if differs}
                              <div>
                                <p class="text-xs font-medium text-shadow-500 dark:text-bark-400 mb-1.5">{df.label}</p>
                                <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                                  <div class="rounded-lg border border-bark-200 dark:border-shadow-700 p-3 bg-bark-50 dark:bg-shadow-900">
                                    <p class="text-[10px] font-medium text-shadow-400 dark:text-bark-500 uppercase tracking-wider mb-1">Current (v{data.version})</p>
                                    <pre class="text-xs font-mono text-shadow-700 dark:text-bark-300 whitespace-pre-wrap max-h-48 overflow-y-auto">{String(diffCurrent.data[df.key] ?? '')}</pre>
                                  </div>
                                  <div class="rounded-lg border border-gold-200 dark:border-gold-800 p-3 bg-gold-50/50 dark:bg-gold-900/10">
                                    <p class="text-[10px] font-medium text-gold-600 dark:text-gold-400 uppercase tracking-wider mb-1">Target (v{entry.version})</p>
                                    <pre class="text-xs font-mono text-shadow-700 dark:text-bark-300 whitespace-pre-wrap max-h-48 overflow-y-auto">{String(diffTarget.data[df.key] ?? '')}</pre>
                                  </div>
                                </div>
                              </div>
                            {/if}
                          {/each}
                          {#if !DIFF_FIELDS.some(df => fieldsDiffer(diffCurrent!, diffTarget!, df.key))}
                            <p class="text-xs text-shadow-400 dark:text-bark-500 italic">No field differences detected.</p>
                          {/if}
                        </div>
                      {:else}
                        <p class="text-xs text-shadow-400 dark:text-bark-500 italic">Unable to load diff.</p>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>
