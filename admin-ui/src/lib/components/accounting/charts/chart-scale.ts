export interface ChartSegment {
  key: string;
  value: number;
}

export interface ChartBucket {
  startMs: number;
  segments: readonly ChartSegment[];
}

export interface StackedChartSegment extends ChartSegment {
  start: number;
  end: number;
  startRatio: number;
  endRatio: number;
}

export interface StackedChartBucket {
  startMs: number;
  total: number;
  segments: StackedChartSegment[];
}

export const OTHER_SERIES_KEY = 'Other';

const NICE_STEPS = [1, 2, 2.5, 5, 10] as const;

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function stableNumber(value: number): number {
  return value === 0 ? 0 : Number(value.toPrecision(12));
}

function aggregateSegmentValues(segments: readonly ChartSegment[]): Map<string, number> {
  const values = new Map<string, number>();
  for (const segment of segments) {
    values.set(
      segment.key,
      (values.get(segment.key) ?? 0) + finiteNonNegative(segment.value),
    );
  }
  return values;
}

/** Round a positive chart maximum up to a human-readable scale boundary. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;

  const magnitude = 10 ** Math.floor(Math.log10(value));
  if (magnitude === 0) return value;

  const normalized = value / magnitude;
  const step = NICE_STEPS.find(candidate => normalized <= candidate) ?? 10;
  return stableNumber(step * magnitude);
}

/** Build a fixed number of evenly spaced ticks, including zero and max. */
export function buildLinearTicks(max: number, count: number): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0];

  const tickCount = Number.isFinite(count) ? Math.max(2, Math.floor(count)) : 2;
  return Array.from({ length: tickCount }, (_, index) => {
    if (index === tickCount - 1) return max;
    return stableNumber((max * index) / (tickCount - 1));
  });
}

/**
 * Stack each bucket in the requested series order. Missing and invalid values
 * become zero so every returned coordinate remains finite.
 */
export function stackSegments(
  buckets: readonly ChartBucket[],
  seriesKeys: readonly string[],
): StackedChartBucket[] {
  const orderedKeys = [...new Set(seriesKeys)];

  return buckets.map((bucket) => {
    const values = aggregateSegmentValues(bucket.segments);
    const total = orderedKeys.reduce((sum, key) => sum + (values.get(key) ?? 0), 0);
    let cursor = 0;
    const segments = orderedKeys.map((key): StackedChartSegment => {
      const value = values.get(key) ?? 0;
      const start = cursor;
      const end = start + value;
      cursor = end;
      return {
        key,
        value,
        start,
        end,
        startRatio: total === 0 ? 0 : start / total,
        endRatio: total === 0 ? 0 : end / total,
      };
    });

    return { startMs: bucket.startMs, total, segments };
  });
}

/**
 * Keep the N highest-total series (including ties at the cutoff) and merge all
 * remaining bucket values into a stable `Other` segment.
 */
export function mergeTopNSeries(
  buckets: readonly ChartBucket[],
  keyTotals: readonly ChartSegment[],
  n: number,
): ChartBucket[] {
  const totals = new Map<string, number>();
  for (const total of keyTotals) {
    if (total.key === OTHER_SERIES_KEY) continue;
    totals.set(total.key, (totals.get(total.key) ?? 0) + finiteNonNegative(total.value));
  }

  const ranked = [...totals.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((left, right) => right.value - left.value || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const requestedCount = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  const cutoff = requestedCount > 0 && requestedCount < ranked.length
    ? ranked[requestedCount - 1]?.value
    : undefined;
  const selected = requestedCount >= ranked.length
    ? ranked
    : requestedCount === 0
      ? []
      : ranked.filter((entry, index) => index < requestedCount || entry.value === cutoff);
  const selectedKeys = new Set(selected.map(entry => entry.key));
  const hasOther = ranked.some(entry => !selectedKeys.has(entry.key))
    || buckets.some(bucket => bucket.segments.some(segment => !selectedKeys.has(segment.key)));

  return buckets.map((bucket) => {
    const values = aggregateSegmentValues(bucket.segments);
    const segments: ChartSegment[] = selected.map(({ key }) => ({
      key,
      value: values.get(key) ?? 0,
    }));
    if (hasOther) {
      const otherValue = [...values.entries()].reduce(
        (sum, [key, value]) => selectedKeys.has(key) ? sum : sum + value,
        0,
      );
      segments.push({ key: OTHER_SERIES_KEY, value: otherValue });
    }

    return { startMs: bucket.startMs, segments };
  });
}
