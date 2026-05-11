<script lang="ts">
  import { onMount } from 'svelte';
  import { getValuesData } from '$lib/api/endpoints/values';
  import {
    ensureCompanionNameLoaded,
    getCompanionName,
  } from '$lib/stores/companion.svelte';
  import type { ValuesJournalEntry } from '$lib/types';

  // ── State ──
  let entries = $state<ValuesJournalEntry[]>([]);
  let loading = $state(true);
  let error = $state('');
  let endpointMissing = $state(false);
  const companionName = $derived(getCompanionName());

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

  async function loadData() {
    loading = true;
    error = '';
    endpointMissing = false;

    try {
      const data = await getValuesData();
      entries = data.entries;
    } catch (e) {
      if (e instanceof Error && e.message.includes('404')) {
        endpointMissing = true;
      } else {
        error = e instanceof Error ? e.message : 'Failed to load values data';
      }
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void ensureCompanionNameLoaded();
    void loadData();
  });
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">The Journal</h1>
      <p class="text-sm text-shadow-600 mt-1">Values reflections -- versioned journal entries from periodic heartbeat introspection</p>
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

  {#if loading}
    <div class="card-garden p-12 text-center">
      <div class="w-8 h-8 mx-auto rounded-full bg-bark-200 animate-pulse mb-4"></div>
      <p class="text-sm text-shadow-600">Loading values journal...</p>
    </div>
  {:else if error}
    <div class="card-garden p-6 border-l-4 border-l-wilt-400">
      <p class="text-sm text-shadow-800">{error}</p>
    </div>
  {:else if endpointMissing}
    <div class="card-garden p-6">
      <div class="flex items-start gap-3">
        <svg class="w-5 h-5 text-bark-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div>
          <p class="text-sm text-shadow-800">
            Requires gateway connection
          </p>
          <p class="text-sm text-shadow-600 mt-2">
            The values journal is available when the agent is running with an active gateway.
            Values reflections are captured from the consolidated weekly reflection heartbeat.
            Each entry records a versioned prompt and the agent's reflection on her current values and goals.
          </p>
        </div>
      </div>
    </div>

    <!-- Explanation -->
    <div class="card-garden p-5">
      <h2 class="text-base font-serif font-semibold text-shadow-900 mb-3">About the Values Journal</h2>
      <div class="space-y-3 text-sm text-shadow-700">
        <p>The values journal stores {companionName}'s periodic self-reflections. These are triggered by heartbeat templates configured on the Scheduler page.</p>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <div class="p-4 bg-bark-50 rounded-lg border border-bark-200">
            <p class="font-semibold text-shadow-800 mb-1">Prompt</p>
            <p>The reflection question or prompt sent to the agent during a heartbeat.</p>
          </div>
          <div class="p-4 bg-bark-50 rounded-lg border border-bark-200">
            <p class="font-semibold text-shadow-800 mb-1">Reflection</p>
            <p>The agent's introspective response -- her current perspective on values, goals, and experiences.</p>
          </div>
        </div>
      </div>
    </div>
  {:else if entries.length === 0}
    <div class="card-garden p-12 text-center">
      <svg class="w-16 h-16 mx-auto text-bark-300 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
      </svg>
      <p class="font-serif text-lg text-shadow-700 mb-1">No values reflections recorded yet</p>
      <p class="text-sm text-shadow-600">
        Reflections will appear here as the agent completes periodic heartbeat introspections.
      </p>
    </div>
  {:else}
    <!-- Summary -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="card-garden p-4 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Total Entries</p>
        <p class="text-2xl font-serif font-bold text-shadow-900">{entries.length}</p>
      </div>
      <div class="card-garden p-4 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Latest Version</p>
        <p class="text-2xl font-serif font-bold text-gold-600">v{entries.length > 0 ? entries[0].version : 0}</p>
      </div>
      <div class="card-garden p-4 text-center">
        <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Latest Entry</p>
        <p class="text-sm font-mono text-shadow-800">
          {entries.length > 0 ? formatDateTime(entries[0].createdAt) : '--'}
        </p>
      </div>
    </div>

    <!-- Timeline -->
    <div class="space-y-4">
      {#each entries as entry (entry.id)}
        <article class="card-garden overflow-hidden border-l-4 border-l-gold-300">
          <!-- Entry header -->
          <div class="px-5 py-3 bg-bark-50 border-b border-bark-100">
            <div class="flex items-center flex-wrap gap-2">
              <span class="text-sm text-shadow-700">
                {formatDate(entry.createdAt)} {formatTime(entry.createdAt)}
              </span>
              <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium bg-gold-100 text-gold-700">
                v{entry.version}
              </span>
              <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium bg-petal-100 text-petal-500">
                {entry.templateName}
              </span>
            </div>
          </div>

          <div class="px-5 py-4 space-y-3">
            <!-- Prompt -->
            <div>
              <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Prompt</p>
              <p class="text-sm text-shadow-700 leading-relaxed bg-bark-50 rounded-lg p-3 border border-bark-200">
                {entry.prompt}
              </p>
            </div>

            <!-- Reflection -->
            <div>
              <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Reflection</p>
              <div class="text-sm text-shadow-800 leading-relaxed bg-bark-50 rounded-lg p-3 border border-bark-200 whitespace-pre-wrap">
                {entry.reflection}
              </div>
            </div>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</div>
