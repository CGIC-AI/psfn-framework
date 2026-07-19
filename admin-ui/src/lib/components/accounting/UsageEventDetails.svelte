<script lang="ts">
  import type {
    ModelUsageCostBreakdown,
    ModelUsageEvent,
  } from '../../../../../src/shared/telemetry/model-usage.js';
  import {
    formatDurationMs,
    formatUsd,
    labelDimension,
    shortId,
  } from '$lib/accounting/format';
  import { pushToast } from '$lib/stores/toast.svelte';

  interface Props {
    event: ModelUsageEvent;
    timezone: string;
    detailId: string;
  }

  interface DetailEntry {
    label: string;
    value: string;
    copy?: boolean;
  }

  interface DetailSection {
    key: string;
    heading: string;
    entries: DetailEntry[];
  }

  interface CostRow {
    label: string;
    cost: ModelUsageCostBreakdown;
  }

  let { event, timezone, detailId }: Props = $props();

  let identityEntries: DetailEntry[] = $derived([
    { label: 'Event ID', value: event.id, copy: true },
    { label: 'Logical call ID', value: event.logicalCallId, copy: true },
    { label: 'Attempt', value: String(event.attempt) },
    { label: 'Call kind', value: event.callKind },
    { label: 'Slot key', value: event.slotKey ?? 'unknown' },
    {
      label: 'Requested model',
      value: event.requestedProvider && event.requestedModel
        ? `${event.requestedProvider}:${event.requestedModel}`
        : 'unknown',
    },
  ]);

  let attributionEntries: DetailEntry[] = $derived([
    { label: 'Companion ID', value: event.attribution.companionId, copy: true },
    { label: 'Session ID', value: event.attribution.sessionId, copy: true },
    { label: 'Channel ID', value: event.attribution.channelId, copy: true },
    { label: 'Channel type', value: event.attribution.channelType },
    { label: 'Call type', value: event.attribution.callType },
    { label: 'Purpose', value: event.attribution.purpose },
    { label: 'Origin type', value: event.attribution.originType },
    { label: 'Origin stage', value: event.attribution.originStage },
    { label: 'Service', value: event.attribution.service },
    { label: 'Process', value: event.attribution.process },
    { label: 'Turn ID', value: event.attribution.turnId, copy: true },
    { label: 'Request ID', value: event.attribution.requestId, copy: true },
    { label: 'Tool name', value: event.attribution.toolName },
    { label: 'Tool call ID', value: event.attribution.toolCallId, copy: true },
    { label: 'Runtime lane class', value: event.attribution.runtimeLaneClass },
    { label: 'Charge lane', value: event.attribution.chargeLane },
    { label: 'Charge surface', value: event.attribution.chargeSurface },
    { label: 'Charge event ID', value: event.attribution.chargeEventId, copy: true },
    { label: 'Charge run ID', value: event.attribution.chargeRunId, copy: true },
    { label: 'Charge root run ID', value: event.attribution.chargeRootRunId, copy: true },
    { label: 'Charge parent run ID', value: event.attribution.chargeParentRunId, copy: true },
    { label: 'Shard ID', value: event.attribution.shardId, copy: true },
    { label: 'Subagent ID', value: event.attribution.subagentId, copy: true },
    { label: 'Conversation ID', value: event.attribution.conversationId, copy: true },
    { label: 'Root initiation ID', value: event.attribution.rootInitiationId, copy: true },
    { label: 'Workload type', value: event.attribution.workloadType },
    { label: 'Workload ID', value: event.attribution.workloadId, copy: true },
  ]);

  let detailSections: DetailSection[] = $derived([
    { key: 'identity', heading: 'Call identity', entries: identityEntries },
    { key: 'attribution', heading: 'Full attribution', entries: attributionEntries },
  ]);

  let costRows: CostRow[] = $derived([
    { label: 'Provider', cost: event.providerCost },
    { label: 'Estimated', cost: event.estimatedCost },
    { label: 'Effective', cost: event.effectiveCost },
  ]);

  function detailValue(value: string): string {
    return value === 'unknown' ? 'Unknown' : value;
  }

  function formatDetailedTimestamp(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) return 'Unknown';
    return new Date(value).toLocaleString('en-US', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'long',
    });
  }

  function formatCost(value: number | undefined): string {
    return value === undefined || !Number.isFinite(value) ? 'Unknown' : formatUsd(value);
  }

  async function copyValue(label: string, value: string): Promise<void> {
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('Clipboard access is unavailable in this browser context.');
      }
      await navigator.clipboard.writeText(value);
      pushToast(`${label} copied`, 'success');
    } catch (error) {
      pushToast(
        error instanceof Error ? error.message : `Could not copy ${label.toLocaleLowerCase()}.`,
        'error',
      );
    }
  }
</script>

<div class="space-y-5 bg-bark-50/70 px-5 py-5" role="region" aria-label={`Details for usage event ${event.id}`}>
  {#each detailSections as section (section.key)}
    <section aria-labelledby={`${detailId}-${section.key}`}>
      <h4 id={`${detailId}-${section.key}`} class="text-xs font-semibold uppercase tracking-[0.14em] text-shadow-500">{section.heading}</h4>
      <dl class="mt-2 grid gap-x-5 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {#each section.entries as detail (detail.label)}
          <div class="min-w-0">
            <dt class="text-xs text-shadow-500">{detail.label}</dt>
            <dd class="mt-0.5 break-words text-sm text-shadow-800">
              {#if detail.copy && detail.value !== 'unknown'}
                <button
                  type="button"
                  class="inline-flex max-w-full items-center gap-1 rounded font-mono text-xs text-shadow-800 underline decoration-bark-300 underline-offset-2 hover:text-gold-700 focus:outline-none focus:ring-2 focus:ring-gold-400"
                  title={`Copy ${detail.label}: ${detail.value}`}
                  aria-label={`Copy ${detail.label} ${detail.value}`}
                  onclick={() => void copyValue(detail.label, detail.value)}
                >
                  <span class="truncate">{shortId(detail.value)}</span><span aria-hidden="true">⧉</span>
                </button>
              {:else}
                {detailValue(detail.value)}
              {/if}
            </dd>
          </div>
        {/each}
      </dl>
    </section>
  {/each}

  <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
    <section aria-labelledby={`${detailId}-outcome`}>
      <h4 id={`${detailId}-outcome`} class="text-xs font-semibold uppercase tracking-[0.14em] text-shadow-500">Timing and outcome</h4>
      <dl class="mt-2 grid gap-x-5 gap-y-3 sm:grid-cols-2">
        <div><dt class="text-xs text-shadow-500">Recorded</dt><dd class="mt-0.5 text-sm text-shadow-800">{formatDetailedTimestamp(event.recordedAtMs)}</dd></div>
        <div><dt class="text-xs text-shadow-500">Started</dt><dd class="mt-0.5 text-sm text-shadow-800">{formatDetailedTimestamp(event.startedAtMs)}</dd></div>
        <div><dt class="text-xs text-shadow-500">Completed</dt><dd class="mt-0.5 text-sm text-shadow-800">{formatDetailedTimestamp(event.completedAtMs)}</dd></div>
        <div><dt class="text-xs text-shadow-500">Duration</dt><dd class="mt-0.5 text-sm text-shadow-800">{formatDurationMs(event.durationMs)}</dd></div>
        <div><dt class="text-xs text-shadow-500">Time to first token</dt><dd class="mt-0.5 text-sm text-shadow-800">{formatDurationMs(event.ttftMs)}</dd></div>
        <div><dt class="text-xs text-shadow-500">Status</dt><dd class="mt-0.5 text-sm {event.status === 'success' ? 'text-moss-600' : 'text-wilt-600'}">{labelDimension(event.status)}</dd></div>
        <div><dt class="text-xs text-shadow-500">Settlement</dt><dd class="mt-0.5 text-sm text-shadow-800">{labelDimension(event.settlement)}</dd></div>
        <div><dt class="text-xs text-shadow-500">Stop reason</dt><dd class="mt-0.5 break-words text-sm text-shadow-800">{event.stopReason ?? 'Unknown'}</dd></div>
      </dl>
    </section>

    <section aria-labelledby={`${detailId}-cost`}>
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h4 id={`${detailId}-cost`} class="text-xs font-semibold uppercase tracking-[0.14em] text-shadow-500">Cost accounting</h4>
        <p class="text-xs text-shadow-600">Source: <strong class="text-shadow-800">{labelDimension(event.costSource)}</strong></p>
      </div>
      <div class="mt-2 overflow-x-auto rounded-lg border border-bark-200 bg-white/60">
        <table class="min-w-full text-left text-xs">
          <thead class="border-b border-bark-200 text-shadow-500">
            <tr>
              <th class="px-3 py-2 font-semibold">Amount</th>
              <th class="px-3 py-2 text-right font-semibold">Input</th>
              <th class="px-3 py-2 text-right font-semibold">Cache read</th>
              <th class="px-3 py-2 text-right font-semibold">Cache write</th>
              <th class="px-3 py-2 text-right font-semibold">Output</th>
              <th class="px-3 py-2 text-right font-semibold">Total</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-bark-200">
            {#each costRows as row (row.label)}
              <tr class={row.label === 'Effective' ? 'font-semibold text-shadow-900' : 'text-shadow-700'}>
                <th class="px-3 py-2 font-medium">{row.label}</th>
                <td class="px-3 py-2 text-right">{formatCost(row.cost.input)}</td>
                <td class="px-3 py-2 text-right">{formatCost(row.cost.cacheRead)}</td>
                <td class="px-3 py-2 text-right">{formatCost(row.cost.cacheWrite)}</td>
                <td class="px-3 py-2 text-right">{formatCost(row.cost.output)}</td>
                <td class="px-3 py-2 text-right">{formatCost(row.cost.total)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  </div>

  {#if event.errorCode || event.errorMessage}
    <section class="rounded-lg border border-wilt-300 bg-wilt-50 px-4 py-3" aria-labelledby={`${detailId}-error`}>
      <h4 id={`${detailId}-error`} class="text-xs font-semibold uppercase tracking-[0.14em] text-wilt-700">Error detail</h4>
      <dl class="mt-2 grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        <div><dt class="text-xs text-wilt-600">Code</dt><dd class="mt-0.5 break-words font-mono text-sm text-wilt-800">{event.errorCode ?? 'Unknown'}</dd></div>
        <div><dt class="text-xs text-wilt-600">Message</dt><dd class="mt-0.5 whitespace-pre-wrap break-words text-sm text-wilt-800">{event.errorMessage ?? 'Unknown'}</dd></div>
      </dl>
    </section>
  {/if}
</div>
