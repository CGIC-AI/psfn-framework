<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listPrompts,
    getPromptDetail,
    updatePrompt,
    togglePrompt,
    rollbackPrompt,
    getPromptDiff,
  } from '$lib/api/endpoints/prompts';
  import type {
    PromptLayer,
    PromptRegistryEntry,
    AdminPromptDetailData,
    PromptHistoryEntry,
    PromptDiffResult,
  } from '$lib/types';

  // ── Structured prompt constants ──
  const STRUCTURED_SECTION_KEYS = [
    'description', 'personality', 'system_prompt',
    'post_history_instructions', 'scenario', 'mes_example', 'first_mes',
  ] as const;

  type StructuredSectionKey = typeof STRUCTURED_SECTION_KEYS[number];

  const SECTION_LABELS: Record<StructuredSectionKey, string> = {
    description: 'Description',
    personality: 'Personality',
    system_prompt: 'System Prompt',
    post_history_instructions: 'Post-History Instructions',
    scenario: 'Scenario',
    mes_example: 'Message Example',
    first_mes: 'First Message',
  };

  const SECTION_ROWS: Record<StructuredSectionKey, number> = {
    description: 4,
    personality: 4,
    system_prompt: 7,
    post_history_instructions: 4,
    scenario: 4,
    mes_example: 7,
    first_mes: 4,
  };

  // ── Macro catalog ──
  const MACROS = [
    { token: '{{current_datetime}} / {{now()}}', desc: 'Current UTC datetime in ISO-8601 format.', example: '2026-02-21T13:20:11.123Z' },
    { token: '{{current_date}}', desc: 'Current UTC calendar date.', example: '2026-02-21' },
    { token: '{{current_time}}', desc: 'Current UTC time.', example: '13:20:11Z' },
    { token: '{{unix_timestamp}}', desc: 'Current Unix epoch timestamp in seconds.', example: '1769020811' },
    { token: '{{user}}', desc: 'Current author/user display name from runtime context.', example: 'Vega' },
    { token: '{{char}}', desc: 'Character/assistant name from runtime context.', example: 'Purrsephone' },
    { token: '{{channel_id}}', desc: 'Resolved channel/session identifier.', example: 'discord:dm:123456789' },
    { token: '{{channel_type}}', desc: 'Resolved channel type.', example: 'discord_text' },
    { token: '{{trust_level}}', desc: 'Current trust tier for the author/context.', example: 'primary' },
    { token: '{{model}}', desc: 'Current active model identifier.', example: 'moonshotai/kimi-k2.5' },
  ];

  // ── Layer type ordering and styling ──
  const TYPE_ORDER: Record<string, number> = {
    base: 0, operator: 1, runtime: 2, channel: 3, task: 4,
  };

  const LAYER_BADGE: Record<string, { bg: string; text: string }> = {
    base:     { bg: 'bg-gold-200', text: 'text-gold-800' },
    operator: { bg: 'bg-bark-400', text: 'text-bark-50' },
    runtime:  { bg: 'bg-moss-200', text: 'text-moss-700' },
    channel:  { bg: 'bg-petal-200', text: 'text-petal-500' },
    task:     { bg: 'bg-gold-100', text: 'text-gold-700' },
  };

  // ── State ──
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
  let editSections = $state<Record<StructuredSectionKey, string>>({
    description: '', personality: '', system_prompt: '',
    post_history_instructions: '', scenario: '', mes_example: '', first_mes: '',
  });
  let editRawContent = $state('');
  let isStructured = $state(false);
  let savingContent = $state(false);
  let saveMessage = $state('');

  // Metadata editing
  let editIdentifier = $state('');
  let editRole = $state('');
  let editPromptOrder = $state<number | undefined>(undefined);

  // Rollback
  let rollingBack = $state(false);

  // Diff
  let showDiff = $state(false);
  let diffData = $state<PromptDiffResult | null>(null);
  let diffLoading = $state(false);

  // Priority editing
  let editingPriorityId = $state<string | null>(null);
  let editPriorityValue = $state(0);

  // Static prompt expansion
  let expandedStatic = $state<string | null>(null);

  // Section toggles
  let showMacroCatalog = $state(false);

  // ── Derived ──
  let sortedLayers = $derived(
    [...layers].sort((a, b) => {
      const typeOrder = (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99);
      if (typeOrder !== 0) return typeOrder;
      return a.priority - b.priority;
    })
  );

  let charCount = $derived(
    isStructured
      ? Object.values(editSections).reduce((sum, s) => sum + s.length, 0)
      : editRawContent.length
  );

  // ── Structured content parsing ──
  function parseStructuredContent(content: string): { sections: Record<StructuredSectionKey, string>; isStructured: boolean } {
    const sections: Record<StructuredSectionKey, string> = {
      description: '', personality: '', system_prompt: '',
      post_history_instructions: '', scenario: '', mes_example: '', first_mes: '',
    };
    const lines = content.replace(/\r\n?/g, '\n').split('\n');
    const hasHeadings = lines.some(l => /^###\s+[a-z_]+\s*$/.test(l.trim()));
    if (!hasHeadings) {
      sections.system_prompt = content.trim();
      return { sections, isStructured: false };
    }

    let currentSection: StructuredSectionKey | null = null;
    const buckets: Record<StructuredSectionKey, string[]> = {
      description: [], personality: [], system_prompt: [],
      post_history_instructions: [], scenario: [], mes_example: [], first_mes: [],
    };

    for (const line of lines) {
      const match = line.trim().match(/^###\s+([a-z_]+)\s*$/);
      if (match) {
        const key = match[1] as StructuredSectionKey;
        if (STRUCTURED_SECTION_KEYS.includes(key)) {
          currentSection = key;
          continue;
        }
      }
      if (currentSection) {
        buckets[currentSection].push(line);
      }
    }

    for (const key of STRUCTURED_SECTION_KEYS) {
      const lines2 = buckets[key];
      let start = 0;
      while (start < lines2.length && lines2[start].trim() === '') start++;
      let end = lines2.length;
      while (end > start && lines2[end - 1].trim() === '') end--;
      sections[key] = lines2.slice(start, end).join('\n');
    }

    return { sections, isStructured: true };
  }

  function composeSections(sections: Record<StructuredSectionKey, string>): string {
    const chunks: string[] = [];
    for (const key of STRUCTURED_SECTION_KEYS) {
      const value = (sections[key] ?? '').trim();
      if (!value) continue;
      chunks.push(`### ${key}\n${value}`);
    }
    return chunks.join('\n\n');
  }

  // ── Diff computation ──
  function computeDiffLines(oldText: string, newText: string): Array<{ kind: 'same' | 'remove' | 'add'; line: string }> {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const max = Math.max(oldLines.length, newLines.length);
    const rows: Array<{ kind: 'same' | 'remove' | 'add'; line: string }> = [];
    for (let i = 0; i < max; i++) {
      const oldLine = oldLines[i];
      const newLine = newLines[i];
      if (oldLine === newLine) {
        rows.push({ kind: 'same', line: oldLine ?? '' });
      } else {
        if (oldLine !== undefined) rows.push({ kind: 'remove', line: oldLine });
        if (newLine !== undefined) rows.push({ kind: 'add', line: newLine });
      }
    }
    return rows;
  }

  // ── Lifecycle ──
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

  // ── Layer actions ──
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
    diffData = null;
    try {
      detailData = await getPromptDetail(layerId);
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
        detailData = await getPromptDetail(layerId);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to toggle layer';
    }
  }

  function startEditContent(layer: PromptLayer) {
    const parsed = parseStructuredContent(layer.content);
    isStructured = parsed.isStructured;
    editSections = { ...parsed.sections };
    editRawContent = layer.content;
    editIdentifier = layer.identifier ?? '';
    editRole = layer.role ?? '';
    editPromptOrder = layer.promptOrder;
    editingContent = true;
    saveMessage = '';
  }

  async function saveContent(layerId: string) {
    savingContent = true;
    saveMessage = '';
    try {
      const content = isStructured ? composeSections(editSections) : editRawContent;
      const patch: Record<string, unknown> = { content };
      if (editIdentifier) patch.identifier = editIdentifier;
      if (editRole) patch.role = editRole;
      if (editPromptOrder !== undefined) patch.promptOrder = editPromptOrder;
      await updatePrompt(layerId, patch);
      await refreshList();
      detailData = await getPromptDetail(layerId);
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
      detailData = await getPromptDetail(layerId);
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
      diffData = await getPromptDiff(layerId);
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
      if (selectedLayerId === layerId) {
        detailData = await getPromptDetail(layerId);
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
    <h1 class="text-2xl font-serif font-bold text-shadow-900">The Soil</h1>
    <p class="text-sm text-shadow-600 mt-1">Layered prompt stack -- {layers.length} layer{layers.length === 1 ? '' : 's'}</p>
  </div>

  <!-- Error -->
  {#if error}
    <div class="card-garden p-4 flex items-center gap-3 border-wilt-400">
      <svg class="w-5 h-5 text-wilt-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
      </svg>
      <span class="text-sm text-wilt-600">{error}</span>
      <button onclick={() => error = ''} class="ml-auto text-shadow-600 hover:text-shadow-900 text-lg leading-none">&times;</button>
    </div>
  {/if}

  <!-- Loading -->
  {#if loading}
    <div class="space-y-2">
      {#each Array(5) as _}
        <div class="card-garden p-4 animate-pulse">
          <div class="flex items-center gap-3">
            <div class="h-5 w-14 bg-bark-300 rounded"></div>
            <div class="h-4 bg-bark-300 rounded flex-1"></div>
            <div class="h-4 w-8 bg-bark-300 rounded"></div>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <!-- ─── Macro Catalog ─── -->
    <div class="card-garden overflow-hidden">
      <button
        onclick={() => showMacroCatalog = !showMacroCatalog}
        class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
      >
        <div class="flex items-center gap-3">
          <span class="flex items-center justify-center w-7 h-7 rounded-full bg-gold-100 text-gold-700 text-sm font-bold border border-gold-300">{'{}'}</span>
          <h2 class="text-sm font-serif font-semibold text-shadow-800">Macro Catalog</h2>
          <span class="text-sm text-shadow-600">{MACROS.length} runtime macros</span>
        </div>
        <svg class="w-4 h-4 text-shadow-600 transition-transform {showMacroCatalog ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {#if showMacroCatalog}
        <div class="border-t border-bark-300 overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-bark-300 bg-bark-100">
                <th class="text-left px-4 py-2.5 text-shadow-700 font-medium">Macro</th>
                <th class="text-left px-4 py-2.5 text-shadow-700 font-medium">Meaning</th>
                <th class="text-left px-4 py-2.5 text-shadow-700 font-medium">Example</th>
              </tr>
            </thead>
            <tbody>
              {#each MACROS as macro}
                <tr class="border-b border-bark-200 hover:bg-bark-100 transition-colors">
                  <td class="px-4 py-2"><code class="text-sm font-mono text-gold-700 bg-gold-50 px-1.5 py-0.5 rounded">{macro.token}</code></td>
                  <td class="px-4 py-2 text-shadow-700">{macro.desc}</td>
                  <td class="px-4 py-2"><code class="text-sm font-mono text-shadow-600">{macro.example}</code></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>

    <!-- ─── Prompt Layers ─── -->
    <div>
      <h2 class="text-base font-serif font-semibold text-shadow-800 mb-3">Prompt Layers</h2>
      <p class="text-sm text-shadow-600 mb-4">Sorted by type precedence (base -> operator -> runtime -> channel -> task) then priority within type.</p>

      <div class="space-y-2">
        {#each sortedLayers as layer (layer.id)}
          {@const badge = LAYER_BADGE[layer.type] || LAYER_BADGE.task}
          {@const isSelected = selectedLayerId === layer.id}
          {@const locked = isProtected(layer)}

          <div class="card-garden overflow-hidden transition-all {!layer.enabled ? 'opacity-60' : ''} {isSelected ? 'filigree-border-strong ring-1 ring-gold-300' : ''}">
            <!-- Layer header row -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-bark-100 transition-colors cursor-pointer"
              onclick={() => selectLayer(layer.id)}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectLayer(layer.id); }}}
              role="button"
              tabindex="0"
            >
              <!-- Type badge -->
              <span class="px-2 py-0.5 rounded text-sm font-bold uppercase tracking-wide {badge.bg} {badge.text}">
                {layer.type}
              </span>

              <!-- Name -->
              <span class="font-serif font-medium text-sm text-shadow-800 min-w-0 truncate">{layer.name}</span>

              <!-- Identifier -->
              {#if layer.identifier}
                <span class="text-sm font-mono text-shadow-600 hidden sm:inline">{layer.identifier}</span>
              {/if}

              <span class="flex-1"></span>

              <!-- Move buttons (non-protected only) -->
              {#if !locked}
                <div class="flex items-center gap-0.5 shrink-0" onclick={(e) => e.stopPropagation()}>
                  <button
                    onclick={() => moveLayer(layer.id, 'up')}
                    disabled={sortedLayers.indexOf(layer) === 0}
                    class="w-6 h-6 flex items-center justify-center rounded text-shadow-600 hover:text-gold-600 hover:bg-bark-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="Move up"
                  >
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 15l-6-6-6 6"/></svg>
                  </button>
                  <button
                    onclick={() => moveLayer(layer.id, 'down')}
                    disabled={sortedLayers.indexOf(layer) === sortedLayers.length - 1}
                    class="w-6 h-6 flex items-center justify-center rounded text-shadow-600 hover:text-gold-600 hover:bg-bark-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="Move down"
                  >
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
                  </button>
                </div>
              {/if}

              <!-- Priority -->
              {#if editingPriorityId === layer.id}
                <div class="flex items-center gap-1 shrink-0" onclick={(e) => e.stopPropagation()}>
                  <input
                    type="number" min="0" max="999"
                    bind:value={editPriorityValue}
                    onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); savePriority(layer.id); } if (e.key === 'Escape') editingPriorityId = null; }}
                    class="w-16 px-2 py-0.5 text-sm font-mono rounded border border-gold-300 bg-white text-shadow-900 text-center focus:outline-none focus:ring-1 focus:ring-gold-400"
                  />
                  <button onclick={() => savePriority(layer.id)} class="text-sm text-gold-600 hover:text-gold-700 font-medium">OK</button>
                </div>
              {:else}
                <button
                  onclick={(e) => { e.stopPropagation(); if (!locked) startPriorityEdit(layer); }}
                  class="text-sm text-shadow-600 font-mono shrink-0 {locked ? 'cursor-default' : 'hover:text-gold-600 cursor-pointer'}"
                  title={locked ? `Priority: ${layer.priority}` : 'Click to edit priority'}
                >
                  p{layer.priority}
                </button>
              {/if}

              <!-- Version -->
              <span class="text-sm text-shadow-600 font-mono shrink-0">v{layer.version}</span>

              <!-- Toggle or lock -->
              {#if locked}
                <svg class="w-4 h-4 text-shadow-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              {:else}
                <button
                  onclick={(e) => { e.stopPropagation(); handleToggle(layer.id); }}
                  class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-gold-300 focus:ring-offset-2 {layer.enabled ? 'bg-moss-500' : 'bg-bark-400'}"
                  role="switch"
                  aria-checked={layer.enabled}
                >
                  <span class="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out {layer.enabled ? 'translate-x-4' : 'translate-x-0'}"></span>
                </button>
              {/if}
            </div>

            <!-- Detail panel -->
            {#if isSelected}
              <div class="border-t border-bark-300">
                {#if detailLoading}
                  <div class="p-5 animate-pulse space-y-3">
                    <div class="h-4 bg-bark-300 rounded w-1/3"></div>
                    <div class="h-20 bg-bark-300 rounded"></div>
                  </div>
                {:else if detailData?.layer}
                  {@const dl = detailData.layer}
                  <div class="p-5 space-y-5">
                    <!-- Metadata grid -->
                    <div>
                      <span class="text-sm font-medium text-shadow-700 uppercase tracking-wider">Metadata</span>
                      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2 text-sm">
                        <div>
                          <span class="text-shadow-600">Type</span>
                          <p class="text-shadow-800 mt-0.5 capitalize">{dl.type}</p>
                        </div>
                        <div>
                          <span class="text-shadow-600">Priority</span>
                          <p class="text-shadow-800 mt-0.5">{dl.priority}</p>
                        </div>
                        <div>
                          <span class="text-shadow-600">Role</span>
                          <p class="text-shadow-800 mt-0.5">{dl.role ?? 'system'}</p>
                        </div>
                        <div>
                          <span class="text-shadow-600">Version</span>
                          <p class="text-shadow-800 mt-0.5">v{dl.version}</p>
                        </div>
                        <div>
                          <span class="text-shadow-600">Updated</span>
                          <p class="text-shadow-800 mt-0.5">{new Date(dl.updatedAt).toLocaleString()}</p>
                        </div>
                        <div>
                          <span class="text-shadow-600">By</span>
                          <p class="text-shadow-800 mt-0.5">{dl.updatedBy}</p>
                        </div>
                        <div>
                          <span class="text-shadow-600">Checksum</span>
                          <p class="font-mono text-shadow-700 mt-0.5">{dl.checksum.slice(0, 12)}</p>
                        </div>
                        <div>
                          <span class="text-shadow-600">Enabled</span>
                          <p class="mt-0.5 {dl.enabled ? 'text-moss-600' : 'text-wilt-600'}">{dl.enabled ? 'Yes' : 'No'}</p>
                        </div>
                        {#if dl.identifier}
                          <div>
                            <span class="text-shadow-600">Identifier</span>
                            <p class="font-mono text-shadow-800 mt-0.5">{dl.identifier}</p>
                          </div>
                        {/if}
                        {#if dl.promptOrder !== undefined && dl.promptOrder !== null}
                          <div>
                            <span class="text-shadow-600">Prompt Order</span>
                            <p class="text-shadow-800 mt-0.5">{dl.promptOrder}</p>
                          </div>
                        {/if}
                        {#if dl.channelType}
                          <div>
                            <span class="text-shadow-600">Channel Type</span>
                            <p class="text-shadow-800 mt-0.5">{dl.channelType}</p>
                          </div>
                        {/if}
                        {#if dl.taskKind}
                          <div>
                            <span class="text-shadow-600">Task Kind</span>
                            <p class="text-shadow-800 mt-0.5">{dl.taskKind}</p>
                          </div>
                        {/if}
                      </div>
                    </div>

                    <!-- Content section -->
                    <div>
                      <div class="flex items-center justify-between mb-2">
                        <span class="text-sm font-medium text-shadow-700 uppercase tracking-wider">Content</span>
                        <div class="flex items-center gap-3">
                          {#if dl.version > 1}
                            <button
                              onclick={() => loadDiff(dl.id)}
                              disabled={diffLoading}
                              class="text-sm text-shadow-700 hover:text-gold-600 transition-colors"
                            >
                              {diffLoading ? 'Loading...' : showDiff ? 'Hide Diff' : 'Show Diff'}
                            </button>
                          {/if}
                          {#if !locked && !editingContent}
                            <button
                              onclick={() => startEditContent(dl)}
                              class="text-sm text-gold-600 hover:underline font-medium"
                            >
                              Edit
                            </button>
                          {/if}
                        </div>
                      </div>

                      <!-- Diff view -->
                      {#if showDiff && diffData}
                        {@const diffLines = computeDiffLines(diffData.oldContent, diffData.newContent)}
                        <div class="mb-3 rounded-lg border border-bark-300 overflow-hidden">
                          <div class="px-3 py-2 bg-bark-200 text-sm text-shadow-700 font-medium">Diff Preview</div>
                          <div class="font-mono text-sm max-h-64 overflow-y-auto">
                            {#each diffLines as line}
                              {#if line.kind === 'add'}
                                <div class="px-3 py-0.5 bg-moss-50 text-moss-700">+ {line.line}</div>
                              {:else if line.kind === 'remove'}
                                <div class="px-3 py-0.5 bg-wilt-50 text-wilt-600">- {line.line}</div>
                              {:else}
                                <div class="px-3 py-0.5 text-shadow-600">  {line.line}</div>
                              {/if}
                            {/each}
                          </div>
                        </div>
                      {/if}

                      <!-- Edit mode -->
                      {#if editingContent}
                        <div class="space-y-4">
                          <!-- Metadata fields -->
                          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                              <label class="block text-sm font-medium text-shadow-700 mb-1">Identifier</label>
                              <input type="text" bind:value={editIdentifier} placeholder="main"
                                class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400" />
                            </div>
                            <div>
                              <label class="block text-sm font-medium text-shadow-700 mb-1">Role</label>
                              <select bind:value={editRole}
                                class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400">
                                <option value="">Unset</option>
                                <option value="system">system</option>
                                <option value="user">user</option>
                                <option value="assistant">assistant</option>
                              </select>
                            </div>
                            <div>
                              <label class="block text-sm font-medium text-shadow-700 mb-1">Prompt Order</label>
                              <input type="number" min="0" step="1"
                                value={editPromptOrder ?? ''}
                                onchange={(e) => { const v = (e.target as HTMLInputElement).value; editPromptOrder = v ? Number(v) : undefined; }}
                                class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400" />
                            </div>
                          </div>

                          <!-- Structured sections or raw textarea -->
                          {#if isStructured}
                            <div class="space-y-3">
                              {#each STRUCTURED_SECTION_KEYS as key}
                                <div>
                                  <label class="block text-sm font-semibold text-shadow-700 mb-1">{SECTION_LABELS[key]}</label>
                                  <textarea
                                    bind:value={editSections[key]}
                                    rows={SECTION_ROWS[key]}
                                    class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm font-mono resize-vertical leading-relaxed focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                                  ></textarea>
                                </div>
                              {/each}
                            </div>
                          {:else}
                            <textarea
                              bind:value={editRawContent}
                              rows={14}
                              class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm font-mono resize-vertical leading-relaxed focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                            ></textarea>
                          {/if}

                          <div class="flex items-center justify-between">
                            <span class="text-sm text-shadow-600">{charCount} characters</span>
                            <div class="flex gap-2">
                              <button
                                onclick={() => { editingContent = false; saveMessage = ''; }}
                                class="px-3 py-1.5 rounded-lg text-shadow-700 text-sm hover:bg-bark-200 transition-colors"
                              >
                                Cancel
                              </button>
                              <button
                                onclick={() => saveContent(dl.id)}
                                disabled={savingContent || locked}
                                class="px-4 py-1.5 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors"
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
                            <div class="absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded text-sm bg-bark-200 text-shadow-600">
                              <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                              </svg>
                              Protected
                            </div>
                          {/if}
                          <pre class="text-sm font-mono text-shadow-800 whitespace-pre-wrap bg-bark-100 p-3 rounded-lg max-h-72 overflow-y-auto leading-relaxed {locked ? 'border border-bark-300' : ''}">{dl.content}</pre>
                          <span class="block text-sm text-shadow-600 mt-1 text-right">{dl.content.length} characters</span>
                        </div>
                      {/if}

                      {#if saveMessage}
                        <p class="mt-2 text-sm text-moss-600">{saveMessage}</p>
                      {/if}
                    </div>

                    <!-- Version history + rollback -->
                    {#if detailData.layerHistory && detailData.layerHistory.length > 0}
                      <div>
                        <span class="text-sm font-medium text-shadow-700 uppercase tracking-wider">Version History</span>
                        <p class="text-sm text-shadow-600 mt-0.5 mb-2">{detailData.layerHistory.length} version{detailData.layerHistory.length === 1 ? '' : 's'}</p>
                        <div class="space-y-1.5">
                          {#each detailData.layerHistory as entry (entry.version)}
                            {@const isCurrent = entry.version === dl.version}
                            <div class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm {isCurrent ? 'bg-gold-50 border border-gold-300' : 'bg-bark-100'}">
                              <span class="font-mono font-medium {isCurrent ? 'text-gold-700' : 'text-shadow-800'}">v{entry.version}</span>
                              <span class="text-shadow-700">{new Date(entry.timestamp).toLocaleString()}</span>
                              <span class="text-shadow-600">{entry.updatedBy}</span>
                              {#if entry.reason}
                                <span class="text-shadow-600 italic truncate max-w-48">{entry.reason}</span>
                              {/if}
                              {#if isCurrent}
                                <span class="ml-auto px-2 py-0.5 rounded-full text-sm font-medium bg-gold-100 text-gold-700 border border-gold-300">current</span>
                              {:else}
                                <button
                                  onclick={() => handleRollback(dl.id, entry.version)}
                                  disabled={rollingBack}
                                  class="ml-auto px-2.5 py-0.5 text-sm font-medium rounded border border-wilt-400 text-wilt-600 hover:bg-wilt-50 transition-colors disabled:opacity-50"
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
          <div class="card-garden p-8 text-center text-shadow-600 italic">
            No prompt layers configured
          </div>
        {/if}
      </div>
    </div>

    <!-- ─── Static Prompts ─── -->
    {#if staticPrompts.length > 0}
      <hr class="divider-filigree my-6" />

      <div>
        <h2 class="text-base font-serif font-semibold text-shadow-800 mb-1">Static Prompt Registry</h2>
        <p class="text-sm text-shadow-600 mb-3">{staticPrompts.length} registered prompt{staticPrompts.length === 1 ? '' : 's'} -- always active</p>

        <div class="space-y-2">
          {#each staticPrompts as sp (sp.key)}
            {@const isExpanded = expandedStatic === sp.key}

            <div class="card-garden overflow-hidden {sp.enabled === false ? 'opacity-60' : ''}">
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="px-4 py-3 flex items-center gap-3 hover:bg-bark-100 transition-colors cursor-pointer"
                onclick={() => expandedStatic = isExpanded ? null : sp.key}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expandedStatic = isExpanded ? null : sp.key; }}}
                role="button"
                tabindex="0"
              >
                <span class="px-2 py-0.5 rounded text-sm font-bold uppercase tracking-wide bg-bark-200 text-shadow-700">
                  static
                </span>
                <span class="font-serif font-medium text-sm text-shadow-800">{sp.name}</span>
                <span class="text-sm font-mono text-shadow-600">{sp.key}</span>
                <span class="flex-1"></span>
                {#if sp.category}
                  <span class="text-sm px-1.5 py-0.5 rounded-full bg-bark-200 text-shadow-700">{sp.category}</span>
                {/if}
                <span class="text-sm text-shadow-600">v{sp.version}</span>
                <svg class="w-4 h-4 text-shadow-600 transition-transform {isExpanded ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M19 9l-7 7-7-7" />
                </svg>
              </div>

              {#if isExpanded}
                <div class="border-t border-bark-300 p-4 space-y-3">
                  <div class="flex items-center gap-4 text-sm text-shadow-700">
                    <span>Updated: {sp.updatedAt ? new Date(sp.updatedAt).toLocaleString() : 'unknown'}</span>
                    {#if sp.enabled !== false}
                      <span class="text-moss-600">Enabled</span>
                    {:else}
                      <span class="text-wilt-600">Disabled</span>
                    {/if}
                    {#if sp.description}
                      <span class="text-shadow-600">{sp.description}</span>
                    {/if}
                  </div>
                  <pre class="text-sm font-mono text-shadow-800 whitespace-pre-wrap bg-bark-100 p-3 rounded-lg max-h-64 overflow-y-auto leading-relaxed">{sp.content}</pre>
                  <span class="block text-sm text-shadow-600 text-right">{sp.content.length} characters</span>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>
