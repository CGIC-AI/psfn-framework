<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { getEvents, isPaused, pauseTelemetry, resumeTelemetry, clearEvents, filterEvents } from '$lib/stores/telemetry.svelte';
  import type { TelemetryEvent } from '$lib/types';

  let filterType = $state('');
  let scrollContainer: HTMLDivElement | undefined = $state();
  let autoScroll = $state(true);

  // Color coding by event category prefix
  function eventColor(type: string): string {
    if (type.startsWith('agent.'))   return 'text-gold-600 dark:text-gold-400';
    if (type.startsWith('memory.'))  return 'text-moss-600 dark:text-moss-400';
    if (type.startsWith('message.')) return 'text-blue-600 dark:text-blue-400';
    if (type.startsWith('shard.'))   return 'text-petal-600 dark:text-petal-400';
    if (type.startsWith('tool.'))    return 'text-amber-600 dark:text-amber-400';
    if (type.startsWith('error'))    return 'text-wilt-600 dark:text-wilt-400';
    if (type.startsWith('session.')) return 'text-purple-600 dark:text-purple-400';
    return 'text-shadow-500 dark:text-bark-400';
  }

  function eventBadgeColor(type: string): string {
    if (type.startsWith('agent.'))   return 'bg-gold-100 text-gold-700 dark:bg-gold-900/30 dark:text-gold-300';
    if (type.startsWith('memory.'))  return 'bg-moss-100 text-moss-700 dark:bg-moss-900/30 dark:text-moss-300';
    if (type.startsWith('message.')) return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
    if (type.startsWith('shard.'))   return 'bg-petal-100 text-petal-700 dark:bg-petal-900/30 dark:text-petal-300';
    if (type.startsWith('tool.'))    return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
    if (type.startsWith('error'))    return 'bg-wilt-100 text-wilt-700 dark:bg-wilt-900/30 dark:text-wilt-300';
    if (type.startsWith('session.')) return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300';
    return 'bg-bark-100 text-shadow-600 dark:bg-shadow-800 dark:text-bark-400';
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
  }

  function previewData(data: unknown): string {
    if (data === null || data === undefined) return '';
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    return str.length > 120 ? str.slice(0, 120) + '...' : str;
  }

  function filteredEvents(): TelemetryEvent[] {
    return filterType ? filterEvents(filterType) : getEvents();
  }

  // Auto-scroll to bottom when new events arrive
  $effect(() => {
    const evts = getEvents();
    if (autoScroll && scrollContainer) {
      tick().then(() => {
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      });
    }
  });

  function handleScroll() {
    if (!scrollContainer) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
    // If user scrolled up more than 100px from bottom, disable auto-scroll
    autoScroll = scrollHeight - scrollTop - clientHeight < 100;
  }
</script>

<div class="space-y-6 h-full flex flex-col">
  <!-- Header -->
  <div class="flex items-center justify-between flex-wrap gap-3">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-800 dark:text-bark-200">The Sap</h1>
      <p class="text-sm text-shadow-400 dark:text-bark-500 mt-1">Real-time telemetry flowing through the substrate</p>
    </div>

    <div class="flex items-center gap-2">
      <!-- Filter -->
      <input
        type="text"
        bind:value={filterType}
        placeholder="Filter by type prefix..."
        class="text-sm px-3 py-1.5 rounded-lg border border-bark-200 dark:border-shadow-700
               bg-white dark:bg-shadow-800 text-shadow-800 dark:text-bark-200
               placeholder:text-shadow-400 dark:placeholder:text-shadow-500
               focus:outline-none focus:border-gold-400 dark:focus:border-gold-600 w-48"
      />

      <!-- Pause / Resume -->
      <button
        onclick={() => isPaused() ? resumeTelemetry() : pauseTelemetry()}
        class="text-sm px-3 py-1.5 rounded-lg border transition-colors
               {isPaused()
                 ? 'border-moss-300 bg-moss-50 text-moss-700 hover:bg-moss-100 dark:border-moss-700 dark:bg-moss-900/20 dark:text-moss-400 dark:hover:bg-moss-900/30'
                 : 'border-wilt-300 bg-wilt-50 text-wilt-700 hover:bg-wilt-100 dark:border-wilt-700 dark:bg-wilt-900/20 dark:text-wilt-400 dark:hover:bg-wilt-900/30'
               }"
      >
        {isPaused() ? 'Resume' : 'Pause'}
      </button>

      <!-- Clear -->
      <button
        onclick={clearEvents}
        class="text-sm px-3 py-1.5 rounded-lg border border-bark-200 dark:border-shadow-700
               text-shadow-600 dark:text-bark-400 hover:bg-bark-100 dark:hover:bg-shadow-800 transition-colors"
      >
        Clear
      </button>
    </div>
  </div>

  <!-- Status bar -->
  <div class="flex items-center gap-4 text-xs text-shadow-400 dark:text-bark-500">
    <span>{filteredEvents().length} events</span>
    {#if filterType}
      <span>Filtered: <code class="font-mono text-gold-600 dark:text-gold-400">{filterType}*</code></span>
    {/if}
    {#if isPaused()}
      <span class="flex items-center gap-1">
        <span class="w-2 h-2 rounded-full bg-wilt-400 animate-pulse"></span>
        Paused
      </span>
    {/if}
    {#if !autoScroll}
      <button
        onclick={() => { autoScroll = true; if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight; }}
        class="text-gold-600 dark:text-gold-400 hover:underline"
      >
        Scroll to latest
      </button>
    {/if}
  </div>

  <!-- Event stream -->
  <div
    class="card-garden flex-1 min-h-0 overflow-y-auto font-mono text-xs"
    bind:this={scrollContainer}
    onscroll={handleScroll}
  >
    {#if filteredEvents().length === 0}
      <div class="p-8 text-center">
        <p class="text-shadow-400 dark:text-bark-500 italic font-sans text-sm">
          No sap flows yet — events will appear as the substrate runs
        </p>
      </div>
    {:else}
      <table class="w-full">
        <thead class="sticky top-0 bg-white dark:bg-shadow-900 border-b border-bark-200 dark:border-shadow-700">
          <tr class="text-left text-shadow-400 dark:text-bark-500">
            <th class="px-3 py-2 font-medium w-28">Time</th>
            <th class="px-3 py-2 font-medium w-48">Type</th>
            <th class="px-3 py-2 font-medium">Data</th>
          </tr>
        </thead>
        <tbody>
          {#each filteredEvents() as event, i}
            <tr class="border-b border-bark-100 dark:border-shadow-800 hover:bg-bark-50 dark:hover:bg-shadow-800/50 transition-colors">
              <td class="px-3 py-1.5 text-shadow-300 dark:text-bark-500 whitespace-nowrap">
                {formatTime(event.timestamp)}
              </td>
              <td class="px-3 py-1.5">
                <span class="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium {eventBadgeColor(event.type)}">
                  {event.type}
                </span>
              </td>
              <td class="px-3 py-1.5 text-shadow-500 dark:text-bark-400 truncate max-w-md" title={typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}>
                {previewData(event.data)}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>
