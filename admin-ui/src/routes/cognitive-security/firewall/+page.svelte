<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getIntakePolicy,
    getIntakeSourceLists,
    mutateIntakeSourceList,
  } from '$lib/api/endpoints/intake';
  import { listCogSecEvents } from '$lib/api/endpoints/sessions';
  import type {
    AdminCogSecEventListData,
    IntakePolicyConfig,
    IntakeSourceListName,
    IntakeSourceListsConfig,
  } from '$lib/types';
  import { pushToast } from '$lib/stores/toast.svelte';

  let policy = $state<IntakePolicyConfig | null>(null);
  let lists = $state<IntakeSourceListsConfig | null>(null);
  let cogSecEvents = $state<AdminCogSecEventListData['events']>([]);
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
    off: 'bg-bark-200 text-shadow-700',
    shadow: 'bg-gold-100 text-gold-700',
    enforce: 'bg-moss-100 text-moss-700',
  };

  const TIER_ORDER = ['trusted', 'standard', 'untrusted', 'hostile'] as const;

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
    mutating = true;
    try {
      const result = await mutateIntakeSourceList({ action, list, pattern: trimmed });
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

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <p class="text-xs font-semibold uppercase text-moss-700">Cognitive Security</p>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">Intake Firewall</h1>
      <p class="text-sm text-shadow-600 mt-1">
        The intake-policy configuration (mode, source risk tiers, escalation thresholds, source lists)
        plus recent CogSec events. Edit thresholds via Settings &rarr; intake-policy; source lists are
        editable here and fed by Approvals-page decisions (the flywheel).
      </p>
    </div>
    <button
      onclick={loadData}
      disabled={loading}
      class="text-sm px-3 py-1.5 rounded-lg border border-bark-300 text-shadow-600 hover:bg-bark-100
             transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
    >
      {loading ? 'Loading...' : 'Refresh'}
    </button>
  </div>

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
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="card-garden p-5">
        <p class="text-xs uppercase font-semibold text-shadow-600">Mode</p>
        <p class="mt-2">
          <span class="inline-block px-3 py-1 rounded-full text-sm font-semibold {MODE_STYLES[policy.mode] ?? 'bg-bark-200 text-shadow-700'}">{policy.mode}</span>
        </p>
        <p class="mt-2 text-xs text-shadow-600">
          {policy.mode === 'enforce'
            ? 'Sink gates enforce screening decisions; quarantined content is withheld.'
            : policy.mode === 'shadow'
              ? 'Observe-only: envelopes are screened and journaled, nothing is withheld.'
              : 'Firewall off: no intake screening is wired anywhere.'}
        </p>
      </div>
      <div class="card-garden p-5">
        <p class="text-xs uppercase font-semibold text-shadow-600">Quarantine TTL</p>
        <p class="mt-2 text-2xl font-serif text-shadow-900">{policy.quarantine.itemTtlHours}h</p>
        <p class="mt-1 text-xs text-shadow-600">Held items expire after this window.</p>
      </div>
      <div class="card-garden p-5">
        <p class="text-xs uppercase font-semibold text-shadow-600">Max held items</p>
        <p class="mt-2 text-2xl font-serif text-shadow-900">{policy.quarantine.maxHeldItems}</p>
        <p class="mt-1 text-xs text-shadow-600">Oldest held items expire early beyond this.</p>
      </div>
    </div>

    <!-- Source risk tiers -->
    <div class="card-garden p-5">
      <h2 class="font-serif text-lg text-shadow-900 mb-1">Source risk tiers</h2>
      <p class="text-sm text-shadow-600 mb-3">Every inbound surface maps to a tier; scrutiny scales with the tier (source lists adjust it per origin).</p>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm min-w-[480px]">
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
        L2 model: <span class="font-mono text-xs">{policy.l2Screener.model}</span> ·
        L3 model: <span class="font-mono text-xs">{policy.l3Screener.model}{policy.l3Screener.dualModel && policy.l3Screener.secondaryModel ? ` + ${policy.l3Screener.secondaryModel}` : ''}</span>
      </p>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm min-w-[640px]">
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
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm min-w-[640px]">
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
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
