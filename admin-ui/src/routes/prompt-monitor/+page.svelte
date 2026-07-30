<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { ApiError } from '$lib/api/client';
  import {
    getSessionMessages,
    getSessionTurnDetail,
    listSessions,
  } from '$lib/api/endpoints/sessions';
  import BoundedList from '$lib/components/garden/BoundedList.svelte';
  import PromptMonitorSelectedTurnTabs from '$lib/components/prompt-monitor/PromptMonitorSelectedTurnTabs.svelte';
  import {
    connectGardenEventBus,
    disconnectGardenEventBus,
    getGardenEventBusConnectionError,
    getGardenEvents,
    isGardenEventBusConnected,
    subscribeGardenEvents,
  } from '$lib/events/garden-event-bus.svelte';
  import {
    buildPromptMonitorTurns,
    formatPromptMonitorStageLabel,
    mergePromptMonitorEvent,
    mergePromptMonitorResolvedTurn,
    PROMPT_MONITOR_STAGE_ORDER,
    resolvePromptMonitorMetrics,
    resolvePromptMonitorSummary,
    type PromptMonitorSnapshotRejection,
    type PromptMonitorTurn,
  } from '$lib/events/prompt-monitor';
  import type { ChannelInfo } from '$lib/types';
  import { isRecord } from '../../../../src/shared/utils/types.js';

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
  const pendingTurnDetailFetches = new Map<string, Promise<void>>();
  const deferredTurnDetailFetches = new Set<string>();

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
      turns = buildPromptMonitorTurns(response.turns, {
        onRejectedSnapshot: surfaceSnapshotRejection,
      });
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

  function stageTooltip(turn: PromptMonitorTurn): string {
    return PROMPT_MONITOR_STAGE_ORDER
      .map(stageName => {
        const stage = turn.stages.find(candidate => candidate.stage === stageName);
        return `${formatPromptMonitorStageLabel(stageName)}: ${stage ? formatDuration(stage.elapsedMs) : '—'}`;
      })
      .join('\n');
  }

  function surfaceSnapshotRejection(rejection: PromptMonitorSnapshotRejection): void {
    const turnLabel = rejection.turnId ? ` for turn ${rejection.turnId}` : '';
    error = `Rejected malformed ${rejection.source} turn snapshot${turnLabel}: ${rejection.message}`;
  }

  function isEndStageEvent(event: Parameters<typeof mergePromptMonitorEvent>[1]): boolean {
    return event.type === 'agent.turn.stage'
      && isRecord(event.data)
      && event.data.stage === 'end';
  }

  function needsResolvedTurnDetail(turnId: string): boolean {
    const turn = turns.find(candidate => candidate.turnId === turnId);
    return turn !== undefined && (turn.record === null || turn.promptLoom === null);
  }

  function resolveLiveTurnDetail(turnId: string, surfaceFailure: boolean): void {
    const sessionId = selectedSessionId;
    if (!sessionId || !needsResolvedTurnDetail(turnId)) return;
    if (!surfaceFailure && deferredTurnDetailFetches.has(turnId)) return;

    const active = pendingTurnDetailFetches.get(turnId);
    if (active) {
      if (surfaceFailure) {
        void active.finally(() => resolveLiveTurnDetail(turnId, true));
      }
      return;
    }

    let request: Promise<void>;
    request = getSessionTurnDetail(sessionId, turnId)
      .then((detail) => {
        if (selectedSessionId !== sessionId) return;
        turns = mergePromptMonitorResolvedTurn(turns, detail.turn, {
          onRejectedSnapshot: surfaceSnapshotRejection,
        });
        deferredTurnDetailFetches.delete(turnId);
      })
      .catch((cause: unknown) => {
        if (cause instanceof ApiError && cause.status === 404 && !surfaceFailure) {
          // Snapshot/stage telemetry can beat the durable TurnRecord to the
          // read endpoint. Record that race and retry exactly once when the end
          // stage arrives instead of rendering the unresolved slim snapshot.
          deferredTurnDetailFetches.add(turnId);
          return;
        }
        const message = cause instanceof Error ? cause.message : 'Failed to resolve live turn detail';
        error = `Failed to resolve live turn ${turnId}: ${message}`;
      })
      .finally(() => {
        if (pendingTurnDetailFetches.get(turnId) === request) {
          pendingTurnDetailFetches.delete(turnId);
        }
      });
    pendingTurnDetailFetches.set(turnId, request);
  }

  function handlePromptEvent(event: Parameters<typeof mergePromptMonitorEvent>[1]): void {
    if (!selectedLogicalChannelId || event.correlation.channelId !== selectedLogicalChannelId) {
      return;
    }
    let rejectedSnapshot = false;
    const nextTurns = mergePromptMonitorEvent(turns, event, {
      onRejectedSnapshot(rejection) {
        rejectedSnapshot = true;
        surfaceSnapshotRejection(rejection);
      },
    });
    if (rejectedSnapshot) return;
    turns = nextTurns;
    liveEventCount += 1;
    if (!selectedTurnId) {
      selectedTurnId = turns[0]?.turnId ?? null;
    }
    const turnId = event.correlation.turnId;
    if (turnId) {
      resolveLiveTurnDetail(turnId, isEndStageEvent(event));
    }
  }

  onMount(async () => {
    connectGardenEventBus();
    unsubscribePromptEvents = subscribeGardenEvents(handlePromptEvent, {
      types: ['agent.turn.snapshot', 'agent.turn.stage', 'memory.retrieval'],
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
        {#if !isGardenEventBusConnected() && getGardenEventBusConnectionError()}
          <span role="status">
            —
            {#if getGardenEventBusConnectionError()?.code !== null}
              code {getGardenEventBusConnectionError()?.code}:
            {/if}
            {getGardenEventBusConnectionError()?.reason}
          </span>
        {/if}
      </span>
      <button
        type="button"
        onclick={() => void loadChannels()}
        class="rounded-lg border border-bark-300 px-2.5 py-1 text-sm font-medium text-shadow-700 hover:bg-bark-100 transition-colors disabled:opacity-60"
        disabled={loadingChannels}
      >
        {loadingChannels ? 'Refreshing…' : 'Refresh Sessions'}
      </button>
      <button
        type="button"
        onclick={() => void refreshSelectedChannel()}
        class="rounded-lg border border-gold-300 bg-gold-50 px-2.5 py-1 text-sm font-medium text-shadow-800 hover:bg-gold-100 transition-colors disabled:opacity-60"
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

  <div class="card-garden flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
    <div class="flex items-baseline gap-2" title="Mean `agent.turn.stage.prompt` duration across loaded turns">
      <span class="text-xs font-medium uppercase tracking-wide text-shadow-600">Avg Prompt</span>
      <span class="font-serif text-2xl leading-none {metricTone(summary.averagePromptDurationMs, 1_500)}">
        {formatDuration(summary.averagePromptDurationMs)}
      </span>
    </div>
    <div class="flex items-baseline gap-2" title="Mean time-to-first-token across loaded turns">
      <span class="text-xs font-medium uppercase tracking-wide text-shadow-600">Avg TTFT</span>
      <span class="font-serif text-2xl leading-none {metricTone(summary.averageTtftMs, 500)}">
        {formatDuration(summary.averageTtftMs)}
      </span>
    </div>
    <div class="h-6 w-px bg-bark-300" aria-hidden="true"></div>
    <div class="flex items-baseline gap-2">
      <span class="text-xs font-medium uppercase tracking-wide text-shadow-600">Turns</span>
      <span class="text-base text-shadow-900">{summary.turnCount}</span>
    </div>
    <div class="flex items-baseline gap-2" title="Incomplete prompt traces still accumulating">
      <span class="text-xs font-medium uppercase tracking-wide text-shadow-600">Live</span>
      <span class="text-base text-shadow-900">{summary.liveTurnCount}</span>
    </div>
    <div class="ml-auto flex min-w-0 items-baseline gap-3 text-xs text-shadow-600">
      <span class="truncate" title={selectedLogicalChannelId ?? undefined}>
        {selectedLogicalChannelId ? truncateValue(selectedLogicalChannelId, 28) : 'No channel selected'}
      </span>
      <span class="truncate font-mono" title="Latest prompt stack pointer">
        stack {truncateValue(summary.latestPromptVersionPointer, 16)}
      </span>
    </div>
  </div>

  <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
    <aside class="card-garden overflow-hidden">
      <div class="flex items-baseline justify-between gap-3 border-b border-bark-300 bg-bark-100 px-4 py-2">
        <p class="text-sm font-medium text-shadow-800">Sessions</p>
        <p class="text-xs text-shadow-600">
          {channels.length} visible · {liveEventCount} live prompt event{liveEventCount === 1 ? '' : 's'}
        </p>
      </div>

      <BoundedList maxHeight="13.5rem" label="Sessions">
        {#if loadingChannels}
          <div class="space-y-2 p-3">
            {#each Array(3) as _}
              <div class="h-10 rounded-lg bg-bark-200 animate-pulse"></div>
            {/each}
          </div>
        {:else if channels.length === 0}
          <div class="p-3 text-sm text-shadow-600">
            No sessions with recorded turns yet.
          </div>
        {:else}
          {#each channels as channel (channel.sessionId)}
            <button
              type="button"
              onclick={() => selectChannel(channel.sessionId)}
              class="w-full border-b border-bark-200 px-3 py-2 text-left transition-colors hover:bg-bark-100"
              class:bg-gold-50={selectedSessionId === channel.sessionId}
              class:border-l-4={selectedSessionId === channel.sessionId}
              class:border-l-gold-400={selectedSessionId === channel.sessionId}
            >
              <div class="flex items-baseline justify-between gap-3">
                <p class="min-w-0 truncate text-sm font-medium text-shadow-900" title={channel.channelId}>
                  {channelLabel(channel)}
                </p>
                <p class="shrink-0 text-xs text-shadow-600">{formatRelativeActivity(channel)}</p>
              </div>
              <p class="mt-0.5 truncate text-xs text-shadow-600">
                {channel.messageCount} messages{channel.linkedContactName ? ` · ${channel.linkedContactName}` : ''}{channel.sessionId !== channel.channelId ? ` · session: ${channel.sessionId}` : ''}
              </p>
            </button>
          {/each}
        {/if}
      </BoundedList>
    </aside>

    <section class="card-garden overflow-hidden">
      <div class="flex items-baseline justify-between gap-3 border-b border-bark-300 bg-bark-100 px-4 py-2">
        <p class="text-sm font-medium text-shadow-800">Turns</p>
        <p class="min-w-0 truncate text-xs text-shadow-600" title={selectedLogicalChannelId ?? selectedSessionId ?? undefined}>
          {#if selectedSessionId}
            {turns.length} loaded · {selectedLogicalChannelId ?? selectedSessionId}
          {:else}
            no session selected
          {/if}
        </p>
      </div>

      <BoundedList maxHeight="13.5rem" label="Turn ledger">
        {#if !selectedSessionId}
          <div class="p-3 text-sm text-shadow-600">
            Select a session to inspect prompt generation.
          </div>
        {:else if loadingTurns}
          <div class="space-y-2 p-3">
            {#each Array(3) as _}
              <div class="h-10 rounded-lg bg-bark-200 animate-pulse"></div>
            {/each}
          </div>
        {:else if turns.length === 0}
          <div class="p-3 text-sm text-shadow-600">
            No prompt traces yet. Trigger a turn and the live bus will populate the monitor.
          </div>
        {:else}
          {#each turns as turn (turn.turnId)}
            {@const metrics = resolvePromptMonitorMetrics(turn)}
            <button
              type="button"
              onclick={() => selectedTurnId = turn.turnId}
              title={stageTooltip(turn)}
              class="w-full border-b border-bark-200 px-3 py-2 text-left transition-colors hover:bg-gold-50/50"
              class:bg-gold-50={selectedTurnId === turn.turnId}
              class:border-l-4={selectedTurnId === turn.turnId}
              class:border-l-gold-400={selectedTurnId === turn.turnId}
            >
              <div class="flex items-baseline justify-between gap-3">
                <p class="min-w-0 truncate font-mono text-sm text-shadow-900">
                  {truncateValue(turn.turnId, 22)}
                </p>
                <span class="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium
                  {metrics.isComplete ? 'bg-bark-100 text-shadow-700' : 'bg-moss-50 text-moss-700'}">
                  {metrics.isComplete ? 'recorded' : 'live'}
                </span>
              </div>
              <p class="mt-0.5 flex flex-wrap items-baseline gap-x-3 text-xs text-shadow-600">
                <span>TTFT <span class="text-sm font-medium {metricTone(metrics.ttftMs, 500)}">{formatDuration(metrics.ttftMs)}</span></span>
                <span>Prompt <span class="text-sm font-medium {metricTone(metrics.promptDurationMs, 1_500)}">{formatDuration(metrics.promptDurationMs)}</span></span>
                <span class="font-mono">{truncateValue(metrics.promptVersionPointer, 12)}</span>
                <span>{metrics.promptMode ?? 'default'}</span>
                <span>{formatTimestamp(turn.latestEventAt)}</span>
              </p>
            </button>
          {/each}
        {/if}
      </BoundedList>
    </section>
  </div>

  {#if selectedTurn}
    <PromptMonitorSelectedTurnTabs
      turn={selectedTurn}
      metrics={selectedTurnMetrics}
      selectedChannelEvents={selectedChannelEvents}
      turns={turns}
    />
  {/if}
</div>
