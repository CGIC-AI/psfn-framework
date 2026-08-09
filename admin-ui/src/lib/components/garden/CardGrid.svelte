<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    class: className = '',
    children,
  } = $props<{
    class?: string;
    children: Snippet;
  }>();
</script>

<div class={`grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3 ${className}`.trim()}>
  {@render children()}
</div>
