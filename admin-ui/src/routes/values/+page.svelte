<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    AdminJournalStatusData,
    AdminJournalStreamStatus,
    AdminJournalTaskStatus,
    JournalPrivacyDisclosure,
  } from '$lib/api/endpoints/values';
  import {
    getJournalStatus,
    JOURNAL_PRIVACY_TARGETS,
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
  import {
    getJournalDisclosure,
    rememberJournalDisclosure,
  } from '$lib/stores/journal-disclosure-session';
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

  interface JournalStreamStatusCard {
    label: string;
    stream: AdminJournalStreamStatus;
  }

  interface JournalTaskStatusCard {
    label: string;
    task: AdminJournalTaskStatus;
  }

  function emptyJournalState<T>(): JournalState<T> {
    return {
      entries: [],
      disclosed: false,
    };
  }

  function cachedJournalState<T>(entries: T[] | undefined): JournalState<T> {
    return entries
      ? { entries, disclosed: true }
      : emptyJournalState<T>();
  }

  let values = $state<JournalState<ValuesJournalEntry>>(cachedJournalState(
    getJournalDisclosure('values-journal')?.entries,
  ));
  let metacognition = $state<JournalState<ReflectionMetacognitionJournalEntry>>(cachedJournalState(
    getJournalDisclosure('reflection-metacognition')?.entries,
  ));
  let daily = $state<JournalState<ReflectionDailyJournalEntry>>(cachedJournalState(
    getJournalDisclosure('reflection-daily')?.entries,
  ));
  let reflection = $state<JournalState<ReflectionJournalEntry>>(cachedJournalState(
    getJournalDisclosure('reflection-journal')?.entries,
  ));
  let journalStatus = $state<AdminJournalStatusData | null>(null);
  let journalStatusError = $state('');
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
    { id: 'values', label: 'Values', count: journalStatus?.streams.values.count ?? (values.disclosed ? values.entries.length : undefined) },
    { id: 'daily', label: 'Daily', count: journalStatus?.streams.daily.count ?? (daily.disclosed ? daily.entries.length : undefined) },
    { id: 'reflection', label: 'Reflections', count: journalStatus?.streams.reflection.count ?? (reflection.disclosed ? reflectionEntries.length : undefined) },
    { id: 'concerns', label: 'Concern routing', count: journalStatus?.streams.concerns.count ?? (reflection.disclosed ? concernEntries.length : undefined) },
    { id: 'metacognition', label: 'Metacognition', count: journalStatus?.streams.metacognition.count ?? (metacognition.disclosed ? metacognition.entries.length : undefined) },
  ]);

  const streamStatusCards = $derived<JournalStreamStatusCard[]>(journalStatus ? [
    { label: 'Values', stream: journalStatus.streams.values },
    { label: 'Daily', stream: journalStatus.streams.daily },
    { label: 'Reflections', stream: journalStatus.streams.reflection },
    { label: 'Concerns', stream: journalStatus.streams.concerns },
    { label: 'Metacognition', stream: journalStatus.streams.metacognition },
  ] : []);
  const taskStatusCards = $derived<JournalTaskStatusCard[]>(journalStatus ? [
    { label: 'Daily review', task: journalStatus.tasks.daily },
    { label: 'Weekly review', task: journalStatus.tasks.weekly },
  ] : []);

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

  const lockedPrivacyTargets = $derived(JOURNAL_PRIVACY_TARGETS.filter(target => {
    switch (target.stream) {
      case 'values-journal': return !values.disclosed;
      case 'reflection-metacognition': return !metacognition.disclosed;
      case 'reflection-daily': return !daily.disclosed;
      default: return !reflection.disclosed;
    }
  }));

  function handleJournalDisclosure(disclosure: JournalPrivacyDisclosure): void {
    rememberJournalDisclosure(disclosure);
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

  function formatStatusDateTime(isoStr: string | null): string {
    return isoStr ? formatDateTime(isoStr) : 'Never';
  }

  function formatHealth(value: string): string {
    return value.replace(/_/g, ' ').replace(/^./, first => first.toUpperCase());
  }

  async function refreshJournalStatus(): Promise<void> {
    try {
      journalStatus = await getJournalStatus();
      journalStatusError = '';
    } catch (error) {
      journalStatusError = error instanceof Error ? error.message : 'Journal activity status is unavailable';
    }
  }

  onMount(() => {
    void ensureCompanionNameLoaded();
    void refreshJournalStatus();
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

  <section class="card-garden p-4 space-y-3" aria-labelledby="journal-activity-status">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="journal-activity-status" class="font-serif text-lg font-semibold text-shadow-900">Journal activity</h2>
      <p class="text-xs text-shadow-600">Counts and run health stay visible while journal bodies are sealed.</p>
    </div>
    {#if journalStatus}
      <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {#each streamStatusCards as { label, stream } (label)}
          <div class="rounded-lg border border-bark-200 bg-bark-50 p-3">
            <p class="text-xs font-medium uppercase tracking-wide text-shadow-600">{label}</p>
            {#if stream.available}
              <p class="mt-1 text-lg font-semibold tabular-nums text-shadow-900">{stream.count}</p>
              <p class="text-xs text-shadow-600">Latest: {formatStatusDateTime(stream.latestAt)}</p>
            {:else}
              <p class="mt-1 text-sm font-medium text-wilt-700">Unavailable</p>
              <p class="text-xs text-shadow-600">Count not reported</p>
            {/if}
          </div>
        {/each}
      </div>
      <div class="grid gap-2 sm:grid-cols-2">
        {#each taskStatusCards as { label, task } (label)}
          <div class="rounded-lg border p-3 {task.attentionRequired ? 'border-wilt-300 bg-wilt-50' : 'border-leaf-200 bg-leaf-50'}">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-sm font-medium text-shadow-800">{label}</p>
              <span class="rounded-full px-2 py-0.5 text-xs font-medium {task.attentionRequired ? 'bg-wilt-100 text-wilt-700' : 'bg-leaf-100 text-leaf-700'}">
                {formatHealth(task.health)}
              </span>
            </div>
            <p class="mt-1 text-xs text-shadow-600">Last run: {formatStatusDateTime(task.lastRunAt)}</p>
          </div>
        {/each}
      </div>
    {:else if journalStatusError}
      <p class="text-sm text-wilt-700" role="alert">Journal activity status unavailable: {journalStatusError}</p>
    {:else}
      <p class="text-sm text-shadow-600">Loading journal counts and schedule health…</p>
    {/if}
  </section>

  {#if lockedPrivacyTargets.length > 0}
    <JournalPrivacyBreakGlass
      targets={lockedPrivacyTargets}
      onDisclosure={handleJournalDisclosure}
    />
  {:else}
    <p class="rounded-lg border border-leaf-200 bg-leaf-50 px-4 py-3 text-sm text-leaf-700">
      All journal views are unlocked for this browser session.
    </p>
  {/if}

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
      Metacognition records reflection runs and mutations separately from the daily journal.
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
