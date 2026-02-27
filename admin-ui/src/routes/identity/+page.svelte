<script lang="ts">
  import { onMount } from 'svelte';
  import { getIdentity, importIdentity, rollbackIdentity, previewDiff } from '$lib/api/endpoints/identity';
  import type { AdminIdentityData, CharacterCardV2 } from '$lib/types';

  let data = $state<AdminIdentityData | null>(null);
  let loading = $state(true);
  let error = $state('');
  let showJson = $state(false);

  // Import
  let importPath = $state('');
  let importing = $state(false);
  let importMessage = $state('');
  let importSuccess = $state(false);

  // Rollback
  let rollingBack = $state<number | null>(null);
  let rollbackMessage = $state('');

  // Diff
  let diffVersion = $state<number | null>(null);
  let diffLoading = $state(false);
  let diffText = $state<string>('');

  // Creator notes collapsible
  let creatorNotesOpen = $state(false);

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
    importSuccess = false;
    try {
      const result = await importIdentity({ path: importPath.trim() });
      importMessage = result.message || 'Import successful';
      importSuccess = true;
      data = await getIdentity();
      importPath = '';
    } catch (e) {
      importMessage = e instanceof Error ? e.message : 'Import failed';
      importSuccess = false;
    } finally {
      importing = false;
    }
  }

  async function handleRollback(version: number) {
    if (!confirm(`Roll back to version ${version}? This will replace the current identity card.`)) return;
    rollingBack = version;
    rollbackMessage = '';
    try {
      const result = await rollbackIdentity({ version });
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
      diffText = '';
      return;
    }
    diffVersion = version;
    diffLoading = true;
    try {
      const result = await previewDiff({ version });
      diffText = result.diff;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load diff';
      diffVersion = null;
    } finally {
      diffLoading = false;
    }
  }

  const PLACEHOLDER_VALUES = ['sytem prompt', 'system prompt', 'post history', 'post_history_instructions'];

  function isPlaceholder(value: string | undefined): boolean {
    if (!value || !value.trim()) return true;
    return PLACEHOLDER_VALUES.some(p => value.trim().toLowerCase() === p);
  }

  let card = $derived(data?.card ?? null);
  let cardData = $derived(card?.data ?? null);
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900 dark:text-bark-200">The Seeds</h1>
      <p class="text-sm text-shadow-500 dark:text-bark-500 mt-1">Character identity and card data</p>
    </div>
    {#if data}
      <button
        onclick={() => showJson = !showJson}
        class="flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600 text-shadow-500 dark:text-bark-400 hover:bg-bark-100 dark:hover:bg-shadow-800 hover:border-gold-300 transition-colors"
      >
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          {#if showJson}
            <path d="M4 6h16M4 12h16M4 18h16" />
          {:else}
            <path d="M8 2v4l-4 6 4 6v4M16 2v4l4 6-4 6v4" />
          {/if}
        </svg>
        {showJson ? 'Card View' : 'Raw JSON'}
      </button>
    {/if}
  </div>

  <!-- Error -->
  {#if error}
    <div class="card-garden p-4 flex items-center gap-3">
      <svg class="w-5 h-5 text-wilt-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
      </svg>
      <span class="text-sm text-wilt-600 dark:text-wilt-400">{error}</span>
      <button onclick={() => error = ''} class="ml-auto text-shadow-400 hover:text-shadow-600 dark:text-bark-500 dark:hover:text-bark-300 text-lg leading-none">&times;</button>
    </div>
  {/if}

  <!-- Loading -->
  {#if loading}
    <div class="space-y-4">
      <div class="card-garden p-8 animate-pulse">
        <div class="flex items-center gap-4">
          <div class="w-16 h-16 rounded-full bg-bark-200 dark:bg-shadow-700"></div>
          <div class="space-y-2">
            <div class="h-6 bg-bark-200 dark:bg-shadow-700 rounded w-48"></div>
            <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded w-32"></div>
          </div>
        </div>
      </div>
      {#each Array(3) as _}
        <div class="card-garden p-6 animate-pulse space-y-3">
          <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded w-24"></div>
          <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded w-3/4"></div>
          <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded w-1/2"></div>
        </div>
      {/each}
    </div>

  {:else if data && card && cardData}
    <!-- Raw JSON view -->
    {#if showJson}
      <div class="card-garden p-5">
        <div class="flex items-center justify-between mb-3">
          <span class="text-xs font-medium text-shadow-500 dark:text-bark-400 uppercase tracking-wider">Raw Character Card</span>
          <span class="text-[10px] font-mono text-shadow-400 dark:text-bark-500">
            {card.spec} {card.spec_version}
          </span>
        </div>
        <pre class="text-xs font-mono text-shadow-800 dark:text-bark-300 bg-bark-50 dark:bg-shadow-900 p-4 rounded-lg overflow-x-auto whitespace-pre-wrap max-h-[600px] overflow-y-auto leading-relaxed">{JSON.stringify(card, null, 2)}</pre>
      </div>

    {:else}
      <!-- Formatted card view -->
      <div class="space-y-4">
        <!-- Name + version hero card -->
        <div class="card-garden p-6">
          <div class="flex items-center gap-5">
            <div class="w-16 h-16 rounded-full bg-gold-50 dark:bg-gold-900/30 border-2 border-gold-300 dark:border-gold-700 flex items-center justify-center shrink-0">
              <span class="text-2xl font-serif font-bold text-gold-600 dark:text-gold-400">{cardData.name[0]}</span>
            </div>
            <div class="min-w-0">
              <h2 class="text-xl font-serif font-bold text-shadow-900 dark:text-bark-200">{cardData.name}</h2>
              <div class="flex flex-wrap items-center gap-2 mt-1">
                <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-gold-50 text-gold-600 dark:bg-gold-900/30 dark:text-gold-400 border border-gold-300 dark:border-gold-700">
                  v{data.version}
                </span>
                <span class="text-xs text-shadow-400 dark:text-bark-500">
                  {card.spec} {card.spec_version}
                </span>
                {#if data.checksum}
                  <span class="text-[10px] font-mono text-shadow-400 dark:text-bark-500">{data.checksum.slice(0, 12)}</span>
                {/if}
              </div>
              {#if cardData.creator}
                <p class="text-xs text-shadow-500 dark:text-bark-400 mt-1">
                  by <span class="font-medium text-shadow-800 dark:text-bark-300">{cardData.creator}</span>
                  {#if cardData.character_version}
                    <span class="text-shadow-400 dark:text-bark-500 ml-1">({cardData.character_version})</span>
                  {/if}
                </p>
              {/if}
            </div>
          </div>
        </div>

        <!-- Import card -->
        <div class="card-garden p-5">
          <h3 class="text-sm font-serif font-semibold text-shadow-800 dark:text-bark-300 mb-3">Import Character Card</h3>
          <form onsubmit={(e) => { e.preventDefault(); handleImport(); }} class="flex gap-2">
            <input
              type="text"
              bind:value={importPath}
              placeholder="/path/to/character.json"
              class="flex-1 px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm
                placeholder:text-shadow-400 dark:placeholder:text-shadow-600
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
            <p class="mt-2 text-xs {importSuccess ? 'text-moss-600 dark:text-moss-400' : 'text-wilt-600 dark:text-wilt-400'}">{importMessage}</p>
          {/if}
        </div>

        <!-- Description -->
        {#if cardData.description && cardData.description.trim()}
          <div class="card-garden p-5">
            <h3 class="text-xs font-medium text-shadow-500 dark:text-bark-400 uppercase tracking-wider mb-3">Description</h3>
            <div class="text-sm text-shadow-800 dark:text-bark-200 whitespace-pre-wrap leading-relaxed">{cardData.description}</div>
          </div>
        {/if}

        <!-- Personality -->
        {#if cardData.personality && cardData.personality.trim()}
          <div class="card-garden p-5">
            <h3 class="text-xs font-medium text-shadow-500 dark:text-bark-400 uppercase tracking-wider mb-3">Personality</h3>
            <div class="text-sm text-shadow-800 dark:text-bark-200 whitespace-pre-wrap leading-relaxed">{cardData.personality}</div>
          </div>
        {/if}

        <!-- Scenario -->
        {#if cardData.scenario && cardData.scenario.trim()}
          <div class="card-garden p-5">
            <h3 class="text-xs font-medium text-shadow-500 dark:text-bark-400 uppercase tracking-wider mb-3">Scenario</h3>
            <div class="text-sm text-shadow-800 dark:text-bark-200 whitespace-pre-wrap leading-relaxed">{cardData.scenario}</div>
          </div>
        {/if}

        <!-- First Message -->
        {#if !isPlaceholder(cardData.first_mes)}
          <div class="card-garden p-5">
            <h3 class="text-xs font-medium text-shadow-500 dark:text-bark-400 uppercase tracking-wider mb-3">First Message</h3>
            <div class="text-sm text-shadow-800 dark:text-bark-200 whitespace-pre-wrap leading-relaxed bg-bark-50 dark:bg-shadow-900 p-3 rounded-lg">{cardData.first_mes}</div>
          </div>
        {/if}

        <!-- Message Examples -->
        {#if !isPlaceholder(cardData.mes_example)}
          <div class="card-garden p-5">
            <h3 class="text-xs font-medium text-shadow-500 dark:text-bark-400 uppercase tracking-wider mb-3">Example Dialogue</h3>
            <pre class="text-sm font-mono text-shadow-800 dark:text-bark-200 whitespace-pre-wrap leading-relaxed bg-bark-50 dark:bg-shadow-900 p-3 rounded-lg max-h-64 overflow-y-auto">{cardData.mes_example}</pre>
          </div>
        {/if}

        <!-- System Prompt -->
        {#if !isPlaceholder(cardData.system_prompt)}
          <div class="card-garden p-5">
            <h3 class="text-xs font-medium text-shadow-500 dark:text-bark-400 uppercase tracking-wider mb-3">System Prompt</h3>
            <pre class="text-sm font-mono text-shadow-800 dark:text-bark-200 whitespace-pre-wrap leading-relaxed bg-bark-50 dark:bg-shadow-900 p-3 rounded-lg max-h-64 overflow-y-auto">{cardData.system_prompt}</pre>
          </div>
        {/if}

        <!-- Post History Instructions -->
        {#if !isPlaceholder(cardData.post_history_instructions)}
          <div class="card-garden p-5">
            <h3 class="text-xs font-medium text-shadow-500 dark:text-bark-400 uppercase tracking-wider mb-3">Post-History Instructions</h3>
            <pre class="text-sm font-mono text-shadow-800 dark:text-bark-200 whitespace-pre-wrap leading-relaxed bg-bark-50 dark:bg-shadow-900 p-3 rounded-lg max-h-64 overflow-y-auto">{cardData.post_history_instructions}</pre>
          </div>
        {/if}

        <!-- Tags -->
        {#if cardData.tags && cardData.tags.length > 0}
          <div class="card-garden p-5">
            <h3 class="text-xs font-medium text-shadow-500 dark:text-bark-400 uppercase tracking-wider mb-3">Tags</h3>
            <div class="flex flex-wrap gap-2">
              {#each cardData.tags as tag}
                <span class="px-3 py-1 rounded-full text-xs font-medium bg-bark-100 dark:bg-shadow-800 text-shadow-800 dark:text-bark-300 border border-bark-200 dark:border-shadow-700">{tag}</span>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Creator Notes (collapsible) -->
        {#if cardData.extensions && Object.keys(cardData.extensions).length > 0}
          <div class="card-garden overflow-hidden">
            <button
              class="w-full flex items-center justify-between p-5 text-left hover:bg-bark-50 dark:hover:bg-shadow-800/50 transition-colors"
              onclick={() => creatorNotesOpen = !creatorNotesOpen}
            >
              <h3 class="text-xs font-medium text-shadow-500 dark:text-bark-400 uppercase tracking-wider">Extensions</h3>
              <span class="text-shadow-400 dark:text-bark-500 text-xs transition-transform {creatorNotesOpen ? 'rotate-180' : ''}">&#9660;</span>
            </button>
            {#if creatorNotesOpen}
              <div class="border-t border-bark-100 dark:border-shadow-800 p-5">
                <pre class="text-xs font-mono text-shadow-800 dark:text-bark-300 whitespace-pre-wrap bg-bark-50 dark:bg-shadow-900 p-3 rounded-lg max-h-48 overflow-y-auto">{JSON.stringify(cardData.extensions, null, 2)}</pre>
              </div>
            {/if}
          </div>
        {/if}

        <!-- Version History -->
        {#if data.history && data.history.length > 0}
          <div class="card-garden overflow-hidden">
            <div class="p-5 pb-0">
              <h3 class="text-xs font-medium text-shadow-500 dark:text-bark-400 uppercase tracking-wider mb-1">Version History</h3>
              <p class="text-[11px] text-shadow-400 dark:text-bark-500 mb-4">{data.history.length} version{data.history.length === 1 ? '' : 's'} recorded</p>
            </div>

            {#if rollbackMessage}
              <div class="mx-5 mb-3 px-3 py-2 rounded-lg bg-moss-50 dark:bg-moss-900/20 text-xs text-moss-600 dark:text-moss-400">{rollbackMessage}</div>
            {/if}

            <div class="px-5 pb-5 space-y-2">
              {#each data.history as entry (entry.version)}
                {@const isCurrent = entry.version === data.version}
                <div class="rounded-lg border border-bark-200 dark:border-shadow-700 overflow-hidden {isCurrent ? 'border-gold-300 dark:border-gold-700' : ''}">
                  <div class="flex items-center gap-3 px-4 py-2.5 {isCurrent ? 'bg-gold-50/50 dark:bg-gold-900/10' : 'bg-bark-50 dark:bg-shadow-800/50'}">
                    <span class="font-mono text-xs font-medium {isCurrent ? 'text-gold-600 dark:text-gold-400' : 'text-shadow-800 dark:text-bark-300'}">v{entry.version}</span>
                    <span class="text-xs text-shadow-500 dark:text-bark-400">{new Date(entry.timestamp).toLocaleString()}</span>
                    <span class="text-xs text-shadow-400 dark:text-bark-500">{entry.changedBy}</span>
                    {#if isCurrent}
                      <span class="ml-auto px-2 py-0.5 rounded-full text-[10px] font-medium bg-gold-100 text-gold-600 dark:bg-gold-900/30 dark:text-gold-400 border border-gold-300 dark:border-gold-700">current</span>
                    {:else}
                      <div class="ml-auto flex gap-1.5">
                        <button
                          onclick={() => showDiff(entry.version)}
                          class="px-2.5 py-1 text-[11px] font-medium rounded border border-bark-300 dark:border-shadow-600 text-shadow-500 dark:text-bark-400 hover:bg-bark-100 dark:hover:bg-shadow-800 hover:border-gold-300 transition-colors"
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
                      {:else if diffText}
                        <p class="text-xs text-shadow-500 dark:text-bark-400 mb-3">
                          Comparing <span class="font-medium text-shadow-800 dark:text-bark-300">current (v{data.version})</span> with <span class="font-medium text-shadow-800 dark:text-bark-300">v{entry.version}</span>
                        </p>
                        <pre class="text-xs font-mono text-shadow-800 dark:text-bark-300 whitespace-pre-wrap bg-bark-50 dark:bg-shadow-900 p-3 rounded-lg max-h-64 overflow-y-auto leading-relaxed">{diffText}</pre>
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
