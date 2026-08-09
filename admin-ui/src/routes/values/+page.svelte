<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    JournalPrivacyDisclosure,
    JournalPrivacyStream,
  } from '$lib/api/endpoints/values';
  import JournalPrivacyBreakGlass from '$lib/components/JournalPrivacyBreakGlass.svelte';
  import BoundedList from '$lib/components/garden/BoundedList.svelte';
  import CollapsibleSection from '$lib/components/garden/CollapsibleSection.svelte';
  import GardenTabBar from '$lib/components/garden/GardenTabBar.svelte';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
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

  type JournalTab = 'values' | 'metacognition' | 'daily' | 'reflection' | 'concerns';

  /**
   * Automated concern-routing appends bookkeeping entries to the reflection
   * journal under this template id (see src/core/intention/concern-route-adapters.ts).
   * They get their own tab so journal reading is not interleaved with them.
   */
  const CONCERN_ROUTE_TEMPLATE_ID = 'concern_route';

  const LIST_MAX_HEIGHT = '65vh';

  interface JournalState<T> {
    entries: T[];
    disclosed: boolean;
  }

  function emptyJournalState<T>(): JournalState<T> {
    return {
      entries: [],
      disclosed: false,
    };
  }

  let values = $state<JournalState<ValuesJournalEntry>>(emptyJournalState());
  let metacognition = $state<JournalState<ReflectionMetacognitionJournalEntry>>(emptyJournalState());
  let daily = $state<JournalState<ReflectionDailyJournalEntry>>(emptyJournalState());
  let reflection = $state<JournalState<ReflectionJournalEntry>>(emptyJournalState());
  let activeTab = $state<JournalTab>('values');
  let searchQuery = $state('');
  const companionName = $derived(getCompanionName());

  const concernEntries = $derived(
    reflection.entries.filter(entry => entry.templateId === CONCERN_ROUTE_TEMPLATE_ID),
  );
  const reflectionEntries = $derived(
    reflection.entries.filter(entry => entry.templateId !== CONCERN_ROUTE_TEMPLATE_ID),
  );

  const normalizedQuery = $derived(searchQuery.trim().toLowerCase());

  function matchesQuery(fields: Array<string | undefined>): boolean {
    if (!normalizedQuery) return true;
    return fields.some(field => field != null && field.toLowerCase().includes(normalizedQuery));
  }

  const filteredValues = $derived(
    values.entries.filter(entry =>
      matchesQuery([entry.templateName, entry.templateId, entry.prompt, entry.reflection]),
    ),
  );
  const filteredMetacognition = $derived(
    metacognition.entries.filter(entry =>
      matchesQuery([
        entry.kind,
        entry.templateName,
        entry.templateId,
        entry.reason,
        entry.prompt,
        entry.reflection,
        entry.initiatedBy,
        entry.initiatorSurface,
      ]),
    ),
  );
  const filteredDaily = $derived(
    daily.entries.filter(entry =>
      matchesQuery([
        entry.templateName,
        entry.templateId,
        entry.prompt,
        entry.reflection,
        entry.executionSource,
        entry.date,
      ]),
    ),
  );
  const filteredReflection = $derived(
    reflectionEntries.filter(entry =>
      matchesQuery([
        entry.templateName,
        entry.templateId,
        entry.prompt,
        entry.reflection,
        entry.mode,
        entry.channelId,
      ]),
    ),
  );
  const filteredConcerns = $derived(
    concernEntries.filter(entry =>
      matchesQuery([entry.prompt, entry.reflection, entry.channelId, entry.mode]),
    ),
  );

  const tabs = $derived([
    { id: 'values', label: 'Values', count: values.entries.length },
    { id: 'daily', label: 'Daily', count: daily.entries.length },
    { id: 'reflection', label: 'Reflections', count: reflectionEntries.length },
    { id: 'concerns', label: 'Concern routing', count: concernEntries.length },
    { id: 'metacognition', label: 'Metacognition', count: metacognition.entries.length },
  ]);

  const activeCounts = $derived.by(() => {
    switch (activeTab) {
      case 'values':
        return { shown: filteredValues.length, total: values.entries.length };
      case 'metacognition':
        return { shown: filteredMetacognition.length, total: metacognition.entries.length };
      case 'daily':
        return { shown: filteredDaily.length, total: daily.entries.length };
      case 'concerns':
        return { shown: filteredConcerns.length, total: concernEntries.length };
      default:
        return { shown: filteredReflection.length, total: reflectionEntries.length };
    }
  });

  const activePrivacyTarget = $derived.by((): {
    stream: JournalPrivacyStream;
    label: string;
  } => {
    switch (activeTab) {
      case 'values':
        return { stream: 'values-journal', label: 'Values journal' };
      case 'metacognition':
        return { stream: 'reflection-metacognition', label: 'Metacognition journal' };
      case 'daily':
        return { stream: 'reflection-daily', label: 'Daily reflection journal' };
      default:
        return { stream: 'reflection-journal', label: 'Reflection journal' };
    }
  });

  function handleJournalDisclosure(disclosure: JournalPrivacyDisclosure): void {
    switch (disclosure.stream) {
      case 'values-journal':
        values = { entries: disclosure.entries, disclosed: true };
        return;
      case 'reflection-metacognition':
        metacognition = { entries: disclosure.entries, disclosed: true };
        return;
      case 'reflection-daily':
        daily = { entries: disclosure.entries, disclosed: true };
        return;
      default:
        reflection = { entries: disclosure.entries, disclosed: true };
    }
  }

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

  onMount(() => {
    void ensureCompanionNameLoaded();
  });
</script>

{#snippet promptSection(prompt: string)}
  <CollapsibleSection
    title="Prompt"
    subtitle={`${prompt.length.toLocaleString()} characters — generation prompt sent to the companion`}
    class="border border-bark-200 shadow-none"
  >
    <p class="text-sm text-shadow-700 leading-relaxed whitespace-pre-wrap">{prompt}</p>
  </CollapsibleSection>
{/snippet}

{#snippet reflectionSection(text: string)}
  <div>
    <p class="text-xs font-medium text-shadow-600 uppercase tracking-wide mb-1">Reflection</p>
    <div class="text-sm text-shadow-800 leading-relaxed bg-bark-50 rounded-lg p-3 border border-bark-200 whitespace-pre-wrap">{text}</div>
  </div>
{/snippet}

{#snippet noMatches()}
  <div class="garden-empty card-garden p-8 text-center">
    <p class="text-sm text-shadow-600">No entries match "{searchQuery.trim()}".</p>
  </div>
{/snippet}

<div class="garden-page space-y-5 pb-8">
  <GardenPageHeader
    eyebrow="Memory & Identity"
    title="The Journal"
    description={`${companionName}'s values, metacognition, daily notes, and reflection timelines.`}
  />

  <div class="garden-toolbar space-y-3">
    <GardenTabBar
      {tabs}
      activeId={activeTab}
      onSelect={(id) => { activeTab = id as JournalTab; }}
      label="Journal views"
    />

    <div class="flex flex-wrap items-center gap-3">
      <input
        type="search"
        bind:value={searchQuery}
        placeholder="Search loaded entries..."
        aria-label="Search loaded journal entries"
        class="w-full max-w-sm text-sm px-3 py-1.5 rounded-lg border border-bark-300 bg-bark-50
               text-shadow-800 placeholder:text-shadow-500
               focus:outline-none focus:border-gold-300"
      />
      {#if normalizedQuery}
        <p class="text-xs text-shadow-600">
          Showing {activeCounts.shown} of {activeCounts.total} loaded entries
        </p>
      {/if}
    </div>
  </div>

  {#key activePrivacyTarget.stream}
    <JournalPrivacyBreakGlass
      stream={activePrivacyTarget.stream}
      streamLabel={activePrivacyTarget.label}
      onDisclosure={handleJournalDisclosure}
    />
  {/key}

  {#if activeTab === 'values'}
    {#if !values.disclosed}
      <div class="garden-empty card-garden p-8 text-center">
        <p class="text-sm text-shadow-600">Values journal entries remain sealed until the audited confirmation is completed.</p>
      </div>
    {:else if values.entries.length === 0}
      <div class="garden-empty card-garden p-12 text-center">
        <p class="font-serif text-lg text-shadow-700 mb-1">No values reflections recorded yet</p>
        <p class="text-sm text-shadow-600">Values reflections will appear after scheduled reflection introspection writes them.</p>
      </div>
    {:else if filteredValues.length === 0}
      {@render noMatches()}
    {:else}
      <BoundedList maxHeight={LIST_MAX_HEIGHT} label="Values journal entries">
        <div class="space-y-3 pr-1">
          {#each filteredValues as entry (entry.id)}
            <article class="garden-section card-garden overflow-hidden border-l-4 border-l-gold-300">
              <div class="px-4 py-2 bg-bark-50 border-b border-bark-100">
                <div class="flex items-center flex-wrap gap-2">
                  <span class="text-sm text-shadow-700">{formatDate(entry.createdAt)} {formatTime(entry.createdAt)}</span>
                  <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-gold-100 text-gold-700">v{entry.version}</span>
                  <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-petal-100 text-petal-500">{entry.templateName}</span>
                </div>
              </div>
              <div class="px-4 py-3 space-y-3">
                {@render reflectionSection(entry.reflection)}
                {@render promptSection(entry.prompt)}
              </div>
            </article>
          {/each}
        </div>
      </BoundedList>
    {/if}
  {:else if activeTab === 'metacognition'}
    <p class="text-xs text-shadow-600">
      Every non-silent reflection writes one entry to both the daily journal and this metacognition log,
      so their counts always match — these are the same reflections viewed as run and mutation records.
    </p>
    {#if !metacognition.disclosed}
      <div class="garden-empty card-garden p-8 text-center">
        <p class="text-sm text-shadow-600">Metacognition entries remain sealed until the audited confirmation is completed.</p>
      </div>
    {:else if metacognition.entries.length === 0}
      <div class="garden-empty card-garden p-12 text-center">
        <p class="font-serif text-lg text-shadow-700 mb-1">No metacognition entries yet</p>
        <p class="text-sm text-shadow-600">Reflection run and mutation entries will appear here when recorded.</p>
      </div>
    {:else if filteredMetacognition.length === 0}
      {@render noMatches()}
    {:else}
      <BoundedList maxHeight={LIST_MAX_HEIGHT} label="Metacognition journal entries">
        <div class="space-y-3 pr-1">
          {#each filteredMetacognition as entry (entry.id)}
            <article class="garden-section card-garden overflow-hidden border-l-4 border-l-petal-300">
              <div class="px-4 py-2 bg-bark-50 border-b border-bark-100">
                <div class="flex items-center flex-wrap gap-2">
                  <span class="text-sm text-shadow-700">{formatDateTime(entry.occurredAt)}</span>
                  <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-petal-100 text-petal-600">{entry.kind}</span>
                  {#if entry.templateName}
                    <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-bark-100 text-shadow-700">{entry.templateName}</span>
                  {/if}
                </div>
              </div>
              <div class="px-4 py-3 space-y-3">
                <div class="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">
                  <p><span class="font-medium text-shadow-700">Surface:</span> {entry.initiatorSurface}</p>
                  <p><span class="font-medium text-shadow-700">Initiated by:</span> {entry.initiatedBy}</p>
                  <p><span class="font-medium text-shadow-700">Mode:</span> {entry.mode ?? '--'}</p>
                </div>
                {#if entry.reason}
                  <p class="text-sm text-shadow-700 bg-bark-50 rounded-lg p-3 border border-bark-200">{entry.reason}</p>
                {/if}
                {#if entry.reflection}
                  {@render reflectionSection(entry.reflection)}
                {/if}
                {#if entry.prompt}
                  {@render promptSection(entry.prompt)}
                {/if}
              </div>
            </article>
          {/each}
        </div>
      </BoundedList>
    {/if}
  {:else if activeTab === 'daily'}
    {#if !daily.disclosed}
      <div class="garden-empty card-garden p-8 text-center">
        <p class="text-sm text-shadow-600">Daily reflection entries remain sealed until the audited confirmation is completed.</p>
      </div>
    {:else if daily.entries.length === 0}
      <div class="garden-empty card-garden p-12 text-center">
        <p class="font-serif text-lg text-shadow-700 mb-1">No daily reflection entries yet</p>
        <p class="text-sm text-shadow-600">Daily reflection entries will appear after daily journal writes complete. Weekly reflections land here too, tagged with their weekly template.</p>
      </div>
    {:else if filteredDaily.length === 0}
      {@render noMatches()}
    {:else}
      <BoundedList maxHeight={LIST_MAX_HEIGHT} label="Daily reflection journal entries">
        <div class="space-y-3 pr-1">
          {#each filteredDaily as entry (entry.id)}
            <article class="garden-section card-garden overflow-hidden border-l-4 border-l-leaf-300">
              <div class="px-4 py-2 bg-bark-50 border-b border-bark-100">
                <div class="flex items-center flex-wrap gap-2">
                  <span class="text-sm text-shadow-700">{entry.date} {formatTime(entry.createdAt)}</span>
                  <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-leaf-100 text-leaf-700">{entry.executionSource}</span>
                  {#if entry.templateId?.includes('weekly')}
                    <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-gold-100 text-gold-700">weekly</span>
                  {/if}
                  {#if entry.templateName}
                    <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-bark-100 text-shadow-700">{entry.templateName}</span>
                  {/if}
                </div>
              </div>
              <div class="px-4 py-3 space-y-3">
                {@render reflectionSection(entry.reflection)}
                {#if entry.prompt}
                  {@render promptSection(entry.prompt)}
                {/if}
              </div>
            </article>
          {/each}
        </div>
      </BoundedList>
    {/if}
  {:else if activeTab === 'concerns'}
    <p class="text-xs text-shadow-600">
      Automated concern routing records durable follow-ups in the reflection journal under the
      "{CONCERN_ROUTE_TEMPLATE_ID}" template. They are separated here so reflection reading stays uncluttered.
    </p>
    {#if !reflection.disclosed}
      <div class="garden-empty card-garden p-8 text-center">
        <p class="text-sm text-shadow-600">Concern-routing entries remain sealed with the reflection journal until the audited confirmation is completed.</p>
      </div>
    {:else if concernEntries.length === 0}
      <div class="garden-empty card-garden p-12 text-center">
        <p class="font-serif text-lg text-shadow-700 mb-1">No concern-route entries yet</p>
        <p class="text-sm text-shadow-600">Entries appear when concern routing records a durable follow-up in the reflection journal.</p>
      </div>
    {:else if filteredConcerns.length === 0}
      {@render noMatches()}
    {:else}
      <BoundedList maxHeight={LIST_MAX_HEIGHT} label="Concern routing entries">
        <div class="space-y-3 pr-1">
          {#each filteredConcerns as entry (entry.id)}
            <article class="garden-section card-garden overflow-hidden border-l-4 border-l-wilt-400">
              <div class="px-4 py-2 bg-bark-50 border-b border-bark-100">
                <div class="flex items-center flex-wrap gap-2">
                  <span class="text-sm text-shadow-700">{formatDateTime(entry.createdAt)}</span>
                  <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-bark-100 text-shadow-700">{entry.mode}</span>
                  <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-petal-100 text-petal-600">{entry.templateName}</span>
                </div>
              </div>
              <div class="px-4 py-3 space-y-3">
                {@render reflectionSection(entry.reflection)}
                {@render promptSection(entry.prompt)}
              </div>
            </article>
          {/each}
        </div>
      </BoundedList>
    {/if}
  {:else}
    {#if !reflection.disclosed}
      <div class="garden-empty card-garden p-8 text-center">
        <p class="text-sm text-shadow-600">Reflection entries remain sealed until the audited confirmation is completed.</p>
      </div>
    {:else if reflectionEntries.length === 0}
      <div class="garden-empty card-garden p-12 text-center">
        <p class="font-serif text-lg text-shadow-700 mb-1">No reflection journal entries yet</p>
        <p class="text-sm text-shadow-600">Free-form reflection entries will appear when reflection templates persist them.</p>
      </div>
    {:else if filteredReflection.length === 0}
      {@render noMatches()}
    {:else}
      <BoundedList maxHeight={LIST_MAX_HEIGHT} label="Reflection journal entries">
        <div class="space-y-3 pr-1">
          {#each filteredReflection as entry (entry.id)}
            <article class="garden-section card-garden overflow-hidden border-l-4 border-l-bark-300">
              <div class="px-4 py-2 bg-bark-50 border-b border-bark-100">
                <div class="flex items-center flex-wrap gap-2">
                  <span class="text-sm text-shadow-700">{formatDateTime(entry.createdAt)}</span>
                  <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-bark-100 text-shadow-700">{entry.mode}</span>
                  <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-petal-100 text-petal-600">{entry.templateName}</span>
                </div>
              </div>
              <div class="px-4 py-3 space-y-3">
                {@render reflectionSection(entry.reflection)}
                {@render promptSection(entry.prompt)}
              </div>
            </article>
          {/each}
        </div>
      </BoundedList>
    {/if}
  {/if}
</div>
