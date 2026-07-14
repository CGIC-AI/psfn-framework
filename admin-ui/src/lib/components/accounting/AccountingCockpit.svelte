<script lang="ts">
  import { onMount } from 'svelte';
  import AccountingControls from './AccountingControls.svelte';
  import ChargeCostPanel from './ChargeCostPanel.svelte';
  import UsageBreakdownTable from './UsageBreakdownTable.svelte';
  import UsageEventsTable from './UsageEventsTable.svelte';
  import UsageMetricCards from './UsageMetricCards.svelte';
  import UsageTimeSeries from './UsageTimeSeries.svelte';
  import {
    accountingStateFromSearchParams,
    accountingStateToSearchParams,
    buildChargeCostQuery,
    buildModelUsageQuery,
    createDefaultAccountingState,
    unsupportedChargeCostFilters,
    type AccountingQueryState,
  } from '$lib/accounting/query-state';
  import { formatTimestamp } from '$lib/accounting/format';
  import { getChargeCosts, type AdminChargeCostData } from '$lib/api/endpoints/charge-costs';
  import {
    downloadModelUsageExport,
    getModelUsage,
    type AdminModelUsageData,
  } from '$lib/api/endpoints/model-usage';
  import type {
    ModelUsageGroupDimension,
    ModelUsageGroupSort,
  } from '../../../../../src/shared/telemetry/model-usage.js';

  const REFRESH_INTERVAL_MS = 30_000;

  let draftState = $state<AccountingQueryState>(createDefaultAccountingState());
  let appliedState = $state<AccountingQueryState>(createDefaultAccountingState());
  let usage = $state<AdminModelUsageData | null>(null);
  let chargeCosts = $state<AdminChargeCostData | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let stale = $state(false);
  let errorMessage = $state('');
  let chargeCostError = $state('');
  let exportError = $state('');
  let exporting = $state(false);
  let lastSuccessfulAt = $state<number | null>(null);
  let latestRequestId = 0;

  const dirty = $derived(
    accountingStateToSearchParams(draftState).toString()
      !== accountingStateToSearchParams(appliedState).toString(),
  );
  const chargeFiltersNotApplied = $derived(unsupportedChargeCostFilters(appliedState));

  function cloneState(source: AccountingQueryState): AccountingQueryState {
    return { ...source, groupBy: [...source.groupBy], filters: { ...source.filters } };
  }

  function updateUrl(source: AccountingQueryState): void {
    const url = new URL(window.location.href);
    const next = accountingStateToSearchParams(source);
    url.search = next.toString();
    window.history.replaceState(window.history.state, '', url);
  }

  async function load(nextState: AccountingQueryState, mode: 'initial' | 'apply' | 'poll'): Promise<void> {
    const requestedState = cloneState(nextState);
    let modelQuery;
    try {
      modelQuery = buildModelUsageQuery(requestedState);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Invalid accounting view.';
      loading = false;
      refreshing = false;
      return;
    }

    const requestId = ++latestRequestId;
    if (mode === 'initial') loading = true;
    else refreshing = true;
    if (mode !== 'poll') errorMessage = '';
    exportError = '';

    try {
      const nextUsage = await getModelUsage(modelQuery);
      if (requestId !== latestRequestId) return;

      let nextChargeCosts: AdminChargeCostData | null = null;
      let nextChargeCostError = '';
      try {
        nextChargeCosts = await getChargeCosts(buildChargeCostQuery(requestedState, nextUsage.resolvedRange));
      } catch (error) {
        nextChargeCostError = error instanceof Error
          ? error.message
          : 'Charge-cost reconciliation is unavailable.';
      }
      if (requestId !== latestRequestId) return;

      usage = nextUsage;
      chargeCosts = nextChargeCosts;
      chargeCostError = nextChargeCostError;
      appliedState = requestedState;
      lastSuccessfulAt = Date.now();
      stale = false;
      errorMessage = '';
      if (mode !== 'poll') draftState = cloneState(requestedState);
      updateUrl(requestedState);
    } catch (error) {
      if (requestId !== latestRequestId) return;
      errorMessage = error instanceof Error ? error.message : 'Failed to load persisted accounting data.';
      stale = usage !== null;
    } finally {
      if (requestId === latestRequestId) {
        loading = false;
        refreshing = false;
      }
    }
  }

  function applyCurrent(): void {
    void load(draftState, 'apply');
  }

  function reset(): void {
    const defaults = createDefaultAccountingState();
    draftState = defaults;
    void load(defaults, 'apply');
  }

  function sortGroups(sortBy: ModelUsageGroupSort): void {
    const next = cloneState(appliedState);
    next.sortDirection = next.sortBy === sortBy && next.sortDirection === 'desc' ? 'asc' : 'desc';
    next.sortBy = sortBy;
    draftState = next;
    void load(next, 'apply');
  }

  function drilldown(dimension: ModelUsageGroupDimension, value: string): void {
    const next = cloneState(appliedState);
    next.filters = { ...next.filters, [dimension]: value };
    draftState = next;
    void load(next, 'apply');
  }

  async function exportRows(format: 'csv' | 'json'): Promise<void> {
    exporting = true;
    exportError = '';
    try {
      const download = await downloadModelUsageExport(format, buildModelUsageQuery(appliedState));
      const objectUrl = URL.createObjectURL(download.blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = download.filename ?? `model-usage.${format}`;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      exportError = error instanceof Error ? error.message : `Failed to export ${format.toUpperCase()}.`;
    } finally {
      exporting = false;
    }
  }

  onMount(() => {
    const initialState = accountingStateFromSearchParams(new URLSearchParams(window.location.search));
    draftState = initialState;
    appliedState = cloneState(initialState);
    void load(initialState, 'initial');
    const timer = window.setInterval(() => {
      if (!loading && !refreshing) void load(appliedState, 'poll');
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  });
</script>

<div class="space-y-5">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div>
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Postgres accounting ledger</p>
      <h2 class="mt-1 font-serif text-xl font-semibold text-shadow-900">Model usage analysis</h2>
      <p class="mt-1 max-w-3xl text-sm text-shadow-600">One canonical view across model calls, tokens, effective dollars, charge-unit reconciliation, attribution, and exports.</p>
    </div>
    <div class="text-right text-xs text-shadow-500">
      {#if usage}
        <p>{usage.resolvedRange.boundary} · {usage.resolvedRange.timezone}</p>
        <p>{formatTimestamp(usage.resolvedRange.sinceMs, usage.resolvedRange.timezone)} to {formatTimestamp(usage.resolvedRange.untilMs, usage.resolvedRange.timezone)}</p>
      {/if}
    </div>
  </div>

  <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
    {loading ? 'Loading persisted accounting data.' : stale ? 'Accounting data is stale because refresh failed.' : refreshing ? 'Refreshing accounting data.' : 'Accounting data is current.'}
  </p>

  <AccountingControls
    queryState={draftState}
    busy={loading || refreshing}
    {exporting}
    onChange={(next) => draftState = next}
    onApply={applyCurrent}
    onReset={reset}
    onExport={(format) => void exportRows(format)}
  />

  {#if dirty && !loading}
    <p class="rounded-lg border border-gold-300 bg-gold-50 px-4 py-2 text-sm text-shadow-700" role="status">Controls have unapplied changes; graphs, tables, and export still use the last applied URL view.</p>
  {/if}

  {#if errorMessage}
    <div class="rounded-xl border border-wilt-300 bg-wilt-50 px-4 py-3" role="alert">
      <p class="font-medium text-wilt-700">{stale ? 'Refresh failed; showing last successful data.' : 'Accounting data unavailable.'}</p>
      <p class="mt-1 text-sm text-wilt-600">{errorMessage}</p>
    </div>
  {/if}
  {#if exportError}
    <p class="rounded-lg border border-wilt-300 bg-wilt-50 px-4 py-2 text-sm text-wilt-700" role="alert">{exportError}</p>
  {/if}

  {#if loading && !usage}
    <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Loading accounting data">
      {#each Array(8) as _}
        <div class="card-garden h-28 animate-pulse bg-bark-50"></div>
      {/each}
    </div>
  {:else if usage}
    <div class="flex flex-wrap items-center gap-2 text-xs text-shadow-600">
      <span class="rounded-full border px-3 py-1 {stale ? 'border-wilt-300 bg-wilt-50 text-wilt-700' : 'border-moss-300 bg-moss-50 text-moss-700'}">{stale ? 'Stale persisted data' : 'Current persisted data'}</span>
      <span>Last successful refresh {lastSuccessfulAt ? formatTimestamp(lastSuccessfulAt, appliedState.timezone) : 'unknown'}</span>
      {#if refreshing}<span>Refreshing…</span>{/if}
    </div>

    <UsageMetricCards totals={usage.totals} />

    {#if usage.totals.calls === 0}
      <div class="card-garden px-5 py-8 text-center">
        <h3 class="font-serif text-lg font-semibold text-shadow-900">No model calls match this view</h3>
        <p class="mt-1 text-sm text-shadow-600">Change the date range or remove a filter. This is a real empty result from the persisted ledger.</p>
      </div>
    {/if}

    <UsageTimeSeries buckets={usage.timeSeries} timezone={usage.resolvedRange.timezone} />
    <UsageBreakdownTable
      groups={usage.groups}
      groupedBy={usage.query.groupBy ?? appliedState.groupBy}
      coverage={usage.attributionCoverage}
      sortBy={appliedState.sortBy}
      sortDirection={appliedState.sortDirection}
      onSort={sortGroups}
      onDrilldown={drilldown}
    />

    {#if chargeCosts}
      <ChargeCostPanel data={chargeCosts} filtersNotApplied={chargeFiltersNotApplied} />
    {:else if chargeCostError}
      <div class="rounded-xl border border-wilt-300 bg-wilt-50 px-4 py-3" role="alert">
        <p class="font-medium text-wilt-700">Charge-cost reconciliation unavailable</p>
        <p class="mt-1 text-sm text-wilt-600">Model usage above remains current. {chargeCostError}</p>
      </div>
    {/if}

    <UsageEventsTable
      events={usage.eventPage.items}
      order={usage.eventPage.order}
      hasMore={usage.eventPage.hasMore}
      timezone={usage.resolvedRange.timezone}
    />
  {/if}
</div>
