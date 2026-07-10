<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    maxHeight = '18rem',
    label,
    class: className = '',
    children,
  } = $props<{
    maxHeight?: string;
    label?: string;
    class?: string;
    children: Snippet;
  }>();

  let viewport = $state<HTMLDivElement | null>(null);
  let content = $state<HTMLDivElement | null>(null);
  let moreBelow = $state(false);

  function updateAffordance(): void {
    if (!viewport) return;
    moreBelow = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 1;
  }

  $effect(() => {
    if (!viewport || !content) return;
    updateAffordance();
    const observer = new ResizeObserver(updateAffordance);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  });
</script>

<div class={`relative ${className}`.trim()}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -- tabindex is only set alongside role="region", which makes the scroll area keyboard-focusable -->
  <div
    bind:this={viewport}
    onscroll={updateAffordance}
    role={label ? 'region' : undefined}
    aria-label={label}
    tabindex={label ? 0 : undefined}
    style={`max-height: ${maxHeight};`}
    class="overflow-y-auto overscroll-contain"
  >
    <div bind:this={content}>
      {@render children()}
    </div>
  </div>

  {#if moreBelow}
    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-x-0 bottom-0 h-8"
      style="background: linear-gradient(to bottom, transparent, var(--color-bark-50));"
    ></div>
  {/if}
</div>
