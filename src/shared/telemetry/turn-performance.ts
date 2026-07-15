import type { EventBus } from '../event-bus.js';

export const TURN_PERFORMANCE_STAGES = [
  'transport_received',
  'speech_end',
  'stt_final',
  'channel_queue_wait',
  'post_turn_drain_wait',
  'compaction_wait',
  'context_assembly',
  'prompt_assembly',
  'provider_request',
  'provider_first_token',
  'first_text_committed',
  'tts_request',
  'tts_first_byte',
  'first_audible_playback',
  'cancellation_ack',
  'background_job_state',
  'turn_complete',
] as const;

export type TurnPerformanceStage = typeof TURN_PERFORMANCE_STAGES[number];

export type TurnPerformanceWarmState = 'warm' | 'cold' | 'unknown';
export type TurnPerformanceCacheState = 'hit' | 'miss' | 'mixed' | 'unknown';
export type TurnPerformanceDeferReason =
  | 'no_stream_delta'
  | 'queued'
  | 'deduplicated'
  | 'started'
  | 'succeeded'
  | 'rescheduled'
  | 'retry_scheduled'
  | 'failed'
  | 'dropped_budget'
  | 'cancelled'
  | 'acknowledged'
  | 'malformed_dropped';

/**
 * Content-free foreground timing envelope. Keep this contract deliberately
 * closed: prompt text, transcripts, generated text, tool arguments, and audio
 * must never enter live latency telemetry.
 */
export interface TurnPerformanceEvent {
  schemaVersion: 1;
  traceId: string;
  stage: TurnPerformanceStage;
  monotonicAtMs: number;
  timestampMs: number;
  turnId?: string;
  requestId?: string;
  companionId?: string;
  channelId?: string;
  channelType?: string;
  model?: string;
  provider?: string;
  warmState?: TurnPerformanceWarmState;
  cacheState?: TurnPerformanceCacheState;
  toolUse?: boolean;
  backgroundContention?: boolean;
  durationMs?: number;
  queueDepth?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  backgroundJobAgeMs?: number;
  deferReason?: TurnPerformanceDeferReason;
  cancellationOutcome?: 'acknowledged' | 'timed_out' | 'failed';
}

export type TurnPerformanceEventInput = Omit<
  TurnPerformanceEvent,
  'schemaVersion' | 'monotonicAtMs' | 'timestampMs'
> & Partial<Pick<TurnPerformanceEvent, 'monotonicAtMs' | 'timestampMs'>>;

export interface TurnPerformanceDimensions {
  companionId?: string;
  channelId?: string;
  channelType?: string;
  model?: string;
  provider?: string;
  warmState?: TurnPerformanceWarmState;
  cacheState?: TurnPerformanceCacheState;
  toolUse?: boolean;
  backgroundContention?: boolean;
}

export type TurnPerformanceMetric = TurnPerformanceStage | 'llm_ttft' | 'ttfa';

export interface TurnPerformancePercentiles {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface TurnPerformancePercentileSeries {
  metric: TurnPerformanceMetric;
  dimensions: TurnPerformanceDimensions;
  percentiles: TurnPerformancePercentiles;
}

export interface TurnPerformanceSnapshot {
  windowSize: number;
  series: TurnPerformancePercentileSeries[];
}

interface TurnTimeline {
  traceId: string;
  stages: Partial<Record<TurnPerformanceStage, TurnPerformanceEvent>>;
  dimensions: TurnPerformanceDimensions;
  derivedMetrics: Set<'llm_ttft' | 'ttfa'>;
}

interface DurationSample {
  traceId: string;
  metric: TurnPerformanceMetric;
  durationMs: number;
  dimensions: TurnPerformanceDimensions;
}

const DIMENSION_KEYS = [
  'companionId',
  'channelId',
  'channelType',
  'model',
  'provider',
  'warmState',
  'cacheState',
  'toolUse',
  'backgroundContention',
] as const satisfies readonly (keyof TurnPerformanceDimensions)[];

export function monotonicEpochNowMs(): number {
  return performance.timeOrigin + performance.now();
}

export function buildTurnPerformanceEvent(input: TurnPerformanceEventInput): TurnPerformanceEvent {
  return {
    schemaVersion: 1,
    ...input,
    monotonicAtMs: input.monotonicAtMs ?? monotonicEpochNowMs(),
    timestampMs: input.timestampMs ?? Date.now(),
  };
}

export function emitTurnPerformance(
  eventBus: EventBus,
  input: TurnPerformanceEventInput,
): Promise<void> {
  return eventBus.emit('agent.turn.performance', buildTurnPerformanceEvent(input));
}

/** Bounded, process-local live aggregation for Garden. */
export class TurnPerformanceTracker {
  private readonly timelines = new Map<string, TurnTimeline>();
  private readonly samples: DurationSample[] = [];

  constructor(private readonly windowSize = 512) {
    if (!Number.isInteger(windowSize) || windowSize < 1) {
      throw new Error('Turn performance window size must be a positive integer');
    }
  }

  observe(event: TurnPerformanceEvent): void {
    if (!Number.isFinite(event.monotonicAtMs)) return;
    let timeline = this.timelines.get(event.traceId);
    if (!timeline) {
      timeline = { traceId: event.traceId, stages: {}, dimensions: {}, derivedMetrics: new Set() };
      this.timelines.set(event.traceId, timeline);
      this.trimTimelines();
    }
    timeline.dimensions = mergeDimensions(timeline.dimensions, event);
    for (const sample of this.samples) {
      if (sample.traceId === event.traceId) {
        sample.dimensions = { ...timeline.dimensions };
      }
    }
    const existingStage = timeline.stages[event.stage];
    if (!existingStage || event.monotonicAtMs < existingStage.monotonicAtMs) {
      timeline.stages[event.stage] = event;
    }

    if (isNonNegativeDuration(event.durationMs)) {
      this.addSample(event.traceId, event.stage, event.durationMs, timeline.dimensions);
    }
    this.addDerivedSample(timeline, 'llm_ttft', 'provider_request', 'provider_first_token');
    this.addDerivedSample(timeline, 'ttfa', 'speech_end', 'first_audible_playback');
  }

  snapshot(): TurnPerformanceSnapshot {
    const groups = new Map<string, {
      metric: TurnPerformanceMetric;
      dimensions: TurnPerformanceDimensions;
      values: number[];
    }>();
    for (const sample of this.samples) {
      this.addGroup(groups, sample.metric, {}, sample.durationMs);
      for (const key of DIMENSION_KEYS) {
        const value = sample.dimensions[key];
        if (value === undefined) continue;
        this.addGroup(groups, sample.metric, { [key]: value }, sample.durationMs);
      }
    }
    return {
      windowSize: this.windowSize,
      series: [...groups.values()]
        .map(group => ({
          metric: group.metric,
          dimensions: group.dimensions,
          percentiles: calculatePercentiles(group.values),
        }))
        .sort(compareSeries),
    };
  }

  private addDerivedSample(
    timeline: TurnTimeline,
    metric: 'llm_ttft' | 'ttfa',
    startStage: TurnPerformanceStage,
    endStage: TurnPerformanceStage,
  ): void {
    if (timeline.derivedMetrics.has(metric)) return;
    const start = timeline.stages[startStage];
    const end = timeline.stages[endStage];
    if (!start || !end) return;
    const durationMs = end.monotonicAtMs - start.monotonicAtMs;
    if (!isNonNegativeDuration(durationMs)) return;
    timeline.derivedMetrics.add(metric);
    this.addSample(timeline.traceId, metric, durationMs, timeline.dimensions);
  }

  private addSample(
    traceId: string,
    metric: TurnPerformanceMetric,
    durationMs: number,
    dimensions: TurnPerformanceDimensions,
  ): void {
    this.samples.push({ traceId, metric, durationMs, dimensions: { ...dimensions } });
    let metricSamples = 0;
    for (let index = this.samples.length - 1; index >= 0; index -= 1) {
      if (this.samples[index]?.metric !== metric) continue;
      metricSamples += 1;
      if (metricSamples > this.windowSize) {
        this.samples.splice(index, 1);
        break;
      }
    }
  }

  private addGroup(
    groups: Map<string, {
      metric: TurnPerformanceMetric;
      dimensions: TurnPerformanceDimensions;
      values: number[];
    }>,
    metric: TurnPerformanceMetric,
    dimensions: TurnPerformanceDimensions,
    durationMs: number,
  ): void {
    const dimensionsKey = JSON.stringify(dimensions);
    const key = `${metric}:${dimensionsKey}`;
    const existing = groups.get(key);
    if (existing) {
      existing.values.push(durationMs);
      return;
    }
    groups.set(key, { metric, dimensions, values: [durationMs] });
  }

  private trimTimelines(): void {
    while (this.timelines.size > this.windowSize) {
      const oldest = this.timelines.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.timelines.delete(oldest);
    }
  }
}

function mergeDimensions(
  current: TurnPerformanceDimensions,
  event: TurnPerformanceEvent,
): TurnPerformanceDimensions {
  const next = { ...current };
  for (const key of DIMENSION_KEYS) {
    const value = event[key];
    if (value !== undefined) {
      Object.assign(next, { [key]: value });
    }
  }
  return next;
}

function isNonNegativeDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function calculatePercentiles(values: readonly number[]): TurnPerformancePercentiles {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: nearestRank(sorted, 0.50),
    p95Ms: nearestRank(sorted, 0.95),
    p99Ms: nearestRank(sorted, 0.99),
  };
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * percentile) - 1);
  return sorted[index] ?? 0;
}

function compareSeries(
  left: TurnPerformancePercentileSeries,
  right: TurnPerformancePercentileSeries,
): number {
  return left.metric.localeCompare(right.metric)
    || JSON.stringify(left.dimensions).localeCompare(JSON.stringify(right.dimensions));
}
