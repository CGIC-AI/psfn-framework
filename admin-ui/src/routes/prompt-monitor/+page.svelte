<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { getSessionMessages, listSessions } from '$lib/api/endpoints/sessions';
  import PromptMonitorSelectedTurnTabs from '$lib/components/prompt-monitor/PromptMonitorSelectedTurnTabs.svelte';
  import {
    connectGardenEventBus,
    disconnectGardenEventBus,
    getGardenEvents,
    isGardenEventBusConnected,
    subscribeGardenEvents,
  } from '$lib/events/garden-event-bus.svelte';
  import {
    buildPromptMonitorTurns,
    formatPromptMonitorStageLabel,
    mergePromptMonitorEvent,
    PROMPT_MONITOR_STAGE_ORDER,
    resolvePromptMonitorMetrics,
    resolvePromptMonitorSummary,
    type PromptMonitorTurn,
  } from '$lib/events/prompt-monitor';
  import type { ChannelInfo } from '$lib/types';

  let channels = $state<ChannelInfo[]>([]);
  let selectedSessionId = $state<string | null>(null);
  let turns = $state<PromptMonitorTurn[]>([]);
  let selectedTurnId = $state<string | null>(null);
  let loadingChannels = $state(true);
  let loadingTurns = $state(false);
  let refreshingSelected = $state(false);
  let error = $state('');
  let liveEventCount = $state(0);

  let unsubscribePromptEvents: (() => void) | null = null;

  const selectedChannel = $derived(channels.find(channel => channel.sessionId === selectedSessionId) ?? null);
  const selectedLogicalChannelId = $derived(selectedChannel?.channelId ?? null);
  const selectedTurn = $derived(turns.find(turn => turn.turnId === selectedTurnId) ?? turns[0] ?? null);
  const selectedTurnMetrics = $derived(selectedTurn ? resolvePromptMonitorMetrics(selectedTurn) : null);
  const selectedChannelEvents = $derived.by(() => {
    if (!selectedLogicalChannelId) return [];
    return getGardenEvents()
      .filter(event => event.correlation.channelId === selectedLogicalChannelId)
      .slice(-30)
      .reverse();
  });
  const summary = $derived(resolvePromptMonitorSummary(turns));

  function sortChannels(nextChannels: ChannelInfo[]): ChannelInfo[] {
    return [...nextChannels].sort((left, right) => {
      const leftActivity = left.lastActivityAt ?? 0;
      const rightActivity = right.lastActivityAt ?? 0;
      if (rightActivity !== leftActivity) {
        return rightActivity - leftActivity;
      }
      if (right.messageCount !== left.messageCount) {
        return right.messageCount - left.messageCount;
      }
      return left.channelId.localeCompare(right.channelId);
    });
  }

  async function loadChannels(): Promise<void> {
    loadingChannels = true;
    error = '';
    try {
      const response = await listSessions();
      channels = sortChannels(response.channels);

      if (!selectedSessionId && channels.length > 0) {
        selectedSessionId = channels[0].sessionId;
        await loadTurnsForChannel(selectedSessionId, { preserveSelection: false });
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Failed to load sessions';
    } finally {
      loadingChannels = false;
    }
  }

  async function loadTurnsForChannel(
    sessionId: string,
    options: { preserveSelection: boolean } = { preserveSelection: true },
  ): Promise<void> {
    loadingTurns = true;
    error = '';
    try {
      const response = await getSessionMessages(sessionId);
      turns = buildPromptMonitorTurns(response.turns);
      liveEventCount = 0;

      if (!options.preserveSelection || !turns.some(turn => turn.turnId === selectedTurnId)) {
        selectedTurnId = turns[0]?.turnId ?? null;
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Failed to load session turns';
      turns = [];
      selectedTurnId = null;
    } finally {
      loadingTurns = false;
    }
  }

  async function refreshSelectedChannel(): Promise<void> {
    if (!selectedSessionId || refreshingSelected) return;
    refreshingSelected = true;
    try {
      await loadTurnsForChannel(selectedSessionId);
    } finally {
      refreshingSelected = false;
    }
  }

  function selectChannel(sessionId: string): void {
    if (sessionId === selectedSessionId) return;
    selectedSessionId = sessionId;
    turns = [];
    selectedTurnId = null;
    liveEventCount = 0;
    void loadTurnsForChannel(sessionId, { preserveSelection: false });
  }

  function formatDuration(value: number | null): string {
    if (value == null) return '—';
    if (value < 1_000) return `${Math.round(value)}ms`;
    if (value < 60_000) return `${(value / 1_000).toFixed(2)}s`;
    return `${(value / 60_000).toFixed(2)}m`;
  }

  function formatTimestamp(value: number | null): string {
    if (value == null) return '—';
    return new Date(value).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatRelativeActivity(channel: ChannelInfo): string {
    const timestamp = channel.lastActivityAt ?? null;
    if (timestamp == null) return 'No recent activity';
    const deltaMs = Date.now() - timestamp;
    if (deltaMs < 60_000) return `${Math.max(1, Math.round(deltaMs / 1_000))}s ago`;
    if (deltaMs < 3_600_000) return `${Math.round(deltaMs / 60_000)}m ago`;
    if (deltaMs < 86_400_000) return `${Math.round(deltaMs / 3_600_000)}h ago`;
    return `${Math.round(deltaMs / 86_400_000)}d ago`;
  }

  function channelLabel(channel: ChannelInfo): string {
    return channel.displayLabel ?? channel.channelId;
  }

  function truncateValue(value: string | null | undefined, limit: number = 18): string {
    if (!value) return '—';
    if (value.length <= limit) return value;
    return `${value.slice(0, limit)}…`;
  }

  function metricTone(value: number | null, warningThreshold: number): string {
    if (value == null) return 'text-shadow-700';
    return value >= warningThreshold ? 'text-wilt-600' : 'text-moss-700';
  }

  function handlePromptEvent(event: Parameters<typeof mergePromptMonitorEvent>[1]): void {
    if (!selectedLogicalChannelId || event.correlation.channelId !== selectedLogicalChannelId) {
      return;
    }
    turns = mergePromptMonitorEvent(turns, event);
    liveEventCount += 1;
    if (!selectedTurnId) {
      selectedTurnId = turns[0]?.turnId ?? null;
    }
  }

  onMount(async () => {
    connectGardenEventBus();
    unsubscribePromptEvents = subscribeGardenEvents(handlePromptEvent, {
      types: ['agent.turn.snapshot', 'agent.turn.stage'],
    });
    await loadChannels();
  });

  onDestroy(() => {
    unsubscribePromptEvents?.();
    disconnectGardenEventBus();
  });
</script>

<div class="space-y-6">
  <div class="flex items-start justify-between gap-3 flex-wrap">
    <div>
      <h1 class="font-serif text-2xl text-shadow-900 font-semibold">The Loom</h1>
      <p class="text-shadow-600 text-sm mt-1">
        Prompt-generation monitor built from live turn snapshots and stage telemetry.
      </p>
    </div>
    <div class="flex items-center gap-2 flex-wrap">
      <span class="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium
        {isGardenEventBusConnected() ? 'border-moss-300 bg-moss-50 text-moss-700' : 'border-wilt-200 bg-wilt-50 text-wilt-600'}">
        <span class="inline-block h-2.5 w-2.5 rounded-full {isGardenEventBusConnected() ? 'bg-moss-500' : 'bg-wilt-400'}"></span>
        {isGardenEventBusConnected() ? 'Live bus connected' : 'Live bus disconnected'}
      </span>
      <button
        type="button"
        onclick={() => void loadChannels()}
        class="rounded-lg border border-bark-300 px-3 py-1.5 text-sm font-medium text-shadow-700 hover:bg-bark-100 transition-colors disabled:opacity-60"
        disabled={loadingChannels}
      >
        {loadingChannels ? 'Refreshing…' : 'Refresh Sessions'}
      </button>
      <button
        type="button"
        onclick={() => void refreshSelectedChannel()}
        class="rounded-lg border border-gold-300 bg-gold-50 px-3 py-1.5 text-sm font-medium text-shadow-800 hover:bg-gold-100 transition-colors disabled:opacity-60"
        disabled={!selectedSessionId || refreshingSelected}
      >
        {refreshingSelected ? 'Refreshing…' : 'Refresh Turn History'}
      </button>
    </div>
  </div>

  {#if error}
    <div class="card-garden border-wilt-200 p-4">
      <p class="text-sm font-medium text-wilt-600">Monitor error</p>
      <p class="mt-1 text-sm text-shadow-700">{error}</p>
    </div>
  {/if}

  <div class="grid grid-cols-1 xl:grid-cols-[18rem,minmax(0,1fr)] gap-4">
    <aside class="card-garden overflow-hidden">
      <div class="border-b border-bark-300 bg-bark-100 px-4 py-3">
        <p class="text-sm font-medium text-shadow-800">Sessions</p>
        <p class="text-sm text-shadow-600">
          {channels.length} visible . {liveEventCount} live prompt event{liveEventCount === 1 ? '' : 's'}
        </p>
      </div>

      <div class="max-h-[36rem] overflow-y-auto">
        {#if loadingChannels}
          <div class="space-y-2 p-4">
            {#each Array(6) as _}
              <div class="h-14 rounded-lg bg-bark-200 animate-pulse"></div>
            {/each}
          </div>
        {:else if channels.length === 0}
          <div class="p-4 text-sm text-shadow-600">
            No sessions with recorded turns yet.
          </div>
        {:else}
          {#each channels as channel (channel.sessionId)}
            <button
              type="button"
              onclick={() => selectChannel(channel.sessionId)}
              class="w-full border-b border-bark-200 px-4 py-3 text-left transition-colors hover:bg-bark-100"
              class:bg-gold-50={selectedSessionId === channel.sessionId}
              class:border-l-4={selectedSessionId === channel.sessionId}
              class:border-l-gold-400={selectedSessionId === channel.sessionId}
            >
              <p class="truncate text-sm font-medium text-shadow-900" title={channel.channelId}>
                {channelLabel(channel)}
              </p>
              <p class="mt-1 text-sm text-shadow-600">
                {channel.messageCount} messages . {formatRelativeActivity(channel)}
              </p>
              {#if channel.sessionId !== channel.channelId}
                <p class="mt-1 truncate font-mono text-sm text-shadow-600" title={channel.sessionId}>
                  session: {channel.sessionId}
                </p>
              {/if}
              {#if channel.linkedContactName}
                <p class="mt-1 truncate text-sm text-moss-700">
                  {channel.linkedContactName}
                </p>
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    </aside>

    <div class="space-y-4 min-w-0">
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="card-garden p-4">
          <p class="text-sm font-medium uppercase tracking-wide text-shadow-600">Turns Loaded</p>
          <p class="mt-1 font-serif text-3xl text-shadow-900">{summary.turnCount}</p>
          <p class="mt-1 text-sm text-shadow-600">
            {selectedLogicalChannelId ? truncateValue(selectedLogicalChannelId, 28) : 'No channel selected'}
          </p>
        </div>
        <div class="card-garden p-4">
          <p class="text-sm font-medium uppercase tracking-wide text-shadow-600">Live Turns</p>
          <p class="mt-1 font-serif text-3xl text-shadow-900">{summary.liveTurnCount}</p>
          <p class="mt-1 text-sm text-shadow-600">Incomplete prompt traces still accumulating</p>
        </div>
        <div class="card-garden p-4">
          <p class="text-sm font-medium uppercase tracking-wide text-shadow-600">Avg Prompt Stage</p>
          <p class="mt-1 font-serif text-3xl {metricTone(summary.averagePromptDurationMs, 1_500)}">
            {formatDuration(summary.averagePromptDurationMs)}
          </p>
          <p class="mt-1 text-sm text-shadow-600">Mean `agent.turn.stage.prompt` duration</p>
        </div>
        <div class="card-garden p-4">
          <p class="text-sm font-medium uppercase tracking-wide text-shadow-600">Avg TTFT</p>
          <p class="mt-1 font-serif text-3xl {metricTone(summary.averageTtftMs, 500)}">
            {formatDuration(summary.averageTtftMs)}
          </p>
          <p class="mt-1 text-sm text-shadow-600">
            Latest stack {truncateValue(summary.latestPromptVersionPointer, 16)}
          </p>
        </div>
      </div>

      {#if !selectedSessionId}
        <div class="card-garden p-8 text-center text-shadow-600">
          Select a session to inspect prompt generation.
        </div>
      {:else if loadingTurns}
        <div class="card-garden p-5 space-y-3">
          {#each Array(4) as _}
            <div class="h-24 rounded-lg bg-bark-200 animate-pulse"></div>
          {/each}
        </div>
      {:else if turns.length === 0}
        <div class="card-garden p-8 text-center">
          <p class="font-serif text-lg text-shadow-800">No prompt traces yet</p>
          <p class="mt-2 text-sm text-shadow-600">
            This session has no recorded turn observability. Trigger a turn and the live bus will populate the monitor.
          </p>
        </div>
      {:else}
        <div class="grid grid-cols-1 2xl:grid-cols-[minmax(0,1.1fr),minmax(0,0.9fr)] gap-4">
          <section class="card-garden overflow-hidden">
            <div class="border-b border-bark-300 bg-bark-100 px-5 py-4">
              <h2 class="font-serif text-lg text-shadow-900">Turn Ledger</h2>
              <p class="mt-1 text-sm text-shadow-600">
                Prompt snapshots and stage timings for {selectedLogicalChannelId ?? selectedSessionId}
              </p>
            </div>

            <div class="max-h-[42rem] overflow-y-auto p-4 space-y-3">
              {#each turns as turn (turn.turnId)}
                {@const metrics = resolvePromptMonitorMetrics(turn)}
                <button
                  type="button"
                  onclick={() => selectedTurnId = turn.turnId}
                  class="w-full rounded-xl border p-4 text-left transition-colors hover:border-gold-300 hover:bg-gold-50/50"
                  class:border-gold-400={selectedTurnId === turn.turnId}
                  class:bg-gold-50={selectedTurnId === turn.turnId}
                  class:border-bark-300={selectedTurnId !== turn.turnId}
                >
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <p class="truncate font-mono text-sm text-shadow-900">
                        {truncateValue(turn.turnId, 22)}
                      </p>
                      <p class="mt-1 text-sm text-shadow-600">
                        {formatTimestamp(turn.latestEventAt)}
                      </p>
                    </div>
                    <span class="shrink-0 rounded-full px-2.5 py-1 text-sm font-medium
                      {metrics.isComplete ? 'bg-bark-100 text-shadow-700' : 'bg-moss-50 text-moss-700'}">
                      {metrics.isComplete ? 'recorded' : 'live'}
                    </span>
                  </div>

                  <div class="mt-3 grid grid-cols-2 gap-2 text-sm text-shadow-700 sm:grid-cols-4">
                    <div>
                      <span class="block text-shadow-600">TTFT</span>
                      <span class="font-medium {metricTone(metrics.ttftMs, 500)}">{formatDuration(metrics.ttftMs)}</span>
                    </div>
                    <div>
                      <span class="block text-shadow-600">Prompt</span>
                      <span class="font-medium {metricTone(metrics.promptDurationMs, 1_500)}">{formatDuration(metrics.promptDurationMs)}</span>
                    </div>
                    <div>
                      <span class="block text-shadow-600">Stack</span>
                      <span class="font-mono text-shadow-800">{truncateValue(metrics.promptVersionPointer, 12)}</span>
                    </div>
                    <div>
                      <span class="block text-shadow-600">Mode</span>
                      <span class="text-shadow-800">{metrics.promptMode ?? 'default'}</span>
                    </div>
                  </div>

                  <div class="mt-3 flex flex-wrap gap-2">
                    {#each PROMPT_MONITOR_STAGE_ORDER as stageName}
                      {@const stage = turn.stages.find(candidate => candidate.stage === stageName)}
                      <span class="rounded-full border px-2.5 py-1 text-sm
                        {stage ? 'border-gold-200 bg-gold-50 text-shadow-800' : 'border-bark-200 bg-white text-shadow-500'}">
                        {formatPromptMonitorStageLabel(stageName)} {stage ? `· ${formatDuration(stage.elapsedMs)}` : ''}
                      </span>
                    {/each}
                  </div>
                </button>
              {/each}
            </div>
          </section>

          {#if selectedTurn}
            <PromptMonitorSelectedTurnTabs
              turn={selectedTurn}
              metrics={selectedTurnMetrics}
              selectedChannelEvents={selectedChannelEvents}
            />
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>
