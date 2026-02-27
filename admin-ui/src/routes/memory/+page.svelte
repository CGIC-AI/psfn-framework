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

  let typeFilter = $state('');
  let searchQuery = $state('');
  let searchActive = $state(false);
  let offset = $state(0);
  let expandedId = $state<string | null>(null);
  let deleteConfirmId = $state<string | null>(null);

  let contactsById = $derived<Record<string, AdminMemoryContactSummary>>(
    searchActive && searchResults ? searchResults.contactsById :
    data ? data.contactsById : {}
  );

  let memories = $derived<PurrMemory[]>(
    searchActive && searchResults ? searchResults.results :
    data ? data.memories : []
  );

  async function loadMemories() {
    loading = true;
    error = '';
    searchActive = false;
    searchResults = null;
    try {
      data = await listMemories({
        type: typeFilter || undefined,
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

  async function handleDelete(id: string) {
    try {
      await deleteMemory(id);
      deleteConfirmId = null;
      await loadMemories();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Delete failed';
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

  function typeColor(type: string): string {
    const colors: Record<string, string> = {
      episodic: 'bg-moss-50 text-moss-600 border-moss-200',
      semantic: 'bg-gold-50 text-gold-700 border-gold-200',
      emotional: 'bg-petal-50 text-petal-500 border-petal-200',
      procedural: 'bg-bark-200 text-shadow-600 border-bark-300',
      reflection: 'bg-shadow-50 text-shadow-500 border-shadow-200',
      relational: 'bg-petal-100 text-petal-400 border-petal-200',
    };
    return colors[type] ?? 'bg-bark-200 text-shadow-500 border-bark-300';
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

  <!-- Filter bar -->
  <div class="card p-4">
    <div class="flex flex-col sm:flex-row gap-3">
      <select
        bind:value={typeFilter}
        onchange={() => { offset = 0; loadMemories(); }}
        class="px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-700
               focus:outline-none focus:border-gold-400 text-sm"
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
          class="flex-1 px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-700
                 placeholder:text-shadow-500 focus:outline-none focus:border-gold-400 text-sm"
        />
        <button
          onclick={handleSearch}
          class="px-4 py-2 rounded-lg bg-gold-400 text-bark-50 text-sm font-medium
                 hover:bg-gold-500 transition-colors"
        >
          Search
        </button>
        {#if searchActive}
          <button
            onclick={() => { searchQuery = ''; searchActive = false; searchResults = null; loadMemories(); }}
            class="px-3 py-2 rounded-lg border border-bark-300 text-shadow-500 text-sm
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
    <div class="card p-4 border-wilt-200">
      <p class="text-wilt-600 text-sm">{error}</p>
    </div>
  {/if}

  <!-- Memory list -->
  {#if loading}
    <div class="space-y-3">
      {#each Array(5) as _}
        <div class="card p-4 animate-pulse">
          <div class="h-4 bg-bark-200 rounded w-32 mb-2"></div>
          <div class="h-3 bg-bark-200 rounded w-full mb-1"></div>
          <div class="h-3 bg-bark-200 rounded w-3/4"></div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="space-y-3">
      {#each memories as memory (memory.id)}
        <div class="card p-4">
          <!-- Header -->
          <div class="flex items-start justify-between gap-3">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="px-2 py-0.5 text-xs rounded border {typeColor(memory.type)}">
                {memory.type}
              </span>
              {#if memory.sensitivity && memory.sensitivity !== 'public'}
                <span class="px-2 py-0.5 text-xs rounded border bg-wilt-50 text-wilt-600 border-wilt-200">
                  {memory.sensitivity}
                </span>
              {/if}
              {#if memory.contactId && contactsById[memory.contactId]}
                <span class="px-2 py-0.5 text-xs rounded border bg-bark-200 text-shadow-500 border-bark-300">
                  {contactsById[memory.contactId].displayName}
                </span>
              {/if}
              {#if memory.supersededAt}
                <span class="px-2 py-0.5 text-xs rounded border bg-bark-200 text-shadow-600 border-bark-300 line-through">
                  superseded
                </span>
              {/if}
            </div>
            <button
              onclick={() => expandedId = expandedId === memory.id ? null : memory.id}
              class="text-sm text-shadow-600 hover:text-gold-600 transition-colors shrink-0"
            >
              {expandedId === memory.id ? 'Collapse' : 'Expand'}
            </button>
          </div>

          <!-- Content preview -->
          <p class="text-shadow-700 text-sm mt-2 leading-relaxed">
            {expandedId === memory.id ? memory.content : memory.content.slice(0, 200) + (memory.content.length > 200 ? '...' : '')}
          </p>

          <!-- Metrics -->
          <div class="flex items-center gap-4 mt-3 text-sm text-shadow-600">
            <span title="Importance">
              Imp: <span class="text-shadow-600 tabular-nums">{(memory.importance * 100).toFixed(0)}%</span>
            </span>
            <span title="Salience">
              Sal: <span class="text-shadow-600 tabular-nums">{(memory.salience * 100).toFixed(0)}%</span>
            </span>
            <span title="Emotional Weight">
              Emo: <span class="text-shadow-600 tabular-nums">{(memory.emotionalWeight * 100).toFixed(0)}%</span>
            </span>
            <span class="ml-auto">{formatDate(memory.createdAt)}</span>
          </div>

          <!-- Expanded details -->
          {#if expandedId === memory.id}
            <div class="mt-4 pt-3 border-t border-bark-200 space-y-2 text-sm">
              <div class="grid grid-cols-2 gap-2 text-shadow-700">
                <span>ID: <code class="text-shadow-600">{memory.id}</code></span>
                <span>Created: {formatDate(memory.createdAt)}</span>
                <span>Updated: {formatDate(memory.updatedAt)}</span>
                {#if memory.supersededAt}
                  <span>Superseded: {formatDate(memory.supersededAt)}</span>
                {/if}
              </div>

              <!-- Delete button -->
              <div class="flex justify-end pt-2">
                {#if deleteConfirmId === memory.id}
                  <div class="flex items-center gap-2">
                    <span class="text-wilt-600">Are you sure?</span>
                    <button
                      onclick={() => handleDelete(memory.id)}
                      class="px-3 py-1 rounded bg-wilt-400 text-bark-50 hover:bg-wilt-600 transition-colors"
                    >
                      Yes, Delete
                    </button>
                    <button
                      onclick={() => deleteConfirmId = null}
                      class="px-3 py-1 rounded border border-bark-300 text-shadow-500 hover:bg-bark-200 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                {:else}
                  <button
                    onclick={() => deleteConfirmId = memory.id}
                    class="px-3 py-1 rounded border border-wilt-200 text-wilt-600 hover:bg-wilt-50 transition-colors"
                  >
                    Delete
                  </button>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/each}

      {#if memories.length === 0 && !loading}
        <div class="card p-6 text-center">
          <p class="text-shadow-700">No memories found.</p>
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
        class="px-4 py-2 rounded-lg border border-bark-300 text-shadow-600 text-sm
               hover:bg-bark-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Previous
      </button>
      <span class="text-sm text-shadow-700">
        Page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.ceil(data.pagination.total / PAGE_SIZE)}
      </span>
      <button
        onclick={nextPage}
        disabled={!data.pagination.hasNext}
        class="px-4 py-2 rounded-lg border border-bark-300 text-shadow-600 text-sm
               hover:bg-bark-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Next
      </button>
    </div>
  {/if}
</div>
