<script lang="ts">
  import type { Snippet } from 'svelte';
  import { requestCommandPalette } from '$lib/page-design/command-palette';

  let {
    eyebrow = 'Garden · Operator console',
    title,
    description,
    actions,
    navigation,
    showSearch = true,
    sticky = true,
    class: className = '',
  } = $props<{
    eyebrow?: string;
    title: string;
    description?: string;
    actions?: Snippet;
    navigation?: Snippet;
    showSearch?: boolean;
    sticky?: boolean;
    class?: string;
  }>();

  function openCommandPalette(): void {
    if (typeof window !== 'undefined') requestCommandPalette(window);
  }
</script>

<header class={`garden-page-header ${sticky ? 'garden-page-header--sticky' : ''} ${className}`.trim()}>
  <div class="flex flex-wrap items-start gap-3 px-3 pt-4 sm:px-5 lg:px-7">
    <div class="min-w-0 flex-1">
      <p class="page-kicker">{eyebrow}</p>
      <h1 class="page-title mt-0.5">{title}</h1>
      {#if description}
        <p class="page-description mt-1">{description}</p>
      {/if}
    </div>

    <div class="flex flex-wrap items-center justify-end gap-2">
      {#if showSearch}
        <button
          type="button"
          data-command-palette-trigger
          onclick={openCommandPalette}
          class="garden-action hidden text-shadow-600 hover:border-gold-300 hover:text-shadow-900 lg:inline-flex"
          aria-label="Search Garden destinations"
        >
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
            <circle cx="11" cy="11" r="7"></circle>
            <path d="m20 20-4-4"></path>
          </svg>
          <span class="sr-only xl:not-sr-only">Search</span>
          <kbd class="rounded border border-bark-300 bg-bark-100 px-1.5 py-0.5 font-mono text-[0.62rem]">⌘K</kbd>
        </button>
      {/if}
      {#if actions}
        {@render actions()}
      {/if}
    </div>
  </div>

  {#if navigation}
    <div class="mt-3 overflow-x-auto px-3 sm:px-5 lg:px-7">
      {@render navigation()}
    </div>
  {:else}
    <div class="h-4"></div>
  {/if}
</header>
