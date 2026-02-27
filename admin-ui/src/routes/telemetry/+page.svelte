<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import {
    getEvents,
    isConnected,
    isPaused,
    connectTelemetry,
    disconnectTelemetry,
    pauseTelemetry,
    resumeTelemetry,
    clearEvents,
    filterEvents,
  } from '$lib/stores/telemetry.svelte';
  import type { TelemetryEvent } from '$lib/types';

  // ── State ──
  let filterText = $state('');
  let scrollContainer: HTMLDivElement | undefined = $state();
  let autoScroll = $state(true);
  let expandedIdx = $state<number | null>(null);
  let connectedSince = $state<number | null>(null);
  let uptimeDisplay = $state('00:00');
  let uptimeInterval: ReturnType<typeof setInterval> | undefined;

  // Category filters — all enabled by default
  let catAgent = $state(true);
  let catMemory = $state(true);
  let catSchedule = $state(true);
  let catWyoming = $state(true);
  let catSystem = $state(true);
  let catOther = $state(true);

  // ── Category logic ──
  type Category = 'agent' | 'memory' | 'schedule' | 'wyoming' | 'system' | 'other';

  function categorize(type: string): Category {
    if (type.startsWith('agent.'))    return 'agent';
    if (type.startsWith('memory.'))   return 'memory';
    if (type.startsWith('schedule.')) return 'schedule';
    if (type.startsWith('wyoming.'))  return 'wyoming';
    if (type.startsWith('system.'))   return 'system';
    return 'other';
  }

  function isCategoryEnabled(cat: Category): boolean {
    switch (cat) {
      case 'agent':    return catAgent;
      case 'memory':   return catMemory;
      case 'schedule': return catSchedule;
      case 'wyoming':  return catWyoming;
      case 'system':   return catSystem;
      case 'other':    return catOther;
    }
  }

  const CATEGORY_BADGE: Record<Category, string> = {
    agent:    'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    memory:   'bg-gold-100 text-gold-700 dark:bg-gold-900/30 dark:text-gold-300',
    schedule: 'bg-moss-100 text-moss-700 dark:bg-moss-900/30 dark:text-moss-300',
    wyoming:  'bg-petal-100 text-petal-700 dark:bg-petal-900/30 dark:text-petal-300',
    system:   'bg-wilt-100 text-wilt-700 dark:bg-wilt-900/30 dark:text-wilt-300',
    other:    'bg-bark-200 text-shadow-600 dark:bg-shadow-800 dark:text-bark-400',
  };

  const CATEGORY_LABEL: Record<Category, string> = {
    agent: 'agent.*',
    memory: 'memory.*',
    schedule: 'schedule.*',
    wyoming: 'wyoming.*',
    system: 'system.*',
    other: 'other',
  };

  // ── Filtered events (newest first) ──
  let filteredEvents = $derived.by(() => {
    let evts = filterText ? filterEvents(filterText) : getEvents();
    evts = evts.filter(e => isCategoryEnabled(categorize(e.type)));
    return [...evts].reverse();
  });

  // ── Stats ──
  let totalCount = $derived(getEvents().length);
  let eventsPerMinute = $derived.by(() => {
    const all = getEvents();
    if (all.length < 2) return 0;
    const spanMs = all[all.length - 1].timestamp - all[0].timestamp;
    if (spanMs <= 0) return 0;
    return Math.round((all.length / (spanMs / 60_000)) * 10) / 10;
  });

  // ── Formatting ──
  function formatTime(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  }

  function previewData(data: unknown): string {
    if (data === null || data === undefined) return '';
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    return str.length > 120 ? str.slice(0, 120) + '...' : str;
  }

  function formatJson(data: unknown): string {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }

  // ── Uptime tracking ──
  function updateUptime() {
    if (!connectedSince) {
      uptimeDisplay = '00:00';
      return;
    }
    const elapsed = Math.floor((Date.now() - connectedSince) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    uptimeDisplay = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // ── Auto-scroll ──
  $effect(() => {
    void getEvents().length;
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
    autoScroll = scrollHeight - scrollTop - clientHeight < 100;
  }

  // ── Connect/disconnect handlers ──
  function handleConnect() {
    connectTelemetry();
    connectedSince = Date.now();
  }

  function handleDisconnect() {
    disconnectTelemetry();
    connectedSince = null;
  }

  // ── Lifecycle ──
  onMount(() => {
    uptimeInterval = setInterval(updateUptime, 1000);
    if (isConnected()) {
      connectedSince = Date.now();
    }
  });

  onDestroy(() => {
    if (uptimeInterval) clearInterval(uptimeInterval);
  });
</script>

<div class="space-y-5 h-full flex flex-col">
  <!-- Header -->
  <div class="flex items-center justify-between flex-wrap gap-3">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900 dark:text-bark-200">The Sap</h1>
      <p class="text-sm text-shadow-500 dark:text-bark-500 mt-1">Real-time telemetry flowing through the substrate</p>
    </div>

    <!-- Connection indicator -->
    <div class="flex items-center gap-3">
      <div class="flex items-center gap-2">
        {#if isConnected()}
          <span class="relative flex h-2.5 w-2.5">
            <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-moss-400 opacity-75"></span>
            <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-moss-500"></span>
          </span>
          <span class="text-sm text-moss-700 dark:text-moss-400 font-medium">Connected</span>
        {:else}
          <span class="inline-flex rounded-full h-2.5 w-2.5 bg-wilt-500"></span>
          <span class="text-sm text-wilt-600 dark:text-wilt-400 font-medium">Disconnected</span>
        {/if}
      </div>
    </div>
  </div>

  <!-- Controls bar -->
  <div class="card-garden p-4">
    <div class="flex flex-wrap items-center gap-3">
      <!-- Connect / Disconnect -->
      {#if isConnected()}
        <button
          onclick={handleDisconnect}
          class="text-sm px-4 py-2 rounded-lg border border-wilt-300 bg-wilt-50 text-wilt-700
                 hover:bg-wilt-100 dark:border-wilt-700 dark:bg-wilt-900/20 dark:text-wilt-400
                 dark:hover:bg-wilt-900/30 font-medium transition-colors"
        >
          Disconnect
        </button>
      {:else}
        <button
          onclick={handleConnect}
          class="text-sm px-4 py-2 rounded-lg border border-moss-300 bg-moss-50 text-moss-700
                 hover:bg-moss-100 dark:border-moss-700 dark:bg-moss-900/20 dark:text-moss-400
                 dark:hover:bg-moss-900/30 font-medium transition-colors"
        >
          Connect
        </button>
      {/if}

      <!-- Pause / Resume -->
      <button
        onclick={() => isPaused() ? resumeTelemetry() : pauseTelemetry()}
        disabled={!isConnected()}
        class="text-sm px-4 py-2 rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed
               {isPaused()
                 ? 'border-gold-300 bg-gold-50 text-gold-700 hover:bg-gold-100 dark:border-gold-700 dark:bg-gold-900/20 dark:text-gold-400 dark:hover:bg-gold-900/30'
                 : 'border-bark-300 bg-bark-50 text-shadow-600 hover:bg-bark-100 dark:border-shadow-600 dark:bg-shadow-800 dark:text-bark-400 dark:hover:bg-shadow-700'
               } font-medium"
      >
        {isPaused() ? 'Resume' : 'Pause'}
      </button>

      <!-- Clear -->
      <button
        onclick={clearEvents}
        class="text-sm px-4 py-2 rounded-lg border border-bark-300 dark:border-shadow-600
               text-shadow-600 dark:text-bark-400 hover:bg-bark-100 dark:hover:bg-shadow-800
               font-medium transition-colors"
      >
        Clear
      </button>

      <div class="flex-1"></div>

      <!-- Text filter -->
      <input
        type="text"
        bind:value={filterText}
        placeholder="Filter by type prefix..."
        class="text-sm px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600
               bg-bark-50 dark:bg-shadow-800 text-shadow-800 dark:text-bark-200
               placeholder:text-shadow-400 dark:placeholder:text-shadow-500
               focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400 w-52"
      />
    </div>

    <!-- Category filter checkboxes -->
    <div class="flex flex-wrap items-center gap-3 mt-3 pt-3 border-t border-bark-200 dark:border-shadow-700">
      <span class="text-xs text-shadow-400 dark:text-bark-500 font-medium uppercase tracking-wide">Categories:</span>

      <label class="inline-flex items-center gap-1.5 cursor-pointer">
        <input type="checkbox" bind:checked={catAgent} class="rounded text-blue-600 border-bark-300 focus:ring-blue-300" />
        <span class="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium {CATEGORY_BADGE.agent}">{CATEGORY_LABEL.agent}</span>
      </label>

      <label class="inline-flex items-center gap-1.5 cursor-pointer">
        <input type="checkbox" bind:checked={catMemory} class="rounded text-gold-600 border-bark-300 focus:ring-gold-300" />
        <span class="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium {CATEGORY_BADGE.memory}">{CATEGORY_LABEL.memory}</span>
      </label>

      <label class="inline-flex items-center gap-1.5 cursor-pointer">
        <input type="checkbox" bind:checked={catSchedule} class="rounded text-moss-600 border-bark-300 focus:ring-moss-300" />
        <span class="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium {CATEGORY_BADGE.schedule}">{CATEGORY_LABEL.schedule}</span>
      </label>

      <label class="inline-flex items-center gap-1.5 cursor-pointer">
        <input type="checkbox" bind:checked={catWyoming} class="rounded text-petal-600 border-bark-300 focus:ring-petal-300" />
        <span class="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium {CATEGORY_BADGE.wyoming}">{CATEGORY_LABEL.wyoming}</span>
      </label>

      <label class="inline-flex items-center gap-1.5 cursor-pointer">
        <input type="checkbox" bind:checked={catSystem} class="rounded text-wilt-600 border-bark-300 focus:ring-wilt-300" />
        <span class="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium {CATEGORY_BADGE.system}">{CATEGORY_LABEL.system}</span>
      </label>

      <label class="inline-flex items-center gap-1.5 cursor-pointer">
        <input type="checkbox" bind:checked={catOther} class="rounded text-shadow-500 border-bark-300 focus:ring-shadow-300" />
        <span class="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium {CATEGORY_BADGE.other}">{CATEGORY_LABEL.other}</span>
      </label>
    </div>
  </div>

  <!-- Stats bar -->
  <div class="flex items-center gap-6 text-xs text-shadow-500 dark:text-bark-500">
    <span class="flex items-center gap-1.5">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" /></svg>
      <strong class="text-shadow-800 dark:text-bark-300">{totalCount}</strong> events
    </span>
    <span class="flex items-center gap-1.5">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" /></svg>
      <strong class="text-shadow-800 dark:text-bark-300">{eventsPerMinute}</strong>/min
    </span>
    <span class="flex items-center gap-1.5">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
      Uptime: <strong class="text-shadow-800 dark:text-bark-300">{uptimeDisplay}</strong>
    </span>

    {#if filterText}
      <span class="text-gold-600 dark:text-gold-400">
        Filtered: <code class="font-mono">{filterText}*</code>
      </span>
    {/if}

    {#if isPaused()}
      <span class="flex items-center gap-1.5 text-wilt-600 dark:text-wilt-400">
        <span class="w-2 h-2 rounded-full bg-wilt-400 animate-pulse"></span>
        Paused
      </span>
    {/if}

    <div class="flex-1"></div>

    {#if !autoScroll}
      <button
        onclick={() => { autoScroll = true; if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight; }}
        class="text-gold-600 dark:text-gold-400 hover:underline font-medium"
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
    {#if filteredEvents.length === 0}
      <div class="p-12 text-center">
        <svg class="w-12 h-12 mx-auto text-bark-300 dark:text-shadow-700 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12 20.25a.375.375 0 11-.75 0 .375.375 0 01.75 0v.001" />
        </svg>
        <p class="text-shadow-500 dark:text-bark-400 italic font-sans text-sm">
          No sap flows yet -- events will appear as the substrate runs
        </p>
        {#if !isConnected()}
          <button
            onclick={handleConnect}
            class="mt-3 text-sm font-sans text-gold-600 hover:text-gold-700 dark:text-gold-400 dark:hover:text-gold-300 font-medium"
          >
            Connect to start
          </button>
        {/if}
      </div>
    {:else}
      <table class="w-full">
        <thead class="sticky top-0 bg-white dark:bg-shadow-900 border-b border-bark-200 dark:border-shadow-700 z-10">
          <tr class="text-left">
            <th class="px-3 py-2 font-medium text-shadow-400 dark:text-bark-500 w-28">Time</th>
            <th class="px-3 py-2 font-medium text-shadow-400 dark:text-bark-500 w-52">Type</th>
            <th class="px-3 py-2 font-medium text-shadow-400 dark:text-bark-500">Data</th>
          </tr>
        </thead>
        <tbody>
          {#each filteredEvents as event, i (event.timestamp.toString() + event.type + i)}
            {@const cat = categorize(event.type)}
            <tr
              class="border-b border-bark-100 dark:border-shadow-800 hover:bg-bark-50 dark:hover:bg-shadow-800/50 transition-colors cursor-pointer"
              onclick={() => expandedIdx = expandedIdx === i ? null : i}
            >
              <td class="px-3 py-1.5 text-shadow-400 dark:text-bark-500 whitespace-nowrap align-top">
                {formatTime(event.timestamp)}
              </td>
              <td class="px-3 py-1.5 align-top">
                <span class="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium {CATEGORY_BADGE[cat]}">
                  {event.type}
                </span>
              </td>
              <td class="px-3 py-1.5 text-shadow-500 dark:text-bark-400 align-top">
                {#if expandedIdx === i}
                  <pre class="whitespace-pre-wrap text-shadow-800 dark:text-bark-200 font-mono text-[11px] bg-bark-100 dark:bg-shadow-800 rounded-lg p-3 mt-1 mb-1 max-h-64 overflow-y-auto">{formatJson(event.data)}</pre>
                {:else}
                  <span class="truncate block max-w-md" title={typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}>
                    {previewData(event.data)}
                  </span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>
