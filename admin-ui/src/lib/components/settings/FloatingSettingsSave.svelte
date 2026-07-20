<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    formatLastSavedAt,
    resolveFloatingSaveControlState,
  } from './floating-save';

  let {
    dirty,
    saveable,
    saving,
    lastSavedAt,
    onSave,
  } = $props<{
    dirty: boolean;
    saveable: boolean;
    saving: boolean;
    lastSavedAt: number | null;
    onSave: () => void | Promise<void>;
  }>();

  let nowMs = $state(Date.now());
  let clockTimer: ReturnType<typeof setInterval> | null = null;
  let control = $derived(resolveFloatingSaveControlState({ dirty, saveable, saving }));
  let lastSavedText = $derived(formatLastSavedAt(lastSavedAt, nowMs));

  function activate(): void {
    if (control.disabled) return;
    void onSave();
  }

  onMount(() => {
    clockTimer = setInterval(() => {
      nowMs = Date.now();
    }, 15_000);
  });

  onDestroy(() => {
    if (clockTimer !== null) clearInterval(clockTimer);
  });
</script>

<div class="sticky top-3 z-30 flex justify-end pointer-events-none" data-settings-floating-save>
  <div
    class="pointer-events-auto inline-flex items-center gap-3 rounded-xl border px-3 py-2 shadow-lg backdrop-blur-sm
      {control.tone === 'clean'
        ? 'border-bark-300 bg-bark-50/95'
        : 'border-gold-500 bg-gold-50/95'}"
  >
    <span
      class="max-w-28 text-right text-xs font-medium leading-tight
        {control.tone === 'clean' ? 'text-shadow-500' : 'text-gold-700'}"
      aria-live="polite"
      aria-atomic="true"
    >
      {lastSavedText}
    </span>
    <button
      type="button"
      aria-disabled={control.disabled}
      aria-label="{control.ariaLabel}. {lastSavedText}."
      onclick={activate}
      class="rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-gold-300 focus:ring-offset-2
        {control.tone === 'clean'
          ? 'cursor-not-allowed bg-bark-300 text-shadow-500'
          : (control.disabled
            ? 'cursor-not-allowed bg-gold-200 text-gold-700'
            : 'bg-gold-600 text-white hover:bg-gold-700')}"
    >
      {control.label}
    </button>
  </div>
</div>
