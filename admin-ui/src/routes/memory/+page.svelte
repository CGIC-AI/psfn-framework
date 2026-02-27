<script lang="ts">
  import { onMount } from 'svelte';
  import { listMemories, searchMemories, deleteMemory } from '$lib/api/endpoints/memory';
  import type { AdminMemoryListData, AdminMemorySearchResult, PurrMemory, AdminMemoryContactSummary } from '$lib/types';

  const MEMORY_TYPES = ['', 'episodic', 'semantic', 'emotional', 'procedural', 'reflection', 'relational'];
  const PAGE_SIZE = 20;

  let data = $state<AdminMemoryListData | null>(null);
  let searchResults = $state<AdminMemorySearchResult | null>(null);
  let error = $state('');
  let loading = $state(true);
  let actionMessage = $state('');
  let actionOk = $state(true);

  let typeFilter = $state('');
  let searchQuery = $state('');
  let searchActive = $state(false);
  let offset = $state(0);
  let expandedId = $state<string | null>(null);
  let supersedeConfirmId = $state<string | null>(null);

  let contactsById = $derived<Record<string, AdminMemoryContactSummary>>(
    searchActive && searchResults ? searchResults.contactsById :
    data ? data.contactsById : {}
  );

  let memories = $derived<PurrMemory[]>(
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

  async function loadMemories() {
    loading = true;
    error = '';
    searchActive = false;
    searchResults = null;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      data = await listMemories({
        type: typeFilter || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      clearTimeout(timeoutId);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        error = 'Request timed out (10s). The server may be slow or unresponsive.';
      } else {
        error = e instanceof Error ? e.message : 'Failed to load memories';
      }
    } finally {
      loading = false;
    }
  }

  async function handleSearch() {
    if (!searchQuery.trim()) {
      searchActive = false;
      searchResults = null;
      return;
    }
    loading = true;
    error = '';
    try {
      searchResults = await searchMemories(searchQuery.trim());
      searchActive = true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Search failed';
    } finally {
      loading = false;
    }
  }

  async function handleSupersede(id: string) {
    try {
      await deleteMemory(id);
      supersedeConfirmId = null;
      flash(true, 'Memory superseded successfully');
      await loadMemories();
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Supersede failed');
    }
  }

  function nextPage() {
    if (data?.pagination.hasNext) {
      offset += PAGE_SIZE;
      loadMemories();
    }
  }

  function prevPage() {
    if (data?.pagination.hasPrevious) {
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

  function formatDate(ts: number): string {
    return new Date(ts).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  onMount(() => {
    loadMemories();
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

  <!-- Filter bar -->
  <div class="card-garden p-4">
    <div class="flex flex-col sm:flex-row gap-3">
      <select
        bind:value={typeFilter}
        onchange={() => { offset = 0; loadMemories(); }}
        class="px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800
               focus:outline-none focus:border-gold-400 focus:ring-2 focus:ring-gold-300 text-sm"
      >
        <option value="">All Types</option>
        {#each MEMORY_TYPES.filter(t => t) as t}
          <option value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
        {/each}
      </select>

      <div class="flex flex-1 gap-2">
        <input
          type="text"
          bind:value={searchQuery}
          placeholder="Search memories..."
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
            class="px-3 py-2 rounded-lg border border-bark-300 text-shadow-700 text-sm
                   hover:bg-bark-200 transition-colors"
          >
            Clear
          </button>
        {/if}
      </div>
    </div>

    {#if searchActive && searchResults}
      <p class="text-sm text-shadow-700 mt-2">
        Found {searchResults.results.length} results for "{searchResults.query}"
      </p>
    {:else if data}
      <p class="text-sm text-shadow-700 mt-2">
        Showing {data.pagination.offset + 1}--{Math.min(data.pagination.offset + data.pagination.limit, data.pagination.total)} of {data.pagination.total}
      </p>
    {/if}
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
              <span class="px-2.5 py-0.5 text-sm rounded-full font-medium" style={typeBadgeStyle(memory.type)}>
                {memory.type}
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
              {#if memory.supersededAt}
                <span class="px-2 py-0.5 text-sm rounded border bg-bark-200 text-shadow-600 border-bark-300 line-through">
                  superseded
                </span>
              {/if}
            </div>
            <button
              onclick={() => expandedId = expandedId === memory.id ? null : memory.id}
              class="text-sm text-gold-700 hover:text-gold-600 transition-colors shrink-0 font-medium"
            >
              {expandedId === memory.id ? 'Collapse' : 'Expand'}
            </button>
          </div>

          <!-- Content preview -->
          <p class="text-shadow-800 text-sm mt-2 leading-relaxed">
            {expandedId === memory.id ? memory.content : memory.content.slice(0, 200) + (memory.content.length > 200 ? '...' : '')}
          </p>

          <!-- Metrics -->
          <div class="flex items-center gap-4 mt-3 text-sm text-shadow-600">
            <span title="Importance">
              Imp: <span class="text-shadow-800 tabular-nums font-medium">{(memory.importance * 100).toFixed(0)}%</span>
            </span>
            <span title="Salience">
              Sal: <span class="text-shadow-800 tabular-nums font-medium">{(memory.salience * 100).toFixed(0)}%</span>
            </span>
            <span title="Emotional Weight">
              Emo: <span class="text-shadow-800 tabular-nums font-medium">{(memory.emotionalWeight * 100).toFixed(0)}%</span>
            </span>
            <span class="ml-auto text-shadow-700">{formatDate(memory.createdAt)}</span>
          </div>

          <!-- Expanded details -->
          {#if expandedId === memory.id}
            <div class="mt-4 pt-3 border-t border-bark-200 space-y-3 text-sm">
              <div class="grid grid-cols-2 gap-2 text-shadow-700">
                <span>ID: <code class="text-shadow-800 bg-bark-200 px-1 rounded">{memory.id}</code></span>
                <span>Created: <span class="text-shadow-800">{formatDate(memory.createdAt)}</span></span>
                <span>Updated: <span class="text-shadow-800">{formatDate(memory.updatedAt)}</span></span>
                {#if memory.supersededAt}
                  <span>Superseded: <span class="text-shadow-800">{formatDate(memory.supersededAt)}</span></span>
                {/if}
                {#if memory.sourceRef}
                  <span>Source: <code class="text-shadow-800 bg-bark-200 px-1 rounded">{memory.sourceRef}</code></span>
                {/if}
                {#if memory.tags}
                  <span>Tags: <span class="text-shadow-800">{memory.tags}</span></span>
                {/if}
              </div>

              <!-- Supersede button (not "Delete" — backend calls supersedeMemory) -->
              <div class="flex justify-end pt-2">
                {#if supersedeConfirmId === memory.id}
                  <div class="flex items-center gap-2">
                    <span class="text-shadow-700">
                      Supersede this memory? It won't be deleted, but marked as replaced.
                    </span>
                    <button
                      onclick={() => handleSupersede(memory.id)}
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
                    onclick={() => supersedeConfirmId = memory.id}
                    class="px-3 py-1 rounded border border-wilt-200 text-wilt-600 hover:bg-wilt-50 transition-colors text-sm font-medium"
                    title="Mark this memory as superseded (replaced). The original is preserved but hidden from active retrieval."
                  >
                    Supersede
                  </button>
                {/if}
              </div>
            </div>
          {/if}
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
        disabled={!data.pagination.hasPrevious}
        class="px-4 py-2 rounded-lg border border-bark-300 text-shadow-800 text-sm font-medium
               hover:bg-bark-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Previous
      </button>
      <span class="text-sm text-shadow-700">
        Page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.max(1, Math.ceil((data.pagination.total || 1) / PAGE_SIZE))}
      </span>
      <button
        onclick={nextPage}
        disabled={!data.pagination.hasNext}
        class="px-4 py-2 rounded-lg border border-bark-300 text-shadow-800 text-sm font-medium
               hover:bg-bark-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Next
      </button>
    </div>
  {/if}
</div>
