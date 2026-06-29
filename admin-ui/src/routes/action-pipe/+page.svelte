<script lang="ts">
  import { onMount } from 'svelte';
  import {
    acknowledgeActionPipeAction,
    cancelActionPipeAction,
    getActionPipeStatus,
    type ActionPipeStatus,
  } from '$lib/api/endpoints/action-pipe';

  type QueuedAction = ActionPipeStatus['queued'][number];
  type LaneStatus = ActionPipeStatus['lanes'][number];
  type FailureRecord = ActionPipeStatus['failures']['recentFailures'][number];
  type DropRecord = ActionPipeStatus['backPressure']['recentDrops'][number];
  type TerminalRecord = ActionPipeStatus['terminal']['recentTerminals'][number];
  type CompletionRecord = ActionPipeStatus['completions']['recentCompletions'][number];
  type OutreachRecord = NonNullable<ActionPipeStatus['outreachOutbox']>['recentRecords'][number];
  type HistoryRecord = FailureRecord | DropRecord | TerminalRecord | CompletionRecord;

  const MUTATION_CANCEL_DETAIL = 'Cancelled from Garden action-pipe operator surface.';
  const MUTATION_ACK_DETAIL = 'Acknowledged from Garden action-pipe operator surface.';
  const DEFAULT_STATE_CLASS = 'border-leaf-300 bg-leaf-50 text-leaf-800';
  const STATE_CLASS_BY_STATE: Record<string, string> = {
    ready: 'border-gold-300 bg-gold-50 text-gold-800',
    running: 'border-gold-300 bg-gold-50 text-gold-800',
    scheduled: 'border-petal-300 bg-petal-50 text-petal-800',
    retry_scheduled: 'border-petal-300 bg-petal-50 text-petal-800',
    queued: 'border-gold-300 bg-gold-50 text-gold-800',
    sent: 'border-leaf-300 bg-leaf-50 text-leaf-700',
    blocked: 'border-wilt-300 bg-wilt-50 text-wilt-700',
    failed: 'border-wilt-300 bg-wilt-50 text-wilt-700',
    skipped: 'border-bark-300 bg-bark-100 text-shadow-700',
    cancelled: 'border-bark-300 bg-bark-100 text-shadow-700',
    acknowledged: 'border-bark-300 bg-bark-100 text-shadow-700',
  };
  const DURATION_UNITS = [
    { max: 1_000, divisor: 1, suffix: 'ms' },
    { max: 60_000, divisor: 1_000, suffix: 's' },
    { max: 3_600_000, divisor: 60_000, suffix: 'm' },
    { max: Number.POSITIVE_INFINITY, divisor: 3_600_000, suffix: 'h' },
  ] as const;

  let status = $state<ActionPipeStatus | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let errorMessage = $state('');
  let mutationMessage = $state('');
  let mutationOk = $state(true);
  let mutatingActionRef = $state('');

  let queuedActions = $derived(status?.queued ?? []);
  let lanes = $derived(status?.lanes ?? []);
  let recentFailures = $derived(status?.failures.recentFailures ?? []);
  let recentDrops = $derived(status?.backPressure.recentDrops ?? []);
  let recentTerminals = $derived(status?.terminal.recentTerminals ?? []);
  let recentCompletions = $derived(status?.completions.recentCompletions ?? []);
  let outreachRecords = $derived(status?.outreachOutbox?.recentRecords ?? []);
  let subagentOutcomes = $derived.by(() => recentCompletions.filter((entry) => Boolean(entry.subagentSpawn)));
  let historyPanels = $derived.by(() => [
    { title: 'Failures', records: recentFailures as HistoryRecord[], empty: 'No recent failures.' },
    { title: 'Back-pressure drops', records: recentDrops as HistoryRecord[], empty: 'No recent back-pressure drops.' },
    { title: 'Operator terminals', records: recentTerminals as HistoryRecord[], empty: 'No recent cancellations or acknowledgements.' },
    { title: 'Completions', records: recentCompletions as HistoryRecord[], empty: 'No recent completions.' },
  ]);

  async function loadStatus(): Promise<void> {
    errorMessage = '';
    mutationMessage = '';
    try {
      status = await getActionPipeStatus();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Failed to load action pipe status.';
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  async function refreshStatus(): Promise<void> {
    refreshing = true;
    await loadStatus();
  }

  async function cancelAction(action: QueuedAction): Promise<void> {
    mutatingActionRef = action.actionId;
    mutationMessage = '';
    try {
      const result = await cancelActionPipeAction(action.actionId, MUTATION_CANCEL_DETAIL);
      status = result.status;
      mutationOk = result.ok;
      mutationMessage = result.message;
    } catch (error) {
      mutationOk = false;
      mutationMessage = error instanceof Error ? error.message : 'Failed to cancel action.';
    } finally {
      mutatingActionRef = '';
    }
  }

  async function acknowledgeAction(action: QueuedAction): Promise<void> {
    mutatingActionRef = action.actionId;
    mutationMessage = '';
    try {
      const result = await acknowledgeActionPipeAction(action.actionId, MUTATION_ACK_DETAIL);
      status = result.status;
      mutationOk = result.ok;
      mutationMessage = result.message;
    } catch (error) {
      mutationOk = false;
      mutationMessage = error instanceof Error ? error.message : 'Failed to acknowledge action.';
    } finally {
      mutatingActionRef = '';
    }
  }

  function formatTime(timestamp: number | undefined): string {
    if (!timestamp) return '-';
    return new Date(timestamp).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatDuration(ms: number | undefined): string {
    if (ms === undefined || !Number.isFinite(ms)) return '-';
    const boundedMs = Math.max(0, ms);
    const unit = DURATION_UNITS.find((candidate) => boundedMs < candidate.max) ?? DURATION_UNITS.at(-1)!;
    return `${Math.round(boundedMs / unit.divisor)}${unit.suffix}`;
  }

  function shortRef(value: string): string {
    return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
  }

  function stateClass(state: string): string {
    return STATE_CLASS_BY_STATE[state] ?? DEFAULT_STATE_CLASS;
  }

  function stringRecordProperty(record: HistoryRecord, key: string): string | undefined {
    const value = (record as unknown as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  function recordSummary(record: HistoryRecord): string {
    return stringRecordProperty(record, 'error')
      ?? stringRecordProperty(record, 'detail')
      ?? stringRecordProperty(record, 'reason')
      ?? 'No detail recorded.';
  }

  function outreachSummary(record: OutreachRecord): string {
    return record.error
      ?? record.reason
      ?? record.metadata?.skippedReason?.toString()
      ?? `content ${record.contentLength ?? 0} chars`;
  }

  onMount(() => {
    void loadStatus();
  });
</script>

<div class="space-y-8">
  <div class="flex items-start justify-between gap-4 flex-wrap">
    <div>
      <p class="text-xs uppercase tracking-[0.2em] text-shadow-500">Action Pipe</p>
      <h1 class="mt-1 text-2xl font-serif font-bold text-shadow-900">Action Pipe - Backstage Queue</h1>
      <p class="mt-1 max-w-3xl text-sm text-shadow-600">
        Live operator surface for post-turn work, autonomous actions, retries, quarantine, and bounded subagent outcomes.
      </p>
    </div>
    <button
      onclick={refreshStatus}
      disabled={refreshing}
      class="rounded-xl border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {refreshing ? 'Refreshing...' : 'Refresh'}
    </button>
  </div>

  {#if errorMessage}
    <div class="card-garden border-l-4 border-l-wilt-400 p-4">
      <p class="text-sm font-medium text-wilt-700">{errorMessage}</p>
    </div>
  {/if}

  {#if mutationMessage}
    <div class="card-garden border-l-4 {mutationOk ? 'border-l-leaf-400' : 'border-l-wilt-400'} p-4">
      <p class="text-sm font-medium {mutationOk ? 'text-leaf-700' : 'text-wilt-700'}">{mutationMessage}</p>
    </div>
  {/if}

  {#if loading}
    <div class="card-garden p-6 text-sm text-shadow-600">Loading action pipe status...</div>
  {:else if status}
    <section class="grid gap-4 md:grid-cols-4" aria-label="Action pipe overview">
      <div class="card-garden p-5">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Queue Depth</p>
        <p class="mt-3 text-4xl font-serif font-bold text-shadow-900">{status.queueDepth}</p>
        <p class="mt-2 text-sm text-shadow-600">{status.availableSlots} available of {status.maxQueueDepth} total slots.</p>
      </div>
      <div class="card-garden p-5">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Ready / Running</p>
        <p class="mt-3 text-4xl font-serif font-bold text-gold-600">{status.readyCount + status.runningCount}</p>
        <p class="mt-2 text-sm text-shadow-600">{status.readyCount} ready, {status.runningCount} running now.</p>
      </div>
      <div class="card-garden p-5">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Failures</p>
        <p class="mt-3 text-4xl font-serif font-bold text-wilt-600">{status.failures.failedCount}</p>
        <p class="mt-2 text-sm text-shadow-600">{status.failures.recentFailures.length} recent retained failure records.</p>
      </div>
      <div class="card-garden p-5">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Persistence</p>
        <p class="mt-3 text-2xl font-serif font-bold text-shadow-900">{status.persistence.loadState}</p>
        <p class="mt-2 text-sm text-shadow-600">{status.persistence.enabled ? 'Queue persistence enabled.' : 'Queue persistence not configured.'}</p>
      </div>
    </section>

    <section class="space-y-4" aria-labelledby="action-pipe-lanes-heading">
      <div>
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Runtime Lanes</p>
        <h2 id="action-pipe-lanes-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
          Lane pressure and back-pressure
        </h2>
      </div>
      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {#each lanes as lane (lane.runtimeClass)}
          <article class="card-garden p-4">
            <div class="flex items-start justify-between gap-3">
              <div>
                <h3 class="font-serif font-semibold text-shadow-900">{lane.runtimeClass}</h3>
                <p class="mt-1 text-xs uppercase tracking-[0.16em] text-shadow-500">{lane.chargeLane}</p>
              </div>
              <span class="rounded-full border px-2.5 py-1 text-xs font-semibold {lane.saturated ? 'border-wilt-300 bg-wilt-50 text-wilt-700' : 'border-leaf-300 bg-leaf-50 text-leaf-700'}">
                {lane.saturated ? 'saturated' : 'available'}
              </span>
            </div>
            <dl class="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div><dt class="text-shadow-500">Depth</dt><dd class="font-mono text-shadow-900">{lane.queueDepth}/{lane.maxQueuedActions}</dd></div>
              <div><dt class="text-shadow-500">Ready</dt><dd class="font-mono text-shadow-900">{lane.readyCount}</dd></div>
              <div><dt class="text-shadow-500">Retries</dt><dd class="font-mono text-shadow-900">{lane.retryScheduledCount}</dd></div>
              <div><dt class="text-shadow-500">Dropped</dt><dd class="font-mono text-shadow-900">{lane.droppedCount}</dd></div>
            </dl>
            {#if lane.nextRunAt}
              <p class="mt-3 text-xs text-shadow-500">Next run: {formatTime(lane.nextRunAt)}</p>
            {/if}
          </article>
        {/each}
      </div>
    </section>

    <section class="space-y-4" aria-labelledby="action-pipe-queued-heading">
      <div>
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Queue</p>
        <h2 id="action-pipe-queued-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
          Queued autonomous actions
        </h2>
        <p class="mt-1 text-sm text-shadow-600">
          Cancellable entries can be cancelled or acknowledged before execution. Running and historical entries are read-only.
        </p>
      </div>

      {#if queuedActions.length === 0}
        <div class="card-garden p-5 text-sm text-shadow-600">No queued post-turn actions.</div>
      {:else}
        <div class="space-y-3">
          {#each queuedActions as action (action.dedupeKey)}
            <article class="card-garden p-4">
              <div class="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <div class="flex items-center gap-2 flex-wrap">
                    <h3 class="font-serif font-semibold text-shadow-900">{action.actionKind}</h3>
                    <span class="rounded-full border px-2 py-0.5 text-xs font-semibold {stateClass(action.state)}">{action.state}</span>
                    <span class="rounded-full border border-bark-300 bg-bark-100 px-2 py-0.5 text-xs text-shadow-700">{action.runtimeClass}</span>
                    <span class="rounded-full border border-gold-300 bg-gold-50 px-2 py-0.5 text-xs text-gold-800">{action.capability}</span>
                  </div>
                  <p class="mt-2 font-mono text-xs text-shadow-500">{shortRef(action.actionId)} · {shortRef(action.dedupeKey)}</p>
                  {#if action.subagentSpawn}
                    <p class="mt-2 text-sm text-shadow-700">
                      Subagent request: {action.subagentSpawn.requestName ?? 'unnamed'} · max turns {action.subagentSpawn.requestedMaxTurns ?? action.subagentSpawn.budgetMaxTurns ?? '-'} · policy {action.subagentSpawn.policyMode ?? 'unknown'}
                    </p>
                  {/if}
                </div>
                <div class="flex items-center gap-2">
                  <button
                    type="button"
                    onclick={() => cancelAction(action)}
                    disabled={!action.cancellable || mutatingActionRef === action.actionId}
                    class="rounded-lg border border-wilt-300 px-3 py-1.5 text-sm font-medium text-wilt-700 transition-colors hover:bg-wilt-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onclick={() => acknowledgeAction(action)}
                    disabled={!action.cancellable || mutatingActionRef === action.actionId}
                    class="rounded-lg border border-bark-300 px-3 py-1.5 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Acknowledge
                  </button>
                </div>
              </div>
              <dl class="mt-4 grid gap-3 text-sm md:grid-cols-4">
                <div><dt class="text-shadow-500">Attempt</dt><dd class="font-mono text-shadow-900">{action.attempt}/{action.maxAttempts}</dd></div>
                <div><dt class="text-shadow-500">Queued for</dt><dd class="font-mono text-shadow-900">{formatDuration(action.queuedForMs)}</dd></div>
                <div><dt class="text-shadow-500">Runs in</dt><dd class="font-mono text-shadow-900">{formatDuration(action.runAfterMs)}</dd></div>
                <div><dt class="text-shadow-500">Next run</dt><dd class="font-mono text-shadow-900">{formatTime(action.nextRunAt)}</dd></div>
              </dl>
            </article>
          {/each}
        </div>
      {/if}
    </section>

    <section class="grid gap-4 xl:grid-cols-2" aria-label="Action pipe persistence and quarantine">
      <article class="card-garden p-5">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Persistence</p>
        <h2 class="mt-1 text-lg font-serif font-semibold text-shadow-900">Queue file state</h2>
        <dl class="mt-4 space-y-2 text-sm">
          <div class="flex justify-between gap-4"><dt class="text-shadow-500">Load state</dt><dd class="font-mono text-shadow-900">{status.persistence.loadState}</dd></div>
          <div class="flex justify-between gap-4"><dt class="text-shadow-500">Loaded entries</dt><dd class="font-mono text-shadow-900">{status.persistence.loadedEntries}</dd></div>
          <div class="flex justify-between gap-4"><dt class="text-shadow-500">Quarantined entries</dt><dd class="font-mono text-shadow-900">{status.persistence.quarantinedEntries}</dd></div>
          <div class="flex justify-between gap-4"><dt class="text-shadow-500">Last persisted</dt><dd class="font-mono text-shadow-900">{formatTime(status.persistence.lastPersistedAt)}</dd></div>
        </dl>
        {#if status.persistence.path}
          <p class="mt-4 break-all rounded-lg border border-bark-200 bg-bark-50 p-3 font-mono text-xs text-shadow-600">{status.persistence.path}</p>
        {/if}
        {#if status.persistence.lastLoadError || status.persistence.lastPersistError}
          <p class="mt-3 text-sm text-wilt-700">{status.persistence.lastLoadError ?? status.persistence.lastPersistError}</p>
        {/if}
      </article>

      <article class="card-garden p-5">
        <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Quarantine</p>
        <h2 class="mt-1 text-lg font-serif font-semibold text-shadow-900">Invalid persisted entries</h2>
        <p class="mt-2 text-sm text-shadow-600">
          {status.quarantine.count} entries quarantined; sidecar persisted: {status.quarantine.persisted ? 'yes' : 'no'}.
        </p>
        {#if status.quarantine.entries.length > 0}
          <div class="mt-4 space-y-2">
            {#each status.quarantine.entries as entry}
              <div class="rounded-lg border border-wilt-200 bg-wilt-50 p-3">
                <p class="text-sm font-medium text-wilt-700">Entry {entry.entryNumber}: {entry.error}</p>
                <pre class="mt-2 max-h-40 overflow-auto text-xs text-shadow-700">{JSON.stringify(entry.raw, null, 2)}</pre>
              </div>
            {/each}
          </div>
        {:else}
          <p class="mt-4 text-sm text-shadow-600">No quarantined queue entries.</p>
        {/if}
      </article>
    </section>

    <section class="space-y-4" aria-labelledby="action-pipe-outreach-heading">
      <div>
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Outreach</p>
        <h2 id="action-pipe-outreach-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
          Proactive outbound ledger
        </h2>
      </div>
      {#if outreachRecords.length === 0}
        <div class="card-garden p-5 text-sm text-shadow-600">No recent outreach outbox records.</div>
      {:else}
        <div class="grid gap-4 xl:grid-cols-2">
          {#each outreachRecords.slice(0, 10) as record}
            <article class="card-garden p-4">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <h3 class="font-serif font-semibold text-shadow-900">{record.channelType} · {shortRef(record.channelId)}</h3>
                  <p class="mt-1 font-mono text-xs text-shadow-500">{shortRef(record.actionId)} · {shortRef(record.dedupeKey)}</p>
                </div>
                <span class="rounded-full border px-2.5 py-1 text-xs font-semibold {stateClass(record.phase)}">{record.phase}</span>
              </div>
              <p class="mt-3 text-sm text-shadow-700">{outreachSummary(record)}</p>
              <dl class="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div><dt class="text-shadow-500">Recorded</dt><dd class="font-mono text-shadow-900">{formatTime(record.recordedAt)}</dd></div>
                <div><dt class="text-shadow-500">Source</dt><dd class="font-mono text-shadow-900">{shortRef(record.sourceMessageId)}</dd></div>
                {#if record.runAt}
                  <div><dt class="text-shadow-500">Run at</dt><dd class="font-mono text-shadow-900">{formatTime(record.runAt)}</dd></div>
                {/if}
                {#if record.contentHash}
                  <div><dt class="text-shadow-500">Content hash</dt><dd class="font-mono text-shadow-900">{shortRef(record.contentHash)}</dd></div>
                {/if}
              </dl>
            </article>
          {/each}
        </div>
      {/if}
    </section>

    <section class="space-y-4" aria-labelledby="action-pipe-history-heading">
      <div>
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Recent History</p>
        <h2 id="action-pipe-history-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
          Failures, drops, operator actions, and completions
        </h2>
      </div>
      <div class="grid gap-4 xl:grid-cols-2">
        {#each historyPanels as panel (panel.title)}
          <article class="card-garden p-5">
            <h3 class="font-serif font-semibold text-shadow-900">{panel.title}</h3>
            {#if panel.records.length === 0}
              <p class="mt-3 text-sm text-shadow-600">{panel.empty}</p>
            {:else}
              <div class="mt-4 space-y-3">
                {#each panel.records.slice(0, 8) as record}
                  <div class="rounded-xl border border-bark-200 bg-bark-50 p-3">
                    <div class="flex items-start justify-between gap-3">
                      <div>
                        <p class="font-mono text-xs text-shadow-500">{shortRef(record.actionId)} · {record.actionKind}</p>
                        <p class="mt-1 text-sm text-shadow-800">{recordSummary(record)}</p>
                      </div>
                      <span class="rounded-full border border-bark-300 bg-bark-100 px-2 py-0.5 text-xs text-shadow-700">
                        {record.runtimeClass}
                      </span>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </article>
        {/each}
      </div>
    </section>

    <section class="space-y-4" aria-labelledby="action-pipe-subagents-heading">
      <div>
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Subagents</p>
        <h2 id="action-pipe-subagents-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
          Spawned-agent outcomes
        </h2>
      </div>
      {#if subagentOutcomes.length === 0}
        <div class="card-garden p-5 text-sm text-shadow-600">No completed subagent spawn actions in recent history.</div>
      {:else}
        <div class="grid gap-4 xl:grid-cols-2">
          {#each subagentOutcomes as outcome (outcome.dedupeKey)}
            {@const spawn = outcome.subagentSpawn}
            {#if spawn}
              <article class="card-garden p-5">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <h3 class="font-serif font-semibold text-shadow-900">{spawn.name}</h3>
                    <p class="mt-1 font-mono text-xs text-shadow-500">{shortRef(spawn.subagentId)}</p>
                  </div>
                  <span class="rounded-full border px-2.5 py-1 text-xs font-semibold {stateClass(spawn.health)}">{spawn.health}</span>
                </div>
                <p class="mt-3 text-sm text-shadow-700">{spawn.stateReason}</p>
                {#if spawn.failureReason}
                  <p class="mt-2 text-sm text-wilt-700">{spawn.failureReason}</p>
                {/if}
                <dl class="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                  <div><dt class="text-shadow-500">Lifecycle</dt><dd class="font-mono text-shadow-900">{spawn.lifecycleState}</dd></div>
                  <div><dt class="text-shadow-500">Model</dt><dd class="font-mono text-shadow-900">{spawn.model}</dd></div>
                  <div><dt class="text-shadow-500">Turns</dt><dd class="font-mono text-shadow-900">{spawn.turns}</dd></div>
                  <div><dt class="text-shadow-500">Duration</dt><dd class="font-mono text-shadow-900">{formatDuration(spawn.durationMs)}</dd></div>
                </dl>
              </article>
            {/if}
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>
