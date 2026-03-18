<script lang="ts">
  import type { AdminTurnPromptContextMessage } from '$lib/types';

  interface Props {
    title: string;
    messages?: AdminTurnPromptContextMessage[];
    emptyText?: string;
  }

  let {
    title,
    messages = [],
    emptyText = 'No context messages recorded.',
  }: Props = $props();
</script>

<div class="rounded-xl border border-bark-200 bg-white p-4">
  <h3 class="font-medium text-shadow-900">{title}</h3>
  {#if messages.length === 0}
    <p class="mt-3 text-sm text-shadow-600">{emptyText}</p>
  {:else}
    <div class="mt-3 space-y-3">
      {#each messages as message, index (`${message.role}-${index}`)}
        <div class="rounded-lg border border-bark-200 bg-bark-50 p-3">
          <p class="text-xs font-medium uppercase tracking-wide text-shadow-600">{message.role}</p>
          <pre class="mt-2 overflow-auto whitespace-pre-wrap font-mono text-sm text-shadow-800">{message.content}</pre>
        </div>
      {/each}
    </div>
  {/if}
</div>
