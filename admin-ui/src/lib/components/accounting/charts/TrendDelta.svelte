<script lang="ts">
  interface Props {
    current: number;
    previous: number | null;
    invertPolarity?: boolean;
    formatter?: (deltaRatio: number) => string;
  }

  function defaultFormatter(deltaRatio: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'percent',
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
      signDisplay: 'exceptZero',
    }).format(deltaRatio);
  }

  let {
    current,
    previous,
    invertPolarity = false,
    formatter = defaultFormatter,
  }: Props = $props();

  const deltaRatio = $derived(
    previous === null
      || previous === 0
      || !Number.isFinite(previous)
      || !Number.isFinite(current)
      ? null
      : (current - previous) / Math.abs(previous),
  );
  const favorable = $derived(deltaRatio === null || deltaRatio === 0
    ? null
    : invertPolarity ? deltaRatio < 0 : deltaRatio > 0);
  const formattedDelta = $derived(deltaRatio === null ? '—' : formatter(deltaRatio));
  const toneClass = $derived(favorable === null
    ? 'border-bark-300 bg-bark-100 text-shadow-600'
    : favorable
      ? 'border-moss-200 bg-moss-50 text-moss-700'
      : 'border-petal-200 bg-petal-50 text-petal-700');
  const accessibleLabel = $derived(deltaRatio === null
    ? 'No previous period comparison'
    : `${formattedDelta} versus previous period; ${favorable === null ? 'unchanged' : favorable ? 'favorable' : 'unfavorable'}`);
</script>

<span
  class={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold tabular-nums ${toneClass}`}
  aria-label={accessibleLabel}
>
  <span aria-hidden="true">{formattedDelta} vs prev period</span>
</span>
