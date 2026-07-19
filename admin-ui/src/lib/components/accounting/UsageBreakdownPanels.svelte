<script lang="ts">
  import {
    buildUsageBreakdownRows,
    sumUsageBreakdownMetrics,
    type UsageBreakdownDimension,
    type UsageBreakdownRow,
  } from '$lib/accounting/usage-breakdown';
  import { formatInteger, formatUsd, labelDimension } from '$lib/accounting/format';
  import { seriesColor } from './charts/chart-colors';
  import type {
    ModelUsageBreakdown,
    ModelUsageGroupDimension,
    ModelUsageSortDirection,
  } from '../../../../../src/shared/telemetry/model-usage.js';

  interface Props {
    byModel: ModelUsageBreakdown[];
    byPurpose: ModelUsageBreakdown[];
    byTool: ModelUsageBreakdown[];
    byChannel: ModelUsageBreakdown[];
    detailByCallKind: ModelUsageBreakdown[];
    channelLoading: boolean;
    channelError: string;
    onDrilldown: (dimension: ModelUsageGroupDimension, value: string) => void;
  }

  interface PanelDefinition {
    dimension: UsageBreakdownDimension;
    title: string;
    description: string;
    items: ModelUsageBreakdown[];
  }

  type PanelSortState = Record<UsageBreakdownDimension, ModelUsageSortDirection>;

  let {
    byModel,
    byPurpose,
    byTool,
    byChannel,
    detailByCallKind,
    channelLoading,
    channelError,
    onDrilldown,
  }: Props = $props();

  let panelSort = $state<PanelSortState>({
    model: 'desc',
    purpose: 'desc',
    toolName: 'desc',
    channelId: 'desc',
  });

  // Call kind has five canonical values, so this operator-visible partition is complete even though
  // the higher-cardinality breakdowns are server-capped. It keeps Other accurate without mixing in
  // companion-private totals.
  const detailTotals = $derived(sumUsageBreakdownMetrics(detailByCallKind));

  const panels = $derived<PanelDefinition[]>([
    {
      dimension: 'model',
      title: 'By model',
      description: 'Provider and model combinations doing the work.',
      items: byModel,
    },
    {
      dimension: 'purpose',
      title: 'By purpose',
      description: 'Runtime purposes responsible for token spend.',
      items: byPurpose,
    },
    {
      dimension: 'toolName',
      title: 'By tool',
      description: 'Tools whose flows initiated model calls.',
      items: byTool,
    },
    {
      dimension: 'channelId',
      title: 'By channel',
      description: 'Channels and group chats ranked by model cost.',
      items: byChannel,
    },
  ]);

  function toggleDirection(dimension: UsageBreakdownDimension): void {
    panelSort[dimension] = panelSort[dimension] === 'desc' ? 'asc' : 'desc';
  }
</script>

{#snippet rowContent(row: UsageBreakdownRow)}
  <span class="min-w-0">
    <span class="block truncate text-sm font-medium text-shadow-900" title={row.label}>{row.label}</span>
    <span class="mt-0.5 block text-xs text-shadow-500">{formatInteger(row.totalTokens)} tokens</span>
  </span>
  <span class="text-right">
    <span class="block text-sm font-semibold text-shadow-900">{formatUsd(row.effectiveCostUsd)}</span>
  </span>
{/snippet}

<section class="space-y-3" aria-labelledby="usage-attribution-heading">
  <div>
    <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Attribution detail</p>
    <h3 id="usage-attribution-heading" class="mt-1 font-serif text-lg font-semibold text-shadow-900">What did the work</h3>
  </div>

  <div class="grid gap-4 md:grid-cols-2">
    {#each panels as panel (panel.dimension)}
      {@const sort = panelSort[panel.dimension]}
      {@const rows = buildUsageBreakdownRows(panel.items, {
        dimension: panel.dimension,
        sortDirection: sort,
        detailTotals: panel.items.length > 0 ? detailTotals : undefined,
      })}
      {@const maximumCost = Math.max(0, ...rows.map(row => row.effectiveCostUsd))}
      <article class="card-garden overflow-hidden" aria-labelledby={`usage-${panel.dimension}-heading`}>
        <div class="border-b border-bark-300 px-4 py-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <h4 id={`usage-${panel.dimension}-heading`} class="font-serif text-base font-semibold text-shadow-900">{panel.title}</h4>
              <p class="mt-1 text-xs text-shadow-600">{panel.description}</p>
            </div>
            <div class="flex items-center gap-1.5">
              <button
                type="button"
                onclick={() => toggleDirection(panel.dimension)}
                class="rounded-lg border border-bark-300 bg-bark-50 px-2.5 py-1.5 text-xs text-shadow-700 hover:border-gold-400 hover:bg-gold-50"
                aria-label={`${sort === 'desc' ? 'Sort cost ascending' : 'Sort cost descending'} for ${panel.title.toLowerCase()}`}
                title={`Effective cost, ${sort === 'desc' ? 'descending' : 'ascending'}`}
              >
                Cost {sort === 'desc' ? '↓' : '↑'}
              </button>
            </div>
          </div>
          {#if panel.dimension === 'channelId' && channelLoading}
            <p class="mt-2 text-xs text-shadow-500" role="status">Refreshing channel attribution…</p>
          {/if}
        </div>

        {#if panel.dimension === 'channelId' && channelError}
          <p class="border-b border-wilt-300 bg-wilt-50 px-4 py-2 text-xs text-wilt-700" role="alert">{channelError}</p>
        {/if}

        <div class="space-y-2 p-3">
          {#each rows as row, index (row.key)}
            {@const widthPercent = maximumCost === 0 ? 0 : row.effectiveCostUsd / maximumCost * 100}
            <div class="relative overflow-hidden rounded-lg border border-bark-200 bg-bark-50/60">
              <div
                class="absolute inset-y-0 left-0 opacity-[0.12]"
                style={`width: ${widthPercent}%; background-color: ${seriesColor(index)}`}
                aria-hidden="true"
              ></div>
              {#if row.drillValue !== null}
                <button
                  type="button"
                  onclick={() => onDrilldown(panel.dimension, row.drillValue as string)}
                  class="relative z-10 grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left hover:bg-gold-50/60 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-gold-400"
                  title={`Filter ${labelDimension(panel.dimension)} to ${row.drillValue}`}
                >
                  {@render rowContent(row)}
                </button>
              {:else}
                <div class="relative z-10 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2">
                  {@render rowContent(row)}
                </div>
              {/if}
            </div>
          {:else}
            <p class="px-2 py-7 text-center text-sm text-shadow-600">
              {panel.dimension === 'channelId' && channelLoading
                ? 'Loading channel attribution…'
                : 'No attributed usage matches this view.'}
            </p>
          {/each}
        </div>
      </article>
    {/each}
  </div>
</section>
