<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import ConfirmationModal from '$lib/components/ConfirmationModal.svelte';
  import {
    cancelIcpCandidate,
    emergencyDisableIcpAutonomy,
    getIcpAutonomyData,
    setIcpDoNotDisturb,
    type IcpAutonomyData,
  } from '$lib/api/endpoints/icp-autonomy';
  import type { AdminIcpCandidateView } from '../../../../src/operator/garden/services/types.js';
  import {
    canCancelIcpCandidate,
    costProjectionUnavailableMessage,
    costState,
    formatUsd,
  } from './autonomy-view';
  import { scopeGardenPath } from '$lib/fleet/companion-scope';

  type PendingAction =
    | { kind: 'cancel'; candidate: AdminIcpCandidateView }
    | { kind: 'dnd' }
    | { kind: 'disable' };

  let data = $state<IcpAutonomyData | null>(null);
  let loading = $state(true);
  let error = $state('');
  let mutationMessage = $state('');
  let pendingAction = $state<PendingAction | null>(null);
  let mutating = $state(false);
  let lastLoadedAt = $state<number | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;

  const effectiveScheduler = $derived(data?.settings.scheduler.effectiveValue ?? null);
  const onDiskScheduler = $derived(data?.settings.scheduler.onDiskValue ?? null);
  const effectiveCharge = $derived(data?.settings.chargePolicy.effectiveValue ?? null);
  const onDiskCharge = $derived(data?.settings.chargePolicy.onDiskValue ?? null);

  const confirmation = $derived.by(() => {
    if (!pendingAction) return null;
    if (pendingAction.kind === 'cancel') {
      return {
        title: 'Cancel autonomous candidate?',
        body: 'This stops the selected local candidate. If it owns an issued permit, the permit is revoked before the candidate is cancelled.',
        context: `${pendingAction.candidate.source} · ${pendingAction.candidate.candidateId}`,
        label: 'Cancel candidate',
      };
    }
    if (pendingAction.kind === 'dnd') {
      return {
        title: 'Set autonomy do-not-disturb?',
        body: 'This publishes a local operator DND lease and safely invalidates outstanding permits involving this companion.',
        context: 'The operator lease expires according to scheduler.json. This does not disable ordinary human chat.',
        label: 'Set DND',
      };
    }
    return {
      title: 'Emergency-disable autonomous initiation?',
      body: 'This immediately fences the running source, publishes DND, invalidates outstanding permits, and writes enabled=false to scheduler.json.',
      context: 'Re-enabling requires an owner-file edit and process restart. Ordinary companion replies and human chat are not disabled.',
      label: 'Emergency disable',
    };
  });

  async function loadData(background = false): Promise<void> {
    if (!background) loading = true;
    error = '';
    try {
      data = await getIcpAutonomyData();
      lastLoadedAt = Date.now();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Failed to load autonomy state';
    } finally {
      loading = false;
    }
  }

  async function confirmAction(): Promise<void> {
    const action = pendingAction;
    if (!action || mutating) return;
    mutating = true;
    mutationMessage = '';
    try {
      const result = action.kind === 'cancel'
        ? await cancelIcpCandidate(action.candidate.candidateId, action.candidate.revision)
        : action.kind === 'dnd'
          ? await setIcpDoNotDisturb()
          : await emergencyDisableIcpAutonomy();
      mutationMessage = `${result.message}. Revoked permits: ${result.revokedPermitCount}.`;
      pendingAction = null;
      await loadData(true);
    } catch (cause) {
      mutationMessage = cause instanceof Error ? cause.message : 'Autonomy control failed';
    } finally {
      mutating = false;
    }
  }

  function dateTime(timestamp: number): string {
    return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : '--';
  }

  function relative(timestamp: number | null): string {
    if (timestamp === null) return '--';
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ago`;
  }

  function badge(value: string): string {
    if (['available', 'open_to_chat', 'active', 'consumed', 'normal'].includes(value)) {
      return 'bg-moss-100 text-moss-700';
    }
    if (['rejected', 'suppressed', 'revoked', 'hard_stop', 'unknown_cost', 'do_not_disturb'].includes(value)) {
      return 'bg-wilt-100 text-wilt-700';
    }
    return 'bg-gold-100 text-gold-700';
  }

  onMount(() => {
    void loadData();
    timer = setInterval(() => void loadData(true), 15_000);
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
  });
</script>

<div class="space-y-6">
  <header class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
    <div>
      <div class="flex flex-wrap items-center gap-2">
        <h1 class="text-2xl font-serif font-bold text-shadow-900">Autonomy Control Plane</h1>
        {#if data}
          <span class={`rounded-full px-2.5 py-1 text-xs font-medium ${data.runtimeEnabled ? 'bg-moss-100 text-moss-700' : 'bg-bark-200 text-shadow-700'}`}>
            {data.runtimeEnabled ? 'Runtime enabled' : 'Runtime disabled'}
          </span>
        {/if}
      </div>
      <p class="mt-1 max-w-3xl text-sm text-shadow-600">
        Bounded, content-free observability for autonomous companion initiation. Private motivation,
        contact identifiers, bearer permits, transcripts, and model reasoning are never exposed here.
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
      <button class="rounded-lg border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700 hover:bg-bark-100 disabled:opacity-50" onclick={() => loadData()} disabled={loading}>
        {loading ? 'Loading…' : 'Refresh'}
      </button>
      <button class="rounded-lg border border-gold-400 bg-gold-50 px-3 py-2 text-sm font-medium text-gold-800 hover:bg-gold-100 disabled:opacity-50" onclick={() => (pendingAction = { kind: 'dnd' })} disabled={!data?.available || mutating}>
        Set DND
      </button>
      <button class="rounded-lg bg-wilt-600 px-3 py-2 text-sm font-medium text-white hover:bg-wilt-700 disabled:opacity-50" onclick={() => (pendingAction = { kind: 'disable' })} disabled={!data?.available || mutating || data?.runtimeEnabled === false}>
        Emergency disable
      </button>
    </div>
  </header>

  {#if mutationMessage}
    <div class="card-garden border-l-4 border-l-gold-400 p-4 text-sm text-shadow-800">{mutationMessage}</div>
  {/if}

  {#if loading && !data}
    <div class="card-garden p-12 text-center text-sm text-shadow-600">Loading autonomy control-plane state…</div>
  {:else if error && !data}
    <div class="card-garden border-l-4 border-l-wilt-400 p-6 text-sm text-shadow-800">{error}</div>
  {:else if data}
    {#if !data.available}
      <div class="card-garden border-l-4 border-l-gold-400 p-5">
        <p class="font-medium text-shadow-900">Control plane wired but empty</p>
        <p class="mt-1 text-sm text-shadow-600">
          This deployment has no multi-companion ICP control plane (single-companion topology, or the
          shared Postgres control plane is not provisioned). The page stays wired and truthful: the
          runtime flag state above is real, the tables below are genuinely empty, and mutation
          controls remain disabled. Autonomous initiation additionally requires seeded sibling
          contacts — see <code>npm run seed:sibling-contacts</code>.
        </p>
      </div>
    {/if}
    {#if data.companionPeerContactCount === 0}
      <div class="card-garden border-l-4 border-l-wilt-400 p-5">
        <p class="font-medium text-shadow-900">No ICP-eligible sibling contacts</p>
        <p class="mt-1 text-sm text-shadow-600">
          No contact carries a <code>channel='companion'</code> identity, so peer selection can never
          succeed even with autonomy enabled. Run
          <code>npm run seed:sibling-contacts -- --apply</code> on the fleet to seed mutual sibling
          contacts (idempotent; dry-run without <code>--apply</code>).
        </p>
      </div>
    {/if}

    <section class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      <div class="card-garden p-4">
        <p class="text-xs font-medium uppercase tracking-wide text-shadow-500">Activity state</p>
        <p class="mt-2 text-lg font-semibold text-shadow-900">{data.quietState.replaceAll('_', ' ')}</p>
        <p class="mt-1 text-xs text-shadow-600">{data.quietExplanation}</p>
      </div>
      <div class="card-garden p-4">
        <p class="text-xs font-medium uppercase tracking-wide text-shadow-500">Candidates / episodes</p>
        <p class="mt-2 text-lg font-semibold text-shadow-900">{data.candidates.length} / {data.episodes.length}</p>
        <p class="mt-1 text-xs text-shadow-600">Bounded to the most recent 50 records per lifecycle.</p>
      </div>
      <div class="card-garden p-4">
        <p class="text-xs font-medium uppercase tracking-wide text-shadow-500">Failures observed</p>
        <p class="mt-2 text-lg font-semibold text-shadow-900">{data.failureCount}</p>
        <p class="mt-1 text-xs text-shadow-600">Rejected, suppressed, failed, or breaker-denied records.</p>
      </div>
      <div class="card-garden p-4">
        <p class="text-xs font-medium uppercase tracking-wide text-shadow-500">Last refreshed</p>
        <p class="mt-2 text-lg font-semibold text-shadow-900">{relative(lastLoadedAt)}</p>
        <p class="mt-1 break-all text-xs text-shadow-600">Local: {data.localCompanionId ?? 'unavailable'}</p>
      </div>
    </section>

    <section class="card-garden p-5 space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="font-serif text-lg font-semibold text-shadow-900">Canonical owner policy</h2>
          <p class="text-sm text-shadow-600">Effective process state is shown beside on-disk owner state. Divergence requires restart.</p>
        </div>
        <div class="flex gap-3 text-sm">
          <a href={scopeGardenPath('/settings')} class="font-medium text-gold-700 hover:text-gold-800">Open settings</a>
          <a href={scopeGardenPath('/channels')} class="font-medium text-gold-700 hover:text-gold-800">Channel authorization</a>
          <a href={scopeGardenPath('/contacts')} class="font-medium text-gold-700 hover:text-gold-800">Trust / contacts</a>
        </div>
      </div>
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div class="rounded-lg border border-bark-200 bg-bark-50 p-4 text-sm">
          <div class="flex items-center justify-between gap-2">
            <p class="font-medium text-shadow-900">scheduler.json</p>
            {#if data.settings.scheduler.restartRequired}<span class="rounded-full bg-gold-100 px-2 py-1 text-xs text-gold-700">Restart required</span>{/if}
          </div>
          <dl class="mt-3 grid grid-cols-2 gap-2 text-shadow-700">
            <dt>Effective enabled</dt><dd class="text-right font-medium">{effectiveScheduler?.enabled === true ? 'yes' : 'no'}</dd>
            <dt>On disk enabled</dt><dd class="text-right font-medium">{onDiskScheduler?.enabled === true ? 'yes' : 'no'}</dd>
            <dt>Candidate TTL</dt><dd class="text-right">{effectiveScheduler?.candidate.defaultTtlMs ?? '--'} ms</dd>
            <dt>Retry cadence</dt><dd class="text-right">{effectiveScheduler?.candidate.retryCadenceMs ?? '--'} ms</dd>
            <dt>Permit TTL</dt><dd class="text-right">{effectiveScheduler?.permit.ttlMs ?? '--'} ms</dd>
          </dl>
        </div>
        <div class="rounded-lg border border-bark-200 bg-bark-50 p-4 text-sm">
          <div class="flex items-center justify-between gap-2">
            <p class="font-medium text-shadow-900">charge-policy.json</p>
            {#if data.settings.chargePolicy.restartRequired}<span class="rounded-full bg-gold-100 px-2 py-1 text-xs text-gold-700">Restart required</span>{/if}
          </div>
          <dl class="mt-3 grid grid-cols-2 gap-2 text-shadow-700">
            <dt>Social quota</dt><dd class="text-right">{effectiveCharge?.companionSocialQuota ?? '--'}</dd>
            <dt>Continuation cost</dt><dd class="text-right">{effectiveCharge?.companionSocialContinuationCost ?? '--'}</dd>
            <dt>Cost breaker</dt><dd class="text-right font-medium">{effectiveCharge?.costBreaker.enabled === true ? 'enabled' : 'disabled'}</dd>
            <dt>On-disk breaker</dt><dd class="text-right">{onDiskCharge?.costBreaker.enabled === true ? 'enabled' : 'disabled'}</dd>
          </dl>
        </div>
      </div>
    </section>

    <section class="card-garden overflow-hidden">
      <div class="border-b border-bark-200 p-5">
        <h2 class="font-serif text-lg font-semibold text-shadow-900">Availability</h2>
        <p class="text-sm text-shadow-600">Current and expired coarse leases only; no presence transcript or private activity is included.</p>
      </div>
      {#if data.availability.length === 0}
        <p class="p-5 text-sm text-shadow-600">No availability leases recorded.</p>
      {:else}
        <div class="overflow-x-auto"><table class="w-full text-sm"><thead class="bg-bark-100 text-left text-xs uppercase tracking-wide text-shadow-500"><tr><th class="p-3">Companion</th><th class="p-3">State</th><th class="p-3">Source</th><th class="p-3">Expires</th></tr></thead><tbody class="divide-y divide-bark-200">
          {#each data.availability as lease (lease.companionId)}<tr><td class="p-3 font-mono text-xs">{lease.local ? 'Local · ' : ''}{lease.companionId}</td><td class="p-3"><span class={`rounded-full px-2 py-1 text-xs ${badge(lease.state)}`}>{lease.state.replaceAll('_', ' ')}</span>{#if !lease.current}<span class="ml-2 text-xs text-shadow-500">expired</span>{/if}</td><td class="p-3">{lease.source}</td><td class="p-3">{dateTime(lease.expiresAtMs)}</td></tr>{/each}
        </tbody></table></div>
      {/if}
    </section>

    <section class="card-garden overflow-hidden">
      <div class="border-b border-bark-200 p-5"><h2 class="font-serif text-lg font-semibold text-shadow-900">Local candidates</h2><p class="text-sm text-shadow-600">Private motivation and contact bindings are withheld. Cancellation uses the current revision and never accepts a target companion.</p></div>
      {#if data.candidates.length === 0}<p class="p-5 text-sm text-shadow-600">No local autonomous candidates recorded.</p>{:else}
        <div class="overflow-x-auto"><table class="w-full text-sm"><thead class="bg-bark-100 text-left text-xs uppercase tracking-wide text-shadow-500"><tr><th class="p-3">Source</th><th class="p-3">Peer</th><th class="p-3">Status / reason</th><th class="p-3">Created</th><th class="p-3"></th></tr></thead><tbody class="divide-y divide-bark-200">
          {#each data.candidates as candidate (candidate.candidateId)}<tr><td class="p-3"><p class="font-medium">{candidate.source.replaceAll('_', ' ')}</p><p class="font-mono text-xs text-shadow-500">{candidate.provenanceRef}</p></td><td class="p-3 font-mono text-xs">{candidate.peerCompanionId}</td><td class="p-3"><span class={`rounded-full px-2 py-1 text-xs ${badge(candidate.status)}`}>{candidate.status}</span><p class="mt-1 text-xs text-shadow-600">{candidate.reasonCode ?? 'no reason recorded'}</p></td><td class="p-3">{dateTime(candidate.createdAtMs)}</td><td class="p-3 text-right"><button class="rounded border border-wilt-300 px-2.5 py-1 text-xs font-medium text-wilt-700 hover:bg-wilt-50 disabled:opacity-40" disabled={!canCancelIcpCandidate(candidate) || mutating} onclick={() => (pendingAction = { kind: 'cancel', candidate })}>Cancel</button></td></tr>{/each}
        </tbody></table></div>
      {/if}
    </section>

    <section class="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <div class="card-garden overflow-hidden"><div class="border-b border-bark-200 p-5"><h2 class="font-serif text-lg font-semibold text-shadow-900">Episodes</h2><p class="text-sm text-shadow-600">Content-free episode lifecycle with ordinary Garden investigation links.</p></div>{#if data.episodes.length === 0}<p class="p-5 text-sm text-shadow-600">No episodes recorded.</p>{:else}<div class="divide-y divide-bark-200">{#each data.episodes as episode (episode.conversationId)}<div class="p-4 text-sm"><div class="flex items-center justify-between gap-2"><span class={`rounded-full px-2 py-1 text-xs ${badge(episode.status)}`}>{episode.status}</span><span class="text-xs text-shadow-500">{dateTime(episode.lastActivityAtMs)}</span></div><p class="mt-2 font-mono text-xs text-shadow-700">{episode.conversationId}</p><p class="mt-1 text-xs text-shadow-600">{episode.initiationSource} · {episode.closeReasonCode ?? 'open / no close reason'}</p><div class="mt-2 flex gap-3 text-xs"><a href={episode.links.sessions} class="text-gold-700">Sessions</a><a href={episode.links.charges} class="text-gold-700">Charges</a><a href={episode.links.modelUsage} class="text-gold-700">Models</a></div></div>{/each}</div>{/if}</div>
      <div class="card-garden overflow-hidden"><div class="border-b border-bark-200 p-5"><h2 class="font-serif text-lg font-semibold text-shadow-900">Permits</h2><p class="text-sm text-shadow-600">Bearer permit IDs are withheld; lifecycle and correlation handles remain visible.</p></div>{#if data.permits.length === 0}<p class="p-5 text-sm text-shadow-600">No permits recorded.</p>{:else}<div class="divide-y divide-bark-200">{#each data.permits as permit (`${permit.candidateId}-${permit.revision}`)}<div class="p-4 text-sm"><div class="flex items-center justify-between gap-2"><span class={`rounded-full px-2 py-1 text-xs ${badge(permit.status)}`}>{permit.status}</span><span class="text-xs text-shadow-500">rev {permit.revision}</span></div><p class="mt-2 font-mono text-xs text-shadow-700">Candidate {permit.candidateId}</p><p class="mt-1 text-xs text-shadow-600">{permit.senderCompanionId} → {permit.recipientCompanionId}</p><p class="mt-1 text-xs text-shadow-600">{permit.reasonCode ?? 'no reason recorded'} · expires {dateTime(permit.expiresAtMs)}</p></div>{/each}</div>{/if}</div>
    </section>

    <section class="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <div class="card-garden overflow-hidden"><div class="border-b border-bark-200 p-5"><h2 class="font-serif text-lg font-semibold text-shadow-900">Fatigue / charge</h2><p class="text-sm text-shadow-600">Aggregated by content-free episode identity; private peer-contact IDs are excluded.</p></div>{#if data.fatigue.length === 0}<p class="p-5 text-sm text-shadow-600">No fatigue reservations recorded.</p>{:else}<div class="divide-y divide-bark-200">{#each data.fatigue as row (`${row.conversationId}-${row.localCompanionId}`)}<div class="grid grid-cols-2 gap-2 p-4 text-sm"><p class="col-span-2 font-mono text-xs text-shadow-700">{row.conversationId}</p><p>Charged <strong>{row.chargedUnits}</strong></p><p>Overcharge <strong>{row.overchargeUnits}</strong></p><p>Delivered {row.deliveredCount}</p><p>Failed {row.failedCount}</p></div>{/each}</div>{/if}</div>
      <div class="card-garden overflow-hidden"><div class="border-b border-bark-200 p-5"><h2 class="font-serif text-lg font-semibold text-shadow-900">Conversation cost breaker</h2><p class="text-sm text-shadow-600">Latest durable decision per conversation. Empty is expected when the breaker has no decisions.</p></div>{#if !data.costProjection.available}<div class="border-l-4 border-l-gold-400 p-5"><p class="font-medium text-shadow-900">Cost projection unavailable</p><p class="mt-1 text-sm text-shadow-600">{costProjectionUnavailableMessage(data.costProjection.unavailableReason)}</p></div>{:else if data.costs.length === 0}<p class="p-5 text-sm text-shadow-600">No cost-breaker decisions recorded.</p>{:else}<div class="divide-y divide-bark-200">{#each data.costs as cost (cost.conversationId)}<div class="p-4 text-sm"><div class="flex items-center justify-between gap-2"><span class={`rounded-full px-2 py-1 text-xs ${badge(costState(cost))}`}>{costState(cost).replaceAll('_', ' ')}</span><span class="text-xs text-shadow-500">{cost.reason.replaceAll('_', ' ')}</span></div><p class="mt-2 font-mono text-xs text-shadow-700">{cost.conversationId}</p><div class="mt-2 grid grid-cols-3 gap-2 text-xs text-shadow-600"><span>Actual {formatUsd(cost.actualCostUsd)}</span><span>Projected {formatUsd(cost.projectedTotalCostUsd)}</span><span>Hard {formatUsd(cost.hardLimitUsd)}</span></div></div>{/each}</div>{/if}</div>
    </section>

    <section class="card-garden p-5">
      <h2 class="font-serif text-lg font-semibold text-shadow-900">Reasons and redaction contract</h2>
      <div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>{#if data.reasonCounts.length === 0}<p class="text-sm text-shadow-600">No machine-readable reasons recorded.</p>{:else}<div class="flex flex-wrap gap-2">{#each data.reasonCounts as reason (reason.reasonCode)}<span class="rounded-full border border-bark-200 bg-bark-50 px-2.5 py-1 text-xs text-shadow-700">{reason.reasonCode}: {reason.count}</span>{/each}</div>{/if}</div>
        <ul class="space-y-1 text-sm text-shadow-600"><li>Private motivation: withheld</li><li>Peer contact IDs: withheld</li><li>Permit bearer IDs: withheld</li><li>Transcripts and chain-of-thought: not collected</li></ul>
      </div>
    </section>
  {/if}
</div>

<ConfirmationModal
  open={pendingAction !== null}
  title={confirmation?.title ?? ''}
  body={confirmation?.body ?? ''}
  context={confirmation?.context ?? ''}
  confirmLabel={confirmation?.label ?? 'Confirm'}
  cancelLabel="Keep current state"
  tone="danger"
  busy={mutating}
  onConfirm={() => void confirmAction()}
  onCancel={() => (pendingAction = null)}
/>
