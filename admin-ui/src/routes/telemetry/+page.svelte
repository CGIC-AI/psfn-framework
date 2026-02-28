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
  import type { TelemetryEvent, AuditEntry, AuditActionType, AuditDecision, AuditTimeRange } from '$lib/types';

  // ── Tab State ──
  type TabId = 'live' | 'audit';
  let activeTab = $state<TabId>('live');

  // ══════════════════════════════════════════════
  // LIVE EVENTS tab state
  // ══════════════════════════════════════════════
  let filterText = $state('');
  let scrollContainer: HTMLDivElement | undefined = $state();
  let autoScroll = $state(true);
  let expandedIdx = $state<number | null>(null);
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
    let evts = filterText ? filterEvents(filterText) : getEvents();
    evts = evts.filter(e => isCategoryEnabled(categorize(e.type)));
    return evts;
  });

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

  const ACTION_TYPE_OPTIONS: { value: AuditActionType | 'all'; label: string }[] = [
    { value: 'all', label: 'All action types' },
    { value: 'tool_invocation', label: 'Tool invocation' },
    { value: 'identity_edit', label: 'Identity edit' },
    { value: 'external_action', label: 'External action' },
    { value: 'memory_mutation', label: 'Memory mutation' },
  ];

  const DECISION_OPTIONS: { value: AuditDecision | 'all'; label: string }[] = [
    { value: 'all', label: 'All decisions' },
    { value: 'allowed', label: 'Allowed' },
    { value: 'denied', label: 'Denied' },
  ];

  const TIME_RANGE_OPTIONS: { value: AuditTimeRange; label: string }[] = [
    { value: '15m', label: 'Last 15 min' },
    { value: '1h', label: 'Last hour' },
    { value: '24h', label: 'Last 24h' },
    { value: '7d', label: 'Last 7 days' },
    { value: '30d', label: 'Last 30 days' },
    { value: 'all', label: 'All time' },
  ];

  const TIME_RANGE_MS: Record<Exclude<AuditTimeRange, 'all'>, number> = {
    '15m': 15 * 60 * 1_000,
    '1h': 60 * 60 * 1_000,
    '24h': 24 * 60 * 60 * 1_000,
    '7d': 7 * 24 * 60 * 60 * 1_000,
    '30d': 30 * 24 * 60 * 60 * 1_000,
  };

  // Classify telemetry events into audit entries
  function eventToAuditEntry(event: TelemetryEvent, index: number): AuditEntry | null {
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') return null;

    // Tool invocations
    if (event.type === 'agent.tool.start' || event.type === 'agent.tool.end') {
      const toolName = (data.name as string) || (data.toolName as string) || 'unknown';
      const status = event.type === 'agent.tool.start' ? 'started' : 'completed';
      const resultText = data.error ? `error: ${data.error}` : '';
      return {
        id: `audit-${index}`,
        timestamp: event.timestamp,
        actionType: 'tool_invocation',
        decision: 'allowed',
        narrative: `Tool "${toolName}" ${status}`,
        details: resultText || undefined,
      };
    }

    // Memory mutations
    if (event.type === 'memory.extraction.end' || event.type.startsWith('memory.write') || event.type.startsWith('memory.import')) {
      const count = (data.count as number) || (data.extracted as number) || 0;
      return {
        id: `audit-${index}`,
        timestamp: event.timestamp,
        actionType: 'memory_mutation',
        decision: 'allowed',
        narrative: `Memory ${event.type.split('.').pop()}: ${count > 0 ? `${count} entries` : 'completed'}`,
        details: data.types ? `types: ${data.types}` : undefined,
      };
    }

    // External actions (message sent, broadcast)
    if (event.type === 'message.sent' || event.type.startsWith('broadcast.')) {
      const channel = (data.channelId as string) || (data.channel as string) || '';
      return {
        id: `audit-${index}`,
        timestamp: event.timestamp,
        actionType: 'external_action',
        decision: 'allowed',
        narrative: `${event.type}${channel ? ` on ${channel}` : ''}`,
        details: data.contentPreview ? String(data.contentPreview) : undefined,
      };
    }

    // Wyoming policy violations (denied)
    if (event.type === 'wyoming.policy.violation') {
      return {
        id: `audit-${index}`,
        timestamp: event.timestamp,
        actionType: 'external_action',
        decision: 'denied',
        narrative: `Wyoming policy violation: ${data.code || 'unknown'}`,
        details: [
          data.scope ? `scope=${data.scope}` : null,
          data.action ? `action=${data.action}` : null,
          data.limit ? `limit=${data.limit}` : null,
        ].filter(Boolean).join(' ') || undefined,
      };
    }

    // Wyoming audit summary
    if (event.type === 'wyoming.audit.summary') {
      const decision = data.decision === 'denied' ? 'denied' as const : 'allowed' as const;
      return {
        id: `audit-${index}`,
        timestamp: event.timestamp,
        actionType: 'external_action',
        decision,
        narrative: `Wyoming ${data.method || 'action'}: ${data.decision || 'unknown'}`,
        details: data.error ? String(data.error) : undefined,
      };
    }

    // Wyoming session events
    if (event.type === 'wyoming.session.start' || event.type === 'wyoming.session.end') {
      return {
        id: `audit-${index}`,
        timestamp: event.timestamp,
        actionType: 'external_action',
        decision: 'allowed',
        narrative: event.type === 'wyoming.session.start'
          ? `Wyoming session started (${data.activeSessions || 0} active)`
          : `Wyoming session ended: ${data.reason || 'normal'}`,
        details: data.durationMs ? `duration=${data.durationMs}ms` : undefined,
      };
    }

    // Agent turn usage (audit as tool invocation since it's a completed turn)
    if (event.type === 'agent.turn.usage') {
      return {
        id: `audit-${index}`,
        timestamp: event.timestamp,
        actionType: 'tool_invocation',
        decision: 'allowed',
        narrative: `Agent turn completed`,
        details: [
          data.inputTokens ? `input=${data.inputTokens}` : null,
          data.outputTokens ? `output=${data.outputTokens}` : null,
          data.toolCalls ? `tools=${data.toolCalls}` : null,
        ].filter(Boolean).join(' ') || undefined,
      };
    }

    return null;
  }

  let auditEntries = $derived.by(() => {
    const allEvents = getEvents();
    const entries: AuditEntry[] = [];

    for (let i = 0; i < allEvents.length; i++) {
      const entry = eventToAuditEntry(allEvents[i], i);
      if (entry) entries.push(entry);
    }

    // Apply filters
    const now = Date.now();
    const minTimestamp = auditTimeRange === 'all' ? 0 : now - TIME_RANGE_MS[auditTimeRange];

    return entries.filter(entry => {
      if (entry.timestamp < minTimestamp) return false;
      if (auditActionType !== 'all' && entry.actionType !== auditActionType) return false;
      if (auditDecision !== 'all' && entry.decision !== auditDecision) return false;
      return true;
    }).reverse(); // newest first
  });

  const DECISION_BADGE: Record<AuditDecision, string> = {
    allowed: 'bg-moss-100 text-moss-700',
    denied: 'bg-wilt-100 text-wilt-600',
  };

  const ACTION_TYPE_BADGE: Record<AuditActionType, string> = {
    tool_invocation: 'bg-gold-100 text-gold-700',
    identity_edit: 'bg-petal-100 text-petal-500',
    external_action: 'bg-bark-200 text-shadow-800',
    memory_mutation: 'bg-moss-100 text-moss-700',
  };

  const ACTION_TYPE_LABEL: Record<AuditActionType, string> = {
    tool_invocation: 'Tool',
    identity_edit: 'Identity',
    external_action: 'External',
    memory_mutation: 'Memory',
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
      <h1 class="text-2xl font-serif font-bold text-shadow-900">The Sap</h1>
      <p class="text-sm text-shadow-600 mt-1">Real-time telemetry and audit trail flowing through the substrate</p>
    </div>

    <!-- Connection indicator -->
    <div class="flex items-center gap-3">
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
    </div>
  </div>

  <!-- Tab bar -->
  <div class="flex gap-1 border-b border-bark-300">
    <button
      onclick={() => activeTab = 'live'}
      class="px-5 py-2.5 text-sm font-medium rounded-t-lg transition-colors
             {activeTab === 'live'
               ? 'bg-white border border-bark-300 border-b-white -mb-px text-shadow-900'
               : 'text-shadow-600 hover:text-shadow-800 hover:bg-bark-100'}"
    >
      Live Events
    </button>
    <button
      onclick={() => activeTab = 'audit'}
      class="px-5 py-2.5 text-sm font-medium rounded-t-lg transition-colors
             {activeTab === 'audit'
               ? 'bg-white border border-bark-300 border-b-white -mb-px text-shadow-900'
               : 'text-shadow-600 hover:text-shadow-800 hover:bg-bark-100'}"
    >
      Audit Trail
      {#if auditEntries.length > 0}
        <span class="ml-1.5 text-xs px-1.5 py-0.5 rounded-full bg-gold-100 text-gold-700">{auditEntries.length}</span>
      {/if}
    </button>
  </div>

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
          type="text"
          bind:value={filterText}
          placeholder="Filter by type prefix..."
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

    <!-- Terminal-style event stream -->
    <div
      class="flex-1 min-h-0 overflow-y-auto rounded-lg border border-shadow-800 bg-shadow-900"
      style="min-height: 400px;"
      bind:this={scrollContainer}
      onscroll={handleScroll}
    >
      {#if filteredEvents.length === 0}
        <div class="p-12 text-center">
          <p class="text-sm italic font-sans text-bark-400">
            No sap flows yet -- events will appear as the substrate runs
          </p>
          {#if !isConnected()}
            <button
              onclick={handleConnect}
              class="mt-3 text-sm font-sans font-medium text-gold-400 hover:text-gold-300"
            >
              Connect to start
            </button>
          {/if}
        </div>
      {:else}
        <div class="p-3 space-y-0">
          {#each filteredEvents as event, i (event.timestamp.toString() + event.type + i)}
            <div
              role="button"
              tabindex="0"
              class="flex items-start gap-3 py-1 px-2 font-mono text-sm rounded transition-colors cursor-pointer hover:bg-shadow-800"
              onclick={() => expandedIdx = expandedIdx === i ? null : i}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expandedIdx = expandedIdx === i ? null : i; } }}
            >
              <!-- Timestamp -->
              <span class="shrink-0 w-28 text-bark-500">
                {formatTime(event.timestamp)}
              </span>
              <!-- Event type (gold) -->
              <span class="shrink-0 w-56 font-medium truncate text-gold-400">
                {event.type}
              </span>
              <!-- Key-value data -->
              <span class="flex-1 truncate text-bark-300">
                {formatEventKv(event.data)}
              </span>
            </div>
            {#if expandedIdx === i}
              <pre
                class="mx-2 mb-1 p-3 rounded text-sm font-mono overflow-x-auto max-h-64 overflow-y-auto bg-shadow-950 text-bark-300"
              >{formatJson(event.data)}</pre>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- ══════════════════════════════════════════════ -->
  <!-- AUDIT TRAIL TAB                               -->
  <!-- ══════════════════════════════════════════════ -->
  {#if activeTab === 'audit'}
    <div class="card-garden p-4">
      <p class="text-sm text-shadow-600 mb-4">
        Unified timeline for tool invocations, identity edits, external actions, and memory mutations.
        Audit entries are derived from the live telemetry stream.
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

        <div class="flex-1"></div>

        <span class="text-sm text-shadow-600">
          {auditEntries.length} {auditEntries.length === 1 ? 'entry' : 'entries'}
        </span>
      </div>
    </div>

    <!-- Connection required notice -->
    {#if !isConnected() && getEvents().length === 0}
      <div class="card-garden p-8 text-center">
        <p class="font-serif text-lg text-shadow-800 mb-2">No telemetry data</p>
        <p class="text-sm text-shadow-600 mb-4">
          Audit entries are derived from the live telemetry stream. Connect to start capturing events.
        </p>
        <button
          onclick={handleConnect}
          class="text-sm px-5 py-2.5 rounded-lg border border-moss-300 bg-moss-50 text-moss-700
                 hover:bg-moss-100 font-medium transition-colors"
        >
          Connect telemetry
        </button>
      </div>
    {:else if auditEntries.length === 0}
      <div class="card-garden p-8 text-center">
        <p class="text-sm text-shadow-600 italic">
          No audit events match the selected filters.
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
              <span class="inline-block px-2 py-0.5 rounded-full text-sm font-medium {DECISION_BADGE[entry.decision]}">
                {entry.decision === 'allowed' ? 'Allowed' : 'Denied'}
              </span>
            </div>
            <p class="text-sm text-shadow-800 leading-relaxed">{entry.narrative}</p>
            {#if entry.details}
              <p class="text-sm text-shadow-600 mt-1 font-mono">{entry.details}</p>
            {/if}
          </article>
        {/each}
      </div>
    {/if}
  {/if}
</div>
