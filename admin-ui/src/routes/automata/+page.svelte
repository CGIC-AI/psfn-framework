<script lang="ts">
  import { onMount } from 'svelte';

  import AutomataLessonsPanel from '$lib/components/automata/AutomataLessonsPanel.svelte';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import {
    getAutomataSnapshot,
    reindexAutomataBus,
    resolveAutomataPageState,
    type AutomataQuery,
    type AutomataRunStatus,
    type AutomataSnapshot,
    type AutomataVerificationStatus,
  } from '$lib/api/endpoints/automata';

  const RUN_STATUSES: Array<{ value: AutomataRunStatus | ''; label: string }> = [
    { value: '', label: 'All run states' },
    { value: 'queued', label: 'Queued' },
    { value: 'running', label: 'Running' },
    { value: 'completed', label: 'Completed' },
    { value: 'failed', label: 'Failed' },
    { value: 'cancelled', label: 'Cancelled' },
  ];
  const VERIFICATION_STATUSES: Array<{ value: AutomataVerificationStatus | ''; label: string }> = [
    { value: '', label: 'All verification states' },
    { value: 'pending', label: 'Pending' },
    { value: 'verified', label: 'Verified' },
    { value: 'rejected', label: 'Rejected' },
  ];

  let snapshot = $state<AutomataSnapshot | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let error = $state('');
  let lastLoadedAt = $state<number | null>(null);
  let requestSequence = 0;
  let reindexing = $state(false);
  let reindexMessage = $state('');

  let classId = $state('');
  let taskId = $state('');
  let runStatus = $state<AutomataRunStatus | ''>('');
  let busRunId = $state('');
  let eventId = $state('');
  let verificationStatus = $state<AutomataVerificationStatus | ''>('');
  let runOffset = $state(0);
  let busOffset = $state(0);

  const pageState = $derived(resolveAutomataPageState({ loading, error, snapshot }));

  function query(): AutomataQuery {
    return {
      ...(classId ? { classId, busClassId: classId } : {}),
      ...(taskId.trim() ? { taskId: taskId.trim(), busTaskId: taskId.trim() } : {}),
      ...(runStatus ? { status: runStatus } : {}),
      ...(busRunId.trim() ? { busRunId: busRunId.trim() } : {}),
      ...(eventId.trim() ? { eventId: eventId.trim() } : {}),
      ...(verificationStatus ? { verificationStatus } : {}),
      runOffset,
      busOffset,
    };
  }

  async function loadData(mode: 'initial' | 'refresh' = 'initial'): Promise<void> {
    const sequence = ++requestSequence;
    if (mode === 'initial') loading = true;
    else refreshing = true;
    error = '';
    try {
      const result = await getAutomataSnapshot(query());
      if (sequence !== requestSequence) return;
      snapshot = result;
      lastLoadedAt = Date.now();
    } catch (cause) {
      if (sequence !== requestSequence) return;
      error = cause instanceof Error ? cause.message : 'Failed to load Automata data.';
    } finally {
      if (sequence !== requestSequence) return;
      loading = false;
      refreshing = false;
    }
  }

  function applyFilters(): void {
    runOffset = 0;
    busOffset = 0;
    void loadData('refresh');
  }

  function clearFilters(): void {
    classId = '';
    taskId = '';
    runStatus = '';
    busRunId = '';
    eventId = '';
    verificationStatus = '';
    applyFilters();
  }

  function moveRuns(direction: -1 | 1): void {
    const pageLimit = snapshot?.runPage.limit ?? 0;
    runOffset = Math.max(0, runOffset + direction * pageLimit);
    void loadData('refresh');
  }

  function moveBus(direction: -1 | 1): void {
    const pageLimit = snapshot?.bus.page.limit ?? 0;
    busOffset = Math.max(0, busOffset + direction * pageLimit);
    void loadData('refresh');
  }

  async function runReindex(): Promise<void> {
    reindexing = true;
    reindexMessage = '';
    try {
      const result = await reindexAutomataBus();
      reindexMessage = `Reindexed ${result.indexed} of ${result.processed} current findings.`;
      await loadData('refresh');
    } catch (cause) {
      reindexMessage = cause instanceof Error ? cause.message : 'Automata Bus reindex failed.';
    } finally {
      reindexing = false;
    }
  }

  function formatDate(value: string | number | null | undefined): string {
    if (value === null || value === undefined) return 'Never';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
  }

  function formatDuration(milliseconds: number): string {
    if (milliseconds < 60_000) return `${Math.round(milliseconds / 1_000)}s`;
    if (milliseconds < 3_600_000) return `${Math.round(milliseconds / 60_000)}m`;
    if (milliseconds < 86_400_000) return `${Math.round(milliseconds / 3_600_000)}h`;
    return `${Math.round(milliseconds / 86_400_000)}d`;
  }

  onMount(() => {
    void loadData();
  });
</script>

<div class="garden-page space-y-5">
  <GardenPageHeader
    eyebrow="Operations · Durable workers"
    title="Automata"
    description="Registry, retained runs, content-safe Bus state, and review-only recurrent lesson proposals for the selected companion."
  >
    {#snippet actions()}
      <button
        type="button"
        class="garden-action"
        onclick={() => loadData('refresh')}
        disabled={loading || refreshing}
      >
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    {/snippet}
  </GardenPageHeader>

  {#if pageState === 'loading'}
    <section class="garden-loading card-garden p-10 text-center" aria-live="polite">
      <div class="mx-auto mb-3 h-8 w-8 animate-pulse rounded-full bg-bark-200"></div>
      <p class="text-sm text-shadow-600">Loading the Automata registry and Bus monitor…</p>
    </section>
  {:else if pageState === 'error'}
    <section class="garden-error card-garden border-l-4 border-l-wilt-400 p-6" role="alert">
      <h2 class="font-semibold text-shadow-900">Automata data could not be loaded</h2>
      <p class="mt-1 text-sm text-shadow-600">{error}</p>
      <button type="button" class="garden-action mt-4" onclick={() => loadData()}>Try again</button>
    </section>
  {:else if snapshot}
    {#if error}
      <section class="garden-error card-garden border-l-4 border-l-wilt-400 p-4" role="alert">
        <p class="text-sm text-shadow-700">Refresh failed; the data below is from {formatDate(lastLoadedAt)}. {error}</p>
      </section>
    {/if}

    <section class="garden-toolbar card-garden p-4" aria-label="Automata filters">
      <div class="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <label class="text-xs font-medium text-shadow-600">
          Class
          <select class="mt-1 w-full rounded-lg border border-bark-300 bg-surface px-2 py-2 text-sm" bind:value={classId}>
            <option value="">All classes</option>
            {#each snapshot.classes as entry (entry.id)}
              <option value={entry.id}>{entry.id}</option>
            {/each}
          </select>
        </label>
        <label class="text-xs font-medium text-shadow-600">
          Run status
          <select class="mt-1 w-full rounded-lg border border-bark-300 bg-surface px-2 py-2 text-sm" bind:value={runStatus}>
            {#each RUN_STATUSES as status}
              <option value={status.value}>{status.label}</option>
            {/each}
          </select>
        </label>
        <label class="text-xs font-medium text-shadow-600">
          Task ID
          <input class="mt-1 w-full rounded-lg border border-bark-300 bg-surface px-2 py-2 text-sm" bind:value={taskId} placeholder="Exact task ID" />
        </label>
        <label class="text-xs font-medium text-shadow-600">
          Bus run ID
          <input class="mt-1 w-full rounded-lg border border-bark-300 bg-surface px-2 py-2 text-sm" bind:value={busRunId} placeholder="Exact run ID" />
        </label>
        <label class="text-xs font-medium text-shadow-600">
          Bus event ID
          <input class="mt-1 w-full rounded-lg border border-bark-300 bg-surface px-2 py-2 text-sm" bind:value={eventId} placeholder="Exact event ID" />
        </label>
        <label class="text-xs font-medium text-shadow-600">
          Verification
          <select class="mt-1 w-full rounded-lg border border-bark-300 bg-surface px-2 py-2 text-sm" bind:value={verificationStatus}>
            {#each VERIFICATION_STATUSES as status}
              <option value={status.value}>{status.label}</option>
            {/each}
          </select>
        </label>
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" class="garden-action garden-action--primary" onclick={applyFilters}>Apply filters</button>
        <button type="button" class="garden-action" onclick={clearFilters}>Clear</button>
        <span class="ml-auto text-xs text-shadow-500">Last loaded {formatDate(lastLoadedAt)}</span>
      </div>
    </section>

    <section class="garden-section card-garden p-5" aria-labelledby="bus-health-heading">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p class="page-kicker">Automata Bus</p>
          <h2 id="bus-health-heading" class="text-lg font-semibold text-shadow-900">Health and freshness</h2>
        </div>
        <div class="flex gap-2">
          {#if snapshot.bus.health.reindexState !== 'current' || snapshot.bus.health.indexState !== 'ready'}
            <button
              type="button"
              class="garden-action garden-action--primary"
              onclick={runReindex}
              disabled={reindexing || refreshing}
            >
              {reindexing ? 'Reindexing…' : 'Rebuild this companion index'}
            </button>
          {/if}
          <span class="rounded-full bg-bark-100 px-2.5 py-1 text-xs font-semibold uppercase text-shadow-700">
            {snapshot.bus.health.condition}
          </span>
          <span class="rounded-full bg-bark-100 px-2.5 py-1 text-xs font-semibold uppercase text-shadow-700">
            {snapshot.bus.health.freshness}
          </span>
        </div>
      </div>

      {#if !snapshot.bus.available}
        <div class="garden-empty mt-4 border-l-4 border-l-gold-400 p-4">
          <p class="font-medium text-shadow-800">Bus reads are unavailable</p>
          <p class="mt-1 text-sm text-shadow-600">The durable run registry remains available. No empty or healthy Bus state is being inferred.</p>
        </div>
      {:else if snapshot.bus.health.freshness === 'stale'}
        <div class="mt-4 border-l-4 border-l-gold-400 bg-gold-50 p-4 text-sm text-shadow-700">
          Bus data is stale. The most recent visible event was {formatDate(snapshot.bus.health.lastEventAt)}.
        </div>
      {:else if snapshot.bus.health.condition === 'degraded'}
        <div class="mt-4 border-l-4 border-l-gold-400 bg-gold-50 p-4 text-sm text-shadow-700">
          Bus reads are degraded: {snapshot.bus.health.degradationReasons.join(', ') || 'unspecified degradation'}.
        </div>
      {/if}

      <dl class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div class="garden-metric p-3"><dt>Index</dt><dd>{snapshot.bus.health.indexState}</dd></div>
        <div class="garden-metric p-3"><dt>Reindex</dt><dd>{snapshot.bus.health.reindexState}</dd></div>
        <div class="garden-metric p-3"><dt>Pending index work</dt><dd>{snapshot.bus.health.pendingIndexCount}</dd></div>
        <div class="garden-metric p-3"><dt>Observed</dt><dd class="text-sm">{formatDate(snapshot.bus.health.observedAt)}</dd></div>
      </dl>
      {#if reindexMessage}
        <p class="mt-3 text-sm text-shadow-700" role="status">{reindexMessage}</p>
      {/if}
    </section>

    <section class="garden-section card-garden p-5" aria-labelledby="classes-heading">
      <div class="flex items-end justify-between gap-3">
        <div>
          <p class="page-kicker">Production manifest</p>
          <h2 id="classes-heading" class="text-lg font-semibold text-shadow-900">Automata classes</h2>
        </div>
        <span class="text-sm text-shadow-500">{snapshot.classes.length} registered</span>
      </div>
      {#if snapshot.classes.length === 0}
        <div class="garden-empty mt-4 p-5 text-sm text-shadow-600">No production Automata classes are registered.</div>
      {:else}
        <div class="garden-table-shell mt-4">
          <div class="garden-table-scroll">
            <table class="garden-table">
              <thead><tr><th>Class</th><th>Kind</th><th>Bus</th><th>Concurrency</th><th>Failure</th><th>Retention</th></tr></thead>
              <tbody>
                {#each snapshot.classes as entry (entry.id)}
                  <tr>
                    <td class="font-mono text-xs">{entry.id}</td>
                    <td>{entry.workerKind}</td>
                    <td>{entry.busEligibility}</td>
                    <td>{entry.concurrencyClass}</td>
                    <td>{entry.failureClass}</td>
                    <td>{formatDuration(entry.retentionMs)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      {/if}
    </section>

    <section class="garden-section card-garden p-5" aria-labelledby="runs-heading">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p class="page-kicker">Durable registry</p>
          <h2 id="runs-heading" class="text-lg font-semibold text-shadow-900">Active and recent runs</h2>
        </div>
        <div class="flex items-center gap-2">
          <button type="button" class="garden-action" disabled={runOffset === 0 || refreshing} onclick={() => moveRuns(-1)}>Previous</button>
          <span class="text-xs text-shadow-500">{runOffset + 1}–{runOffset + snapshot.runs.length}</span>
          <button type="button" class="garden-action" disabled={!snapshot.runPage.hasMore || refreshing} onclick={() => moveRuns(1)}>Next</button>
        </div>
      </div>
      {#if snapshot.runs.length === 0}
        <div class="garden-empty mt-4 p-5 text-sm text-shadow-600">No retained runs match these filters.</div>
      {:else}
        <div class="garden-table-shell mt-4">
          <div class="garden-table-scroll">
            <table class="garden-table">
              <thead><tr><th>Run / task</th><th>Class / trigger</th><th>Status / outcome</th><th>Lineage</th><th>Custody</th><th>Retention</th></tr></thead>
              <tbody>
                {#each snapshot.runs as run (run.runId)}
                  <tr>
                    <td>
                      <div class="font-mono text-xs">{run.runId}</div>
                      <div class="mt-1 text-sm text-shadow-700">{run.taskLabel}</div>
                      <div class="font-mono text-xs text-shadow-500">{run.taskId}</div>
                    </td>
                    <td>
                      <div class="font-mono text-xs">{run.automatonClass}</div>
                      <div class="mt-1 text-xs text-shadow-500">{run.trigger}</div>
                      <div class="mt-1 text-xs">Bus: {run.busEligibility}</div>
                    </td>
                    <td>
                      <span class="rounded-full bg-bark-100 px-2 py-1 text-xs font-medium">{run.status}</span>
                      <div class="mt-2 text-xs text-shadow-500">{run.outcome ?? 'No terminal outcome'}</div>
                      <div class="mt-1 text-xs text-shadow-500">{run.statusReason}</div>
                    </td>
                    <td>
                      <div class="text-xs">Worker {run.workerId} · gen {run.workerGeneration}</div>
                      <div class="mt-1 font-mono text-xs">Parent: {run.parentRunId ?? 'None'}</div>
                      <div class="font-mono text-xs">Source: {run.sourceRunId ?? 'None'}</div>
                      {#if run.sessionIds.length === 0}
                        <span class="mt-1 block text-shadow-400">No sessions</span>
                      {:else}
                        {#each run.sessionIds as sessionId}
                          <div class="font-mono text-xs">{sessionId}</div>
                        {/each}
                      {/if}
                    </td>
                    <td>
                      <div>{run.artifactCount} artifacts ({run.artifactCustody.durable} durable)</div>
                      <div class="mt-1 text-xs text-shadow-500">Promotion: {run.promotionState}</div>
                      <div class="text-xs text-shadow-500">Fold: {run.foldState}</div>
                    </td>
                    <td>
                      <div>{run.retentionState}</div>
                      <div class="mt-1 text-xs text-shadow-500">{formatDate(run.retentionDeadlineMs)}</div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      {/if}
    </section>

    <div class="grid gap-5 xl:grid-cols-2">
      <section class="garden-section card-garden p-5" aria-labelledby="findings-heading">
        <div class="flex items-end justify-between gap-3">
          <div>
            <p class="page-kicker">Reduced state</p>
            <h2 id="findings-heading" class="text-lg font-semibold text-shadow-900">Current findings</h2>
          </div>
          <span class="text-sm text-shadow-500">{snapshot.bus.currentFindings.length} visible</span>
        </div>
        {#if !snapshot.bus.available}
          <div class="garden-empty mt-4 p-5 text-sm text-shadow-600">Current state is unavailable while the Bus read port is offline.</div>
        {:else if snapshot.bus.currentFindings.length === 0}
          <div class="garden-empty mt-4 p-5 text-sm text-shadow-600">No current findings match these filters.</div>
        {:else}
          <div class="mt-4 space-y-3">
            {#each snapshot.bus.currentFindings as finding (finding.eventId)}
              <article class="rounded-xl border border-bark-200 p-4">
                <div class="flex flex-wrap justify-between gap-2 text-xs text-shadow-500">
                  <span class="font-mono">{finding.eventId}</span>
                  <span>{formatDate(finding.occurredAt)}</span>
                </div>
                <p class="mt-2 text-sm text-shadow-800">{finding.finding.claim}</p>
                <div class="mt-3 flex flex-wrap gap-2 text-xs">
                  <span class="rounded bg-bark-100 px-2 py-1">{finding.finding.provenance}</span>
                  <span class="rounded bg-bark-100 px-2 py-1">{finding.finding.verificationStatus}</span>
                  <span class="rounded bg-bark-100 px-2 py-1">{finding.context.automatonClass}</span>
                </div>
                {#if finding.finding.evidence.length > 0}
                  <details class="mt-3 text-sm">
                    <summary class="cursor-pointer text-shadow-600">Evidence metadata ({finding.finding.evidence.length})</summary>
                    <ul class="mt-2 space-y-2">
                      {#each finding.finding.evidence as evidence (evidence.referenceDigest)}
                        <li class="rounded bg-bark-50 p-2">
                          <div>{evidence.kind} · {evidence.summary}</div>
                          <div class="mt-1 break-all font-mono text-xs text-shadow-500">{evidence.referenceDigest}</div>
                        </li>
                      {/each}
                    </ul>
                  </details>
                {/if}
              </article>
            {/each}
          </div>
        {/if}
      </section>

      <section class="garden-section card-garden p-5" aria-labelledby="events-heading">
        <div class="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p class="page-kicker">Immutable history</p>
            <h2 id="events-heading" class="text-lg font-semibold text-shadow-900">Events and corrections</h2>
          </div>
          <div class="flex items-center gap-2">
            <button type="button" class="garden-action" disabled={busOffset === 0 || refreshing} onclick={() => moveBus(-1)}>Previous</button>
            <button type="button" class="garden-action" disabled={!snapshot.bus.page.hasMore || refreshing} onclick={() => moveBus(1)}>Next</button>
          </div>
        </div>
        {#if !snapshot.bus.available}
          <div class="garden-empty mt-4 p-5 text-sm text-shadow-600">Event history is unavailable while the Bus read port is offline.</div>
        {:else if snapshot.bus.events.length === 0}
          <div class="garden-empty mt-4 p-5 text-sm text-shadow-600">No Bus events match these filters.</div>
        {:else}
          <ol class="mt-4 space-y-3">
            {#each snapshot.bus.events as event (event.eventId)}
              <li class="rounded-xl border border-bark-200 p-4">
                <div class="flex flex-wrap justify-between gap-2 text-xs text-shadow-500">
                  <span>#{event.sequence} · {event.type}</span>
                  <span>{formatDate(event.occurredAt)}</span>
                </div>
                <div class="mt-2 break-all font-mono text-xs">{event.eventId}</div>
                <div class="mt-2 text-xs text-shadow-600">
                  {event.context.automatonClass} · run {event.context.runId} · task {event.context.taskId}
                </div>
                {#if event.finding}
                  <p class="mt-2 text-sm text-shadow-800">{event.finding.claim}</p>
                  <p class="mt-2 text-xs text-shadow-500">{event.finding.provenance} · {event.finding.verificationStatus}</p>
                {:else if event.relation}
                  <p class="mt-2 text-sm text-shadow-800">
                    {event.relation.kind} <span class="font-mono text-xs">{event.relation.targetEventId}</span>: {event.relation.reason}
                  </p>
                {/if}
              </li>
            {/each}
          </ol>
        {/if}

        {#if snapshot.bus.correctionHistory.length > 0}
          <div class="mt-5 border-t border-bark-200 pt-4">
            <h3 class="text-sm font-semibold text-shadow-800">Correction history</h3>
            <ul class="mt-2 space-y-1 text-xs text-shadow-600">
              {#each snapshot.bus.correctionHistory as correction (correction.byEventId)}
                <li><span class="font-medium">{correction.relation}</span> {correction.targetEventId} via {correction.byEventId}</li>
              {/each}
            </ul>
          </div>
        {/if}
      </section>
    </div>

    <AutomataLessonsPanel lessons={snapshot.lessons} />

    <section class="garden-section card-garden p-5" aria-labelledby="extensions-heading">
      <p class="page-kicker">Extension seam</p>
      <h2 id="extensions-heading" class="text-lg font-semibold text-shadow-900">Management panels</h2>
      {#if snapshot.extensions.managementPanels.length === 0}
        <div class="garden-empty mt-4 p-4 text-sm text-shadow-600">No management extensions are installed. This surface is read-only.</div>
      {:else}
        <ul class="mt-4 grid gap-3 md:grid-cols-2">
          {#each snapshot.extensions.managementPanels as panel (panel.id)}
            <li class="rounded-xl border border-bark-200 p-4">
              <div class="font-medium text-shadow-800">{panel.label}</div>
              <p class="mt-1 text-sm text-shadow-600">{panel.description}</p>
              <span class="mt-2 inline-block text-xs uppercase text-shadow-500">{panel.mode.replace('_', ' ')}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>
