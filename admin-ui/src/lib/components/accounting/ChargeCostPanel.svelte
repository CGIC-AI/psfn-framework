<script lang="ts">
  import type { AdminChargeCostData } from '$lib/api/endpoints/charge-costs';
  import type { ChargeCostBreakdown } from '../../../../../src/shared/telemetry/charge-cost-reconciliation-contracts.js';
  import type { ModelUsageGroupDimension } from '../../../../../src/shared/telemetry/model-usage.js';
  import { formatInteger, formatPercent, formatUsd, labelDimension } from '$lib/accounting/format';

  interface Props {
    data: AdminChargeCostData;
    filtersNotApplied: ModelUsageGroupDimension[];
  }

  let { data, filtersNotApplied }: Props = $props();
  const dispositions = $derived([
    ['Attributable', data.buckets.attributable],
    ['Charged without usage', data.buckets.chargedWithoutUsage],
    ['Usage without charge', data.buckets.usageWithoutCharge],
    ['Ambiguous', data.buckets.ambiguous],
    ['Non-model charges', data.buckets.nonModelCharges],
  ] as const);
  const breakdownSections = $derived<Array<{ label: string; rows: ChargeCostBreakdown[] }>>([
    { label: 'Lane', rows: data.breakdowns.byLane },
    { label: 'Surface', rows: data.breakdowns.bySurface },
  ]);
</script>

<section class="card-garden overflow-hidden" aria-labelledby="charge-cost-heading">
  <div class="border-b border-bark-300 px-5 py-4">
    <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Operator-only reconciliation</p>
    <h3 id="charge-cost-heading" class="mt-1 font-serif text-lg font-semibold text-shadow-900">Charge units and model dollars</h3>
    <p class="mt-1 text-sm text-shadow-600">Charge units and effective dollars are separate ledgers. They are reconciled for coverage and never added together.</p>
    {#if filtersNotApplied.length > 0}
      <p class="mt-2 rounded-lg border border-gold-300 bg-gold-50 px-3 py-2 text-xs text-shadow-700" role="status">
        Reconciliation supports the selected time range plus compatible lineage filters. These usage-only filters do not narrow charge coverage:
        {filtersNotApplied.map(labelDimension).join(', ')}.
      </p>
    {/if}
  </div>

  <div class="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-4">
    <article class="rounded-xl border border-bark-300 bg-bark-50 p-4">
      <p class="text-xs uppercase tracking-[0.14em] text-shadow-500">Charge units</p>
      <p class="mt-2 font-serif text-2xl font-bold text-shadow-900">{formatInteger(data.sourceTotals.chargeUnits)}</p>
      <p class="mt-1 text-xs text-shadow-500">{formatInteger(data.sourceTotals.chargeEvents)} immutable charge events</p>
    </article>
    <article class="rounded-xl border border-bark-300 bg-bark-50 p-4">
      <p class="text-xs uppercase tracking-[0.14em] text-shadow-500">Effective model cost</p>
      <p class="mt-2 font-serif text-2xl font-bold text-gold-700">{formatUsd(data.sourceTotals.effectiveCostUsd)}</p>
      <p class="mt-1 text-xs text-shadow-500">{formatInteger(data.sourceTotals.calls)} immutable usage calls</p>
    </article>
    <article class="rounded-xl border border-bark-300 bg-bark-50 p-4">
      <p class="text-xs uppercase tracking-[0.14em] text-shadow-500">Charge coverage</p>
      <p class="mt-2 font-serif text-2xl font-bold text-moss-600">{formatPercent(data.coverage.charge.coveragePercent)}</p>
      <p class="mt-1 text-xs text-shadow-500">{formatInteger(data.coverage.charge.attributableUnits)} of {formatInteger(data.coverage.charge.totalUnits)} units attributable</p>
    </article>
    <article class="rounded-xl border border-bark-300 bg-bark-50 p-4">
      <p class="text-xs uppercase tracking-[0.14em] text-shadow-500">Usage coverage</p>
      <p class="mt-2 font-serif text-2xl font-bold text-moss-600">{formatPercent(data.coverage.usage.coveragePercent)}</p>
      <p class="mt-1 text-xs text-shadow-500">{formatInteger(data.coverage.usage.attributableCalls)} of {formatInteger(data.coverage.usage.totalCalls)} calls attributable</p>
    </article>
  </div>

  <div class="grid gap-5 border-t border-bark-200 p-5 xl:grid-cols-2">
    <div class="overflow-x-auto">
      <h4 class="font-serif font-semibold text-shadow-900">Classification coverage</h4>
      <table class="mt-2 min-w-full divide-y divide-bark-200 text-left text-sm">
        <thead class="text-xs uppercase tracking-[0.12em] text-shadow-500">
          <tr><th class="py-2 pr-3 font-semibold">Disposition</th><th class="px-3 py-2 text-right font-semibold">Units</th><th class="px-3 py-2 text-right font-semibold">Calls</th><th class="py-2 pl-3 text-right font-semibold">Dollars</th></tr>
        </thead>
        <tbody class="divide-y divide-bark-200">
          {#each dispositions as [label, metrics] (label)}
            <tr><td class="py-2 pr-3 text-shadow-700">{label}</td><td class="px-3 py-2 text-right text-shadow-600">{formatInteger(metrics.chargeUnits)}</td><td class="px-3 py-2 text-right text-shadow-600">{formatInteger(metrics.calls)}</td><td class="py-2 pl-3 text-right font-medium text-shadow-800">{formatUsd(metrics.effectiveCostUsd)}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div>
      <h4 class="font-serif font-semibold text-shadow-900">Reconciliation integrity</h4>
      <div class="mt-2 space-y-2 text-sm text-shadow-700">
        <p class="flex items-center justify-between gap-3 rounded-lg bg-bark-50 px-3 py-2">
          <span>Charge ledger classified</span>
          <strong class={data.ledgerReconciliation.charge.reconciled ? 'text-moss-600' : 'text-wilt-600'}>{data.ledgerReconciliation.charge.reconciled ? 'Reconciled' : 'Mismatch'}</strong>
        </p>
        <p class="flex items-center justify-between gap-3 rounded-lg bg-bark-50 px-3 py-2">
          <span>Usage ledger classified</span>
          <strong class={data.ledgerReconciliation.usage.reconciled ? 'text-moss-600' : 'text-wilt-600'}>{data.ledgerReconciliation.usage.reconciled ? 'Reconciled' : 'Mismatch'}</strong>
        </p>
        <p class="rounded-lg bg-bark-50 px-3 py-2">
          Attributable rate: {data.buckets.attributable.dollarsPerChargeUnit === null ? 'not available' : `${formatUsd(data.buckets.attributable.dollarsPerChargeUnit)} per charge unit`}.
        </p>
      </div>
    </div>
  </div>

  <details class="border-t border-bark-200 px-5 py-3">
    <summary class="cursor-pointer text-sm font-medium text-shadow-700">Lane and surface reconciliation breakdown</summary>
    <div class="mt-3 grid gap-4 lg:grid-cols-2">
      {#each breakdownSections as section (section.label)}
        <div class="overflow-x-auto">
          <h4 class="text-xs font-semibold uppercase tracking-[0.14em] text-shadow-500">By {section.label}</h4>
          <table class="mt-2 min-w-full divide-y divide-bark-200 text-sm">
            <tbody class="divide-y divide-bark-200">
              {#each section.rows as row (row.key)}
                <tr><td class="py-2 pr-3 font-mono text-xs text-shadow-700">{row.key}</td><td class="px-3 py-2 text-right text-shadow-600">{formatInteger(row.chargeUnits)} units</td><td class="py-2 pl-3 text-right text-shadow-600">{formatUsd(row.effectiveCostUsd)}</td></tr>
              {:else}
                <tr><td class="py-3 text-shadow-600">No {section.label.toLowerCase()} rows.</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/each}
    </div>
  </details>
</section>
