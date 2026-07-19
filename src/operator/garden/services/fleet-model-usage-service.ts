import type { CompanionId } from '../../../shared/routing/companion-id.js';
import {
  type ModelUsageAggregateCost,
  type ModelUsageQuery,
  type ModelUsageResolvedRange,
  type ModelUsageTimeBucket,
  type ModelUsageTotals,
} from '../../../shared/telemetry/model-usage.js';
import { roundModelUsageUsd } from '../../../shared/telemetry/model-usage-accounting.js';
import {
  createModelUsageBucketBoundaries,
  resolveModelUsageRange,
} from '../../../shared/telemetry/model-usage-range.js';
import {
  buildFleetModelUsageInternalRequestTarget,
  requireBoundedFleetModelUsageQuery,
  resolveAuthorizedFleetModelUsageRange,
} from '../../../shared/telemetry/fleet-model-usage-request.js';
import { isRecord } from '../../../shared/utils/types.js';
import type { FleetGardenTargetRegistry } from '../fleet-garden-target-registry.js';
import type {
  FleetGardenModelUsageAuthority,
  FleetGardenModelUsageTransportPort,
} from '../fleet-transport-client.js';
import type { AdminModelUsageService } from './types.js';

export interface FleetModelUsageTopModel {
  readonly key: string;
  readonly calls: number;
  readonly totalTokens: number;
  readonly effectiveCostUsd: number;
}

export interface AvailableFleetModelUsageCompanion {
  readonly companionId: CompanionId;
  readonly status: 'available';
  /** Operator-visible totals only. Companion-private spend remains fleet-headline-only. */
  readonly totals: ModelUsageTotals;
  readonly topModel: FleetModelUsageTopModel | null;
}

export interface UnavailableFleetModelUsageCompanion {
  readonly companionId: CompanionId;
  readonly status: 'unavailable';
}

export type FleetModelUsageCompanion =
  | AvailableFleetModelUsageCompanion
  | UnavailableFleetModelUsageCompanion;

export interface FleetModelUsageData {
  readonly deployment: 'single' | 'fleet';
  readonly resolvedRange: ModelUsageResolvedRange;
  /** Aggregate totals include companion-private usage from every available companion. */
  readonly totals: ModelUsageTotals | null;
  readonly perCompanion: readonly FleetModelUsageCompanion[];
  readonly timeSeries: readonly ModelUsageTimeBucket[];
  readonly coverage: {
    readonly available: number;
    readonly unavailable: number;
    readonly complete: boolean;
  };
}

interface ParsedModelUsageResponse {
  readonly resolvedRange: ModelUsageResolvedRange;
  readonly totals: ModelUsageTotals;
  readonly timeSeries: ModelUsageTimeBucket[];
  readonly visibleTotals: ModelUsageTotals;
  readonly topModel: FleetModelUsageTopModel | null;
}

const PRIVATE_DETAIL_MARKER = 'companion_private';

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Fleet model-usage response has invalid ${field}`);
  }
  return value as number;
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Fleet model-usage response has invalid ${field}`);
  }
  return value;
}

function nullableAverage(value: unknown, field: string): number | null {
  if (value === null) return null;
  return nonNegativeNumber(value, field);
}

function parseAggregateCost(value: unknown, field: string): ModelUsageAggregateCost {
  if (!isRecord(value)) {
    throw new Error(`Fleet model-usage response has invalid ${field}`);
  }
  return {
    inputUsd: nonNegativeNumber(value.inputUsd, `${field}.inputUsd`),
    inputKnownCalls: nonNegativeInteger(value.inputKnownCalls, `${field}.inputKnownCalls`),
    outputUsd: nonNegativeNumber(value.outputUsd, `${field}.outputUsd`),
    outputKnownCalls: nonNegativeInteger(value.outputKnownCalls, `${field}.outputKnownCalls`),
    cacheReadUsd: nonNegativeNumber(value.cacheReadUsd, `${field}.cacheReadUsd`),
    cacheReadKnownCalls: nonNegativeInteger(
      value.cacheReadKnownCalls,
      `${field}.cacheReadKnownCalls`,
    ),
    cacheWriteUsd: nonNegativeNumber(value.cacheWriteUsd, `${field}.cacheWriteUsd`),
    cacheWriteKnownCalls: nonNegativeInteger(
      value.cacheWriteKnownCalls,
      `${field}.cacheWriteKnownCalls`,
    ),
    totalUsd: nonNegativeNumber(value.totalUsd, `${field}.totalUsd`),
    totalKnownCalls: nonNegativeInteger(value.totalKnownCalls, `${field}.totalKnownCalls`),
  };
}

function equalWithinAccountingPrecision(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function assertAverageConsistency(
  average: number | null,
  total: number,
  samples: number,
  field: string,
): void {
  if (samples === 0) {
    if (total !== 0 || average !== null) {
      throw new Error(`Fleet model-usage response has inconsistent ${field}`);
    }
    return;
  }
  if (average === null || !equalWithinAccountingPrecision(average, total / samples)) {
    throw new Error(`Fleet model-usage response has inconsistent ${field}`);
  }
}

function assertAggregateCostConsistency(
  cost: ModelUsageAggregateCost,
  calls: number,
  field: string,
): void {
  for (const knownCalls of [
    cost.inputKnownCalls,
    cost.outputKnownCalls,
    cost.cacheReadKnownCalls,
    cost.cacheWriteKnownCalls,
    cost.totalKnownCalls,
  ]) {
    if (knownCalls > calls) {
      throw new Error(`Fleet model-usage response has inconsistent ${field}`);
    }
  }
}

function assertTotalsConsistency(totals: ModelUsageTotals, field: string): void {
  if (totals.successfulCalls + totals.failedCalls !== totals.calls
    || totals.inputTokens
      + totals.outputTokens
      + totals.cacheReadTokens
      + totals.cacheWriteTokens !== totals.totalTokens
    || totals.durationSamples > totals.calls
    || totals.ttftSamples > totals.calls
    || !equalWithinAccountingPrecision(totals.providerCostUsd, totals.providerCost.totalUsd)
    || !equalWithinAccountingPrecision(totals.estimatedCostUsd, totals.estimatedCost.totalUsd)
    || !equalWithinAccountingPrecision(totals.totalCostUsd, totals.effectiveCost.totalUsd)) {
    throw new Error(`Fleet model-usage response has inconsistent ${field}`);
  }
  assertAverageConsistency(
    totals.averageDurationMs,
    totals.totalDurationMs,
    totals.durationSamples,
    `${field}.averageDurationMs`,
  );
  assertAverageConsistency(
    totals.averageTtftMs,
    totals.totalTtftMs,
    totals.ttftSamples,
    `${field}.averageTtftMs`,
  );
  assertAggregateCostConsistency(totals.providerCost, totals.calls, `${field}.providerCost`);
  assertAggregateCostConsistency(totals.estimatedCost, totals.calls, `${field}.estimatedCost`);
  assertAggregateCostConsistency(totals.effectiveCost, totals.calls, `${field}.effectiveCost`);
}

function parseTotals(value: unknown, field: string): ModelUsageTotals {
  if (!isRecord(value)) throw new Error(`Fleet model-usage response has invalid ${field}`);
  const totals = {
    calls: nonNegativeInteger(value.calls, `${field}.calls`),
    successfulCalls: nonNegativeInteger(value.successfulCalls, `${field}.successfulCalls`),
    failedCalls: nonNegativeInteger(value.failedCalls, `${field}.failedCalls`),
    inputTokens: nonNegativeInteger(value.inputTokens, `${field}.inputTokens`),
    outputTokens: nonNegativeInteger(value.outputTokens, `${field}.outputTokens`),
    cacheReadTokens: nonNegativeInteger(value.cacheReadTokens, `${field}.cacheReadTokens`),
    cacheWriteTokens: nonNegativeInteger(value.cacheWriteTokens, `${field}.cacheWriteTokens`),
    totalTokens: nonNegativeInteger(value.totalTokens, `${field}.totalTokens`),
    providerCostUsd: nonNegativeNumber(value.providerCostUsd, `${field}.providerCostUsd`),
    estimatedCostUsd: nonNegativeNumber(value.estimatedCostUsd, `${field}.estimatedCostUsd`),
    totalCostUsd: nonNegativeNumber(value.totalCostUsd, `${field}.totalCostUsd`),
    providerCost: parseAggregateCost(value.providerCost, `${field}.providerCost`),
    estimatedCost: parseAggregateCost(value.estimatedCost, `${field}.estimatedCost`),
    effectiveCost: parseAggregateCost(value.effectiveCost, `${field}.effectiveCost`),
    totalDurationMs: nonNegativeInteger(value.totalDurationMs, `${field}.totalDurationMs`),
    durationSamples: nonNegativeInteger(value.durationSamples, `${field}.durationSamples`),
    totalTtftMs: nonNegativeInteger(value.totalTtftMs, `${field}.totalTtftMs`),
    ttftSamples: nonNegativeInteger(value.ttftSamples, `${field}.ttftSamples`),
    averageDurationMs: nullableAverage(value.averageDurationMs, `${field}.averageDurationMs`),
    averageTtftMs: nullableAverage(value.averageTtftMs, `${field}.averageTtftMs`),
  };
  assertTotalsConsistency(totals, field);
  return totals;
}

function parseResolvedRange(value: unknown): ModelUsageResolvedRange {
  if (!isRecord(value)
    || !['today', 'week', 'month', 'quarter', 'year', 'all', 'custom'].includes(String(value.range))
    || typeof value.timezone !== 'string'
    || !['hour', 'day', 'week', 'month'].includes(String(value.bucket))
    || value.boundary !== '[sinceMs, untilMs)'
    || value.calendarWeekStartsOn !== 'monday') {
    throw new Error('Fleet model-usage response has invalid resolvedRange');
  }
  return {
    range: value.range as ModelUsageResolvedRange['range'],
    timezone: value.timezone,
    sinceMs: nonNegativeInteger(value.sinceMs, 'resolvedRange.sinceMs'),
    untilMs: nonNegativeInteger(value.untilMs, 'resolvedRange.untilMs'),
    bucket: value.bucket as ModelUsageResolvedRange['bucket'],
    boundary: '[sinceMs, untilMs)',
    calendarWeekStartsOn: 'monday',
  };
}

function emptyAggregateCost(): ModelUsageAggregateCost {
  return {
    inputUsd: 0,
    inputKnownCalls: 0,
    outputUsd: 0,
    outputKnownCalls: 0,
    cacheReadUsd: 0,
    cacheReadKnownCalls: 0,
    cacheWriteUsd: 0,
    cacheWriteKnownCalls: 0,
    totalUsd: 0,
    totalKnownCalls: 0,
  };
}

function emptyTotals(): ModelUsageTotals {
  return {
    calls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    providerCostUsd: 0,
    estimatedCostUsd: 0,
    totalCostUsd: 0,
    providerCost: emptyAggregateCost(),
    estimatedCost: emptyAggregateCost(),
    effectiveCost: emptyAggregateCost(),
    totalDurationMs: 0,
    durationSamples: 0,
    totalTtftMs: 0,
    ttftSamples: 0,
    averageDurationMs: null,
    averageTtftMs: null,
  };
}

function checkedIntegerSum(left: number, right: number, field: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new Error(`Fleet model-usage ${field} overflowed`);
  return sum;
}

function addAggregateCost(
  left: ModelUsageAggregateCost,
  right: ModelUsageAggregateCost,
): ModelUsageAggregateCost {
  return {
    inputUsd: roundModelUsageUsd(left.inputUsd + right.inputUsd),
    inputKnownCalls: checkedIntegerSum(
      left.inputKnownCalls,
      right.inputKnownCalls,
      'inputKnownCalls',
    ),
    outputUsd: roundModelUsageUsd(left.outputUsd + right.outputUsd),
    outputKnownCalls: checkedIntegerSum(
      left.outputKnownCalls,
      right.outputKnownCalls,
      'outputKnownCalls',
    ),
    cacheReadUsd: roundModelUsageUsd(left.cacheReadUsd + right.cacheReadUsd),
    cacheReadKnownCalls: checkedIntegerSum(
      left.cacheReadKnownCalls,
      right.cacheReadKnownCalls,
      'cacheReadKnownCalls',
    ),
    cacheWriteUsd: roundModelUsageUsd(left.cacheWriteUsd + right.cacheWriteUsd),
    cacheWriteKnownCalls: checkedIntegerSum(
      left.cacheWriteKnownCalls,
      right.cacheWriteKnownCalls,
      'cacheWriteKnownCalls',
    ),
    totalUsd: roundModelUsageUsd(left.totalUsd + right.totalUsd),
    totalKnownCalls: checkedIntegerSum(
      left.totalKnownCalls,
      right.totalKnownCalls,
      'totalKnownCalls',
    ),
  };
}

function addTotals(left: ModelUsageTotals, right: ModelUsageTotals): ModelUsageTotals {
  const totalDurationMs = checkedIntegerSum(
    left.totalDurationMs,
    right.totalDurationMs,
    'totalDurationMs',
  );
  const durationSamples = checkedIntegerSum(
    left.durationSamples,
    right.durationSamples,
    'durationSamples',
  );
  const totalTtftMs = checkedIntegerSum(left.totalTtftMs, right.totalTtftMs, 'totalTtftMs');
  const ttftSamples = checkedIntegerSum(left.ttftSamples, right.ttftSamples, 'ttftSamples');
  return {
    calls: checkedIntegerSum(left.calls, right.calls, 'calls'),
    successfulCalls: checkedIntegerSum(
      left.successfulCalls,
      right.successfulCalls,
      'successfulCalls',
    ),
    failedCalls: checkedIntegerSum(left.failedCalls, right.failedCalls, 'failedCalls'),
    inputTokens: checkedIntegerSum(left.inputTokens, right.inputTokens, 'inputTokens'),
    outputTokens: checkedIntegerSum(left.outputTokens, right.outputTokens, 'outputTokens'),
    cacheReadTokens: checkedIntegerSum(
      left.cacheReadTokens,
      right.cacheReadTokens,
      'cacheReadTokens',
    ),
    cacheWriteTokens: checkedIntegerSum(
      left.cacheWriteTokens,
      right.cacheWriteTokens,
      'cacheWriteTokens',
    ),
    totalTokens: checkedIntegerSum(left.totalTokens, right.totalTokens, 'totalTokens'),
    providerCostUsd: roundModelUsageUsd(left.providerCostUsd + right.providerCostUsd),
    estimatedCostUsd: roundModelUsageUsd(left.estimatedCostUsd + right.estimatedCostUsd),
    totalCostUsd: roundModelUsageUsd(left.totalCostUsd + right.totalCostUsd),
    providerCost: addAggregateCost(left.providerCost, right.providerCost),
    estimatedCost: addAggregateCost(left.estimatedCost, right.estimatedCost),
    effectiveCost: addAggregateCost(left.effectiveCost, right.effectiveCost),
    totalDurationMs,
    durationSamples,
    totalTtftMs,
    ttftSamples,
    averageDurationMs: durationSamples === 0 ? null : totalDurationMs / durationSamples,
    averageTtftMs: ttftSamples === 0 ? null : totalTtftMs / ttftSamples,
  };
}

function hasPrivateDetailMarker(value: string): boolean {
  return value.toLowerCase().includes(PRIVATE_DETAIL_MARKER);
}

function parseModelUsageResponse(
  value: unknown,
  expectedRange: ModelUsageResolvedRange,
): ParsedModelUsageResponse {
  if (!isRecord(value)
    || !Array.isArray(value.timeSeries)
    || !Array.isArray(value.groups)
    || !Array.isArray(value.byModel)) {
    throw new Error('Fleet model-usage response is malformed');
  }
  const resolvedRange = parseResolvedRange(value.resolvedRange);
  if (resolvedRange.sinceMs !== expectedRange.sinceMs
    || resolvedRange.untilMs !== expectedRange.untilMs
    || resolvedRange.timezone !== expectedRange.timezone
    || resolvedRange.bucket !== expectedRange.bucket) {
    throw new Error('Fleet model-usage response range does not match the fleet query');
  }
  const timeSeries = value.timeSeries.map((bucket, index): ModelUsageTimeBucket => {
    if (!isRecord(bucket)) {
      throw new Error(`Fleet model-usage response has invalid timeSeries[${index}]`);
    }
    return {
      startMs: nonNegativeInteger(bucket.startMs, `timeSeries[${index}].startMs`),
      endMs: nonNegativeInteger(bucket.endMs, `timeSeries[${index}].endMs`),
      ...parseTotals(bucket, `timeSeries[${index}]`),
    };
  });
  const expectedBoundaries = createModelUsageBucketBoundaries(expectedRange);
  if (timeSeries.length !== expectedBoundaries.length
    || timeSeries.some((bucket, index) => (
      bucket.startMs !== expectedBoundaries[index]?.startMs
      || bucket.endMs !== expectedBoundaries[index]?.endMs
    ))) {
    throw new Error('Fleet model-usage response timeSeries does not match the fleet buckets');
  }
  let visibleTotals = emptyTotals();
  for (const [index, group] of value.groups.entries()) {
    if (!isRecord(group) || !isRecord(group.dimensions)) {
      throw new Error(`Fleet model-usage response has invalid groups[${index}]`);
    }
    for (const dimension of Object.values(group.dimensions)) {
      if (typeof dimension === 'string' && hasPrivateDetailMarker(dimension)) {
        throw new Error('Fleet model-usage response exposed companion-private detail');
      }
    }
    visibleTotals = addTotals(visibleTotals, parseTotals(group.metrics, `groups[${index}].metrics`));
  }
  let topModel: FleetModelUsageTopModel | null = null;
  const firstModel = value.byModel[0];
  if (firstModel !== undefined) {
    if (!isRecord(firstModel)
      || typeof firstModel.key !== 'string'
      || !firstModel.key.trim()
      || firstModel.key.length > 1_024
      || hasPrivateDetailMarker(firstModel.key)) {
      throw new Error('Fleet model-usage response has invalid top model detail');
    }
    topModel = {
      key: firstModel.key,
      calls: nonNegativeInteger(firstModel.calls, 'byModel[0].calls'),
      totalTokens: nonNegativeInteger(firstModel.totalTokens, 'byModel[0].totalTokens'),
      effectiveCostUsd: nonNegativeNumber(
        firstModel.totalCostUsd,
        'byModel[0].totalCostUsd',
      ),
    };
  }
  return {
    resolvedRange,
    totals: parseTotals(value.totals, 'totals'),
    timeSeries,
    visibleTotals,
    topModel,
  };
}

function buildUpstreamQuery(range: ModelUsageResolvedRange): ModelUsageQuery {
  return {
    range: 'custom',
    timezone: range.timezone,
    sinceMs: range.sinceMs,
    untilMs: range.untilMs,
    bucket: range.bucket,
    limit: 1,
    topN: 100,
    groupBy: ['model'],
  };
}

/** Single-companion compatibility projection over that Garden's canonical service. */
export class SingleCompanionFleetModelUsageService {
  constructor(private readonly options: {
    readonly companionId: CompanionId;
    readonly modelUsage: Pick<AdminModelUsageService, 'getModelUsageData'>;
    readonly nowMs?: () => number;
  }) {}

  async getFleetModelUsage(query: ModelUsageQuery = {}): Promise<FleetModelUsageData> {
    const resolvedRange = resolveModelUsageRange(requireBoundedFleetModelUsageQuery(query), {
      nowMs: this.options.nowMs?.() ?? Date.now(),
    });
    const response = parseModelUsageResponse(
      await this.options.modelUsage.getModelUsageData(buildUpstreamQuery(resolvedRange)),
      resolvedRange,
    );
    return {
      deployment: 'single',
      resolvedRange,
      totals: response.totals,
      perCompanion: [{
        companionId: this.options.companionId,
        status: 'available',
        totals: response.visibleTotals,
        topModel: response.topModel,
      }],
      timeSeries: response.timeSeries,
      coverage: { available: 1, unavailable: 0, complete: true },
    };
  }
}

function mergeTimeSeries(responses: readonly ParsedModelUsageResponse[]): ModelUsageTimeBucket[] {
  const buckets = new Map<string, ModelUsageTimeBucket>();
  for (const response of responses) {
    for (const bucket of response.timeSeries) {
      const key = `${bucket.startMs}:${bucket.endMs}`;
      const existing = buckets.get(key);
      buckets.set(key, existing
        ? { startMs: bucket.startMs, endMs: bucket.endMs, ...addTotals(existing, bucket) }
        : bucket);
    }
  }
  return [...buckets.values()].sort((left, right) => left.startMs - right.startMs);
}

export class FleetModelUsageService {
  constructor(private readonly options: {
    readonly registry: FleetGardenTargetRegistry;
    readonly transport: FleetGardenModelUsageTransportPort;
  }) {}

  async getFleetModelUsage(
    query: ModelUsageQuery = {},
    authority?: FleetGardenModelUsageAuthority,
  ): Promise<FleetModelUsageData> {
    if (!authority || authority.authorizedCompanionIds.length === 0) {
      throw new Error('Fleet model usage requires a signed authorized companion roster');
    }
    const resolvedRange = resolveAuthorizedFleetModelUsageRange(
      query,
      authority.modelUsageRequestTarget,
    );
    const requestPath = buildFleetModelUsageInternalRequestTarget(resolvedRange);
    const results = await Promise.all(authority.authorizedCompanionIds.map(async companionId => {
      try {
        const response = parseModelUsageResponse(
          await this.options.transport.requestModelUsage(
            this.options.registry.resolve(companionId),
            requestPath,
            authority,
          ),
          resolvedRange,
        );
        return { companionId, status: 'available' as const, response };
      } catch {
        return { companionId, status: 'unavailable' as const };
      }
    }));
    const available = results.flatMap(result => (
      result.status === 'available' ? [result] : []
    ));
    const totals = available.length === 0
      ? null
      : available.reduce(
        (aggregate, result) => addTotals(aggregate, result.response.totals),
        emptyTotals(),
      );
    const perCompanion: FleetModelUsageCompanion[] = results.map(result => (
      result.status === 'available'
        ? {
            companionId: result.companionId,
            status: 'available',
            totals: result.response.visibleTotals,
            topModel: result.response.topModel,
          }
        : { companionId: result.companionId, status: 'unavailable' }
    ));
    return {
      deployment: 'fleet',
      resolvedRange,
      totals,
      perCompanion,
      timeSeries: mergeTimeSeries(available.map(result => result.response)),
      coverage: {
        available: available.length,
        unavailable: results.length - available.length,
        complete: available.length === results.length,
      },
    };
  }
}
