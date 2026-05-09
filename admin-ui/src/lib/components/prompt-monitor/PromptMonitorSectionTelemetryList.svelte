<script lang="ts">
  import type { AdminPromptSectionTelemetry } from '$lib/types';
  import PromptMonitorTextBlock from './PromptMonitorTextBlock.svelte';

  interface Props {
    title: string;
    sections?: AdminPromptSectionTelemetry[];
    emptyText?: string;
  }

  let {
    title,
    sections = [],
    emptyText = 'No prompt section telemetry recorded.',
  }: Props = $props();

  function formatCount(value: number): string {
    return value.toLocaleString();
  }
</script>

<div class="rounded-xl border border-bark-200 bg-white p-4">
  <h3 class="font-medium text-shadow-900">{title}</h3>
  {#if sections.length === 0}
    <p class="mt-3 text-sm text-shadow-600">{emptyText}</p>
  {:else}
    <div class="mt-3 space-y-3">
      {#each sections as section (`${section.id}-${section.title}`)}
        <div class="rounded-lg border border-bark-200 bg-bark-50 p-3">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="truncate text-sm font-medium text-shadow-900">{section.title}</p>
              <p class="mt-0.5 truncate font-mono text-xs text-shadow-600">{section.id}</p>
            </div>
            <p class="text-xs text-shadow-600">
              {formatCount(section.charCount)} chars . {formatCount(section.tokenCount)} tokens
            </p>
          </div>
          <div class="mt-3 text-sm">
            <PromptMonitorTextBlock
              title="Section Content"
              value={section.content}
              emptyText="No section content recorded."
              maxHeightClass="max-h-56"
            />
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
