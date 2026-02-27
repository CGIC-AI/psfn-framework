<script lang="ts">
  import { onMount } from 'svelte';
  import { listMemories, searchMemories, deleteMemory } from '$lib/api/endpoints/memory';
  import type { PurrMemory, AdminMemoryListData } from '$lib/types';

  let data = $state<AdminMemoryListData | null>(null);
  let loading = $state(true);
  let error = $state('');
  let searchQuery = $state('');
  let searching = $state(false);
  let typeFilter = $state('');
  let pageSize = $state(25);
  let currentOffset = $state(0);
  let selectedMemory = $state<PurrMemory | null>(null);

  const TYPE_BADGE: Record<string, string> = {
    episodic: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    semantic: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    emotional: 'bg-petal-100 text-petal-700 dark:bg-petal-900/30 dark:text-petal-300',
    procedural: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    boundary: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    reflection: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
    relational: 'bg-gold-100 text-gold-700 dark:bg-gold-900/30 dark:text-gold-300',
  };

  const SENSITIVITY_BADGE: Record<string, string> = {
    public: 'bg-bark-100 text-bark-600',
    personal: 'bg-blue-50 text-blue-600',
    intimate: 'bg-petal-50 text-petal-600',
    confidential: 'bg-red-50 text-red-600',
  };

  async function loadMemories() {
    loading = true;
    error = '';
    try {
      data = await listMemories({
        type: typeFilter || undefined,
        limit: pageSize,
        offset: currentOffset,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load memories';
    } finally {
      loading = false;
    }
  }

  async function handleSearch() {
    if (!searchQuery.trim()) {
      await loadMemories();
      return;
    }
    searching = true;
    error = '';
    try {
      const result = await searchMemories(searchQuery.trim());
      data = {
        memories: result.results,
        contactsById: result.contactsById,
        pagination: { limit: result.results.length, offset: 0, total: result.results.length, hasPrevious: false, hasNext: false },
      };
    } catch (e) {
      error = e instanceof Error ? e.message : 'Search failed';
    } finally {
      searching = false;
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Archive this memory? It will be marked as superseded.')) return;
    try {
      await deleteMemory(id);
      await loadMemories();
      selectedMemory = null;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to archive memory';
    }
  }

  function prevPage() {
    if (data?.pagination.hasPrevious) {
      currentOffset = Math.max(0, currentOffset - pageSize);
      loadMemories();
    }
  }

  function nextPage() {
    if (data?.pagination.hasNext) {
      currentOffset += pageSize;
      loadMemories();
    }
  }

  function formatDate(ts: number): string {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max) + '...' : text;
  }

  onMount(loadMemories);

  $effect(() => {
    // Reload when filter changes
    void typeFilter;
    currentOffset = 0;
    loadMemories();
  });
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-800 dark:text-bark-200">The Roots</h1>
      <p class="text-sm text-shadow-400 dark:text-bark-500 mt-1">Memory browser — {data?.pagination.total ?? 0} memories</p>
    </div>
  </div>

  <!-- Filters -->
  <div class="card-garden p-4 flex flex-wrap items-center gap-3">
    <form onsubmit={(e) => { e.preventDefault(); handleSearch(); }} class="flex-1 min-w-[200px] flex gap-2">
      <input
        type="text"
        bind:value={searchQuery}
        placeholder="Semantic search..."
        class="flex-1 px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm
          placeholder:text-shadow-300 dark:placeholder:text-shadow-600
          focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
      />
      <button
        type="submit"
        class="px-4 py-2 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors"
        disabled={searching}
      >
        {searching ? 'Searching...' : 'Search'}
      </button>
    </form>

    <select
      bind:value={typeFilter}
      class="px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm"
    >
      <option value="">All types</option>
      <option value="episodic">Episodic</option>
      <option value="semantic">Semantic</option>
      <option value="emotional">Emotional</option>
      <option value="procedural">Procedural</option>
      <option value="boundary">Boundary</option>
      <option value="reflection">Reflection</option>
      <option value="relational">Relational</option>
    </select>
  </div>

  {#if loading}
    <div class="space-y-3">
      {#each Array(5) as _}
        <div class="card-garden p-4 animate-pulse">
          <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded w-16 mb-2"></div>
          <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded w-3/4"></div>
        </div>
      {/each}
    </div>
  {:else if error}
    <div class="card-garden p-6 text-center">
      <p class="text-wilt-600">{error}</p>
    </div>
  {:else if data}
    <!-- Memory list -->
    <div class="space-y-2">
      {#each data.memories as memory (memory.id)}
        <button
          class="w-full text-left card-garden p-4 cursor-pointer transition-all
            {selectedMemory?.id === memory.id ? 'filigree-border-strong ring-1 ring-gold-300' : ''}"
          onclick={() => selectedMemory = selectedMemory?.id === memory.id ? null : memory}
        >
          <div class="flex items-start gap-3">
            <div class="flex flex-wrap gap-1.5">
              <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium {TYPE_BADGE[memory.type] || 'bg-bark-200 text-bark-600'}">
                {memory.type}
              </span>
              <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] {SENSITIVITY_BADGE[memory.sensitivity] || ''}">
                {memory.sensitivity}
              </span>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm text-shadow-800 dark:text-bark-200 leading-relaxed">{truncate(memory.text, 200)}</p>
              <div class="flex items-center gap-4 mt-2 text-[11px] text-shadow-400 dark:text-bark-500">
                <span>Salience: {(memory.salience * 100).toFixed(0)}%</span>
                <span>Importance: {(memory.importance * 100).toFixed(0)}%</span>
                <span>{formatDate(memory.extractedAt)}</span>
                {#if memory.tags.length > 0}
                  <span class="flex gap-1">
                    {#each memory.tags.slice(0, 3) as tag}
                      <span class="bg-bark-100 dark:bg-shadow-800 px-1.5 py-0.5 rounded text-[10px]">{tag}</span>
                    {/each}
                    {#if memory.tags.length > 3}
                      <span class="text-shadow-300">+{memory.tags.length - 3}</span>
                    {/if}
                  </span>
                {/if}
              </div>
            </div>
          </div>

          <!-- Expanded detail -->
          {#if selectedMemory?.id === memory.id}
            <div class="mt-4 pt-4 border-t border-bark-200 dark:border-shadow-700 space-y-3">
              <div class="text-sm text-shadow-800 dark:text-bark-200 whitespace-pre-wrap">{memory.text}</div>
              <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div>
                  <span class="text-shadow-400 dark:text-bark-500">ID</span>
                  <p class="font-mono text-shadow-600 dark:text-bark-400 break-all">{memory.id}</p>
                </div>
                <div>
                  <span class="text-shadow-400 dark:text-bark-500">Source</span>
                  <p class="text-shadow-600 dark:text-bark-400">{memory.sourceRef}</p>
                </div>
                <div>
                  <span class="text-shadow-400 dark:text-bark-500">Confidence</span>
                  <p>{(memory.confidence * 100).toFixed(0)}%</p>
                </div>
                <div>
                  <span class="text-shadow-400 dark:text-bark-500">Emotional Valence</span>
                  <p>{memory.emotionalValence.toFixed(2)}</p>
                </div>
                <div>
                  <span class="text-shadow-400 dark:text-bark-500">Access Count</span>
                  <p>{memory.accessCount}</p>
                </div>
                <div>
                  <span class="text-shadow-400 dark:text-bark-500">Last Accessed</span>
                  <p>{formatDate(memory.lastAccessed)}</p>
                </div>
                <div>
                  <span class="text-shadow-400 dark:text-bark-500">Retention</span>
                  <p>{memory.retentionClass ?? 'standard'}</p>
                </div>
                {#if memory.contactId}
                  <div>
                    <span class="text-shadow-400 dark:text-bark-500">Contact</span>
                    <p>{data.contactsById[memory.contactId]?.displayName ?? memory.contactId}</p>
                  </div>
                {/if}
              </div>
              {#if memory.tags.length > 0}
                <div>
                  <span class="text-xs text-shadow-400 dark:text-bark-500">Tags</span>
                  <div class="flex flex-wrap gap-1 mt-1">
                    {#each memory.tags as tag}
                      <span class="bg-bark-100 dark:bg-shadow-800 px-2 py-0.5 rounded text-xs text-shadow-600 dark:text-bark-400">{tag}</span>
                    {/each}
                  </div>
                </div>
              {/if}
              <div class="flex gap-2 pt-2">
                <button
                  onclick={(e) => { e.stopPropagation(); handleDelete(memory.id); }}
                  class="px-3 py-1.5 text-xs text-wilt-600 hover:text-wilt-700 hover:bg-wilt-50 rounded-lg transition-colors"
                >
                  Archive
                </button>
              </div>
            </div>
          {/if}
        </button>
      {:else}
        <div class="card-garden p-8 text-center">
          <p class="text-shadow-400 dark:text-bark-500 italic">No memories found</p>
        </div>
      {/each}
    </div>

    <!-- Pagination -->
    {#if data.pagination.total > pageSize}
      <div class="flex items-center justify-between card-garden p-3">
        <button
          onclick={prevPage}
          disabled={!data.pagination.hasPrevious}
          class="px-3 py-1.5 text-sm text-shadow-600 dark:text-bark-400 hover:bg-bark-100 dark:hover:bg-shadow-800 rounded-lg disabled:opacity-30 transition-colors"
        >
          Previous
        </button>
        <span class="text-xs text-shadow-400 dark:text-bark-500">
          {currentOffset + 1}–{Math.min(currentOffset + pageSize, data.pagination.total)} of {data.pagination.total}
        </span>
        <button
          onclick={nextPage}
          disabled={!data.pagination.hasNext}
          class="px-3 py-1.5 text-sm text-shadow-600 dark:text-bark-400 hover:bg-bark-100 dark:hover:bg-shadow-800 rounded-lg disabled:opacity-30 transition-colors"
        >
          Next
        </button>
      </div>
    {/if}
  {/if}
</div>
