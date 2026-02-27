<script lang="ts">
  import { onMount } from 'svelte';
  import { listPrompts, getPromptDetail, updatePrompt, togglePrompt, rollbackPrompt, getPromptDiff } from '$lib/api/endpoints/prompts';
  import type { PromptLayer, PromptRegistryEntry } from '$lib/types';

  interface AdminPromptDetailData {
    layer: Record<string, unknown>;
    layerHistory: Array<{ version: number; timestamp: string; updatedBy: string; reason?: string }>;
  }

  async function fetchDetail(layerId: string): Promise<AdminPromptDetailData> {
    const raw = await getPromptDetail(layerId);
    return { layer: raw.layer as Record<string, unknown>, layerHistory: raw.history as AdminPromptDetailData['layerHistory'] };
  }

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
  let saveMessage = $state('');

  // Rollback
  let rollingBack = $state(false);

  // Diff
  let showDiff = $state(false);
  let diffOld = $state('');
  let diffNew = $state('');
  let diffLoading = $state(false);

  // Priority editing
  let editingPriorityId = $state<string | null>(null);
  let editPriorityValue = $state(0);

  // Static prompt expansion
  let expandedStatic = $state<string | null>(null);

  const LAYER_BADGE: Record<string, { bg: string; text: string; label: string }> = {
    base:     { bg: 'bg-gold-100 dark:bg-gold-900/30', text: 'text-gold-600 dark:text-gold-400', label: 'base' },
    operator: { bg: 'bg-moss-100 dark:bg-moss-900/30', text: 'text-moss-600 dark:text-moss-400', label: 'operator' },
    runtime:  { bg: 'bg-shadow-100 dark:bg-shadow-800', text: 'text-shadow-500 dark:text-shadow-300', label: 'runtime' },
    channel:  { bg: 'bg-petal-100 dark:bg-petal-900/30', text: 'text-petal-600 dark:text-petal-400', label: 'channel' },
    task:     { bg: 'bg-bark-200 dark:bg-bark-800/30', text: 'text-shadow-800 dark:text-bark-300', label: 'task' },
  };

  let sortedLayers = $derived(
    [...layers].sort((a, b) => a.priority - b.priority)
  );

  let charCount = $derived(editContent.length);

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
      showDiff = false;
      saveMessage = '';
      return;
    }
    selectedLayerId = layerId;
    detailLoading = true;
    editingContent = false;
    showDiff = false;
    saveMessage = '';
    try {
      detailData = await fetchDetail(layerId);
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
      if (selectedLayerId === layerId && detailData?.layer) {
        detailData = await fetchDetail(layerId);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to toggle layer';
    }
  }

  function startEditContent(layer: PromptLayer) {
    editContent = layer.content;
    editingContent = true;
    saveMessage = '';
  }

  async function saveContent(layerId: string) {
    savingContent = true;
    saveMessage = '';
    try {
      await updatePrompt(layerId, { content: editContent });
      await refreshList();
      detailData = await fetchDetail(layerId);
      editingContent = false;
      saveMessage = 'Content saved successfully';
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to save content';
    } finally {
      savingContent = false;
    }
  }

  async function handleRollback(layerId: string, version: number) {
    if (!confirm(`Roll back layer to version ${version}? This will replace current content.`)) return;
    rollingBack = true;
    try {
      await rollbackPrompt(layerId, { version });
      await refreshList();
      detailData = await fetchDetail(layerId);
      saveMessage = `Rolled back to version ${version}`;
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
      const result = await getPromptDiff(layerId);
      // diff is returned as a single string; split by a delimiter or show as-is
      diffOld = result.diff;
      diffNew = '';
      showDiff = true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'No previous version to diff';
    } finally {
      diffLoading = false;
    }
  }

  function startPriorityEdit(layer: PromptLayer) {
    editingPriorityId = layer.id;
    editPriorityValue = layer.priority;
  }

  async function savePriority(layerId: string) {
    try {
      await updatePrompt(layerId, { priority: editPriorityValue });
      await refreshList();
      editingPriorityId = null;
      if (selectedLayerId === layerId && detailData?.layer) {
        detailData = await fetchDetail(layerId);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to update priority';
    }
  }

  async function moveLayer(layerId: string, direction: 'up' | 'down') {
    const idx = sortedLayers.findIndex(l => l.id === layerId);
    if (idx < 0) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sortedLayers.length) return;

    const current = sortedLayers[idx];
    const target = sortedLayers[swapIdx];
    if (isProtected(current) || isProtected(target)) return;

    // Swap priorities
    try {
      await Promise.all([
        updatePrompt(current.id, { priority: target.priority }),
        updatePrompt(target.id, { priority: current.priority }),
      ]);
      await refreshList();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to reorder';
    }
  }

  function isProtected(layer: PromptLayer): boolean {
    return layer.type === 'base' || layer.type === 'operator';
  }

  function truncate(text: string, len: number): string {
    if (text.length <= len) return text;
    return text.slice(0, len) + '...';
  }
</script>

<div class="space-y-6">
  <!-- Header -->
  <div>
    <h1 class="text-2xl font-serif font-bold text-shadow-900 dark:text-bark-200">The Soil</h1>
    <p class="text-sm text-shadow-500 dark:text-bark-500 mt-1">Layered prompt stack -- {layers.length} layer{layers.length === 1 ? '' : 's'}</p>
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
    <div class="space-y-2">
      {#each Array(5) as _}
        <div class="card-garden p-4 animate-pulse">
          <div class="flex items-center gap-3">
            <div class="h-5 w-14 bg-bark-200 dark:bg-shadow-700 rounded"></div>
            <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded flex-1"></div>
            <div class="h-4 w-8 bg-bark-200 dark:bg-shadow-700 rounded"></div>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <!-- Section: Prompt Layers -->
    <div>
      <h2 class="text-base font-serif font-semibold text-shadow-800 dark:text-bark-200 mb-3">Prompt Layers</h2>
      <div class="space-y-2">
        {#each sortedLayers as layer (layer.id)}
          {@const badge = LAYER_BADGE[layer.type] || LAYER_BADGE.task}
          {@const isSelected = selectedLayerId === layer.id}
          {@const locked = isProtected(layer)}

          <div class="card-garden overflow-hidden transition-all {!layer.enabled ? 'opacity-60' : ''} {isSelected ? 'filigree-border-strong ring-1 ring-gold-300' : ''}">
            <!-- Layer header row -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-bark-50 dark:hover:bg-shadow-800/50 transition-colors cursor-pointer"
              onclick={() => selectLayer(layer.id)}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectLayer(layer.id); }}}
              role="button"
              tabindex="0"
            >
              <!-- Type badge -->
              <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide {badge.bg} {badge.text}">
                {badge.label}
              </span>

              <!-- Name -->
              <span class="font-serif font-medium text-sm text-shadow-800 dark:text-bark-300 min-w-0 truncate">{layer.name}</span>

              <!-- Identifier (if present) -->
              {#if layer.identifier}
                <span class="text-[10px] font-mono text-shadow-400 dark:text-bark-500 hidden sm:inline">{layer.identifier}</span>
              {/if}

              <!-- Spacer -->
              <span class="flex-1"></span>

              <!-- Move buttons (non-protected only) -->
              {#if !locked}
                <div class="flex items-center gap-0.5 shrink-0" onclick={(e) => e.stopPropagation()}>
                  <button
                    onclick={() => moveLayer(layer.id, 'up')}
                    disabled={sortedLayers.indexOf(layer) === 0}
                    class="w-5 h-5 flex items-center justify-center rounded text-shadow-400 hover:text-gold-600 hover:bg-bark-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="Move up (lower priority number)"
                  >
                    <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 15l-6-6-6 6"/></svg>
                  </button>
                  <button
                    onclick={() => moveLayer(layer.id, 'down')}
                    disabled={sortedLayers.indexOf(layer) === sortedLayers.length - 1}
                    class="w-5 h-5 flex items-center justify-center rounded text-shadow-400 hover:text-gold-600 hover:bg-bark-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="Move down (higher priority number)"
                  >
                    <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
                  </button>
                </div>
              {/if}

              <!-- Priority (clickable to edit) -->
              {#if editingPriorityId === layer.id}
                <div class="flex items-center gap-1 shrink-0" onclick={(e) => e.stopPropagation()}>
                  <input
                    type="number"
                    min="0"
                    max="999"
                    bind:value={editPriorityValue}
                    onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); savePriority(layer.id); } if (e.key === 'Escape') editingPriorityId = null; }}
                    class="w-14 px-1.5 py-0.5 text-[11px] font-mono rounded border border-gold-300 bg-white text-shadow-900 text-center focus:outline-none focus:ring-1 focus:ring-gold-400"
                  />
                  <button onclick={() => savePriority(layer.id)} class="text-[10px] text-gold-600 hover:text-gold-700 font-medium">OK</button>
                </div>
              {:else}
                <button
                  onclick={(e) => { e.stopPropagation(); if (!locked) startPriorityEdit(layer); }}
                  class="text-[11px] text-shadow-400 font-mono shrink-0 {locked ? 'cursor-default' : 'hover:text-gold-600 cursor-pointer'}"
                  title={locked ? `Priority: ${layer.priority}` : 'Click to edit priority'}
                >
                  p{layer.priority}
                </button>
              {/if}

              <!-- Content preview -->
              <span class="text-[11px] text-shadow-400 dark:text-bark-500 truncate max-w-32 hidden md:inline">{truncate(layer.content, 60)}</span>

              <!-- Toggle or lock -->
              {#if locked}
                <svg class="w-4 h-4 text-shadow-400 dark:text-bark-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              {:else}
                <button
                  onclick={(e) => { e.stopPropagation(); handleToggle(layer.id); }}
                  class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-gold-300 focus:ring-offset-2 {layer.enabled ? 'bg-moss-500' : 'bg-bark-300 dark:bg-shadow-600'}"
                  role="switch"
                  aria-checked={layer.enabled}
                >
                  <span class="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out {layer.enabled ? 'translate-x-4' : 'translate-x-0'}"></span>
                </button>
              {/if}
            </div>

            <!-- Detail panel -->
            {#if isSelected}
              <div class="border-t border-bark-100 dark:border-shadow-800">
                {#if detailLoading}
                  <div class="p-5 animate-pulse space-y-3">
                    <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded w-1/3"></div>
                    <div class="h-20 bg-bark-200 dark:bg-shadow-700 rounded"></div>
                  </div>
                {:else if detailData?.layer}
                  {@const dl = detailData.layer}
                  <div class="p-5 space-y-5">
                    <!-- Metadata grid -->
                    <div>
                      <span class="text-[11px] font-medium text-shadow-500 dark:text-bark-400 uppercase tracking-wider">Metadata</span>
                      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2 text-xs">
                        <div>
                          <span class="text-shadow-400 dark:text-bark-500">Type</span>
                          <p class="text-shadow-800 dark:text-bark-300 mt-0.5 capitalize">{dl.type}</p>
                        </div>
                        <div>
                          <span class="text-shadow-400 dark:text-bark-500">Priority</span>
                          <p class="text-shadow-800 dark:text-bark-300 mt-0.5">{dl.priority}</p>
                        </div>
                        <div>
                          <span class="text-shadow-400 dark:text-bark-500">Role</span>
                          <p class="text-shadow-800 dark:text-bark-300 mt-0.5">{dl.role ?? 'system'}</p>
                        </div>
                        <div>
                          <span class="text-shadow-400 dark:text-bark-500">Version</span>
                          <p class="text-shadow-800 dark:text-bark-300 mt-0.5">v{dl.version}</p>
                        </div>
                        <div>
                          <span class="text-shadow-400 dark:text-bark-500">Updated</span>
                          <p class="text-shadow-800 dark:text-bark-300 mt-0.5">{new Date(dl.updatedAt).toLocaleString()}</p>
                        </div>
                        <div>
                          <span class="text-shadow-400 dark:text-bark-500">By</span>
                          <p class="text-shadow-800 dark:text-bark-300 mt-0.5">{dl.updatedBy}</p>
                        </div>
                        <div>
                          <span class="text-shadow-400 dark:text-bark-500">Checksum</span>
                          <p class="font-mono text-shadow-500 dark:text-bark-400 mt-0.5">{dl.checksum.slice(0, 12)}</p>
                        </div>
                        <div>
                          <span class="text-shadow-400 dark:text-bark-500">Enabled</span>
                          <p class="mt-0.5 {dl.enabled ? 'text-moss-600 dark:text-moss-400' : 'text-wilt-500 dark:text-wilt-400'}">{dl.enabled ? 'Yes' : 'No'}</p>
                        </div>
                      </div>
                    </div>

                    <!-- Content section -->
                    <div>
                      <div class="flex items-center justify-between mb-2">
                        <span class="text-[11px] font-medium text-shadow-500 dark:text-bark-400 uppercase tracking-wider">Content</span>
                        <div class="flex items-center gap-3">
                          {#if dl.version > 1}
                            <button
                              onclick={() => loadDiff(dl.id)}
                              disabled={diffLoading}
                              class="text-[11px] text-shadow-500 dark:text-bark-400 hover:text-gold-600 dark:hover:text-gold-400 transition-colors"
                            >
                              {diffLoading ? 'Loading...' : showDiff ? 'Hide Diff' : 'Diff'}
                            </button>
                          {/if}
                          {#if !locked && !editingContent}
                            <button
                              onclick={() => startEditContent(dl)}
                              class="text-[11px] text-gold-600 dark:text-gold-400 hover:underline font-medium"
                            >
                              Edit
                            </button>
                          {/if}
                        </div>
                      </div>

                      <!-- Diff view -->
                      {#if showDiff}
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-2 mb-3">
                          <div class="rounded-lg border border-bark-200 dark:border-shadow-700 p-3 bg-bark-50 dark:bg-shadow-900">
                            <p class="text-[10px] font-medium text-shadow-400 dark:text-bark-500 uppercase tracking-wider mb-1.5">Previous</p>
                            <pre class="text-xs font-mono text-shadow-800 dark:text-bark-300 whitespace-pre-wrap max-h-48 overflow-y-auto">{diffOld || '(empty)'}</pre>
                          </div>
                          <div class="rounded-lg border border-gold-200 dark:border-gold-800 p-3 bg-gold-50 dark:bg-gold-900/10">
                            <p class="text-[10px] font-medium text-gold-600 dark:text-gold-400 uppercase tracking-wider mb-1.5">Current</p>
                            <pre class="text-xs font-mono text-shadow-800 dark:text-bark-300 whitespace-pre-wrap max-h-48 overflow-y-auto">{diffNew || '(empty)'}</pre>
                          </div>
                        </div>
                      {/if}

                      <!-- Edit mode -->
                      {#if editingContent}
                        <div class="relative">
                          <textarea
                            bind:value={editContent}
                            rows={14}
                            class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-xs font-mono resize-vertical leading-relaxed
                              focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400
                              {locked ? 'opacity-50 cursor-not-allowed' : ''}"
                            disabled={locked}
                          ></textarea>
                          <div class="flex items-center justify-between mt-2">
                            <span class="text-[10px] text-shadow-400 dark:text-bark-500">{charCount} characters</span>
                            <div class="flex gap-2">
                              <button
                                onclick={() => { editingContent = false; saveMessage = ''; }}
                                class="px-3 py-1.5 rounded-lg text-shadow-500 dark:text-bark-400 text-xs hover:bg-bark-100 dark:hover:bg-shadow-800 transition-colors"
                              >
                                Cancel
                              </button>
                              <button
                                onclick={() => saveContent(dl.id)}
                                disabled={savingContent || locked}
                                class="px-4 py-1.5 rounded-lg bg-gold-600 text-white text-xs font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors"
                              >
                                {savingContent ? 'Saving...' : 'Save'}
                              </button>
                            </div>
                          </div>
                        </div>
                      {:else}
                        <!-- Read-only display -->
                        <div class="relative">
                          {#if locked}
                            <div class="absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-bark-100 dark:bg-shadow-800 text-shadow-400 dark:text-bark-500">
                              <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                              </svg>
                              Protected
                            </div>
                          {/if}
                          <pre class="text-xs font-mono text-shadow-800 dark:text-bark-300 whitespace-pre-wrap bg-bark-50 dark:bg-shadow-900 p-3 rounded-lg max-h-72 overflow-y-auto leading-relaxed {locked ? 'border border-bark-200 dark:border-shadow-700' : ''}">{dl.content}</pre>
                          <span class="block text-[10px] text-shadow-400 dark:text-bark-500 mt-1 text-right">{dl.content.length} characters</span>
                        </div>
                      {/if}

                      {#if saveMessage}
                        <p class="mt-2 text-xs text-moss-600 dark:text-moss-400">{saveMessage}</p>
                      {/if}
                    </div>

                    <!-- Version history + rollback -->
                    {#if detailData.layerHistory && detailData.layerHistory.length > 0}
                      <div>
                        <span class="text-[11px] font-medium text-shadow-500 dark:text-bark-400 uppercase tracking-wider">Version History</span>
                        <p class="text-[10px] text-shadow-400 dark:text-bark-500 mt-0.5 mb-2">{detailData.layerHistory.length} version{detailData.layerHistory.length === 1 ? '' : 's'}</p>
                        <div class="space-y-1.5">
                          {#each detailData.layerHistory as entry (entry.version)}
                            {@const isCurrent = entry.version === dl.version}
                            <div class="flex items-center gap-3 px-3 py-2 rounded-lg text-xs {isCurrent ? 'bg-gold-50/50 dark:bg-gold-900/10 border border-gold-200 dark:border-gold-800' : 'bg-bark-50 dark:bg-shadow-800/50'}">
                              <span class="font-mono font-medium {isCurrent ? 'text-gold-600 dark:text-gold-400' : 'text-shadow-800 dark:text-bark-300'}">v{entry.version}</span>
                              <span class="text-shadow-500 dark:text-bark-400">{new Date(entry.timestamp).toLocaleString()}</span>
                              <span class="text-shadow-400 dark:text-bark-500">{entry.updatedBy}</span>
                              {#if entry.reason}
                                <span class="text-shadow-400 dark:text-bark-500 italic truncate max-w-48">{entry.reason}</span>
                              {/if}
                              {#if isCurrent}
                                <span class="ml-auto px-2 py-0.5 rounded-full text-[10px] font-medium bg-gold-100 text-gold-600 dark:bg-gold-900/30 dark:text-gold-400 border border-gold-300 dark:border-gold-700">current</span>
                              {:else}
                                <button
                                  onclick={() => handleRollback(dl.id, entry.version)}
                                  disabled={rollingBack}
                                  class="ml-auto px-2.5 py-0.5 text-[11px] font-medium rounded border border-wilt-300 dark:border-wilt-700 text-wilt-600 dark:text-wilt-400 hover:bg-wilt-50 dark:hover:bg-wilt-900/20 transition-colors disabled:opacity-50"
                                >
                                  {rollingBack ? '...' : 'Rollback'}
                                </button>
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

        {#if sortedLayers.length === 0}
          <div class="card-garden p-8 text-center text-shadow-400 dark:text-bark-500 italic">
            No prompt layers configured
          </div>
        {/if}
      </div>
    </div>

    <!-- Section: Static Prompts -->
    {#if staticPrompts.length > 0}
      <hr class="divider-filigree my-6" />

      <div>
        <h2 class="text-base font-serif font-semibold text-shadow-800 dark:text-bark-200 mb-1">Static Prompt Registry</h2>
        <p class="text-xs text-shadow-400 dark:text-bark-500 mb-3">{staticPrompts.length} registered prompt{staticPrompts.length === 1 ? '' : 's'} -- always active</p>

        <div class="space-y-2">
          {#each staticPrompts as sp (sp.key)}
            {@const isExpanded = expandedStatic === sp.key}

            <div class="card-garden overflow-hidden {!sp.enabled ? 'opacity-60' : ''}">
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="px-4 py-3 flex items-center gap-3 hover:bg-bark-50 dark:hover:bg-shadow-800/50 transition-colors cursor-pointer"
                onclick={() => expandedStatic = isExpanded ? null : sp.key}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expandedStatic = isExpanded ? null : sp.key; }}}
                role="button"
                tabindex="0"
              >
                <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-bark-100 dark:bg-shadow-800 text-shadow-500 dark:text-shadow-300">
                  static
                </span>
                <span class="font-serif font-medium text-sm text-shadow-800 dark:text-bark-300">{sp.name}</span>
                <span class="text-[10px] font-mono text-shadow-400 dark:text-bark-500">{sp.key}</span>
                <span class="flex-1"></span>
                {#if sp.category}
                  <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-bark-100 dark:bg-shadow-800 text-shadow-500 dark:text-bark-400">{sp.category}</span>
                {/if}
                <span class="text-[11px] text-shadow-400 dark:text-bark-500">v{sp.version}</span>
                <svg class="w-4 h-4 text-shadow-400 dark:text-bark-500 transition-transform {isExpanded ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M19 9l-7 7-7-7" />
                </svg>
              </div>

              {#if isExpanded}
                <div class="border-t border-bark-100 dark:border-shadow-800 p-4 space-y-3">
                  <div class="flex items-center gap-4 text-xs text-shadow-500 dark:text-bark-400">
                    <span>Updated: {new Date(sp.updatedAt).toLocaleString()}</span>
                    {#if sp.enabled}
                      <span class="text-moss-600 dark:text-moss-400">Enabled</span>
                    {:else}
                      <span class="text-wilt-500 dark:text-wilt-400">Disabled</span>
                    {/if}
                  </div>
                  <pre class="text-xs font-mono text-shadow-800 dark:text-bark-300 whitespace-pre-wrap bg-bark-50 dark:bg-shadow-900 p-3 rounded-lg max-h-64 overflow-y-auto leading-relaxed">{sp.content}</pre>
                  <span class="block text-[10px] text-shadow-400 dark:text-bark-500 text-right">{sp.content.length} characters</span>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>
