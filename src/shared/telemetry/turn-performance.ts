import type { LLMStreamOutputKind } from '../contracts/runtime-base.js';
import { isRecord } from '../utils/types.js';

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
  | 'resumed'
  | 'stale_discarded'
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
  providerOutputKind?: LLMStreamOutputKind;
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
  backgroundSessionIdHash?: string;
  backgroundJobAttemptCount?: number;
  backgroundJobKind?:
    | 'memory_extraction'
    | 'intention_post_turn_hooks'
    | 'emotion_appraisal'
    | 'auto_compaction';
  backgroundJobState?:
    | 'queued'
    | 'deferred'
    | 'retry_wait'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'stale_discarded';
  backgroundJobReason?:
    | 'enqueued'
    | 'deduplicated'
    | 'foreground_active'
    | 'started'
    | 'completed'
    | 'handler_failed'
    | 'retry_scheduled'
    | 'retry_exhausted'
    | 'lease_expired'
    | 'shutdown'
    | 'source_not_ready'
    | 'source_missing'
    | 'source_mismatch'
    | 'superseded'
    | 'malformed_payload'
    | 'unknown_kind';
  deferReason?: TurnPerformanceDeferReason;
  cancellationOutcome?: 'acknowledged' | 'timed_out' | 'failed';
}

export interface TurnPerformanceEventEmitter {
  emit(event: 'agent.turn.performance', payload: TurnPerformanceEvent): Promise<void>;
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

const TURN_PERFORMANCE_EVENT_KEYS = new Set<keyof TurnPerformanceEvent>([
  'schemaVersion',
  'traceId',
  'stage',
  'monotonicAtMs',
  'timestampMs',
  'turnId',
  'requestId',
  'companionId',
  'channelId',
  'channelType',
  'model',
  'provider',
  'providerOutputKind',
  'warmState',
  'cacheState',
  'toolUse',
  'backgroundContention',
  'durationMs',
  'queueDepth',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'costUsd',
  'backgroundJobAgeMs',
  'backgroundSessionIdHash',
  'backgroundJobAttemptCount',
  'backgroundJobKind',
  'backgroundJobState',
  'backgroundJobReason',
  'deferReason',
  'cancellationOutcome',
]);

const TURN_PERFORMANCE_STAGE_SET = new Set<string>(TURN_PERFORMANCE_STAGES);
const TURN_PERFORMANCE_WARM_STATE_SET = new Set<string>(['warm', 'cold', 'unknown']);
const TURN_PERFORMANCE_CACHE_STATE_SET = new Set<string>(['hit', 'miss', 'mixed', 'unknown']);
const TURN_PERFORMANCE_PROVIDER_OUTPUT_KIND_SET = new Set<string>(['text', 'thinking', 'tool']);
const TURN_PERFORMANCE_DEFER_REASON_SET = new Set<string>([
  'no_stream_delta',
  'queued',
  'deduplicated',
  'started',
  'succeeded',
  'rescheduled',
  'retry_scheduled',
  'failed',
  'resumed',
  'stale_discarded',
  'dropped_budget',
  'cancelled',
  'acknowledged',
  'malformed_dropped',
]);
const TURN_PERFORMANCE_CANCELLATION_OUTCOME_SET = new Set<string>([
  'acknowledged',
  'timed_out',
  'failed',
]);
const TURN_PERFORMANCE_BACKGROUND_JOB_KIND_SET = new Set<string>([
  'memory_extraction',
  'intention_post_turn_hooks',
  'emotion_appraisal',
  'auto_compaction',
]);
const TURN_PERFORMANCE_BACKGROUND_JOB_STATE_SET = new Set<string>([
  'queued',
  'deferred',
  'retry_wait',
  'running',
  'succeeded',
  'failed',
  'stale_discarded',
]);
const TURN_PERFORMANCE_BACKGROUND_JOB_REASON_SET = new Set<string>([
  'enqueued',
  'deduplicated',
  'foreground_active',
  'started',
  'completed',
  'handler_failed',
  'retry_scheduled',
  'retry_exhausted',
  'lease_expired',
  'shutdown',
  'source_not_ready',
  'source_missing',
  'source_mismatch',
  'superseded',
  'malformed_payload',
  'unknown_kind',
]);

/**
 * Validate the gateway→agent wire envelope before it reaches the agent bus.
 * Unknown keys are rejected so prompt text, transcripts, tool arguments, and
 * audio can never hitch a ride on this content-free telemetry boundary.
 */
export function parseTurnPerformanceEvent(value: unknown): TurnPerformanceEvent {
  if (!isRecord(value)) {
    throw new Error('Turn performance event must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!TURN_PERFORMANCE_EVENT_KEYS.has(key as keyof TurnPerformanceEvent)) {
      throw new Error(`Turn performance event contains unsupported field "${key}"`);
    }
  }
  if (value.schemaVersion !== 1) {
    throw new Error('Turn performance event schemaVersion must be 1');
  }
  requireNonEmptyString(value.traceId, 'traceId');
  requireEnum(value.stage, TURN_PERFORMANCE_STAGE_SET, 'stage');
  requireFiniteNonNegative(value.monotonicAtMs, 'monotonicAtMs');
  requireFiniteNonNegative(value.timestampMs, 'timestampMs');
  for (const key of [
    'turnId',
    'requestId',
    'companionId',
    'channelId',
    'channelType',
    'model',
    'provider',
    'backgroundSessionIdHash',
  ] as const) {
    if (value[key] !== undefined) requireNonEmptyString(value[key], key);
  }
  if (value.providerOutputKind !== undefined) {
    requireEnum(value.providerOutputKind, TURN_PERFORMANCE_PROVIDER_OUTPUT_KIND_SET, 'providerOutputKind');
  }
  if (value.warmState !== undefined) {
    requireEnum(value.warmState, TURN_PERFORMANCE_WARM_STATE_SET, 'warmState');
  }
  if (value.cacheState !== undefined) {
    requireEnum(value.cacheState, TURN_PERFORMANCE_CACHE_STATE_SET, 'cacheState');
  }
  if (value.backgroundJobKind !== undefined) {
    requireEnum(value.backgroundJobKind, TURN_PERFORMANCE_BACKGROUND_JOB_KIND_SET, 'backgroundJobKind');
  }
  if (value.backgroundJobState !== undefined) {
    requireEnum(value.backgroundJobState, TURN_PERFORMANCE_BACKGROUND_JOB_STATE_SET, 'backgroundJobState');
  }
  if (value.backgroundJobReason !== undefined) {
    requireEnum(value.backgroundJobReason, TURN_PERFORMANCE_BACKGROUND_JOB_REASON_SET, 'backgroundJobReason');
  }
  if (value.backgroundSessionIdHash !== undefined) {
    requireNonEmptyString(value.backgroundSessionIdHash, 'backgroundSessionIdHash');
    if (!/^[a-f0-9]{64}$/.test(value.backgroundSessionIdHash)) {
      throw new Error('Turn performance event backgroundSessionIdHash must be a SHA-256 hex digest');
    }
  }
  for (const key of ['toolUse', 'backgroundContention'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      throw new Error(`Turn performance event ${key} must be a boolean`);
    }
  }
  for (const key of [
    'durationMs',
    'queueDepth',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'costUsd',
    'backgroundJobAgeMs',
    'backgroundJobAttemptCount',
  ] as const) {
    if (value[key] !== undefined) requireFiniteNonNegative(value[key], key);
  }
  if (value.backgroundJobAttemptCount !== undefined
    && !Number.isSafeInteger(value.backgroundJobAttemptCount)) {
    throw new Error('Turn performance event backgroundJobAttemptCount must be a safe integer');
  }
  if (value.deferReason !== undefined) {
    requireEnum(value.deferReason, TURN_PERFORMANCE_DEFER_REASON_SET, 'deferReason');
  }
  if (value.cancellationOutcome !== undefined) {
    requireEnum(
      value.cancellationOutcome,
      TURN_PERFORMANCE_CANCELLATION_OUTCOME_SET,
      'cancellationOutcome',
    );
  }
  return value as unknown as TurnPerformanceEvent;
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`Turn performance event ${field} must be a trimmed non-empty string`);
  }
}

function requireFiniteNonNegative(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Turn performance event ${field} must be a finite non-negative number`);
  }
}

function requireEnum(value: unknown, allowed: ReadonlySet<string>, field: string): asserts value is string {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`Turn performance event ${field} is invalid`);
  }
}

export function emitTurnPerformance(
  eventBus: TurnPerformanceEventEmitter,
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
