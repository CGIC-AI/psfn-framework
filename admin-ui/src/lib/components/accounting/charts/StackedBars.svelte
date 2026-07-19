<script lang="ts">
  import {
    buildLinearTicks,
    niceMax,
    stackSegments,
    type ChartBucket,
  } from './chart-scale';

  interface ChartSeries {
    key: string;
    label: string;
    colorClass: string;
  }

  interface Props {
    buckets: ChartBucket[];
    series: ChartSeries[];
    timezone: string;
    valueFormatter: (value: number) => string;
    onSelectBucket?: (bucket: ChartBucket) => void;
  }

  const frame = {
    width: 720,
    height: 320,
    top: 16,
    right: 16,
    bottom: 48,
    left: 68,
  } as const;
  const plotWidth = frame.width - frame.left - frame.right;
  const plotHeight = frame.height - frame.top - frame.bottom;
  const dayMs = 24 * 60 * 60 * 1_000;

  let {
    buckets,
    series,
    timezone,
    valueFormatter,
    onSelectBucket,
  }: Props = $props();
  let hiddenKeys = $state<string[]>([]);

  const visibleSeries = $derived(series.filter(item => !hiddenKeys.includes(item.key)));
  const seriesByKey = $derived(new Map(series.map(item => [item.key, item])));
  const stackedBuckets = $derived(stackSegments(buckets, visibleSeries.map(item => item.key)));
  const maximum = $derived(Math.max(0, ...stackedBuckets.map(bucket => bucket.total)));
  const axisMaximum = $derived(niceMax(maximum));
  const ticks = $derived(buildLinearTicks(axisMaximum, 5));
  const slotWidth = $derived(plotWidth / Math.max(1, buckets.length));
  const barWidth = $derived(Math.max(1, slotWidth * 0.68));
  const bucketStepMs = $derived.by(() => {
    let smallestStep = Number.POSITIVE_INFINITY;
    for (let index = 1; index < buckets.length; index += 1) {
      const step = (buckets[index]?.startMs ?? 0) - (buckets[index - 1]?.startMs ?? 0);
      if (step > 0 && step < smallestStep) smallestStep = step;
    }
    return Number.isFinite(smallestStep) ? smallestStep : 0;
  });
  const includesTime = $derived(bucketStepMs > 0 && bucketStepMs < dayMs);
  const yearFormatter = $derived(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
  }));
  const spansYears = $derived(buckets.length > 1
    && yearFormatter.format(buckets[0]?.startMs ?? 0)
      !== yearFormatter.format(buckets.at(-1)?.startMs ?? 0));
  const axisDateFormatter = $derived(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    ...(includesTime ? { hour: 'numeric', minute: '2-digit' } : {}),
    ...(spansYears ? { year: '2-digit' } : {}),
  }));
  const accessibleDateFormatter = $derived(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(includesTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  }));
  const estimatedLabelWidth = $derived(includesTime || spansYears ? 96 : 72);
  const labelEvery = $derived(Math.max(
    1,
    Math.ceil(buckets.length / Math.max(1, Math.floor(plotWidth / estimatedLabelWidth))),
  ));

  function toggleSeries(key: string): void {
    hiddenKeys = hiddenKeys.includes(key)
      ? hiddenKeys.filter(hiddenKey => hiddenKey !== key)
      : [...hiddenKeys, key];
  }

  function isCssVariable(colorClass: string): boolean {
    return colorClass.trim().startsWith('var(');
  }

  function paintClass(colorClass: string): string | undefined {
    return isCssVariable(colorClass) ? undefined : colorClass;
  }

  function paintStyle(colorClass: string): string | undefined {
    return isCssVariable(colorClass) ? colorClass : undefined;
  }

  function xForBucket(index: number): number {
    return frame.left + index * slotWidth + (slotWidth - barWidth) / 2;
  }

  function yForValue(value: number): number {
    return axisMaximum === 0
      ? frame.top + plotHeight
      : frame.top + plotHeight - (value / axisMaximum) * plotHeight;
  }

  function shouldShowDateLabel(index: number): boolean {
    const lastIndex = buckets.length - 1;
    if (index === 0 || index === lastIndex) return true;
    return index % labelEvery === 0 && lastIndex - index >= labelEvery;
  }

  function bucketAriaLabel(index: number): string {
    const bucket = stackedBuckets[index];
    if (!bucket) return 'Empty time bucket';
    const details = bucket.segments
      .filter(segment => segment.value > 0)
      .map((segment) => {
        const label = seriesByKey.get(segment.key)?.label ?? segment.key;
        return `${label}: ${valueFormatter(segment.value)}`;
      });
    return [
      accessibleDateFormatter.format(bucket.startMs),
      `total ${valueFormatter(bucket.total)}`,
      ...details,
    ].join('; ');
  }

  function selectBucket(bucket: ChartBucket): void {
    onSelectBucket?.(bucket);
  }

  function handleBucketKeydown(event: KeyboardEvent, bucket: ChartBucket): void {
    if (!onSelectBucket || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    onSelectBucket(bucket);
  }
</script>

<div class="w-full">
  <svg
    viewBox={`0 0 ${frame.width} ${frame.height}`}
    role="group"
    aria-label={`Stacked usage by time bucket in ${timezone}`}
    class="block h-auto w-full overflow-visible"
  >
    {#each ticks as tick (tick)}
      {@const y = yForValue(tick)}
      <line
        x1={frame.left}
        x2={frame.width - frame.right}
        y1={y}
        y2={y}
        class="stroke-bark-300"
        stroke-width="1"
        vector-effect="non-scaling-stroke"
      />
      <text
        x={frame.left - 10}
        y={y + 3}
        text-anchor="end"
        class="fill-shadow-500 text-[10px]"
      >{valueFormatter(tick)}</text>
    {/each}

    {#if buckets.length === 0}
      <text
        x={frame.left + plotWidth / 2}
        y={frame.top + plotHeight / 2}
        text-anchor="middle"
        class="fill-shadow-500 text-xs"
      >No chart data</text>
    {:else}
      {#each stackedBuckets as bucket, index (bucket.startMs)}
        {@const sourceBucket = buckets[index] ?? { startMs: bucket.startMs, segments: [] }}
        {@const x = xForBucket(index)}
        <g
          class:cursor-pointer={Boolean(onSelectBucket)}
          class="chart-bucket outline-none"
          role="button"
          tabindex="0"
          aria-disabled={!onSelectBucket}
          aria-label={bucketAriaLabel(index)}
          onclick={() => selectBucket(sourceBucket)}
          onkeydown={(event) => handleBucketKeydown(event, sourceBucket)}
        >
          <rect
            x={x}
            y={frame.top}
            width={barWidth}
            height={plotHeight}
            fill="transparent"
          />
          {#each bucket.segments as segment (segment.key)}
            {#if segment.value > 0}
              {@const descriptor = seriesByKey.get(segment.key)}
              {@const segmentTop = yForValue(segment.end)}
              {@const segmentBottom = yForValue(segment.start)}
              <rect
                x={x}
                y={segmentTop}
                width={barWidth}
                height={Math.max(0, segmentBottom - segmentTop)}
                class={paintClass(descriptor?.colorClass ?? '')}
                style:fill={paintStyle(descriptor?.colorClass ?? '')}
              >
                <title>{accessibleDateFormatter.format(bucket.startMs)} · {descriptor?.label ?? segment.key}: {valueFormatter(segment.value)}</title>
              </rect>
            {/if}
          {/each}
          <rect
            x={x - 2}
            y={frame.top}
            width={barWidth + 4}
            height={plotHeight}
            rx="2"
            class="bucket-focus"
            vector-effect="non-scaling-stroke"
          />
        </g>

        {#if shouldShowDateLabel(index)}
          <text
            x={x + barWidth / 2}
            y={frame.top + plotHeight + 20}
            text-anchor="middle"
            class="fill-shadow-500 text-[10px]"
            aria-hidden="true"
          >{axisDateFormatter.format(bucket.startMs)}</text>
        {/if}
      {/each}
    {/if}
  </svg>

  {#if series.length > 0}
    <div class="mt-3 flex flex-wrap gap-2" role="list" aria-label="Chart series">
      {#each series as item (item.key)}
        {@const visible = !hiddenKeys.includes(item.key)}
        <span role="listitem">
          <button
            type="button"
            aria-pressed={visible}
            onclick={() => toggleSeries(item.key)}
            class="inline-flex items-center gap-1.5 rounded-full border border-bark-300 bg-bark-50 px-2.5 py-1 text-xs font-medium text-shadow-700 transition-opacity hover:border-gold-400 focus:outline-none focus:ring-2 focus:ring-gold-400 {visible ? '' : 'opacity-45'}"
          >
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
              <rect
                width="10"
                height="10"
                rx="2"
                class={paintClass(item.colorClass)}
                style:fill={paintStyle(item.colorClass)}
              />
            </svg>
            {item.label}
          </button>
        </span>
      {/each}
    </div>
  {/if}
</div>

<style>
  .bucket-focus {
    fill: none;
    pointer-events: none;
    stroke: transparent;
  }

  .chart-bucket:focus .bucket-focus {
    stroke: var(--color-gold-500);
    stroke-width: 2;
  }
</style>
