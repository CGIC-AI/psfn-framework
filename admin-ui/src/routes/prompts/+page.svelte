<script lang="ts">
  import { onMount } from 'svelte';
  import { listPrompts, getPrompt, updatePrompt, togglePrompt, rollbackPrompt, diffPrompt } from '$lib/api/endpoints/prompts';
  import type { PromptLayer, PromptRegistryEntry, AdminPromptDetailData } from '$lib/types';

  let layers = $state<PromptLayer[]>([]);
  let staticPrompts = $state<PromptRegistryEntry[]>([]);
  let loading = $state(true);
  let error = $state('');

  // Detail view
  let selectedLayerId = $state<string | null>(null);
  let detailData = $state<AdminPromptDetailData | null>(null);
  let detailLoading = $state(false);

  // Content editing
  let editingContent = $state(false);
  let editContent = $state('');
  let savingContent = $state(false);

  // Metadata editing
  let editingMeta = $state(false);
  let editName = $state('');
  let editPriority = $state(0);
  let editRole = $state<string>('');
  let savingMeta = $state(false);

  // Rollback
  let rollingBack = $state(false);

  // Diff
  let showDiff = $state(false);
  let diffOld = $state('');
  let diffNew = $state('');
  let diffLoading = $state(false);

  const LAYER_BADGE: Record<string, string> = {
    base:     'bg-shadow-600 text-white',
    operator: 'bg-wilt-600 text-white',
    runtime:  'bg-moss-600 text-white',
    channel:  'bg-gold-600 text-white',
    task:     'bg-petal-600 text-white',
  };

  onMount(async () => {
    try {
      const data = await listPrompts();
      layers = data.layers;
      staticPrompts = data.staticPrompts;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load prompts';
    } finally {
      loading = false;
    }
  });

  async function refreshList() {
    const data = await listPrompts();
    layers = data.layers;
    staticPrompts = data.staticPrompts;
  }

  async function selectLayer(layerId: string) {
    if (selectedLayerId === layerId) {
      selectedLayerId = null;
      detailData = null;
      editingContent = false;
      editingMeta = false;
      showDiff = false;
      return;
    }
    selectedLayerId = layerId;
    detailLoading = true;
    editingContent = false;
    editingMeta = false;
    showDiff = false;
    try {
      detailData = await getPrompt(layerId);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load layer detail';
      selectedLayerId = null;
    } finally {
      detailLoading = false;
    }
  }

  async function handleToggle(layerId: string) {
    try {
      await togglePrompt(layerId);
      await refreshList();
      // Refresh detail if currently viewing this layer
      if (selectedLayerId === layerId && detailData?.layer) {
        detailData = await getPrompt(layerId);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to toggle layer';
    }
  }

  function startEditContent(layer: PromptLayer) {
    editContent = layer.content;
    editingContent = true;
  }

  async function saveContent(layerId: string) {
    savingContent = true;
    try {
      await updatePrompt(layerId, { content: editContent });
      await refreshList();
      detailData = await getPrompt(layerId);
      editingContent = false;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to save content';
    } finally {
      savingContent = false;
    }
  }

  function startEditMeta(layer: PromptLayer) {
    editName = layer.name;
    editPriority = layer.priority;
    editRole = layer.role ?? 'system';
    editingMeta = true;
  }

  async function saveMeta(layerId: string) {
    savingMeta = true;
    try {
      const patch: Record<string, unknown> = {};
      const layer = detailData?.layer;
      if (layer) {
        if (editName !== layer.name) patch.name = editName;
        if (editPriority !== layer.priority) patch.priority = editPriority;
        if (editRole !== (layer.role ?? 'system')) patch.role = editRole;
      }
      if (Object.keys(patch).length > 0) {
        await updatePrompt(layerId, patch);
        await refreshList();
        detailData = await getPrompt(layerId);
      }
      editingMeta = false;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to save metadata';
    } finally {
      savingMeta = false;
    }
  }

  async function handleRollback(layerId: string, version: number) {
    if (!confirm(`Roll back layer to version ${version}?`)) return;
    rollingBack = true;
    try {
      await rollbackPrompt(layerId, version);
      await refreshList();
      detailData = await getPrompt(layerId);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to rollback';
    } finally {
      rollingBack = false;
    }
  }

  async function loadDiff(layerId: string) {
    if (showDiff) {
      showDiff = false;
      return;
    }
    diffLoading = true;
    try {
      const result = await diffPrompt(layerId);
      diffOld = result.oldContent;
      diffNew = result.newContent;
      showDiff = true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'No previous version to diff';
    } finally {
      diffLoading = false;
    }
  }

  function isProtected(layer: PromptLayer): boolean {
    return layer.type === 'base' || layer.type === 'operator';
  }
</script>

<div class="space-y-4">
  <div>
    <h1 class="text-2xl font-serif font-bold text-shadow-800 dark:text-bark-200">The Soil</h1>
    <p class="text-sm text-shadow-400 dark:text-shadow-500 mt-1">Layered prompt stack -- {layers.length} layers</p>
  </div>

  {#if error}
    <div class="card-garden p-4 text-wilt-600 dark:text-wilt-400 text-sm">
      {error}
      <button onclick={() => error = ''} class="ml-2 text-shadow-400 hover:text-shadow-600 dark:text-shadow-500 dark:hover:text-shadow-300">&times;</button>
    </div>
  {/if}

  {#if loading}
    <div class="space-y-2">
      {#each Array(5) as _}
        <div class="card-garden p-4 animate-pulse h-16"></div>
      {/each}
    </div>
  {:else}
    <!-- Dynamic layers -->
    <div class="space-y-2">
      {#each layers as layer (layer.id)}
        <div class="card-garden overflow-hidden {!layer.enabled ? 'opacity-50' : ''} {selectedLayerId === layer.id ? 'filigree-border-strong ring-1 ring-gold-300' : ''}">
          <!-- Layer header row -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-bark-50 dark:hover:bg-shadow-800/50 transition-colors cursor-pointer"
            onclick={() => selectLayer(layer.id)}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectLayer(layer.id); }}}
            role="button"
            tabindex="0"
          >
            <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide {LAYER_BADGE[layer.type] || 'bg-bark-300 text-bark-700'}">
              {layer.type}
            </span>
            <span class="flex-1 text-sm font-medium text-shadow-700 dark:text-bark-300">{layer.name}</span>
            {#if layer.identifier}
              <span class="text-[11px] font-mono text-shadow-300 dark:text-shadow-600">{layer.identifier}</span>
            {/if}
            <span class="text-[11px] text-shadow-400 dark:text-shadow-500">p{layer.priority}</span>
            {#if !isProtected(layer)}
              <button
                onclick={(e) => { e.stopPropagation(); handleToggle(layer.id); }}
                class="px-2 py-1 text-[11px] rounded {layer.enabled ? 'text-moss-600 dark:text-moss-400 hover:bg-moss-50 dark:hover:bg-moss-900/20' : 'text-wilt-500 dark:text-wilt-400 hover:bg-wilt-50 dark:hover:bg-wilt-900/20'} transition-colors"
              >
                {layer.enabled ? 'ON' : 'OFF'}
              </button>
            {:else}
              <svg class="w-4 h-4 text-shadow-300 dark:text-shadow-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            {/if}
          </div>

          <!-- Detail panel -->
          {#if selectedLayerId === layer.id}
            <div class="border-t border-bark-100 dark:border-shadow-800">
              {#if detailLoading}
                <div class="p-4 animate-pulse space-y-3">
                  <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded w-1/3"></div>
                  <div class="h-20 bg-bark-200 dark:bg-shadow-700 rounded"></div>
                </div>
              {:else if detailData?.layer}
                {@const dl = detailData.layer}
                <div class="p-4 space-y-4">
                  <!-- Metadata section -->
                  <div>
                    <div class="flex items-center justify-between mb-2">
                      <span class="text-[11px] font-medium text-shadow-400 dark:text-shadow-500 uppercase tracking-wider">Metadata</span>
                      {#if !isProtected(dl) && !editingMeta}
                        <button
                          onclick={() => startEditMeta(dl)}
                          class="text-[11px] text-gold-600 dark:text-gold-400 hover:underline"
                        >
                          Edit
                        </button>
                      {/if}
                    </div>
                    {#if editingMeta}
                      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div>
                          <label for="edit-layer-name" class="block text-xs text-shadow-500 dark:text-shadow-400 mb-1">Name</label>
                          <input
                            id="edit-layer-name"
                            type="text"
                            bind:value={editName}
                            class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm
                              focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                          />
                        </div>
                        <div>
                          <label for="edit-layer-priority" class="block text-xs text-shadow-500 dark:text-shadow-400 mb-1">Priority</label>
                          <input
                            id="edit-layer-priority"
                            type="number"
                            bind:value={editPriority}
                            class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm
                              focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                          />
                        </div>
                        <div>
                          <label for="edit-layer-role" class="block text-xs text-shadow-500 dark:text-shadow-400 mb-1">Role</label>
                          <select
                            id="edit-layer-role"
                            bind:value={editRole}
                            class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm
                              focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                          >
                            <option value="system">system</option>
                            <option value="user">user</option>
                            <option value="assistant">assistant</option>
                          </select>
                        </div>
                      </div>
                      <div class="flex gap-2 mt-3">
                        <button
                          onclick={() => saveMeta(dl.id)}
                          disabled={savingMeta}
                          class="px-3 py-1.5 rounded-lg bg-gold-600 text-white text-xs font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors"
                        >
                          {savingMeta ? 'Saving...' : 'Save'}
                        </button>
                        <button
                          onclick={() => editingMeta = false}
                          class="px-3 py-1.5 rounded-lg text-shadow-500 dark:text-shadow-400 text-xs hover:bg-bark-100 dark:hover:bg-shadow-800 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    {:else}
                      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                        <div>
                          <span class="text-shadow-400 dark:text-shadow-500">Type</span>
                          <p class="text-shadow-700 dark:text-bark-300 mt-0.5 capitalize">{dl.type}</p>
                        </div>
                        <div>
                          <span class="text-shadow-400 dark:text-shadow-500">Priority</span>
                          <p class="text-shadow-700 dark:text-bark-300 mt-0.5">{dl.priority}</p>
                        </div>
                        <div>
                          <span class="text-shadow-400 dark:text-shadow-500">Role</span>
                          <p class="text-shadow-700 dark:text-bark-300 mt-0.5">{dl.role ?? 'system'}</p>
                        </div>
                        <div>
                          <span class="text-shadow-400 dark:text-shadow-500">Version</span>
                          <p class="text-shadow-700 dark:text-bark-300 mt-0.5">v{dl.version}</p>
                        </div>
                        <div>
                          <span class="text-shadow-400 dark:text-shadow-500">Updated</span>
                          <p class="text-shadow-700 dark:text-bark-300 mt-0.5">{new Date(dl.updatedAt).toLocaleString()}</p>
                        </div>
                        <div>
                          <span class="text-shadow-400 dark:text-shadow-500">By</span>
                          <p class="text-shadow-700 dark:text-bark-300 mt-0.5">{dl.updatedBy}</p>
                        </div>
                        <div>
                          <span class="text-shadow-400 dark:text-shadow-500">Checksum</span>
                          <p class="font-mono text-shadow-500 dark:text-shadow-400 mt-0.5">{dl.checksum.slice(0, 12)}</p>
                        </div>
                        <div>
                          <span class="text-shadow-400 dark:text-shadow-500">Enabled</span>
                          <p class="mt-0.5 {dl.enabled ? 'text-moss-600 dark:text-moss-400' : 'text-wilt-500 dark:text-wilt-400'}">{dl.enabled ? 'Yes' : 'No'}</p>
                        </div>
                      </div>
                    {/if}
                  </div>

                  <!-- Content section -->
                  <div>
                    <div class="flex items-center justify-between mb-2">
                      <span class="text-[11px] font-medium text-shadow-400 dark:text-shadow-500 uppercase tracking-wider">Content</span>
                      <div class="flex gap-2">
                        {#if dl.version > 1}
                          <button
                            onclick={() => loadDiff(dl.id)}
                            disabled={diffLoading}
                            class="text-[11px] text-shadow-500 dark:text-shadow-400 hover:text-gold-600 dark:hover:text-gold-400 transition-colors"
                          >
                            {diffLoading ? 'Loading...' : showDiff ? 'Hide Diff' : 'Diff'}
                          </button>
                        {/if}
                        {#if !isProtected(dl) && !editingContent}
                          <button
                            onclick={() => startEditContent(dl)}
                            class="text-[11px] text-gold-600 dark:text-gold-400 hover:underline"
                          >
                            Edit
                          </button>
                        {/if}
                      </div>
                    </div>

                    {#if showDiff}
                      <div class="grid grid-cols-1 md:grid-cols-2 gap-2 mb-3">
                        <div class="rounded-lg border border-bark-200 dark:border-shadow-700 p-3 bg-bark-50 dark:bg-shadow-900">
                          <p class="text-[10px] font-medium text-shadow-400 dark:text-shadow-500 uppercase tracking-wider mb-1">Previous</p>
                          <pre class="text-xs font-mono text-shadow-600 dark:text-shadow-400 whitespace-pre-wrap max-h-48 overflow-y-auto">{diffOld || '(empty)'}</pre>
                        </div>
                        <div class="rounded-lg border border-gold-200 dark:border-gold-800 p-3 bg-gold-50/50 dark:bg-gold-900/10">
                          <p class="text-[10px] font-medium text-gold-600 dark:text-gold-400 uppercase tracking-wider mb-1">Current</p>
                          <pre class="text-xs font-mono text-shadow-600 dark:text-shadow-400 whitespace-pre-wrap max-h-48 overflow-y-auto">{diffNew || '(empty)'}</pre>
                        </div>
                      </div>
                    {/if}

                    {#if editingContent}
                      <textarea
                        bind:value={editContent}
                        rows={12}
                        class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-xs font-mono resize-vertical
                          focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                      ></textarea>
                      <div class="flex gap-2 mt-2">
                        <button
                          onclick={() => saveContent(dl.id)}
                          disabled={savingContent}
                          class="px-3 py-1.5 rounded-lg bg-gold-600 text-white text-xs font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors"
                        >
                          {savingContent ? 'Saving...' : 'Save Content'}
                        </button>
                        <button
                          onclick={() => editingContent = false}
                          class="px-3 py-1.5 rounded-lg text-shadow-500 dark:text-shadow-400 text-xs hover:bg-bark-100 dark:hover:bg-shadow-800 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    {:else}
                      <pre class="text-xs font-mono text-shadow-600 dark:text-shadow-400 whitespace-pre-wrap bg-bark-50 dark:bg-shadow-900 p-3 rounded-lg max-h-64 overflow-y-auto">{dl.content}</pre>
                    {/if}
                  </div>

                  <!-- Version history + rollback -->
                  {#if detailData.layerHistory && detailData.layerHistory.length > 0}
                    <div>
                      <span class="text-[11px] font-medium text-shadow-400 dark:text-shadow-500 uppercase tracking-wider">Version History</span>
                      <div class="mt-2 space-y-1.5">
                        {#each detailData.layerHistory as entry (entry.version)}
                          <div class="flex items-center gap-3 px-3 py-2 rounded-lg bg-bark-50 dark:bg-shadow-800/50 text-xs">
                            <span class="font-mono text-shadow-600 dark:text-shadow-400">v{entry.version}</span>
                            <span class="text-shadow-500 dark:text-shadow-400">{new Date(entry.timestamp).toLocaleString()}</span>
                            <span class="text-shadow-300 dark:text-shadow-600">{entry.updatedBy}</span>
                            {#if entry.reason}
                              <span class="text-shadow-400 dark:text-shadow-500 italic truncate">{entry.reason}</span>
                            {/if}
                            {#if entry.version < dl.version}
                              <button
                                onclick={() => handleRollback(dl.id, entry.version)}
                                disabled={rollingBack}
                                class="ml-auto px-2 py-0.5 text-[11px] font-medium rounded border border-wilt-300 dark:border-wilt-700 text-wilt-600 dark:text-wilt-400 hover:bg-wilt-50 dark:hover:bg-wilt-900/20 transition-colors disabled:opacity-50"
                              >
                                {rollingBack ? '...' : 'Rollback'}
                              </button>
                            {:else}
                              <span class="ml-auto px-2 py-0.5 rounded-full text-[10px] font-medium bg-gold-100 text-gold-700 dark:bg-gold-900/30 dark:text-gold-400">current</span>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <!-- Static Prompt Registry -->
    {#if staticPrompts.length > 0}
      <div class="mt-6">
        <h2 class="text-lg font-serif font-semibold text-shadow-700 dark:text-bark-300 mb-3">Static Prompt Registry</h2>
        <div class="space-y-2">
          {#each staticPrompts as sp (sp.key)}
            <details class="card-garden overflow-hidden {!sp.enabled ? 'opacity-50' : ''}">
              <summary class="px-4 py-3 cursor-pointer hover:bg-bark-50 dark:hover:bg-shadow-800/50 transition-colors">
                <div class="inline-flex items-center gap-3">
                  <span class="text-sm font-medium text-shadow-700 dark:text-bark-300">{sp.name}</span>
                  <span class="text-[11px] font-mono text-shadow-300 dark:text-shadow-600">{sp.key}</span>
                  {#if sp.category}
                    <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-bark-100 dark:bg-shadow-800 text-shadow-500 dark:text-shadow-400">{sp.category}</span>
                  {/if}
                  <span class="text-[11px] text-shadow-400 dark:text-shadow-500">v{sp.version}</span>
                  <span class="text-[11px] text-shadow-300 dark:text-shadow-600">{new Date(sp.updatedAt).toLocaleString()}</span>
                </div>
              </summary>
              <div class="px-4 pb-4 border-t border-bark-100 dark:border-shadow-800">
                <pre class="mt-3 text-xs font-mono text-shadow-600 dark:text-shadow-400 whitespace-pre-wrap bg-bark-50 dark:bg-shadow-900 p-3 rounded-lg max-h-48 overflow-y-auto">{sp.content}</pre>
              </div>
            </details>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>
