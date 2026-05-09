<script lang="ts">
  import { formatTimestamp } from './tool-display';

  interface Props {
    title: string;
    message: string;
    timestamp?: number;
    meta?: string | null;
    tone?: 'wilt' | 'gold';
  }

  let {
    title,
    message,
    timestamp,
    meta = null,
    tone = 'wilt',
  }: Props = $props();

  const toneClasses = $derived(tone === 'gold'
    ? {
      container: 'border-gold-200 bg-gold-50',
      title: 'text-gold-700',
      text: 'text-gold-700',
      meta: 'text-gold-600',
    }
    : {
      container: 'border-wilt-200 bg-wilt-50',
      title: 'text-wilt-700',
      text: 'text-wilt-700',
      meta: 'text-wilt-600',
    });
</script>

<div class="rounded-2xl border px-4 py-3 {toneClasses.container}">
  <div class="flex items-center justify-between gap-3">
    <code class="text-sm font-medium {toneClasses.title}">{title}</code>
    <span class="text-xs {toneClasses.text}">{formatTimestamp(timestamp)}</span>
  </div>
  <p class="mt-2 text-sm {toneClasses.text}">{message}</p>
  {#if meta}
    <p class="mt-2 text-xs uppercase tracking-[0.16em] {toneClasses.meta}">{meta}</p>
  {/if}
</div>
