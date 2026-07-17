<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    open,
    onToggle,
    summary,
    bodyClass = 'px-5 pb-5 border-t border-bark-300 pt-4',
    children,
  } = $props<{
    title: string;
    open: boolean;
    onToggle: () => void;
    summary?: Snippet;
    bodyClass?: string;
    children: Snippet;
  }>();

  const uid = $props.id();
  const bodyId = `${uid}-body`;
</script>

<div class="card-garden overflow-hidden">
  <button
    type="button"
    aria-expanded={open}
    aria-controls={bodyId}
    onclick={onToggle}
    class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
  >
    <div class="flex items-center gap-3">
      <h2 class="text-sm font-serif font-semibold text-shadow-800">{title}</h2>
    </div>
    <div class="flex items-center gap-3">
      {#if !open && summary}
        {@render summary()}
      {/if}
      <span class="text-shadow-500 text-sm transition-transform duration-200 {open ? 'rotate-180' : ''}">&#9660;</span>
    </div>
  </button>
  {#if open}
    <div id={bodyId} class={bodyClass}>
      {@render children()}
    </div>
  {/if}
</div>
