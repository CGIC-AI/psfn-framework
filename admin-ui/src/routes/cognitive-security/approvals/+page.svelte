<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    confirmIntakeQuarantineDecision,
    decideIntakeQuarantine,
    loadIntakeQuarantineLocalFirst,
    getIntakeQuarantineItem,
    type IntakeQuarantineDecisionAction,
  } from '$lib/api/endpoints/intake';
  import type {
    AdminIntakeQuarantineFirewallStatus,
    AdminIntakeQuarantineItemDetail,
    AdminIntakeQuarantineItemView,
    AdminIntakeQuarantineSourceListAction,
  } from '$lib/types';
  import ConfirmationModal from '$lib/components/ConfirmationModal.svelte';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import RuleMatchProvenance from '$lib/components/cognitive-security/RuleMatchProvenance.svelte';
  import { pushToast } from '$lib/stores/toast.svelte';
  import { createGardenQueueRefresh } from '$lib/polling/garden-queue-refresh';
  import {
    createSilentBackgroundRevalidation,
    reconcilePollingSnapshot,
  } from '$lib/polling/silent-background-revalidation';

  // ── Queue state ──
  let items = $state<AdminIntakeQuarantineItemView[]>([]);
  let firewallStatus = $state<AdminIntakeQuarantineFirewallStatus | null>(null);
  let loading = $state(true);
  let error = $state('');
  let endpointMissing = $state(false);
  let backgroundError = $state('');
  let initialized = false;

  // ── Detail state (one expanded item at a time) ──
  let expandedId = $state('');
  let detail = $state<AdminIntakeQuarantineItemDetail | null>(null);
  let detailLoading = $state(false);
  let rawRevealed = $state(false);
  let queueFilter = $state<'held' | 'fail_closed' | 'decided'>('held');

  // ── Decision form state ──
  let reason = $state('');
  let sourceListChoice = $state<'none' | AdminIntakeQuarantineSourceListAction>('none');

  // ── Double-confirm flow state ──
  type ConfirmStage = 'idle' | 'first' | 'second';
  let confirmStage = $state<ConfirmStage>('idle');
  let confirmBusy = $state(false);
  let pendingAction = $state<IntakeQuarantineDecisionAction | null>(null);
  let pendingItem = $state<AdminIntakeQuarantineItemView | null>(null);
  let confirmToken = $state('');
  let serverSummary = $state('');

  const heldItems = $derived(items.filter(item => item.status === 'held'));
  const decidedItems = $derived(items.filter(item => item.status !== 'held'));
  const failClosedItems = $derived(heldItems.filter(item => item.holdReason === 'screener_malfunction'));
  const hostileItems = $derived(heldItems.filter(item => item.sourceRiskTier === 'hostile'));
  const queueItems = $derived(
    queueFilter === 'decided'
      ? decidedItems
      : queueFilter === 'fail_closed'
        ? failClosedItems
        : heldItems,
  );
  const selectedItem = $derived(
    queueItems.find(item => item.id === expandedId) ?? queueItems[0] ?? null,
  );

  const ACTION_LABELS: Record<IntakeQuarantineDecisionAction, string> = {
    release_raw: 'Release raw',
    release_sanitized: 'Release sanitized',
    discard: 'Discard',
  };

  const STATUS_STYLES: Record<string, string> = {
    held: 'bg-gold-100 text-gold-700',
    detection_hold: 'bg-gold-100 text-gold-700',
    screener_malfunction: 'bg-wilt-100 text-wilt-700',
    released_raw: 'bg-wilt-100 text-wilt-600',
    released_sanitized: 'bg-moss-100 text-moss-700',
    discarded: 'bg-bark-200 text-shadow-700',
    expired: 'bg-bark-200 text-shadow-600',
  };

  const TIER_STYLES: Record<string, string> = {
    trusted: 'bg-moss-100 text-moss-700',
    standard: 'bg-bark-200 text-shadow-700',
    untrusted: 'bg-gold-100 text-gold-700',
    hostile: 'bg-wilt-100 text-wilt-600',
  };

  function formatTimestamp(value: string): string {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
  }

  function formatTtl(ms: number): string {
    if (ms <= 0) return 'expired';
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    if (hours >= 48) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function statusLabel(status: string): string {
    return status.replace(/_/g, ' ');
  }

  function queueStatus(item: AdminIntakeQuarantineItemView): string {
    if (item.status !== 'held') return item.status;
    return item.holdReason === 'screener_malfunction'
      ? 'screener_malfunction'
      : 'detection_hold';
  }

  async function loadData() {
    backgroundRefresh.invalidate();
    loading = true;
    error = '';
    endpointMissing = false;
    backgroundError = '';
    let rendered = false;
    try {
      await loadIntakeQuarantineLocalFirst((data, source) => {
        rendered = true;
        const reconciled = reconcilePollingSnapshot(items, data.items);
        if (reconciled !== items) items = reconciled;
        if (data.firewallStatus) firewallStatus = data.firewallStatus;
        if (source === 'cache') loading = false;
      });
      if (!expandedId) {
        const firstHeld = items.find(item => item.status === 'held');
        if (firstHeld) await toggleDetail(firstHeld);
      }
    } catch (e) {
      if (rendered) {
        backgroundError = e instanceof Error ? e.message : 'Failed to refresh quarantine queue';
      } else if (e instanceof Error && e.message.includes('404')) {
        endpointMissing = true;
      } else {
        error = e instanceof Error ? e.message : 'Failed to load quarantine queue';
      }
    } finally {
      loading = false;
      initialized = true;
    }
  }

  const backgroundRefresh = createSilentBackgroundRevalidation({
    load: publish => loadIntakeQuarantineLocalFirst(data => {
      if (data.firewallStatus) firewallStatus = data.firewallStatus;
      publish(data.items);
    }),
    read: () => items,
    write: data => { items = data; },
    reportError: message => { backgroundError = message; },
    fallbackError: 'Failed to refresh quarantine queue',
  });

  async function toggleDetail(item: AdminIntakeQuarantineItemView) {
    if (expandedId === item.id) {
      return;
    }
    expandedId = item.id;
    detail = null;
    rawRevealed = false;
    reason = '';
    sourceListChoice = 'none';
    detailLoading = true;
    try {
      const data = await getIntakeQuarantineItem(item.id);
      if (expandedId !== item.id) return;
      detail = data.item;
    } catch (e) {
      pushToast(e instanceof Error ? e.message : 'Failed to load item detail', 'error');
    } finally {
      detailLoading = false;
    }
  }

  function beginDecision(item: AdminIntakeQuarantineItemView, action: IntakeQuarantineDecisionAction) {
    if (!reason.trim()) {
      pushToast('A reason is required for every quarantine decision.', 'error');
      return;
    }
    pendingItem = item;
    pendingAction = action;
    confirmToken = '';
    serverSummary = '';
    confirmStage = 'first';
  }

  function beginRedeliveryRetry(item: AdminIntakeQuarantineItemView) {
    const action = item.operatorDecision?.action;
    if (action !== 'release_raw' && action !== 'release_sanitized') {
      pushToast('This item has no released content to re-deliver.', 'error');
      return;
    }
    sourceListChoice = 'none';
    beginDecision(item, action);
  }

  function cancelConfirmFlow() {
    confirmStage = 'idle';
    confirmBusy = false;
    pendingAction = null;
    pendingItem = null;
    confirmToken = '';
    serverSummary = '';
  }

  // First confirm: request the server-side confirm token (step 1 of 2). On a
  // companion Garden route the gateway requires an audited escalation grant
  // bound to exactly this confirm route, so the grant is minted and spent here.
  async function handleFirstConfirm() {
    if (!pendingItem || !pendingAction) return;
    confirmBusy = true;
    try {
      const reasonText = reason.trim();
      const result = await confirmIntakeQuarantineDecision(pendingItem.id, {
          action: pendingAction,
          ...(sourceListChoice !== 'none' ? { sourceList: sourceListChoice } : {}),
        }, reasonText);
      confirmToken = result.confirmToken;
      serverSummary = result.summary;
      confirmStage = 'second';
    } catch (e) {
      pushToast(e instanceof Error ? e.message : 'Confirmation was refused', 'error');
      cancelConfirmFlow();
      await loadData();
    } finally {
      confirmBusy = false;
    }
  }

  // Second confirm: execute with the single-use token (step 2 of 2). The
  // gateway requires its own audited grant for the decide route; a retry mints
  // a fresh grant. Release-raw and release-sanitized stay distinct body
  // actions — the ceremony authorizes the endpoint, never auto-releasing.
  async function handleSecondConfirm() {
    if (!pendingItem || !pendingAction || !confirmToken) return;
    confirmBusy = true;
    try {
      const result = await decideIntakeQuarantine(pendingItem.id, {
          action: pendingAction,
          ...(sourceListChoice !== 'none' ? { sourceList: sourceListChoice } : {}),
          confirmToken,
          reason: reason.trim(),
        });
      pushToast(result.message, 'success');
      expandedId = '';
      detail = null;
      reason = '';
      sourceListChoice = 'none';
    } catch (e) {
      pushToast(e instanceof Error ? e.message : 'Decision was refused', 'error');
    } finally {
      cancelConfirmFlow();
      await loadData();
    }
  }

  const queueRefresh = createGardenQueueRefresh({
    queue: 'intake-quarantine',
    refresh: () => {
      // Don't reshuffle the queue mid-decision.
      if (confirmStage === 'idle') {
        return initialized ? backgroundRefresh.refresh() : loadData();
      }
    },
    intervalMs: 15_000,
  });

  onMount(() => {
    queueRefresh.start();
  });

  onDestroy(() => {
    queueRefresh.stop();
    backgroundRefresh.dispose();
  });
</script>

<svelte:head>
  <title>Cognitive Security: Approvals</title>
</svelte:head>

<div class="garden-page space-y-5">
  <GardenPageHeader
    eyebrow="Cognitive Security · Human review"
    title="Quarantine Approvals"
    description="Review content withheld by the intake firewall. Reading never releases content; every disposition is double-confirmed server-side and audit recorded."
  >
    {#snippet actions()}
      <span class="text-xs text-shadow-600">Auto-refreshes every 15s</span>
      <button
        onclick={loadData}
        disabled={loading}
        class="text-sm px-3 py-1.5 rounded-lg border border-bark-300 text-shadow-600 hover:bg-bark-100
               transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
      >
        {loading ? 'Loading...' : 'Refresh'}
      </button>
    {/snippet}
  </GardenPageHeader>

  {#if backgroundError}
    <p class="garden-error rounded border border-wilt-200 bg-wilt-50 px-3 py-2 text-sm text-wilt-700" role="status">
      Background refresh failed: {backgroundError}. Showing the last available queue.
    </p>
  {/if}

  {#if firewallStatus}
    <section class="card-garden border-l-4 border-l-moss-300 p-4" aria-label="Shared firewall status">
      <div class="flex flex-wrap items-center gap-3">
        <span class="text-xs uppercase font-semibold text-shadow-600">Shared firewall mode</span>
        <span class="inline-block px-3 py-1 rounded-full text-sm font-semibold {firewallStatus.mode === 'strict' ? 'bg-wilt-100 text-wilt-700' : firewallStatus.mode === 'boundary' ? 'bg-moss-100 text-moss-700' : 'bg-gold-100 text-gold-700'}">{firewallStatus.mode}</span>
        <span class="text-xs text-shadow-500">
          TTL {firewallStatus.quarantineItemTtlHours}h · max held {firewallStatus.quarantineMaxHeldItems} · held now {firewallStatus.heldCount}
        </span>
      </div>
      <p class="mt-2 text-sm text-shadow-800">
        An empty approval queue <strong>never</strong> means the firewall is off. The mode above is the
        shared gateway's authoritative posture and is independent of this queue's contents.
      </p>
    </section>
  {/if}

  {#if loading && items.length === 0}
    <div class="garden-loading flex-col space-y-3">
      {#each Array(3) as _}
        <div class="card-garden p-5 animate-pulse space-y-3">
          <div class="h-4 rounded bg-bark-200 w-2/5"></div>
          <div class="h-3 rounded bg-bark-200 w-3/5"></div>
        </div>
      {/each}
      <p class="text-sm text-shadow-600 px-1">Loading quarantine queue...</p>
    </div>
  {:else if error}
    <div class="garden-error card-garden p-6 border-l-4 border-l-wilt-400">
      <p class="text-sm text-shadow-800">{error}</p>
    </div>
  {:else if endpointMissing}
    <div class="card-garden p-6">
      <p class="text-sm text-shadow-800">Requires the agent runtime</p>
      <p class="text-sm text-shadow-600 mt-2">
        The quarantine approval queue is served by the runtime's admin surface. Items appear
        here when the intake firewall (<code class="font-mono bg-bark-100 px-1 rounded">intake-policy.json</code>)
        quarantines inbound content.
      </p>
    </div>
  {:else if items.length === 0}
    <div class="garden-empty card-garden p-12 text-center">
      <p class="font-serif text-lg text-shadow-700 mb-1">Nothing in quarantine</p>
      <p class="text-sm text-shadow-600">
        When the intake firewall holds suspicious content for review, it lands here with the
        full screening detail. The companion only ever sees a calm placeholder.
      </p>
    </div>
  {:else}
    {#snippet itemCard(item: AdminIntakeQuarantineItemView)}
      <div class="garden-section card-garden overflow-hidden">
        <button
          type="button"
          class="w-full px-5 py-4 border-b border-bark-100 bg-bark-50 text-left hover:bg-bark-100 transition-colors"
          onclick={() => toggleDetail(item)}
        >
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <h3 class="text-base font-semibold text-shadow-900 truncate">
                {item.sourceClass}
                <span class="text-shadow-600 font-normal font-mono text-sm">{item.originRef}</span>
              </h3>
              <div class="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <span class="inline-block px-2 py-0.5 rounded-full font-medium {STATUS_STYLES[queueStatus(item)] ?? 'bg-bark-200 text-shadow-700'}">
                  {statusLabel(queueStatus(item))}
                </span>
                <span class="inline-block px-2 py-0.5 rounded-full font-medium {TIER_STYLES[item.sourceRiskTier] ?? 'bg-bark-200 text-shadow-700'}">
                  {item.sourceRiskTier}
                </span>
                <span class="inline-block px-2 py-0.5 rounded-full font-medium {item.mode === 'enforce' ? 'bg-shadow-800 text-bark-50' : 'bg-bark-200 text-shadow-700'}">
                  {item.mode === 'enforce' ? 'enforce (withheld)' : 'shadow (was delivered)'}
                </span>
                {#if item.attribution}
                  {#if item.attribution.targetContactDisplayName}
                    <span class="inline-block px-2 py-0.5 rounded-full font-medium bg-bark-100 text-shadow-800">To: {item.attribution.targetContactDisplayName}</span>
                  {/if}
                  <span class="inline-block px-2 py-0.5 rounded-full font-medium bg-bark-50 border border-bark-200 text-shadow-700">{item.attribution.sourceChannelLabel}</span>
                  <span class="inline-block px-2 py-0.5 rounded-full font-medium {item.attribution.direction === 'outbound' ? 'bg-gold-50 text-gold-700 border border-gold-200' : 'bg-bark-50 text-shadow-700 border border-bark-200'}">{item.attribution.direction}</span>
                  <span class="inline-block px-2 py-0.5 rounded-full font-medium bg-wilt-50 border border-wilt-200 text-wilt-700">{item.attribution.faultType}</span>
                  <span class="inline-block px-2 py-0.5 rounded-full font-medium bg-bark-50 border border-bark-200 text-shadow-600 uppercase tracking-wide">{item.attribution.screeningStage} · {item.attribution.decision}</span>
                  {#if item.attribution.correlationId}
                    <span class="inline-block px-2 py-0.5 rounded-full font-mono text-[0.65rem] bg-bark-50 border border-bark-200 text-shadow-500" title="Correlated group fanout (content-free)">corr · {item.attribution.correlationId.slice(-8)}</span>
                  {/if}
                {/if}
                {#if item.status === 'held'}
                  <span class="text-shadow-600">TTL {formatTtl(item.ttlRemainingMs)}</span>
                {/if}
              </div>
            </div>
            <span class="text-shadow-500 text-sm shrink-0">{expandedId === item.id ? 'Evidence loaded' : 'Load evidence'}</span>
          </div>
        </button>

        <div class="px-5 py-4 space-y-3">
          <div class="flex flex-wrap gap-1.5">
            {#if item.attribution?.sourceChannelLabel}
              <span class="inline-block px-2 py-0.5 rounded bg-bark-50 border border-bark-200 text-shadow-700 text-xs">{item.attribution.sourceChannelLabel} ({item.attribution.sourceChannelClass})</span>
            {/if}
            {#each item.riskLabels as label (label)}
              <span class="inline-block px-2 py-0.5 rounded bg-wilt-50 border border-wilt-200 text-wilt-700 font-mono text-xs">{label}</span>
            {/each}
            {#if item.riskLabels.length === 0}
              <span class="text-xs text-shadow-600">
                {item.holdReason === 'screener_malfunction'
                  ? 'No risk verdict: screening did not complete.'
                  : 'No risk labels (score-driven hold).'}
              </span>
            {/if}
          </div>

          {#if item.holdReason === 'screener_malfunction'}
            <p class="rounded border border-wilt-200 bg-wilt-50 px-3 py-2 text-sm text-wilt-700">
              Held fail-closed because a screener malfunctioned. This is a reliability failure,
              not a detection verdict; review remains required before release.
            </p>
          {/if}

          {#if item.whyFlagged}
            <p class="text-sm text-shadow-800"><span class="font-medium text-shadow-700">Why flagged:</span> {item.whyFlagged}</p>
          {/if}
          {#if item.summary}
            <p class="text-sm text-shadow-800"><span class="font-medium text-shadow-700">Screener summary:</span> {item.summary}</p>
          {/if}
          <p class="text-sm text-shadow-800">
            <span class="font-medium text-shadow-700">Screening decision:</span>
            <span class="font-mono text-xs">{item.screeningDecisionReason ?? 'n/a'}</span>
          </p>
          <RuleMatchProvenance
            matches={item.ruleMatches}
            unavailable={item.ruleMatchProvenanceUnavailable}
            totalCount={item.ruleMatchTotalCount}
            truncated={item.ruleMatchesTruncated}
          />

          <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
            <div><span class="text-shadow-600">Held:</span> <span class="ml-1 text-shadow-800">{formatTimestamp(item.heldAt)}</span></div>
            <div><span class="text-shadow-600">Expires:</span> <span class="ml-1 text-shadow-800">{formatTimestamp(item.expiresAt)}</span></div>
            {#if item.canonicalContactId}
              <div>
                <span class="text-shadow-600">Sender:</span>
                <span class="ml-1 text-shadow-800">{item.attribution?.targetContactDisplayName ?? 'authorized contact'}</span>
                <details class="inline-block">
                  <summary class="cursor-pointer text-xs text-shadow-500">debug id</summary>
                  <code class="ml-1 font-mono text-shadow-800 bg-bark-100 px-1.5 py-0.5 rounded">{item.canonicalContactId}</code>
                </details>
              </div>
            {/if}
            {#if item.contentSha256}
              <div class="md:col-span-2"><span class="text-shadow-600">Content sha256:</span> <code class="ml-1 font-mono text-xs text-shadow-800 break-all">{item.contentSha256}</code></div>
            {/if}
            {#if item.operatorDecision}
              <div class="md:col-span-2">
                <span class="text-shadow-600">Operator decision:</span>
                <span class="ml-1 text-shadow-800">{statusLabel(item.operatorDecision.action)} by {item.operatorDecision.actor} at {formatTimestamp(item.operatorDecision.at)} -- {item.operatorDecision.reason}</span>
              </div>
            {/if}
            {#if item.redelivery}
              <div class="md:col-span-2 rounded border border-bark-200 bg-bark-50 px-3 py-2">
                <p class="font-medium text-shadow-800">Release destinations</p>
                <ul class="mt-1 space-y-1 text-xs text-shadow-800">
                  <li>
                    <span class="font-medium">Conversation context:</span>
                    {item.redelivery.delivered ? 'appended to L0' : 'append failed'}
                    {item.redelivery.logicalSessionId ? ` in session ${item.redelivery.logicalSessionId}` : ''}
                    {item.redelivery.entryId === undefined || item.redelivery.entryId === null
                      ? ''
                      : ` as entry ${item.redelivery.entryId}`}
                    at {formatTimestamp(item.redelivery.attemptedAt)}.
                    {item.redelivery.reason ? ` ${item.redelivery.reason}` : ''}
                  </li>
                  <li><span class="font-medium">External chat:</span> no Discord, Telegram, or API message was sent by this action.</li>
                  <li><span class="font-medium">Companion behavior:</span> the released context is available on the companion's next turn; this action does not start a turn by itself.</li>
                </ul>
              </div>
            {/if}
            {#if item.releasedArtifactPaths && item.releasedArtifactPaths.length > 0}
              <div class="md:col-span-2 rounded border border-moss-200 bg-moss-50 px-3 py-2">
                <p class="font-medium text-moss-800">Released files are readable at</p>
                <ul class="mt-1 space-y-0.5">
                  {#each item.releasedArtifactPaths as path (path)}
                    <li><code class="font-mono text-xs break-all text-shadow-800">{path}</code></li>
                  {/each}
                </ul>
              </div>
            {/if}
            {#if item.contentAccessAttempts && item.contentAccessAttempts.length > 0}
              <!-- hrmrq.54: reads of the held item's on-disk artifact while it
                   was not released -- a containment-bypass attempt the reviewer
                   must see. -->
              <div class="md:col-span-2 rounded border border-wilt-200 bg-wilt-50 px-3 py-2">
                <span class="font-medium text-wilt-700">Content access attempted ({item.contentAccessAttempts.length}):</span>
                <ul class="mt-1 space-y-0.5">
                  {#each item.contentAccessAttempts as attempt (attempt.at + attempt.path)}
                    <li class="text-xs text-shadow-800">
                      <span class="font-mono">{attempt.via}</span>
                      <span class="text-shadow-600">at {formatTimestamp(attempt.at)}:</span>
                      <code class="font-mono break-all">{attempt.path}</code>
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}
          </div>

          {#if expandedId === item.id}
            {#if detailLoading}
              <p class="garden-loading rounded-xl border border-bark-200 bg-bark-50 p-4 text-sm text-shadow-600">Loading screening evidence...</p>
            {:else if detail}
              <div class="space-y-4 border-t border-bark-100 pt-4">
                <!-- Which classifiers fired -->
                <div>
                  <p class="text-sm font-medium text-shadow-700 mb-1">Classifiers fired (calibrated 0-1 scores)</p>
                  <div class="garden-table-shell garden-table-scroll overflow-x-auto rounded-xl border border-bark-200">
                    <table class="garden-table w-full text-left text-sm">
                      <thead class="text-xs uppercase text-shadow-600 border-b border-bark-200">
                        <tr><th class="px-2 py-1.5 font-semibold">Scanner / classifier</th><th class="px-2 py-1.5 font-semibold">Score</th></tr>
                      </thead>
                      <tbody>
                        {#each Object.entries(detail.scores) as [scanner, score] (scanner)}
                          <tr class="border-b border-bark-100">
                            <td class="px-2 py-1.5 font-mono text-xs">{scanner}</td>
                            <td class="px-2 py-1.5 font-mono text-xs {score >= 0.75 ? 'text-wilt-600 font-semibold' : 'text-shadow-800'}">{score.toFixed(4)}</td>
                          </tr>
                        {/each}
                        {#if Object.keys(detail.scores).length === 0}
                          <tr><td colspan="2" class="px-2 py-1.5 text-shadow-600">No numeric scores recorded.</td></tr>
                        {/if}
                      </tbody>
                    </table>
                  </div>
                </div>

                <!-- Extracted fields -->
                {#if Object.keys(detail.extractedFields).length > 0}
                  <div>
                    <p class="text-sm font-medium text-shadow-700 mb-1">Screening findings</p>
                    <dl class="space-y-1">
                      {#each Object.entries(detail.extractedFields) as [key, value] (key)}
                        <div class="text-xs bg-bark-50 border border-bark-200 rounded px-2 py-1">
                          <dt class="font-mono font-semibold text-shadow-700 inline">{key}:</dt>
                          <dd class="inline ml-1 text-shadow-800 break-words whitespace-pre-wrap">{value}</dd>
                        </div>
                      {/each}
                    </dl>
                  </div>
                {/if}

                <!-- Envelope journal -->
                <div>
                  <p class="text-sm font-medium text-shadow-700 mb-1">Envelope journal</p>
                  <ul class="space-y-1">
                    {#each detail.transitions as record, index (index)}
                      <li class="text-xs font-mono text-shadow-800 bg-bark-50 border border-bark-200 rounded px-2 py-1">
                        {record.from} &rarr; {record.to} · {record.actor} · {formatTimestamp(record.at)} · {record.reason}
                      </li>
                    {/each}
                  </ul>
                </div>

                <!-- Safe representation -->
                <div>
                  <p class="text-sm font-medium text-shadow-700 mb-1">Safe representation (what "release sanitized" delivers)</p>
                  {#if detail.safeRepresentationText}
                    <pre class="text-xs text-shadow-800 bg-moss-50 border border-moss-200 rounded px-3 py-2 whitespace-pre-wrap break-words">{detail.safeRepresentationText}</pre>
                  {:else}
                    <p class="text-sm text-shadow-600 bg-bark-50 border border-bark-200 rounded px-3 py-2">
                      None -- this item predates L3 screening or L3 produced no safe representation.
                      Release-sanitized is unavailable for it (no silent fallback to raw).
                    </p>
                  {/if}
                </div>

                <!-- Raw content, behind an explicit reveal -->
                <div>
                  <div class="flex items-center gap-3 mb-1">
                    <p class="text-sm font-medium text-shadow-700">Raw held content{detail.rawTextTruncated ? ' (truncated at storage cap)' : ''}</p>
                    <button
                      type="button"
                      class="text-xs px-2 py-1 rounded border border-bark-300 text-shadow-600 hover:bg-bark-100"
                      onclick={() => { rawRevealed = !rawRevealed; }}
                    >
                      {rawRevealed ? 'Hide' : 'Reveal'}
                    </button>
                  </div>
                  {#if rawRevealed}
                    {#if detail.rawText}
                      <pre class="text-xs font-mono text-shadow-800 bg-wilt-50 border border-wilt-200 rounded px-3 py-2 max-h-80 overflow-y-auto whitespace-pre-wrap break-words">{detail.rawText}</pre>
                    {:else}
                      <p class="text-sm text-shadow-600">Content was scrubbed (discarded or expired).</p>
                    {/if}
                  {:else}
                    <p class="text-xs text-shadow-600">Hidden. This is the suspected-hostile content, shown verbatim when revealed.</p>
                  {/if}
                </div>

                <!-- Decision panel -->
                {#if item.status === 'held'}
                  <div class="garden-field-grid border-t border-bark-100 pt-4 space-y-3">
                    <p class="text-sm font-medium text-shadow-700">Decision</p>

                    <label class="garden-field block text-sm text-shadow-800">
                      Reason (required, audited)
                      <textarea
                        class="mt-1 w-full min-h-16 rounded-lg border border-bark-300 px-3 py-2 text-sm"
                        bind:value={reason}
                        placeholder="Why you are releasing or discarding this item."
                      ></textarea>
                    </label>

                    <fieldset class="text-sm text-shadow-800">
                      <legend class="text-sm text-shadow-700">Teach the firewall about this source
                        {#if item.flywheelTarget}
                          (<span class="font-mono">{item.flywheelTarget.kind}: {item.flywheelTarget.pattern}</span>)
                        {/if}
                      </legend>
                      <div class="mt-1 flex flex-wrap gap-4">
                        <label class="flex items-center gap-1.5">
                          <input type="radio" bind:group={sourceListChoice} value="none" /> No list change
                        </label>
                        <label class="flex items-center gap-1.5 {item.flywheelTarget ? '' : 'opacity-50'}">
                          <input type="radio" bind:group={sourceListChoice} value="always_allow" disabled={!item.flywheelTarget} /> Always allow this source
                        </label>
                        <label class="flex items-center gap-1.5 {item.flywheelTarget ? '' : 'opacity-50'}">
                          <input type="radio" bind:group={sourceListChoice} value="always_deny" disabled={!item.flywheelTarget} /> Always deny this source
                        </label>
                      </div>
                      {#if !item.flywheelTarget}
                        <p class="mt-1 text-xs text-shadow-600">Unavailable: this item has no URL host and no canonical contact id to list.</p>
                      {/if}
                    </fieldset>

                    <div class="flex flex-wrap gap-3 pt-1">
                      <button
                        type="button"
                        onclick={() => beginDecision(item, 'release_raw')}
                        disabled={item.ruleMatchProvenanceUnavailable}
                        title={item.ruleMatchProvenanceUnavailable ? 'Rule-match provenance is unavailable; release is disabled' : ''}
                        class="garden-action garden-action--danger px-4 py-2 rounded-lg text-sm font-medium bg-wilt-100 text-wilt-600 hover:bg-wilt-200 transition-colors border border-wilt-200 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Release raw
                      </button>
                      <button
                        type="button"
                        onclick={() => beginDecision(item, 'release_sanitized')}
                        disabled={!item.safeRepresentationAvailable || item.ruleMatchProvenanceUnavailable}
                        title={item.ruleMatchProvenanceUnavailable
                          ? 'Rule-match provenance is unavailable; release is disabled'
                          : item.safeRepresentationAvailable ? '' : 'No safe representation exists for this item'}
                        class="garden-action garden-action--primary px-4 py-2 rounded-lg text-sm font-medium bg-moss-100 text-moss-700 hover:bg-moss-200 transition-colors border border-moss-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Release sanitized
                      </button>
                      <button
                        type="button"
                        onclick={() => beginDecision(item, 'discard')}
                        class="garden-action px-4 py-2 rounded-lg text-sm font-medium bg-bark-100 text-shadow-700 hover:bg-bark-200 transition-colors border border-bark-300"
                      >
                        Discard
                      </button>
                    </div>
                  </div>
                {:else if item.redeliveryRetryAvailable}
                  <div class="garden-field-grid border-t border-bark-100 pt-4 space-y-3">
                    <p class="text-sm font-medium text-wilt-700">Released content was not placed in the active conversation context</p>
                    <label class="garden-field block text-sm text-shadow-800">
                      Retry reason (required, audited)
                      <textarea
                        class="mt-1 w-full min-h-16 rounded-lg border border-bark-300 px-3 py-2 text-sm"
                        bind:value={reason}
                        placeholder="Why conversation placement should be retried."
                      ></textarea>
                    </label>
                    <button
                      type="button"
                      onclick={() => beginRedeliveryRetry(item)}
                      class="garden-action garden-action--primary px-4 py-2 rounded-lg text-sm font-medium bg-moss-100 text-moss-700 hover:bg-moss-200 transition-colors border border-moss-300"
                    >
                      Retry conversation placement
                    </button>
                  </div>
                {/if}
              </div>
            {/if}
          {/if}
        </div>
      </div>
    {/snippet}

    <section class="garden-metric-grid grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-bark-300 bg-bark-300 shadow-sm lg:grid-cols-4" aria-label="Quarantine queue summary">
      <div class="garden-metric bg-surface px-4 py-3">
        <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-shadow-500">Awaiting</p>
        <p class="mt-1 font-serif text-2xl font-semibold text-shadow-900">{heldItems.length}</p>
      </div>
      <div class="garden-metric bg-surface px-4 py-3">
        <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-shadow-500">Fail-closed</p>
        <p class="mt-1 font-serif text-2xl font-semibold text-wilt-600">{failClosedItems.length}</p>
      </div>
      <div class="garden-metric bg-surface px-4 py-3">
        <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-shadow-500">Hostile sources</p>
        <p class="mt-1 font-serif text-2xl font-semibold text-wilt-600">{hostileItems.length}</p>
      </div>
      <div class="garden-metric bg-surface px-4 py-3">
        <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-shadow-500">Recent decisions</p>
        <p class="mt-1 font-serif text-2xl font-semibold text-shadow-900">{decidedItems.length}</p>
      </div>
    </section>

    <div class="garden-toolbar flex flex-wrap gap-2" role="group" aria-label="Filter quarantine items">
      <button type="button" aria-pressed={queueFilter === 'held'} onclick={() => queueFilter = 'held'} class="rounded-xl border px-3 py-2 text-sm font-medium transition-colors {queueFilter === 'held' ? 'border-gold-300 bg-gold-50 text-gold-800' : 'border-bark-300 bg-surface text-shadow-700 hover:border-gold-300'}">Awaiting · {heldItems.length}</button>
      <button type="button" aria-pressed={queueFilter === 'fail_closed'} onclick={() => queueFilter = 'fail_closed'} class="rounded-xl border px-3 py-2 text-sm font-medium transition-colors {queueFilter === 'fail_closed' ? 'border-wilt-300 bg-wilt-50 text-wilt-700' : 'border-bark-300 bg-surface text-shadow-700 hover:border-gold-300'}">Fail-closed · {failClosedItems.length}</button>
      <button type="button" aria-pressed={queueFilter === 'decided'} onclick={() => queueFilter = 'decided'} class="rounded-xl border px-3 py-2 text-sm font-medium transition-colors {queueFilter === 'decided' ? 'border-moss-300 bg-moss-50 text-moss-700' : 'border-bark-300 bg-surface text-shadow-700 hover:border-gold-300'}">Decided · {decidedItems.length}</button>
    </div>

    {#if queueItems.length === 0}
      <div class="garden-empty card-garden p-10 text-center">
        <p class="font-serif text-lg text-shadow-800">No items in this view</p>
        <p class="mt-1 text-sm text-shadow-600">Review is exception-only; the selected queue is clear.</p>
      </div>
    {:else}
      <div class="garden-split-view grid items-start gap-4 xl:grid-cols-[minmax(300px,390px)_minmax(0,1fr)]">
        <aside class="garden-section card-garden overflow-hidden" aria-label="Quarantine review queue">
          <div class="garden-section-header border-b border-bark-200 bg-bark-50 px-4 py-3">
            <h2 class="garden-section-title font-serif text-lg font-semibold text-shadow-900">Review queue</h2>
            <p class="garden-section-description text-xs text-shadow-600">{queueItems.length} item{queueItems.length === 1 ? '' : 's'} · select one to load evidence</p>
          </div>
          <div class="max-h-[68vh] divide-y divide-bark-200 overflow-y-auto">
            {#each queueItems as item (item.id)}
              <button
                type="button"
                onclick={() => void toggleDetail(item)}
                aria-current={selectedItem?.id === item.id ? 'true' : undefined}
                class="w-full border-l-4 px-4 py-3 text-left transition-colors {selectedItem?.id === item.id ? 'border-l-gold-400 bg-gold-50/70' : 'border-l-transparent bg-surface hover:bg-bark-50'}"
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <p class="truncate text-sm font-semibold text-shadow-900">{item.sourceClass}</p>
                    <p class="mt-0.5 truncate font-mono text-[11px] text-shadow-500">{item.originRef}</p>
                  </div>
                  <span class="shrink-0 font-mono text-[11px] text-shadow-500">{item.status === 'held' ? formatTtl(item.ttlRemainingMs) : statusLabel(item.status)}</span>
                </div>
                <div class="mt-2 flex flex-wrap gap-1.5">
                  <span class="garden-status {item.holdReason === 'screener_malfunction' ? 'garden-status--danger' : 'garden-status--warning'} inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold {STATUS_STYLES[queueStatus(item)] ?? 'bg-bark-200 text-shadow-700'}">{statusLabel(queueStatus(item))}</span>
                  <span class="garden-status {item.sourceRiskTier === 'hostile' ? 'garden-status--danger' : item.sourceRiskTier === 'trusted' ? 'garden-status--success' : 'garden-status--warning'} inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold {TIER_STYLES[item.sourceRiskTier] ?? 'bg-bark-200 text-shadow-700'}">Risk: {item.sourceRiskTier}</span>
                </div>
                {#if item.whyFlagged || item.summary}
                  <p class="mt-2 line-clamp-2 text-xs leading-relaxed text-shadow-700">{item.whyFlagged ?? item.summary}</p>
                {/if}
              </button>
            {/each}
          </div>
        </aside>

        <div class="min-w-0 xl:sticky xl:top-28">
          {#if selectedItem}
            {@render itemCard(selectedItem)}
          {:else}
            <div class="garden-empty card-garden p-10 text-center text-sm text-shadow-600">Select a held item to review its evidence.</div>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</div>

<!-- Double-confirm: the modals mirror the SERVER-side two-step token flow. -->
<ConfirmationModal
  open={confirmStage === 'first'}
  title="Are you sure?"
  body={pendingAction && pendingItem
    ? `${ACTION_LABELS[pendingAction]} for this ${pendingItem.sourceClass} item${sourceListChoice !== 'none' ? `, and ${sourceListChoice === 'always_allow' ? 'always allow' : 'always deny'} its source from now on` : ''}. Confirming requests a single-use release token from the server (step 1 of 2).`
    : ''}
  context={pendingItem ? `${pendingItem.originRef} -- ${pendingItem.riskLabels.join(', ') || 'no risk labels'}` : ''}
  confirmLabel="Yes, continue"
  tone={pendingAction === 'release_raw' ? 'danger' : 'primary'}
  busy={confirmBusy}
  onConfirm={handleFirstConfirm}
  onCancel={cancelConfirmFlow}
/>

<ConfirmationModal
  open={confirmStage === 'second'}
  title="Are you *sure* sure?"
  body={pendingAction === 'release_raw'
    ? 'This delivers the suspected-hostile content VERBATIM to the companion-visible pipeline. This is the single most dangerous action in the firewall and cannot be undone (step 2 of 2).'
    : 'This decision is final and fully audited (step 2 of 2).'}
  context={serverSummary}
  confirmLabel={pendingAction ? `${ACTION_LABELS[pendingAction]} -- final` : 'Confirm'}
  tone={pendingAction === 'discard' ? 'primary' : 'danger'}
  busy={confirmBusy}
  onConfirm={handleSecondConfirm}
  onCancel={cancelConfirmFlow}
/>
