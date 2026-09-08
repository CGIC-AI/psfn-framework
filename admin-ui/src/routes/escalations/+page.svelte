<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import {
    getHumanEscalations,
    resolveHumanEscalation,
  } from '$lib/api/endpoints/human-escalations';
  import { createVisibilityAwarePoller } from '$lib/polling/visibility-aware-poller';
  import type {
    HumanEscalationRecord,
    HumanEscalationResolutionReason,
    HumanEscalationResolutionState,
    HumanEscalationSnapshot,
  } from '$lib/types';

  // ── State ──
  let snapshot = $state<HumanEscalationSnapshot | null>(null);
  let loading = $state(true);
  let error = $state('');
  let unavailable = $state(false);
  let scope = $state<'open' | 'all'>('open');
  let busyId = $state<string | null>(null);
  let actionError = $state('');
  // Per-row operator intent. Nothing is submitted until Record is pressed, so a
  // misclick on a dropdown never resolves an escalation.
  let draftState = $state<Record<string, HumanEscalationResolutionState>>({});
  let draftReason = $state<Record<string, HumanEscalationResolutionReason>>({});

  const RESOLUTION_STATES: HumanEscalationResolutionState[] = [
    'acknowledged',
    'resolved',
    'dismissed',
  ];
  const RESOLUTION_REASONS: HumanEscalationResolutionReason[] = [
    'handled',
    'mitigated',
    'investigating',
    'not_actionable',
    'duplicate',
    'expected',
  ];

  const SEVERITY_BADGE: Record<string, string> = {
    info: 'bg-bark-100 text-shadow-600',
    warning: 'bg-gold-100 text-gold-700',
    degraded: 'bg-gold-100 text-gold-700',
    critical: 'bg-wilt-100 text-wilt-600',
  };

  const escalations = $derived(snapshot?.escalations ?? []);

  function severityBadge(severity: string): string {
    return SEVERITY_BADGE[severity] ?? 'bg-bark-100 text-shadow-600';
  }

  function ownerLabel(owner: HumanEscalationRecord['owner']): string {
    return owner.kind === 'companion' ? `companion ${owner.companionId}` : 'system';
  }

  function formatClock(ts: number | null): string {
    if (ts === null || !Number.isFinite(ts)) return '--';
    return new Date(ts).toLocaleString();
  }

  function evidenceEntries(
    evidence: HumanEscalationRecord['evidence'],
  ): Array<[string, string]> {
    return Object.entries(evidence)
      .filter((entry): entry is [string, number | boolean] => entry[1] !== undefined)
      .map(([key, value]) => [key, String(value)]);
  }

  function selectedState(id: string): HumanEscalationResolutionState {
    return draftState[id] ?? 'acknowledged';
  }

  function selectedReason(id: string): HumanEscalationResolutionReason {
    return draftReason[id] ?? 'handled';
  }

  async function loadData() {
    loading = true;
    error = '';
    unavailable = false;
    try {
      snapshot = await getHumanEscalations(scope);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load escalations';
      if (message.includes('503')) {
        unavailable = true;
      } else {
        error = message;
      }
    } finally {
      loading = false;
    }
  }

  async function setScope(next: 'open' | 'all') {
    scope = next;
    await loadData();
  }

  async function record(escalation: HumanEscalationRecord) {
    actionError = '';
    busyId = escalation.escalationId;
    try {
      await resolveHumanEscalation(escalation.escalationId, {
        state: selectedState(escalation.escalationId),
        reason: selectedReason(escalation.escalationId),
      });
      await loadData();
    } catch (e) {
      actionError = e instanceof Error ? e.message : 'Failed to record the resolution';
    } finally {
      busyId = null;
    }
  }

  const poller = createVisibilityAwarePoller({
    refresh: loadData,
    intervalMs: 15_000,
  });

  onMount(() => {
    poller.start();
  });

  onDestroy(() => {
    poller.stop();
  });
</script>

<div class="garden-page space-y-5">
  <GardenPageHeader
    eyebrow="Operations · Human in the loop"
    title="Escalations"
    description="Everything this runtime is waiting on a person for, on one governed ledger. Recording a decision here is a record, not an execution: specialised workflows are still answered on their own page."
  >
    {#snippet actions()}
      <div class="flex items-center gap-2">
        <button
          onclick={() => setScope('open')}
          class="rounded-md border border-bark-200 px-3 py-1.5 text-sm {scope === 'open' ? 'bg-bark-100 font-medium' : ''}"
        >Open</button>
        <button
          onclick={() => setScope('all')}
          class="rounded-md border border-bark-200 px-3 py-1.5 text-sm {scope === 'all' ? 'bg-bark-100 font-medium' : ''}"
        >All</button>
        <button
          onclick={loadData}
          class="rounded-md border border-bark-200 px-3 py-1.5 text-sm"
        >Refresh</button>
      </div>
    {/snippet}
  </GardenPageHeader>

  {#if unavailable}
    <p class="rounded-md border border-gold-300 bg-gold-50 p-4 text-sm text-gold-800">
      The escalation ledger is unavailable. Nothing is being hidden — this page cannot read the
      durable ledger right now, so it shows no escalations rather than an empty queue.
    </p>
  {:else if error}
    <p class="rounded-md border border-wilt-300 bg-wilt-50 p-4 text-sm text-wilt-700">{error}</p>
  {:else if loading && !snapshot}
    <p class="text-sm text-shadow-500">Loading escalations…</p>
  {:else if snapshot}
    <div class="flex flex-wrap gap-3 text-sm text-shadow-600">
      <span>Open: <strong>{snapshot.counts.open}</strong></span>
      <span>Acknowledged: <strong>{snapshot.counts.acknowledged}</strong></span>
      <span>Resolved: <strong>{snapshot.counts.resolved}</strong></span>
      <span>Dismissed: <strong>{snapshot.counts.dismissed}</strong></span>
      <span class="text-shadow-400">
        Ledger scope: {ownerLabel(snapshot.scope.owner)} · {snapshot.scope.process} process · {snapshot.scope.ledgers.join(" + ")}
      </span>
    </div>

    {#if actionError}
      <p class="rounded-md border border-wilt-300 bg-wilt-50 p-3 text-sm text-wilt-700">
        {actionError}
      </p>
    {/if}

    {#if escalations.length === 0}
      <p class="rounded-md border border-bark-200 bg-bark-50 p-4 text-sm text-shadow-500">
        Nothing is waiting on a person.
      </p>
    {:else}
      <ul class="space-y-3">
        {#each escalations as escalation (escalation.escalationId)}
          <li class="rounded-md border border-bark-200 bg-white p-4">
            <div class="flex flex-wrap items-baseline gap-2">
              <span class="rounded px-2 py-0.5 text-xs font-medium {severityBadge(escalation.severity)}">
                {escalation.severity}
              </span>
              <span class="font-medium">{escalation.kind}</span>
              <span class="text-xs text-shadow-400">{escalation.escalationId}</span>
            </div>
            <dl class="mt-2 grid gap-x-6 gap-y-1 text-sm text-shadow-600 sm:grid-cols-2">
              <div><dt class="inline text-shadow-400">Owner:</dt> <dd class="inline">{ownerLabel(escalation.owner)}</dd></div>
              <div><dt class="inline text-shadow-400">State:</dt> <dd class="inline">{escalation.state}</dd></div>
              <div><dt class="inline text-shadow-400">First raised:</dt> <dd class="inline">{formatClock(escalation.raisedAtMs)}</dd></div>
              <div><dt class="inline text-shadow-400">Last raised:</dt> <dd class="inline">{formatClock(escalation.lastRaisedAtMs)}</dd></div>
              <div><dt class="inline text-shadow-400">Raises:</dt> <dd class="inline">{escalation.raiseCount}</dd></div>
              <div><dt class="inline text-shadow-400">Last notified:</dt> <dd class="inline">{formatClock(escalation.lastNotifiedAtMs)}</dd></div>
            </dl>
            {#if escalation.labels.length > 0}
              <p class="mt-2 text-sm text-shadow-600">
                <span class="text-shadow-400">Labels:</span> {escalation.labels.join(', ')}
              </p>
            {/if}
            {#if evidenceEntries(escalation.evidence).length > 0}
              <p class="mt-1 text-sm text-shadow-600">
                <span class="text-shadow-400">Evidence:</span>
                {evidenceEntries(escalation.evidence).map(([k, v]) => `${k}=${v}`).join(', ')}
              </p>
            {/if}
            <p class="mt-2 text-sm">
              <a href={escalation.detailPath} class="text-gold-700 underline-offset-2 hover:underline">
                Open the workflow that raised this →
              </a>
            </p>

            {#if escalation.resolution}
              <p class="mt-3 rounded bg-bark-50 p-2 text-sm text-shadow-600">
                {escalation.resolution.state} · {escalation.resolution.reason} ·
                recorded by {escalation.resolution.actor} at
                {formatClock(escalation.resolution.resolvedAtMs)}
              </p>
            {/if}

            {#if escalation.state !== 'resolved' && escalation.state !== 'dismissed'}
              <div class="mt-3 flex flex-wrap items-center gap-2">
                <label class="text-sm text-shadow-500" for={`state-${escalation.escalationId}`}>
                  Record
                </label>
                <select
                  id={`state-${escalation.escalationId}`}
                  class="rounded border border-bark-200 px-2 py-1 text-sm"
                  value={selectedState(escalation.escalationId)}
                  onchange={(event) => {
                    draftState[escalation.escalationId] =
                      (event.currentTarget as HTMLSelectElement).value as HumanEscalationResolutionState;
                  }}
                >
                  {#each RESOLUTION_STATES as option (option)}
                    <option value={option}>{option}</option>
                  {/each}
                </select>
                <select
                  aria-label="Reason"
                  class="rounded border border-bark-200 px-2 py-1 text-sm"
                  value={selectedReason(escalation.escalationId)}
                  onchange={(event) => {
                    draftReason[escalation.escalationId] =
                      (event.currentTarget as HTMLSelectElement).value as HumanEscalationResolutionReason;
                  }}
                >
                  {#each RESOLUTION_REASONS as option (option)}
                    <option value={option}>{option}</option>
                  {/each}
                </select>
                <button
                  class="rounded-md border border-bark-200 px-3 py-1 text-sm disabled:opacity-50"
                  disabled={busyId === escalation.escalationId}
                  onclick={() => record(escalation)}
                >
                  {busyId === escalation.escalationId ? 'Recording…' : 'Record'}
                </button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>
