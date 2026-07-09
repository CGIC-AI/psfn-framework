<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    confirmIntakeQuarantineDecision,
    decideIntakeQuarantine,
    getIntakeQuarantine,
    getIntakeQuarantineItem,
    type IntakeQuarantineDecisionAction,
  } from '$lib/api/endpoints/intake';
  import type {
    AdminIntakeQuarantineItemDetail,
    AdminIntakeQuarantineItemView,
    AdminIntakeQuarantineSourceListAction,
  } from '$lib/types';
  import ConfirmationModal from '$lib/components/ConfirmationModal.svelte';
  import { pushToast } from '$lib/stores/toast.svelte';

  // ── Queue state ──
  let items = $state<AdminIntakeQuarantineItemView[]>([]);
  let loading = $state(true);
  let error = $state('');
  let endpointMissing = $state(false);

  // ── Detail state (one expanded item at a time) ──
  let expandedId = $state('');
  let detail = $state<AdminIntakeQuarantineItemDetail | null>(null);
  let detailLoading = $state(false);
  let rawRevealed = $state(false);

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

  const ACTION_LABELS: Record<IntakeQuarantineDecisionAction, string> = {
    release_raw: 'Release raw',
    release_sanitized: 'Release sanitized',
    discard: 'Discard',
  };

  const STATUS_STYLES: Record<string, string> = {
    held: 'bg-gold-100 text-gold-700',
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

  async function loadData() {
    loading = true;
    error = '';
    endpointMissing = false;
    try {
      const data = await getIntakeQuarantine();
      items = data.items;
    } catch (e) {
      if (e instanceof Error && e.message.includes('404')) {
        endpointMissing = true;
      } else {
        error = e instanceof Error ? e.message : 'Failed to load quarantine queue';
      }
    } finally {
      loading = false;
    }
  }

  async function toggleDetail(item: AdminIntakeQuarantineItemView) {
    if (expandedId === item.id) {
      expandedId = '';
      detail = null;
      rawRevealed = false;
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

  function cancelConfirmFlow() {
    confirmStage = 'idle';
    confirmBusy = false;
    pendingAction = null;
    pendingItem = null;
    confirmToken = '';
    serverSummary = '';
  }

  // First confirm: request the server-side confirm token (step 1 of 2).
  async function handleFirstConfirm() {
    if (!pendingItem || !pendingAction) return;
    confirmBusy = true;
    try {
      const result = await confirmIntakeQuarantineDecision(pendingItem.id, {
        action: pendingAction,
        ...(sourceListChoice !== 'none' ? { sourceList: sourceListChoice } : {}),
      });
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

  // Second confirm: execute with the single-use token (step 2 of 2).
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

  // ── Auto-refresh every 15s (batched, async — never interrupt-driven) ──
  let refreshInterval: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    loadData();
    refreshInterval = setInterval(() => {
      // Don't reshuffle the queue mid-decision.
      if (confirmStage === 'idle') void loadData();
    }, 15_000);
  });

  onDestroy(() => {
    if (refreshInterval) clearInterval(refreshInterval);
  });
</script>

<svelte:head>
  <title>Cognitive Security: Approvals</title>
</svelte:head>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <p class="text-xs font-semibold uppercase text-moss-700">Cognitive Security</p>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">Quarantine Approvals</h1>
      <p class="text-sm text-shadow-600 mt-1">
        Items the intake firewall held for human review. Only you can release them --
        every release is double-confirmed server-side, and every decision can teach the
        firewall about the source (always allow / always deny).
      </p>
    </div>
    <div class="flex items-center gap-3">
      <span class="text-xs text-shadow-600">Auto-refreshes every 15s</span>
      <button
        onclick={loadData}
        disabled={loading}
        class="text-sm px-3 py-1.5 rounded-lg border border-bark-300 text-shadow-600 hover:bg-bark-100
               transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
      >
        {loading ? 'Loading...' : 'Refresh'}
      </button>
    </div>
  </div>

  {#if loading && items.length === 0}
    <div class="space-y-3">
      {#each Array(3) as _}
        <div class="card-garden p-5 animate-pulse space-y-3">
          <div class="h-4 rounded bg-bark-200 w-2/5"></div>
          <div class="h-3 rounded bg-bark-200 w-3/5"></div>
        </div>
      {/each}
      <p class="text-sm text-shadow-600 px-1">Loading quarantine queue...</p>
    </div>
  {:else if error}
    <div class="card-garden p-6 border-l-4 border-l-wilt-400">
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
    <div class="card-garden p-12 text-center">
      <p class="font-serif text-lg text-shadow-700 mb-1">Nothing in quarantine</p>
      <p class="text-sm text-shadow-600">
        When the intake firewall holds suspicious content for review, it lands here with the
        full screening detail. The companion only ever sees a calm placeholder.
      </p>
    </div>
  {:else}
    {#snippet itemCard(item: AdminIntakeQuarantineItemView)}
      <div class="card-garden overflow-hidden">
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
                <span class="inline-block px-2 py-0.5 rounded-full font-medium {STATUS_STYLES[item.status] ?? 'bg-bark-200 text-shadow-700'}">
                  {statusLabel(item.status)}
                </span>
                <span class="inline-block px-2 py-0.5 rounded-full font-medium {TIER_STYLES[item.sourceRiskTier] ?? 'bg-bark-200 text-shadow-700'}">
                  {item.sourceRiskTier}
                </span>
                <span class="inline-block px-2 py-0.5 rounded-full font-medium {item.mode === 'enforce' ? 'bg-shadow-800 text-white' : 'bg-bark-200 text-shadow-700'}">
                  {item.mode === 'enforce' ? 'enforce (withheld)' : 'shadow (was delivered)'}
                </span>
                {#if item.status === 'held'}
                  <span class="text-shadow-600">TTL {formatTtl(item.ttlRemainingMs)}</span>
                {/if}
              </div>
            </div>
            <span class="text-shadow-500 text-sm shrink-0">{expandedId === item.id ? 'Hide' : 'Review'}</span>
          </div>
        </button>

        <div class="px-5 py-4 space-y-3">
          <div class="flex flex-wrap gap-1.5">
            {#each item.riskLabels as label (label)}
              <span class="inline-block px-2 py-0.5 rounded bg-wilt-50 border border-wilt-200 text-wilt-700 font-mono text-xs">{label}</span>
            {/each}
            {#if item.riskLabels.length === 0}
              <span class="text-xs text-shadow-600">No risk labels (score-driven or fail-closed hold)</span>
            {/if}
          </div>

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

          <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
            <div><span class="text-shadow-600">Held:</span> <span class="ml-1 text-shadow-800">{formatTimestamp(item.heldAt)}</span></div>
            <div><span class="text-shadow-600">Expires:</span> <span class="ml-1 text-shadow-800">{formatTimestamp(item.expiresAt)}</span></div>
            {#if item.canonicalContactId}
              <div><span class="text-shadow-600">Sender:</span> <code class="ml-1 font-mono text-shadow-800 bg-bark-100 px-1.5 py-0.5 rounded">{item.canonicalContactId}</code></div>
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
          </div>

          {#if expandedId === item.id}
            {#if detailLoading}
              <p class="text-sm text-shadow-600">Loading screening detail...</p>
            {:else if detail}
              <div class="space-y-4 border-t border-bark-100 pt-4">
                <!-- Which classifiers fired -->
                <div>
                  <p class="text-sm font-medium text-shadow-700 mb-1">Classifiers fired (calibrated 0-1 scores)</p>
                  <div class="overflow-x-auto">
                    <table class="w-full text-left text-sm">
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
                  <div class="border-t border-bark-100 pt-4 space-y-3">
                    <p class="text-sm font-medium text-shadow-700">Decision</p>

                    <label class="block text-sm text-shadow-800">
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
                        class="px-4 py-2 rounded-lg text-sm font-medium bg-wilt-100 text-wilt-600 hover:bg-wilt-200 transition-colors border border-wilt-200"
                      >
                        Release raw
                      </button>
                      <button
                        type="button"
                        onclick={() => beginDecision(item, 'release_sanitized')}
                        disabled={!item.safeRepresentationAvailable}
                        title={item.safeRepresentationAvailable ? '' : 'No safe representation exists for this item'}
                        class="px-4 py-2 rounded-lg text-sm font-medium bg-moss-100 text-moss-700 hover:bg-moss-200 transition-colors border border-moss-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Release sanitized
                      </button>
                      <button
                        type="button"
                        onclick={() => beginDecision(item, 'discard')}
                        class="px-4 py-2 rounded-lg text-sm font-medium bg-bark-100 text-shadow-700 hover:bg-bark-200 transition-colors border border-bark-300"
                      >
                        Discard
                      </button>
                    </div>
                  </div>
                {/if}
              </div>
            {/if}
          {/if}
        </div>
      </div>
    {/snippet}

    <div class="space-y-4">
      <h2 class="font-serif text-lg text-shadow-800">Awaiting review ({heldItems.length})</h2>
      {#if heldItems.length === 0}
        <div class="card-garden p-6 text-center">
          <p class="text-sm text-shadow-600">The queue is clear. Review is exception-only -- nothing needs you right now.</p>
        </div>
      {/if}
      {#each heldItems as item (item.id)}
        {@render itemCard(item)}
      {/each}

      {#if decidedItems.length > 0}
        <h2 class="font-serif text-lg text-shadow-800 pt-2">Recent decisions ({decidedItems.length})</h2>
        {#each decidedItems as item (item.id)}
          {@render itemCard(item)}
        {/each}
      {/if}
    </div>
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
