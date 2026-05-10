<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    bulkDeleteMemories,
    bulkUpdateMemories,
    deleteMemory,
    getMemoryDetail,
    getManagedMemoryScopeDetail,
    getMemoryLinks,
    linkMemories,
    listManagedMemoryScopes,
    listMemories,
    searchMemories,
    unlinkMemories,
    updateMemoryScope,
  } from '$lib/api/endpoints/memory';
  import type {
    AdminBulkMutationResult,
    AdminMemoryContactSummary,
    AdminMemoryDetailData,
    AdminMemoryLink,
    AdminMemoryListData,
    AdminMemorySearchResult,
    AdminMemoryScopeDetailData,
    AdminMemoryScopeSummary,
    AdminUiPurrMemory,
  } from '$lib/types';

  const MEMORY_TYPES = ['', 'episodic', 'semantic', 'emotional', 'procedural', 'reflection', 'relational'];
  const SENSITIVITY_LEVELS = ['', 'public', 'personal', 'intimate', 'confidential'];
  const MEMORY_LINK_TYPES = ['related', 'supports', 'conflicts', 'sequence', 'causal'];
  const MANAGED_SCOPE_KINDS = [
    { value: 'project', label: 'Project' },
    { value: 'north_star', label: 'North Star' },
  ] as const;
  const PAGE_SIZE = 20;

  let data = $state<AdminMemoryListData | null>(null);
  let searchResults = $state<AdminMemorySearchResult | null>(null);
  let error = $state('');
  let loading = $state(true);
  let actionMessage = $state('');
  let actionOk = $state(true);

  let typeFilter = $state('');
  let sensitivityFilter = $state('');
  let startDateFilter = $state('');
  let endDateFilter = $state('');
  let searchQuery = $state('');
  let searchActive = $state(false);
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  let searchRequestId = 0;
  let offset = $state(0);

  let detailModalId = $state<string | null>(null);
  let detailModalData = $state<AdminMemoryDetailData | null>(null);
  let detailModalLoading = $state(false);
  let detailModalError = $state('');
  let detailMemoryId = $derived(detailModalData?.memory.id ?? '');

  let supersedeConfirmId = $state<string | null>(null);
  let selectedIds = $state<string[]>([]);
  let bulkMemoryType = $state('');
  let bulkSensitivity = $state('');
  let linksById = $state<Record<string, AdminMemoryLink[]>>({});
  let linkTargetById = $state<Record<string, string>>({});
  let linkTypeById = $state<Record<string, string>>({});
  let loadingLinksFor = $state<string | null>(null);
  let managedScopes = $state<AdminMemoryScopeSummary[]>([]);
  let managedScopeLoading = $state(false);
  let managedScopeError = $state('');
  let managedScopeKindFilter = $state<'project' | 'north_star'>('project');
  let selectedManagedScopeKey = $state<string | null>(null);
  let selectedManagedScopeDetail = $state<AdminMemoryScopeDetailData | null>(null);
  let selectedManagedScopeLoading = $state(false);
  let selectedManagedScopeError = $state('');
  let scopeEditorRefLabel = $state('');
  let scopeEditorTags = $state('');
  let scopeMutating = $state(false);

  let selectedCount = $derived(selectedIds.length);

  let contactsById = $derived<Record<string, AdminMemoryContactSummary>>(
    searchActive && searchResults ? searchResults.contactsById :
    data ? data.contactsById : {}
  );

  let memories = $derived<AdminUiPurrMemory[]>(
    searchActive && searchResults ? searchResults.results :
    data ? data.memories : []
  );

  // Memory type badge colors (from htmx admin)
  const TYPE_COLORS: Record<string, { bg: string; text: string }> = {
    episodic:    { bg: '#8B7355', text: 'white' },
    semantic:    { bg: '#4A7C59', text: 'white' },
    emotional:   { bg: '#C44569', text: 'white' },
    procedural:  { bg: '#6C5B7B', text: 'white' },
    reflection:  { bg: '#F7B731', text: '#3a2e0a' },
    relational:  { bg: '#4A5C8B', text: 'white' },
  };

  // Memory sensitivity badge colors
  const SENSITIVITY_COLORS: Record<string, { bg: string; text: string }> = {
    public:       { bg: '#4A5C8B', text: 'white' },
    personal:     { bg: '#6C5B7B', text: 'white' },
    intimate:     { bg: '#C44569', text: 'white' },
    confidential: { bg: '#8F3B3B', text: 'white' },
  };

  function flash(ok: boolean, msg: string) {
    actionOk = ok;
    actionMessage = msg;
    setTimeout(() => { actionMessage = ''; }, 4000);
  }

  function hasInvalidDateRange(): boolean {
    return Boolean(startDateFilter && endDateFilter && startDateFilter > endDateFilter);
  }

  function isSelected(id: string): boolean {
    return selectedIds.includes(id);
  }

  function toggleSelected(id: string): void {
    if (isSelected(id)) {
      selectedIds = selectedIds.filter(existing => existing !== id);
      return;
    }
    selectedIds = [...selectedIds, id];
  }

  function clearSelection(): void {
    selectedIds = [];
  }

  function selectVisible(): void {
    const visible = memories.map(memory => memory.id);
    selectedIds = [...new Set([...selectedIds, ...visible])];
  }

  function toggleSelectVisible(): void {
    const visible = memories.map(memory => memory.id);
    const allVisibleSelected = visible.length > 0 && visible.every(id => selectedIds.includes(id));
    if (allVisibleSelected) {
      selectedIds = selectedIds.filter(id => !visible.includes(id));
      return;
    }
    selectVisible();
  }

  function applyListFilters(): void {
    if (hasInvalidDateRange()) {
      flash(false, 'Start date must be before or equal to end date');
      return;
    }
    offset = 0;
    void loadMemories();
  }

  function clearListFilters(): void {
    typeFilter = '';
    sensitivityFilter = '';
    startDateFilter = '';
    endDateFilter = '';
    offset = 0;
    void loadMemories();
  }

  async function loadMemories() {
    searchRequestId += 1;
    if (searchDebounce) {
      clearTimeout(searchDebounce);
      searchDebounce = null;
    }
    loading = true;
    error = '';
    searchActive = false;
    searchResults = null;

    if (hasInvalidDateRange()) {
      error = 'Start date must be before or equal to end date.';
      loading = false;
      return;
    }

    try {
      data = await listMemories({
        type: typeFilter || undefined,
        sensitivity: sensitivityFilter || undefined,
        startDate: startDateFilter || undefined,
        endDate: endDateFilter || undefined,
        limit: PAGE_SIZE,
        offset,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load memories';
    } finally {
      loading = false;
    }
  }

  async function handleSearch() {
    if (searchDebounce) {
      clearTimeout(searchDebounce);
      searchDebounce = null;
    }
    const trimmedQuery = searchQuery.trim();
    if (!trimmedQuery) {
      searchActive = false;
      searchResults = null;
      return;
    }
    const requestId = ++searchRequestId;
    loading = true;
    error = '';
    try {
      const nextResults = await searchMemories(trimmedQuery);
      if (requestId !== searchRequestId) return;
      searchResults = nextResults;
      searchActive = true;
    } catch (e) {
      if (requestId !== searchRequestId) return;
      error = e instanceof Error ? e.message : 'Search failed';
    } finally {
      if (requestId !== searchRequestId) return;
      loading = false;
    }
  }

  function closeDetailModal(): void {
    detailModalId = null;
    detailModalData = null;
    detailModalLoading = false;
    detailModalError = '';
    supersedeConfirmId = null;
    scopeEditorRefLabel = '';
    scopeEditorTags = '';
  }

  async function openDetailModal(id: string): Promise<void> {
    detailModalId = id;
    detailModalData = null;
    detailModalError = '';
    detailModalLoading = true;
    supersedeConfirmId = null;

    try {
      detailModalData = await getMemoryDetail(id);
      syncScopeEditorFromDetail();
      await ensureLinksLoaded(id);
    } catch (e) {
      detailModalError = e instanceof Error ? e.message : 'Failed to load memory detail';
    } finally {
      detailModalLoading = false;
    }
  }

  function queueSearch() {
    if (searchDebounce) {
      clearTimeout(searchDebounce);
      searchDebounce = null;
    }
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      if (searchActive || searchResults) {
        searchActive = false;
        searchResults = null;
        void loadMemories();
      }
      return;
    }
    if (trimmed.length < 2) {
      if (searchActive || searchResults) {
        searchActive = false;
        searchResults = null;
        void loadMemories();
      }
      return;
    }
    searchDebounce = setTimeout(() => {
      searchDebounce = null;
      void handleSearch();
    }, 320);
  }

  async function handleSupersede(id: string) {
    try {
      await deleteMemory(id);
      supersedeConfirmId = null;
      selectedIds = selectedIds.filter(existing => existing !== id);
      if (detailModalId === id) {
        closeDetailModal();
      }
      flash(true, 'Memory superseded successfully');
      await loadMemories();
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Supersede failed');
    }
  }

  async function handleBulkDelete() {
    if (selectedIds.length === 0) {
      flash(false, 'Select at least one memory');
      return;
    }
    if (!window.confirm(`Supersede ${selectedIds.length} selected memories?`)) return;
    try {
      const result: AdminBulkMutationResult = await bulkDeleteMemories(selectedIds);
      flash(true, `Superseded ${result.count} memories`);
      clearSelection();
      await loadMemories();
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Bulk delete failed');
    }
  }

  async function handleBulkUpdate() {
    if (selectedIds.length === 0) {
      flash(false, 'Select at least one memory');
      return;
    }
    if (!bulkMemoryType && !bulkSensitivity) {
      flash(false, 'Choose a memory type and/or sensitivity');
      return;
    }
    try {
      const result = await bulkUpdateMemories(selectedIds, {
        ...(bulkMemoryType ? { memoryType: bulkMemoryType } : {}),
        ...(bulkSensitivity ? { sensitivity: bulkSensitivity } : {}),
      });
      flash(true, `Updated ${result.count} memories`);
      await loadMemories();
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Bulk update failed');
    }
  }

  async function ensureLinksLoaded(id: string) {
    if (linksById[id] !== undefined) return;
    loadingLinksFor = id;
    try {
      const result = await getMemoryLinks(id);
      linksById = {
        ...linksById,
        [id]: result.links ?? [],
      };
    } catch {
      linksById = {
        ...linksById,
        [id]: [],
      };
    } finally {
      if (loadingLinksFor === id) {
        loadingLinksFor = null;
      }
    }
  }

  async function handleLinkMemory(id: string) {
    const targetId = (linkTargetById[id] ?? '').trim();
    const linkType = (linkTypeById[id] ?? 'related').trim() || 'related';
    if (!targetId) {
      flash(false, 'Target memory ID is required');
      return;
    }
    if (targetId === id) {
      flash(false, 'Cannot link a memory to itself');
      return;
    }

    try {
      const result = await linkMemories(id, targetId, linkType);
      if (!result.ok) {
        flash(false, result.message ?? 'Failed to create link');
        return;
      }
      linkTargetById = { ...linkTargetById, [id]: '' };
      await ensureLinksLoaded(id);
      const refreshed = await getMemoryLinks(id);
      linksById = {
        ...linksById,
        [id]: refreshed.links ?? [],
      };
      flash(true, 'Memory link created');
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Failed to create link');
    }
  }

  async function handleUnlinkMemory(memoryId: string, id1: string, id2: string) {
    try {
      await unlinkMemories(id1, id2);
      const refreshed = await getMemoryLinks(memoryId);
      linksById = {
        ...linksById,
        [memoryId]: refreshed.links ?? [],
      };
      flash(true, 'Memory link removed');
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Failed to remove link');
    }
  }

  function nextPage() {
    if (data?.pagination?.hasNext) {
      offset += PAGE_SIZE;
      loadMemories();
    }
  }

  function prevPage() {
    if (data?.pagination?.hasPrevious) {
      offset = Math.max(0, offset - PAGE_SIZE);
      loadMemories();
    }
  }

  function typeBadgeStyle(type: string): string {
    const c = TYPE_COLORS[type];
    if (!c) return 'background-color: #a19e99; color: white';
    return `background-color: ${c.bg}; color: ${c.text}`;
  }

  function sensitivityBadgeStyle(sensitivity: string): string {
    const c = SENSITIVITY_COLORS[sensitivity];
    if (!c) return 'background-color: #a19e99; color: white';
    return `background-color: ${c.bg}; color: ${c.text}`;
  }

  function formatDate(ts: number | undefined): string {
    if (ts === undefined || ts === null) return 'unknown';
    return new Date(ts).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function saliencePercent(value: number | undefined): string {
    const clamped = Math.max(0, Math.min(1, value ?? 0));
    return (clamped * 100).toFixed(0);
  }

  function salienceBarStyle(value: number | undefined): string {
    return `width: ${saliencePercent(value)}%`;
  }

  // Backend uses `text`, old frontend used `content` -- handle both
  function memText(m: AdminUiPurrMemory): string {
    return m.text ?? m.content ?? '';
  }

  // Backend uses `extractedAt`, old frontend used `createdAt`
  function memCreated(m: AdminUiPurrMemory): number | undefined {
    return m.extractedAt ?? m.createdAt;
  }

  // Backend uses `lastAccessed`, old frontend used `updatedAt`
  function memUpdated(m: AdminUiPurrMemory): number | undefined {
    return m.lastAccessed ?? m.updatedAt;
  }

  // Backend uses `emotionalValence`, old frontend used `emotionalWeight`
  function memEmotion(m: AdminUiPurrMemory): number {
    return m.emotionalValence ?? m.emotionalWeight ?? 0;
  }

  // Backend uses `deletedAt` for superseded, old frontend used `supersededAt`
  function memSuperseded(m: AdminUiPurrMemory): number | undefined {
    return m.deletedAt ?? m.supersededAt;
  }

  // Tags are array in backend, string in old frontend
  function memTags(m: AdminUiPurrMemory): string {
    if (Array.isArray(m.tags)) return m.tags.join(', ');
    return String(m.tags ?? '');
  }

  function managedScopeKey(kind: string, id: string): string {
    return `${kind}:${id}`;
  }

  function scopeLabel(scope: { kind: string; id: string; label?: string }): string {
    return scope.label?.trim() || scope.id;
  }

  function scopeKindLabel(kind: string): string {
    return kind === 'north_star' ? 'North Star' : 'Project';
  }

  function syncScopeEditorFromDetail(): void {
    scopeEditorRefLabel = detailModalData?.memory.scopeRef?.label ?? '';
    scopeEditorTags = (detailModalData?.memory.scopeTags ?? []).join(', ');
  }

  async function loadManagedScopes(selectKey?: string | null) {
    managedScopeLoading = true;
    managedScopeError = '';
    try {
      const result = await listManagedMemoryScopes(managedScopeKindFilter);
      managedScopes = result.scopes ?? [];
      const nextKey = selectKey
        ?? selectedManagedScopeKey
        ?? (managedScopes[0] ? managedScopeKey(managedScopes[0].kind, managedScopes[0].id) : null);
      if (nextKey) {
        await loadManagedScopeDetail(nextKey);
      } else {
        selectedManagedScopeKey = null;
        selectedManagedScopeDetail = null;
      }
    } catch (e) {
      managedScopeError = e instanceof Error ? e.message : 'Failed to load managed scopes';
    } finally {
      managedScopeLoading = false;
    }
  }

  async function loadManagedScopeDetail(key: string): Promise<void> {
    selectedManagedScopeKey = key;
    selectedManagedScopeLoading = true;
    selectedManagedScopeError = '';
    const separator = key.indexOf(':');
    const kind = key.slice(0, separator) as 'project' | 'north_star';
    const id = key.slice(separator + 1);
    try {
      selectedManagedScopeDetail = await getManagedMemoryScopeDetail(kind, id);
    } catch (e) {
      selectedManagedScopeDetail = null;
      selectedManagedScopeError = e instanceof Error ? e.message : 'Failed to load managed scope detail';
    } finally {
      selectedManagedScopeLoading = false;
    }
  }

  async function refreshScopeViewsForMemory(memory: AdminUiPurrMemory): Promise<void> {
    const managedAssignments = detailModalData?.scopeAssignments ?? [];
    const memoryManagedScopeKey = managedAssignments[0]
      ? managedScopeKey(managedAssignments[0].kind, managedAssignments[0].id)
      : selectedManagedScopeKey;
    await loadManagedScopes(memoryManagedScopeKey);
  }

  async function handleScopeRepair(id: string): Promise<void> {
    scopeMutating = true;
    try {
      const result = await updateMemoryScope(id, { repair: true });
      if (!result.ok) {
        flash(false, result.message ?? 'Scope repair failed');
        return;
      }
      if (detailModalData && result.memory) {
        detailModalData = {
          ...detailModalData,
          memory: result.memory,
          scopeAssignments: result.scopeAssignments ?? [],
          scopeRepair: result.scopeRepair,
        };
        syncScopeEditorFromDetail();
        await refreshScopeViewsForMemory(result.memory);
      }
      await loadMemories();
      flash(true, 'Scope tags repaired');
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Scope repair failed');
    } finally {
      scopeMutating = false;
    }
  }

  async function handleScopeSave(id: string): Promise<void> {
    const sourceMemory = detailModalData?.memory;
    if (!sourceMemory?.scopeRef) {
      flash(false, 'This memory does not have a managed scopeRef to edit');
      return;
    }
    scopeMutating = true;
    try {
      const result = await updateMemoryScope(id, {
        scopeRef: {
          kind: sourceMemory.scopeRef.kind,
          id: sourceMemory.scopeRef.id,
          ...(scopeEditorRefLabel.trim() ? { label: scopeEditorRefLabel.trim() } : {}),
        },
        scopeTags: scopeEditorTags
          .split(',')
          .map(tag => tag.trim())
          .filter(Boolean),
      });
      if (!result.ok) {
        flash(false, result.message ?? 'Scope update failed');
        return;
      }
      if (detailModalData && result.memory) {
        detailModalData = {
          ...detailModalData,
          memory: result.memory,
          scopeAssignments: result.scopeAssignments ?? [],
          scopeRepair: result.scopeRepair,
        };
        syncScopeEditorFromDetail();
        await refreshScopeViewsForMemory(result.memory);
      }
      await loadMemories();
      flash(true, 'Scope tags updated');
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Scope update failed');
    } finally {
      scopeMutating = false;
    }
  }

  onMount(() => {
    loadMemories();
    loadManagedScopes();
  });

  onDestroy(() => {
    searchRequestId += 1;
    if (searchDebounce) {
      clearTimeout(searchDebounce);
    }
  });
</script>

<div class="space-y-6">
  <div>
    <h1 class="font-serif text-2xl text-shadow-900 font-semibold">The Roots</h1>
    <p class="text-shadow-600 text-sm mt-1">Memory Browser</p>
  </div>

  <!-- Flash message -->
  {#if actionMessage}
    <div class="px-4 py-2.5 rounded-lg text-sm font-medium
      {actionOk
        ? 'bg-moss-50 text-moss-700 border border-moss-200'
        : 'bg-wilt-50 text-wilt-600 border border-wilt-200'}">
      {actionMessage}
    </div>
  {/if}

  <div class="card-garden p-4 space-y-4">
    <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div>
        <h2 class="font-serif text-lg text-shadow-900 font-semibold">Scoped Memory Tags</h2>
        <p class="text-shadow-600 text-sm mt-1">
          Browse project and north-star scope attachments, inspect provenance, and spot memories that need repair.
        </p>
      </div>
      <div class="flex items-center gap-2">
        {#each MANAGED_SCOPE_KINDS as option}
          <button
            onclick={() => {
              managedScopeKindFilter = option.value;
              void loadManagedScopes();
            }}
            class={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
              managedScopeKindFilter === option.value
                ? 'border-gold-500 bg-gold-100 text-gold-800'
                : 'border-bark-300 text-shadow-700 hover:bg-bark-200'
            }`}
          >
            {option.label}
          </button>
        {/each}
      </div>
    </div>

    {#if managedScopeError}
      <p class="text-sm text-wilt-600">{managedScopeError}</p>
    {/if}

    <div class="grid grid-cols-1 gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
      <div class="space-y-2">
        {#if managedScopeLoading}
          {#each Array(4) as _}
            <div class="rounded-lg border border-bark-200 bg-bark-50 p-3 animate-pulse">
              <div class="h-4 w-40 rounded bg-bark-200"></div>
            </div>
          {/each}
        {:else if managedScopes.length === 0}
          <div class="rounded-lg border border-bark-200 bg-bark-50 p-4 text-sm text-shadow-600">
            No {scopeKindLabel(managedScopeKindFilter).toLowerCase()} scopes found.
          </div>
        {:else}
          {#each managedScopes as scope}
            <button
              onclick={() => { void loadManagedScopeDetail(managedScopeKey(scope.kind, scope.id)); }}
              class={`w-full rounded-xl border p-3 text-left transition-colors ${
                selectedManagedScopeKey === managedScopeKey(scope.kind, scope.id)
                  ? 'border-gold-500 bg-gold-50'
                  : 'border-bark-200 bg-bark-50 hover:bg-bark-100'
              }`}
            >
              <div class="flex items-start justify-between gap-3">
                <div>
                  <p class="text-shadow-900 font-medium">{scopeLabel(scope)}</p>
                  <p class="text-xs text-shadow-600 mt-1">
                    <code>{scope.canonicalTag}</code>
                  </p>
                </div>
                <span class="rounded-full bg-bark-200 px-2 py-0.5 text-xs text-shadow-700">
                  {scope.memoryCount} mem
                </span>
              </div>
              {#if scope.needsRepairCount > 0}
                <p class="mt-2 text-xs text-wilt-600">
                  {scope.needsRepairCount} attachment{scope.needsRepairCount === 1 ? '' : 's'} need repair
                </p>
              {/if}
            </button>
          {/each}
        {/if}
      </div>

      <div class="rounded-xl border border-bark-200 bg-bark-50 p-4">
        {#if selectedManagedScopeLoading}
          <div class="space-y-2">
            <div class="h-4 w-56 rounded bg-bark-200 animate-pulse"></div>
            <div class="h-3 w-full rounded bg-bark-200 animate-pulse"></div>
            <div class="h-3 w-5/6 rounded bg-bark-200 animate-pulse"></div>
          </div>
        {:else if selectedManagedScopeError}
          <p class="text-sm text-wilt-600">{selectedManagedScopeError}</p>
        {:else if selectedManagedScopeDetail}
          <div class="space-y-4">
            <div>
              <p class="text-xs uppercase tracking-[0.2em] text-shadow-500">
                {scopeKindLabel(selectedManagedScopeDetail.scope.kind)}
              </p>
              <h3 class="mt-1 font-serif text-xl text-shadow-900 font-semibold">
                {scopeLabel(selectedManagedScopeDetail.scope)}
              </h3>
              <p class="mt-1 text-sm text-shadow-600">
                <code>{selectedManagedScopeDetail.scope.canonicalTag}</code> •
                {selectedManagedScopeDetail.scope.memoryCount === 1
                  ? ` ${selectedManagedScopeDetail.scope.memoryCount} memory`
                  : ` ${selectedManagedScopeDetail.scope.memoryCount} memories`}
              </p>
            </div>

            <div class="space-y-3">
              {#each selectedManagedScopeDetail.memories as entry}
                <div class="rounded-lg border border-bark-200 bg-white/60 p-3">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <p class="text-sm font-medium text-shadow-900">{entry.memory.id}</p>
                      <p class="mt-1 text-sm text-shadow-700">
                        {memText(entry.memory).slice(0, 180)}{memText(entry.memory).length > 180 ? '...' : ''}
                      </p>
                    </div>
                    <button
                      onclick={() => { void openDetailModal(entry.memory.id); }}
                      class="shrink-0 text-sm font-medium text-gold-700 hover:text-gold-600"
                    >
                      Open
                    </button>
                  </div>
                  <div class="mt-3 flex flex-wrap gap-2 text-xs">
                    {#if entry.repair.needsRepair}
                      <span class="rounded-full bg-wilt-50 px-2 py-0.5 text-wilt-700 border border-wilt-200">
                        Repair suggested
                      </span>
                    {/if}
                    <span class="rounded-full bg-bark-200 px-2 py-0.5 text-shadow-700">
                      {entry.memory.type}
                    </span>
                    <span class="rounded-full bg-bark-200 px-2 py-0.5 text-shadow-700">
                      {formatDate(memCreated(entry.memory))}
                    </span>
                  </div>
                  <div class="mt-3 space-y-1">
                    {#each entry.evidence as evidence}
                      <div class="rounded border border-bark-200 bg-bark-50 px-2 py-1 text-xs text-shadow-700">
                        <span class="font-medium text-shadow-900">{evidence.type}:</span>
                        <code class="ml-1">{evidence.value}</code>
                        <span class="ml-1">{evidence.detail}</span>
                      </div>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {:else}
          <p class="text-sm text-shadow-600">Select a managed scope to inspect matching memories.</p>
        {/if}
      </div>
    </div>
  </div>

  <!-- Filter bar -->
  <div class="card-garden p-4 space-y-3">
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
      <select
        bind:value={typeFilter}
        onchange={applyListFilters}
        class="px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800
               focus:outline-none focus:border-gold-400 focus:ring-2 focus:ring-gold-300 text-sm"
      >
        <option value="">All Types</option>
        {#each MEMORY_TYPES.filter(t => t) as t}
          <option value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
        {/each}
      </select>

      <select
        bind:value={sensitivityFilter}
        onchange={applyListFilters}
        class="px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800
               focus:outline-none focus:border-gold-400 focus:ring-2 focus:ring-gold-300 text-sm"
      >
        <option value="">All Sensitivity</option>
        {#each SENSITIVITY_LEVELS.filter(level => level) as level}
          <option value={level}>{level.charAt(0).toUpperCase() + level.slice(1)}</option>
        {/each}
      </select>

      <input
        type="date"
        bind:value={startDateFilter}
        onchange={applyListFilters}
        class="px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm
               focus:outline-none focus:border-gold-400 focus:ring-2 focus:ring-gold-300"
        title="Start date"
      />

      <input
        type="date"
        bind:value={endDateFilter}
        onchange={applyListFilters}
        class="px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm
               focus:outline-none focus:border-gold-400 focus:ring-2 focus:ring-gold-300"
        title="End date"
      />

      <button
        onclick={clearListFilters}
        class="px-3 py-2 rounded-lg border border-bark-300 text-shadow-700 text-sm font-medium
               hover:bg-bark-200 transition-colors"
      >
        Reset Filters
      </button>
    </div>

    {#if hasInvalidDateRange()}
      <p class="text-sm text-wilt-600">
        Start date must be before or equal to end date.
      </p>
    {/if}

    <div class="flex flex-col sm:flex-row gap-2">
      <input
        data-search-shortcut
        type="text"
        bind:value={searchQuery}
        placeholder="Search memories..."
        oninput={queueSearch}
        onkeydown={(e) => { if (e.key === 'Enter') handleSearch(); }}
        class="flex-1 px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800
               placeholder:text-shadow-400 focus:outline-none focus:border-gold-400 focus:ring-2 focus:ring-gold-300 text-sm"
      />
      <button
        onclick={handleSearch}
        class="px-4 py-2 rounded-lg bg-gold-600 text-white text-sm font-medium
               hover:bg-gold-700 transition-colors"
      >
        Search
      </button>
      {#if searchActive}
        <button
          onclick={() => { searchQuery = ''; searchActive = false; searchResults = null; loadMemories(); }}
          data-esc-close
          class="px-3 py-2 rounded-lg border border-bark-300 text-shadow-700 text-sm
                 hover:bg-bark-200 transition-colors"
        >
          Clear
        </button>
      {/if}
    </div>

    {#if searchActive && searchResults}
      <p class="text-sm text-shadow-700 mt-1">
        Found {searchResults.results?.length ?? 0} results for "{searchResults.query}"
      </p>
    {:else if data?.pagination}
      <p class="text-sm text-shadow-700 mt-1">
        Showing {(data.pagination.offset ?? 0) + 1}--{Math.min((data.pagination.offset ?? 0) + (data.pagination.limit ?? PAGE_SIZE), data.pagination.total ?? 0)} of {data.pagination.total ?? 0}
      </p>
    {/if}
  </div>

  <!-- Bulk/link actions -->
  <div class="card-garden p-4 space-y-3">
    <div class="flex items-center justify-between gap-3">
      <p class="text-shadow-700 text-sm">
        Selected memories: <span class="font-medium text-shadow-900">{selectedCount}</span>
      </p>
      <div class="flex items-center gap-2">
        <button
          onclick={toggleSelectVisible}
          class="px-3 py-1.5 rounded border border-bark-300 text-shadow-700 text-sm hover:bg-bark-200 transition-colors"
        >
          Toggle Visible
        </button>
        <button
          onclick={clearSelection}
          disabled={selectedCount === 0}
          class="px-3 py-1.5 rounded border border-bark-300 text-shadow-700 text-sm hover:bg-bark-200
                 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Clear
        </button>
      </div>
    </div>
    <div class="flex flex-col sm:flex-row gap-2 sm:items-center">
      <select
        bind:value={bulkMemoryType}
        class="px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm"
      >
        <option value="">Set type (optional)</option>
        {#each MEMORY_TYPES.filter(t => t) as t}
          <option value={t}>{t}</option>
        {/each}
      </select>
      <select
        bind:value={bulkSensitivity}
        class="px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm"
      >
        <option value="">Set sensitivity (optional)</option>
        {#each SENSITIVITY_LEVELS.filter(t => t) as sensitivity}
          <option value={sensitivity}>{sensitivity}</option>
        {/each}
      </select>
      <button
        onclick={handleBulkUpdate}
        disabled={selectedCount === 0}
        class="px-3 py-2 rounded-lg bg-moss-500 text-white text-sm font-medium hover:bg-moss-600
               disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Apply Bulk Update
      </button>
      <button
        onclick={handleBulkDelete}
        disabled={selectedCount === 0}
        class="px-3 py-2 rounded-lg border border-wilt-200 text-wilt-600 text-sm font-medium hover:bg-wilt-50
               disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Bulk Supersede
      </button>
    </div>
  </div>

  <!-- Error -->
  {#if error}
    <div class="card-garden p-4 border-wilt-200">
      <p class="text-wilt-600 text-sm">{error}</p>
      <button onclick={() => error = ''} class="text-sm text-shadow-600 hover:text-shadow-800 mt-1">Dismiss</button>
    </div>
  {/if}

  <!-- Memory list -->
  {#if loading}
    <div class="space-y-3">
      {#each Array(5) as _}
        <div class="card-garden p-4 animate-pulse">
          <div class="h-4 bg-bark-200 rounded w-32 mb-2"></div>
          <div class="h-3 bg-bark-200 rounded w-full mb-1"></div>
          <div class="h-3 bg-bark-200 rounded w-3/4"></div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="space-y-3">
      {#each memories as memory (memory.id)}
        <div class="card-garden p-4">
          <!-- Header -->
          <div class="flex items-start justify-between gap-3">
            <div class="flex items-center gap-2 flex-wrap">
              <input
                type="checkbox"
                checked={isSelected(memory.id)}
                onchange={() => toggleSelected(memory.id)}
                class="h-4 w-4 rounded border-bark-300 accent-gold-600"
                title="Select memory for bulk actions"
              />
              <span class="px-2.5 py-0.5 text-sm rounded-full font-medium" style={typeBadgeStyle(memory.type ?? 'unknown')}>
                {memory.type ?? 'unknown'}
              </span>
              {#if memory.sensitivity && memory.sensitivity !== 'public'}
                <span class="px-2.5 py-0.5 text-sm rounded-full font-medium" style={sensitivityBadgeStyle(memory.sensitivity)}>
                  {memory.sensitivity}
                </span>
              {/if}
              {#if memory.contactId && contactsById[memory.contactId]}
                <span class="px-2 py-0.5 text-sm rounded border bg-bark-200 text-shadow-800 border-bark-300">
                  {contactsById[memory.contactId].displayName}
                </span>
              {/if}
              {#if memSuperseded(memory)}
                <span class="px-2 py-0.5 text-sm rounded border bg-bark-200 text-shadow-600 border-bark-300 line-through">
                  superseded
                </span>
              {/if}
            </div>
            <button
              onclick={() => { void openDetailModal(memory.id); }}
              class="text-sm text-gold-700 hover:text-gold-600 transition-colors shrink-0 font-medium"
            >
              Details
            </button>
          </div>

          <!-- Content preview -->
          <p class="text-shadow-800 text-sm mt-2 leading-relaxed">
            {memText(memory).slice(0, 220)}{memText(memory).length > 220 ? '...' : ''}
          </p>

          <!-- Metrics -->
          <div class="mt-3 space-y-2 text-sm text-shadow-600">
            <div class="flex items-center gap-4">
              <span title="Importance">
                Imp: <span class="text-shadow-800 tabular-nums font-medium">{((memory.importance ?? 0) * 100).toFixed(0)}%</span>
              </span>
              <span title="Salience">
                Sal: <span class="text-shadow-800 tabular-nums font-medium">{saliencePercent(memory.salience)}%</span>
              </span>
              <span title="Emotional Valence">
                Emo: <span class="text-shadow-800 tabular-nums font-medium">{(memEmotion(memory) * 100).toFixed(0)}%</span>
              </span>
              <span class="ml-auto text-shadow-700">{formatDate(memCreated(memory))}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs uppercase tracking-wide text-shadow-600">Salience</span>
              <div class="h-2 flex-1 rounded-full bg-bark-200 overflow-hidden">
                <div class="h-full rounded-full bg-gold-500" style={salienceBarStyle(memory.salience)}></div>
              </div>
              <span class="w-11 text-right text-shadow-800 tabular-nums font-medium">{saliencePercent(memory.salience)}%</span>
            </div>
          </div>
        </div>
      {/each}

      {#if memories.length === 0 && !loading}
        <div class="card-garden p-6 text-center">
          <p class="text-shadow-600 text-sm">No memories found.</p>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Pagination -->
  {#if !searchActive && data?.pagination}
    <div class="flex items-center justify-between">
      <button
        onclick={prevPage}
        disabled={!data.pagination?.hasPrevious}
        class="px-4 py-2 rounded-lg border border-bark-300 text-shadow-800 text-sm font-medium
               hover:bg-bark-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Previous
      </button>
      <span class="text-sm text-shadow-700">
        Page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.max(1, Math.ceil(((data.pagination?.total ?? 0) || 1) / PAGE_SIZE))}
      </span>
      <button
        onclick={nextPage}
        disabled={!data.pagination?.hasNext}
        class="px-4 py-2 rounded-lg border border-bark-300 text-shadow-800 text-sm font-medium
               hover:bg-bark-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Next
      </button>
    </div>
  {/if}
</div>

{#if detailModalId}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    role="presentation"
    onclick={(event) => {
      if (event.currentTarget === event.target) {
        closeDetailModal();
      }
    }}
  >
    <div
      class="card-garden w-full max-w-4xl max-h-[90vh] overflow-y-auto p-5 space-y-4"
      role="dialog"
      aria-modal="true"
      aria-label="Memory detail"
    >
      <div class="flex items-start justify-between gap-3">
        <div>
          <h2 class="font-serif text-xl text-shadow-900 font-semibold">Memory Detail</h2>
          {#if detailModalData}
            <p class="text-shadow-600 text-xs mt-1">
              ID: <code class="text-shadow-800 bg-bark-200 px-1 rounded">{detailModalData.memory.id}</code>
            </p>
          {/if}
        </div>
        <button
          onclick={closeDetailModal}
          class="px-3 py-1 rounded border border-bark-300 text-shadow-700 hover:bg-bark-200 transition-colors text-sm"
        >
          Close
        </button>
      </div>

      {#if detailModalLoading}
        <div class="space-y-2">
          <div class="h-4 bg-bark-200 rounded w-1/3 animate-pulse"></div>
          <div class="h-3 bg-bark-200 rounded w-full animate-pulse"></div>
          <div class="h-3 bg-bark-200 rounded w-5/6 animate-pulse"></div>
        </div>
      {:else if detailModalError}
        <div class="rounded-lg border border-wilt-200 bg-wilt-50 p-3">
          <p class="text-sm text-wilt-600">{detailModalError}</p>
        </div>
      {:else if detailModalData}
        <div class="space-y-4 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <span class="px-2.5 py-0.5 text-sm rounded-full font-medium" style={typeBadgeStyle(detailModalData.memory.type ?? 'unknown')}>
              {detailModalData.memory.type ?? 'unknown'}
            </span>
            {#if detailModalData.memory.sensitivity}
              <span class="px-2.5 py-0.5 text-sm rounded-full font-medium" style={sensitivityBadgeStyle(detailModalData.memory.sensitivity)}>
                {detailModalData.memory.sensitivity}
              </span>
            {/if}
            {#if detailModalData.linkedContact}
              <span class="px-2 py-0.5 text-sm rounded border bg-bark-200 text-shadow-800 border-bark-300">
                {detailModalData.linkedContact.displayName}
              </span>
            {:else if detailModalData.memory.contactId && contactsById[detailModalData.memory.contactId]}
              <span class="px-2 py-0.5 text-sm rounded border bg-bark-200 text-shadow-800 border-bark-300">
                {contactsById[detailModalData.memory.contactId].displayName}
              </span>
            {/if}
          </div>

          <p class="text-shadow-800 leading-relaxed">{memText(detailModalData.memory)}</p>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-shadow-700">
            <span>Extracted: <span class="text-shadow-800">{formatDate(memCreated(detailModalData.memory))}</span></span>
            <span>Last Accessed: <span class="text-shadow-800">{formatDate(memUpdated(detailModalData.memory))}</span></span>
            <span>Importance: <span class="text-shadow-800">{((detailModalData.memory.importance ?? 0) * 100).toFixed(0)}%</span></span>
            <span>Salience: <span class="text-shadow-800">{saliencePercent(detailModalData.memory.salience)}%</span></span>
            {#if detailModalData.memory.confidence !== undefined}
              <span>Confidence: <span class="text-shadow-800">{((detailModalData.memory.confidence ?? 0) * 100).toFixed(0)}%</span></span>
            {/if}
            <span>Emotional Valence: <span class="text-shadow-800">{(memEmotion(detailModalData.memory) * 100).toFixed(0)}%</span></span>
            {#if memSuperseded(detailModalData.memory)}
              <span>Superseded: <span class="text-shadow-800">{formatDate(memSuperseded(detailModalData.memory))}</span></span>
            {/if}
            {#if detailModalData.memory.accessCount !== undefined}
              <span>Access Count: <span class="text-shadow-800">{detailModalData.memory.accessCount}</span></span>
            {/if}
            {#if detailModalData.memory.sourceRef}
              <span class="sm:col-span-2">Source: <code class="text-shadow-800 bg-bark-200 px-1 rounded text-sm break-all">{detailModalData.memory.sourceRef}</code></span>
            {/if}
            {#if memTags(detailModalData.memory)}
              <span class="sm:col-span-2">Tags: <span class="text-shadow-800">{memTags(detailModalData.memory)}</span></span>
            {/if}
          </div>

          <div class="rounded-xl border border-bark-200 bg-bark-50 p-4 space-y-3">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="font-medium text-shadow-900">Managed Scope Attachment</p>
                <p class="mt-1 text-xs text-shadow-600">
                  Project and north-star scope refs and tags persisted on this memory.
                </p>
              </div>
              {#if detailModalData.scopeRepair?.needsRepair}
                <button
                  onclick={() => handleScopeRepair(detailMemoryId)}
                  disabled={scopeMutating}
                  class="px-3 py-1.5 rounded-lg border border-gold-500 text-gold-800 text-sm font-medium hover:bg-gold-50 disabled:opacity-50"
                >
                  Repair Tags
                </button>
              {/if}
            </div>

            {#if detailModalData.scopeAssignments.length === 0}
              <p class="text-sm text-shadow-600">No managed project or north-star scope is attached.</p>
            {:else}
              <div class="space-y-3">
                {#each detailModalData.scopeAssignments as assignment}
                  <div class="rounded-lg border border-bark-200 bg-white/70 p-3">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="rounded-full bg-bark-200 px-2 py-0.5 text-xs text-shadow-700">
                        {scopeKindLabel(assignment.kind)}
                      </span>
                      <span class="text-sm font-medium text-shadow-900">{scopeLabel(assignment)}</span>
                      <code class="text-xs text-shadow-700">{assignment.canonicalTag}</code>
                    </div>
                    <div class="mt-2 space-y-1">
                      {#each assignment.evidence as evidence}
                        <div class="rounded border border-bark-200 bg-bark-50 px-2 py-1 text-xs text-shadow-700">
                          <span class="font-medium text-shadow-900">{evidence.type}:</span>
                          <code class="ml-1">{evidence.value}</code>
                          <span class="ml-1">{evidence.detail}</span>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}

            {#if detailModalData.memory.scopeRef}
              <div class="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]">
                <input
                  type="text"
                  bind:value={scopeEditorRefLabel}
                  placeholder="Scope label"
                  class="px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm"
                />
                <input
                  type="text"
                  bind:value={scopeEditorTags}
                  placeholder="Comma-separated scope tags"
                  class="px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm"
                />
                <button
                  onclick={() => handleScopeSave(detailMemoryId)}
                  disabled={scopeMutating}
                  class="px-3 py-2 rounded-lg bg-moss-500 text-white text-sm font-medium hover:bg-moss-600 disabled:opacity-50"
                >
                  Save Scope
                </button>
              </div>
            {/if}

            {#if detailModalData.scopeRepair}
              <div class="text-xs text-shadow-600 space-y-1">
                {#if detailModalData.scopeRepair.suggestedScopeRef}
                  <p>
                    Suggested scopeRef:
                    <code>{detailModalData.scopeRepair.suggestedScopeRef.kind}:{detailModalData.scopeRepair.suggestedScopeRef.id}</code>
                  </p>
                {/if}
                <p>
                  Suggested tags:
                  <code>{detailModalData.scopeRepair.suggestedScopeTags.join(', ') || 'none'}</code>
                </p>
                {#each detailModalData.scopeRepair.notes as note}
                  <p>{note}</p>
                {/each}
              </div>
            {/if}
          </div>

          <!-- Supersede button (not "Delete" — backend calls supersedeMemory) -->
          <div class="flex justify-end pt-2 border-t border-bark-200">
            {#if supersedeConfirmId === detailModalData.memory.id}
              <div class="flex flex-wrap items-center justify-end gap-2">
                <span class="text-shadow-700">
                  Supersede this memory? It will be marked as replaced.
                </span>
                <button
                  onclick={() => handleSupersede(detailMemoryId)}
                  class="px-3 py-1 rounded bg-wilt-400 text-white hover:bg-wilt-600 transition-colors text-sm font-medium"
                >
                  Yes, Supersede
                </button>
                <button
                  onclick={() => supersedeConfirmId = null}
                  class="px-3 py-1 rounded border border-bark-300 text-shadow-700 hover:bg-bark-200 transition-colors text-sm"
                >
                  Cancel
                </button>
              </div>
            {:else}
              <button
                onclick={() => supersedeConfirmId = detailMemoryId}
                class="px-3 py-1 rounded border border-wilt-200 text-wilt-600 hover:bg-wilt-50 transition-colors text-sm font-medium"
                title="Mark this memory as superseded (replaced). The original is preserved but hidden from active retrieval."
              >
                Supersede
              </button>
            {/if}
          </div>

          <!-- Memory links -->
          <div class="pt-2 border-t border-bark-200 space-y-2">
            <p class="text-shadow-700 font-medium text-sm">Memory Links</p>
            <div class="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                placeholder="Target memory ID"
                value={linkTargetById[detailModalData.memory.id] ?? ''}
                oninput={(event) => {
                  const next = (event.currentTarget as HTMLInputElement).value;
                  linkTargetById = { ...linkTargetById, [detailMemoryId]: next };
                }}
                class="flex-1 px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm"
              />
              <select
                value={linkTypeById[detailModalData.memory.id] ?? 'related'}
                onchange={(event) => {
                  const next = (event.currentTarget as HTMLSelectElement).value;
                  linkTypeById = { ...linkTypeById, [detailMemoryId]: next };
                }}
                class="px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm"
              >
                {#each MEMORY_LINK_TYPES as linkType}
                  <option value={linkType}>{linkType}</option>
                {/each}
              </select>
              <button
                onclick={() => handleLinkMemory(detailMemoryId)}
                class="px-3 py-2 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 transition-colors"
              >
                Link
              </button>
            </div>

            {#if loadingLinksFor === detailModalData.memory.id}
              <p class="text-shadow-600 text-sm">Loading links...</p>
            {:else if (linksById[detailModalData.memory.id] ?? []).length === 0}
              <p class="text-shadow-600 text-sm">No links for this memory.</p>
            {:else}
              <div class="space-y-1">
                {#each linksById[detailModalData.memory.id] ?? [] as link}
                  <div class="flex items-center justify-between rounded border border-bark-200 bg-bark-50 px-2 py-1 text-sm">
                    <span class="text-shadow-800">
                      <code>{link.id1}</code> <span class="mx-1">↔</span> <code>{link.id2}</code> ({link.linkType})
                    </span>
                    <button
                      onclick={() => handleUnlinkMemory(detailMemoryId, link.id1, link.id2)}
                      class="text-wilt-600 hover:text-wilt-700 font-medium"
                    >
                      Unlink
                    </button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}
