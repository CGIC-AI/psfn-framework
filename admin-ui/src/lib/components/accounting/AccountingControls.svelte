<script lang="ts">
  import {
    ACCOUNTING_DIMENSION_OPTIONS,
    ACCOUNTING_RANGE_OPTIONS,
    type AccountingQueryState,
  } from '$lib/accounting/query-state';
  import {
    MODEL_USAGE_BUCKETS,
    MODEL_USAGE_GROUP_SORTS,
    type ModelUsageGroupDimension,
    type ModelUsageGroupSort,
  } from '../../../../../src/shared/telemetry/model-usage.js';
  import { formatDimensionValue, labelDimension, shortId } from '$lib/accounting/format';

  interface Props {
    queryState: AccountingQueryState;
    busy?: boolean;
    hasChanges?: boolean;
    exporting?: boolean;
    onChange: (queryState: AccountingQueryState) => void;
    onApply: () => void;
    onReset: () => void;
    onExport: (format: 'csv' | 'json') => void;
  }

  let {
    queryState,
    busy = false,
    hasChanges = false,
    exporting = false,
    onChange,
    onApply,
    onReset,
    onExport,
  }: Props = $props();
  let filterDimension = $state<ModelUsageGroupDimension>('model');
  let filterValue = $state('');

  function patch(change: Partial<AccountingQueryState>): void {
    onChange({ ...queryState, ...change });
  }

  function setPrimaryGroup(value: ModelUsageGroupDimension): void {
    const secondary = queryState.groupBy[1];
    patch({ groupBy: secondary && secondary !== value ? [value, secondary] : [value] });
  }

  function setSecondaryGroup(value: string): void {
    patch({
      groupBy: value && value !== queryState.groupBy[0]
        ? [queryState.groupBy[0] ?? 'model', value as ModelUsageGroupDimension]
        : [queryState.groupBy[0] ?? 'model'],
    });
  }

  function addFilter(): void {
    const value = filterValue.trim();
    if (!value) return;
    patch({ filters: { ...queryState.filters, [filterDimension]: value } });
    filterValue = '';
  }

  function removeFilter(dimension: ModelUsageGroupDimension): void {
    const filters = { ...queryState.filters };
    delete filters[dimension];
    patch({ filters });
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    onApply();
  }

  const activeFilters = $derived(Object.entries(queryState.filters)
    .filter((entry): entry is [ModelUsageGroupDimension, string] => Boolean(entry[1])));
</script>

<form class="card-garden overflow-hidden" aria-labelledby="accounting-controls-heading" onsubmit={submit}>
  <div class="border-b border-bark-300 px-5 py-4">
    <h3 id="accounting-controls-heading" class="font-serif text-lg font-semibold text-shadow-900">Analysis scope</h3>
    <p class="mt-1 text-sm text-shadow-600">Applied filters are saved in the URL so this exact operator view can be reopened or shared.</p>
  </div>

  <div class="space-y-5 p-5">
    <fieldset>
      <legend class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Calendar range</legend>
      <div class="mt-2 flex flex-wrap gap-2">
        {#each ACCOUNTING_RANGE_OPTIONS as option (option.value)}
          <button
            type="button"
            aria-pressed={queryState.range === option.value}
            onclick={() => patch({ range: option.value })}
            class="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors {queryState.range === option.value ? 'bg-shadow-900 text-bark-50' : 'border border-bark-300 text-shadow-700 hover:bg-bark-100'}"
          >
            {option.label}
          </button>
        {/each}
      </div>
    </fieldset>

    <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <label class="text-sm text-shadow-700">
        <span class="mb-1 block text-xs font-semibold uppercase tracking-[0.14em] text-shadow-500">Timezone</span>
        <input
          value={queryState.timezone}
          oninput={(event) => patch({ timezone: (event.currentTarget as HTMLInputElement).value })}
          placeholder="America/New_York"
          autocomplete="off"
          class="w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 focus:border-gold-400 focus:outline-none"
        />
      </label>
      <label class="text-sm text-shadow-700">
        <span class="mb-1 block text-xs font-semibold uppercase tracking-[0.14em] text-shadow-500">Bucket</span>
        <select
          value={queryState.bucket}
          onchange={(event) => patch({ bucket: (event.currentTarget as HTMLSelectElement).value as AccountingQueryState['bucket'] })}
          class="w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 focus:border-gold-400 focus:outline-none"
        >
          {#each MODEL_USAGE_BUCKETS as bucket}
            <option value={bucket}>{labelDimension(bucket)}</option>
          {/each}
        </select>
      </label>
      <label class="text-sm text-shadow-700">
        <span class="mb-1 block text-xs font-semibold uppercase tracking-[0.14em] text-shadow-500">Primary group</span>
        <select
          value={queryState.groupBy[0] ?? 'model'}
          onchange={(event) => setPrimaryGroup((event.currentTarget as HTMLSelectElement).value as ModelUsageGroupDimension)}
          class="w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 focus:border-gold-400 focus:outline-none"
        >
          {#each ACCOUNTING_DIMENSION_OPTIONS as dimension}
            <option value={dimension.value}>{dimension.label}</option>
          {/each}
        </select>
      </label>
      <label class="text-sm text-shadow-700">
        <span class="mb-1 block text-xs font-semibold uppercase tracking-[0.14em] text-shadow-500">Secondary group</span>
        <select
          value={queryState.groupBy[1] ?? ''}
          onchange={(event) => setSecondaryGroup((event.currentTarget as HTMLSelectElement).value)}
          class="w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 focus:border-gold-400 focus:outline-none"
        >
          <option value="">None</option>
          {#each ACCOUNTING_DIMENSION_OPTIONS as dimension}
            <option value={dimension.value} disabled={dimension.value === queryState.groupBy[0]}>{dimension.label}</option>
          {/each}
        </select>
      </label>
    </div>

    {#if queryState.range === 'custom'}
      <div class="rounded-xl border border-gold-300 bg-gold-50 p-4">
        <p class="text-sm text-shadow-700">Custom dates are inclusive calendar days at midnight in <strong>{queryState.timezone || 'the selected timezone'}</strong>.</p>
        <div class="mt-3 grid gap-4 sm:grid-cols-2">
          <label class="text-sm text-shadow-700">
            <span class="mb-1 block font-medium">Start date</span>
            <input
              type="date"
              value={queryState.customSinceDate}
              oninput={(event) => patch({ customSinceDate: (event.currentTarget as HTMLInputElement).value })}
              class="w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 focus:border-gold-400 focus:outline-none"
            />
          </label>
          <label class="text-sm text-shadow-700">
            <span class="mb-1 block font-medium">Through date</span>
            <input
              type="date"
              value={queryState.customUntilDate}
              oninput={(event) => patch({ customUntilDate: (event.currentTarget as HTMLInputElement).value })}
              class="w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 focus:border-gold-400 focus:outline-none"
            />
          </label>
        </div>
      </div>
    {/if}

    <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div>
        <p class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">Add declared-dimension filter</p>
        <div class="mt-2 grid gap-2 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto]">
          <select
            aria-label="Filter dimension"
            value={filterDimension}
            onchange={(event) => filterDimension = (event.currentTarget as HTMLSelectElement).value as ModelUsageGroupDimension}
            class="rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm focus:border-gold-400 focus:outline-none"
          >
            {#each ACCOUNTING_DIMENSION_OPTIONS as dimension}
              <option value={dimension.value}>{dimension.label}</option>
            {/each}
          </select>
          <input
            aria-label="Filter value"
            value={filterValue}
            oninput={(event) => filterValue = (event.currentTarget as HTMLInputElement).value}
            placeholder="Exact value"
            autocomplete="off"
            class="rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm focus:border-gold-400 focus:outline-none"
          />
          <button type="button" onclick={addFilter} class="rounded-lg border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700 hover:bg-bark-100">Add</button>
        </div>
        {#if activeFilters.length > 0}
          <div class="mt-3 flex flex-wrap gap-2" aria-label="Active accounting filters">
            {#each activeFilters as [dimension, value] (dimension)}
              <button
                type="button"
                onclick={() => removeFilter(dimension)}
                class="inline-flex max-w-full items-center gap-1 rounded-full border border-gold-300 bg-gold-50 px-3 py-1 text-xs text-shadow-700 hover:bg-gold-100"
                aria-label={`Remove ${labelDimension(dimension)} filter ${value}`}
              >
                <strong>{labelDimension(dimension)}:</strong> <span class="truncate">{shortId(formatDimensionValue(dimension, value))}</span> ×
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <div class="grid gap-3 sm:grid-cols-3">
        <label class="text-sm text-shadow-700">
          <span class="mb-1 block text-xs font-semibold uppercase tracking-[0.14em] text-shadow-500">Sort groups</span>
          <select
            value={queryState.sortBy}
            onchange={(event) => patch({ sortBy: (event.currentTarget as HTMLSelectElement).value as ModelUsageGroupSort })}
            class="w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 focus:border-gold-400 focus:outline-none"
          >
            {#each MODEL_USAGE_GROUP_SORTS as sort}
              <option value={sort}>{labelDimension(sort)}</option>
            {/each}
          </select>
        </label>
        <label class="text-sm text-shadow-700">
          <span class="mb-1 block text-xs font-semibold uppercase tracking-[0.14em] text-shadow-500">Direction</span>
          <select
            value={queryState.sortDirection}
            onchange={(event) => patch({ sortDirection: (event.currentTarget as HTMLSelectElement).value as AccountingQueryState['sortDirection'] })}
            class="w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 focus:border-gold-400 focus:outline-none"
          >
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </label>
        <label class="text-sm text-shadow-700">
          <span class="mb-1 block text-xs font-semibold uppercase tracking-[0.14em] text-shadow-500">Calls table</span>
          <select
            value={queryState.eventOrder}
            onchange={(event) => patch({ eventOrder: (event.currentTarget as HTMLSelectElement).value as AccountingQueryState['eventOrder'] })}
            class="w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 focus:border-gold-400 focus:outline-none"
          >
            <option value="expensive">Highest cost</option>
            <option value="recent">Most recent</option>
          </select>
        </label>
      </div>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-3 border-t border-bark-200 pt-4">
      <div class="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} class="rounded-lg bg-gold-600 px-4 py-2 text-sm font-semibold text-white hover:bg-gold-700 disabled:cursor-not-allowed disabled:opacity-50">
          {busy ? 'Loading…' : hasChanges ? 'Apply view' : 'Refresh view'}
        </button>
        <button type="button" onclick={onReset} disabled={busy} class="rounded-lg border border-bark-300 px-4 py-2 text-sm font-medium text-shadow-700 hover:bg-bark-100 disabled:opacity-50">Reset</button>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-xs text-shadow-500">Export the applied filtered call rows:</span>
        <button type="button" onclick={() => onExport('csv')} disabled={exporting || busy} class="rounded-lg border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700 hover:bg-bark-100 disabled:opacity-50">CSV</button>
        <button type="button" onclick={() => onExport('json')} disabled={exporting || busy} class="rounded-lg border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700 hover:bg-bark-100 disabled:opacity-50">JSON</button>
      </div>
    </div>
  </div>
</form>
