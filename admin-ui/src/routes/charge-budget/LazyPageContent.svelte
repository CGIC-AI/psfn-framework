<script lang="ts">
  import { onMount } from 'svelte';
  import BoundedList from '$lib/components/garden/BoundedList.svelte';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import AccountingCockpit from '$lib/components/accounting/AccountingCockpit.svelte';
  import HumanAttentionPressurePanel from './HumanAttentionPressurePanel.svelte';
  import { accountingSearchParamsForTab } from '$lib/accounting/query-state';
  import { snapshotReactiveState } from '$lib/state/reactive-snapshot.svelte';
  import {
    getCharges,
    type AdminChargeLedgerData,
    type RunChargeLedgerEntry,
    type RunChargeRunSummary,
  } from '$lib/api/endpoints/charges';
  import { getSubConfig, saveSubConfig } from '$lib/api/endpoints/settings';
  import {
    CHARGE_POLICY_REFERENCE_MODEL_CLASS_VALUES,
    CHARGE_POLICY_RUNTIME_LANE_VALUES,
    CHARGE_POLICY_SURFACE_VALUES,
    type ChargePolicyConfig,
    type ChargePolicyReferenceModelClass,
    type ChargePolicyRuntimeLane,
    type ChargePolicySurface,
  } from '../../../../src/shared/contracts/charge-policy.js';

  interface MergedRunRow {
    runId: string;
    rootRunId: string;
    when: number;
    amount: number;
    eventCount: number;
    lineageLabel: string;
    models: string[];
    entries: RunChargeLedgerEntry[];
    summarized: boolean;
  }

  const now = () => Date.now();
  const DAY_MS = 86_400_000;
  const DASH = '-';
  const LANE_VALUES = CHARGE_POLICY_RUNTIME_LANE_VALUES;
  const SURFACE_VALUES = CHARGE_POLICY_SURFACE_VALUES;
  const REFERENCE_MODEL_CLASS_VALUES = CHARGE_POLICY_REFERENCE_MODEL_CLASS_VALUES;

  let charges = $state<AdminChargeLedgerData | null>(null);
  let policy = $state<ChargePolicyConfig | null>(null);
  let activeTab = $state<'charges' | 'token-usage'>('charges');
  let dayWindow = $state<AdminChargeLedgerData | null>(null);
  let monthWindow = $state<AdminChargeLedgerData | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let errorMessage = $state('');
  let policyError = $state('');
  let saveMessage = $state('');
  let saveOk = $state(true);
  let saving = $state(false);
  let rawEditorOpen = $state(false);
  let rawJson = $state('');
  let initialPolicyJson = $state('');
  let expandedRunIds = $state<string[]>([]);

  let policyValidationErrors = $derived.by(() => (
    policy ? validatePolicy(policy) : []
  ));

  let policyDirty = $derived.by(() => {
    if (!policy) return false;
    if (rawEditorOpen) return rawJson !== initialPolicyJson;
    return serializePolicy(policy) !== initialPolicyJson;
  });

  let activeRun = $derived(charges?.activeRun ?? null);
  let recentRuns = $derived(charges?.recentRuns ?? []);
  let recentEvents = $derived(charges?.events ?? []);
  let humanAttention = $derived(charges?.humanAttention ?? null);
  let humanAttentionPolicy = $derived(
    charges?.humanAttentionPolicy ?? policy?.fatigue.humanAttention ?? null,
  );

  let mergedRuns = $derived.by<MergedRunRow[]>(() => {
    const entriesByRun = new Map<string, RunChargeLedgerEntry[]>();
    for (const entry of recentEvents) {
      const runId = entry.event.lineage.runId;
      const bucket = entriesByRun.get(runId);
      if (bucket) bucket.push(entry);
      else entriesByRun.set(runId, [entry]);
    }
    for (const bucket of entriesByRun.values()) {
      bucket.sort((left, right) => right.event.timestampMs - left.event.timestampMs);
    }

    const rows: MergedRunRow[] = recentRuns.map(run => ({
      runId: run.runId,
      rootRunId: run.rootRunId,
      when: run.updatedAtMs,
      amount: run.amount,
      eventCount: run.eventCount,
      lineageLabel: runLineageLabel(run),
      models: run.models,
      entries: entriesByRun.get(run.runId) ?? [],
      summarized: true,
    }));

    const summarizedIds = new Set(recentRuns.map(run => run.runId));
    for (const [runId, entries] of entriesByRun) {
      if (summarizedIds.has(runId)) continue;
      const lineage = entries[0]?.event.lineage;
      const labels: string[] = [];
      if (lineage && lineage.rootRunId !== runId) labels.push(`root ${shortId(lineage.rootRunId)}`);
      if (lineage?.parentRunId) labels.push(`parent ${shortId(lineage.parentRunId)}`);
      const models = [...new Set(
        entries.map(entry => entry.metadata?.model).filter((model): model is string => Boolean(model)),
      )];
      rows.push({
        runId,
        rootRunId: lineage?.rootRunId ?? runId,
        when: entries[0]?.event.timestampMs ?? 0,
        amount: entries.reduce((sum, entry) => sum + entry.event.amount, 0),
        eventCount: entries.length,
        lineageLabel: labels.join(' | '),
        models,
        entries,
        summarized: false,
      });
    }

    return rows.sort((left, right) => right.when - left.when);
  });

  let mergedEventCount = $derived(mergedRuns.reduce((sum, row) => sum + row.entries.length, 0));
  let lineageRootCount = $derived(new Set(mergedRuns.map(row => row.rootRunId)).size);

  async function loadAll(): Promise<void> {
    errorMessage = '';
    policyError = '';
    saveMessage = '';
    const timestamp = now();

    try {
      const [chargeData, policyJson, dayData, monthData] = await Promise.all([
        getCharges({ limit: 200 }),
        getSubConfig('charge-policy'),
        getCharges({ limit: 500, sinceMs: timestamp - DAY_MS }),
        getCharges({ limit: 500, sinceMs: timestamp - 30 * DAY_MS }),
      ]);
      charges = chargeData;
      dayWindow = dayData;
      monthWindow = monthData;
      rawJson = prettyJson(policyJson);
      initialPolicyJson = rawJson;
      policy = JSON.parse(rawJson) as ChargePolicyConfig;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Failed to load charge data.';
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  function prettyJson(json: string): string {
    return JSON.stringify(JSON.parse(json), null, 2);
  }

  function serializePolicy(nextPolicy: ChargePolicyConfig): string {
    return JSON.stringify(nextPolicy, null, 2);
  }

  function formatCharge(amount: number | undefined): string {
    if (amount === undefined || !Number.isFinite(amount)) return DASH;
    if (amount === 0) return '0';
    if (Math.abs(amount) < 1) return amount.toFixed(3);
    return amount.toFixed(2);
  }

  function formatInteger(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) return '0';
    return new Intl.NumberFormat('en-US').format(value);
  }


  function formatTime(timestampMs: number | undefined): string {
    if (!timestampMs) return DASH;
    return new Date(timestampMs).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function labelize(value: string): string {
    return value
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, char => char.toUpperCase());
  }

  function policyKey(prefix: string, key: string): string {
    return `${prefix}.${key}`;
  }

  function shortId(id: string): string {
    return id.length > 12 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
  }

  function runLineageLabel(run: RunChargeRunSummary): string {
    const labels = [`depth ${run.lineageDepth}`];
    if (run.rootRunId !== run.runId) labels.push(`root ${shortId(run.rootRunId)}`);
    if (run.parentRunId) labels.push(`parent ${shortId(run.parentRunId)}`);
    if (run.shardIds.length > 0) labels.push(`shards ${run.shardIds.map(shortId).join(', ')}`);
    if (run.subagentIds.length > 0) labels.push(`subagents ${run.subagentIds.map(shortId).join(', ')}`);
    return labels.join(' | ');
  }

  function toggleRun(runId: string): void {
    expandedRunIds = expandedRunIds.includes(runId)
      ? expandedRunIds.filter(id => id !== runId)
      : [...expandedRunIds, runId];
  }

  function rollingWindowLaneSpend(lane: ChargePolicyRuntimeLane): number {
    return dayWindow?.aggregates.byLane.find(item => item.key === lane)?.amount ?? 0;
  }

  function quotaPercent(lane: ChargePolicyRuntimeLane): number {
    const quota = policy?.runChargeQuotaByLane[lane] ?? 0;
    const remaining = Math.max(0, quota - rollingWindowLaneSpend(lane));
    if (quota <= 0) return 0;
    return Math.max(0, Math.min(100, (remaining / quota) * 100));
  }

  function clonePolicy(nextPolicy: ChargePolicyConfig): ChargePolicyConfig {
    return snapshotReactiveState(nextPolicy);
  }

  function parseNumber(value: string): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  function setLaneQuota(lane: ChargePolicyRuntimeLane, value: string): void {
    if (!policy) return;
    const next = clonePolicy(policy);
    next.runChargeQuotaByLane[lane] = parseNumber(value);
    policy = next;
  }

  function setSurfaceCost(surface: ChargePolicySurface, value: string): void {
    if (!policy) return;
    const next = clonePolicy(policy);
    next.surfaceCosts[surface] = parseNumber(value);
    next.surfaceRationales = next.surfaceRationales ?? {};
    policy = next;
  }

  function setSurfaceRationale(surface: ChargePolicySurface, value: string): void {
    if (!policy) return;
    const next = clonePolicy(policy);
    next.surfaceRationales = next.surfaceRationales ?? {};
    next.surfaceRationales[surface] = value;
    policy = next;
  }

  function setMoaMultiplier(referenceClass: ChargePolicyReferenceModelClass, value: string): void {
    if (!policy) return;
    const next = clonePolicy(policy);
    next.moa.perRoundMultiplierByReferenceModelClass[referenceClass] = parseNumber(value);
    policy = next;
  }

  function setReferencePricing(referenceClass: ChargePolicyReferenceModelClass, value: string): void {
    if (!policy) return;
    const next = clonePolicy(policy);
    next.referenceModelClassPricing[referenceClass] = parseNumber(value);
    next.referenceModelClassPricingRationales = next.referenceModelClassPricingRationales ?? {};
    policy = next;
  }

  function setReferenceRationale(referenceClass: ChargePolicyReferenceModelClass, value: string): void {
    if (!policy) return;
    const next = clonePolicy(policy);
    next.referenceModelClassPricingRationales = next.referenceModelClassPricingRationales ?? {};
    next.referenceModelClassPricingRationales[referenceClass] = value;
    policy = next;
  }

  function validatePolicy(nextPolicy: ChargePolicyConfig): string[] {
    const errors: string[] = [];
    for (const lane of LANE_VALUES) {
      if (!Number.isFinite(nextPolicy.runChargeQuotaByLane[lane]) || nextPolicy.runChargeQuotaByLane[lane] < 0) {
        errors.push(`${labelize(lane)} quota must be a finite number >= 0.`);
      }
    }
    for (const surface of SURFACE_VALUES) {
      const cost = nextPolicy.surfaceCosts[surface];
      if (!Number.isFinite(cost) || cost < 0) {
        errors.push(`${labelize(surface)} cost must be a finite number >= 0.`);
      }
      if (cost > 0 && !nextPolicy.surfaceRationales?.[surface]?.trim()) {
        errors.push(`${labelize(surface)} has a nonzero cost and needs a rationale.`);
      }
    }
    for (const referenceClass of REFERENCE_MODEL_CLASS_VALUES) {
      const multiplier = nextPolicy.moa.perRoundMultiplierByReferenceModelClass[referenceClass];
      const pricing = nextPolicy.referenceModelClassPricing[referenceClass];
      if (!Number.isFinite(multiplier) || multiplier < 0) {
        errors.push(`${labelize(referenceClass)} MoA multiplier must be a finite number >= 0.`);
      }
      if (!Number.isFinite(pricing) || pricing < 0) {
        errors.push(`${labelize(referenceClass)} reference price must be a finite number >= 0.`);
      }
      if (pricing > 0 && !nextPolicy.referenceModelClassPricingRationales?.[referenceClass]?.trim()) {
        errors.push(`${labelize(referenceClass)} has nonzero reference pricing and needs a rationale.`);
      }
    }
    const humanAttention = nextPolicy.fatigue.humanAttention;
    if (!humanAttention) {
      errors.push('Human attention pressure policy is required.');
    } else {
      const { public: publicThreshold, regular, trusted, primary } =
        humanAttention.trustThresholds;
      if (
        ![publicThreshold, regular, trusted, primary]
          .every(value => Number.isInteger(value) && value > 0)
      ) {
        errors.push('Human attention trust thresholds must be positive integers.');
      } else if (
        publicThreshold > regular
        || regular > trusted
        || trusted > primary
      ) {
        errors.push('Human attention trust thresholds must increase from public through primary.');
      }
      if (
        !Number.isFinite(humanAttention.channelWeights.directMessage)
        || humanAttention.channelWeights.directMessage <= 0
        || !Number.isFinite(humanAttention.channelWeights.directMention)
        || humanAttention.channelWeights.directMention <= 0
      ) {
        errors.push('Human attention direct-message and direct-mention weights must be greater than zero.');
      }
    }
    return errors;
  }

  function toggleRawEditor(): void {
    if (!policy) return;
    rawEditorOpen = !rawEditorOpen;
    if (rawEditorOpen) {
      rawJson = serializePolicy(policy);
    }
  }

  async function refreshData(): Promise<void> {
    refreshing = true;
    await loadAll();
  }

  function selectTab(tab: 'charges' | 'token-usage'): void {
    activeTab = tab;
    const url = new URL(window.location.href);
    url.search = accountingSearchParamsForTab(url.searchParams, tab).toString();
    window.history.replaceState(window.history.state, '', url);
  }

  async function savePolicy(): Promise<void> {
    if (!policy) return;
    saving = true;
    saveMessage = '';
    policyError = '';
    try {
      const nextJson = rawEditorOpen ? prettyJson(rawJson) : serializePolicy(policy);
      if (!rawEditorOpen && policyValidationErrors.length > 0) {
        policyError = policyValidationErrors[0] ?? 'Charge policy validation failed.';
        return;
      }
      await saveSubConfig('charge-policy', nextJson);
      rawJson = nextJson;
      initialPolicyJson = nextJson;
      policy = JSON.parse(nextJson) as ChargePolicyConfig;
      saveOk = true;
      saveMessage = 'charge-policy.json saved';
    } catch (error) {
      saveOk = false;
      saveMessage = error instanceof Error ? error.message : 'Failed to save charge-policy.json';
    } finally {
      saving = false;
    }
  }

  onMount(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'token-usage') {
      activeTab = 'token-usage';
    }
    void loadAll();
  });
</script>

<div class="garden-page space-y-6 pb-10">
  <GardenPageHeader
    eyebrow="Runtime & Tools · Accounting"
    title="Charge / Budget"
    description="Canonical charge-policy controls, a merged run/event ledger, rolling quotas, and persisted model-cost analysis."
    class="border-b border-bark-300 pb-4"
  >
    {#snippet actions()}
    {#if activeTab === 'charges'}
      <button
        onclick={refreshData}
        disabled={refreshing || saving}
        class="garden-action rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm font-medium text-shadow-700 transition-colors hover:border-gold-300 hover:bg-gold-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {refreshing ? 'Refreshing...' : 'Refresh'}
      </button>
    {/if}
    {/snippet}
  </GardenPageHeader>

  {#if errorMessage && activeTab === 'charges'}
    <div class="garden-error card-garden border-l-4 border-l-wilt-400 p-4">
      <p class="text-sm font-medium text-wilt-600">{errorMessage}</p>
    </div>
  {/if}

  {#if loading}
    <div class="garden-loading garden-metric-grid grid gap-4 md:grid-cols-4">
      {#each Array(4) as _}
        <div class="card-garden h-32 animate-pulse bg-bark-50 p-5"></div>
      {/each}
    </div>
  {:else}
    <div class="garden-toolbar flex gap-1 overflow-x-auto border-b border-bark-300 pb-0">
      <button
        type="button"
        onclick={() => selectTab('charges')}
        class="shrink-0 border-b-2 px-3 pb-2.5 pt-1 text-sm font-medium transition-colors {activeTab === 'charges' ? 'border-gold-500 text-shadow-900' : 'border-transparent text-shadow-600 hover:border-gold-300 hover:text-shadow-900'}"
      >
        Charge Policy
      </button>
      <button
        type="button"
        onclick={() => selectTab('token-usage')}
        class="shrink-0 border-b-2 px-3 pb-2.5 pt-1 text-sm font-medium transition-colors {activeTab === 'token-usage' ? 'border-gold-500 text-shadow-900' : 'border-transparent text-shadow-600 hover:border-gold-300 hover:text-shadow-900'}"
      >
        Token Usage
      </button>
    </div>

    {#if activeTab === 'charges'}
    <section class="garden-metric-grid flex flex-wrap items-center gap-2" aria-label="Quick charge stats">
      <span class="inline-flex items-center gap-2 rounded-full border border-bark-300 bg-bark-50 px-3 py-1.5 text-xs font-medium text-shadow-700">
        <span class="h-2 w-2 rounded-full {activeRun ? 'bg-moss-500' : 'bg-bark-300'}" aria-hidden="true"></span>
        {#if activeRun}
          Active run <span class="font-semibold text-shadow-900">{formatCharge(activeRun.amount)}</span>
          <span class="text-shadow-500">· {formatInteger(activeRun.eventCount)} events</span>
        {:else}
          No active run
        {/if}
      </span>
      <span class="inline-flex items-center gap-1.5 rounded-full border border-bark-300 bg-bark-50 px-3 py-1.5 text-xs font-medium text-shadow-700">
        Last 24h <span class="font-semibold text-petal-500">{formatCharge(dayWindow?.aggregates.amount)}</span>
        <span class="text-shadow-500">· {formatInteger(dayWindow?.aggregates.eventCount)} events</span>
      </span>
      {#each LANE_VALUES as lane}
        <span class="inline-flex items-center gap-1.5 rounded-full border border-bark-300 bg-bark-50 px-3 py-1.5 text-xs font-medium text-shadow-700">
          {labelize(lane)}
          <span class="font-semibold text-shadow-900">{formatCharge(rollingWindowLaneSpend(lane))}</span>
          <span class="text-shadow-500">/ {formatCharge(policy?.runChargeQuotaByLane[lane] ?? 0)}</span>
        </span>
      {/each}
    </section>

    <section class="garden-section card-garden overflow-hidden" aria-labelledby="policy-heading">
      <div class="garden-section-header flex flex-wrap items-start justify-between gap-3 border-b border-bark-300 px-5 py-4">
        <div>
          <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Canonical owner file</p>
          <h2 id="policy-heading" class="garden-section-title mt-1 font-serif text-lg font-semibold text-shadow-900">charge-policy.json</h2>
          <p class="garden-section-description mt-1 text-sm text-shadow-600">
            Curated controls save through the same raw owner-file path used by Garden settings.
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          {#if saveMessage}
            <span class="text-sm font-medium {saveOk ? 'text-moss-600' : 'text-wilt-600'}">{saveMessage}</span>
          {/if}
          <button
            onclick={toggleRawEditor}
            disabled={!policy || saving}
            class="garden-action rounded-lg border border-bark-300 px-3 py-1.5 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:opacity-50"
          >
            {rawEditorOpen ? 'Hide raw JSON' : 'Raw JSON'}
          </button>
          <button
            onclick={savePolicy}
            disabled={!policy || saving || (!rawEditorOpen && policyValidationErrors.length > 0) || !policyDirty}
            class="garden-action garden-action--primary rounded-lg bg-gold-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-gold-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save policy'}
          </button>
        </div>
      </div>

      {#if policyError || policyValidationErrors.length > 0}
        <div class="border-b border-wilt-200 bg-wilt-50 px-5 py-3">
          {#if policyError}
            <p class="text-sm font-medium text-wilt-600">{policyError}</p>
          {/if}
          {#each policyValidationErrors as validationError}
            <p class="text-sm text-wilt-600">{validationError}</p>
          {/each}
        </div>
      {/if}

      {#if policy}
        {#if rawEditorOpen}
          <textarea
            value={rawJson}
            oninput={(event) => rawJson = (event.currentTarget as HTMLTextAreaElement).value}
            rows="20"
            class="w-full resize-y border-0 bg-bark-50 p-4 font-mono text-sm text-shadow-800 focus:outline-none focus:ring-2 focus:ring-gold-300 focus:ring-inset"
            spellcheck="false"
          ></textarea>
        {:else}
          <div class="space-y-6 p-5">
            <div>
              <h3 class="font-serif text-base font-semibold text-shadow-900">Run and rolling quota by lane</h3>
              <div class="mt-3 grid gap-3 md:grid-cols-5">
                {#each LANE_VALUES as lane}
                  <label class="block rounded-xl border border-bark-300 bg-bark-50 p-3">
                    <span class="block font-mono text-xs font-semibold text-shadow-800">{policyKey('runChargeQuotaByLane', lane)}</span>
                    <span class="mt-1 block text-xs uppercase tracking-[0.14em] text-shadow-500">{labelize(lane)}</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={policy.runChargeQuotaByLane[lane]}
                      aria-label={`${policyKey('runChargeQuotaByLane', lane)} quota`}
                      oninput={(event) => setLaneQuota(lane, (event.currentTarget as HTMLInputElement).value)}
                      class="mt-2 w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm text-shadow-800 focus:border-gold-400 focus:outline-none"
                    />
                  </label>
                {/each}
              </div>
            </div>

            <div>
              <h3 class="font-serif text-base font-semibold text-shadow-900">Surface costs and rationales</h3>
              <p class="mt-1 text-sm text-shadow-600">Every nonzero surface cost requires a non-empty rationale before save.</p>
              <div class="garden-table-shell mt-3 overflow-hidden rounded-xl border border-bark-300">
                <div class="garden-table-scroll overflow-x-auto">
                <table class="garden-table min-w-full divide-y divide-bark-200 text-left text-sm">
                  <thead class="bg-bark-50 text-xs uppercase tracking-[0.14em] text-shadow-500">
                    <tr>
                      <th class="px-4 py-3 font-semibold">Surface</th>
                      <th class="px-4 py-3 font-semibold">Cost</th>
                      <th class="px-4 py-3 font-semibold">Required rationale</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-bark-200 bg-bark-50">
                    {#each SURFACE_VALUES as surface}
                      <tr>
                        <td class="px-4 py-3">
                          <p class="font-mono text-xs font-semibold text-shadow-800">{policyKey('surfaceCosts', surface)}</p>
                          <p class="mt-1 text-xs text-shadow-500">{labelize(surface)}</p>
                        </td>
                        <td class="px-4 py-3">
                          <input
                            type="number"
                            min="0"
                            step="0.001"
                            value={policy.surfaceCosts[surface]}
                            aria-label={`${policyKey('surfaceCosts', surface)} cost`}
                            oninput={(event) => setSurfaceCost(surface, (event.currentTarget as HTMLInputElement).value)}
                            class="w-28 rounded-lg border border-bark-300 px-3 py-2 text-sm focus:border-gold-400 focus:outline-none"
                          />
                        </td>
                        <td class="px-4 py-3">
                          <input
                            type="text"
                            value={policy.surfaceRationales?.[surface] ?? ''}
                            placeholder={policy.surfaceCosts[surface] > 0 ? 'Required for nonzero cost' : 'Optional'}
                            aria-label={`${policyKey('surfaceRationales', surface)} rationale`}
                            oninput={(event) => setSurfaceRationale(surface, (event.currentTarget as HTMLInputElement).value)}
                            class="w-full min-w-64 rounded-lg border border-bark-300 px-3 py-2 text-sm focus:border-gold-400 focus:outline-none"
                            class:border-wilt-400={policy.surfaceCosts[surface] > 0 && !policy.surfaceRationales?.[surface]?.trim()}
                          />
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
                </div>
              </div>
            </div>

            <div class="grid gap-6 lg:grid-cols-2">
              <div>
                <h3 class="font-serif text-base font-semibold text-shadow-900">MoA per-round multipliers</h3>
                <div class="mt-3 space-y-3">
                  {#each REFERENCE_MODEL_CLASS_VALUES as referenceClass}
                    <label class="flex items-center justify-between gap-3 rounded-xl border border-bark-300 bg-bark-50 p-3">
                      <span>
                        <span class="block font-mono text-xs font-semibold text-shadow-800">
                          {policyKey('moa.perRoundMultiplierByReferenceModelClass', referenceClass)}
                        </span>
                        <span class="mt-1 block text-xs text-shadow-500">{labelize(referenceClass)}</span>
                      </span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={policy.moa.perRoundMultiplierByReferenceModelClass[referenceClass]}
                        aria-label={`${policyKey('moa.perRoundMultiplierByReferenceModelClass', referenceClass)} multiplier`}
                        oninput={(event) => setMoaMultiplier(referenceClass, (event.currentTarget as HTMLInputElement).value)}
                        class="w-32 rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm focus:border-gold-400 focus:outline-none"
                      />
                    </label>
                  {/each}
                </div>
              </div>

              <div>
                <h3 class="font-serif text-base font-semibold text-shadow-900">Reference model class pricing</h3>
                <p class="mt-1 text-sm text-shadow-600">Nonzero pricing requires rationale.</p>
                <div class="mt-3 space-y-3">
                  {#each REFERENCE_MODEL_CLASS_VALUES as referenceClass}
                    <div class="rounded-xl border border-bark-300 bg-bark-50 p-3">
                      <div class="flex items-center justify-between gap-3">
                        <span>
                          <span class="block font-mono text-xs font-semibold text-shadow-800">
                            {policyKey('referenceModelClassPricing', referenceClass)}
                          </span>
                          <span class="mt-1 block text-xs text-shadow-500">{labelize(referenceClass)}</span>
                        </span>
                        <input
                          type="number"
                          min="0"
                          step="0.001"
                          value={policy.referenceModelClassPricing[referenceClass]}
                          aria-label={`${policyKey('referenceModelClassPricing', referenceClass)} price`}
                          oninput={(event) => setReferencePricing(referenceClass, (event.currentTarget as HTMLInputElement).value)}
                          class="w-32 rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm focus:border-gold-400 focus:outline-none"
                        />
                      </div>
                      <input
                        type="text"
                        value={policy.referenceModelClassPricingRationales?.[referenceClass] ?? ''}
                        placeholder={policy.referenceModelClassPricing[referenceClass] > 0 ? 'Required pricing rationale' : 'Optional rationale'}
                        aria-label={`${policyKey('referenceModelClassPricingRationales', referenceClass)} rationale`}
                        oninput={(event) => setReferenceRationale(referenceClass, (event.currentTarget as HTMLInputElement).value)}
                        class="mt-3 w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm focus:border-gold-400 focus:outline-none"
                        class:border-wilt-400={policy.referenceModelClassPricing[referenceClass] > 0 && !policy.referenceModelClassPricingRationales?.[referenceClass]?.trim()}
                      />
                    </div>
                  {/each}
                </div>
              </div>
            </div>
          </div>
        {/if}
      {/if}
    </section>

    <HumanAttentionPressurePanel data={humanAttention} policy={humanAttentionPolicy} />

    <section class="garden-section card-garden overflow-hidden" aria-labelledby="recent-runs-heading">
      <div class="garden-section-header border-b border-bark-300 px-5 py-4">
        <h2 id="recent-runs-heading" class="garden-section-title font-serif text-lg font-semibold text-shadow-900">Recent runs & charge events</h2>
        <p class="mt-1 text-sm text-shadow-600">
          {formatInteger(mergedRuns.length)} runs · {formatInteger(mergedEventCount)} charge events · {formatInteger(lineageRootCount)} lineage roots.
          Expand a run to see its individual charge events.
        </p>
      </div>
      <BoundedList maxHeight="28rem" label="Recent runs and charge events">
        <div class="divide-y divide-bark-200">
          {#each mergedRuns as row (row.runId)}
            {@const expanded = expandedRunIds.includes(row.runId)}
            <div>
              <button
                type="button"
                onclick={() => toggleRun(row.runId)}
                aria-expanded={expanded}
                class="grid w-full gap-2 px-5 py-3 text-left text-sm transition-colors hover:bg-bark-50 md:grid-cols-[1fr_auto_auto] md:items-center"
              >
                <div class="min-w-0">
                  <p class="font-medium text-shadow-800">
                    <span class="font-mono text-xs">{shortId(row.runId)}</span>
                    {#if !row.summarized}
                      <span class="text-xs text-shadow-500">(events only)</span>
                    {/if}
                  </p>
                  {#if row.lineageLabel}
                    <p class="mt-1 text-xs text-shadow-500">{row.lineageLabel}</p>
                  {/if}
                  <p class="mt-1 text-xs text-shadow-500">{row.models.length ? row.models.join(', ') : 'No models recorded'}</p>
                </div>
                <div class="text-left md:text-right">
                  <p class="font-semibold text-shadow-900">{formatCharge(row.amount)}</p>
                  <p class="text-xs text-shadow-500">{formatInteger(row.eventCount)} events · {formatTime(row.when)}</p>
                </div>
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  class="h-4 w-4 shrink-0 justify-self-end text-shadow-500 transition-transform {expanded ? 'rotate-180' : ''}"
                >
                  <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              {#if expanded}
                <div class="border-t border-bark-200 bg-bark-50 px-5 py-2">
                  {#each row.entries as entry (entry.eventId)}
                    <div class="grid gap-1 py-2 text-sm md:grid-cols-[1fr_auto]">
                      <div>
                        <p class="text-shadow-800">{labelize(entry.event.surface)} on {labelize(entry.event.lane)}</p>
                        <p class="mt-0.5 text-xs text-shadow-500">
                          {#if entry.metadata?.shardId}shard {shortId(entry.metadata.shardId)} | {/if}
                          {#if entry.metadata?.subagentId}subagent {shortId(entry.metadata.subagentId)} | {/if}
                          {#if entry.metadata?.model}model {entry.metadata.model} | {/if}
                          lane remaining {formatCharge(entry.event.remainingAfter)} of {formatCharge(entry.event.quota)}
                        </p>
                      </div>
                      <div class="text-left md:text-right">
                        <p class="font-semibold text-shadow-900">{formatCharge(entry.event.amount)}</p>
                        <p class="text-xs text-shadow-500">{formatTime(entry.event.timestampMs)}</p>
                      </div>
                    </div>
                  {:else}
                    <p class="py-2 text-sm text-shadow-600">No charge events for this run in the recent event window.</p>
                  {/each}
                </div>
              {/if}
            </div>
          {:else}
            <p class="px-5 py-4 text-sm text-shadow-600">No runs or charge events recorded.</p>
          {/each}
        </div>
      </BoundedList>
    </section>

    <section class="garden-split-view grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]" aria-label="Charge quota and history">
      <div class="garden-section card-garden overflow-hidden">
        <div class="border-b border-bark-300 px-5 py-4">
          <h2 class="font-serif text-lg font-semibold text-shadow-900">Rolling 24h quota by lane</h2>
          <p class="mt-1 text-sm text-shadow-600">Uses Last 24h ledger spend against charge-policy lane quotas; each run also uses the same quota as a runaway guard.</p>
        </div>
        <div class="divide-y divide-bark-200">
          {#each LANE_VALUES as lane}
            {@const quota = policy?.runChargeQuotaByLane[lane] ?? 0}
            {@const spent = rollingWindowLaneSpend(lane)}
            {@const remaining = Math.max(0, quota - spent)}
            <div class="px-5 py-4">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <p class="font-mono text-sm font-semibold text-shadow-800">{policyKey('runChargeQuotaByLane', lane)}</p>
                  <p class="text-xs text-shadow-500">{labelize(lane)}</p>
                  <p class="text-xs text-shadow-500">Spent {formatCharge(spent)} of {formatCharge(quota)}</p>
                </div>
                <p class="font-serif text-xl font-bold text-moss-600">{formatCharge(remaining)}</p>
              </div>
              <div class="mt-3 h-2 overflow-hidden rounded-full bg-bark-200">
                <div class="h-full rounded-full bg-moss-400" style={`width: ${quotaPercent(lane)}%`}></div>
              </div>
            </div>
          {/each}
        </div>
      </div>

      <div class="space-y-4">
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="card-garden p-5">
            <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Active run</p>
            <p class="mt-3 text-3xl font-serif font-bold text-shadow-900">
              {activeRun ? formatCharge(activeRun.amount) : DASH}
            </p>
            <p class="mt-2 text-sm text-shadow-600">
              {activeRun ? `${formatInteger(activeRun.eventCount)} charge events` : 'No charge events recorded'}
            </p>
          </div>
          <div class="card-garden p-5">
            <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Last 24h used</p>
            <p class="mt-3 text-3xl font-serif font-bold text-petal-500">{formatCharge(dayWindow?.aggregates.amount)}</p>
            <p class="mt-2 text-sm text-shadow-600">
              {formatInteger(dayWindow?.aggregates.eventCount)} events counted against the rolling lane quotas.
            </p>
          </div>
        </div>

        <div class="card-garden overflow-hidden">
          <div class="border-b border-bark-300 px-5 py-4">
            <h2 class="font-serif text-lg font-semibold text-shadow-900">Last 30 days</h2>
            <p class="mt-1 text-sm text-shadow-600">Single historical window with lane and surface breakdowns.</p>
          </div>
          <div class="flex items-baseline justify-between gap-4 px-5 py-4">
            <p class="font-serif text-2xl font-bold text-gold-600">{formatCharge(monthWindow?.aggregates.amount)}</p>
            <p class="text-sm text-shadow-600">{formatInteger(monthWindow?.aggregates.eventCount)} events</p>
          </div>
          <BoundedList maxHeight="16rem" label="30 day lane and surface breakdowns">
            <div class="divide-y divide-bark-200 border-t border-bark-200">
              {#each monthWindow?.aggregates.byLane ?? [] as item (`lane-${item.key}`)}
                <div class="flex items-center justify-between gap-4 px-5 py-2.5">
                  <div>
                    <p class="font-mono text-sm font-medium text-shadow-800">{item.key}</p>
                    <p class="text-xs uppercase tracking-[0.14em] text-shadow-500">Lane</p>
                  </div>
                  <p class="text-sm text-shadow-600">{formatCharge(item.amount)} / {formatInteger(item.eventCount)} events</p>
                </div>
              {/each}
              {#each monthWindow?.aggregates.bySurface ?? [] as item (`surface-${item.key}`)}
                <div class="flex items-center justify-between gap-4 px-5 py-2.5">
                  <div>
                    <p class="font-mono text-sm font-medium text-shadow-800">{item.key}</p>
                    <p class="text-xs uppercase tracking-[0.14em] text-shadow-500">Surface</p>
                  </div>
                  <p class="text-sm text-shadow-600">{formatCharge(item.amount)} / {formatInteger(item.eventCount)} events</p>
                </div>
              {:else}
                {#if (monthWindow?.aggregates.byLane ?? []).length === 0}
                  <p class="px-5 py-4 text-sm text-shadow-600">No charges recorded in the last 30 days.</p>
                {/if}
              {/each}
            </div>
          </BoundedList>
        </div>
      </div>
    </section>
    {:else}
      <AccountingCockpit />
    {/if}
  {/if}
</div>
