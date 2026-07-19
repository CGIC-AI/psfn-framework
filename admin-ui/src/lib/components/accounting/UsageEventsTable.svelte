<script lang="ts">
  import type { ModelUsageEvent, ModelUsageEventOrder } from '../../../../../src/shared/telemetry/model-usage.js';
  import {
    filterUsageEvents,
    sortUsageEvents,
    toggleUsageEventSort,
    type UsageEventSort,
    type UsageEventSortKey,
  } from '$lib/accounting/event-grid';
  import { formatDurationMs, formatInteger, formatTimestamp, formatUsd, shortId } from '$lib/accounting/format';
  import UsageEventDetails from './UsageEventDetails.svelte';

  interface Props {
    events: ModelUsageEvent[];
    order: ModelUsageEventOrder;
    hasMore: boolean;
    timezone: string;
  }

  let { events, order, hasMore, timezone }: Props = $props();

  let searchInput = $state('');
  let debouncedSearch = $state('');
  let sort = $state<UsageEventSort | null>(null);
  let expandedEventIds = $state<Set<string>>(new Set());

  let filteredEvents = $derived(filterUsageEvents(events, debouncedSearch));
  let visibleEvents = $derived(sortUsageEvents(filteredEvents, sort));

  $effect(() => {
    const nextSearch = searchInput;
    const timer = setTimeout(() => {
      debouncedSearch = nextSearch;
    }, 150);
    return () => clearTimeout(timer);
  });

  function setSort(key: UsageEventSortKey): void {
    sort = toggleUsageEventSort(sort, key);
  }

  function sortIndicator(key: UsageEventSortKey): string {
    if (sort?.key !== key) return '';
    return sort.direction === 'desc' ? '↓' : '↑';
  }

  function sortState(key: UsageEventSortKey): 'ascending' | 'descending' | 'none' {
    if (sort?.key !== key) return 'none';
    return sort.direction === 'desc' ? 'descending' : 'ascending';
  }

  function sortLabel(label: string, key: UsageEventSortKey): string {
    const state = sortState(key);
    return `Sort by ${label}; ${state === 'none' ? 'not sorted' : `sorted ${state}`}`;
  }

  function toggleExpanded(eventId: string): void {
    const next = new Set(expandedEventIds);
    if (next.has(eventId)) next.delete(eventId);
    else next.add(eventId);
    expandedEventIds = next;
  }
</script>

<section class="card-garden overflow-hidden" aria-labelledby="usage-calls-heading">
  <div class="border-b border-bark-300 px-5 py-4">
    <h3 id="usage-calls-heading" class="font-serif text-lg font-semibold text-shadow-900">{order === 'expensive' ? 'Highest-cost calls' : 'Recent calls'}</h3>
    <p class="mt-1 text-sm text-shadow-600">Call-level drill-down from the immutable usage ledger. Export includes every matching row, not only this bounded page.</p>

    <div class="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
      <div class="min-w-0 flex-1 lg:max-w-xl">
        <label for="usage-event-search" class="text-xs font-semibold uppercase tracking-[0.12em] text-shadow-600">Search loaded calls</label>
        <div class="mt-1 flex gap-2">
          <input
            id="usage-event-search"
            type="search"
            bind:value={searchInput}
            placeholder="Model, purpose, tool, session, channel, run, or error"
            aria-describedby="usage-event-search-scope"
            class="min-w-0 flex-1 rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm text-shadow-900 outline-none placeholder:text-shadow-400 focus:border-gold-500 focus:ring-2 focus:ring-gold-200"
          />
          {#if searchInput}
            <button
              type="button"
              class="rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm font-medium text-shadow-700 hover:border-gold-400 hover:bg-gold-50"
              onclick={() => searchInput = ''}
            >Clear</button>
          {/if}
        </div>
        <p id="usage-event-search-scope" class="mt-1.5 text-xs text-shadow-500">Searching the {formatInteger(events.length)} loaded calls; use dimension filters to narrow server-side.</p>
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <p class="text-sm text-shadow-700" aria-live="polite">Showing <strong>{formatInteger(filteredEvents.length)}</strong> of {formatInteger(events.length)} loaded calls</p>
        {#if sort}
          <button
            type="button"
            class="rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-xs font-medium text-shadow-700 hover:border-gold-400 hover:bg-gold-50"
            onclick={() => sort = null}
          >Clear column sort</button>
        {/if}
      </div>
    </div>
  </div>

  <div class="max-h-[32rem] overflow-auto">
    <table class="min-w-[96rem] divide-y divide-bark-200 text-left text-sm">
      <thead class="sticky top-0 z-10 bg-bark-50 text-xs uppercase tracking-[0.12em] text-shadow-500">
        <tr>
          <th class="w-10 px-3 py-3 font-semibold"><span class="sr-only">Details</span></th>
          <th class="whitespace-nowrap px-3 py-3 font-semibold" aria-sort={sortState('when')}>
            <button type="button" onclick={() => setSort('when')} class="hover:text-shadow-900" aria-label={sortLabel('when', 'when')}>When {sortIndicator('when')}</button>
          </th>
          <th class="px-3 py-3 font-semibold" aria-sort={sortState('model')}>
            <button type="button" onclick={() => setSort('model')} class="hover:text-shadow-900" aria-label={sortLabel('model', 'model')}>Model {sortIndicator('model')}</button>
          </th>
          <th class="px-3 py-3 font-semibold" aria-sort={sortState('purpose')}>
            <button type="button" onclick={() => setSort('purpose')} class="hover:text-shadow-900" aria-label={sortLabel('purpose', 'purpose')}>Purpose {sortIndicator('purpose')}</button>
          </th>
          <th class="px-3 py-3 font-semibold" aria-sort={sortState('tool')}>
            <button type="button" onclick={() => setSort('tool')} class="hover:text-shadow-900" aria-label={sortLabel('tool', 'tool')}>Tool {sortIndicator('tool')}</button>
          </th>
          <th class="whitespace-nowrap px-3 py-3 text-right font-semibold" aria-sort={sortState('inputTokens')}>
            <button type="button" onclick={() => setSort('inputTokens')} class="hover:text-shadow-900" aria-label={sortLabel('input tokens', 'inputTokens')}>Input {sortIndicator('inputTokens')}</button>
          </th>
          <th class="whitespace-nowrap px-3 py-3 text-right font-semibold" aria-sort={sortState('cacheReadTokens')}>
            <button type="button" onclick={() => setSort('cacheReadTokens')} class="hover:text-shadow-900" aria-label={sortLabel('cache read tokens', 'cacheReadTokens')}>Cache read {sortIndicator('cacheReadTokens')}</button>
          </th>
          <th class="whitespace-nowrap px-3 py-3 text-right font-semibold" aria-sort={sortState('cacheWriteTokens')}>
            <button type="button" onclick={() => setSort('cacheWriteTokens')} class="hover:text-shadow-900" aria-label={sortLabel('cache write tokens', 'cacheWriteTokens')}>Cache write {sortIndicator('cacheWriteTokens')}</button>
          </th>
          <th class="whitespace-nowrap px-3 py-3 text-right font-semibold" aria-sort={sortState('outputTokens')}>
            <button type="button" onclick={() => setSort('outputTokens')} class="hover:text-shadow-900" aria-label={sortLabel('output tokens', 'outputTokens')}>Output {sortIndicator('outputTokens')}</button>
          </th>
          <th class="whitespace-nowrap px-3 py-3 text-right font-semibold" aria-sort={sortState('totalTokens')}>
            <button type="button" onclick={() => setSort('totalTokens')} class="hover:text-shadow-900" aria-label={sortLabel('total tokens', 'totalTokens')}>Total tokens {sortIndicator('totalTokens')}</button>
          </th>
          <th class="whitespace-nowrap px-3 py-3 text-right font-semibold" aria-sort={sortState('effectiveCost')}>
            <button type="button" onclick={() => setSort('effectiveCost')} class="hover:text-shadow-900" aria-label={sortLabel('effective cost', 'effectiveCost')}>Effective cost {sortIndicator('effectiveCost')}</button>
          </th>
          <th class="whitespace-nowrap px-3 py-3 text-right font-semibold" aria-sort={sortState('duration')}>
            <button type="button" onclick={() => setSort('duration')} class="hover:text-shadow-900" aria-label={sortLabel('duration', 'duration')}>Duration {sortIndicator('duration')}</button>
          </th>
        </tr>
      </thead>
      <tbody class="divide-y divide-bark-200">
        {#each visibleEvents as event, index (event.id)}
          {@const expanded = expandedEventIds.has(event.id)}
          {@const detailId = `usage-event-detail-${index}`}
          <tr class={expanded ? 'bg-gold-50/30' : ''}>
            <td class="px-3 py-3 align-top">
              <button
                type="button"
                class="flex size-7 items-center justify-center rounded-md border border-bark-300 bg-bark-50 text-shadow-600 hover:border-gold-400 hover:text-shadow-900 focus:outline-none focus:ring-2 focus:ring-gold-400"
                aria-label={`${expanded ? 'Collapse' : 'Expand'} details for ${event.provider}:${event.model}`}
                aria-expanded={expanded}
                aria-controls={detailId}
                onclick={() => toggleExpanded(event.id)}
              ><span aria-hidden="true">{expanded ? '⌄' : '›'}</span></button>
            </td>
            <td class="whitespace-nowrap px-3 py-3 align-top">
              <p class="text-shadow-700">{formatTimestamp(event.recordedAtMs, timezone)}</p>
              <p class="mt-1 font-mono text-xs text-shadow-500" title={event.logicalCallId}>{shortId(event.logicalCallId)} · attempt {event.attempt}</p>
              <p class="mt-1 text-xs {event.status === 'success' ? 'text-moss-600' : 'text-wilt-600'}">{event.status} · {event.settlement}</p>
            </td>
            <td class="max-w-64 px-3 py-3 align-top">
              <p class="break-words font-medium text-shadow-800" title={`${event.provider}:${event.model}`}>{event.provider}:{event.model}</p>
              <p class="mt-1 text-xs text-shadow-500">{event.callKind}</p>
            </td>
            <td class="max-w-56 px-3 py-3 align-top">
              <p class="break-words text-shadow-700" title={event.attribution.purpose}>{event.attribution.purpose}</p>
              <p class="mt-1 text-xs text-shadow-500">{event.attribution.callType}</p>
            </td>
            <td class="max-w-48 px-3 py-3 align-top text-shadow-700" title={event.attribution.toolName !== 'unknown' ? event.attribution.toolName : undefined}>
              {event.attribution.toolName === 'unknown' ? '—' : event.attribution.toolName}
            </td>
            <td class="px-3 py-3 text-right text-shadow-600">{formatInteger(event.inputTokens)}</td>
            <td class="px-3 py-3 text-right text-shadow-600">{formatInteger(event.cacheReadTokens)}</td>
            <td class="px-3 py-3 text-right text-shadow-600">{formatInteger(event.cacheWriteTokens)}</td>
            <td class="px-3 py-3 text-right text-shadow-600">{formatInteger(event.outputTokens)}</td>
            <td class="px-3 py-3 text-right font-medium text-shadow-700">{formatInteger(event.totalTokens)}</td>
            <td class="px-3 py-3 text-right font-semibold text-shadow-900">{event.effectiveCost.total === undefined ? 'Unknown' : formatUsd(event.effectiveCost.total)}</td>
            <td class="px-3 py-3 text-right text-shadow-600">{formatDurationMs(event.durationMs)}</td>
          </tr>
          {#if expanded}
            <tr id={detailId}>
              <td colspan="12" class="p-0">
                <UsageEventDetails {event} {timezone} {detailId} />
              </td>
            </tr>
          {/if}
        {:else}
          <tr><td colspan="12" class="px-5 py-8 text-center text-shadow-600">{debouncedSearch.trim() ? 'No loaded calls match this search.' : 'No call rows match this view.'}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if hasMore}
    <p class="border-t border-bark-200 px-5 py-3 text-xs text-shadow-500">This table is bounded to 100 rows. Use filtered CSV or JSON export for the complete result.</p>
  {/if}
</section>
