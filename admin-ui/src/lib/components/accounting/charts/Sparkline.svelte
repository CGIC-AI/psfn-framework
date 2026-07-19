<script lang="ts">
  interface Props {
    values: number[];
    width?: number;
    height?: number;
    strokeClass?: string;
    fillClass?: string;
    padding?: number;
    minPadding?: number;
    maxPadding?: number;
    ariaLabel?: string;
  }

  let {
    values,
    width = 120,
    height = 32,
    strokeClass = 'stroke-current',
    fillClass = 'fill-current',
    padding = 2,
    minPadding = 0,
    maxPadding = 0,
    ariaLabel = 'Trend',
  }: Props = $props();

  const geometry = $derived.by(() => {
    const safeWidth = Number.isFinite(width) && width > 0 ? width : 120;
    const safeHeight = Number.isFinite(height) && height > 0 ? height : 32;
    const safePadding = Number.isFinite(padding)
      ? Math.min(Math.max(0, padding), Math.min(safeWidth, safeHeight) / 2)
      : 0;
    const plotLeft = safePadding;
    const plotRight = safeWidth - safePadding;
    const plotTop = safePadding;
    const plotBottom = safeHeight - safePadding;
    const safeValues = values.map(value => Number.isFinite(value) ? value : 0);
    const lowerPadding = Number.isFinite(minPadding) ? Math.max(0, minPadding) : 0;
    const upperPadding = Number.isFinite(maxPadding) ? Math.max(0, maxPadding) : 0;
    const domainMin = (safeValues.length === 0 ? 0 : Math.min(0, ...safeValues)) - lowerPadding;
    const domainMax = (safeValues.length === 0 ? 0 : Math.max(0, ...safeValues)) + upperPadding;
    const domainRange = domainMax - domainMin;

    const pointAt = (value: number, index: number): [number, number] => {
      const x = safeValues.length <= 1
        ? (plotLeft + plotRight) / 2
        : plotLeft + (index / (safeValues.length - 1)) * (plotRight - plotLeft);
      const ratio = domainRange === 0 ? 0 : (value - domainMin) / domainRange;
      const y = domainRange === 0
        ? plotBottom
        : plotBottom - Math.min(1, Math.max(0, ratio)) * (plotBottom - plotTop);
      return [x, y];
    };
    const points = safeValues.map(pointAt);
    const pointList = points.map(([x, y]) => `${x},${y}`).join(' ');
    const areaPath = points.length < 2
      ? ''
      : `M ${points[0]?.[0] ?? plotLeft} ${plotBottom} L ${pointList.replaceAll(',', ' ')} L ${points.at(-1)?.[0] ?? plotRight} ${plotBottom} Z`;

    return {
      safeWidth,
      safeHeight,
      plotLeft,
      plotRight,
      plotBottom,
      points,
      pointList,
      areaPath,
    };
  });
</script>

<span class="relative inline-block max-w-full align-middle">
  <svg
    width={geometry.safeWidth}
    height={geometry.safeHeight}
    viewBox={`0 0 ${geometry.safeWidth} ${geometry.safeHeight}`}
    role="img"
    aria-label={ariaLabel}
    class="block h-auto max-w-full overflow-visible"
  >
    {#if geometry.points.length === 0}
      <line
        x1={geometry.plotLeft}
        x2={geometry.plotRight}
        y1={geometry.plotBottom}
        y2={geometry.plotBottom}
        class={strokeClass}
        stroke-width="1.5"
        stroke-opacity="0.4"
        vector-effect="non-scaling-stroke"
      />
    {:else}
      {#if geometry.areaPath}
        <path d={geometry.areaPath} class={fillClass} fill-opacity="0.16" />
      {/if}
      {#if geometry.points.length === 1}
        <line
          x1={geometry.plotLeft}
          x2={geometry.plotRight}
          y1={geometry.plotBottom}
          y2={geometry.plotBottom}
          class={strokeClass}
          stroke-width="1"
          stroke-opacity="0.25"
          vector-effect="non-scaling-stroke"
        />
        <circle
          cx={geometry.points[0]?.[0]}
          cy={geometry.points[0]?.[1]}
          r="2"
          class={fillClass}
        />
      {:else}
        <polyline
          points={geometry.pointList}
          fill="none"
          class={strokeClass}
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
          vector-effect="non-scaling-stroke"
        />
      {/if}
    {/if}
  </svg>

  <span class="sr-only">
    {ariaLabel} values.
    {#if values.length === 0}
      No values.
    {:else}
      <ol>
        {#each values as value, index}
          <li>Value {index + 1}: {Number.isFinite(value) ? value : 'unavailable'}</li>
        {/each}
      </ol>
    {/if}
  </span>
</span>
