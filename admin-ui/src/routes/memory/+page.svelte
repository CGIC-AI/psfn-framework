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
  let selectedMemoryId = $state<string | null>(null);
  let archiving = $state<string | null>(null);

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
    public: 'bg-bark-200 text-bark-600 dark:bg-bark-800/40 dark:text-bark-400',
    personal: 'bg-moss-100 text-moss-700 dark:bg-moss-900/30 dark:text-moss-400',
    intimate: 'bg-petal-100 text-petal-600 dark:bg-petal-900/30 dark:text-petal-400',
    confidential: 'bg-wilt-100 text-wilt-700 dark:bg-wilt-900/30 dark:text-wilt-400',
  };

  function isRelationalMemory(m: PurrMemory): boolean {
    return m.type === 'relational' || m.type === 'emotional';
  }

  function contactName(m: PurrMemory): string | null {
    if (!m.contactId || !data?.contactsById[m.contactId]) return null;
    return data.contactsById[m.contactId].displayName;
  }

  function parseProvenance(sourceRef: string): string[] {
    return sourceRef
      .split('|')
      .map(s => s.trim())
      .filter(Boolean)
      .map(formatProvenanceSegment);
  }

  function formatProvenanceSegment(segment: string): string {
    if (segment.startsWith('source:')) return `source ${segment.slice('source:'.length)}`;
    if (segment.startsWith('session:')) return `session ${segment.slice('session:'.length)}`;
    if (segment.startsWith('lines:')) return `lines ${segment.slice('lines:'.length)}`;
    if (segment.startsWith('visibility:')) return `visibility ${segment.slice('visibility:'.length)}`;
    if (segment.startsWith('operation:')) return `operation ${segment.slice('operation:'.length)}`;
    if (segment.startsWith('invocation:')) return `invocation ${segment.slice('invocation:'.length)}`;
    if (segment.startsWith('item:')) return `item ${segment.slice('item:'.length)}`;
    return segment;
  }

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

  async function handleSupersede(id: string) {
    if (!confirm('Supersede this memory? It will be marked as archived and excluded from retrieval.')) return;
    archiving = id;
    try {
      await deleteMemory(id);
      await loadMemories();
      selectedMemoryId = null;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to supersede memory';
    } finally {
      archiving = null;
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

  function applyPageSize(newSize: number) {
    if (newSize >= 1 && newSize <= 200) {
      pageSize = newSize;
      currentOffset = 0;
      loadMemories();
    }
  }

  function formatDate(ts: number): string {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatDateTime(ts: number): string {
    return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max) + '...' : text;
  }

  function pct(val: number): string {
    return (val * 100).toFixed(0) + '%';
  }

  let initialized = $state(false);

  onMount(() => {
    initialized = true;
    loadMemories();
  });

  $effect(() => {
    // Reload when filter changes (skip initial mount — onMount handles that)
    void typeFilter;
    if (!initialized) return;
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

    <!-- Page size selector -->
    <div class="flex items-center gap-1.5">
      <label for="page-size" class="text-xs text-shadow-400 dark:text-bark-500">Show</label>
      <select
        id="page-size"
        value={String(pageSize)}
        onchange={(e) => applyPageSize(Number((e.target as HTMLSelectElement).value))}
        class="px-2 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm"
      >
        <option value="10">10</option>
        <option value="25">25</option>
        <option value="50">50</option>
        <option value="100">100</option>
      </select>
    </div>
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
        {@const contact = contactName(memory)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="w-full text-left card-garden p-4 cursor-pointer transition-all
            {selectedMemoryId === memory.id ? 'filigree-border-strong ring-1 ring-gold-300' : ''}"
          onclick={() => selectedMemoryId = selectedMemoryId === memory.id ? null : memory.id}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectedMemoryId = selectedMemoryId === memory.id ? null : memory.id; }}}
          role="button"
          tabindex="0"
        >
          <div class="flex items-start gap-3">
            <div class="flex flex-wrap gap-1.5 shrink-0">
              <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium {TYPE_BADGE[memory.type] || 'bg-bark-200 text-bark-600'}">
                {memory.type}
              </span>
              <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium {SENSITIVITY_BADGE[memory.sensitivity] || 'bg-bark-100 text-bark-500'}">
                {memory.sensitivity}
              </span>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm text-shadow-800 dark:text-bark-200 leading-relaxed">{truncate(memory.text, 200)}</p>
              <div class="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-shadow-400 dark:text-bark-500">
                <span>Salience: {pct(memory.salience)}</span>
                <span>Importance: {pct(memory.importance)}</span>
                <span>{formatDate(memory.extractedAt)}</span>
                {#if contact && isRelationalMemory(memory)}
                  <span class="inline-flex items-center gap-1 text-gold-700 dark:text-gold-400">
                    <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"/></svg>
                    {contact}
                  </span>
                {/if}
                {#if memory.supersededBy}
                  <span class="text-wilt-500 italic">superseded</span>
                {/if}
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
          {#if selectedMemoryId === memory.id}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="mt-4 pt-4 border-t border-bark-200 dark:border-shadow-700 space-y-4"
              onclick={(e) => e.stopPropagation()}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
            >
              <!-- Full text -->
              <div>
                <span class="text-[11px] font-medium text-shadow-400 dark:text-bark-500 uppercase tracking-wider">Full Text</span>
                <p class="mt-1 text-sm text-shadow-800 dark:text-bark-200 whitespace-pre-wrap leading-relaxed">{memory.text}</p>
              </div>

              <!-- Metrics grid -->
              <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div>
                  <span class="text-shadow-400 dark:text-bark-500">ID</span>
                  <p class="font-mono text-shadow-600 dark:text-bark-400 break-all mt-0.5">{memory.id}</p>
                </div>
                <div>
                  <span class="text-shadow-400 dark:text-bark-500">Salience</span>
                  <p class="text-shadow-700 dark:text-bark-300 mt-0.5">{(memory.salience * 100).toFixed(1)}%</p>
                </div>
                <div>
                  <span class="text-shadow-400 dark:text-bark-500">Importance</span>
                  <p class="text-shadow-700 dark:text-bark-300 mt-0.5">{(memory.importance * 100).toFixed(1)}%</p>
                </div>
                <div>
                  <span class="text-shadow-400 dark:text-bark-500">Confidence</span>
                  <p class="text-shadow-700 dark:text-bark-300 mt-0.5">{(memory.confidence * 100).toFixed(1)}%</p>
                </div>
                <div>
                  <span class="text-shadow-400 dark:text-bark-500">Emotional Valence</span>
                  <p class="text-shadow-700 dark:text-bark-300 mt-0.5">{memory.emotionalValence.toFixed(3)}</p>
                </div>
                <div>
                  <span class="text-shadow-400 dark:text-bark-500">Sensitivity</span>
                  <p class="mt-0.5">
                    <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium {SENSITIVITY_BADGE[memory.sensitivity] || ''}">
                      {memory.sensitivity}
                    </span>
                  </p>
                </div>
                <div>
                  <span class="text-shadow-400 dark:text-bark-500">Access Count</span>
                  <p class="text-shadow-700 dark:text-bark-300 mt-0.5">{memory.accessCount}</p>
                </div>
                <div>
                  <span class="text-shadow-400 dark:text-bark-500">Retention</span>
                  <p class="text-shadow-700 dark:text-bark-300 mt-0.5 capitalize">{memory.retentionClass ?? 'standard'}</p>
                </div>
              </div>

              <!-- Contact (for relational/emotional memories) -->
              {#if memory.contactId || isRelationalMemory(memory)}
                <div>
                  <span class="text-[11px] font-medium text-shadow-400 dark:text-bark-500 uppercase tracking-wider">Related Contact</span>
                  {#if memory.contactId && data.contactsById[memory.contactId]}
                    <p class="mt-1 text-sm">
                      <a
                        href="/contacts"
                        class="text-gold-700 dark:text-gold-400 hover:underline inline-flex items-center gap-1"
                        onclick={(e) => e.stopPropagation()}
                      >
                        <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"/></svg>
                        {data.contactsById[memory.contactId].displayName}
                      </a>
                    </p>
                  {:else if memory.contactId}
                    <p class="mt-1 text-xs text-shadow-500 font-mono">{memory.contactId}</p>
                  {:else}
                    <p class="mt-1 text-xs text-shadow-400 dark:text-bark-500 italic">No linked contact</p>
                  {/if}
                </div>
              {/if}

              <!-- Provenance chain -->
              {#if memory.sourceRef}
                {@const segments = parseProvenance(memory.sourceRef)}
                <div>
                  <span class="text-[11px] font-medium text-shadow-400 dark:text-bark-500 uppercase tracking-wider">Provenance</span>
                  {#if segments.length > 0}
                    <div class="mt-1.5 flex flex-wrap items-center gap-1 text-xs">
                      {#each segments as segment, i}
                        <span class="inline-flex items-center px-2 py-1 rounded bg-bark-100 dark:bg-shadow-800 text-shadow-600 dark:text-bark-400">{segment}</span>
                        {#if i < segments.length - 1}
                          <svg class="w-3.5 h-3.5 text-gold-400 dark:text-gold-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
                        {/if}
                      {/each}
                    </div>
                  {:else}
                    <p class="mt-1 text-xs text-shadow-400 dark:text-bark-500 italic">none</p>
                  {/if}
                </div>

                <div>
                  <span class="text-[11px] font-medium text-shadow-400 dark:text-bark-500 uppercase tracking-wider">Source (raw)</span>
                  <p class="mt-0.5 text-xs font-mono text-shadow-500 dark:text-bark-400 break-all">{memory.sourceRef}</p>
                </div>
              {/if}

              <!-- Dates -->
              <div class="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                <div>
                  <span class="text-shadow-400 dark:text-bark-500">Extracted</span>
                  <p class="text-shadow-700 dark:text-bark-300 mt-0.5">{formatDateTime(memory.extractedAt)}</p>
                </div>
                <div>
                  <span class="text-shadow-400 dark:text-bark-500">Last Accessed</span>
                  <p class="text-shadow-700 dark:text-bark-300 mt-0.5">{formatDateTime(memory.lastAccessed)}</p>
                </div>
                {#if memory.supersededBy}
                  <div>
                    <span class="text-shadow-400 dark:text-bark-500">Superseded By</span>
                    <p class="font-mono text-wilt-600 dark:text-wilt-400 mt-0.5 break-all">{memory.supersededBy}</p>
                  </div>
                {/if}
              </div>

              <!-- Tags -->
              {#if memory.tags.length > 0}
                <div>
                  <span class="text-[11px] font-medium text-shadow-400 dark:text-bark-500 uppercase tracking-wider">Tags</span>
                  <div class="flex flex-wrap gap-1.5 mt-1.5">
                    {#each memory.tags as tag}
                      <span class="bg-bark-100 dark:bg-shadow-800 px-2 py-0.5 rounded text-xs text-shadow-600 dark:text-bark-400">{tag}</span>
                    {/each}
                  </div>
                </div>
              {/if}

              <!-- Actions -->
              <div class="flex gap-2 pt-2 border-t border-bark-100 dark:border-shadow-800">
                <button
                  onclick={(e) => { e.stopPropagation(); handleSupersede(memory.id); }}
                  disabled={archiving === memory.id || !!memory.supersededBy}
                  class="px-3 py-1.5 text-xs font-medium text-wilt-600 hover:text-white hover:bg-wilt-500 border border-wilt-300 dark:border-wilt-700 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {#if archiving === memory.id}
                    Archiving...
                  {:else if memory.supersededBy}
                    Already Superseded
                  {:else}
                    Supersede
                  {/if}
                </button>
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class="card-garden p-8 text-center">
          <p class="text-shadow-400 dark:text-bark-500 italic">No memories found</p>
        </div>
      {/each}
    </div>

    <!-- Pagination -->
    {#if data.pagination.total > 0}
      <div class="flex items-center justify-between card-garden p-3">
        <button
          onclick={prevPage}
          disabled={!data.pagination.hasPrevious}
          class="px-3 py-1.5 text-sm text-shadow-600 dark:text-bark-400 hover:bg-bark-100 dark:hover:bg-shadow-800 rounded-lg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          &larr; Previous
        </button>
        <span class="text-xs text-shadow-400 dark:text-bark-500">
          {#if data.pagination.total > 0}
            {currentOffset + 1}&ndash;{Math.min(currentOffset + pageSize, data.pagination.total)} of {data.pagination.total}
          {:else}
            0 memories
          {/if}
        </span>
        <button
          onclick={nextPage}
          disabled={!data.pagination.hasNext}
          class="px-3 py-1.5 text-sm text-shadow-600 dark:text-bark-400 hover:bg-bark-100 dark:hover:bg-shadow-800 rounded-lg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          Next &rarr;
        </button>
      </div>
    {/if}
  {/if}
</div>
