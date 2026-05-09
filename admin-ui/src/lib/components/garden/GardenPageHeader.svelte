<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    eyebrow,
    title,
    description,
    actions,
    class: className = '',
  } = $props<{
    eyebrow?: string;
    title: string;
    description?: string;
    actions?: Snippet;
    class?: string;
  }>();
</script>

<header class={`flex items-start justify-between gap-3 flex-wrap ${className}`.trim()}>
  <div>
    {#if eyebrow}
      <p class="text-xs uppercase tracking-[0.2em] text-shadow-500">{eyebrow}</p>
    {/if}
    <h1 class="font-serif text-2xl text-shadow-900 font-semibold">{title}</h1>
    {#if description}
      <p class="text-shadow-600 text-sm mt-1">{description}</p>
    {/if}
  </div>

  {#if actions}
    <div class="flex items-center gap-2 flex-wrap">
      {@render actions()}
    </div>
  {/if}
</header>
