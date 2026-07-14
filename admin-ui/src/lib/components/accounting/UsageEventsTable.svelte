<script lang="ts">
  import type { ModelUsageEvent, ModelUsageEventOrder } from '../../../../../src/shared/telemetry/model-usage.js';
  import { formatInteger, formatTimestamp, formatUsd, shortId } from '$lib/accounting/format';

  interface Props {
    events: ModelUsageEvent[];
    order: ModelUsageEventOrder;
    hasMore: boolean;
    timezone: string;
  }

  let { events, order, hasMore, timezone }: Props = $props();
</script>

<section class="card-garden overflow-hidden" aria-labelledby="usage-calls-heading">
  <div class="border-b border-bark-300 px-5 py-4">
    <h3 id="usage-calls-heading" class="font-serif text-lg font-semibold text-shadow-900">{order === 'expensive' ? 'Highest-cost calls' : 'Recent calls'}</h3>
    <p class="mt-1 text-sm text-shadow-600">Call-level drill-down from the immutable usage ledger. Export includes every matching row, not only this bounded page.</p>
  </div>
  <div class="max-h-[32rem] overflow-auto">
    <table class="min-w-full divide-y divide-bark-200 text-left text-sm">
      <thead class="sticky top-0 bg-bark-50 text-xs uppercase tracking-[0.12em] text-shadow-500">
        <tr>
          <th class="px-5 py-3 font-semibold">When / call</th>
          <th class="px-3 py-3 font-semibold">Attribution</th>
          <th class="px-3 py-3 text-right font-semibold">Input</th>
          <th class="px-3 py-3 text-right font-semibold">Cache read</th>
          <th class="px-3 py-3 text-right font-semibold">Cache write</th>
          <th class="px-3 py-3 text-right font-semibold">Output</th>
          <th class="px-5 py-3 text-right font-semibold">Effective cost</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-bark-200">
        {#each events as event (event.id)}
          <tr>
            <td class="whitespace-nowrap px-5 py-3 align-top">
              <p class="text-shadow-700">{formatTimestamp(event.recordedAtMs, timezone)}</p>
              <p class="mt-1 font-mono text-xs text-shadow-500">{shortId(event.logicalCallId)} · attempt {event.attempt}</p>
              <p class="mt-1 text-xs {event.status === 'success' ? 'text-moss-600' : 'text-wilt-600'}">{event.status} · {event.settlement}</p>
            </td>
            <td class="min-w-64 px-3 py-3 align-top">
              <p class="font-medium text-shadow-800">{event.provider}:{event.model}</p>
              <p class="mt-1 text-xs text-shadow-500">{event.callKind} · {event.attribution.callType} · {event.attribution.purpose}</p>
              <p class="mt-1 text-xs text-shadow-500">
                {event.attribution.toolName !== 'unknown' ? `tool ${shortId(event.attribution.toolName)} · ` : ''}
                {event.attribution.chargeRunId !== 'unknown' ? `run ${shortId(event.attribution.chargeRunId)}` : 'no charge run'}
              </p>
            </td>
            <td class="px-3 py-3 text-right text-shadow-600">{formatInteger(event.inputTokens)}</td>
            <td class="px-3 py-3 text-right text-shadow-600">{formatInteger(event.cacheReadTokens)}</td>
            <td class="px-3 py-3 text-right text-shadow-600">{formatInteger(event.cacheWriteTokens)}</td>
            <td class="px-3 py-3 text-right text-shadow-600">{formatInteger(event.outputTokens)}</td>
            <td class="px-5 py-3 text-right font-semibold text-shadow-900">{event.effectiveCost.total === undefined ? 'Unknown' : formatUsd(event.effectiveCost.total)}</td>
          </tr>
        {:else}
          <tr><td colspan="7" class="px-5 py-8 text-center text-shadow-600">No call rows match this view.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if hasMore}
    <p class="border-t border-bark-200 px-5 py-3 text-xs text-shadow-500">This table is bounded to 100 rows. Use filtered CSV or JSON export for the complete result.</p>
  {/if}
</section>
