import type { FleetModelUsageData } from '../../../../src/operator/garden/services/fleet-model-usage-service.js';
import {
  MODEL_USAGE_BUCKETS,
  MODEL_USAGE_RANGES,
} from '../../../../src/shared/telemetry/model-usage.js';
import {
  hasExactKeys,
  isRecord,
  isRfc4122Uuid,
} from '../../../../src/shared/utils/types.js';

const AGGREGATE_COST_FIELDS = [
  'inputUsd',
  'inputKnownCalls',
  'outputUsd',
  'outputKnownCalls',
  'cacheReadUsd',
  'cacheReadKnownCalls',
  'cacheWriteUsd',
  'cacheWriteKnownCalls',
  'totalUsd',
  'totalKnownCalls',
] as const;
const TOTAL_FIELDS = [
  'calls',
  'successfulCalls',
  'failedCalls',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
  'providerCostUsd',
  'estimatedCostUsd',
  'totalCostUsd',
  'providerCost',
  'estimatedCost',
  'effectiveCost',
  'totalDurationMs',
  'durationSamples',
  'totalTtftMs',
  'ttftSamples',
  'averageDurationMs',
  'averageTtftMs',
] as const;
const INTEGER_TOTAL_FIELDS = [
  'calls',
  'successfulCalls',
  'failedCalls',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
  'totalDurationMs',
  'durationSamples',
  'totalTtftMs',
  'ttftSamples',
] as const;
const NUMBER_TOTAL_FIELDS = [
  'providerCostUsd',
  'estimatedCostUsd',
  'totalCostUsd',
] as const;

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNullableNonNegativeNumber(value: unknown): value is number | null {
  return value === null || isNonNegativeNumber(value);
}

function isAggregateCost(value: unknown, calls: number): boolean {
  if (!isRecord(value) || !hasExactKeys(value, AGGREGATE_COST_FIELDS)) return false;
  return AGGREGATE_COST_FIELDS.every(field => (
    field.endsWith('KnownCalls')
      ? isNonNegativeInteger(value[field]) && (value[field] as number) <= calls
      : isNonNegativeNumber(value[field])
  ));
}

function equalWithinAccountingPrecision(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function hasConsistentAverage(
  average: unknown,
  total: number,
  samples: number,
): boolean {
  return samples === 0
    ? total === 0 && average === null
    : typeof average === 'number' && equalWithinAccountingPrecision(average, total / samples);
}

function isUsageTotals(value: unknown): boolean {
  if (!isRecord(value)
    || !hasExactKeys(value, TOTAL_FIELDS)
    || !INTEGER_TOTAL_FIELDS.every(field => isNonNegativeInteger(value[field]))
    || !NUMBER_TOTAL_FIELDS.every(field => isNonNegativeNumber(value[field]))
    || !isNullableNonNegativeNumber(value.averageDurationMs)
    || !isNullableNonNegativeNumber(value.averageTtftMs)) {
    return false;
  }
  const calls = value.calls as number;
  const successfulCalls = value.successfulCalls as number;
  const failedCalls = value.failedCalls as number;
  const inputTokens = value.inputTokens as number;
  const outputTokens = value.outputTokens as number;
  const cacheReadTokens = value.cacheReadTokens as number;
  const cacheWriteTokens = value.cacheWriteTokens as number;
  const totalTokens = value.totalTokens as number;
  const totalDurationMs = value.totalDurationMs as number;
  const durationSamples = value.durationSamples as number;
  const totalTtftMs = value.totalTtftMs as number;
  const ttftSamples = value.ttftSamples as number;
  return successfulCalls + failedCalls === calls
    && inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === totalTokens
    && durationSamples <= calls
    && ttftSamples <= calls
    && isAggregateCost(value.providerCost, calls)
    && isAggregateCost(value.estimatedCost, calls)
    && isAggregateCost(value.effectiveCost, calls)
    && equalWithinAccountingPrecision(
      value.providerCostUsd as number,
      (value.providerCost as Record<string, number>).totalUsd!,
    )
    && equalWithinAccountingPrecision(
      value.estimatedCostUsd as number,
      (value.estimatedCost as Record<string, number>).totalUsd!,
    )
    && equalWithinAccountingPrecision(
      value.totalCostUsd as number,
      (value.effectiveCost as Record<string, number>).totalUsd!,
    )
    && hasConsistentAverage(value.averageDurationMs, totalDurationMs, durationSamples)
    && hasConsistentAverage(value.averageTtftMs, totalTtftMs, ttftSamples);
}

function isResolvedRange(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, [
      'range',
      'timezone',
      'sinceMs',
      'untilMs',
      'bucket',
      'boundary',
      'calendarWeekStartsOn',
    ])
    && typeof value.range === 'string'
    && MODEL_USAGE_RANGES.includes(value.range as (typeof MODEL_USAGE_RANGES)[number])
    && typeof value.timezone === 'string'
    && value.timezone.length > 0
    && value.timezone.length <= 128
    && isNonNegativeInteger(value.sinceMs)
    && isNonNegativeInteger(value.untilMs)
    && value.untilMs >= value.sinceMs
    && typeof value.bucket === 'string'
    && MODEL_USAGE_BUCKETS.includes(value.bucket as (typeof MODEL_USAGE_BUCKETS)[number])
    && value.bucket !== 'auto'
    && value.boundary === '[sinceMs, untilMs)'
    && value.calendarWeekStartsOn === 'monday';
}

function isTopModel(value: unknown): boolean {
  return value === null || (
    isRecord(value)
    && hasExactKeys(value, ['key', 'calls', 'totalTokens', 'effectiveCostUsd'])
    && typeof value.key === 'string'
    && value.key.trim().length > 0
    && value.key.length <= 1_024
    && !value.key.toLowerCase().includes('companion_private')
    && isNonNegativeInteger(value.calls)
    && isNonNegativeInteger(value.totalTokens)
    && isNonNegativeNumber(value.effectiveCostUsd)
  );
}

export function parseFleetModelUsageData(value: unknown): FleetModelUsageData {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'deployment',
      'resolvedRange',
      'totals',
      'perCompanion',
      'timeSeries',
      'coverage',
    ])
    || !['single', 'fleet'].includes(String(value.deployment))
    || !isResolvedRange(value.resolvedRange)
    || (value.totals !== null && !isUsageTotals(value.totals))
    || !Array.isArray(value.perCompanion)
    || value.perCompanion.length > 256
    || !Array.isArray(value.timeSeries)
    || !isRecord(value.coverage)
    || !hasExactKeys(value.coverage, ['available', 'unavailable', 'complete'])) {
    throw new Error('Fleet cost telemetry returned an invalid projection');
  }
  const seen = new Set<string>();
  let available = 0;
  for (const companion of value.perCompanion) {
    if (!isRecord(companion)
      || typeof companion.companionId !== 'string'
      || !isRfc4122Uuid(companion.companionId)
      || seen.has(companion.companionId)
      || !['available', 'unavailable'].includes(String(companion.status))) {
      throw new Error('Fleet cost telemetry returned an invalid companion row');
    }
    seen.add(companion.companionId);
    if (companion.status === 'unavailable') {
      if (!hasExactKeys(companion, ['companionId', 'status'])) {
        throw new Error('Fleet cost telemetry returned an invalid unavailable row');
      }
      continue;
    }
    available += 1;
    if (!hasExactKeys(companion, ['companionId', 'status', 'totals', 'topModel'])
      || !isUsageTotals(companion.totals)
      || !isTopModel(companion.topModel)) {
      throw new Error('Fleet cost telemetry returned an invalid available row');
    }
  }
  for (const bucket of value.timeSeries) {
    if (!isRecord(bucket)
      || !hasExactKeys(bucket, ['startMs', 'endMs', ...TOTAL_FIELDS])
      || !isNonNegativeInteger(bucket.startMs)
      || !isNonNegativeInteger(bucket.endMs)
      || bucket.endMs < bucket.startMs
      || !isUsageTotals(Object.fromEntries(
        TOTAL_FIELDS.map(field => [field, bucket[field]]),
      ))) {
      throw new Error('Fleet cost telemetry returned an invalid time bucket');
    }
  }
  const unavailable = value.perCompanion.length - available;
  if (!isNonNegativeInteger(value.coverage.available)
    || !isNonNegativeInteger(value.coverage.unavailable)
    || typeof value.coverage.complete !== 'boolean'
    || value.coverage.available !== available
    || value.coverage.unavailable !== unavailable
    || value.coverage.complete !== (unavailable === 0)
    || (available === 0) !== (value.totals === null)) {
    throw new Error('Fleet cost telemetry returned invalid coverage');
  }
  return value as unknown as FleetModelUsageData;
}
