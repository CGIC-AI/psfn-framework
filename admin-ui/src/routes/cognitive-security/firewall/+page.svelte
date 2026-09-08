<script lang="ts">
  import { onMount } from 'svelte';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import {
    getBlindReviewState,
    getIntakePolicy,
    getIntakeSourceLists,
    mutateIntakeSourceList,
  } from '$lib/api/endpoints/intake';
  import type {
    AdminBlindReviewStateView,
  } from '../../../../../src/operator/garden/services/blind-review-service.js';
  import { listCogSecEvents } from '$lib/api/endpoints/sessions';
  import type {
    AdminCogSecEventListData,
    IntakePolicyConfig,
    IntakeSourceListName,
    IntakeSourceListsConfig,
  } from '$lib/types';
  import { getCompanionName } from '$lib/stores/companion.svelte';
  import { pushToast } from '$lib/stores/toast.svelte';

  let policy = $state<IntakePolicyConfig | null>(null);
  let lists = $state<IntakeSourceListsConfig | null>(null);
  let cogSecEvents = $state<AdminCogSecEventListData['events']>([]);
  let blindReview = $state<AdminBlindReviewStateView | null>(null);
  let loading = $state(true);
  let error = $state('');
  let endpointMissing = $state(false);

  // Add-entry form state per list.
  let addPattern = $state<Record<IntakeSourceListName, string>>({
    trustedSites: '', deniedSites: '', trustedPeople: '', deniedPeople: '',
  });
  let mutating = $state(false);

  const SOURCE_LIST_META: Array<{ name: IntakeSourceListName; label: string; hint: string; accent: string }> = [
    { name: 'trustedSites', label: 'Trusted sites', hint: "Exact host or '*.domain.tld'. Lowers the source risk tier one step -- L1 scanning always still runs.", accent: 'moss' },
    { name: 'deniedSites', label: 'Denied sites', hint: 'Raises the source risk tier to hostile (mandatory deep screening).', accent: 'wilt' },
    { name: 'trustedPeople', label: 'Trusted people', hint: 'Canonical contact ids, matched exactly.', accent: 'moss' },
    { name: 'deniedPeople', label: 'Denied people', hint: 'Canonical contact ids, matched exactly.', accent: 'wilt' },
  ];

  const MODE_STYLES: Record<string, string> = {
    shadow: 'bg-gold-100 text-gold-700',
    boundary: 'bg-moss-100 text-moss-700',
    strict: 'bg-wilt-100 text-wilt-700',
  };

  const TIER_ORDER = ['trusted', 'standard', 'untrusted', 'hostile'] as const;

  const BLIND_REVIEW_STATUS_LABELS: Record<AdminBlindReviewStateView['status'], string> = {
    disabled: 'disabled',
    unwired: 'enabled, not wired',
    never_run: 'no pass yet',
    running: 'running',
  };

  const BLIND_REVIEW_STATUS_STYLES: Record<AdminBlindReviewStateView['status'], string> = {
    disabled: 'bg-bark-200 text-shadow-700',
    unwired: 'bg-wilt-100 text-wilt-600',
    never_run: 'bg-gold-100 text-gold-700',
    running: 'bg-moss-100 text-moss-700',
  };

  const BLIND_REVIEW_GATE_LABELS: Record<AdminBlindReviewStateView['gate']['nextPassGate'], string> = {
    no_evidence: 'no unreviewed evidence -- no model call',
    undersized_items: 'backlog below the batch floor -- deferred, no model call',
    eligible: 'clears the count gates -- a pass may call the reviewer',
  };

  /** Owner-file durations read as hours/minutes/days, not as raw milliseconds. */
  function formatDuration(ms: number): string {
    if (ms <= 0) return '0';
    const days = ms / 86_400_000;
    if (days >= 1) return `${Number(days.toFixed(days < 10 ? 1 : 0))}d`;
    const hours = ms / 3_600_000;
    if (hours >= 1) return `${Number(hours.toFixed(hours < 10 ? 1 : 0))}h`;
    const minutes = ms / 60_000;
    if (minutes >= 1) return `${Number(minutes.toFixed(minutes < 10 ? 1 : 0))}m`;
    return `${Math.round(ms / 1_000)}s`;
  }

  function formatTimestamp(value: string | number): string {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
  }

  async function loadData() {
    loading = true;
    error = '';
    endpointMissing = false;
    try {
      const [policyData, listData] = await Promise.all([getIntakePolicy(), getIntakeSourceLists()]);
      policy = policyData.policy;
      lists = listData.lists;
    } catch (e) {
      if (e instanceof Error && e.message.includes('404')) {
        endpointMissing = true;
      } else {
        error = e instanceof Error ? e.message : 'Failed to load intake policy';
      }
    } finally {
      loading = false;
    }
    // The Blind Reviewer projection rides its own endpoint; a deployment that
    // does not serve it must not blank the page, but it must not look healthy
    // either — the section is simply absent, never rendered as an empty window.
    try {
      blindReview = await getBlindReviewState();
    } catch {
      blindReview = null;
    }
    // CogSec telemetry rides a separate endpoint; its absence must not blank the page.
    try {
      const events = await listCogSecEvents();
      cogSecEvents = events.events;
    } catch {
      cogSecEvents = [];
    }
  }

  async function handleMutation(list: IntakeSourceListName, action: 'add' | 'remove', pattern: string) {
    const trimmed = pattern.trim();
    if (!trimmed) {
      pushToast('Pattern must be non-empty.', 'error');
      return;
    }
    const statedReason = window.prompt(
      `Why are you ${action === 'add' ? 'adding' : 'removing'} this CogSec source-list entry?`,
    )?.trim() ?? '';
    if (!statedReason) {
      pushToast('A reason is required for an audited CogSec change.', 'error');
      return;
    }
    mutating = true;
    try {
      const result = await mutateIntakeSourceList(
        { action, list, pattern: trimmed },
        statedReason,
      );
      if (result.ok) {
        pushToast(result.message || `${action === 'add' ? 'Added to' : 'Removed from'} ${list}.`, 'success');
        if (result.lists) lists = result.lists;
        if (action === 'add') addPattern = { ...addPattern, [list]: '' };
      } else {
        pushToast(result.message || 'Source-list mutation failed.', 'error');
      }
    } catch (e) {
      pushToast(e instanceof Error ? e.message : 'Source-list mutation failed', 'error');
    } finally {
      mutating = false;
    }
  }

  onMount(() => {
    void loadData();
  });
</script>

<svelte:head>
  <title>Cognitive Security: Firewall</title>
</svelte:head>

<div class="garden-page space-y-5">
  <GardenPageHeader
    eyebrow="Cognitive Security · Intake policy"
    title="Intake Firewall"
    description="Inspect enforcement posture, source risk tiers, escalation thresholds, and the allow/deny flywheel that gates inbound context."
  >
    {#snippet actions()}
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

  {#if loading && !policy}
    <div class="card-garden p-5 animate-pulse space-y-3">
      <div class="h-4 rounded bg-bark-200 w-2/5"></div>
      <div class="h-3 rounded bg-bark-200 w-3/5"></div>
    </div>
  {:else if error}
    <div class="card-garden p-6 border-l-4 border-l-wilt-400">
      <p class="text-sm text-shadow-800">{error}</p>
    </div>
  {:else if endpointMissing}
    <div class="card-garden p-6">
      <p class="text-sm text-shadow-800">Requires the agent runtime</p>
      <p class="text-sm text-shadow-600 mt-2">
        Firewall policy is read from <code class="font-mono bg-bark-100 px-1 rounded">intake-policy.json</code>
        through the runtime's admin surface.
      </p>
    </div>
  {:else if policy && lists}
    <!-- Mode + quarantine limits -->
    <div class="garden-metric-grid grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="garden-metric card-garden p-5">
        <p class="text-xs uppercase font-semibold text-shadow-600">Mode</p>
        <p class="mt-2">
          <span class="inline-block px-3 py-1 rounded-full text-sm font-semibold {MODE_STYLES[policy.mode] ?? 'bg-bark-200 text-shadow-700'}">{policy.mode}</span>
        </p>
        <p class="mt-2 text-xs text-shadow-600">
          {policy.mode === 'strict'
            ? 'All declared CogSec vectors are screened and enforced.'
            : policy.mode === 'boundary'
              ? 'External ingress and publication are enforced; authenticated internal work stays in the clean bubble.'
              : 'Observe-only: every declared vector is evaluated and recorded, nothing is withheld.'}
        </p>
      </div>
      <div class="garden-metric card-garden p-5">
        <p class="text-xs uppercase font-semibold text-shadow-600">Quarantine TTL</p>
        <p class="mt-2 text-2xl font-serif text-shadow-900">{policy.quarantine.itemTtlHours}h</p>
        <p class="mt-1 text-xs text-shadow-600">Held items expire after this window.</p>
      </div>
      <div class="garden-metric card-garden p-5">
        <p class="text-xs uppercase font-semibold text-shadow-600">Max held items</p>
        <p class="mt-2 text-2xl font-serif text-shadow-900">{policy.quarantine.maxHeldItems}</p>
        <p class="mt-1 text-xs text-shadow-600">Oldest held items expire early beyond this.</p>
      </div>
    </div>

    <!-- Source risk tiers -->
    <div class="card-garden p-5">
      <h2 class="font-serif text-lg text-shadow-900 mb-1">Source risk tiers</h2>
      <p class="text-sm text-shadow-600 mb-3">Every inbound surface maps to a tier; scrutiny scales with the tier (source lists adjust it per origin).</p>
      <div class="garden-table-shell garden-table-scroll overflow-x-auto rounded-xl border border-bark-200">
        <table class="garden-table w-full text-left text-sm min-w-[480px]">
          <thead class="text-xs uppercase text-shadow-600 border-b border-bark-200">
            <tr><th class="px-2 py-1.5 font-semibold">Source class</th><th class="px-2 py-1.5 font-semibold">Tier</th></tr>
          </thead>
          <tbody>
            {#each Object.entries(policy.sourceRiskTiers) as [sourceClass, tier] (sourceClass)}
              <tr class="border-b border-bark-100">
                <td class="px-2 py-1.5 font-mono text-xs">{sourceClass}</td>
                <td class="px-2 py-1.5">
                  <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium
                    {tier === 'hostile' ? 'bg-wilt-100 text-wilt-600' : tier === 'untrusted' ? 'bg-gold-100 text-gold-700' : tier === 'trusted' ? 'bg-moss-100 text-moss-700' : 'bg-bark-200 text-shadow-700'}">
                    {tier}
                  </span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Escalation thresholds -->
    <div class="card-garden p-5">
      <h2 class="font-serif text-lg text-shadow-900 mb-1">Escalation thresholds by tier</h2>
      <p class="text-sm text-shadow-600 mb-3">
        L1.5 classifier: <span class="font-mono text-xs">label threshold {policy.injectionClassifier.labelThreshold}</span> ·
        L2 lane: <span class="font-mono text-xs">background purpose</span> ·
        L3 lane: <span class="font-mono text-xs">reasoning purpose{policy.l3Screener.dualModel ? ' + background purpose' : ''}</span>
      </p>
      <div class="garden-table-shell garden-table-scroll overflow-x-auto rounded-xl border border-bark-200">
        <table class="garden-table w-full text-left text-sm min-w-[640px]">
          <thead class="text-xs uppercase text-shadow-600 border-b border-bark-200">
            <tr>
              <th class="px-2 py-1.5 font-semibold">Tier</th>
              <th class="px-2 py-1.5 font-semibold">L1.5 score signal &ge;</th>
              <th class="px-2 py-1.5 font-semibold">L2 escalation &ge;</th>
              <th class="px-2 py-1.5 font-semibold">L2 fail-closed</th>
              <th class="px-2 py-1.5 font-semibold">L3 escalation confidence &ge;</th>
              <th class="px-2 py-1.5 font-semibold">Mandatory</th>
            </tr>
          </thead>
          <tbody>
            {#each TIER_ORDER as tier (tier)}
              <tr class="border-b border-bark-100">
                <td class="px-2 py-1.5 font-medium">{tier}</td>
                <td class="px-2 py-1.5 font-mono text-xs">{policy.injectionClassifier.scoreThresholdsByTier[tier]}</td>
                <td class="px-2 py-1.5 font-mono text-xs">{policy.l2Screener.escalationThresholdsByTier[tier]}</td>
                <td class="px-2 py-1.5 font-mono text-xs">{policy.l2Screener.failClosedActionByTier[tier]}</td>
                <td class="px-2 py-1.5 font-mono text-xs">{policy.l3Screener.escalationConfidenceThresholdsByTier[tier]}</td>
                <td class="px-2 py-1.5 text-xs">
                  {[
                    policy.l2Screener.mandatoryTiers.includes(tier) ? 'L2' : null,
                    policy.l3Screener.mandatoryTiers.includes(tier) ? 'L3' : null,
                  ].filter(Boolean).join(' + ') || '--'}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Sink gates -->
    <div class="card-garden p-5">
      <h2 class="font-serif text-lg text-shadow-900 mb-1">Sink gates</h2>
      <p class="text-sm text-shadow-600 mb-3">Per-sink caps: content above the tier cap (or carrying a denied label) may never drive that sink.</p>
      <div class="garden-table-shell garden-table-scroll overflow-x-auto rounded-xl border border-bark-200">
        <table class="garden-table w-full text-left text-sm min-w-[640px]">
          <thead class="text-xs uppercase text-shadow-600 border-b border-bark-200">
            <tr>
              <th class="px-2 py-1.5 font-semibold">Sink</th>
              <th class="px-2 py-1.5 font-semibold">Max source risk tier</th>
              <th class="px-2 py-1.5 font-semibold">Denied labels</th>
              <th class="px-2 py-1.5 font-semibold">Unscreened content</th>
            </tr>
          </thead>
          <tbody>
            {#each Object.entries(policy.sinkGates.sinks) as [sink, rule] (sink)}
              <tr class="border-b border-bark-100">
                <td class="px-2 py-1.5 font-mono text-xs">{sink}</td>
                <td class="px-2 py-1.5 font-mono text-xs">{rule.maxSourceRiskTier}</td>
                <td class="px-2 py-1.5 font-mono text-xs break-words">{rule.denyRiskLabels.join(', ') || '--'}</td>
                <td class="px-2 py-1.5 font-mono text-xs">{rule.unscreened}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="mt-2 text-xs text-shadow-600">
        Trifecta enforcement by tier:
        {#each TIER_ORDER as tier, index (tier)}
          <span class="font-mono">{tier}={policy.sinkGates.trifecta.enforcementByTier[tier]}</span>{index < TIER_ORDER.length - 1 ? ' · ' : ''}
        {/each}
      </p>
    </div>

    <!-- Source lists (the flywheel state) -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {#each SOURCE_LIST_META as meta (meta.name)}
        <div class="card-garden p-5">
          <h2 class="font-serif text-lg text-shadow-900">{meta.label} <span class="text-sm text-shadow-600 font-sans">({lists[meta.name].length})</span></h2>
          <p class="text-xs text-shadow-600 mt-1 mb-3">{meta.hint}</p>

          {#if lists[meta.name].length === 0}
            <p class="text-sm text-shadow-600 mb-3">Empty.</p>
          {:else}
            <ul class="space-y-1.5 mb-3">
              {#each lists[meta.name] as entry (entry.pattern)}
                <li class="flex items-start justify-between gap-2 text-sm bg-bark-50 border border-bark-200 rounded px-2 py-1.5">
                  <div class="min-w-0">
                    <code class="font-mono text-xs text-shadow-900 break-all">{entry.pattern}</code>
                    <p class="text-xs text-shadow-600">
                      {entry.addedBy} · {formatTimestamp(entry.addedAt)}{entry.note ? ` · ${entry.note}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={mutating}
                    onclick={() => handleMutation(meta.name, 'remove', entry.pattern)}
                    class="shrink-0 text-xs px-2 py-1 rounded border border-wilt-200 text-wilt-600 hover:bg-wilt-50 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </li>
              {/each}
            </ul>
          {/if}

          <form
            class="flex gap-2"
            onsubmit={(event) => { event.preventDefault(); void handleMutation(meta.name, 'add', addPattern[meta.name]); }}
          >
            <input
              class="w-full rounded-lg border border-bark-300 px-3 py-1.5 font-mono text-sm"
              bind:value={addPattern[meta.name]}
              placeholder={meta.name.endsWith('Sites') ? 'arxiv.org or *.arxiv.org' : 'canonical contact id'}
            />
            <button
              type="submit"
              disabled={mutating}
              class="shrink-0 text-sm px-3 py-1.5 rounded-lg border font-medium disabled:opacity-50
                {meta.accent === 'moss' ? 'border-moss-300 bg-moss-100 text-moss-700 hover:bg-moss-200' : 'border-wilt-200 bg-wilt-100 text-wilt-600 hover:bg-wilt-200'}"
            >
              Add
            </button>
          </form>
        </div>
      {/each}
    </div>

    <!-- Blind Reviewer state (33xah): the reviewer's own health, never its findings -->
    {#if blindReview}
      <div class="card-garden p-5">
        <div class="flex flex-wrap items-center gap-2 mb-1">
          <h2 class="font-serif text-lg text-shadow-900">Blind Reviewer</h2>
          <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium {BLIND_REVIEW_STATUS_STYLES[blindReview.status]}">
            {BLIND_REVIEW_STATUS_LABELS[blindReview.status]}
          </span>
          {#if blindReview.retry.backingOff}
            <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-gold-100 text-gold-700">
              backing off
            </span>
          {/if}
          {#if blindReview.retry.attemptsExhausted}
            <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-wilt-100 text-wilt-600">
              attempts exhausted
            </span>
          {/if}
        </div>
        <p class="text-sm text-shadow-600 mb-3">
          The passive reviewer's own state. Counts and bounds only &mdash; no evidence, no batch
          digest, and no findings (those arrive as CogSec cases above). The deterministic change
          gate is what keeps unchanged or undersized batches from costing a model call at all.
        </p>

        {#if blindReview.status === 'disabled'}
          <p class="text-sm text-shadow-600">
            Disabled in <code class="font-mono">scheduler.json</code> (<code class="font-mono">blindReviewer.enabled</code>).
          </p>
        {:else if blindReview.status === 'unwired'}
          <p class="text-sm text-wilt-600">
            Enabled, but no durable review window is composed in this process &mdash; the reviewer
            requires a PostgreSQL URL and is not running.
          </p>
        {:else}
          <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            <div>
              <dt class="text-xs text-shadow-500">Window rows</dt>
              <dd class="font-mono text-shadow-800">
                {blindReview.window.total} / {blindReview.window.maxRows}{blindReview.window.atRowCeiling ? ' (at cap)' : ''}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-shadow-500">Unreviewed</dt>
              <dd class="font-mono text-shadow-800">{blindReview.window.unreviewed}</dd>
            </div>
            <div>
              <dt class="text-xs text-shadow-500">Pinned to cases</dt>
              <dd class="font-mono text-shadow-800">
                {blindReview.window.pinned} / {blindReview.window.maxPinnedRows}{blindReview.window.atPinCeiling ? ' (at cap)' : ''}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-shadow-500">Retention</dt>
              <dd class="font-mono text-shadow-800">{formatDuration(blindReview.window.retentionMs)}</dd>
            </div>
            <div>
              <dt class="text-xs text-shadow-500">Last pass</dt>
              <dd class="font-mono text-shadow-800">
                {blindReview.updatedAtMs === 0 ? 'never' : formatTimestamp(blindReview.updatedAtMs)}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-shadow-500">Evidence ingested through</dt>
              <dd class="font-mono text-shadow-800">
                {blindReview.ingestedThroughMs === 0 ? 'never' : formatTimestamp(blindReview.ingestedThroughMs)}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-shadow-500">Reviewed a batch</dt>
              <dd class="font-mono text-shadow-800">{blindReview.hasReviewedBatch ? 'yes' : 'not yet'}</dd>
            </div>
            <div>
              <dt class="text-xs text-shadow-500">Retry attempt</dt>
              <dd class="font-mono text-shadow-800">
                {blindReview.retry.attempt} / {blindReview.retry.maxAttempts}
              </dd>
            </div>
            <div class="col-span-2">
              <dt class="text-xs text-shadow-500">Model calls avoided by the gate</dt>
              <dd class="font-mono text-shadow-800">
                {blindReview.gate.modelCallsAvoided}
                <span class="text-xs text-shadow-500">
                  (last {blindReview.gate.modelCallsAvoidedAtMs === 0
                    ? 'never'
                    : formatTimestamp(blindReview.gate.modelCallsAvoidedAtMs)})
                </span>
              </dd>
              <p class="mt-0.5 text-xs text-shadow-500">
                Cumulative over the lane's whole life, counted only when the gate actually refused a
                candidate batch &mdash; an idle window adds nothing. It never decreases and a restart
                does not reset it.
              </p>
            </div>
            <div class="col-span-2">
              <dt class="text-xs text-shadow-500">Effective cadence</dt>
              <dd class="font-mono text-shadow-800">
                {formatDuration(blindReview.cadence.effectiveIntervalMs)}
              </dd>
              <p class="mt-0.5 text-xs text-shadow-500">
                max(blindReviewer.intervalMs {formatDuration(blindReview.cadence.intervalMs)},
                backgroundMaintenance.intervalMs {formatDuration(blindReview.cadence.backgroundMaintenanceIntervalMs)})
                &mdash; the lane is due-gated on top of the maintenance tick, so it can never run more often than that tick.
              </p>
            </div>
            <div class="col-span-2">
              <dt class="text-xs text-shadow-500">Next pass, change gate</dt>
              <dd class="text-shadow-800">{BLIND_REVIEW_GATE_LABELS[blindReview.gate.nextPassGate]}</dd>
              <p class="mt-0.5 text-xs text-shadow-500">
                Batch floor {blindReview.gate.minItemsPerBatch}, ceiling {blindReview.gate.maxItemsPerBatch},
                at most {blindReview.gate.maxReviewsPerRun} model call{blindReview.gate.maxReviewsPerRun === 1 ? '' : 's'} per pass.
                A batch identical to the last reviewed one is retired without a call; that check needs the
                evidence itself, so it is not previewed here.
              </p>
            </div>
          </dl>
        {/if}
      </div>
    {/if}

    <!-- Recent CogSec events -->
    <div class="card-garden p-5">
      <h2 class="font-serif text-lg text-shadow-900 mb-1">Recent CogSec events</h2>
      <p class="text-sm text-shadow-600 mb-3">
        Safe operator-visible projections (no payloads). Intake-firewall events cover screening
        escalations and quarantine decisions; remediation events come from the Remediation page.
      </p>
      {#if cogSecEvents.length === 0}
        <p class="text-sm text-shadow-600">No CogSec events recorded.</p>
      {:else}
        <div class="space-y-2">
          {#each cogSecEvents.slice(0, 15) as event (event.caseId)}
            <div class="rounded border px-3 py-2 {event.type === 'intake_firewall' ? 'border-gold-200 bg-gold-50' : 'border-bark-200 bg-bark-50'}">
              <div class="flex flex-wrap items-center gap-2 text-xs">
                <code class="font-mono text-shadow-800">{event.caseId}</code>
                <span class="inline-block px-2 py-0.5 rounded-full font-medium {event.severity === 'high' || event.severity === 'critical' ? 'bg-wilt-100 text-wilt-600' : 'bg-bark-200 text-shadow-700'}">{event.severity}</span>
                <span class="text-shadow-600">{event.type} / {event.status}</span>
                <span class="text-shadow-600">{formatTimestamp(event.createdAt)}</span>
              </div>
              <p class="mt-1 text-sm text-shadow-800">{event.safeSummary}</p>
              {#if event.personaMutationAttempt}
                <dl class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                  <div>
                    <dt class="text-shadow-500">Companion</dt>
                    <dd class="text-shadow-800">{getCompanionName()}</dd>
                  </div>
                  <div>
                    <dt class="text-shadow-500">Tool</dt>
                    <dd class="font-mono text-shadow-800">{event.personaMutationAttempt.tool}</dd>
                  </div>
                  <div>
                    <dt class="text-shadow-500">Protected owner</dt>
                    <dd class="font-mono text-shadow-800">{event.personaMutationAttempt.pathClass}</dd>
                  </div>
                  <div>
                    <dt class="text-shadow-500">Occurrences</dt>
                    <dd class="font-mono text-shadow-800">{event.personaMutationAttempt.occurrenceCount}</dd>
                  </div>
                </dl>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
