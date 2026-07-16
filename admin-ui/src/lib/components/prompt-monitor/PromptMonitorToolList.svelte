<script lang="ts">
  import type { AdminTurnToolSchema } from '$lib/types';
  import PromptMonitorTextBlock from './PromptMonitorTextBlock.svelte';

  interface Props {
    title: string;
    tools?: AdminTurnToolSchema[];
    emptyText?: string;
  }

  let {
    title,
    tools = [],
    emptyText = 'No active tools recorded.',
  }: Props = $props();
</script>

<div class="rounded-xl border border-bark-200 bg-bark-50 p-4">
  <h3 class="font-medium text-shadow-900">{title}</h3>
  {#if tools.length === 0}
    <p class="mt-3 text-sm text-shadow-600">{emptyText}</p>
  {:else}
    <div class="mt-3 space-y-3">
      {#each tools as tool (tool.name)}
        <div class="rounded-lg border border-bark-200 bg-bark-50 p-3">
          <p class="text-sm font-medium text-shadow-900">{tool.name}</p>
          <p class="mt-1 text-sm text-shadow-700">{tool.description}</p>
          <div class="mt-2">
            <PromptMonitorTextBlock
              title="Input Schema"
              value={JSON.stringify(tool.inputSchema, null, 2)}
              maxHeightClass="max-h-64"
            />
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
