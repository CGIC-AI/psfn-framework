<script lang="ts">
  import type { AdminObservedMemory, AdminObservedScoredMemory } from '$lib/types';

  type DisplayMemory = AdminObservedMemory | AdminObservedScoredMemory;

  interface Props {
    title: string;
    memories?: DisplayMemory[];
    emptyText?: string;
  }

  let {
    title,
    memories = [],
    emptyText = 'No memories recorded.',
  }: Props = $props();

  function hasSimilarity(memory: DisplayMemory): memory is AdminObservedScoredMemory {
    return typeof (memory as AdminObservedScoredMemory).similarity === 'number';
  }

  function formatMeta(memory: DisplayMemory): string {
    const parts = [memory.type, memory.sensitivity];
    if (hasSimilarity(memory)) {
      parts.push(`sim ${memory.similarity.toFixed(3)}`);
    }
    return parts.join(' · ');
  }
</script>

<div class="rounded-xl border border-bark-200 bg-white p-4">
  <h3 class="font-medium text-shadow-900">{title}</h3>
  {#if memories.length === 0}
    <p class="mt-3 text-sm text-shadow-600">{emptyText}</p>
  {:else}
    <div class="mt-3 space-y-3">
      {#each memories as memory (memory.id)}
        <div class="rounded-lg border border-bark-200 bg-bark-50 p-3">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-sm font-medium text-shadow-900">{memory.id}</p>
              <p class="mt-0.5 text-xs text-shadow-600">{formatMeta(memory)}</p>
            </div>
            <p class="text-xs text-shadow-600">salience {memory.salience.toFixed(2)}</p>
          </div>
          <pre class="mt-2 overflow-auto whitespace-pre-wrap font-mono text-sm text-shadow-800">{memory.text}</pre>
        </div>
      {/each}
    </div>
  {/if}
</div>
