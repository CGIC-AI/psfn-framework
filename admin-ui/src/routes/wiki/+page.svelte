<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getWikiDocument,
    listWikiDocuments,
    searchWikiDocuments,
    type WikiListResponse,
  } from '$lib/api/endpoints/wiki';
  import type { WikiDocument, WikiDocumentListEntry, WikiSearchMatch } from '../../../../src/faculties/wiki/types';

  let data = $state<WikiListResponse | null>(null);
  let selected = $state<WikiDocument | null>(null);
  let searchMatches = $state<WikiSearchMatch[]>([]);
  let loading = $state(true);
  let refreshing = $state(false);
  let loadingDocumentId = $state('');
  let errorMessage = $state('');
  let searchQuery = $state('');

  let documents = $derived(data?.documents ?? []);
  let selectedId = $derived(selected?.id ?? '');

  async function loadDocuments() {
    errorMessage = '';
    try {
      data = await listWikiDocuments();
      if (!selected && data.documents[0]) {
        await selectDocument(data.documents[0].id);
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Failed to load wiki documents.';
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  async function refreshDocuments() {
    refreshing = true;
    await loadDocuments();
  }

  async function selectDocument(id: string) {
    loadingDocumentId = id;
    errorMessage = '';
    try {
      selected = await getWikiDocument(id);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Failed to load wiki document.';
    } finally {
      loadingDocumentId = '';
    }
  }

  async function runSearch() {
    const query = searchQuery.trim();
    if (!query) {
      searchMatches = [];
      return;
    }
    errorMessage = '';
    try {
      const result = await searchWikiDocuments(query);
      searchMatches = result.matches;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Failed to search wiki documents.';
    }
  }

  function formatDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  }

  function formatTags(tags: string[]): string {
    return tags.length ? tags.join(', ') : 'none';
  }

  function sourceLabel(value: string): string {
    return value.replaceAll('_', ' ');
  }

  function documentPreview(document: WikiDocumentListEntry): string {
    return document.summary || document.preview || 'No preview.';
  }

  onMount(() => {
    void loadDocuments();
  });
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <p class="text-xs uppercase tracking-[0.2em] text-shadow-500">The Library</p>
      <h1 class="mt-1 text-2xl font-serif font-bold text-shadow-900">Wiki</h1>
      <p class="mt-1 text-sm text-shadow-600">
        {documents.length} document{documents.length === 1 ? '' : 's'} in workspace-backed knowledge storage
      </p>
    </div>
    <button
      onclick={refreshDocuments}
      disabled={refreshing}
      class="rounded-xl border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {refreshing ? 'Refreshing...' : 'Refresh'}
    </button>
  </div>

  {#if errorMessage}
    <div class="card-garden border-l-4 border-l-wilt-400 p-4">
      <p class="text-sm font-medium text-wilt-700">{errorMessage}</p>
    </div>
  {/if}

  {#if data}
    <section class="card-garden p-5">
      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div>
          <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Boundary</p>
          <p class="mt-2 text-sm text-shadow-700">{data.boundary}</p>
        </div>
        <div>
          <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Workspace</p>
          <p class="mt-2 truncate font-mono text-xs text-shadow-700">{data.roots.workspaceRoot}</p>
        </div>
        <div>
          <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Wiki Root</p>
          <p class="mt-2 truncate font-mono text-xs text-shadow-700">{data.roots.wikiRoot}</p>
        </div>
        <div>
          <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Documents</p>
          <p class="mt-2 text-sm font-semibold text-shadow-900">{documents.length}</p>
        </div>
      </div>
    </section>
  {/if}

  <section class="grid gap-5 xl:grid-cols-[0.85fr,1.15fr]">
    <div class="space-y-5">
      <section class="card-garden p-5">
        <div class="flex flex-wrap items-end gap-3">
          <label class="min-w-0 flex-1">
            <span class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Search</span>
            <input
              type="search"
              bind:value={searchQuery}
              onkeydown={(event) => {
                if (event.key === 'Enter') void runSearch();
              }}
              class="mt-2 w-full rounded-xl border border-bark-300 bg-white px-3 py-2 text-sm text-shadow-900 outline-none transition-colors placeholder:text-shadow-400 focus:border-gold-400"
              placeholder="Search wiki text"
            />
          </label>
          <button
            type="button"
            onclick={runSearch}
            class="rounded-xl border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100"
          >
            Search
          </button>
        </div>

        {#if searchMatches.length}
          <div class="mt-4 space-y-3">
            {#each searchMatches as match}
              <button
                type="button"
                onclick={() => selectDocument(match.id)}
                class="block w-full rounded-xl border border-bark-200 bg-bark-50 px-4 py-3 text-left transition-colors hover:bg-bark-100"
              >
                <p class="text-sm font-medium text-shadow-900">{match.title}</p>
                <p class="mt-1 line-clamp-2 text-sm text-shadow-600">{match.preview}</p>
                <p class="mt-2 text-xs uppercase tracking-[0.14em] text-shadow-500">{sourceLabel(match.sourceClass)}</p>
              </button>
            {/each}
          </div>
        {/if}
      </section>

      <section class="space-y-3">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-base font-serif font-semibold text-shadow-900">Documents</h2>
          <span class="text-sm text-shadow-600">{documents.length}</span>
        </div>

        {#if loading}
          <div class="card-garden animate-pulse p-5">
            <div class="h-4 w-2/3 rounded bg-bark-200"></div>
            <div class="mt-3 h-3 w-full rounded bg-bark-100"></div>
            <div class="mt-2 h-3 w-5/6 rounded bg-bark-100"></div>
          </div>
        {:else if documents.length}
          <div class="space-y-3">
            {#each documents as document}
              <button
                type="button"
                onclick={() => selectDocument(document.id)}
                class="block w-full rounded-xl border px-4 py-3 text-left transition-colors {selectedId === document.id ? 'border-gold-300 bg-gold-50' : 'border-bark-200 bg-white hover:bg-bark-50'}"
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <p class="truncate text-sm font-semibold text-shadow-900">{document.title}</p>
                    <p class="mt-1 line-clamp-2 text-sm text-shadow-600">{documentPreview(document)}</p>
                  </div>
                  <span class="shrink-0 rounded-full border border-bark-200 bg-bark-50 px-2 py-0.5 text-xs font-medium text-shadow-600">
                    v{document.version}
                  </span>
                </div>
                <p class="mt-2 text-xs uppercase tracking-[0.14em] text-shadow-500">
                  {sourceLabel(document.sourceClass)} | {document.sensitivity} | {formatDate(document.updatedAt)}
                </p>
              </button>
            {/each}
          </div>
        {:else}
          <div class="card-garden p-6">
            <p class="text-sm text-shadow-600">No wiki documents found.</p>
          </div>
        {/if}
      </section>
    </div>

    <section class="card-garden min-w-0 p-5">
      {#if selected}
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">{sourceLabel(selected.sourceClass)}</p>
            <h2 class="mt-1 text-xl font-serif font-semibold text-shadow-900">{selected.title}</h2>
            <p class="mt-1 truncate font-mono text-xs text-shadow-500">{selected.bodyPath}</p>
          </div>
          {#if loadingDocumentId === selected.id}
            <span class="text-sm text-shadow-500">Loading...</span>
          {/if}
        </div>

        <dl class="mt-5 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt class="text-xs uppercase tracking-[0.14em] text-shadow-500">Sensitivity</dt>
            <dd class="mt-1 font-medium text-shadow-800">{selected.sensitivity}</dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-[0.14em] text-shadow-500">Tags</dt>
            <dd class="mt-1 text-shadow-800">{formatTags(selected.tags)}</dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-[0.14em] text-shadow-500">Updated</dt>
            <dd class="mt-1 text-shadow-800">{formatDate(selected.updatedAt)}</dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-[0.14em] text-shadow-500">Revision</dt>
            <dd class="mt-1 text-shadow-800">v{selected.version}</dd>
          </div>
        </dl>

        {#if selected.provenanceRefs.length}
          <div class="mt-5">
            <p class="text-xs uppercase tracking-[0.14em] text-shadow-500">Provenance</p>
            <div class="mt-2 flex flex-wrap gap-2">
              {#each selected.provenanceRefs as ref}
                <code class="rounded-lg border border-bark-200 bg-bark-50 px-2 py-1 text-xs text-shadow-700">{ref}</code>
              {/each}
            </div>
          </div>
        {/if}

        <pre class="mt-5 max-h-[56rem] overflow-auto whitespace-pre-wrap rounded-xl border border-bark-200 bg-white p-4 text-sm leading-relaxed text-shadow-800">{selected.body}</pre>
      {:else}
        <p class="text-sm text-shadow-600">Select a wiki document.</p>
      {/if}
    </section>
  </section>
</div>
