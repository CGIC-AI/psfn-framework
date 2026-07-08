<script lang="ts">
  import type { GardenEventEnvelope } from '$lib/events/envelope';
  import type { PromptMonitorTurn } from '$lib/events/prompt-monitor';
  import PromptMonitorTextBlock from './PromptMonitorTextBlock.svelte';
  import {
    formatJson,
    formatTimestamp,
    truncateValue,
  } from './PromptMonitorSelectedTurnTabs.helpers';

  interface Props {
    turn: PromptMonitorTurn;
    selectedChannelEvents: GardenEventEnvelope[];
  }

  let {
    turn,
    selectedChannelEvents,
  }: Props = $props();
</script>

<div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
  <div class="rounded-xl border border-bark-200 bg-white p-4">
    <h3 class="font-medium text-shadow-900">Raw Turn Objects</h3>
    <div class="mt-3 space-y-3 text-sm">
      <PromptMonitorTextBlock
        title="Session Record"
        value={formatJson(turn.record)}
        emptyText="No session record captured for this turn."
        maxHeightClass="max-h-[28rem]"
      />
      <PromptMonitorTextBlock
        title="Turn Snapshot"
        value={formatJson(turn.snapshot)}
        emptyText="No turn snapshot captured for this turn."
        maxHeightClass="max-h-[28rem]"
      />
      <PromptMonitorTextBlock
        title="Stage Telemetry"
        value={formatJson(turn.stages)}
        emptyText="No stage telemetry captured for this turn."
        maxHeightClass="max-h-[28rem]"
      />
    </div>
  </div>

  <div class="rounded-xl border border-bark-200 bg-white p-4">
    <div class="flex items-center justify-between gap-3">
      <h3 class="font-medium text-shadow-900">Live Channel Bus</h3>
      <span class="text-sm text-shadow-600">{selectedChannelEvents.length} visible event{selectedChannelEvents.length === 1 ? '' : 's'}</span>
    </div>
    {#if selectedChannelEvents.length === 0}
      <p class="mt-3 text-sm text-shadow-600">No live bus events for this channel are buffered right now.</p>
    {:else}
      <div class="mt-3 space-y-3 max-h-[44rem] overflow-y-auto">
        {#each selectedChannelEvents as event, index (`${event.type}-${event.timestamp}-${index}`)}
          <div class="rounded-lg border border-bark-200 p-3 text-sm">
            <div class="flex items-center justify-between gap-3">
              <span class="font-medium text-shadow-900">{event.type}</span>
              <span class="text-shadow-600">{formatTimestamp(event.timestamp)}</span>
            </div>
            <p class="mt-1 text-shadow-600">
              turn {truncateValue(event.correlation.turnId, 18)} . purpose {truncateValue(event.correlation.purpose, 24)}
            </p>
            <PromptMonitorTextBlock
              title="Event Payload"
              value={formatJson(event.data)}
              emptyText="No payload"
              maxHeightClass="max-h-48"
            />
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
