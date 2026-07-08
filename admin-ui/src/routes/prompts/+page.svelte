<script lang="ts">
  import { onMount } from 'svelte';
  import ConstitutionBuilderPanel from './ConstitutionBuilderPanel.svelte';
  import NorthStarEditorPanel from './NorthStarEditorPanel.svelte';
  import {
    listPrompts,
    getConstitutionSnapshot,
    getNorthStarSnapshot,
    saveNorthStarItems,
    saveRuntimePromptBlocks,
    createPromptLayer,
    getPromptDetail,
    updatePrompt,
    togglePrompt,
    rollbackPrompt,
    getPromptDiff,
  } from '$lib/api/endpoints/prompts';
  import { apiPost } from '$lib/api/client';
  import type {
    PromptLayer,
    PromptRegistryEntry,
    PromptRuntimeBlock,
    PromptRuntimeLayerCoverageEntry,
    PromptRuntimeMacroHint,
    AdminPromptDetailData,
    PromptDiffResult,
    PromptUpdateResult,
    ConstitutionSnapshotData,
    ConstitutionCompanionLayer,
    ConstitutionImmutableBlock,
    NorthStarSnapshotData,
  } from '$lib/types';
  import {
    buildNorthStarPreview,
    buildReorderedLayerIds,
    buildReorderedRuntimeBlockIds,
    buildStackEntries,
    comparePromptLayers,
    compareRuntimeBlocks,
    computeDiffLines,
    estimateTokens,
    formatTokenCount,
    groupRuntimeMacroHints,
    isProtected,
    layerBadge,
    reorderNorthStarItems,
    roleBadge,
    runtimeBlockStatusLabel,
    runtimePlacementBadge,
    runtimePlacementLabel,
    runtimeVisibilityLabel,
  } from './page-helpers';
  import type { NorthStarDraftItem, StackEntry } from './page-helpers';

  // ── State ──
  let layers = $state<PromptLayer[]>([]);
  let staticPrompts = $state<PromptRegistryEntry[]>([]);
  let runtimeBlocks = $state<PromptRuntimeBlock[]>([]);
  let runtimeLayerCoverage = $state<{ ok: boolean; entries: PromptRuntimeLayerCoverageEntry[] }>({ ok: true, entries: [] });
  let runtimeMacroHints = $state<PromptRuntimeMacroHint[]>([]);
  let runtimeBlockDrafts = $state<Record<string, string>>({});
  let runtimeBlockSaving = $state<Record<string, boolean>>({});
  let runtimeBlockMessages = $state<Record<string, string>>({});
  let loading = $state(true);
  let error = $state('');
  let constitutionLoading = $state(true);
  let constitutionError = $state('');
  let showConstitutionSection = $state(true);
  let constitutionImmutableBlocks = $state<ConstitutionImmutableBlock[]>([]);
  let constitutionCompanionLayer = $state<ConstitutionCompanionLayer | null>(null);
  let constitutionServerPreview = $state('');
  let northStarLoading = $state(true);
  let northStarSaving = $state(false);
  let northStarError = $state('');
  let northStarSaveMessage = $state('');
  let showNorthStarSection = $state(true);
  let northStarLimit = $state(3);

  let northStarItems = $state<NorthStarDraftItem[]>([]);
  let northStarServerPreview = $state('');

  // Inline expansion state
  let expandedLayerId = $state<string | null>(null);
  let detailData = $state<AdminPromptDetailData | null>(null);
  let detailLoading = $state(false);

  // Content editing state
  let editingContent = $state(false);
  let editRawContent = $state('');
  let savingContent = $state(false);
  let saveMessage = $state('');

  // Metadata editing within inline edit
  let editName = $state('');
  let editIdentifier = $state('');
  let editRole = $state('');
  let editPromptOrder = $state<number | undefined>(undefined);

  // Rollback
  let rollingBack = $state(false);

  // Diff
  let showDiff = $state(false);
  let diffData = $state<PromptDiffResult | null>(null);
  let diffLoading = $state(false);

  // Section toggles
  let showMacroCatalog = $state(true);

  // Drag state
  let dragSourceIdx = $state<number | null>(null);
  let dragOverIdx = $state<number | null>(null);
  let isDragging = $state(false);

  // Toast
  let toastMessage = $state('');
  let toastTimeout: ReturnType<typeof setTimeout> | null = null;

  // ── Derived ──
  let sortedLayers = $derived(
    [...layers].sort(comparePromptLayers)
  );

  let editCharCount = $derived(editRawContent.length);
  let groupedRuntimeMacroHints = $derived(groupRuntimeMacroHints(runtimeMacroHints));

  let orderedRuntimeBlocks = $derived(
    [...runtimeBlocks].sort(compareRuntimeBlocks)
  );

  function syncRuntimeBlockDrafts(blocks: PromptRuntimeBlock[]) {
    runtimeBlockDrafts = Object.fromEntries(
      blocks
        .filter(block => block.companionEditable)
        .map(block => [block.id, block.customContent ?? '']),
    );
    runtimeBlockSaving = {};
    runtimeBlockMessages = {};
  }

  let constitutionPreviewText = $derived.by(() => {
    const sections: string[] = [];

    for (const block of constitutionImmutableBlocks) {
      const trimmed = block.content.trim();
      if (!trimmed) continue;
      sections.push(`[${block.title}]\n${trimmed}`);
    }

    if (constitutionCompanionLayer?.content) {
      const companion = constitutionCompanionLayer.content.trim();
      if (companion) sections.push(companion);
    }

    if (sections.length === 0) {
      return constitutionServerPreview;
    }
    return sections.join('\n\n');
  });

  let northStarPreviewText = $derived.by(() => {
    const preview = buildNorthStarPreview(northStarItems);
    return preview || northStarServerPreview;
  });
  let constitutionPreviewTokenCount = $derived(formatTokenCount(estimateTokens(constitutionPreviewText)));
  let northStarPreviewTokenCount = $derived(formatTokenCount(estimateTokens(northStarPreviewText)));

  let stackEntries = $derived.by((): StackEntry[] => {
    return buildStackEntries({
      constitutionPreviewText,
      constitutionImmutableBlockCount: constitutionImmutableBlocks.length,
      northStarPreviewText,
      northStarActiveCount: northStarItems.filter(item => item.enabled).length,
      northStarLimit,
      sortedLayers,
      orderedRuntimeBlocks,
    });
  });

  async function reorderRuntimeBlocks(runtimeBlockIds: string[]) {
    await apiPost<PromptUpdateResult>('/api/admin/prompts/reorder', { runtimeBlockIds });
  }

  async function saveRuntimeBlock(block: PromptRuntimeBlock) {
    if (!block.companionEditable) return;
    runtimeBlockSaving = { ...runtimeBlockSaving, [block.id]: true };
    runtimeBlockMessages = { ...runtimeBlockMessages, [block.id]: '' };
    error = '';
    try {
      const result = await saveRuntimePromptBlocks({
        blocks: [
          {
            id: block.id,
            content: runtimeBlockDrafts[block.id] ?? '',
          },
        ],
      });
      if (!result.ok) {
        runtimeBlockMessages = {
          ...runtimeBlockMessages,
          [block.id]: result.message || 'Failed to save runtime guidance',
        };
        error = result.message || 'Failed to save runtime guidance';
        return;
      }
      await refreshList();
      error = '';
      runtimeBlockMessages = {
        ...runtimeBlockMessages,
        [block.id]: result.message || 'Saved runtime guidance',
      };
      showToast(result.message || 'Runtime guidance saved');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to save runtime guidance';
      runtimeBlockMessages = { ...runtimeBlockMessages, [block.id]: message };
      error = message;
    } finally {
      runtimeBlockSaving = { ...runtimeBlockSaving, [block.id]: false };
    }
  }

  async function moveRuntimeBlock(blockId: string, direction: 'up' | 'down') {
    const idx = orderedRuntimeBlocks.findIndex(block => block.id === blockId);
    if (idx < 0) return;

    let swapIdx = idx;
    while (true) {
      swapIdx += direction === 'up' ? -1 : 1;
      if (swapIdx < 0 || swapIdx >= orderedRuntimeBlocks.length) return;
      if (orderedRuntimeBlocks[swapIdx]?.reorderable) break;
    }

    const nextOrder = buildReorderedRuntimeBlockIds(orderedRuntimeBlocks, idx, swapIdx);
    if (!nextOrder) return;
    try {
      await reorderRuntimeBlocks(nextOrder);
      await refreshList();
      showToast('Runtime prompt order updated');
    } catch (e2) {
      error = e2 instanceof Error ? e2.message : 'Failed to reorder runtime blocks';
    }
  }

  // ── Helpers ──
  function showToast(msg: string) {
    toastMessage = msg;
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toastMessage = ''; }, 3000);
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(`Copied: ${text}`);
    }).catch(() => {
      showToast('Failed to copy');
    });
  }

  function applyConstitutionSnapshot(snapshot: ConstitutionSnapshotData) {
    constitutionImmutableBlocks = snapshot.immutableBlocks ?? [];
    constitutionCompanionLayer = snapshot.companionLayer ?? null;
    constitutionServerPreview = snapshot.preview?.text ?? '';
  }

  function makeNorthStarClientKey(): string {
    return globalThis.crypto?.randomUUID?.() ?? `north-star-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function applyNorthStarSnapshot(snapshot: NorthStarSnapshotData) {
    northStarItems = (snapshot.items ?? []).map(item => ({
      ...item,
      clientKey: item.id,
    }));
    northStarLimit = snapshot.limit ?? 3;
    northStarServerPreview = snapshot.preview?.text ?? '';
    northStarSaveMessage = '';
  }

  function applyPromptListSnapshot(data: Awaited<ReturnType<typeof listPrompts>>) {
    layers = data?.layers ?? [];
    staticPrompts = data?.staticPrompts ?? [];
    runtimeBlocks = data?.runtimeBlocks ?? [];
    runtimeLayerCoverage = data?.runtimeLayerCoverage ?? { ok: true, entries: [] };
    runtimeMacroHints = data?.runtimeMacroHints ?? [];
    syncRuntimeBlockDrafts(runtimeBlocks);
  }

  async function refreshConstitution() {
    try {
      const snapshot = await getConstitutionSnapshot();
      applyConstitutionSnapshot(snapshot);
      constitutionError = '';
    } catch (e) {
      constitutionError = e instanceof Error ? e.message : 'Failed to load constitution snapshot';
    } finally {
      constitutionLoading = false;
    }
  }

  async function refreshNorthStar() {
    try {
      const snapshot = await getNorthStarSnapshot();
      applyNorthStarSnapshot(snapshot);
      northStarError = '';
    } catch (e) {
      northStarError = e instanceof Error ? e.message : 'Failed to load North Star goals';
    } finally {
      northStarLoading = false;
    }
  }

  function addNorthStarItem() {
    if (northStarItems.length >= northStarLimit) return;
    northStarItems = [
      ...northStarItems,
      {
        clientKey: makeNorthStarClientKey(),
        title: '',
        content: '',
        scope: 'shared',
        enabled: true,
        priority: northStarItems.length,
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin',
        checksum: '',
        version: 0,
      },
    ];
  }

  function updateNorthStarItem<T extends keyof NorthStarDraftItem>(
    clientKey: string,
    field: T,
    value: NorthStarDraftItem[T],
  ) {
    northStarItems = northStarItems.map(item => (
      item.clientKey === clientKey ? { ...item, [field]: value } : item
    ));
  }

  function removeNorthStarItem(clientKey: string) {
    northStarItems = northStarItems
      .filter(item => item.clientKey !== clientKey)
      .map((item, index) => ({ ...item, priority: index }));
  }

  function moveNorthStarItem(index: number, direction: 'up' | 'down') {
    const nextItems = reorderNorthStarItems(northStarItems, index, direction);
    if (nextItems === northStarItems) return;
    northStarItems = nextItems;
  }

  async function saveNorthStar() {
    northStarSaving = true;
    northStarError = '';
    northStarSaveMessage = '';
    try {
      const result = await saveNorthStarItems({
        items: northStarItems.map(item => ({
          ...(item.id ? { id: item.id } : {}),
          title: item.title.trim(),
          content: item.content.trim(),
          scope: item.scope,
          enabled: item.enabled,
        })),
      });
      if (!result.ok) {
        northStarError = result.message || 'Failed to save North Star goals';
        return;
      }
      if (result.snapshot) {
        applyNorthStarSnapshot(result.snapshot);
      } else {
        await refreshNorthStar();
      }
      northStarSaveMessage = result.message || 'Saved North Star goals';
      showToast('North Star updated');
    } catch (e) {
      northStarError = e instanceof Error ? e.message : 'Failed to save North Star goals';
    } finally {
      northStarSaving = false;
    }
  }

  // ── Lifecycle ──
  onMount(async () => {
    const [promptsResult, constitutionResult, northStarResult] = await Promise.allSettled([
      listPrompts(),
      getConstitutionSnapshot(),
      getNorthStarSnapshot(),
    ]);

    if (promptsResult.status === 'fulfilled') {
      applyPromptListSnapshot(promptsResult.value);
    } else {
      const reason = promptsResult.reason;
      error = reason instanceof Error ? reason.message : 'Failed to load prompts';
    }

    if (constitutionResult.status === 'fulfilled') {
      applyConstitutionSnapshot(constitutionResult.value);
      constitutionError = '';
    } else {
      const reason = constitutionResult.reason;
      constitutionError = reason instanceof Error
        ? reason.message
        : 'Failed to load constitution snapshot';
    }

    if (northStarResult.status === 'fulfilled') {
      applyNorthStarSnapshot(northStarResult.value);
      northStarError = '';
    } else {
      const reason = northStarResult.reason;
      northStarError = reason instanceof Error
        ? reason.message
        : 'Failed to load North Star goals';
    }
    loading = false;
    constitutionLoading = false;
    northStarLoading = false;
  });

  async function refreshList() {
    const data = await listPrompts();
    applyPromptListSnapshot(data);
    await Promise.all([refreshConstitution(), refreshNorthStar()]);
  }

  function isPromptLayerNotFoundError(errorValue: unknown): boolean {
    return errorValue instanceof Error && errorValue.message.includes('Prompt layer not found');
  }

  // ── Layer actions ──
  async function toggleExpand(layerId: string) {
    if (expandedLayerId === layerId) {
      expandedLayerId = null;
      detailData = null;
      editingContent = false;
      showDiff = false;
      saveMessage = '';
      return;
    }
    expandedLayerId = layerId;
    detailLoading = true;
    editingContent = false;
    showDiff = false;
    saveMessage = '';
    diffData = null;
    try {
      detailData = await getPromptDetail(layerId);
    } catch (e) {
      if (isPromptLayerNotFoundError(e)) {
        await refreshList();
        error = 'That prompt layer no longer exists. The stack was refreshed.';
      } else {
        error = e instanceof Error ? e.message : 'Failed to load layer detail';
      }
      expandedLayerId = null;
    } finally {
      detailLoading = false;
    }
  }

  async function handleToggle(layerId: string) {
    try {
      await togglePrompt(layerId);
      await refreshList();
      if (expandedLayerId === layerId && detailData?.layer) {
        detailData = await getPromptDetail(layerId);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to toggle layer';
    }
  }

  function startEditContent(layer: PromptLayer) {
    editRawContent = layer.content;
    editName = layer.name;
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
      const patch: Record<string, unknown> = { content: editRawContent };
      if (editName.trim()) patch.name = editName.trim();
      if (editIdentifier) patch.identifier = editIdentifier;
      if (editRole) patch.role = editRole;
      if (editPromptOrder !== undefined) patch.promptOrder = editPromptOrder;
      await updatePrompt(layerId, patch);
      await refreshList();
      detailData = await getPromptDetail(layerId);
      editingContent = false;
      saveMessage = 'Saved successfully';
      showToast('Prompt layer saved');
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
      showToast(`Rolled back to v${version}`);
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

  async function reorderLayers(layerIds: string[]) {
    await apiPost<PromptUpdateResult>('/api/admin/prompts/reorder', { layerIds });
  }

  // ── Drag-and-drop reorder ──
  function onDragStart(e: DragEvent, idx: number) {
    dragSourceIdx = idx;
    isDragging = true;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
    }
  }

  function onDragOver(e: DragEvent, idx: number) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dragOverIdx = idx;
  }

  function onDragLeave() {
    dragOverIdx = null;
  }

  async function onDrop(e: DragEvent, targetIdx: number) {
    e.preventDefault();
    isDragging = false;
    dragOverIdx = null;
    if (dragSourceIdx === null || dragSourceIdx === targetIdx) {
      dragSourceIdx = null;
      return;
    }

    const nextOrder = buildReorderedLayerIds(sortedLayers, dragSourceIdx, targetIdx);
    if (!nextOrder) {
      dragSourceIdx = null;
      return;
    }
    dragSourceIdx = null;

    try {
      await reorderLayers(nextOrder);
      await refreshList();
      showToast('Reordered');
    } catch (e2) {
      error = e2 instanceof Error ? e2.message : 'Failed to reorder';
    }
  }

  function onDragEnd() {
    isDragging = false;
    dragSourceIdx = null;
    dragOverIdx = null;
  }

  // Keyboard reorder
  async function moveLayer(layerId: string, direction: 'up' | 'down') {
    const idx = sortedLayers.findIndex(l => l.id === layerId);
    if (idx < 0) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sortedLayers.length) return;
    const nextOrder = buildReorderedLayerIds(sortedLayers, idx, swapIdx);
    if (!nextOrder) return;
    try {
      await reorderLayers(nextOrder);
      await refreshList();
    } catch (e2) {
      error = e2 instanceof Error ? e2.message : 'Failed to reorder';
    }
  }

  // ── New layer form ──
  let showNewLayerForm = $state(false);
  let newLayerName = $state('');
  let newLayerType = $state<'runtime' | 'channel' | 'task'>('runtime');
  let newLayerContent = $state('');
  let newLayerPriority = $state(10);
  let newLayerChannelType = $state('');
  let newLayerTaskKind = $state('');
  let creatingLayer = $state(false);

  function resetNewLayerForm() {
    newLayerName = '';
    newLayerType = 'runtime';
    newLayerContent = '';
    newLayerPriority = 10;
    newLayerChannelType = '';
    newLayerTaskKind = '';
  }

  async function handleCreateLayer() {
    if (!newLayerName.trim()) return;
    creatingLayer = true;
    try {
      const body: Record<string, unknown> = {
        name: newLayerName.trim(),
        type: newLayerType,
        content: newLayerContent,
        priority: newLayerPriority,
      };
      if (newLayerType === 'channel' && newLayerChannelType.trim()) {
        body.channelType = newLayerChannelType.trim();
      }
      if (newLayerType === 'task' && newLayerTaskKind.trim()) {
        body.taskKind = newLayerTaskKind.trim();
      }
      const result = await createPromptLayer(body);
      if (result.ok) {
        showToast(result.message || 'Layer created');
        showNewLayerForm = false;
        resetNewLayerForm();
        await refreshList();
      } else {
        error = result.message || 'Failed to create layer';
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to create layer';
    } finally {
      creatingLayer = false;
    }
  }
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">Prompt Soil</h1>
      <p class="text-sm text-shadow-600 mt-1">
        Layered prompt composition stack -- {layers.length} layer{layers.length === 1 ? '' : 's'}, {runtimeBlocks.length} runtime-derived, {staticPrompts.length} static
      </p>
    </div>
    <div class="flex items-center gap-3 text-sm text-shadow-600">
      <span>Total: ~{formatTokenCount(layers.reduce((sum, l) => sum + estimateTokens(l.content), 0))} tokens</span>
    </div>
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

  <!-- Toast -->
  {#if toastMessage}
    <div class="fixed bottom-6 right-6 z-50 px-4 py-2.5 rounded-lg bg-shadow-800 text-white text-sm shadow-lg transition-all">
      {toastMessage}
    </div>
  {/if}

  <!-- Loading -->
  {#if loading}
    <div class="space-y-2">
      {#each Array(5) as _}
        <div class="card-garden p-4 animate-pulse">
          <div class="flex items-center gap-3">
            <div class="h-5 w-6 bg-bark-300 rounded"></div>
            <div class="h-5 w-20 bg-bark-300 rounded"></div>
            <div class="h-4 bg-bark-300 rounded flex-1"></div>
            <div class="h-4 w-12 bg-bark-300 rounded"></div>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <ConstitutionBuilderPanel
      {showConstitutionSection}
      {constitutionLoading}
      {constitutionError}
      {constitutionImmutableBlocks}
      {constitutionCompanionLayer}
      {constitutionPreviewText}
      {constitutionPreviewTokenCount}
      onToggleConstitutionSection={() => showConstitutionSection = !showConstitutionSection}
    />

    <NorthStarEditorPanel
      {showNorthStarSection}
      {northStarLoading}
      {northStarError}
      {northStarItems}
      {northStarLimit}
      {northStarPreviewText}
      {northStarPreviewTokenCount}
      {northStarSaving}
      {northStarSaveMessage}
      onToggleNorthStarSection={() => showNorthStarSection = !showNorthStarSection}
      {addNorthStarItem}
      {moveNorthStarItem}
      {removeNorthStarItem}
      {updateNorthStarItem}
      {saveNorthStar}
    />

    <!-- ─── Prompt Composition Stack ─── -->
    <div>
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-3">
          <h2 class="text-base font-serif font-semibold text-shadow-800">Composition Stack</h2>
          <span class="text-sm text-shadow-600">Drag prompt layers to reorder. Runtime-derived participants are listed with their actual placement metadata and separate ordering controls.</span>
        </div>
        <button
          onclick={() => { showNewLayerForm = !showNewLayerForm; if (!showNewLayerForm) resetNewLayerForm(); }}
          class="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-bark-300 text-shadow-700 hover:bg-bark-100 hover:border-gold-300 transition-colors font-medium"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {showNewLayerForm ? 'Cancel' : 'New Layer'}
        </button>
      </div>

      <!-- New Layer Form -->
      {#if showNewLayerForm}
        <div class="card-garden p-5 mb-3 filigree-border-strong">
          <h3 class="text-sm font-serif font-semibold text-shadow-800 mb-3">Create New Prompt Layer</h3>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
            <label class="block">
              <span class="block text-sm font-medium text-shadow-700 mb-1">Name <span class="text-wilt-500">*</span></span>
              <input type="text" bind:value={newLayerName} placeholder="My Custom Layer"
                class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400" />
            </label>
            <label class="block">
              <span class="block text-sm font-medium text-shadow-700 mb-1">Type <span class="text-wilt-500">*</span></span>
              <select bind:value={newLayerType}
                class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400">
                <option value="runtime">Runtime</option>
                <option value="channel">Channel</option>
                <option value="task">Task</option>
              </select>
            </label>
            <label class="block">
              <span class="block text-sm font-medium text-shadow-700 mb-1">Priority</span>
              <input type="number" min="0" step="1" bind:value={newLayerPriority}
                class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400" />
            </label>
          </div>

          {#if newLayerType === 'channel'}
            <label class="block mb-3">
              <span class="block text-sm font-medium text-shadow-700 mb-1">Channel Type <span class="text-shadow-500">(optional -- e.g. discord_text, api, admin)</span></span>
              <input type="text" bind:value={newLayerChannelType} placeholder="discord_text"
                class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400" />
            </label>
          {/if}
          {#if newLayerType === 'task'}
            <label class="block mb-3">
              <span class="block text-sm font-medium text-shadow-700 mb-1">Task Kind <span class="text-shadow-500">(optional -- e.g. heartbeat, reflection)</span></span>
              <input type="text" bind:value={newLayerTaskKind} placeholder="heartbeat"
                class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400" />
            </label>
          {/if}

          <label class="block mb-3">
            <span class="block text-sm font-medium text-shadow-700 mb-1">Content</span>
            <textarea
              bind:value={newLayerContent}
              rows={6}
              placeholder="Enter prompt content..."
              class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm font-mono resize-vertical leading-relaxed focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
            ></textarea>
            <span class="text-sm text-shadow-600 mt-1">{newLayerContent.length} chars | ~{formatTokenCount(estimateTokens(newLayerContent))} tokens</span>
          </label>

          <div class="flex items-center gap-2">
            <button
              onclick={handleCreateLayer}
              disabled={creatingLayer || !newLayerName.trim()}
              class="px-4 py-1.5 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors"
            >
              {creatingLayer ? 'Creating...' : 'Create Layer'}
            </button>
            <button
              onclick={() => { showNewLayerForm = false; resetNewLayerForm(); }}
              data-esc-close
              class="px-3 py-1.5 rounded-lg text-shadow-700 text-sm hover:bg-bark-200 transition-colors border border-bark-300"
            >
              Cancel
            </button>
          </div>
        </div>
      {/if}

      <div class="space-y-1">
        {#each stackEntries as entry}
          {#if entry.kind === 'fixed'}
            {@const fixed = entry.fixed}
            <div class="card-garden overflow-hidden border-bark-300 bg-bark-50">
              <div class="px-3 py-3 flex items-start gap-3">
                <div class="flex items-center justify-center w-8 h-8 shrink-0 rounded-lg bg-bark-200 text-shadow-700">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                </div>
                <div class="min-w-0 flex-1 space-y-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wider bg-bark-400 text-white">
                      {fixed.label}
                    </span>
                    <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-bark-200 text-shadow-700">
                      Fixed Position
                    </span>
                    <span class="text-sm text-shadow-600">{fixed.status}</span>
                    <span class="ml-auto text-sm font-mono text-shadow-600 shrink-0">
                      {formatTokenCount(fixed.tokenCount)}t
                    </span>
                  </div>
                  <p class="text-sm text-shadow-700">{fixed.description}</p>
                  <pre class="text-xs font-mono text-shadow-700 whitespace-pre-wrap bg-white/70 p-2 rounded border border-bark-200 max-h-28 overflow-y-auto leading-relaxed">{fixed.preview}</pre>
                </div>
              </div>
            </div>
          {:else if entry.kind === 'runtime'}
            {@const block = entry.block}
            {@const canMoveUp = block.reorderable && orderedRuntimeBlocks.slice(0, entry.idx).some(candidate => candidate.reorderable)}
            {@const canMoveDown = block.reorderable && orderedRuntimeBlocks.slice(entry.idx + 1).some(candidate => candidate.reorderable)}
            <div class="card-garden overflow-hidden border-dashed border-bark-400 bg-bark-50">
              <div class="px-3 py-3 flex items-start gap-3">
                <div class="flex items-center justify-center w-8 h-8 shrink-0 rounded-lg bg-bark-200 text-shadow-700">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M13 10V3L4 14h7v7l9-11h-7z"/>
                  </svg>
                </div>
                <div class="min-w-0 flex-1 space-y-1.5">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wider {runtimePlacementBadge(block)}">
                      {runtimePlacementLabel(block)}
                    </span>
                    <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-bark-200 text-shadow-700">
                      {runtimeVisibilityLabel(block)}
                    </span>
                    {#if block.reorderable}
                      <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-gold-200 text-shadow-800">
                        Sortable
                      </span>
                    {:else}
                      <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-bark-300 text-shadow-700">
                        Fixed
                      </span>
                    {/if}
                    <span class="text-sm font-medium text-shadow-800">{block.label}</span>
                    <span class="ml-auto text-sm font-mono text-shadow-600 shrink-0">
                      #{block.effectiveOrder + 1}
                    </span>
                  </div>
                  <p class="text-sm text-shadow-700">{block.description}</p>
                  <div class="flex flex-wrap items-center gap-3 text-sm text-shadow-600">
                    <span>Source: <span class="font-mono text-shadow-800">{block.source}</span></span>
                    <span>Content: <span class="text-shadow-800">{block.contentVisible ? 'visible' : 'hidden in /prompts'}</span></span>
                    <span>Status: <span class="text-shadow-800">{runtimeBlockStatusLabel(block)}</span></span>
                    {#if block.lockedReason}
                      <span>{block.lockedReason}</span>
                    {/if}
                  </div>
                </div>
                {#if block.reorderable}
                  <div class="flex flex-col gap-1 shrink-0">
                    <button
                      onclick={() => moveRuntimeBlock(block.id, 'up')}
                      disabled={!canMoveUp}
                      class="px-2 py-0.5 rounded border border-bark-300 text-sm text-shadow-700 hover:bg-bark-100 disabled:opacity-40"
                    >
                      Up
                    </button>
                    <button
                      onclick={() => moveRuntimeBlock(block.id, 'down')}
                      disabled={!canMoveDown}
                      class="px-2 py-0.5 rounded border border-bark-300 text-sm text-shadow-700 hover:bg-bark-100 disabled:opacity-40"
                    >
                      Down
                    </button>
                  </div>
                {/if}
              </div>

              {#if block.companionEditable}
                <div class="border-t border-dashed border-bark-300 bg-white/70 px-3 py-3 space-y-3">
                  <div class="flex items-center justify-between gap-3 flex-wrap">
                    <div class="space-y-0.5">
                      <p class="text-sm font-medium text-shadow-800">Companion override</p>
                      <p class="text-xs text-shadow-600">
                        This content is appended to the built-in runtime guidance for this block. Immutable safety content is not editable here.
                      </p>
                    </div>
                    <div class="flex items-center gap-2 text-xs text-shadow-600">
                      <span class="px-1.5 py-0.5 rounded bg-bark-200 text-shadow-700 uppercase tracking-wider font-bold">
                        Bounded
                      </span>
                      <span class="px-1.5 py-0.5 rounded bg-gold-100 text-shadow-700 uppercase tracking-wider font-bold">
                        Companion-tunable
                      </span>
                    </div>
                  </div>

                  <label class="block">
                    <span class="block text-sm font-medium text-shadow-700 mb-1">Override text</span>
                    <textarea
                      rows={5}
                      value={runtimeBlockDrafts[block.id] ?? ''}
                      oninput={(e) => {
                        runtimeBlockDrafts = {
                          ...runtimeBlockDrafts,
                          [block.id]: (e.target as HTMLTextAreaElement).value,
                        };
                        runtimeBlockMessages = {
                          ...runtimeBlockMessages,
                          [block.id]: '',
                        };
                      }}
                      class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm font-mono resize-vertical leading-relaxed focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                      placeholder="Add companion-specific guidance for this runtime block..."
                    ></textarea>
                  </label>

                  <div class="flex items-center gap-3">
                    <button
                      onclick={() => saveRuntimeBlock(block)}
                      disabled={runtimeBlockSaving[block.id]}
                      class="px-3 py-1.5 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors"
                    >
                      {runtimeBlockSaving[block.id] ? 'Saving...' : 'Save block'}
                    </button>
                    {#if runtimeBlockMessages[block.id]}
                      <span class="text-sm text-moss-700">{runtimeBlockMessages[block.id]}</span>
                    {/if}
                  </div>
                </div>
              {/if}
            </div>
          {:else}
            {@const layer = entry.layer}
            {@const idx = entry.idx}
            {@const badge = layerBadge(layer.type)}
            {@const rBadge = roleBadge(layer.role)}
            {@const isExpanded = expandedLayerId === layer.id}
            {@const locked = isProtected(layer)}
            {@const tokens = estimateTokens(layer.content)}
            {@const isDragSource = dragSourceIdx === idx}
            {@const isDragTarget = dragOverIdx === idx}

            <div
              class="card-garden overflow-hidden transition-all duration-150
                {!layer.enabled ? 'opacity-40' : ''}
                {isExpanded ? 'filigree-border-strong ring-1 ring-gold-300' : ''}
                {isDragSource ? 'opacity-50 scale-[0.98]' : ''}
                {isDragTarget ? 'ring-2 ring-gold-400 ring-offset-1' : ''}"
              draggable={layers.length > 1}
              ondragstart={(e) => onDragStart(e, idx)}
              ondragover={(e) => onDragOver(e, idx)}
              ondragleave={() => onDragLeave()}
              ondrop={(e) => onDrop(e, idx)}
              ondragend={() => onDragEnd()}
              role="listitem"
            >
              <!-- Layer header row -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="w-full text-left px-3 py-2.5 flex items-center gap-2.5 hover:bg-bark-100 transition-colors cursor-pointer select-none"
                onclick={() => toggleExpand(layer.id)}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(layer.id); }
                  if (e.key === 'ArrowUp' && e.altKey) { e.preventDefault(); moveLayer(layer.id, 'up'); }
                  if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); moveLayer(layer.id, 'down'); }
                }}
                role="button"
                tabindex="0"
              >
                <!-- Drag handle -->
                <span
                  class="flex items-center justify-center w-6 h-6 shrink-0 rounded text-shadow-500 cursor-grab hover:text-gold-600 hover:bg-bark-200"
                  title="Drag to reorder"
                >
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="4" y="5" width="16" height="2" rx="1"/>
                    <rect x="4" y="11" width="16" height="2" rx="1"/>
                    <rect x="4" y="17" width="16" height="2" rx="1"/>
                  </svg>
                </span>

                <!-- Type badge -->
                <span class="px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wider shrink-0 {badge.bg} {badge.text}">
                  {badge.label}
                </span>

                <!-- Name -->
                <span class="font-serif font-medium text-sm text-shadow-800 min-w-0 truncate">{layer.name}</span>

                <!-- Role badge -->
                {#if rBadge}
                  <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider shrink-0 {rBadge.cls}">
                    {rBadge.label}
                  </span>
                {/if}

                <span class="flex-1"></span>

                <!-- Token count -->
                <span class="text-sm font-mono text-shadow-600 shrink-0" title="{tokens} tokens (~{layer.content.length} chars)">
                  {formatTokenCount(tokens)}t
                </span>

                <!-- Version -->
                <span class="text-sm font-mono text-shadow-600 shrink-0">v{layer.version}</span>

                <!-- Toggle switch or lock -->
                {#if locked}
                  <svg class="w-4 h-4 text-shadow-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <title>Protected layer</title>
                    <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                {:else}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
                    <button
                      onclick={() => handleToggle(layer.id)}
                      class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-gold-300 focus:ring-offset-1 {layer.enabled ? 'bg-moss-500' : 'bg-bark-400'}"
                      role="switch"
                      aria-checked={layer.enabled}
                      title={layer.enabled ? 'Disable layer' : 'Enable layer'}
                    >
                      <span class="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out {layer.enabled ? 'translate-x-4' : 'translate-x-0'}"></span>
                    </button>
                  </div>
                {/if}

                <!-- Expand/collapse chevron -->
                <svg class="w-4 h-4 text-shadow-500 shrink-0 transition-transform duration-200 {isExpanded ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M19 9l-7 7-7-7" />
                </svg>
              </div>

              <!-- Expanded inline editor -->
              {#if isExpanded}
                <div class="border-t border-bark-300">
                  {#if detailLoading}
                    <div class="p-5 animate-pulse space-y-3">
                      <div class="h-4 bg-bark-300 rounded w-1/3"></div>
                      <div class="h-20 bg-bark-300 rounded"></div>
                    </div>
                  {:else if detailData?.layer}
                    {@const dl = detailData.layer}
                    <div class="p-5 space-y-5">
                      {#if !editingContent}
                        <!-- Read-only metadata -->
                        <div class="flex flex-wrap items-center gap-3 text-sm">
                          <span class="text-shadow-600">Type: <span class="text-shadow-800 font-medium capitalize">{dl.type}</span></span>
                          <span class="text-shadow-300">|</span>
                          <span class="text-shadow-600">Priority: <span class="text-shadow-800 font-mono">{dl.priority}</span></span>
                          <span class="text-shadow-300">|</span>
                          <span class="text-shadow-600">Role: <span class="text-shadow-800">{dl.role ?? 'system'}</span></span>
                          <span class="text-shadow-300">|</span>
                          <span class="text-shadow-600">Version: <span class="text-shadow-800 font-mono">v{dl.version}</span></span>
                          <span class="text-shadow-300">|</span>
                          <span class="text-shadow-600">Updated: <span class="text-shadow-800">{dl.updatedAt ? new Date(dl.updatedAt).toLocaleString() : 'unknown'}</span></span>
                          <span class="text-shadow-300">|</span>
                          <span class="text-shadow-600">By: <span class="text-shadow-800">{dl.updatedBy ?? 'unknown'}</span></span>
                          {#if dl.checksum}
                            <span class="text-shadow-300">|</span>
                            <span class="text-shadow-600">Checksum: <span class="font-mono text-shadow-700">{dl.checksum.slice(0, 12)}</span></span>
                          {/if}
                          {#if dl.identifier}
                            <span class="text-shadow-300">|</span>
                            <span class="text-shadow-600">ID: <span class="font-mono text-shadow-800">{dl.identifier}</span></span>
                          {/if}
                          {#if dl.promptOrder !== undefined && dl.promptOrder !== null}
                            <span class="text-shadow-300">|</span>
                            <span class="text-shadow-600">Order: <span class="font-mono text-shadow-800">{dl.promptOrder}</span></span>
                          {/if}
                        </div>

                        <!-- Content display -->
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
                              <button
                                onclick={() => startEditContent(dl)}
                                class="text-sm text-gold-600 hover:text-gold-700 hover:underline font-medium"
                              >
                                Edit
                              </button>
                            </div>
                          </div>

                          <!-- Diff view -->
                          {#if showDiff && diffData}
                            {@const diffLines = computeDiffLines(diffData.oldContent, diffData.newContent)}
                            <div class="mb-3 rounded-lg border border-bark-300 overflow-hidden">
                              <div class="px-3 py-2 bg-bark-200 text-sm text-shadow-700 font-medium">Diff: Previous vs Current</div>
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

                          <!-- Read-only content -->
                          <div class="relative">
                            {#if locked}
                              <div class="absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded text-sm bg-bark-200 text-shadow-600">
                                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                  <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                </svg>
                                Protected
                              </div>
                            {/if}
                            <pre class="text-sm font-mono text-shadow-800 whitespace-pre-wrap bg-bark-100 p-3 rounded-lg max-h-72 overflow-y-auto leading-relaxed {locked ? 'border border-bark-300' : ''}">{dl.content ?? ''}</pre>
                            <div class="flex justify-between mt-1.5">
                              <span class="text-sm text-shadow-600">{(dl.content ?? '').length} chars</span>
                              <span class="text-sm text-shadow-600">~{formatTokenCount(estimateTokens(dl.content ?? ''))} tokens</span>
                            </div>
                          </div>
                        </div>

                      {:else}
                        <!-- ── Edit mode ── -->
                        <div class="space-y-4">
                          <!-- Metadata fields -->
                          <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
                            <label class="block">
                              <span class="block text-sm font-medium text-shadow-700 mb-1">Name</span>
                              <input type="text" bind:value={editName} disabled={locked}
                                class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400 disabled:opacity-50 disabled:cursor-not-allowed" />
                            </label>
                            <label class="block">
                              <span class="block text-sm font-medium text-shadow-700 mb-1">Role</span>
                              <select bind:value={editRole}
                                class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400">
                                <option value="">system (default)</option>
                                <option value="system">system</option>
                                <option value="user">user</option>
                                <option value="assistant">assistant</option>
                              </select>
                            </label>
                            <label class="block">
                              <span class="block text-sm font-medium text-shadow-700 mb-1">Identifier</span>
                              <input type="text" bind:value={editIdentifier} placeholder="main"
                                class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400" />
                            </label>
                            <label class="block">
                              <span class="block text-sm font-medium text-shadow-700 mb-1">Prompt Order</span>
                              <input type="number" min="0" step="1"
                                value={editPromptOrder ?? ''}
                                onchange={(e) => { const v = (e.target as HTMLInputElement).value; editPromptOrder = v ? Number(v) : undefined; }}
                                class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400" />
                            </label>
                          </div>

                          <!-- Content editor -->
                          <textarea
                            bind:value={editRawContent}
                            rows={14}
                            class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm font-mono resize-vertical leading-relaxed focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                          ></textarea>

                          <!-- Edit footer -->
                          <div class="flex items-center justify-between">
                            <div class="flex items-center gap-4 text-sm text-shadow-600">
                              <span>{editCharCount} chars</span>
                              <span>~{formatTokenCount(Math.ceil(editCharCount / 4))} tokens</span>
                            </div>
                            <div class="flex gap-2">
                              <button
                                onclick={() => { editingContent = false; saveMessage = ''; }}
                                data-esc-close
                                class="px-3 py-1.5 rounded-lg text-shadow-700 text-sm hover:bg-bark-200 transition-colors border border-bark-300"
                              >
                                Cancel
                              </button>
                              <button
                                onclick={() => saveContent(dl.id)}
                                disabled={savingContent}
                                class="px-4 py-1.5 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors"
                              >
                                {savingContent ? 'Saving...' : 'Save'}
                              </button>
                            </div>
                          </div>
                        </div>
                      {/if}

                      {#if saveMessage}
                        <p class="text-sm text-moss-600">{saveMessage}</p>
                      {/if}

                      <!-- Version history + rollback -->
                      {#if detailData?.layerHistory && detailData.layerHistory.length > 0 && !editingContent}
                        <div>
                          <span class="text-sm font-medium text-shadow-700 uppercase tracking-wider">Version History</span>
                          <p class="text-sm text-shadow-600 mt-0.5 mb-2">{detailData.layerHistory.length} version{detailData.layerHistory.length === 1 ? '' : 's'}</p>
                          <div class="space-y-1.5 max-h-48 overflow-y-auto">
                            {#each detailData.layerHistory as entry (entry.version)}
                              {@const isCurrent = entry.version === dl.version}
                              <div class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm {isCurrent ? 'bg-gold-50 border border-gold-300' : 'bg-bark-100'}">
                                <span class="font-mono font-medium {isCurrent ? 'text-gold-700' : 'text-shadow-800'}">v{entry.version}</span>
                                <span class="text-shadow-700">{entry.timestamp ? new Date(entry.timestamp).toLocaleString() : 'unknown'}</span>
                                <span class="text-shadow-600">{entry.updatedBy ?? 'unknown'}</span>
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
          {/if}
        {/each}

        {#if sortedLayers.length === 0}
          <div class="card-garden p-8 text-center text-shadow-600 italic">
            No prompt layers configured
          </div>
        {/if}
      </div>
    </div>

    <!-- ─── Macro Catalog ─── -->
    <hr class="divider-filigree my-6" />

    <div class="card-garden overflow-hidden">
      <button
        onclick={() => showMacroCatalog = !showMacroCatalog}
        class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
      >
        <div class="flex items-center gap-3">
          <span class="flex items-center justify-center w-7 h-7 rounded-full bg-gold-100 text-gold-700 text-sm font-bold border border-gold-300">{'{}'}</span>
          <h2 class="text-sm font-serif font-semibold text-shadow-800">Macro Catalog</h2>
          <span class="text-sm text-shadow-600">{runtimeMacroHints.length} runtime macros</span>
        </div>
        <svg class="w-4 h-4 text-shadow-600 transition-transform {showMacroCatalog ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {#if showMacroCatalog}
        <div class="border-t border-bark-300">
          <div class="px-5 py-3 bg-bark-50 border-b border-bark-200">
            <p class="text-sm text-shadow-700 leading-relaxed">
              Prefer the atomic-signal-plus-prose pattern: reach for booleans, labels, counts, and short fragments first, then wrap them in companion-authored prose inside the layer template. The families below mirror the live runtime payload.
            </p>
          </div>
          <div class="grid gap-0 divide-y divide-bark-200">
            {#each groupedRuntimeMacroHints as section}
              <div>
                <div class="px-5 py-3.5 bg-bark-50 border-b border-bark-200">
                  <div class="flex items-center justify-between gap-4">
                    <h3 class="text-sm font-semibold text-shadow-800 uppercase tracking-[0.16em]">{section.label}</h3>
                    <span class="text-sm text-shadow-500">{section.hints.length} macro{section.hints.length === 1 ? '' : 's'}</span>
                  </div>
                  <p class="mt-1 text-sm text-shadow-600 leading-relaxed">{section.rationale}</p>
                </div>
                <div class="grid gap-0 divide-y divide-bark-200">
                  {#each section.hints as macro}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div
                      class="flex items-center gap-4 px-5 py-3 hover:bg-bark-100 transition-colors cursor-pointer group"
                      onclick={() => copyToClipboard(macro.token)}
                      onkeydown={(e) => { if (e.key === 'Enter') copyToClipboard(macro.token); }}
                      role="button"
                      tabindex="0"
                      title="Click to copy"
                    >
                      <code class="text-sm font-mono text-gold-700 bg-gold-50 px-2 py-0.5 rounded border border-gold-200 shrink-0 group-hover:bg-gold-100 transition-colors">
                        {macro.token}
                      </code>
                      <span class="text-sm text-shadow-700 flex-1">{macro.description}</span>
                      <code class="text-sm font-mono text-shadow-500 hidden sm:inline shrink-0">{macro.example}</code>
                      <svg class="w-4 h-4 text-shadow-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
                      </svg>
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
