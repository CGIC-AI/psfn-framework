<script lang="ts">
  import {
    formatPromptMonitorStageLabel,
    type PromptMonitorTurn,
  } from '$lib/events/prompt-monitor';
  import CollapsibleSection from '$lib/components/garden/CollapsibleSection.svelte';
  import PromptMonitorTextBlock from './PromptMonitorTextBlock.svelte';
  import {
    RETRIEVAL_BUFFER_LIMIT,
    STAGE_BUFFER_LIMIT,
    formatDuration,
    formatJson,
    formatTimestamp,
    metricTone,
  } from './PromptMonitorSelectedTurnTabs.helpers';
  import {
    buildPromptMonitorTimingSummary,
    describePromptMonitorTimingData,
    resolvePromptMonitorRetrievals,
  } from './PromptMonitorTimingPanel.helpers';

  interface Props {
    turn: PromptMonitorTurn;
  }

  let { turn }: Props = $props();

  const timing = $derived(buildPromptMonitorTimingSummary(turn));
  const retrievals = $derived(resolvePromptMonitorRetrievals(turn));
</script>

<div class="space-y-4">
  <div class="rounded-xl border border-bark-200 bg-bark-50 p-4">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h3 class="font-medium text-shadow-900">Subsystem Timing</h3>
        <p class="mt-1 text-xs text-shadow-600">
          Rows use each subsystem's recorded duration. Older turns fall back to the difference between adjacent cumulative elapsed markers.
        </p>
      </div>
      <span class="text-xs text-shadow-600">
        live buffer keeps last {STAGE_BUFFER_LIMIT} stage · {RETRIEVAL_BUFFER_LIMIT} retrieval events per turn
      </span>
    </div>

    {#if turn.stages.length >= STAGE_BUFFER_LIMIT}
      <p class="mt-2 text-xs text-wilt-700">
        Showing the last {STAGE_BUFFER_LIMIT} buffered stage events; earlier live events for this turn may have been trimmed.
      </p>
    {/if}

    <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div class="rounded-lg border border-bark-200 bg-bark-50 p-3">
        <p class="text-sm text-shadow-600">Time to First Token</p>
        <p class="mt-1 font-serif text-2xl {metricTone(timing.ttftMs, 500)}">
          {formatDuration(timing.ttftMs)}
        </p>
      </div>
      <div class="rounded-lg border border-bark-200 bg-bark-50 p-3">
        <p class="text-sm text-shadow-600">Measured Subsystems</p>
        <p class="mt-1 font-serif text-2xl text-shadow-900">
          {formatDuration(timing.subsystemTotalMs)}
        </p>
      </div>
      <div class="rounded-lg border border-bark-200 bg-bark-50 p-3">
        <p class="text-sm text-shadow-600">Total Elapsed</p>
        <p class="mt-1 font-serif text-2xl text-shadow-900">
          {formatDuration(timing.totalElapsedMs)}
        </p>
      </div>
    </div>

    {#if timing.totalElapsedMs != null}
      <p class="mt-3 rounded-lg border border-bark-200 bg-bark-100 px-3 py-2 text-xs text-shadow-700">
        {#if (timing.overlapMs ?? 0) > 0}
          Measured subsystem timers include {formatDuration(timing.overlapMs)} of overlap; wall-clock total is {formatDuration(timing.totalElapsedMs)}.
        {:else}
          {formatDuration(timing.subsystemTotalMs)} measured + {formatDuration(timing.unattributedMs)} between stages = {formatDuration(timing.totalElapsedMs)} total.
        {/if}
      </p>
    {/if}
  </div>

  <div class="rounded-xl border border-bark-200 bg-bark-50 p-4">
    <h3 class="font-medium text-shadow-900">Subsystems</h3>
    {#if timing.subsystems.length === 0}
      <p class="mt-3 text-sm text-shadow-600">No subsystem timing telemetry captured.</p>
    {:else}
      <div class="mt-3 space-y-3">
        {#each timing.subsystems as subsystem (`${subsystem.stage}-${subsystem.observedAt}`)}
          {@const details = describePromptMonitorTimingData(subsystem.data)}
          <div class="rounded-lg border border-bark-200 bg-bark-50 px-3 py-3">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div class="flex flex-wrap items-center gap-2">
                  <p class="text-sm font-medium text-shadow-900">
                    {formatPromptMonitorStageLabel(subsystem.stage)}
                  </p>
                  <span class="rounded-full border border-bark-300 bg-bark-100 px-2 py-0.5 text-xs text-shadow-600">
                    {subsystem.durationSource === 'recorded' ? 'recorded duration' : 'elapsed delta fallback'}
                  </span>
                </div>
                <p class="mt-1 text-xs text-shadow-600">
                  completed {formatTimestamp(subsystem.observedAt)} · cumulative marker {formatDuration(subsystem.elapsedMs)}
                </p>
              </div>
              <p class="font-serif text-xl {metricTone(subsystem.durationMs, subsystem.stage === 'prompt' ? 1_500 : 3_000)}">
                {formatDuration(subsystem.durationMs)}
              </p>
            </div>

            {#if details.length > 0}
              <div class="mt-2 flex flex-wrap gap-2">
                {#each details as detail (detail)}
                  <span class="rounded-full border border-bark-300 bg-bark-50 px-2 py-0.5 text-xs text-shadow-700">{detail}</span>
                {/each}
              </div>
            {/if}

            {#if subsystem.stage === 'memory'}
              <div class="mt-3 border-t border-bark-200 pt-3">
                <div class="flex items-center justify-between gap-2">
                  <h4 class="text-sm font-medium text-shadow-900">Memory Retrievals</h4>
                  <span class="text-xs text-shadow-600">{retrievals.length} event{retrievals.length === 1 ? '' : 's'}</span>
                </div>
                {#if retrievals.length === 0}
                  <p class="mt-2 text-sm text-shadow-600">No memory retrieval telemetry recorded.</p>
                {:else}
                  <div class="mt-2 space-y-2">
                    {#each retrievals as retrieval, index (`${retrieval.observedAt}-${index}`)}
                      <div class="flex flex-wrap items-center gap-2 rounded-lg border border-bark-200 bg-bark-100 px-3 py-2 text-xs text-shadow-700">
                        <span class="font-medium text-shadow-900">{retrieval.retrievalSource?.replace('_', ' ') ?? 'unspecified source'}</span>
                        <span>{retrieval.count} result{retrieval.count === 1 ? '' : 's'}</span>
                        {#if retrieval.reason}<span>· {retrieval.reason}</span>{/if}
                        <span class="ml-auto text-shadow-500">{formatTimestamp(retrieval.observedAt)}</span>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <CollapsibleSection
    title="Raw timing telemetry"
    subtitle="Cumulative stage markers and retrieval payloads for diagnostics"
  >
    <PromptMonitorTextBlock
      title="Stages & Retrievals"
      value={formatJson({ stages: turn.stages, retrievals })}
      emptyText="No timing telemetry recorded."
      maxHeightClass="max-h-[32rem]"
    />
  </CollapsibleSection>
</div>
