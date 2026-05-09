<script lang="ts">
  import type { Snippet } from 'svelte';

  export interface GardenDebugStreamItem {
    id: string;
    timestamp: string;
    label: string;
    summary?: string;
    detail?: string;
  }

  let {
    items,
    expandedId,
    onToggle,
    scroller = $bindable(),
    onScroll,
    emptyText = 'No entries yet.',
    emptyAction,
    minHeight = '400px',
    class: className = '',
  } = $props<{
    items: GardenDebugStreamItem[];
    expandedId: string | null;
    onToggle: (id: string) => void;
    scroller?: HTMLDivElement;
    onScroll?: () => void;
    emptyText?: string;
    emptyAction?: Snippet;
    minHeight?: string;
    class?: string;
  }>();

  function handleKeydown(event: KeyboardEvent, itemId: string): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onToggle(itemId);
  }
</script>

<div
  class={`bg-shadow-900 text-bark-50 rounded-xl p-4 overflow-y-auto font-mono text-sm ${className}`.trim()}
  style:min-height={minHeight}
  bind:this={scroller}
  onscroll={onScroll}
>
  {#if items.length === 0}
    <div class="h-full flex flex-col items-center justify-center text-shadow-300 gap-3">
      <div class="text-4xl">◌</div>
      <p>{emptyText}</p>
      {#if emptyAction}
        {@render emptyAction()}
      {/if}
    </div>
  {:else}
    <div class="space-y-2">
      {#each items as item (item.id)}
        <div
          role="button"
          tabindex="0"
          aria-expanded={expandedId === item.id}
          class="group cursor-pointer rounded-lg border border-shadow-700 bg-shadow-800/60 p-3 hover:bg-shadow-800 transition-colors"
          onclick={() => onToggle(item.id)}
          onkeydown={(event) => handleKeydown(event, item.id)}
        >
          <div class="flex items-start gap-3">
            <span class="text-moss-400 whitespace-nowrap">{item.timestamp}</span>
            <span class="text-gold-300 font-semibold">{item.label}</span>
            {#if item.summary}
              <span class="text-bark-200 flex-1 break-all">{item.summary}</span>
            {/if}
          </div>
          {#if expandedId === item.id && item.detail}
            <pre class="mt-3 rounded bg-shadow-950/80 p-3 text-xs text-bark-100 overflow-x-auto" aria-label={`${item.label} details`}>{item.detail}</pre>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
