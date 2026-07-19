import type {
  ModelUsageDimensionTimeBucket,
  ModelUsageTimeBucket,
} from '../../../../../../src/shared/telemetry/model-usage.js';
import {
  mergeTopNSeries,
  type ChartBucket,
  type ChartSegment,
} from './chart-scale';

export type UsageChartMetric = 'effectiveCost' | 'totalTokens' | 'calls';

export interface UsageByModelChartData {
  buckets: ChartBucket[];
  seriesKeys: string[];
}

function metricValue(
  bucket: ModelUsageDimensionTimeBucket,
  metric: UsageChartMetric,
): number {
  return metric === 'effectiveCost' ? bucket.effectiveCost.totalUsd : bucket[metric];
}

export function buildUsageByModelChartData(
  timeSeries: readonly ModelUsageTimeBucket[],
  modelSeries: readonly ModelUsageDimensionTimeBucket[],
  metric: UsageChartMetric,
  topN: number,
): UsageByModelChartData {
  const segmentsByStart = new Map<number, ChartSegment[]>(timeSeries.map(bucket => [
    bucket.startMs,
    [],
  ]));
  const keyTotals: ChartSegment[] = [];

  for (const bucket of modelSeries) {
    const segments = segmentsByStart.get(bucket.startMs);
    if (!segments) continue;
    const segment = { key: bucket.key, value: metricValue(bucket, metric) };
    segments.push(segment);
    keyTotals.push(segment);
  }

  const buckets = mergeTopNSeries(timeSeries.map(bucket => ({
    startMs: bucket.startMs,
    segments: segmentsByStart.get(bucket.startMs) ?? [],
  })), keyTotals, topN);
  const seriesKeys = [...new Set(buckets.flatMap(bucket => (
    bucket.segments.map(segment => segment.key)
  )))];
  return { buckets, seriesKeys };
}

export function buildTokenCompositionBuckets(
  timeSeries: readonly ModelUsageTimeBucket[],
): ChartBucket[] {
  return timeSeries.map(bucket => ({
    startMs: bucket.startMs,
    segments: [
      { key: 'input', value: bucket.inputTokens },
      { key: 'cacheRead', value: bucket.cacheReadTokens },
      { key: 'cacheWrite', value: bucket.cacheWriteTokens },
      { key: 'output', value: bucket.outputTokens },
    ],
  }));
}
