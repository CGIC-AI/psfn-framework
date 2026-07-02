<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import GardenDebugStream, { type GardenDebugStreamItem } from '$lib/components/garden/GardenDebugStream.svelte';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import GardenTabBar, { type GardenTabItem } from '$lib/components/garden/GardenTabBar.svelte';
  import AuditSurfaceMap from '$lib/components/telemetry/AuditSurfaceMap.svelte';
  import { getAuditHistory } from '$lib/api/endpoints/audit-history';
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
  import type { AuditEntry, AuditActionType, AuditDecision, AuditHistoryData, AuditHistorySource, AuditTimeRange } from '$lib/types';

  // ── Tab State ──
  type TabId = 'live' | 'audit';
  let activeTab = $state<TabId>('live');

  // ══════════════════════════════════════════════
  // LIVE EVENTS tab state
  // ══════════════════════════════════════════════
  let filterText = $state('');
  let debouncedFilterText = $state('');
  let filterDebounce: ReturnType<typeof setTimeout> | undefined;
  let scrollContainer: HTMLDivElement | undefined = $state();
  let autoScroll = $state(true);
  let expandedEventId = $state<string | null>(null);
  let connectedSince = $state<number | null>(null);
  let uptimeDisplay = $state('00:00');
  let uptimeInterval: ReturnType<typeof setInterval> | undefined;

  // Category filters
  let catAgent = $state(true);
  let catMemory = $state(true);
  let catSchedule = $state(true);
  let catWyoming = $state(true);
  let catSystem = $state(true);
  let catOther = $state(true);

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
    agent:    'bg-gold-100 text-gold-700',
    memory:   'bg-moss-100 text-moss-700',
    schedule: 'bg-bark-200 text-shadow-800',
    wyoming:  'bg-petal-100 text-petal-700',
    system:   'bg-wilt-100 text-wilt-600',
    other:    'bg-bark-200 text-shadow-800',
  };

  const CATEGORY_LABEL: Record<Category, string> = {
    agent: 'agent.*',
    memory: 'memory.*',
    schedule: 'schedule.*',
    wyoming: 'wyoming.*',
    system: 'system.*',
    other: 'other',
  };

  // Filtered events (oldest first for terminal display)
  let filteredEvents = $derived.by(() => {
    let evts = debouncedFilterText ? filterEvents(debouncedFilterText) : getEvents();
    evts = evts.filter(e => isCategoryEnabled(categorize(e.type)));
    return evts;
  });

  let liveEventRows: GardenDebugStreamItem[] = $derived.by(() => filteredEvents.map((event, i) => ({
    id: event.timestamp.toString() + event.type + i,
    timestamp: formatTime(event.timestamp),
    label: event.type,
    summary: formatEventKv(event.data),
    detail: formatJson(event.data),
  })));

  // Stats
  let totalCount = $derived(getEvents().length);
  let eventsPerMinute = $derived.by(() => {
    const all = getEvents();
    if (all.length < 2) return 0;
    const spanMs = all[all.length - 1].timestamp - all[0].timestamp;
    if (spanMs <= 0) return 0;
    return Math.round((all.length / (spanMs / 60_000)) * 10) / 10;
  });

  // ══════════════════════════════════════════════
  // AUDIT TRAIL tab state
  // ══════════════════════════════════════════════
  let auditActionType = $state<AuditActionType | 'all'>('all');
  let auditDecision = $state<AuditDecision | 'all'>('all');
  let auditTimeRange = $state<AuditTimeRange>('24h');
  let auditSource = $state<AuditHistorySource | 'all'>('all');
  let auditQuery = $state('');
  let auditHistory = $state<AuditHistoryData | null>(null);
  let auditLoading = $state(false);
  let auditError = $state<string | null>(null);
  let auditOffset = $state(0);
  let auditRequestSeq = 0;
  let lastAuditFilterKey = '';
  const AUDIT_PAGE_SIZE = 100;

  const ACTION_TYPE_OPTIONS: { value: AuditActionType | 'all'; label: string }[] = [
    { value: 'all', label: 'All action types' },
    { value: 'tool_invocation', label: 'Tool invocation' },
    { value: 'tool_activation', label: 'Tool activation' },
    { value: 'identity_edit', label: 'Identity edit' },
    { value: 'external_action', label: 'External action' },
    { value: 'memory_mutation', label: 'Memory mutation' },
    { value: 'memory_access', label: 'Memory access' },
    { value: 'settings_change', label: 'Settings change' },
    { value: 'confirmation', label: 'Confirmation' },
    { value: 'charge_decision', label: 'Charge decision' },
    { value: 'gateway_policy', label: 'Gateway policy' },
  ];

  const DECISION_OPTIONS: { value: AuditDecision | 'all'; label: string }[] = [
    { value: 'all', label: 'All decisions' },
    { value: 'allowed', label: 'Allowed' },
    { value: 'denied', label: 'Denied' },
    { value: 'needs_approval', label: 'Needs approval' },
  ];

  const AUDIT_SOURCE_STATUSES: { value: AuditHistorySource; label: string }[] = [
    { value: 'garden', label: 'Garden runtime' },
    { value: 'gateway', label: 'Gateway audit' },
    { value: 'charge', label: 'Charge ledger' },
  ];

  const SOURCE_OPTIONS: { value: AuditHistorySource | 'all'; label: string }[] = [
    { value: 'all', label: 'All sources' },
    ...AUDIT_SOURCE_STATUSES,
  ];

  const TIME_RANGE_OPTIONS: { value: AuditTimeRange; label: string }[] = [
    { value: '15m', label: 'Last 15 min' },
    { value: '1h', label: 'Last hour' },
    { value: '24h', label: 'Last 24h' },
    { value: '7d', label: 'Last 7 days' },
    { value: '30d', label: 'Last 30 days' },
    { value: 'all', label: 'All time' },
  ];

  let auditEntries = $derived<AuditEntry[]>(auditHistory?.entries ?? []);

  const TELEMETRY_TABS = [
    { id: 'live', label: 'Live Events' },
    { id: 'audit', label: 'Audit Trail' },
  ] satisfies GardenTabItem[];

  let telemetryTabs: GardenTabItem[] = $derived.by(() => TELEMETRY_TABS.map(tab => {
    if (tab.id !== 'audit' || auditEntries.length === 0) return tab;
    return { ...tab, count: auditEntries.length };
  }));

  const DECISION_BADGE: Record<AuditDecision, string> = {
    allowed: 'bg-moss-100 text-moss-700',
    denied: 'bg-wilt-100 text-wilt-600',
    needs_approval: 'bg-gold-100 text-gold-700',
  };

  const ACTION_TYPE_BADGE: Record<AuditActionType, string> = {
    tool_invocation: 'bg-gold-100 text-gold-700',
    tool_activation: 'bg-gold-100 text-gold-700',
    identity_edit: 'bg-petal-100 text-petal-500',
    external_action: 'bg-bark-200 text-shadow-800',
    memory_mutation: 'bg-moss-100 text-moss-700',
    memory_access: 'bg-wilt-100 text-wilt-600',
    settings_change: 'bg-petal-100 text-petal-600',
    confirmation: 'bg-bark-200 text-shadow-800',
    charge_decision: 'bg-moss-100 text-moss-700',
    gateway_policy: 'bg-wilt-100 text-wilt-600',
  };

  const ACTION_TYPE_LABEL: Record<AuditActionType, string> = {
    tool_invocation: 'Tool',
    tool_activation: 'Activation',
    identity_edit: 'Identity',
    external_action: 'External',
    memory_mutation: 'Memory',
    memory_access: 'Memory access',
    settings_change: 'Settings',
    confirmation: 'Confirm',
    charge_decision: 'Charge',
    gateway_policy: 'Gateway',
  };

  const SOURCE_BADGE: Record<AuditHistorySource, string> = {
    garden: 'bg-petal-100 text-petal-600',
    gateway: 'bg-wilt-100 text-wilt-600',
    charge: 'bg-moss-100 text-moss-700',
  };

  const SOURCE_LABEL: Record<AuditHistorySource, string> = {
    garden: 'Garden',
    gateway: 'Gateway',
    charge: 'Charge',
  };

  // ══════════════════════════════════════════════
  // Shared formatting helpers
  // ══════════════════════════════════════════════
  function formatTime(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  }

  function formatDateTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  function formatEventKv(data: unknown): string {
    if (data === null || data === undefined) return '';
    if (typeof data === 'string') return data;
    if (typeof data !== 'object') return String(data);
    const obj = data as Record<string, unknown>;
    return Object.entries(obj)
      .filter(([k]) => k !== 'type' && k !== 'timestamp')
      .map(([k, v]) => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'string') return `${k}=${v}`;
        if (typeof v === 'number' || typeof v === 'boolean') return `${k}=${v}`;
        if (Array.isArray(v)) return `${k}=[${v.length}]`;
        return `${k}=${JSON.stringify(v)}`;
      })
      .filter(Boolean)
      .join(' ');
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

  // ── Auto-scroll for live events ──
  $effect(() => {
    void getEvents().length;
    if (activeTab === 'live' && autoScroll && scrollContainer) {
      tick().then(() => {
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      });
    }
  });

  // Debounce free-text filter updates for large event lists.
  $effect(() => {
    const nextFilter = filterText.trim();
    if (filterDebounce) {
      clearTimeout(filterDebounce);
    }
    filterDebounce = setTimeout(() => {
      debouncedFilterText = nextFilter;
    }, 180);
    return () => {
      if (filterDebounce) {
        clearTimeout(filterDebounce);
      }
    };
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

  function selectTelemetryTab(tab: TabId): void {
    activeTab = tab;
  }

  function selectTelemetryTabId(id: string): void {
    if (id === 'live' || id === 'audit') {
      selectTelemetryTab(id);
    }
  }

  function toggleExpandedEvent(id: string): void {
    expandedEventId = expandedEventId === id ? null : id;
  }

  async function loadPersistentAuditHistory(): Promise<void> {
    const requestId = ++auditRequestSeq;
    auditLoading = true;
    auditError = null;
    try {
      const result = await getAuditHistory({
        actionType: auditActionType,
        decision: auditDecision,
        timeRange: auditTimeRange,
        source: auditSource,
        query: auditQuery,
        limit: AUDIT_PAGE_SIZE,
        offset: auditOffset,
      });
      if (requestId !== auditRequestSeq) return;
      auditHistory = result;
    } catch (error) {
      if (requestId !== auditRequestSeq) return;
      auditError = error instanceof Error ? error.message : String(error);
      auditHistory = null;
    } finally {
      if (requestId === auditRequestSeq) {
        auditLoading = false;
      }
    }
  }

  function refreshAuditHistory(): void {
    void loadPersistentAuditHistory();
  }

  function previousAuditPage(): void {
    auditOffset = Math.max(0, auditOffset - AUDIT_PAGE_SIZE);
  }

  function nextAuditPage(): void {
    auditOffset += AUDIT_PAGE_SIZE;
  }

  $effect(() => {
    const filterKey = [
      auditActionType,
      auditDecision,
      auditTimeRange,
      auditSource,
      auditQuery.trim(),
    ].join('|');
    if (lastAuditFilterKey && filterKey !== lastAuditFilterKey) {
      auditOffset = 0;
    }
    lastAuditFilterKey = filterKey;
  });

  $effect(() => {
    void auditActionType;
    void auditDecision;
    void auditTimeRange;
    void auditSource;
    void auditQuery;
    void auditOffset;
    void loadPersistentAuditHistory();
  });

  // ── Lifecycle ──
  onMount(() => {
    uptimeInterval = setInterval(updateUptime, 1000);
    debouncedFilterText = filterText.trim();
    if (isConnected()) {
      connectedSince = Date.now();
    }
  });

  onDestroy(() => {
    if (filterDebounce) clearTimeout(filterDebounce);
    if (uptimeInterval) clearInterval(uptimeInterval);
  });
</script>

<div class="space-y-5 h-full flex flex-col">
  {#snippet telemetryHeaderActions()}
    <div class="flex items-center gap-2">
      {#if isConnected()}
        <span class="relative flex h-2.5 w-2.5">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-moss-400 opacity-75"></span>
          <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-moss-500"></span>
        </span>
        <span class="text-sm text-moss-700 font-medium">Connected</span>
      {:else}
        <span class="inline-flex rounded-full h-2.5 w-2.5 bg-wilt-400"></span>
        <span class="text-sm text-wilt-600 font-medium">Disconnected</span>
      {/if}
    </div>
  {/snippet}

  <GardenPageHeader
    title="Events & Audit"
    description="Live telemetry, derived audit trail, and observability map. Garden context: The Sap."
    actions={telemetryHeaderActions}
  />

  <AuditSurfaceMap
    {activeTab}
    onSelectTelemetryTab={selectTelemetryTab}
  />

  <GardenTabBar
    tabs={telemetryTabs}
    activeId={activeTab}
    onSelect={selectTelemetryTabId}
    label="Telemetry views"
  />

  <!-- ══════════════════════════════════════════════ -->
  <!-- LIVE EVENTS TAB                               -->
  <!-- ══════════════════════════════════════════════ -->
  {#if activeTab === 'live'}
    <!-- Controls bar -->
    <div class="card-garden p-4">
      <div class="flex flex-wrap items-center gap-3">
        {#if isConnected()}
          <button
            onclick={handleDisconnect}
            class="text-sm px-4 py-2 rounded-lg border border-wilt-200 bg-wilt-50 text-wilt-600
                   hover:bg-wilt-100 font-medium transition-colors"
          >
            Disconnect
          </button>
        {:else}
          <button
            onclick={handleConnect}
            class="text-sm px-4 py-2 rounded-lg border border-moss-300 bg-moss-50 text-moss-700
                   hover:bg-moss-100 font-medium transition-colors"
          >
            Connect
          </button>
        {/if}

        <button
          onclick={() => isPaused() ? resumeTelemetry() : pauseTelemetry()}
          disabled={!isConnected()}
          class="text-sm px-4 py-2 rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                 {isPaused()
                   ? 'border-gold-300 bg-gold-50 text-gold-700 hover:bg-gold-100'
                   : 'border-bark-300 bg-bark-50 text-shadow-600 hover:bg-bark-100'
                 } font-medium"
        >
          {isPaused() ? 'Resume' : 'Pause'}
        </button>

        <button
          onclick={clearEvents}
          class="text-sm px-4 py-2 rounded-lg border border-bark-300
                 text-shadow-600 hover:bg-bark-100
                 font-medium transition-colors"
        >
          Clear
        </button>

        <div class="flex-1"></div>

        <input
          data-search-shortcut
          type="text"
          bind:value={filterText}
          placeholder="Filter by type prefix... (press /)"
          class="text-sm px-3 py-2 rounded-lg border border-bark-300
                 bg-bark-50 text-shadow-800
                 placeholder:text-shadow-600
                 focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400 w-52"
        />
      </div>

      <!-- Category filter checkboxes -->
      <div class="flex flex-wrap items-center gap-3 mt-3 pt-3 border-t border-bark-200">
        <span class="text-sm text-shadow-600 font-medium uppercase tracking-wide">Categories:</span>

        <label class="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" bind:checked={catAgent} class="rounded border-bark-300" />
          <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium {CATEGORY_BADGE.agent}">{CATEGORY_LABEL.agent}</span>
        </label>

        <label class="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" bind:checked={catMemory} class="rounded border-bark-300" />
          <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium {CATEGORY_BADGE.memory}">{CATEGORY_LABEL.memory}</span>
        </label>

        <label class="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" bind:checked={catSchedule} class="rounded border-bark-300" />
          <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium {CATEGORY_BADGE.schedule}">{CATEGORY_LABEL.schedule}</span>
        </label>

        <label class="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" bind:checked={catWyoming} class="rounded border-bark-300" />
          <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium {CATEGORY_BADGE.wyoming}">{CATEGORY_LABEL.wyoming}</span>
        </label>

        <label class="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" bind:checked={catSystem} class="rounded border-bark-300" />
          <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium {CATEGORY_BADGE.system}">{CATEGORY_LABEL.system}</span>
        </label>

        <label class="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" bind:checked={catOther} class="rounded border-bark-300" />
          <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium {CATEGORY_BADGE.other}">{CATEGORY_LABEL.other}</span>
        </label>
      </div>
    </div>

    <!-- Stats bar -->
    <div class="flex items-center gap-6 text-sm text-shadow-600">
      <span class="flex items-center gap-1.5">
        <strong class="text-shadow-800">{totalCount}</strong> events
      </span>
      <span class="flex items-center gap-1.5">
        <strong class="text-shadow-800">{eventsPerMinute}</strong>/min
      </span>
      <span class="flex items-center gap-1.5">
        Uptime: <strong class="text-shadow-800">{uptimeDisplay}</strong>
      </span>

      {#if filterText}
        <span class="text-gold-600">
          Filtered: <code class="font-mono text-sm">{filterText}*</code>
        </span>
      {/if}

      {#if isPaused()}
        <span class="flex items-center gap-1.5 text-wilt-600">
          <span class="w-2 h-2 rounded-full bg-wilt-400 animate-pulse"></span>
          Paused
        </span>
      {/if}

      <div class="flex-1"></div>

      {#if !autoScroll}
        <button
          onclick={() => { autoScroll = true; if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight; }}
          class="text-sm text-gold-600 hover:underline font-medium"
        >
          Scroll to latest
        </button>
      {/if}
    </div>

    {#snippet liveStreamEmptyAction()}
      {#if !isConnected()}
        <button
          type="button"
          onclick={handleConnect}
          class="text-sm font-sans font-medium text-gold-400 hover:text-gold-300"
        >
          Connect to start
        </button>
      {/if}
    {/snippet}

    <GardenDebugStream
      class="flex-1 min-h-0 border border-shadow-800"
      items={liveEventRows}
      expandedId={expandedEventId}
      onToggle={toggleExpandedEvent}
      bind:scroller={scrollContainer}
      onScroll={handleScroll}
      emptyText="No sap flows yet -- events will appear as the substrate runs"
      emptyAction={liveStreamEmptyAction}
    />
  {/if}

  <!-- ══════════════════════════════════════════════ -->
  <!-- AUDIT TRAIL TAB                               -->
  <!-- ══════════════════════════════════════════════ -->
  {#if activeTab === 'audit'}
    <div class="card-garden p-4">
      <p class="text-sm text-shadow-600 mb-4">
        Unified persisted timeline for tool invocations and activation failures, settings changes,
        confirmations, gateway policy decisions, memory mutations, charge decisions, and external actions.
        The live stream remains an overlay on the Live Events tab.
      </p>

      <!-- Filters -->
      <div class="flex flex-wrap items-end gap-4">
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-shadow-800">Action type</span>
          <select
            bind:value={auditActionType}
            class="text-sm px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800
                   focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
          >
            {#each ACTION_TYPE_OPTIONS as opt}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-shadow-800">Decision</span>
          <select
            bind:value={auditDecision}
            class="text-sm px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800
                   focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
          >
            {#each DECISION_OPTIONS as opt}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-shadow-800">Time range</span>
          <select
            bind:value={auditTimeRange}
            class="text-sm px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800
                   focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
          >
            {#each TIME_RANGE_OPTIONS as opt}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-shadow-800">Source</span>
          <select
            bind:value={auditSource}
            class="text-sm px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800
                   focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
          >
            {#each SOURCE_OPTIONS as opt}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-shadow-800">Search</span>
          <input
            type="text"
            bind:value={auditQuery}
            placeholder="Narrative, details, source..."
            class="text-sm px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800
                   placeholder:text-shadow-600
                   focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400 w-60"
          />
        </label>

        <div class="flex-1"></div>

        <button
          type="button"
          onclick={refreshAuditHistory}
          class="text-sm px-4 py-2 rounded-lg border border-bark-300 text-shadow-600 hover:bg-bark-100 font-medium transition-colors"
        >
          Refresh
        </button>

        <span class="text-sm text-shadow-600">
          {auditHistory?.pagination.total ?? 0} total
        </span>
      </div>

      {#if auditHistory}
        <div class="mt-4 flex flex-wrap gap-2 text-sm text-shadow-600">
          {#each AUDIT_SOURCE_STATUSES as sourceOption}
            {@const source = sourceOption.value}
            {@const state = auditHistory.sources[source]}
            <span class="inline-flex items-center gap-1 rounded-full px-2 py-1 {SOURCE_BADGE[source]}">
              {SOURCE_LABEL[source]}: {state.available ? `${state.count} indexed` : `unavailable${state.message ? ` (${state.message})` : ''}`}
            </span>
          {/each}
        </div>
      {/if}
    </div>

    {#if auditLoading}
      <div class="card-garden p-8 text-center">
        <p class="font-serif text-lg text-shadow-800 mb-2">Loading audit history</p>
        <p class="text-sm text-shadow-600">Reading persisted Garden, gateway, and charge history.</p>
      </div>
    {:else if auditError}
      <div class="card-garden p-8 text-center">
        <p class="font-serif text-lg text-wilt-600 mb-2">Audit history unavailable</p>
        <p class="text-sm text-shadow-600">{auditError}</p>
      </div>
    {:else if auditEntries.length === 0}
      <div class="card-garden p-8 text-center">
        <p class="text-sm text-shadow-600 italic">
          No persisted audit events match the selected filters.
        </p>
      </div>
    {:else}
      <!-- Audit entries list -->
      <div class="flex-1 min-h-0 overflow-y-auto space-y-2" style="min-height: 300px;">
        {#each auditEntries as entry (entry.id)}
          <article class="card-garden p-4 border-l-4 {entry.decision === 'denied' ? 'border-l-wilt-400' : 'border-l-moss-400'}">
            <div class="flex items-center gap-3 mb-1.5 flex-wrap">
              <span class="text-sm text-shadow-600 font-mono">
                {formatDateTime(entry.timestamp)}
              </span>
              <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium {ACTION_TYPE_BADGE[entry.actionType]}">
                {ACTION_TYPE_LABEL[entry.actionType]}
              </span>
              <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium {SOURCE_BADGE[entry.source]}">
                {SOURCE_LABEL[entry.source]}
              </span>
              <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium {DECISION_BADGE[entry.decision]}">
                {entry.decision === 'allowed' ? 'Allowed' : entry.decision === 'needs_approval' ? 'Needs approval' : 'Denied'}
              </span>
              {#if entry.actor}
                <span class="text-sm text-shadow-600">actor={entry.actor}</span>
              {/if}
            </div>
            <p class="text-sm text-shadow-800 leading-relaxed">{entry.narrative}</p>
            {#if entry.details}
              <p class="text-sm text-shadow-600 mt-1 font-mono">{entry.details}</p>
            {/if}
          </article>
        {/each}
      </div>

      {#if auditHistory}
        <div class="card-garden p-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onclick={previousAuditPage}
            disabled={!auditHistory.pagination.hasPrevious}
            class="text-sm px-4 py-2 rounded-lg border border-bark-300 text-shadow-600 hover:bg-bark-100 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          <button
            type="button"
            onclick={nextAuditPage}
            disabled={!auditHistory.pagination.hasNext}
            class="text-sm px-4 py-2 rounded-lg border border-bark-300 text-shadow-600 hover:bg-bark-100 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next
          </button>
          <span class="text-sm text-shadow-600">
            Showing {auditHistory.pagination.offset + 1}-{Math.min(auditHistory.pagination.offset + auditHistory.entries.length, auditHistory.pagination.total)}
            of {auditHistory.pagination.total}
          </span>
        </div>
      {/if}
    {/if}
  {/if}
</div>
