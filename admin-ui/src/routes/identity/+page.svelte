<script lang="ts">
  import { onMount } from 'svelte';
  import { getIdentity, importIdentity, rollbackIdentity, previewDiff } from '$lib/api/endpoints/identity';
  import type { DiffPreviewResponse } from '$lib/api/endpoints/identity';
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
  let diffData = $state<DiffPreviewResponse | null>(null);

  // Inline editing
  let editingField = $state<string | null>(null);
  let editFieldValue = $state('');

  // Collapsible sections
  let showExtensions = $state(false);
  let showAlternateGreetings = $state(false);
  let showCreatorNotes = $state(false);

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
      importSuccess = result.ok !== false;
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
      diffData = null;
      return;
    }
    diffVersion = version;
    diffLoading = true;
    try {
      diffData = await previewDiff({ version });
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load diff';
      diffVersion = null;
      diffData = null;
    } finally {
      diffLoading = false;
    }
  }

  // Compute diff lines between two string values
  function computeFieldDiff(current: string, target: string): Array<{ type: 'same' | 'add' | 'remove'; text: string }> {
    const currentLines = current.split('\n');
    const targetLines = target.split('\n');
    const result: Array<{ type: 'same' | 'add' | 'remove'; text: string }> = [];

    // Simple line-by-line comparison
    const maxLen = Math.max(currentLines.length, targetLines.length);
    const currentSet = new Set(currentLines);
    const targetSet = new Set(targetLines);

    // Lines removed from current (in current but not in target)
    for (const line of currentLines) {
      if (!targetSet.has(line)) {
        result.push({ type: 'remove', text: line });
      }
    }
    // Lines added in target (in target but not in current)
    for (const line of targetLines) {
      if (!currentSet.has(line)) {
        result.push({ type: 'add', text: line });
      }
    }
    // Lines unchanged
    for (const line of currentLines) {
      if (targetSet.has(line)) {
        result.push({ type: 'same', text: line });
      }
    }

    return result;
  }

  // Build structured diff for two card objects
  function buildCardDiff(current: CharacterCardV2, target: CharacterCardV2): Array<{ field: string; current: string; target: string }> {
    const fields = [
      'name', 'description', 'personality', 'scenario', 'first_mes',
      'mes_example', 'system_prompt', 'post_history_instructions',
      'creator', 'creator_notes', 'character_version',
    ];
    const diffs: Array<{ field: string; current: string; target: string }> = [];
    for (const f of fields) {
      const cv = String(current.data[f] ?? '');
      const tv = String(target.data[f] ?? '');
      if (cv !== tv) {
        diffs.push({ field: f, current: cv, target: tv });
      }
    }
    // Check tags
    const cTags = (current.data.tags ?? []).join(', ');
    const tTags = (target.data.tags ?? []).join(', ');
    if (cTags !== tTags) {
      diffs.push({ field: 'tags', current: cTags, target: tTags });
    }
    return diffs;
  }

  const PLACEHOLDER_VALUES = ['sytem prompt', 'system prompt', 'post history', 'post_history_instructions'];

  function isPlaceholder(value: string | undefined): boolean {
    if (!value || !value.trim()) return true;
    return PLACEHOLDER_VALUES.some(p => value.trim().toLowerCase() === p);
  }

  // Inline edit helpers
  function startFieldEdit(field: string, value: string) {
    editingField = field;
    editFieldValue = value;
  }

  function cancelFieldEdit() {
    editingField = null;
    editFieldValue = '';
  }

  // Note: The backend identity update endpoint currently only supports import/rollback,
  // not per-field PATCH. So inline editing shows the textarea but save is via re-import.
  // We show the edit UI for reference/preparation of future API support.
  function saveFieldEdit() {
    // For now, flash info that per-field editing requires re-import
    error = 'Per-field editing is not yet supported by the API. Use Import or Rollback to update the character card.';
    editingField = null;
  }

  let card = $derived(data?.card ?? null);
  let cardData = $derived(card?.data ?? null);

  // Character card fields config
  interface CardFieldConfig {
    key: string;
    label: string;
    rows: number;
    mono?: boolean;
  }

  const CARD_FIELDS: CardFieldConfig[] = [
    { key: 'description', label: 'Description', rows: 4 },
    { key: 'personality', label: 'Personality', rows: 4 },
    { key: 'system_prompt', label: 'System Prompt', rows: 7, mono: true },
    { key: 'post_history_instructions', label: 'Post-History Instructions', rows: 4, mono: true },
    { key: 'scenario', label: 'Scenario', rows: 4 },
    { key: 'mes_example', label: 'Example Dialogue', rows: 7, mono: true },
    { key: 'first_mes', label: 'First Message', rows: 4 },
  ];
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">The Seeds</h1>
      <p class="text-sm text-shadow-600 mt-1">Character identity and card data</p>
    </div>
    {#if data}
      <button
        onclick={() => showJson = !showJson}
        class="flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg border border-bark-300 text-shadow-700 hover:bg-bark-100 hover:border-gold-300 transition-colors"
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
      <svg class="w-5 h-5 text-wilt-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
      </svg>
      <span class="text-sm text-wilt-600">{error}</span>
      <button onclick={() => error = ''} class="ml-auto text-shadow-600 hover:text-shadow-800 text-lg leading-none">&times;</button>
    </div>
  {/if}

  <!-- Loading -->
  {#if loading}
    <div class="space-y-4">
      <div class="card-garden p-8 animate-pulse">
        <div class="flex items-center gap-4">
          <div class="w-16 h-16 rounded-full bg-bark-200"></div>
          <div class="space-y-2">
            <div class="h-6 bg-bark-200 rounded w-48"></div>
            <div class="h-4 bg-bark-200 rounded w-32"></div>
          </div>
        </div>
      </div>
      {#each Array(3) as _}
        <div class="card-garden p-6 animate-pulse space-y-3">
          <div class="h-4 bg-bark-200 rounded w-24"></div>
          <div class="h-4 bg-bark-200 rounded w-3/4"></div>
          <div class="h-4 bg-bark-200 rounded w-1/2"></div>
        </div>
      {/each}
    </div>

  {:else if data && card && cardData}
    <!-- Raw JSON view -->
    {#if showJson}
      <div class="card-garden p-5">
        <div class="flex items-center justify-between mb-3">
          <span class="text-sm font-medium text-shadow-700 uppercase tracking-wider">Raw Character Card</span>
          <span class="text-sm font-mono text-shadow-600">
            {card.spec} {card.spec_version}
          </span>
        </div>
        <pre class="text-sm font-mono text-shadow-800 bg-bark-100 p-4 rounded-lg overflow-x-auto whitespace-pre-wrap max-h-[600px] overflow-y-auto leading-relaxed">{JSON.stringify(card, null, 2)}</pre>
      </div>

    {:else}
      <!-- Formatted card view -->
      <div class="space-y-4">
        <!-- Name + version hero card -->
        <div class="card-garden p-6">
          <div class="flex items-center gap-5">
            <div class="w-16 h-16 rounded-full bg-gold-50 border-2 border-gold-300 flex items-center justify-center shrink-0">
              <span class="text-2xl font-serif font-bold text-gold-700">{cardData.name[0]}</span>
            </div>
            <div class="min-w-0">
              <h2 class="text-xl font-serif font-bold text-shadow-900">{cardData.name}</h2>
              <div class="flex flex-wrap items-center gap-2 mt-1">
                <span class="inline-flex items-center px-2 py-0.5 rounded-full text-sm font-medium bg-gold-50 text-gold-700 border border-gold-300">
                  v{data.version}
                </span>
                <span class="text-sm text-shadow-600">
                  {card.spec} {card.spec_version}
                </span>
                {#if data.checksum}
                  <span class="text-sm font-mono text-shadow-600">{data.checksum.slice(0, 12)}</span>
                {/if}
              </div>
              {#if cardData.creator}
                <p class="text-sm text-shadow-700 mt-1">
                  by <span class="font-medium text-shadow-800">{cardData.creator}</span>
                  {#if cardData.character_version}
                    <span class="text-shadow-600 ml-1">({cardData.character_version})</span>
                  {/if}
                </p>
              {/if}
            </div>
          </div>
        </div>

        <!-- Import card -->
        <div class="card-garden p-5">
          <h3 class="text-sm font-serif font-semibold text-shadow-800 mb-3">Import Character Card</h3>
          <form onsubmit={(e) => { e.preventDefault(); handleImport(); }} class="flex gap-2">
            <input
              type="text"
              bind:value={importPath}
              placeholder="/path/to/character.json"
              class="flex-1 px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-900 text-sm
                placeholder:text-shadow-400
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
            <p class="mt-2 text-sm {importSuccess ? 'text-moss-600' : 'text-wilt-600'}">{importMessage}</p>
          {/if}
        </div>

        <!-- Card fields — each is click-to-edit -->
        {#each CARD_FIELDS as field}
          {@const value = cardData[field.key] as string | undefined}
          {#if !isPlaceholder(value)}
            <div class="card-garden p-5">
              <div class="flex items-center justify-between mb-3">
                <h3 class="text-sm font-medium text-shadow-700 uppercase tracking-wider">{field.label}</h3>
                {#if editingField === field.key}
                  <div class="flex gap-1.5">
                    <button onclick={saveFieldEdit}
                      class="px-2.5 py-1 text-sm font-medium rounded bg-gold-600 text-white hover:bg-gold-700 transition-colors">
                      Save
                    </button>
                    <button onclick={cancelFieldEdit}
                      class="px-2.5 py-1 text-sm font-medium rounded text-shadow-700 hover:bg-bark-200 transition-colors border border-bark-300">
                      Cancel
                    </button>
                  </div>
                {:else}
                  <button onclick={() => startFieldEdit(field.key, value ?? '')}
                    class="text-sm text-gold-700 hover:text-gold-600 transition-colors font-medium">
                    Edit
                  </button>
                {/if}
              </div>

              {#if editingField === field.key}
                <textarea
                  bind:value={editFieldValue}
                  rows={field.rows}
                  class="w-full px-3 py-2 rounded-lg border border-gold-300 bg-white text-shadow-900 text-sm resize-y
                         {field.mono ? 'font-mono' : ''}
                         focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                ></textarea>
              {:else if field.mono}
                <pre class="text-sm font-mono text-shadow-800 whitespace-pre-wrap leading-relaxed bg-bark-100 p-3 rounded-lg max-h-64 overflow-y-auto">{value}</pre>
              {:else}
                <div class="text-sm text-shadow-800 whitespace-pre-wrap leading-relaxed">{value}</div>
              {/if}
            </div>
          {/if}
        {/each}

        <!-- Tags -->
        {#if cardData.tags && cardData.tags.length > 0}
          <div class="card-garden p-5">
            <h3 class="text-sm font-medium text-shadow-700 uppercase tracking-wider mb-3">Tags</h3>
            <div class="flex flex-wrap gap-2">
              {#each cardData.tags as tag}
                <span class="px-3 py-1 rounded-full text-sm font-medium bg-bark-200 text-shadow-800 border border-bark-300">{tag}</span>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Creator Notes (collapsible) -->
        {#if cardData.creator_notes && cardData.creator_notes.trim()}
          <div class="card-garden overflow-hidden">
            <button
              class="w-full flex items-center justify-between p-5 text-left hover:bg-bark-50 transition-colors"
              onclick={() => showCreatorNotes = !showCreatorNotes}
            >
              <h3 class="text-sm font-medium text-shadow-700 uppercase tracking-wider">Creator Notes</h3>
              <span class="text-shadow-600 text-sm transition-transform {showCreatorNotes ? 'rotate-180' : ''}">&#9660;</span>
            </button>
            {#if showCreatorNotes}
              <div class="border-t border-bark-300 p-5">
                <div class="text-sm text-shadow-800 whitespace-pre-wrap leading-relaxed">{cardData.creator_notes}</div>
              </div>
            {/if}
          </div>
        {/if}

        <!-- Alternate Greetings (collapsible) -->
        {#if cardData.alternate_greetings && (cardData.alternate_greetings as string[]).length > 0}
          <div class="card-garden overflow-hidden">
            <button
              class="w-full flex items-center justify-between p-5 text-left hover:bg-bark-50 transition-colors"
              onclick={() => showAlternateGreetings = !showAlternateGreetings}
            >
              <h3 class="text-sm font-medium text-shadow-700 uppercase tracking-wider">Alternate Greetings</h3>
              <span class="text-shadow-600 text-sm transition-transform {showAlternateGreetings ? 'rotate-180' : ''}">&#9660;</span>
            </button>
            {#if showAlternateGreetings}
              <div class="border-t border-bark-300 p-5 space-y-3">
                {#each cardData.alternate_greetings as greeting, i}
                  <div>
                    <p class="text-sm font-medium text-shadow-700 mb-1">Greeting {i + 1}</p>
                    <div class="text-sm text-shadow-800 whitespace-pre-wrap leading-relaxed bg-bark-100 p-3 rounded-lg">{greeting}</div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        <!-- Extensions (collapsible) -->
        {#if cardData.extensions && Object.keys(cardData.extensions).length > 0}
          <div class="card-garden overflow-hidden">
            <button
              class="w-full flex items-center justify-between p-5 text-left hover:bg-bark-50 transition-colors"
              onclick={() => showExtensions = !showExtensions}
            >
              <h3 class="text-sm font-medium text-shadow-700 uppercase tracking-wider">Extensions</h3>
              <span class="text-shadow-600 text-sm transition-transform {showExtensions ? 'rotate-180' : ''}">&#9660;</span>
            </button>
            {#if showExtensions}
              <div class="border-t border-bark-300 p-5">
                <pre class="text-sm font-mono text-shadow-800 whitespace-pre-wrap bg-bark-100 p-3 rounded-lg max-h-64 overflow-y-auto">{JSON.stringify(cardData.extensions, null, 2)}</pre>
              </div>
            {/if}
          </div>
        {/if}

        <!-- Version History -->
        {#if data.history && data.history.length > 0}
          <div class="card-garden overflow-hidden">
            <div class="p-5 pb-0">
              <h3 class="text-sm font-medium text-shadow-700 uppercase tracking-wider mb-1">Version History</h3>
              <p class="text-sm text-shadow-600 mb-4">{data.history.length} version{data.history.length === 1 ? '' : 's'} recorded</p>
            </div>

            {#if rollbackMessage}
              <div class="mx-5 mb-3 px-3 py-2 rounded-lg bg-moss-50 text-sm text-moss-600">{rollbackMessage}</div>
            {/if}

            <div class="px-5 pb-5 space-y-2">
              {#each data.history as entry (entry.version)}
                {@const isCurrent = entry.version === data.version}
                <div class="rounded-lg border overflow-hidden {isCurrent ? 'border-gold-300' : 'border-bark-300'}">
                  <div class="flex items-center gap-3 px-4 py-2.5 {isCurrent ? 'bg-gold-50' : 'bg-bark-100'}">
                    <span class="font-mono text-sm font-medium {isCurrent ? 'text-gold-700' : 'text-shadow-800'}">v{entry.version}</span>
                    <span class="text-sm text-shadow-700">{new Date(entry.timestamp).toLocaleString()}</span>
                    <span class="text-sm text-shadow-600">{entry.changedBy}</span>
                    {#if isCurrent}
                      <span class="ml-auto px-2 py-0.5 rounded-full text-sm font-medium bg-gold-100 text-gold-700 border border-gold-300">current</span>
                    {:else}
                      <div class="ml-auto flex gap-1.5">
                        <button
                          onclick={() => showDiff(entry.version)}
                          class="px-2.5 py-1 text-sm font-medium rounded border border-bark-300 text-shadow-700 hover:bg-bark-200 hover:border-gold-300 transition-colors"
                        >
                          {diffVersion === entry.version ? 'Hide Diff' : 'Diff'}
                        </button>
                        <button
                          onclick={() => handleRollback(entry.version)}
                          disabled={rollingBack === entry.version}
                          class="px-2.5 py-1 text-sm font-medium rounded border border-wilt-200 text-wilt-600 hover:bg-wilt-50 transition-colors disabled:opacity-50"
                        >
                          {rollingBack === entry.version ? 'Rolling back...' : 'Rollback'}
                        </button>
                      </div>
                    {/if}
                  </div>

                  <!-- Diff panel with proper red/green highlighting -->
                  {#if diffVersion === entry.version}
                    <div class="border-t border-bark-300 p-4">
                      {#if diffLoading}
                        <div class="animate-pulse space-y-2">
                          <div class="h-4 bg-bark-200 rounded w-1/3"></div>
                          <div class="h-4 bg-bark-200 rounded w-2/3"></div>
                        </div>
                      {:else if diffData && diffData.ok}
                        {@const fieldDiffs = buildCardDiff(diffData.current, diffData.target)}
                        <p class="text-sm text-shadow-700 mb-3">
                          Comparing <span class="font-medium text-shadow-900">current (v{data.version})</span> with <span class="font-medium text-shadow-900">v{entry.version}</span>
                          {#if fieldDiffs.length === 0}
                            <span class="text-shadow-600 ml-1">(no differences)</span>
                          {/if}
                        </p>
                        {#if fieldDiffs.length > 0}
                          <div class="space-y-3">
                            {#each fieldDiffs as fd}
                              <div>
                                <p class="text-sm font-medium text-shadow-800 mb-1">{fd.field}</p>
                                <div class="text-sm font-mono leading-relaxed rounded-lg overflow-hidden border border-bark-300">
                                  {#if fd.current.trim()}
                                    <div class="bg-red-50 p-2 border-b border-bark-200">
                                      <span class="text-red-800 select-none mr-1">-</span>
                                      <span class="text-red-800 whitespace-pre-wrap">{fd.current}</span>
                                    </div>
                                  {/if}
                                  {#if fd.target.trim()}
                                    <div class="bg-green-50 p-2">
                                      <span class="text-green-800 select-none mr-1">+</span>
                                      <span class="text-green-800 whitespace-pre-wrap">{fd.target}</span>
                                    </div>
                                  {/if}
                                </div>
                              </div>
                            {/each}
                          </div>
                        {/if}
                      {:else}
                        <p class="text-sm text-shadow-600 italic">Unable to load diff.</p>
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
