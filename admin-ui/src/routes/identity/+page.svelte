<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getIdentity,
    importIdentity,
    previewDiff,
    rollbackIdentity,
    updateIdentityField,
    uploadIdentity,
  } from '$lib/api/endpoints/identity';
  import type { DiffPreviewResponse } from '$lib/api/endpoints/identity';
  import ConfirmationModal from '$lib/components/ConfirmationModal.svelte';
  import {
    cancelIdentityConfirmation,
    confirmIdentityConfirmation,
    getIdentityConfirmationContent,
    initialIdentityConfirmationState,
    requestIdentityImportConfirmation,
    requestIdentityRollbackConfirmation,
  } from '$lib/components/identity-confirmation-flow';
  import type { AdminIdentityData, CharacterCardV2, CharacterCardHistoryEntry } from '$lib/types';
  import { pushToast } from '$lib/stores/toast.svelte';

  let data = $state<AdminIdentityData | null>(null);
  let loading = $state(true);
  let error = $state('');
  let showJson = $state(false);

  // Import
  let importPath = $state('');
  let importing = $state(false);
  let importMessage = $state('');
  let importSuccess = $state(false);
  let uploadFile = $state<File | null>(null);
  let uploading = $state(false);
  let uploadMessage = $state('');
  let uploadSuccess = $state(false);
  let uploadInput = $state<HTMLInputElement | null>(null);

  // Rollback
  let rollingBack = $state<number | null>(null);
  let rollbackMessage = $state('');

  // Confirmation modal
  let confirmationState = $state(initialIdentityConfirmationState());
  let pendingConfirmation = $derived(confirmationState.pendingAction);
  let confirmationContent = $derived(
    pendingConfirmation ? getIdentityConfirmationContent(pendingConfirmation) : null
  );

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
  let showRuntimeConfig = $state(false);
  let showVersionHistory = $state(false);
  let showMetadata = $state(false);

  // Export
  function exportAsJson() {
    if (!card) return;
    const blob = new Blob([JSON.stringify(card, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${cardData?.name ?? 'character'}-v${data?.version ?? 1}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  onMount(async () => {
    try {
      data = await getIdentity();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load identity';
    } finally {
      loading = false;
    }
  });

  async function runImport(path: string) {
    importing = true;
    importMessage = '';
    importSuccess = false;
    try {
      const result = await importIdentity({ path });
      importMessage = result.message || 'Import successful';
      importSuccess = result.ok !== false;
      pushToast(importMessage, importSuccess ? 'success' : 'error');
      data = await getIdentity();
      importPath = '';
    } catch (e) {
      importMessage = e instanceof Error ? e.message : 'Import failed';
      importSuccess = false;
      pushToast(importMessage, 'error');
    } finally {
      importing = false;
    }
  }

  function onUploadFileChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    uploadFile = input.files?.[0] ?? null;
    uploadMessage = '';
  }

  function clearUploadSelection() {
    uploadFile = null;
    if (uploadInput) uploadInput.value = '';
  }

  async function runUpload(file: File) {
    uploading = true;
    uploadMessage = '';
    uploadSuccess = false;
    try {
      const result = await uploadIdentity(file);
      uploadMessage = result.message || 'Upload import successful';
      uploadSuccess = result.ok !== false;
      pushToast(uploadMessage, uploadSuccess ? 'success' : 'error');
      data = await getIdentity();
      clearUploadSelection();
    } catch (e) {
      uploadMessage = e instanceof Error ? e.message : 'Upload import failed';
      uploadSuccess = false;
      pushToast(uploadMessage, 'error');
    } finally {
      uploading = false;
    }
  }

  async function runRollback(version: number) {
    rollingBack = version;
    rollbackMessage = '';
    try {
      const result = await rollbackIdentity({ version });
      rollbackMessage = result.message || 'Rollback successful';
      pushToast(rollbackMessage, 'success');
      data = await getIdentity();
    } catch (e) {
      rollbackMessage = e instanceof Error ? e.message : 'Rollback failed';
      pushToast(rollbackMessage, 'error');
    } finally {
      rollingBack = null;
    }
  }

  function openImportConfirmation() {
    confirmationState = requestIdentityImportConfirmation(confirmationState, importPath);
  }

  function openRollbackConfirmation(version: number) {
    confirmationState = requestIdentityRollbackConfirmation(confirmationState, version);
  }

  function cancelConfirmation() {
    confirmationState = cancelIdentityConfirmation(confirmationState);
  }

  async function confirmPendingAction() {
    const { action, nextState } = confirmIdentityConfirmation(confirmationState);
    confirmationState = nextState;
    if (!action) return;

    if (action.type === 'import') {
      await runImport(action.path);
      return;
    }

    await runRollback(action.version);
  }

  async function handleShowDiff(version: number) {
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

  // Build structured diff for two card objects -- compares ALL standard fields
  const DIFF_FIELDS = [
    { key: 'name', label: 'Name' },
    { key: 'description', label: 'Description' },
    { key: 'personality', label: 'Personality' },
    { key: 'scenario', label: 'Scenario' },
    { key: 'first_mes', label: 'First Message' },
    { key: 'mes_example', label: 'Message Example' },
    { key: 'system_prompt', label: 'System Prompt' },
    { key: 'post_history_instructions', label: 'Post-History Instructions' },
    { key: 'creator', label: 'Creator' },
    { key: 'creator_notes', label: 'Creator Notes' },
    { key: 'character_version', label: 'Character Version' },
  ] as const;

  function buildCardDiff(current: CharacterCardV2, target: CharacterCardV2): Array<{ field: string; label: string; current: string; target: string; changed: boolean }> {
    const results: Array<{ field: string; label: string; current: string; target: string; changed: boolean }> = [];
    for (const f of DIFF_FIELDS) {
      const cv = String(current?.data?.[f.key] ?? '');
      const tv = String(target?.data?.[f.key] ?? '');
      results.push({ field: f.key, label: f.label, current: cv, target: tv, changed: cv !== tv });
    }
    // Check tags
    const cTags = (current?.data?.tags ?? []).join(', ');
    const tTags = (target?.data?.tags ?? []).join(', ');
    results.push({ field: 'tags', label: 'Tags', current: cTags, target: tTags, changed: cTags !== tTags });
    return results;
  }

  const PLACEHOLDER_VALUES = ['sytem prompt', 'system prompt', 'post history', 'post_history_instructions'];

  function isPlaceholder(value: string | undefined): boolean {
    if (!value || !value.trim()) return false;
    return PLACEHOLDER_VALUES.some(p => value.trim().toLowerCase() === p);
  }

  function displayValue(value: string | undefined): string {
    if (!value || !value.trim() || isPlaceholder(value)) return '';
    return value;
  }

  // Inline edit helpers
  function startFieldEdit(field: string, value: string) {
    editingField = field;
    editFieldValue = isPlaceholder(value) ? '' : (value ?? '');
  }

  function cancelFieldEdit() {
    editingField = null;
    editFieldValue = '';
  }

  let savingField = $state(false);

  async function saveFieldEdit() {
    if (!editingField) return;
    savingField = true;
    error = '';
    try {
      const result = await updateIdentityField(editingField, editFieldValue);
      if (result.ok) {
        // Refresh the identity data to show updated values
        data = await getIdentity();
        editingField = null;
        editFieldValue = '';
        pushToast('Field saved', 'success');
      } else {
        error = result.message || 'Failed to save field';
        pushToast(error, 'error');
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to save field';
      pushToast(error, 'error');
    } finally {
      savingField = false;
    }
  }

  // Alternate greetings editing
  let editingGreetingIndex = $state<number | null>(null);
  let editGreetingValue = $state('');
  let savingGreeting = $state(false);

  function startGreetingEdit(index: number, value: string) {
    editingGreetingIndex = index;
    editGreetingValue = value;
  }

  function cancelGreetingEdit() {
    editingGreetingIndex = null;
    editGreetingValue = '';
  }

  async function saveGreetingEdit() {
    if (editingGreetingIndex === null) return;
    savingGreeting = true;
    error = '';
    try {
      const nextGreetings = [...alternateGreetings];
      nextGreetings[editingGreetingIndex] = editGreetingValue.trim();
      const cleaned = nextGreetings.filter((entry) => entry.length > 0);
      const result = await updateIdentityField('alternate_greetings', JSON.stringify(cleaned));
      if (result.ok) {
        data = await getIdentity();
        cancelGreetingEdit();
        pushToast('Greeting updated', 'success');
      } else {
        error = result.message || 'Failed to save greeting';
        pushToast(error, 'error');
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to save greeting';
      pushToast(error, 'error');
    } finally {
      savingGreeting = false;
    }
  }

  function addGreeting() {
    editingGreetingIndex = alternateGreetings.length;
    editGreetingValue = '';
  }

  async function removeGreeting(index: number) {
    savingGreeting = true;
    error = '';
    try {
      const nextGreetings = alternateGreetings.filter((_entry, i) => i !== index);
      const result = await updateIdentityField('alternate_greetings', JSON.stringify(nextGreetings));
      if (result.ok) {
        data = await getIdentity();
        if (editingGreetingIndex === index) {
          cancelGreetingEdit();
        }
        pushToast('Greeting removed', 'success');
      } else {
        error = result.message || 'Failed to remove greeting';
        pushToast(error, 'error');
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to remove greeting';
      pushToast(error, 'error');
    } finally {
      savingGreeting = false;
    }
  }

  // Appearance (extensions.visual_description) editing
  let editingAppearance = $state(false);
  let editAppearanceValue = $state('');
  let savingAppearance = $state(false);

  function startAppearanceEdit() {
    editingAppearance = true;
    editAppearanceValue = appearanceValue;
  }

  function cancelAppearanceEdit() {
    editingAppearance = false;
    editAppearanceValue = '';
  }

  async function saveAppearanceEdit() {
    savingAppearance = true;
    error = '';
    try {
      const result = await updateIdentityField('extensions.visual_description', editAppearanceValue);
      if (result.ok) {
        data = await getIdentity();
        cancelAppearanceEdit();
        pushToast('Appearance saved', 'success');
      } else {
        error = result.message || 'Failed to save appearance';
        pushToast(error, 'error');
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to save appearance';
      pushToast(error, 'error');
    } finally {
      savingAppearance = false;
    }
  }

  let card = $derived(data?.card ?? null);
  let cardData = $derived(card?.data ?? null);
  let appearanceValue = $derived(
    cardData?.extensions?.visual_description
      ? String(cardData.extensions.visual_description)
      : ''
  );
  let alternateGreetings = $derived(
    (cardData?.alternate_greetings as string[] | undefined) ?? []
  );

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

  // Runtime config fields to display
  function getConfigFields(config: Record<string, unknown>): Array<{ label: string; value: string }> {
    const fields: Array<{ label: string; value: string }> = [];
    const map: Array<[string, string]> = [
      ['primaryModel', 'Primary Model'],
      ['extractionModel', 'Extraction Model'],
      ['discordBotId', 'Discord Bot ID'],
      ['dataDir', 'Data Dir'],
      ['characterCardPath', 'Character Card Path'],
      ['sessionHistoryBudgetPct', 'Session History Budget %'],
      ['sessionMessageLimit', 'Session Message Hard Override'],
      ['memoryBudgetPct', 'Memory Retrieval Budget %'],
      ['memoryRetrievalLimit', 'Memory Retrieval Hard Override'],
    ];
    for (const [key, label] of map) {
      const val = config?.[key];
      if (val !== undefined && val !== null) {
        fields.push({ label, value: String(val) });
      } else if (key === 'sessionMessageLimit' || key === 'memoryRetrievalLimit') {
        fields.push({ label, value: 'auto' });
      }
    }
    return fields;
  }
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">The Seeds</h1>
      <p class="text-sm text-shadow-600 mt-1">Character identity and card data</p>
    </div>
    {#if data}
      <div class="flex items-center gap-2">
        <button
          onclick={exportAsJson}
          class="flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg border border-bark-300 text-shadow-700 hover:bg-bark-100 hover:border-gold-300 transition-colors"
          title="Export character card as JSON"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
          </svg>
          Export
        </button>
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
      </div>
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
            {card.spec ?? ''} {card.spec_version ?? ''}
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
              <span class="text-2xl font-serif font-bold text-gold-700">{(cardData.name ?? '?')[0]}</span>
            </div>
            <div class="min-w-0">
              <h2 class="text-xl font-serif font-bold text-shadow-900">{cardData.name ?? 'Unknown'}</h2>
              <div class="flex flex-wrap items-center gap-2 mt-1">
                <span class="inline-flex items-center px-2 py-0.5 rounded-full text-sm font-medium bg-gold-50 text-gold-700 border border-gold-300">
                  v{data.version ?? 1}
                </span>
                <span class="text-sm text-shadow-600">
                  {card.spec ?? ''} {card.spec_version ?? ''}
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

        <!-- Metadata section (collapsible) -->
        <div class="card-garden overflow-hidden">
          <button
            class="w-full flex items-center justify-between p-5 text-left hover:bg-bark-50 transition-colors"
            onclick={() => showMetadata = !showMetadata}
          >
            <h3 class="text-sm font-medium text-shadow-700 uppercase tracking-wider">Metadata</h3>
            <div class="flex items-center gap-3">
              <span class="text-sm text-shadow-600">
                {cardData.creator ? `by ${cardData.creator}` : ''}
                {cardData.character_version ? ` (${cardData.character_version})` : ''}
                {cardData.tags && cardData.tags.length > 0 ? ` | ${cardData.tags.length} tags` : ''}
              </span>
              <svg class="w-4 h-4 text-shadow-600 transition-transform {showMetadata ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </button>
          {#if showMetadata}
            <div class="border-t border-bark-300 p-5 space-y-4">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <p class="text-sm font-medium text-shadow-700 mb-1">Creator</p>
                  <p class="text-sm text-shadow-800">{cardData.creator || '(not set)'}</p>
                </div>
                <div>
                  <p class="text-sm font-medium text-shadow-700 mb-1">Character Version</p>
                  <p class="text-sm text-shadow-800">{cardData.character_version || '(not set)'}</p>
                </div>
                <div>
                  <p class="text-sm font-medium text-shadow-700 mb-1">Spec</p>
                  <p class="text-sm text-shadow-800 font-mono">{card.spec ?? ''} {card.spec_version ?? ''}</p>
                </div>
                <div>
                  <p class="text-sm font-medium text-shadow-700 mb-1">Card Version</p>
                  <p class="text-sm text-shadow-800">v{data.version ?? 1}
                    {#if data.checksum}
                      <span class="text-shadow-600 font-mono ml-1">({data.checksum.slice(0, 12)})</span>
                    {/if}
                  </p>
                </div>
              </div>

              {#if cardData.tags && cardData.tags.length > 0}
                <div>
                  <p class="text-sm font-medium text-shadow-700 mb-2">Tags</p>
                  <div class="flex flex-wrap gap-2">
                    {#each cardData.tags as tag}
                      <span class="px-3 py-1 rounded-full text-sm font-medium bg-bark-200 text-shadow-800 border border-bark-300">{tag}</span>
                    {/each}
                  </div>
                </div>
              {/if}

              {#if cardData.creator_notes && cardData.creator_notes.trim()}
                <div>
                  <p class="text-sm font-medium text-shadow-700 mb-2">Creator Notes</p>
                  <div class="text-sm text-shadow-800 whitespace-pre-wrap leading-relaxed bg-bark-100 p-3 rounded-lg max-h-48 overflow-y-auto">{cardData.creator_notes}</div>
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <!-- Import card -->
        <div class="card-garden p-5">
          <h3 class="text-sm font-serif font-semibold text-shadow-800 mb-3">Import Character Card</h3>
          <p class="text-sm text-shadow-600 mb-3">Import from JSON, PNG, or CharX using a local filesystem path, or upload a JSON card file.</p>
          <form onsubmit={(e) => { e.preventDefault(); openImportConfirmation(); }} class="flex gap-2">
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

          <div class="my-4 border-t border-bark-300"></div>

          <form
            onsubmit={(e) => {
              e.preventDefault();
              if (!uploadFile) return;
              runUpload(uploadFile);
            }}
            class="space-y-2"
          >
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                bind:this={uploadInput}
                type="file"
                accept=".json,application/json"
                onchange={onUploadFileChange}
                class="block w-full text-sm text-shadow-700 file:mr-3 file:rounded-lg file:border file:border-bark-300 file:bg-bark-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-shadow-800 hover:file:bg-bark-200"
              />
              <button
                type="submit"
                disabled={uploading || !uploadFile}
                class="px-4 py-2 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                {uploading ? 'Uploading...' : 'Upload & Import'}
              </button>
              <button
                type="button"
                disabled={uploading || !uploadFile}
                onclick={clearUploadSelection}
                class="px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-700 text-sm hover:bg-bark-100 disabled:opacity-50 transition-colors"
              >
                Clear
              </button>
            </div>
          </form>
          {#if uploadMessage}
            <p class="mt-2 text-sm {uploadSuccess ? 'text-moss-600' : 'text-wilt-600'}">{uploadMessage}</p>
          {/if}
        </div>

        <!-- Appearance (extensions.visual_description) -->
        <div class="card-garden p-5">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-medium text-shadow-700 uppercase tracking-wider">Appearance</h3>
            {#if editingAppearance}
              <div class="flex gap-1.5">
                <button
                  onclick={saveAppearanceEdit}
                  disabled={savingAppearance}
                  class="px-2.5 py-1 text-sm font-medium rounded bg-gold-600 text-white hover:bg-gold-700 disabled:opacity-50 transition-colors"
                >
                  {savingAppearance ? 'Saving...' : 'Save'}
                </button>
                <button
                  onclick={cancelAppearanceEdit}
                  data-esc-close
                  disabled={savingAppearance}
                  class="px-2.5 py-1 text-sm font-medium rounded text-shadow-700 hover:bg-bark-200 disabled:opacity-50 transition-colors border border-bark-300"
                >
                  Cancel
                </button>
              </div>
            {:else}
              <button onclick={startAppearanceEdit}
                class="text-sm text-gold-700 hover:text-gold-600 transition-colors font-medium">
                Edit
              </button>
            {/if}
          </div>
          {#if editingAppearance}
            <textarea
              bind:value={editAppearanceValue}
              rows={4}
              class="w-full px-3 py-2 rounded-lg border border-gold-300 bg-white text-shadow-900 text-sm resize-y
                     focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
            ></textarea>
          {:else if appearanceValue}
            <div class="text-sm text-shadow-800 whitespace-pre-wrap leading-relaxed">{appearanceValue}</div>
          {:else}
            <p class="text-sm text-shadow-500 italic">No visual description set in extensions</p>
          {/if}
        </div>

        <!-- Card fields -- each is click-to-edit -->
        {#each CARD_FIELDS as field}
          {@const rawValue = cardData[field.key] as string | undefined}
          {@const value = displayValue(rawValue)}
          <div class="card-garden p-5">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-medium text-shadow-700 uppercase tracking-wider">{field.label}</h3>
              {#if editingField === field.key}
                <div class="flex gap-1.5">
                  <button onclick={saveFieldEdit}
                    disabled={savingField}
                    class="px-2.5 py-1 text-sm font-medium rounded bg-gold-600 text-white hover:bg-gold-700 disabled:opacity-50 transition-colors">
                    {savingField ? 'Saving...' : 'Save'}
                  </button>
                  <button onclick={cancelFieldEdit}
                    data-esc-close
                    disabled={savingField}
                    class="px-2.5 py-1 text-sm font-medium rounded text-shadow-700 hover:bg-bark-200 disabled:opacity-50 transition-colors border border-bark-300">
                    Cancel
                  </button>
                </div>
              {:else}
                <button onclick={() => startFieldEdit(field.key, rawValue ?? '')}
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
            {:else if value}
              {#if field.mono}
                <pre class="text-sm font-mono text-shadow-800 whitespace-pre-wrap leading-relaxed bg-bark-100 p-3 rounded-lg max-h-64 overflow-y-auto">{value}</pre>
              {:else}
                <div class="text-sm text-shadow-800 whitespace-pre-wrap leading-relaxed">{value}</div>
              {/if}
            {:else}
              <p class="text-sm text-shadow-500 italic">Not set -- click Edit to add content</p>
            {/if}
          </div>
        {/each}

        <!-- Alternate Greetings -->
        <div class="card-garden overflow-hidden">
          <div class="w-full flex items-center justify-between p-5 hover:bg-bark-50 transition-colors">
            <button
              class="flex-1 flex items-center justify-between text-left"
              onclick={() => showAlternateGreetings = !showAlternateGreetings}
            >
              <h3 class="text-sm font-medium text-shadow-700 uppercase tracking-wider">
                Alternate Greetings
                <span class="text-shadow-500 font-normal normal-case ml-1">({alternateGreetings.length})</span>
              </h3>
              <svg class="w-4 h-4 text-shadow-600 transition-transform {showAlternateGreetings ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {#if showAlternateGreetings}
              <button
                onclick={addGreeting}
                class="ml-3 text-sm text-gold-700 hover:text-gold-600 transition-colors font-medium"
              >
                Add
              </button>
            {/if}
          </div>
          {#if showAlternateGreetings}
            <div class="border-t border-bark-300 p-5 space-y-3">
              {#if alternateGreetings.length > 0 || editingGreetingIndex === alternateGreetings.length}
                {#each alternateGreetings as greeting, i}
                  <div>
                    <div class="flex items-center justify-between mb-1">
                      <p class="text-sm font-medium text-shadow-700">Greeting {i + 1}</p>
                      {#if editingGreetingIndex !== i}
                        <div class="flex gap-2">
                          <button
                            onclick={() => startGreetingEdit(i, greeting)}
                            class="text-sm text-gold-700 hover:text-gold-600 transition-colors font-medium"
                          >
                            Edit
                          </button>
                          <button
                            onclick={() => removeGreeting(i)}
                            disabled={savingGreeting}
                            class="text-sm text-wilt-600 hover:text-wilt-700 transition-colors font-medium disabled:opacity-50"
                          >
                            Remove
                          </button>
                        </div>
                      {/if}
                    </div>
                    {#if editingGreetingIndex === i}
                      <textarea
                        bind:value={editGreetingValue}
                        rows={4}
                        class="w-full px-3 py-2 rounded-lg border border-gold-300 bg-white text-shadow-900 text-sm resize-y
                               focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                      ></textarea>
                      <div class="flex gap-1.5 mt-2">
                        <button onclick={saveGreetingEdit}
                          disabled={savingGreeting}
                          class="px-2.5 py-1 text-sm font-medium rounded bg-gold-600 text-white hover:bg-gold-700 disabled:opacity-50 transition-colors">
                          {savingGreeting ? 'Saving...' : 'Save'}
                        </button>
                        <button onclick={cancelGreetingEdit}
                          data-esc-close
                          disabled={savingGreeting}
                          class="px-2.5 py-1 text-sm font-medium rounded text-shadow-700 hover:bg-bark-200 transition-colors border border-bark-300">
                          Cancel
                        </button>
                      </div>
                    {:else}
                      <div class="text-sm text-shadow-800 whitespace-pre-wrap leading-relaxed bg-bark-100 p-3 rounded-lg">{greeting}</div>
                    {/if}
                  </div>
                {/each}
                {#if editingGreetingIndex === alternateGreetings.length}
                  <div>
                    <div class="flex items-center justify-between mb-1">
                      <p class="text-sm font-medium text-shadow-700">Greeting {alternateGreetings.length + 1}</p>
                    </div>
                    <textarea
                      bind:value={editGreetingValue}
                      rows={4}
                      class="w-full px-3 py-2 rounded-lg border border-gold-300 bg-white text-shadow-900 text-sm resize-y
                             focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                    ></textarea>
                    <div class="flex gap-1.5 mt-2">
                      <button onclick={saveGreetingEdit}
                        disabled={savingGreeting}
                        class="px-2.5 py-1 text-sm font-medium rounded bg-gold-600 text-white hover:bg-gold-700 disabled:opacity-50 transition-colors">
                        {savingGreeting ? 'Saving...' : 'Save'}
                      </button>
                      <button onclick={cancelGreetingEdit}
                        data-esc-close
                        disabled={savingGreeting}
                        class="px-2.5 py-1 text-sm font-medium rounded text-shadow-700 hover:bg-bark-200 transition-colors border border-bark-300">
                        Cancel
                      </button>
                    </div>
                  </div>
                {/if}
              {:else}
                <p class="text-sm text-shadow-500 italic">No alternate greetings defined</p>
              {/if}
            </div>
          {/if}
        </div>

        <!-- Extensions (collapsible) -->
        {#if cardData.extensions && Object.keys(cardData.extensions).length > 0}
          <div class="card-garden overflow-hidden">
            <button
              class="w-full flex items-center justify-between p-5 text-left hover:bg-bark-50 transition-colors"
              onclick={() => showExtensions = !showExtensions}
            >
              <h3 class="text-sm font-medium text-shadow-700 uppercase tracking-wider">Extensions</h3>
              <svg class="w-4 h-4 text-shadow-600 transition-transform {showExtensions ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {#if showExtensions}
              <div class="border-t border-bark-300 p-5">
                <pre class="text-sm font-mono text-shadow-800 whitespace-pre-wrap bg-bark-100 p-3 rounded-lg max-h-64 overflow-y-auto">{JSON.stringify(cardData.extensions, null, 2)}</pre>
              </div>
            {/if}
          </div>
        {/if}

        <!-- Runtime Configuration -->
        {#if data.config}
          <div class="card-garden overflow-hidden">
            <button
              class="w-full flex items-center justify-between p-5 text-left hover:bg-bark-50 transition-colors"
              onclick={() => showRuntimeConfig = !showRuntimeConfig}
            >
              <h3 class="text-sm font-medium text-shadow-700 uppercase tracking-wider">Runtime Configuration</h3>
              <svg class="w-4 h-4 text-shadow-600 transition-transform {showRuntimeConfig ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {#if showRuntimeConfig}
              <div class="border-t border-bark-300 p-5">
                <div class="overflow-x-auto">
                  <table class="w-full text-sm">
                    <thead>
                      <tr class="border-b border-bark-300">
                        <th class="text-left px-3 py-2 text-shadow-700 font-medium">Setting</th>
                        <th class="text-left px-3 py-2 text-shadow-700 font-medium">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each getConfigFields(data.config) as cf}
                        <tr class="border-b border-bark-200 hover:bg-bark-50 transition-colors">
                          <td class="px-3 py-2 text-shadow-700 font-medium">{cf.label}</td>
                          <td class="px-3 py-2 text-shadow-800 font-mono">{cf.value}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              </div>
            {/if}
          </div>
        {/if}

        <!-- Version History -->
        {#if data.history && data.history.length > 0}
          <div class="card-garden overflow-hidden">
            <button
              class="w-full flex items-center justify-between p-5 text-left hover:bg-bark-50 transition-colors"
              onclick={() => showVersionHistory = !showVersionHistory}
            >
              <div>
                <h3 class="text-sm font-medium text-shadow-700 uppercase tracking-wider">Version History</h3>
                <p class="text-sm text-shadow-600 mt-0.5">
                  Current: <span class="font-medium text-shadow-800">v{data.version ?? 1}</span>
                  <span class="mx-1 text-shadow-500">|</span>
                  {data.history.length} version{data.history.length === 1 ? '' : 's'} recorded
                </p>
              </div>
              <svg class="w-4 h-4 text-shadow-600 transition-transform {showVersionHistory ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {#if showVersionHistory}
            <div class="border-t border-bark-300">
            {#if rollbackMessage}
              <div class="mx-5 mt-3 mb-3 px-3 py-2 rounded-lg bg-moss-50 text-sm text-moss-600 border border-moss-200">{rollbackMessage}</div>
            {/if}

            <!-- Version history table -->
            <div class="px-5 pb-5 pt-3">
              <div class="overflow-x-auto border border-bark-300 rounded-lg">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="bg-bark-100 border-b border-bark-300">
                      <th class="text-left px-3 py-2.5 text-shadow-700 font-medium">Version</th>
                      <th class="text-left px-3 py-2.5 text-shadow-700 font-medium">Changed By</th>
                      <th class="text-left px-3 py-2.5 text-shadow-700 font-medium">Timestamp</th>
                      <th class="text-left px-3 py-2.5 text-shadow-700 font-medium">Previous Checksum</th>
                      <th class="text-left px-3 py-2.5 text-shadow-700 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each [...data.history].reverse().slice(0, 20) as entry (entry.version)}
                      {@const isCurrent = entry.version === (data.version ?? 1) - 1}
                      <tr class="border-b border-bark-200 hover:bg-bark-50 transition-colors {isCurrent ? 'bg-gold-50' : ''}">
                        <td class="px-3 py-2 font-mono text-shadow-800 font-medium">
                          v{entry.version} &rarr; v{entry.version + 1}
                        </td>
                        <td class="px-3 py-2 text-shadow-700">{entry.updatedBy ?? entry.changedBy ?? 'unknown'}</td>
                        <td class="px-3 py-2 text-shadow-700">{entry.timestamp ? new Date(entry.timestamp).toLocaleString() : 'unknown'}</td>
                        <td class="px-3 py-2">
                          <code class="font-mono text-shadow-600 text-sm">{(entry.previousChecksum ?? entry.checksum ?? 'n/a').slice(0, 12)}</code>
                        </td>
                        <td class="px-3 py-2">
                          <div class="flex gap-1.5">
                            <button
                              onclick={() => handleShowDiff(entry.version)}
                              class="px-2.5 py-1 text-sm font-medium rounded border border-bark-300 text-shadow-700 hover:bg-bark-200 hover:border-gold-300 transition-colors"
                            >
                              {diffVersion === entry.version ? 'Hide' : 'Diff'}
                            </button>
                            <button
                              onclick={() => openRollbackConfirmation(entry.version)}
                              disabled={rollingBack === entry.version}
                              class="px-2.5 py-1 text-sm font-medium rounded border border-wilt-200 text-wilt-600 hover:bg-wilt-50 transition-colors disabled:opacity-50"
                            >
                              {rollingBack === entry.version ? '...' : 'Restore'}
                            </button>
                          </div>
                        </td>
                      </tr>

                      <!-- Inline diff panel -->
                      {#if diffVersion === entry.version}
                        <tr>
                          <td colspan="5" class="p-0">
                            <div class="p-4 border-t border-bark-200 bg-bark-50">
                              {#if diffLoading}
                                <div class="animate-pulse space-y-2">
                                  <div class="h-4 bg-bark-200 rounded w-1/3"></div>
                                  <div class="h-4 bg-bark-200 rounded w-2/3"></div>
                                </div>
                              {:else if diffData && diffData.ok}
                                {@const allFields = buildCardDiff(diffData.current, diffData.target)}
                                <p class="text-sm text-shadow-700 mb-3">
                                  Comparing <span class="font-medium text-shadow-900">current (v{data.version})</span>
                                  with <span class="font-medium text-shadow-900">v{entry.version}</span>
                                  {#if allFields.every(f => !f.changed)}
                                    <span class="text-shadow-600 ml-1">(no differences)</span>
                                  {/if}
                                </p>

                                <!-- Side-by-side diff table for ALL fields -->
                                <div class="overflow-x-auto border border-bark-300 rounded-lg">
                                  <table class="w-full text-sm">
                                    <thead>
                                      <tr class="bg-bark-100 border-b border-bark-300">
                                        <th class="text-left px-3 py-2 text-shadow-700 font-medium w-36">Field</th>
                                        <th class="text-left px-3 py-2 text-shadow-700 font-medium">Current</th>
                                        <th class="text-left px-3 py-2 text-shadow-700 font-medium">v{entry.version}</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {#each allFields as fd}
                                        <tr class="border-b border-bark-200 {fd.changed ? '' : ''}">
                                          <td class="px-3 py-2 font-medium text-shadow-800 align-top">{fd.label}</td>
                                          <td
                                            class="px-3 py-2 align-top font-mono text-sm whitespace-pre-wrap max-w-xs overflow-hidden"
                                            style={fd.changed ? 'background-color: #FFF9E6; border-left: 3px solid #E8C766;' : ''}
                                          >
                                            <div class="max-h-32 overflow-y-auto text-shadow-800">{fd.current || '(empty)'}</div>
                                          </td>
                                          <td
                                            class="px-3 py-2 align-top font-mono text-sm whitespace-pre-wrap max-w-xs overflow-hidden"
                                            style={fd.changed ? 'background-color: #FFF9E6; border-left: 3px solid #E8C766;' : ''}
                                          >
                                            <div class="max-h-32 overflow-y-auto text-shadow-800">{fd.target || '(empty)'}</div>
                                          </td>
                                        </tr>
                                      {/each}
                                    </tbody>
                                  </table>
                                </div>
                              {:else}
                                <p class="text-sm text-shadow-600">Unable to load diff for this version.</p>
                              {/if}
                            </div>
                          </td>
                        </tr>
                      {/if}
                    {/each}
                  </tbody>
                </table>
              </div>
            </div>
            </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  {/if}

  {#if pendingConfirmation && confirmationContent}
    <ConfirmationModal
      open={true}
      title={confirmationContent.title}
      body={confirmationContent.body}
      context={confirmationContent.context}
      confirmLabel={confirmationContent.confirmLabel}
      cancelLabel={confirmationContent.cancelLabel}
      tone={confirmationContent.tone}
      onCancel={cancelConfirmation}
      onConfirm={() => { void confirmPendingAction(); }}
    />
  {/if}
</div>
