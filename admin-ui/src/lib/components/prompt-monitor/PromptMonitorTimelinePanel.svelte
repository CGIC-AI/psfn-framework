<script lang="ts">
  import {
    formatPromptMonitorStageLabel,
    PROMPT_MONITOR_STAGE_ORDER,
    type PromptMonitorTurn,
  } from '$lib/events/prompt-monitor';
  import PromptMonitorTextBlock from './PromptMonitorTextBlock.svelte';
  import {
    RETRIEVAL_BUFFER_LIMIT,
    STAGE_BUFFER_LIMIT,
    formatDuration,
    formatJson,
    formatTimestamp,
    metricTone,
    stageFieldCount,
    toTimestamp,
  } from './PromptMonitorSelectedTurnTabs.helpers';

  interface Props {
    turn: PromptMonitorTurn;
  }

  let { turn }: Props = $props();
</script>

<div class="rounded-xl border border-bark-200 bg-white p-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="font-medium text-shadow-900">Stage Timeline</h3>
    <span class="text-xs text-shadow-600">
      live buffer keeps last {STAGE_BUFFER_LIMIT} stage · {RETRIEVAL_BUFFER_LIMIT} retrieval events per turn
    </span>
  </div>
  {#if turn.stages.length >= STAGE_BUFFER_LIMIT}
    <p class="mt-1 text-xs text-wilt-700">
      Showing the last {STAGE_BUFFER_LIMIT} buffered stage events; earlier live events for this turn may have been trimmed from the in-memory buffer.
    </p>
  {/if}
  <div class="mt-3 space-y-3">
    {#each PROMPT_MONITOR_STAGE_ORDER as stageName}
      {@const stage = turn.stages.find(candidate => candidate.stage === stageName)}
      <div class="rounded-lg border px-3 py-2
        {stage ? 'border-bark-200 bg-bark-50' : 'border-dashed border-bark-200 bg-white'}">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="text-sm font-medium text-shadow-900">{formatPromptMonitorStageLabel(stageName)}</p>
            <p class="mt-0.5 text-sm text-shadow-600">
              {stage ? formatTimestamp(toTimestamp(stage.observedAt)) : 'No telemetry captured'}
            </p>
          </div>
          <div class="text-right">
            <p class="font-medium {stage ? metricTone(stage.elapsedMs, stageName === 'prompt' ? 1_500 : 3_000) : 'text-shadow-500'}">
              {stage ? formatDuration(stage.elapsedMs) : '—'}
            </p>
            {#if stage}
              <p class="mt-0.5 text-sm text-shadow-600">
                {stageFieldCount(stage)} field{stageFieldCount(stage) === 1 ? '' : 's'}
              </p>
            {/if}
          </div>
        </div>
        {#if stage}
          <div class="mt-3 text-sm">
            <PromptMonitorTextBlock
              title="Stage Payload"
              value={formatJson(stage.data)}
              emptyText="No stage payload recorded."
              maxHeightClass="max-h-48"
            />
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>
