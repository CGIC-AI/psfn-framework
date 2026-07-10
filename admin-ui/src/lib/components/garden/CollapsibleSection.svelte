<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    collapsed = $bindable(true),
    count,
    subtitle,
    class: className = '',
    children,
  } = $props<{
    title: string;
    collapsed?: boolean;
    count?: number;
    subtitle?: string;
    class?: string;
    children: Snippet;
  }>();

  const uid = $props.id();
  const bodyId = `${uid}-body`;
</script>

<section class={`card-garden ${className}`.trim()}>
  <button
    type="button"
    aria-expanded={!collapsed}
    aria-controls={bodyId}
    onclick={() => (collapsed = !collapsed)}
    class="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-bark-50
      {collapsed ? 'rounded-xl' : 'rounded-t-xl'}"
  >
    <span class="min-w-0">
      <span class="flex flex-wrap items-center gap-2">
        <span class="font-serif text-base font-semibold text-shadow-900">{title}</span>
        {#if count != null}
          <span class="rounded-full border border-bark-300 bg-bark-100 px-2 py-0.5 text-xs font-medium text-shadow-600">
            {count}
          </span>
        {/if}
      </span>
      {#if subtitle}
        <span class="mt-0.5 block text-xs text-shadow-500">{subtitle}</span>
      {/if}
    </span>
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      class="h-4 w-4 shrink-0 text-shadow-500 transition-transform {collapsed ? '' : 'rotate-180'}"
    >
      <path
        d="M6 9l6 6 6-6"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </button>

  {#if !collapsed}
    <div id={bodyId} class="border-t border-bark-200 px-4 py-4">
      {@render children()}
    </div>
  {/if}
</section>
