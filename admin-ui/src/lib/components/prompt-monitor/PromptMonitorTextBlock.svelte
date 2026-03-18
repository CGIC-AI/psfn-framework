<script lang="ts">
  interface Props {
    title: string;
    value?: string | null;
    emptyText?: string;
    maxHeightClass?: string;
  }

  let {
    title,
    value = null,
    emptyText = 'No snapshot recorded.',
    maxHeightClass = 'max-h-44',
  }: Props = $props();

  const resolvedValue = $derived.by(() => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  });
</script>

<div>
  <p class="text-shadow-600">{title}</p>
  <pre class={`mt-1 overflow-auto rounded-lg bg-bark-100 p-3 font-mono text-sm text-shadow-800 whitespace-pre-wrap ${maxHeightClass}`}>
{resolvedValue ?? emptyText}</pre>
</div>
