<script lang="ts">
  import { onMount } from 'svelte';
  import BoundedList from '$lib/components/garden/BoundedList.svelte';
  import CollapsibleSection from '$lib/components/garden/CollapsibleSection.svelte';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import {
    getEpisodicEpisodeDetail,
    getEpisodicThreadDetail,
    listEpisodicEpisodes,
    listEpisodicThreads,
  } from '$lib/api/endpoints/episodic-memory';
  import type {
    AdminEpisodicEpisodeDetailData,
    AdminEpisodicEpisodeListData,
    AdminEpisodicRelatedArcView,
    AdminEpisodicThreadDetailData,
    AdminEpisodicThreadSummary,
    EpisodeArtifactRef,
    EpisodeProvenanceRef,
    EpisodeSpanRef,
  } from '$lib/types';

  const PAGE_SIZE = 24;

  let episodeData = $state<AdminEpisodicEpisodeListData | null>(null);
  let threadData = $state<AdminEpisodicThreadSummary[]>([]);
  let selectedEpisode = $state<AdminEpisodicEpisodeDetailData | null>(null);
  let selectedThread = $state<AdminEpisodicThreadDetailData | null>(null);
  let loadingEpisodes = $state(true);
  let loadingThreads = $state(true);
  let loadingDetail = $state(false);
  let error = $state('');
  let detailError = $state('');
  let threadError = $state('');
  let selectedEpisodeId = $state<string | null>(null);
  let selectedThreadId = $state<string | null>(null);
  let threadIdFilter = $state('');
  let fromDateFilter = $state('');
  let toDateFilter = $state('');
  let offset = $state(0);

  let episodes = $derived(episodeData?.episodes ?? []);
  let pagination = $derived(episodeData?.pagination);

  function toStartInstant(date: string): string | undefined {
    return date ? `${date}T00:00:00.000Z` : undefined;
  }

  function toEndInstant(date: string): string | undefined {
    return date ? `${date}T23:59:59.999Z` : undefined;
  }

  function formatInstant(value: string | undefined): string {
    if (!value) return 'unknown';
    return new Date(value).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatRange(start: string | undefined, end: string | undefined): string {
    return `${formatInstant(start)} -- ${formatInstant(end)}`;
  }

  function percent(value: number | undefined): string {
    const clamped = Math.max(0, Math.min(1, value ?? 0));
    return `${Math.round(clamped * 100)}%`;
  }

  function hasInvalidDateRange(): boolean {
    return Boolean(fromDateFilter && toDateFilter && fromDateFilter > toDateFilter);
  }

  function provenanceKindLabel(ref: EpisodeProvenanceRef): string {
    const labels: Record<EpisodeProvenanceRef['kind'], string> = {
      l0_span: 'L0 span',
      l0_artifact: 'L0 artifact',
      turn: 'Turn',
      session: 'Session',
      operator_note: 'Operator note',
    };
    return labels[ref.kind];
  }

  function relatedEpisodeId(view: AdminEpisodicRelatedArcView): string {
    return view.direction === 'outgoing'
      ? view.arc.targetEpisodeId
      : view.arc.sourceEpisodeId;
  }

  function openRelatedEpisode(view: AdminEpisodicRelatedArcView): void {
    if (!view.relatedEpisode) return;
    void openEpisode(view.relatedEpisode.id);
  }

  async function loadEpisodes(): Promise<void> {
    if (hasInvalidDateRange()) {
      error = 'from (Start date) must be before or equal to to (End date).';
      return;
    }
    loadingEpisodes = true;
    error = '';
    try {
      episodeData = await listEpisodicEpisodes({
        threadId: threadIdFilter.trim() || undefined,
        from: toStartInstant(fromDateFilter),
        to: toEndInstant(toDateFilter),
        limit: PAGE_SIZE,
        offset,
      });
      if (!selectedEpisodeId && episodeData.episodes[0]) {
        await openEpisode(episodeData.episodes[0].id);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load episodic episodes';
    } finally {
      loadingEpisodes = false;
    }
  }

  async function loadThreads(): Promise<void> {
    loadingThreads = true;
    threadError = '';
    try {
      const payload = await listEpisodicThreads();
      threadData = payload.threads ?? [];
    } catch (e) {
      threadError = e instanceof Error ? e.message : 'Failed to load episodic threads';
    } finally {
      loadingThreads = false;
    }
  }

  async function openEpisode(id: string): Promise<void> {
    selectedEpisodeId = id;
    loadingDetail = true;
    detailError = '';
    try {
      selectedEpisode = await getEpisodicEpisodeDetail(id);
      if (selectedEpisode.episode.threadId) {
        selectedThreadId = selectedEpisode.episode.threadId;
        selectedThread = await getEpisodicThreadDetail(selectedEpisode.episode.threadId);
      }
    } catch (e) {
      selectedEpisode = null;
      detailError = e instanceof Error ? e.message : 'Failed to load episodic episode detail';
    } finally {
      loadingDetail = false;
    }
  }

  async function openThread(threadId: string, applyAsFilter = false): Promise<void> {
    selectedThreadId = threadId;
    threadError = '';
    try {
      selectedThread = await getEpisodicThreadDetail(threadId);
      if (applyAsFilter) {
        threadIdFilter = threadId;
        offset = 0;
        await loadEpisodes();
      }
    } catch (e) {
      selectedThread = null;
      threadError = e instanceof Error ? e.message : 'Failed to load episodic thread detail';
    }
  }

  async function applyFilters(): Promise<void> {
    offset = 0;
    await loadEpisodes();
  }

  async function clearFilters(): Promise<void> {
    threadIdFilter = '';
    fromDateFilter = '';
    toDateFilter = '';
    offset = 0;
    await loadEpisodes();
  }

  async function nextPage(): Promise<void> {
    if (!pagination?.hasNext) return;
    offset += PAGE_SIZE;
    await loadEpisodes();
  }

  async function previousPage(): Promise<void> {
    if (!pagination?.hasPrevious) return;
    offset = Math.max(0, offset - PAGE_SIZE);
    await loadEpisodes();
  }

  onMount(() => {
    void loadEpisodes();
    void loadThreads();
  });
</script>

<div class="garden-page space-y-5 pb-8">
  <div class="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
    <GardenPageHeader
      eyebrow="Memory & Identity"
      title="L0.1 Episodes"
      description="Inspect canonical episodes, L0 provenance, and woven episode-arc graph threads."
    />
    <div class="garden-metric-grid grid-cols-3 text-center sm:min-w-[24rem]">
      <div class="garden-metric card-garden p-3">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">episodes</p>
        <p class="font-serif text-xl text-shadow-900">{episodeData?.pagination.total ?? 0}</p>
      </div>
      <div class="garden-metric card-garden p-3">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">threads</p>
        <p class="font-serif text-xl text-shadow-900">{threadData.length}</p>
      </div>
      <div class="garden-metric card-garden p-3">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">selected</p>
        <p class="font-serif text-xl text-shadow-900">{selectedEpisode?.relatedArcs.length ?? 0}</p>
      </div>
    </div>
  </div>

  <div class="garden-toolbar card-garden space-y-3 p-4 sm:p-5">
    <div class="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_11rem_11rem_auto_auto]">
      <input
        data-search-shortcut
        type="text"
        bind:value={threadIdFilter}
        placeholder="threadId (Thread ID)"
        class="px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm
               placeholder:text-shadow-400 focus:outline-none focus:border-gold-400 focus:ring-2 focus:ring-gold-300"
      />
      <input
        type="date"
        bind:value={fromDateFilter}
        title="from (Start date)"
        class="px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm
               focus:outline-none focus:border-gold-400 focus:ring-2 focus:ring-gold-300"
      />
      <input
        type="date"
        bind:value={toDateFilter}
        title="to (End date)"
        class="px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm
               focus:outline-none focus:border-gold-400 focus:ring-2 focus:ring-gold-300"
      />
      <button
        onclick={applyFilters}
        class="px-4 py-2 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 transition-colors"
      >
        Apply
      </button>
      <button
        onclick={clearFilters}
        class="px-4 py-2 rounded-lg border border-bark-300 text-shadow-700 text-sm font-medium hover:bg-bark-200 transition-colors"
      >
        Reset
      </button>
    </div>
    {#if hasInvalidDateRange()}
      <p class="text-sm text-wilt-600">from (Start date) must be before or equal to to (End date).</p>
    {:else if pagination}
      <p class="text-sm text-shadow-700">
        Showing {(pagination.offset ?? 0) + 1}--{Math.min((pagination.offset ?? 0) + (pagination.limit ?? PAGE_SIZE), pagination.total ?? 0)}
        of {pagination.total ?? 0} canonical episodes.
      </p>
    {/if}
  </div>

  {#if error}
    <div class="garden-error card-garden p-4 border-wilt-200">
      <p class="text-sm text-wilt-600">{error}</p>
    </div>
  {/if}

  {#if episodeData?.withheldBySubjectAuthorizationCount !== undefined}
    <div class="rounded-xl border border-gold-200 bg-gold-50 p-4">
      <p class="text-sm text-gold-800">
        {episodeData.withheldBySubjectAuthorizationCount}
        {episodeData.withheldBySubjectAuthorizationCount === 1 ? 'episode is' : 'episodes are'}
        withheld by subject authorization for the current filters.
      </p>
    </div>
  {/if}

  <div class="garden-split-view">
    <section class="space-y-4">
      <div class="garden-section card-garden p-4 space-y-3">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="font-serif text-lg font-semibold text-shadow-900">threadId <span class="text-shadow-600">(woven threads)</span></h2>
            <p class="text-xs text-shadow-600">Threads are grouped from canonical episode <code>threadId</code> values.</p>
          </div>
          {#if loadingThreads}
            <span class="text-xs text-shadow-500">Loading...</span>
          {/if}
        </div>

        {#if threadError}
          <p class="text-sm text-wilt-600">{threadError}</p>
        {/if}

        {#if loadingThreads}
          {#each Array(3) as _}
            <div class="h-16 rounded-lg bg-bark-200 animate-pulse"></div>
          {/each}
        {:else if threadData.length === 0}
          <p class="garden-empty rounded-lg border border-bark-200 bg-bark-50 p-3 text-sm text-shadow-600">No threaded episodes found.</p>
        {:else}
          <BoundedList maxHeight="16rem" label="Woven threads">
            <div class="space-y-2 pr-1">
              {#each threadData as thread (thread.threadId)}
                <button
                  onclick={() => { void openThread(thread.threadId, true); }}
                  class={`w-full rounded-xl border p-3 text-left transition-colors ${
                    selectedThreadId === thread.threadId
                      ? 'border-gold-500 bg-gold-50'
                      : 'border-bark-200 bg-bark-50 hover:bg-bark-100'
                  }`}
                >
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <p class="font-medium text-shadow-900 truncate">{thread.latestEpisodeTitle}</p>
                      <p class="mt-1 text-xs text-shadow-600">{formatRange(thread.startedAt, thread.endedAt)}</p>
                    </div>
                    <span class="shrink-0 rounded-full bg-bark-200 px-2 py-0.5 text-xs text-shadow-700">
                      {thread.episodeCount} eps
                    </span>
                  </div>
                </button>
              {/each}
            </div>
          </BoundedList>
        {/if}
      </div>

      <div class="space-y-3">
        {#if loadingEpisodes}
          {#each Array(3) as _}
            <div class="garden-loading card-garden p-4 animate-pulse">
              <div class="h-4 bg-bark-200 rounded w-2/3 mb-2"></div>
              <div class="h-3 bg-bark-200 rounded w-full mb-1"></div>
              <div class="h-3 bg-bark-200 rounded w-4/5"></div>
            </div>
          {/each}
        {:else if episodes.length === 0}
          <div class="garden-empty card-garden p-6 text-center">
            <p class="text-shadow-600 text-sm">No L0.1 episodes match the current filters.</p>
          </div>
        {:else}
          <BoundedList maxHeight="24rem" label="Canonical episodes">
            <div class="space-y-3 pr-1">
              {#each episodes as episode (episode.id)}
                <button
                  onclick={() => { void openEpisode(episode.id); }}
                  class={`card-garden w-full p-4 text-left transition-all ${
                    selectedEpisodeId === episode.id ? 'border-gold-500 shadow-md' : 'hover:border-gold-300'
                  }`}
                >
                  <div class="flex items-start justify-between gap-3">
                    <h3 class="min-w-0 font-serif text-lg font-semibold text-shadow-900">{episode.title}</h3>
                    <span class="shrink-0 rounded-full bg-bark-200 px-2 py-0.5 text-xs text-shadow-700">
                      {episode.spanRefs.length + episode.artifactRefs.length} refs
                    </span>
                  </div>
                  <p class="mt-2 text-sm text-shadow-700 line-clamp-2">{episode.landmark}</p>
                  <p class="mt-2 text-xs text-shadow-600">{formatRange(episode.startedAt, episode.endedAt)}</p>
                </button>
              {/each}
            </div>
          </BoundedList>
        {/if}
      </div>

      {#if pagination && !loadingEpisodes}
        <div class="flex items-center justify-between">
          <button
            onclick={previousPage}
            disabled={!pagination.hasPrevious}
            class="px-4 py-2 rounded-lg border border-bark-300 text-shadow-800 text-sm font-medium
                   hover:bg-bark-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Previous
          </button>
          <span class="text-sm text-shadow-700">
            Page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.max(1, Math.ceil(((pagination.total ?? 0) || 1) / PAGE_SIZE))}
          </span>
          <button
            onclick={nextPage}
            disabled={!pagination.hasNext}
            class="px-4 py-2 rounded-lg border border-bark-300 text-shadow-800 text-sm font-medium
                   hover:bg-bark-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Next
          </button>
        </div>
      {/if}
    </section>

    <section class="space-y-4">
      {#if loadingDetail}
        <div class="card-garden p-5 space-y-2">
          <div class="h-5 w-1/3 rounded bg-bark-200 animate-pulse"></div>
          <div class="h-3 w-full rounded bg-bark-200 animate-pulse"></div>
          <div class="h-3 w-5/6 rounded bg-bark-200 animate-pulse"></div>
        </div>
      {:else if detailError}
        <div class="card-garden p-5">
          <p class="text-sm text-wilt-600">{detailError}</p>
        </div>
      {:else if selectedEpisode}
        <div class="card-garden p-5 space-y-4">
          <div>
            <h2 class="font-serif text-2xl font-semibold text-shadow-900">{selectedEpisode.episode.title}</h2>
            <p class="mt-1 text-sm text-shadow-600">{formatRange(selectedEpisode.episode.startedAt, selectedEpisode.episode.endedAt)}</p>
          </div>

          <p class="text-sm leading-relaxed text-shadow-800">{selectedEpisode.episode.landmark}</p>

          {#if selectedEpisode.episode.meaning}
            <div class="rounded-xl border border-moss-200 bg-moss-50 p-4">
              <p class="text-xs uppercase tracking-[0.16em] text-moss-700">meaning <span class="normal-case tracking-normal">(the companion's own take)</span></p>
              <p class="mt-1 text-sm leading-relaxed text-shadow-800">{selectedEpisode.episode.meaning.text}</p>
            </div>
          {/if}

          {#if selectedEpisode.episode.themes.length > 0}
            <div class="flex flex-wrap gap-2">
              {#each selectedEpisode.episode.themes as theme}
                <span class="rounded-full bg-moss-50 px-2.5 py-0.5 text-xs text-moss-700 border border-moss-200">{theme}</span>
              {/each}
            </div>
          {/if}
        </div>

        <CollapsibleSection
          title="Provenance"
          subtitle="spanRefs, artifactRefs, provenanceRefs -- how this episode formed"
          count={selectedEpisode.spanRefs.length + selectedEpisode.artifactRefs.length + selectedEpisode.provenanceRefs.length}
        >
          <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {@render ReferenceList('spanRefs', 'L0 spans', selectedEpisode.spanRefs)}
            {@render ReferenceList('artifactRefs', 'L0 artifacts', selectedEpisode.artifactRefs)}
            {@render ProvenanceList(selectedEpisode.provenanceRefs)}
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="Related arcs"
          subtitle="l01_episode_arcs graph links"
          count={selectedEpisode.relatedArcs.length}
        >
          {#if selectedEpisode.relatedArcs.length === 0}
            <p class="text-sm text-shadow-600">No graph links are recorded for this episode.</p>
          {:else}
            <div class="space-y-2">
              {#each selectedEpisode.relatedArcs as view}
                <div class="rounded-lg border border-bark-200 bg-bark-50 p-3">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="rounded-full bg-gold-100 px-2 py-0.5 text-xs text-gold-800">{view.direction}</span>
                    <span class="rounded-full bg-bark-200 px-2 py-0.5 text-xs text-shadow-700">{view.arc.arcKind}</span>
                    <code class="text-xs text-shadow-700">{view.arc.id}</code>
                  </div>
                  <p class="mt-2 text-sm text-shadow-800">
                    {view.arc.sourceEpisodeId} -> {view.arc.targetEpisodeId}
                  </p>
                  <p class="mt-1 text-xs text-shadow-600">
                    relatedEpisode.id {relatedEpisodeId(view)} -
                    confidence {percent(view.arc.confidence)} -
                    salience {percent(view.arc.salience)}
                  </p>
                  {#if view.relatedEpisode}
                    <button
                      onclick={() => openRelatedEpisode(view)}
                      class="mt-2 text-sm font-medium text-gold-700 hover:text-gold-600"
                    >
                      Open related episode
                    </button>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </CollapsibleSection>

        <CollapsibleSection title="Details" subtitle="ids, scores, and raw fields">
          <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
            {@render DetailField('episode.id', selectedEpisode.episode.id)}
            {@render DetailField('threadId', selectedEpisode.episode.threadId ?? 'none')}
            {@render DetailField('channelId', selectedEpisode.episode.channelId ?? 'none')}
            {@render DetailField(
              'participantContactIds',
              selectedEpisode.episode.participantContactIds.join(', ') || 'none',
            )}
            {@render DetailField(
              'salience (score / novelty / emotionalIntensity)',
              `${percent(selectedEpisode.episode.salience.score)} / ${selectedEpisode.episode.salience.novelty ?? 'n/a'} / ${selectedEpisode.episode.salience.emotionalIntensity ?? 'n/a'}`,
            )}
            {@render DetailField(
              'affect (VAD)',
              `valence ${selectedEpisode.episode.affect.valence ?? 'n/a'} - arousal ${selectedEpisode.episode.affect.arousal ?? 'n/a'} - dominance ${selectedEpisode.episode.affect.dominance ?? 'n/a'}`,
            )}
            {@render DetailField('affect.labels', selectedEpisode.episode.affect.labels.join(', ') || 'none')}
            {@render DetailField(
              'createdAt / updatedAt',
              `${formatInstant(selectedEpisode.episode.createdAt)} / ${formatInstant(selectedEpisode.episode.updatedAt)}`,
            )}
          </div>
        </CollapsibleSection>
      {:else}
        <div class="card-garden p-5">
          <p class="text-sm text-shadow-600">Select an episode to inspect its canonical contract, provenance, and graph links.</p>
        </div>
      {/if}

      {#if selectedThread}
        <div class="card-garden p-5 space-y-4">
          <div>
            <h2 class="font-serif text-xl font-semibold text-shadow-900">threadId <span class="text-shadow-600">(selected thread)</span></h2>
            <p class="mt-1 break-all text-sm text-shadow-700">{selectedThread.thread.threadId}</p>
            <p class="mt-1 text-xs text-shadow-600">
              {selectedThread.thread.episodeCount} episodes - {selectedThread.thread.arcCount} arcs -
              {formatRange(selectedThread.thread.startedAt, selectedThread.thread.endedAt)}
            </p>
          </div>

          {#if selectedThread.thread.topThemes.length > 0}
            <div class="flex flex-wrap gap-2">
              {#each selectedThread.thread.topThemes as theme}
                <span class="rounded-full bg-moss-50 px-2.5 py-0.5 text-xs text-moss-700 border border-moss-200">{theme}</span>
              {/each}
            </div>
          {/if}

          <BoundedList maxHeight="12rem" label="Episodes in thread">
            <div class="space-y-2 pr-1">
              {#each selectedThread.episodes as episode (episode.id)}
                <button
                  onclick={() => { void openEpisode(episode.id); }}
                  class="w-full rounded-lg border border-bark-200 bg-bark-50 px-3 py-2 text-left hover:bg-bark-100 transition-colors"
                >
                  <div class="flex items-start justify-between gap-3">
                    <p class="min-w-0 truncate text-sm font-medium text-shadow-900">{episode.title}</p>
                    <span class="shrink-0 text-xs text-shadow-600">{formatInstant(episode.startedAt)}</span>
                  </div>
                </button>
              {/each}
            </div>
          </BoundedList>
        </div>

        <CollapsibleSection title="Thread details" subtitle="scores and raw fields">
          <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
            {@render DetailField('salienceScore', percent(selectedThread.thread.salienceScore))}
            {@render DetailField('latestEpisodeId', selectedThread.thread.latestEpisodeId)}
            {@render DetailField('latestEpisodeTitle', selectedThread.thread.latestEpisodeTitle)}
          </div>
        </CollapsibleSection>
      {/if}
    </section>
  </div>
</div>

{#snippet DetailField(label: string, value: string)}
  <div class="rounded-lg border border-bark-200 bg-bark-50 p-3">
    <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">{label}</p>
    <p class="mt-1 break-all text-sm text-shadow-900">{value}</p>
  </div>
{/snippet}

{#snippet ReferenceList(title: string, subtitle: string, refs: EpisodeSpanRef[] | EpisodeArtifactRef[])}
  <div class="rounded-xl border border-bark-200 bg-bark-50 p-4">
    <h3 class="font-medium text-shadow-900">{title} <span class="text-shadow-600">({subtitle})</span></h3>
    {#if refs.length === 0}
      <p class="mt-2 text-sm text-shadow-600">none</p>
    {:else}
      <div class="mt-3 space-y-2">
        {#each refs as ref}
          <div class="rounded border border-bark-200 bg-bark-100 p-2 text-xs text-shadow-700">
            {#if 'spanId' in ref}
              <p><span class="font-medium text-shadow-900">spanId</span> <code>{ref.spanId}</code></p>
              {#if ref.channelId}<p>channelId <code>{ref.channelId}</code></p>{/if}
              {#if ref.sessionId}<p>sessionId <code>{ref.sessionId}</code></p>{/if}
            {:else}
              <p><span class="font-medium text-shadow-900">artifactId</span> <code>{ref.artifactId}</code></p>
              {#if ref.artifactType}<p>artifactType <code>{ref.artifactType}</code></p>{/if}
              {#if ref.path}<p>path <code>{ref.path}</code></p>{/if}
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet ProvenanceList(refs: EpisodeProvenanceRef[])}
  <div class="rounded-xl border border-bark-200 bg-bark-50 p-4">
    <h3 class="font-medium text-shadow-900">provenanceRefs <span class="text-shadow-600">(Provenance)</span></h3>
    {#if refs.length === 0}
      <p class="mt-2 text-sm text-shadow-600">none</p>
    {:else}
      <div class="mt-3 space-y-2">
        {#each refs as ref}
          <div class="rounded border border-bark-200 bg-bark-100 p-2 text-xs text-shadow-700">
            <p>
              <span class="font-medium text-shadow-900">{ref.kind}</span>
              <span class="text-shadow-600">({provenanceKindLabel(ref)})</span>
            </p>
            <p>refId <code>{ref.refId}</code></p>
            {#if ref.note}<p>note {ref.note}</p>{/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}
