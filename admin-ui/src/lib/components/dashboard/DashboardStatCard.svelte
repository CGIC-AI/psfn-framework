<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    label,
    value,
    hint,
    href,
    actionLabel = 'Open',
    busy = false,
    unavailable = false,
    children,
  } = $props<{
    label: string;
    value: string;
    hint: string;
    href: string;
    actionLabel?: string;
    busy?: boolean;
    unavailable?: boolean;
    children?: Snippet;
  }>();
</script>

<a
  {href}
  class="group flex min-h-40 flex-col rounded-xl border border-bark-300 bg-bark-50 p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-gold-400 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
  aria-busy={busy}
>
  <div class="flex items-start justify-between gap-3">
    <h2 class="text-[11px] font-semibold uppercase tracking-[0.1em] text-shadow-600">{label}</h2>
    <span class="text-xs font-medium text-gold-700 transition-colors group-hover:text-gold-800">
      {actionLabel} <span aria-hidden="true">→</span>
    </span>
  </div>
  <p class="mt-3 font-serif text-3xl font-medium leading-none tabular-nums {unavailable ? 'text-wilt-700' : 'text-shadow-900'}">
    {value}
  </p>
  <p class="mt-2 text-xs leading-snug {unavailable ? 'text-wilt-700' : 'text-shadow-600'}">{hint}</p>
  {#if children}
    <div class="mt-auto pt-3">
      {@render children()}
    </div>
  {/if}
</a>
