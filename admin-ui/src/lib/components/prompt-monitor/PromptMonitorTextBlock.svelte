<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { AdminPromptSectionCacheability } from '$lib/types';
  import { writePromptMonitorClipboard } from './PromptMonitorTextBlock.helpers';

  interface Props {
    title: string;
    value?: string | null;
    emptyText?: string;
    maxHeightClass?: string;
    cacheability?: AdminPromptSectionCacheability | null;
  }

  let {
    title,
    value = null,
    emptyText = 'No snapshot recorded.',
    maxHeightClass = 'max-h-44',
    cacheability = null,
  }: Props = $props();

  const resolvedValue = $derived.by(() => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  });

  let copyState = $state<'idle' | 'copied' | 'error'>('idle');
  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleCopyStateReset(): void {
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      copyState = 'idle';
      resetTimer = null;
    }, 2_000);
  }

  async function copyValue(): Promise<void> {
    if (!resolvedValue) return;
    try {
      await writePromptMonitorClipboard(resolvedValue);
      copyState = 'copied';
    } catch (error) {
      console.error(`Failed to copy prompt-monitor text block "${title}"`, error);
      copyState = 'error';
    }
    scheduleCopyStateReset();
  }

  onDestroy(() => {
    if (resetTimer) clearTimeout(resetTimer);
  });

  function cacheabilityTone(value: AdminPromptSectionCacheability['cacheability'] | undefined): string {
    switch (value) {
      case 'static':
        return 'border-moss-300 bg-moss-50 text-moss-800';
      case 'session_stable':
        return 'border-gold-300 bg-gold-50 text-shadow-900';
      case 'append_only':
        return 'border-sky-300 bg-sky-50 text-sky-800';
      case 'volatile':
        return 'border-wilt-300 bg-wilt-50 text-wilt-800';
      default:
        return 'border-bark-300 bg-bark-100 text-shadow-700';
    }
  }
</script>

<div>
  <div class="flex flex-wrap items-center gap-2">
    <p class="text-shadow-600">{title}</p>
    {#if cacheability}
      <span class={`rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${cacheabilityTone(cacheability.cacheability)}`}>
        {cacheability.cacheability.replace('_', ' ')}
      </span>
      {#each cacheability.cacheBreakers as breaker (breaker)}
        <span class="rounded-full border border-bark-300 bg-bark-50 px-2 py-0.5 text-xs text-shadow-700">
          {breaker.replace('_', ' ')}
        </span>
      {/each}
    {/if}
    <button
      type="button"
      class="ml-auto rounded-md border border-bark-300 bg-bark-50 px-2 py-1 text-xs font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={!resolvedValue}
      aria-label={`Copy ${title}`}
      aria-live="polite"
      title={resolvedValue ? `Copy ${title}` : `Nothing to copy from ${title}`}
      onclick={copyValue}
    >
      {copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy'}
    </button>
  </div>
  {#if cacheability}
    <p class="mt-1 text-xs text-shadow-600">{cacheability.reason}</p>
  {/if}
  <pre class={`mt-1 overflow-auto rounded-lg bg-bark-100 p-3 font-mono text-sm text-shadow-800 whitespace-pre-wrap ${maxHeightClass}`}>
{resolvedValue ?? emptyText}</pre>
</div>
