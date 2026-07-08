<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getReflectionDailyData,
    getReflectionJournalData,
    getReflectionMetacognitionData,
    getValuesData,
  } from '$lib/api/endpoints/values';
  import {
    ensureCompanionNameLoaded,
    getCompanionName,
  } from '$lib/stores/companion.svelte';
  import type {
    ReflectionDailyJournalEntry,
    ReflectionJournalEntry,
    ReflectionMetacognitionJournalEntry,
    ValuesJournalEntry,
  } from '$lib/types';

  type JournalTab = 'values' | 'metacognition' | 'daily' | 'reflection';

  interface JournalState<T> {
    entries: T[];
    error: string;
    endpointMissing: boolean;
  }

  function emptyJournalState<T>(): JournalState<T> {
    return {
      entries: [],
      error: '',
      endpointMissing: false,
    };
  }

  let values = $state<JournalState<ValuesJournalEntry>>(emptyJournalState());
  let metacognition = $state<JournalState<ReflectionMetacognitionJournalEntry>>(emptyJournalState());
  let daily = $state<JournalState<ReflectionDailyJournalEntry>>(emptyJournalState());
  let reflection = $state<JournalState<ReflectionJournalEntry>>(emptyJournalState());
  let loading = $state(true);
  let activeTab = $state<JournalTab>('values');
  const companionName = $derived(getCompanionName());

  const tabs = $derived([
    { id: 'values' as const, label: 'Values', count: values.entries.length },
    { id: 'metacognition' as const, label: 'Metacognition', count: metacognition.entries.length },
    { id: 'daily' as const, label: 'Daily', count: daily.entries.length },
    { id: 'reflection' as const, label: 'Reflections', count: reflection.entries.length },
  ]);

  function formatDate(isoStr: string): string {
    const date = new Date(isoStr);
    return date.toLocaleDateString();
  }

  function formatTime(isoStr: string): string {
    const date = new Date(isoStr);
    return date.toLocaleTimeString();
  }

  function formatDateTime(isoStr: string): string {
    const date = new Date(isoStr);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  }

  function readJournalResult<T>(
    result: PromiseSettledResult<{ entries: T[] }>,
    fallbackMessage: string,
  ): JournalState<T> {
    if (result.status === 'fulfilled') {
      return {
        entries: result.value.entries,
        error: '',
        endpointMissing: false,
      };
    }
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return {
      entries: [],
      error: message || fallbackMessage,
      endpointMissing: message.includes('404') || message.includes('503'),
    };
  }

  async function loadData() {
    loading = true;

    const [
      valuesResult,
      metacognitionResult,
      dailyResult,
      reflectionResult,
    ] = await Promise.allSettled([
      getValuesData(),
      getReflectionMetacognitionData(),
      getReflectionDailyData(),
      getReflectionJournalData(),
    ]);

    values = readJournalResult(valuesResult, 'Failed to load values journal');
    metacognition = readJournalResult(metacognitionResult, 'Failed to load metacognition journal');
    daily = readJournalResult(dailyResult, 'Failed to load daily reflection journal');
    reflection = readJournalResult(reflectionResult, 'Failed to load reflection journal');
    loading = false;
  }

  onMount(() => {
    void ensureCompanionNameLoaded();
    void loadData();
  });
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between gap-4">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">The Journal</h1>
      <p class="text-sm text-shadow-600 mt-1">{companionName}'s values and reflection timelines</p>
    </div>
    <button
      onclick={loadData}
      disabled={loading}
      class="text-sm px-3 py-1.5 rounded-lg border border-bark-300
             text-shadow-600 hover:bg-bark-100
             transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
    >
      {loading ? 'Loading...' : 'Refresh'}
    </button>
  </div>

  <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
    {#each tabs as tab (tab.id)}
      <button
        type="button"
        onclick={() => { activeTab = tab.id; }}
        class={`card-garden p-4 text-left border transition-colors ${
          activeTab === tab.id
            ? 'border-gold-300 bg-gold-50'
            : 'border-bark-200 hover:bg-bark-50'
        }`}
      >
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">{tab.label}</p>
        <p class="text-2xl font-serif font-bold text-shadow-900">{tab.count}</p>
      </button>
    {/each}
  </div>

  {#if loading}
    <div class="card-garden p-12 text-center">
      <div class="w-8 h-8 mx-auto rounded-full bg-bark-200 animate-pulse mb-4"></div>
      <p class="text-sm text-shadow-600">Loading journals...</p>
    </div>
  {:else if activeTab === 'values'}
    {#if values.error}
      <div class="card-garden p-6 border-l-4 border-l-wilt-400">
        <p class="text-sm text-shadow-800">
          {values.endpointMissing ? 'Values journal endpoint unavailable' : values.error}
        </p>
      </div>
    {:else if values.entries.length === 0}
      <div class="card-garden p-12 text-center">
        <p class="font-serif text-lg text-shadow-700 mb-1">No values reflections recorded yet</p>
        <p class="text-sm text-shadow-600">Values reflections will appear after heartbeat introspection writes them.</p>
      </div>
    {:else}
      <div class="space-y-4">
        {#each values.entries as entry (entry.id)}
          <article class="card-garden overflow-hidden border-l-4 border-l-gold-300">
            <div class="px-5 py-3 bg-bark-50 border-b border-bark-100">
              <div class="flex items-center flex-wrap gap-2">
                <span class="text-sm text-shadow-700">{formatDate(entry.createdAt)} {formatTime(entry.createdAt)}</span>
                <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium bg-gold-100 text-gold-700">v{entry.version}</span>
                <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium bg-petal-100 text-petal-500">{entry.templateName}</span>
              </div>
            </div>
            <div class="px-5 py-4 space-y-3">
              <div>
                <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Prompt</p>
                <p class="text-sm text-shadow-700 leading-relaxed bg-bark-50 rounded-lg p-3 border border-bark-200">{entry.prompt}</p>
              </div>
              <div>
                <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Reflection</p>
                <div class="text-sm text-shadow-800 leading-relaxed bg-bark-50 rounded-lg p-3 border border-bark-200 whitespace-pre-wrap">{entry.reflection}</div>
              </div>
            </div>
          </article>
        {/each}
      </div>
    {/if}
  {:else if activeTab === 'metacognition'}
    {#if metacognition.error}
      <div class="card-garden p-6 border-l-4 border-l-wilt-400">
        <p class="text-sm text-shadow-800">
          {metacognition.endpointMissing ? 'Metacognition journal endpoint unavailable' : metacognition.error}
        </p>
      </div>
    {:else if metacognition.entries.length === 0}
      <div class="card-garden p-12 text-center">
        <p class="font-serif text-lg text-shadow-700 mb-1">No metacognition entries yet</p>
        <p class="text-sm text-shadow-600">Reflection run and mutation entries will appear here when recorded.</p>
      </div>
    {:else}
      <div class="space-y-4">
        {#each metacognition.entries as entry (entry.id)}
          <article class="card-garden overflow-hidden border-l-4 border-l-petal-300">
            <div class="px-5 py-3 bg-bark-50 border-b border-bark-100">
              <div class="flex items-center flex-wrap gap-2">
                <span class="text-sm text-shadow-700">{formatDateTime(entry.occurredAt)}</span>
                <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium bg-petal-100 text-petal-600">{entry.kind}</span>
                {#if entry.templateName}
                  <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium bg-bark-100 text-shadow-700">{entry.templateName}</span>
                {/if}
              </div>
            </div>
            <div class="px-5 py-4 space-y-3">
              <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                <p><span class="font-medium text-shadow-700">Surface:</span> {entry.initiatorSurface}</p>
                <p><span class="font-medium text-shadow-700">Initiated by:</span> {entry.initiatedBy}</p>
                <p><span class="font-medium text-shadow-700">Mode:</span> {entry.mode ?? '--'}</p>
              </div>
              {#if entry.reason}
                <p class="text-sm text-shadow-700 bg-bark-50 rounded-lg p-3 border border-bark-200">{entry.reason}</p>
              {/if}
              {#if entry.prompt}
                <div>
                  <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Prompt</p>
                  <p class="text-sm text-shadow-700 leading-relaxed bg-bark-50 rounded-lg p-3 border border-bark-200">{entry.prompt}</p>
                </div>
              {/if}
              {#if entry.reflection}
                <div>
                  <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Reflection</p>
                  <div class="text-sm text-shadow-800 leading-relaxed bg-bark-50 rounded-lg p-3 border border-bark-200 whitespace-pre-wrap">{entry.reflection}</div>
                </div>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    {/if}
  {:else if activeTab === 'daily'}
    {#if daily.error}
      <div class="card-garden p-6 border-l-4 border-l-wilt-400">
        <p class="text-sm text-shadow-800">
          {daily.endpointMissing ? 'Daily reflection journal endpoint unavailable' : daily.error}
        </p>
      </div>
    {:else if daily.entries.length === 0}
      <div class="card-garden p-12 text-center">
        <p class="font-serif text-lg text-shadow-700 mb-1">No daily reflection entries yet</p>
        <p class="text-sm text-shadow-600">Daily reflection entries will appear after daily journal writes complete.</p>
      </div>
    {:else}
      <div class="space-y-4">
        {#each daily.entries as entry (entry.id)}
          <article class="card-garden overflow-hidden border-l-4 border-l-leaf-300">
            <div class="px-5 py-3 bg-bark-50 border-b border-bark-100">
              <div class="flex items-center flex-wrap gap-2">
                <span class="text-sm text-shadow-700">{entry.date} {formatTime(entry.createdAt)}</span>
                <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium bg-leaf-100 text-leaf-700">{entry.executionSource}</span>
                {#if entry.templateName}
                  <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium bg-bark-100 text-shadow-700">{entry.templateName}</span>
                {/if}
              </div>
            </div>
            <div class="px-5 py-4 space-y-3">
              {#if entry.prompt}
                <div>
                  <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Prompt</p>
                  <p class="text-sm text-shadow-700 leading-relaxed bg-bark-50 rounded-lg p-3 border border-bark-200">{entry.prompt}</p>
                </div>
              {/if}
              <div>
                <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Reflection</p>
                <div class="text-sm text-shadow-800 leading-relaxed bg-bark-50 rounded-lg p-3 border border-bark-200 whitespace-pre-wrap">{entry.reflection}</div>
              </div>
            </div>
          </article>
        {/each}
      </div>
    {/if}
  {:else}
    {#if reflection.error}
      <div class="card-garden p-6 border-l-4 border-l-wilt-400">
        <p class="text-sm text-shadow-800">
          {reflection.endpointMissing ? 'Reflection journal endpoint unavailable' : reflection.error}
        </p>
      </div>
    {:else if reflection.entries.length === 0}
      <div class="card-garden p-12 text-center">
        <p class="font-serif text-lg text-shadow-700 mb-1">No reflection journal entries yet</p>
        <p class="text-sm text-shadow-600">Free-form reflection entries will appear when reflection templates persist them.</p>
      </div>
    {:else}
      <div class="space-y-4">
        {#each reflection.entries as entry (entry.id)}
          <article class="card-garden overflow-hidden border-l-4 border-l-bark-300">
            <div class="px-5 py-3 bg-bark-50 border-b border-bark-100">
              <div class="flex items-center flex-wrap gap-2">
                <span class="text-sm text-shadow-700">{formatDateTime(entry.createdAt)}</span>
                <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium bg-bark-100 text-shadow-700">{entry.mode}</span>
                <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium bg-petal-100 text-petal-600">{entry.templateName}</span>
              </div>
            </div>
            <div class="px-5 py-4 space-y-3">
              <div>
                <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Prompt</p>
                <p class="text-sm text-shadow-700 leading-relaxed bg-bark-50 rounded-lg p-3 border border-bark-200">{entry.prompt}</p>
              </div>
              <div>
                <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Reflection</p>
                <div class="text-sm text-shadow-800 leading-relaxed bg-bark-50 rounded-lg p-3 border border-bark-200 whitespace-pre-wrap">{entry.reflection}</div>
              </div>
            </div>
          </article>
        {/each}
      </div>
    {/if}
  {/if}
</div>
