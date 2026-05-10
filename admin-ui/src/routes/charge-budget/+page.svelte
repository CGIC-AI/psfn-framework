<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getCharges,
    type AdminChargeLedgerData,
    type RunChargeRunSummary,
  } from '$lib/api/endpoints/charges';
  import { getSubConfig, saveSubConfig } from '$lib/api/endpoints/settings';

  type ChargePolicyRuntimeLane = 'interactive' | 'background' | 'maintenance' | 'subagent' | 'shard';
  type ChargePolicySurface =
    | 'ownerFileInspection'
    | 'localFilesystem'
    | 'memoryRead'
    | 'memoryWrite'
    | 'localEmbedding'
    | 'externalEmbedding'
    | 'localImageGeneration'
    | 'paidImageGeneration'
    | 'thinkExtensionBand'
    | 'subagentLaunch'
    | 'shardLaunch'
    | 'externalModelConsult'
    | 'moaRoundBase';
  type ChargePolicyReferenceModelClass = 'local' | 'subscription' | 'cheap_cloud' | 'premium_cloud';

  interface ChargePolicyConfig {
    schemaVersion: 1;
    runChargeQuotaByLane: Record<ChargePolicyRuntimeLane, number>;
    surfaceCosts: Record<ChargePolicySurface, number>;
    surfaceRationales?: Partial<Record<ChargePolicySurface, string>>;
    moa: {
      perRoundMultiplierByReferenceModelClass: Record<ChargePolicyReferenceModelClass, number>;
    };
    referenceModelClassPricing: Record<ChargePolicyReferenceModelClass, number>;
    referenceModelClassPricingRationales?: Partial<Record<ChargePolicyReferenceModelClass, string>>;
  }

  const LANE_VALUES = [
    'interactive',
    'background',
    'maintenance',
    'subagent',
    'shard',
  ] as const satisfies readonly ChargePolicyRuntimeLane[];

  const SURFACE_VALUES = [
    'ownerFileInspection',
    'localFilesystem',
    'memoryRead',
    'memoryWrite',
    'localEmbedding',
    'externalEmbedding',
    'localImageGeneration',
    'paidImageGeneration',
    'thinkExtensionBand',
    'subagentLaunch',
    'shardLaunch',
    'externalModelConsult',
    'moaRoundBase',
  ] as const satisfies readonly ChargePolicySurface[];

  const REFERENCE_MODEL_CLASS_VALUES = [
    'local',
    'subscription',
    'cheap_cloud',
    'premium_cloud',
  ] as const satisfies readonly ChargePolicyReferenceModelClass[];

  interface HistoricalWindow {
    id: string;
    label: string;
    sinceMs: number;
    data: AdminChargeLedgerData | null;
  }

  const now = () => Date.now();
  const DAY_MS = 86_400_000;
  const DASH = '-';

  let charges = $state<AdminChargeLedgerData | null>(null);
  let policy = $state<ChargePolicyConfig | null>(null);
  let historicalWindows = $state<HistoricalWindow[]>([]);
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

  async function loadAll(): Promise<void> {
    errorMessage = '';
    policyError = '';
    saveMessage = '';
    const timestamp = now();
    const windows: HistoricalWindow[] = [
      { id: 'day', label: 'Last 24h', sinceMs: timestamp - DAY_MS, data: null },
      { id: 'week', label: 'Last 7d', sinceMs: timestamp - 7 * DAY_MS, data: null },
      { id: 'month', label: 'Last 30d', sinceMs: timestamp - 30 * DAY_MS, data: null },
    ];

    try {
      const [chargeData, policyJson, ...windowData] = await Promise.all([
        getCharges({ limit: 200 }),
        getSubConfig('charge-policy'),
        ...windows.map(window => getCharges({ limit: 500, sinceMs: window.sinceMs })),
      ]);
      charges = chargeData;
      historicalWindows = windows.map((window, index) => ({
        ...window,
        data: windowData[index] ?? null,
      }));
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

  function shortId(id: string): string {
    return id.length > 12 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
  }

  function runLineageLabel(run: RunChargeRunSummary): string {
    const labels = [`depth ${run.lineageDepth}`];
    if (run.parentRunId) labels.push(`parent ${shortId(run.parentRunId)}`);
    if (run.shardIds.length > 0) labels.push(`shards ${run.shardIds.map(shortId).join(', ')}`);
    if (run.subagentIds.length > 0) labels.push(`subagents ${run.subagentIds.map(shortId).join(', ')}`);
    return labels.join(' | ');
  }

  function quotaPercent(lane: ChargePolicyRuntimeLane): number {
    const quota = activeRun?.lastQuotaByLane[lane] ?? policy?.runChargeQuotaByLane[lane] ?? 0;
    const remaining = activeRun?.lastRemainingAfterByLane[lane] ?? quota;
    if (quota <= 0) return 0;
    return Math.max(0, Math.min(100, (remaining / quota) * 100));
  }

  function clonePolicy(nextPolicy: ChargePolicyConfig): ChargePolicyConfig {
    return JSON.parse(JSON.stringify(nextPolicy)) as ChargePolicyConfig;
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
    void loadAll();
  });
</script>

<div class="space-y-8">
  <div class="flex items-start justify-between gap-4 flex-wrap">
    <div>
      <p class="text-xs uppercase tracking-[0.2em] text-shadow-500">Runtime & Tools</p>
      <h1 class="mt-1 text-2xl font-serif font-bold text-shadow-900">Charge / Budget</h1>
      <p class="mt-1 max-w-3xl text-sm text-shadow-600">
        Live run-charge ledger, remaining lane quota, historical spend windows, and canonical charge-policy controls.
      </p>
    </div>
    <button
      onclick={refreshData}
      disabled={refreshing || saving}
      class="rounded-xl border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {refreshing ? 'Refreshing...' : 'Refresh'}
    </button>
  </div>

  {#if errorMessage}
    <div class="card-garden border-l-4 border-l-wilt-400 p-4">
      <p class="text-sm font-medium text-wilt-600">{errorMessage}</p>
    </div>
  {/if}

  {#if loading}
    <div class="grid gap-4 md:grid-cols-4">
      {#each Array(4) as _}
        <div class="card-garden h-32 animate-pulse bg-bark-50 p-5"></div>
      {/each}
    </div>
  {:else}
    <section class="space-y-4" aria-labelledby="charge-overview-heading">
      <div>
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Ledger</p>
        <h2 id="charge-overview-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
          Active and recent spend
        </h2>
      </div>

      <div class="grid gap-4 md:grid-cols-4">
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
          <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Recent total</p>
          <p class="mt-3 text-3xl font-serif font-bold text-petal-500">
            {formatCharge(charges?.aggregates.amount)}
          </p>
          <p class="mt-2 text-sm text-shadow-600">{formatInteger(charges?.aggregates.eventCount)} events in the query window.</p>
        </div>
        <div class="card-garden p-5">
          <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Runs</p>
          <p class="mt-3 text-3xl font-serif font-bold text-moss-600">{formatInteger(recentRuns.length)}</p>
          <p class="mt-2 text-sm text-shadow-600">Most recent run summaries returned by the charge ledger.</p>
        </div>
        <div class="card-garden p-5">
          <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Lineage roots</p>
          <p class="mt-3 text-3xl font-serif font-bold text-gold-600">
            {formatInteger(new Set(recentRuns.map(run => run.rootRunId)).size)}
          </p>
          <p class="mt-2 text-sm text-shadow-600">Distinct root runs represented in recent lineage.</p>
        </div>
      </div>
    </section>

    <section class="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]" aria-label="Charge quota and history">
      <div class="card-garden overflow-hidden">
        <div class="border-b border-bark-300 px-5 py-4">
          <h2 class="font-serif text-lg font-semibold text-shadow-900">Remaining quota by lane</h2>
          <p class="mt-1 text-sm text-shadow-600">Uses the active run's last observed quota state, falling back to charge-policy lane quotas.</p>
        </div>
        <div class="divide-y divide-bark-200">
          {#each LANE_VALUES as lane}
            {@const quota = activeRun?.lastQuotaByLane[lane] ?? policy?.runChargeQuotaByLane[lane] ?? 0}
            {@const spent = activeRun?.lastSpentAfterByLane[lane] ?? 0}
            {@const remaining = activeRun?.lastRemainingAfterByLane[lane] ?? quota}
            <div class="px-5 py-4">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <p class="text-sm font-semibold text-shadow-800">{labelize(lane)}</p>
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

      <div class="card-garden overflow-hidden">
        <div class="border-b border-bark-300 px-5 py-4">
          <h2 class="font-serif text-lg font-semibold text-shadow-900">Historical windows</h2>
          <p class="mt-1 text-sm text-shadow-600">Independent `/api/admin/charges` queries over fixed lookback windows.</p>
        </div>
        <div class="divide-y divide-bark-200">
          {#each historicalWindows as window}
            <div class="grid grid-cols-[1fr_auto] gap-3 px-5 py-4">
              <div>
                <p class="text-sm font-semibold text-shadow-800">{window.label}</p>
                <p class="text-xs text-shadow-500">{formatInteger(window.data?.aggregates.eventCount)} events</p>
              </div>
              <p class="font-serif text-xl font-bold text-shadow-900">{formatCharge(window.data?.aggregates.amount)}</p>
            </div>
          {/each}
        </div>
      </div>
    </section>

    <section class="grid gap-4 lg:grid-cols-2" aria-label="Charge breakdowns">
      <div class="card-garden overflow-hidden">
        <div class="border-b border-bark-300 px-5 py-4">
          <h2 class="font-serif text-lg font-semibold text-shadow-900">Per-lane breakdown</h2>
        </div>
        <div class="divide-y divide-bark-200">
          {#each charges?.aggregates.byLane ?? [] as item}
            <div class="flex items-center justify-between gap-4 px-5 py-3">
              <p class="text-sm font-medium text-shadow-800">{labelize(item.key)}</p>
              <p class="text-sm text-shadow-600">{formatCharge(item.amount)} / {formatInteger(item.eventCount)} events</p>
            </div>
          {:else}
            <p class="px-5 py-4 text-sm text-shadow-600">No lane charges recorded.</p>
          {/each}
        </div>
      </div>

      <div class="card-garden overflow-hidden">
        <div class="border-b border-bark-300 px-5 py-4">
          <h2 class="font-serif text-lg font-semibold text-shadow-900">Per-surface breakdown</h2>
        </div>
        <div class="max-h-80 divide-y divide-bark-200 overflow-y-auto">
          {#each charges?.aggregates.bySurface ?? [] as item}
            <div class="flex items-center justify-between gap-4 px-5 py-3">
              <p class="text-sm font-medium text-shadow-800">{labelize(item.key)}</p>
              <p class="text-sm text-shadow-600">{formatCharge(item.amount)} / {formatInteger(item.eventCount)} events</p>
            </div>
          {:else}
            <p class="px-5 py-4 text-sm text-shadow-600">No surface charges recorded.</p>
          {/each}
        </div>
      </div>
    </section>

    <section class="card-garden overflow-hidden" aria-labelledby="lineage-heading">
      <div class="border-b border-bark-300 px-5 py-4">
        <h2 id="lineage-heading" class="font-serif text-lg font-semibold text-shadow-900">Run lineage</h2>
        <p class="mt-1 text-sm text-shadow-600">Recent runs with shard and subagent labels from charge metadata.</p>
      </div>
      <div class="overflow-x-auto">
        <table class="min-w-full divide-y divide-bark-200 text-left text-sm">
          <thead class="bg-bark-50 text-xs uppercase tracking-[0.16em] text-shadow-500">
            <tr>
              <th class="px-5 py-3 font-semibold">Run</th>
              <th class="px-5 py-3 font-semibold">Updated</th>
              <th class="px-5 py-3 font-semibold">Spend</th>
              <th class="px-5 py-3 font-semibold">Lineage labels</th>
              <th class="px-5 py-3 font-semibold">Models</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-bark-200">
            {#each recentRuns as run}
              <tr>
                <td class="px-5 py-3 font-mono text-xs text-shadow-700">{shortId(run.runId)}</td>
                <td class="px-5 py-3 text-shadow-600">{formatTime(run.updatedAtMs)}</td>
                <td class="px-5 py-3 font-semibold text-shadow-900">{formatCharge(run.amount)}</td>
                <td class="px-5 py-3 text-shadow-600">{runLineageLabel(run)}</td>
                <td class="px-5 py-3 text-shadow-600">{run.models.length ? run.models.join(', ') : DASH}</td>
              </tr>
            {:else}
              <tr>
                <td colspan="5" class="px-5 py-4 text-shadow-600">No recent runs recorded.</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="card-garden overflow-hidden" aria-labelledby="policy-heading">
      <div class="flex flex-wrap items-start justify-between gap-3 border-b border-bark-300 px-5 py-4">
        <div>
          <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Canonical owner file</p>
          <h2 id="policy-heading" class="mt-1 font-serif text-lg font-semibold text-shadow-900">charge-policy.json</h2>
          <p class="mt-1 text-sm text-shadow-600">
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
            class="rounded-lg border border-bark-300 px-3 py-1.5 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:opacity-50"
          >
            {rawEditorOpen ? 'Hide raw JSON' : 'Raw JSON'}
          </button>
          <button
            onclick={savePolicy}
            disabled={!policy || saving || (!rawEditorOpen && policyValidationErrors.length > 0) || !policyDirty}
            class="rounded-lg bg-gold-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-gold-700 disabled:cursor-not-allowed disabled:opacity-50"
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
            class="w-full resize-y border-0 bg-white p-4 font-mono text-sm text-shadow-800 focus:outline-none focus:ring-2 focus:ring-gold-300 focus:ring-inset"
            spellcheck="false"
          ></textarea>
        {:else}
          <div class="space-y-6 p-5">
            <div>
              <h3 class="font-serif text-base font-semibold text-shadow-900">Run charge quota by lane</h3>
              <div class="mt-3 grid gap-3 md:grid-cols-5">
                {#each LANE_VALUES as lane}
                  <label class="block rounded-xl border border-bark-300 bg-bark-50 p-3">
                    <span class="block text-xs font-semibold uppercase tracking-[0.14em] text-shadow-500">{labelize(lane)}</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={policy.runChargeQuotaByLane[lane]}
                      oninput={(event) => setLaneQuota(lane, (event.currentTarget as HTMLInputElement).value)}
                      class="mt-2 w-full rounded-lg border border-bark-300 bg-white px-3 py-2 text-sm text-shadow-800 focus:border-gold-400 focus:outline-none"
                    />
                  </label>
                {/each}
              </div>
            </div>

            <div>
              <h3 class="font-serif text-base font-semibold text-shadow-900">Surface costs and rationales</h3>
              <p class="mt-1 text-sm text-shadow-600">Every nonzero surface cost requires a non-empty rationale before save.</p>
              <div class="mt-3 overflow-x-auto rounded-xl border border-bark-300">
                <table class="min-w-full divide-y divide-bark-200 text-left text-sm">
                  <thead class="bg-bark-50 text-xs uppercase tracking-[0.14em] text-shadow-500">
                    <tr>
                      <th class="px-4 py-3 font-semibold">Surface</th>
                      <th class="px-4 py-3 font-semibold">Cost</th>
                      <th class="px-4 py-3 font-semibold">Required rationale</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-bark-200 bg-white">
                    {#each SURFACE_VALUES as surface}
                      <tr>
                        <td class="px-4 py-3 font-medium text-shadow-800">{labelize(surface)}</td>
                        <td class="px-4 py-3">
                          <input
                            type="number"
                            min="0"
                            step="0.001"
                            value={policy.surfaceCosts[surface]}
                            oninput={(event) => setSurfaceCost(surface, (event.currentTarget as HTMLInputElement).value)}
                            class="w-28 rounded-lg border border-bark-300 px-3 py-2 text-sm focus:border-gold-400 focus:outline-none"
                          />
                        </td>
                        <td class="px-4 py-3">
                          <input
                            type="text"
                            value={policy.surfaceRationales?.[surface] ?? ''}
                            placeholder={policy.surfaceCosts[surface] > 0 ? 'Required for nonzero cost' : 'Optional'}
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

            <div class="grid gap-6 lg:grid-cols-2">
              <div>
                <h3 class="font-serif text-base font-semibold text-shadow-900">MoA per-round multipliers</h3>
                <div class="mt-3 space-y-3">
                  {#each REFERENCE_MODEL_CLASS_VALUES as referenceClass}
                    <label class="flex items-center justify-between gap-3 rounded-xl border border-bark-300 bg-bark-50 p-3">
                      <span class="text-sm font-medium text-shadow-800">{labelize(referenceClass)}</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={policy.moa.perRoundMultiplierByReferenceModelClass[referenceClass]}
                        oninput={(event) => setMoaMultiplier(referenceClass, (event.currentTarget as HTMLInputElement).value)}
                        class="w-32 rounded-lg border border-bark-300 bg-white px-3 py-2 text-sm focus:border-gold-400 focus:outline-none"
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
                        <span class="text-sm font-medium text-shadow-800">{labelize(referenceClass)}</span>
                        <input
                          type="number"
                          min="0"
                          step="0.001"
                          value={policy.referenceModelClassPricing[referenceClass]}
                          oninput={(event) => setReferencePricing(referenceClass, (event.currentTarget as HTMLInputElement).value)}
                          class="w-32 rounded-lg border border-bark-300 bg-white px-3 py-2 text-sm focus:border-gold-400 focus:outline-none"
                        />
                      </div>
                      <input
                        type="text"
                        value={policy.referenceModelClassPricingRationales?.[referenceClass] ?? ''}
                        placeholder={policy.referenceModelClassPricing[referenceClass] > 0 ? 'Required pricing rationale' : 'Optional rationale'}
                        oninput={(event) => setReferenceRationale(referenceClass, (event.currentTarget as HTMLInputElement).value)}
                        class="mt-3 w-full rounded-lg border border-bark-300 bg-white px-3 py-2 text-sm focus:border-gold-400 focus:outline-none"
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

    <section class="card-garden overflow-hidden" aria-labelledby="recent-events-heading">
      <div class="border-b border-bark-300 px-5 py-4">
        <h2 id="recent-events-heading" class="font-serif text-lg font-semibold text-shadow-900">Recent charge events</h2>
      </div>
      <div class="max-h-96 divide-y divide-bark-200 overflow-y-auto">
        {#each recentEvents as entry}
          <div class="grid gap-2 px-5 py-3 text-sm md:grid-cols-[1fr_auto]">
            <div>
              <p class="font-medium text-shadow-800">
                {labelize(entry.event.surface)} on {labelize(entry.event.lane)}
              </p>
              <p class="mt-1 text-xs text-shadow-500">
                run {shortId(entry.event.lineage.runId)}
                {#if entry.metadata?.shardId} | shard {shortId(entry.metadata.shardId)}{/if}
                {#if entry.metadata?.subagentId} | subagent {shortId(entry.metadata.subagentId)}{/if}
                {#if entry.metadata?.model} | model {entry.metadata.model}{/if}
              </p>
            </div>
            <div class="text-left md:text-right">
              <p class="font-semibold text-shadow-900">{formatCharge(entry.event.amount)}</p>
              <p class="text-xs text-shadow-500">{formatTime(entry.event.timestampMs)}</p>
            </div>
          </div>
        {:else}
          <p class="px-5 py-4 text-sm text-shadow-600">No charge events recorded.</p>
        {/each}
      </div>
    </section>
  {/if}
</div>
