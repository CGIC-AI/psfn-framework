import type { RunChargeLedgerEntry } from './charge-ledger.js';
import type { ModelUsageEvent } from './model-usage.js';
import { MODEL_USAGE_UNKNOWN_DIMENSION } from './model-usage-attribution.js';
import {
  addChargeCostMetrics,
  chargeCostMetricsFor,
  createChargeCostBreakdowns,
  emptyChargeCostMetrics,
  finalizeChargeCostMetrics,
  roundChargeCost,
} from './charge-cost-reconciliation-accounting.js';
import {
  MODEL_BEARING_CHARGE_SURFACES,
  type ChargeCostAllocationMethod,
  type ChargeCostDisposition,
  type ChargeCostGroup,
  type ChargeCostLedgerReconciliation,
  type ChargeCostMetrics,
  type ChargeCostReconciliationData,
  type ChargeCostReconciliationQuery,
  type ReconcileChargeCostsInput,
} from './charge-cost-reconciliation-contracts.js';

export * from './charge-cost-reconciliation-contracts.js';

interface InternalGroup {
  chargeEntries: RunChargeLedgerEntry[];
  usageEvents: ModelUsageEvent[];
  forceAmbiguous?: boolean;
  exact?: boolean;
}

const MODEL_BEARING_SURFACE_SET: ReadonlySet<string> = new Set(MODEL_BEARING_CHARGE_SURFACES);

function known(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized !== MODEL_USAGE_UNKNOWN_DIMENSION ? normalized : undefined;
}

function chargeShardId(entry: RunChargeLedgerEntry): string {
  return known(entry.event.shardId) ?? known(entry.metadata?.shardId) ?? MODEL_USAGE_UNKNOWN_DIMENSION;
}

function chargeSubagentId(entry: RunChargeLedgerEntry): string {
  return known(entry.event.subagentId) ?? known(entry.metadata?.subagentId) ?? MODEL_USAGE_UNKNOWN_DIMENSION;
}

function chargeCorrelationParts(entry: RunChargeLedgerEntry, tenantCompanionId: string): string[] {
  const event = entry.event;
  return [
    event.lineage.runId,
    event.lineage.rootRunId,
    known(event.lineage.parentRunId) ?? MODEL_USAGE_UNKNOWN_DIMENSION,
    event.lane,
    event.surface,
    known(event.companionId) ?? tenantCompanionId,
    known(event.channelId) ?? MODEL_USAGE_UNKNOWN_DIMENSION,
    chargeShardId(entry),
    chargeSubagentId(entry),
  ];
}

function usageCorrelationParts(event: ModelUsageEvent): string[] {
  const attribution = event.attribution;
  return [
    attribution.chargeRunId,
    attribution.chargeRootRunId,
    attribution.chargeParentRunId,
    attribution.chargeLane,
    attribution.chargeSurface,
    attribution.companionId,
    attribution.channelId,
    attribution.shardId,
    attribution.subagentId,
  ];
}

function correlationKey(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function chargeCorrelationKey(entry: RunChargeLedgerEntry, tenantCompanionId: string): string {
  return correlationKey(chargeCorrelationParts(entry, tenantCompanionId));
}

function usageCorrelationKey(event: ModelUsageEvent): string {
  return correlationKey(usageCorrelationParts(event));
}

function compareCharge(left: RunChargeLedgerEntry, right: RunChargeLedgerEntry): number {
  return left.event.timestampMs - right.event.timestampMs || left.eventId.localeCompare(right.eventId);
}

function compareUsage(left: ModelUsageEvent, right: ModelUsageEvent): number {
  return left.recordedAtMs - right.recordedAtMs
    || left.logicalCallId.localeCompare(right.logicalCallId)
    || left.attempt - right.attempt
    || left.id.localeCompare(right.id);
}

function normalizedQuery(input: ReconcileChargeCostsInput): ChargeCostReconciliationQuery {
  const query = input.query ?? {};
  if (query.companionId && query.companionId !== input.tenantCompanionId) {
    throw new Error(`Charge-cost query companion ${JSON.stringify(query.companionId)} is outside the reconciliation tenant`);
  }
  if (query.sinceMs !== undefined && query.untilMs !== undefined && query.sinceMs > query.untilMs) {
    throw new Error('sinceMs must be less than or equal to untilMs');
  }
  return { ...query, companionId: input.tenantCompanionId };
}

function chargeMatchesQuery(entry: RunChargeLedgerEntry, query: ChargeCostReconciliationQuery): boolean {
  const event = entry.event;
  if (query.sinceMs !== undefined && event.timestampMs < query.sinceMs) return false;
  if (query.untilMs !== undefined && event.timestampMs > query.untilMs) return false;
  if (query.lane && event.lane !== query.lane) return false;
  if (query.surface && event.surface !== query.surface) return false;
  if (query.runId && event.lineage.runId !== query.runId) return false;
  if (query.rootRunId && event.lineage.rootRunId !== query.rootRunId) return false;
  if (query.channelId && known(event.channelId) !== query.channelId) return false;
  return true;
}

function usageMatchesQuery(event: ModelUsageEvent, query: ChargeCostReconciliationQuery): boolean {
  const attribution = event.attribution;
  if (query.sinceMs !== undefined && event.recordedAtMs < query.sinceMs) return false;
  if (query.untilMs !== undefined && event.recordedAtMs > query.untilMs) return false;
  if (query.lane && attribution.chargeLane !== query.lane) return false;
  if (query.surface && attribution.chargeSurface !== query.surface) return false;
  if (query.runId && attribution.chargeRunId !== query.runId) return false;
  if (query.rootRunId && attribution.chargeRootRunId !== query.rootRunId) return false;
  if (query.channelId && attribution.channelId !== query.channelId) return false;
  return true;
}

function assertTenant(
  tenantCompanionId: string,
  charges: readonly RunChargeLedgerEntry[],
  usage: readonly ModelUsageEvent[],
): void {
  for (const entry of charges) {
    const companionId = known(entry.event.companionId);
    if (companionId && companionId !== tenantCompanionId) {
      throw new Error(`Charge event ${entry.eventId} is outside the reconciliation tenant`);
    }
  }
  for (const event of usage) {
    if (event.attribution.companionId !== tenantCompanionId) {
      throw new Error(`Model usage event ${event.id} is outside the reconciliation tenant`);
    }
  }
}

function makeInternalGroup(
  chargeEntries: readonly RunChargeLedgerEntry[],
  usageEvents: readonly ModelUsageEvent[],
  options: Pick<InternalGroup, 'exact' | 'forceAmbiguous'> = {},
): InternalGroup {
  return {
    chargeEntries: [...chargeEntries].sort(compareCharge),
    usageEvents: [...usageEvents].sort(compareUsage),
    ...options,
  };
}

function bucketByCorrelation<T>(
  values: readonly T[],
  key: (value: T) => string,
): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const value of values) {
    const bucketKey = key(value);
    const bucket = buckets.get(bucketKey) ?? [];
    bucket.push(value);
    buckets.set(bucketKey, bucket);
  }
  return buckets;
}

function groupDimensions(group: InternalGroup, tenantCompanionId: string): string[] {
  if (group.chargeEntries[0]) return chargeCorrelationParts(group.chargeEntries[0], tenantCompanionId);
  if (group.usageEvents[0]) return usageCorrelationParts(group.usageEvents[0]);
  return Array.from({ length: 9 }, () => MODEL_USAGE_UNKNOWN_DIMENSION);
}

function classifyGroup(group: InternalGroup): {
  disposition: ChargeCostDisposition;
  method: ChargeCostAllocationMethod;
  confidence: ChargeCostGroup['confidence'];
} {
  const chargeCount = group.chargeEntries.length;
  const usageCount = group.usageEvents.length;
  const units = group.chargeEntries.reduce((sum, entry) => sum + entry.event.amount, 0);
  if (chargeCount === 0) {
    return { disposition: 'usage_without_charge', method: 'usage_without_charge', confidence: 'unmatched' };
  }
  if (usageCount === 0) {
    const nonModel = group.chargeEntries.every(entry => !MODEL_BEARING_SURFACE_SET.has(entry.event.surface));
    return nonModel
      ? { disposition: 'non_model_charge', method: 'non_model_charge', confidence: 'not_applicable' }
      : { disposition: 'charged_without_usage', method: 'charged_without_usage', confidence: 'unmatched' };
  }
  if (group.forceAmbiguous || units <= 0) {
    return { disposition: 'ambiguous', method: 'ambiguous_scope_conflict', confidence: 'ambiguous' };
  }
  if (chargeCount > 1 && usageCount > 1) {
    return { disposition: 'ambiguous', method: 'ambiguous_many_to_many', confidence: 'ambiguous' };
  }
  if (group.exact) {
    return {
      disposition: 'attributable',
      method: usageCount === 1 ? 'exact_charge_event' : 'exact_charge_event_even_calls',
      confidence: 'exact',
    };
  }
  if (chargeCount === 1 && usageCount === 1) {
    return { disposition: 'attributable', method: 'lineage_single_charge_single_call', confidence: 'lineage' };
  }
  if (chargeCount === 1) {
    return { disposition: 'attributable', method: 'single_charge_even_calls', confidence: 'lineage' };
  }
  return { disposition: 'attributable', method: 'combined_charges_single_call', confidence: 'lineage' };
}

function finalizeGroup(group: InternalGroup, tenantCompanionId: string): ChargeCostGroup {
  const classification = classifyGroup(group);
  const dimensions = groupDimensions(group, tenantCompanionId);
  const metrics = chargeCostMetricsFor(
    group.chargeEntries,
    group.usageEvents,
    classification.disposition === 'attributable',
  );
  const perCallUnits = classification.disposition === 'attributable' && group.usageEvents.length > 0
    ? roundChargeCost(metrics.chargeUnits / group.usageEvents.length)
    : 0;
  let allocatedUnits = 0;
  const allocations = classification.disposition === 'attributable'
    ? group.usageEvents.map((event, index) => {
        const allocation = index === group.usageEvents.length - 1
          ? roundChargeCost(metrics.chargeUnits - allocatedUnits)
          : perCallUnits;
        allocatedUnits = roundChargeCost(allocatedUnits + allocation);
        return {
          usageEventId: event.id,
          logicalCallId: event.logicalCallId,
          attempt: event.attempt,
          allocatedChargeUnits: allocation,
        };
      })
    : [];
  return {
    disposition: classification.disposition,
    allocationMethod: classification.method,
    confidence: classification.confidence,
    lane: dimensions[3] ?? MODEL_USAGE_UNKNOWN_DIMENSION,
    surface: dimensions[4] ?? MODEL_USAGE_UNKNOWN_DIMENSION,
    runId: dimensions[0] ?? MODEL_USAGE_UNKNOWN_DIMENSION,
    rootRunId: dimensions[1] ?? MODEL_USAGE_UNKNOWN_DIMENSION,
    parentRunId: dimensions[2] ?? MODEL_USAGE_UNKNOWN_DIMENSION,
    companionId: dimensions[5] ?? tenantCompanionId,
    channelId: dimensions[6] ?? MODEL_USAGE_UNKNOWN_DIMENSION,
    shardId: dimensions[7] ?? MODEL_USAGE_UNKNOWN_DIMENSION,
    subagentId: dimensions[8] ?? MODEL_USAGE_UNKNOWN_DIMENSION,
    chargeEventIds: group.chargeEntries.map(entry => entry.eventId),
    usageEventIds: group.usageEvents.map(event => event.id),
    allocations,
    metrics,
  };
}

function addMatchedCorrelationGroups(
  groups: InternalGroup[],
  charges: RunChargeLedgerEntry[],
  usage: ModelUsageEvent[],
  tenantCompanionId: string,
): { charges: RunChargeLedgerEntry[]; usage: ModelUsageEvent[] } {
  const chargeBuckets = bucketByCorrelation(charges, entry => chargeCorrelationKey(entry, tenantCompanionId));
  const usageBuckets = bucketByCorrelation(usage, usageCorrelationKey);
  const consumedChargeIds = new Set<string>();
  const consumedUsageIds = new Set<string>();
  for (const key of [...chargeBuckets.keys()].sort()) {
    const chargeBucket = chargeBuckets.get(key) ?? [];
    const usageBucket = usageBuckets.get(key) ?? [];
    if (usageBucket.length === 0) continue;

    const modelSpecificCharges = chargeBucket.filter(entry => known(entry.metadata?.model));
    const genericCharges = chargeBucket.filter(entry => !known(entry.metadata?.model));
    const modelChargeBuckets = bucketByCorrelation(modelSpecificCharges, entry => correlationKey([
      known(entry.metadata?.provider) ?? '',
      known(entry.metadata?.model) ?? MODEL_USAGE_UNKNOWN_DIMENSION,
    ]));
    const sortedModelChargeBuckets = [...modelChargeBuckets.entries()].sort(([leftKey, left], [rightKey, right]) => {
      const leftHasProvider = known(left[0]?.metadata?.provider) ? 1 : 0;
      const rightHasProvider = known(right[0]?.metadata?.provider) ? 1 : 0;
      return rightHasProvider - leftHasProvider || leftKey.localeCompare(rightKey);
    });
    for (const [, matchingCharges] of sortedModelChargeBuckets) {
      const provider = known(matchingCharges[0]?.metadata?.provider);
      const model = known(matchingCharges[0]?.metadata?.model);
      const matchingUsage = usageBucket.filter(event => (
        known(event.model) === model
        && (!provider || known(event.provider) === provider)
        && !consumedUsageIds.has(event.id)
      ));
      if (matchingUsage.length === 0) continue;
      groups.push(makeInternalGroup(matchingCharges, matchingUsage));
      for (const entry of matchingCharges) consumedChargeIds.add(entry.eventId);
      for (const event of matchingUsage) consumedUsageIds.add(event.id);
    }

    const remainingUsage = usageBucket.filter(event => !consumedUsageIds.has(event.id));
    if (genericCharges.length > 0 && remainingUsage.length > 0) {
      groups.push(makeInternalGroup(genericCharges, remainingUsage));
      for (const entry of genericCharges) consumedChargeIds.add(entry.eventId);
      for (const event of remainingUsage) consumedUsageIds.add(event.id);
    }
  }
  return {
    charges: charges.filter(entry => !consumedChargeIds.has(entry.eventId)),
    usage: usage.filter(event => !consumedUsageIds.has(event.id)),
  };
}

function buildInternalGroups(
  charges: readonly RunChargeLedgerEntry[],
  usage: readonly ModelUsageEvent[],
  tenantCompanionId: string,
): InternalGroup[] {
  const groups: InternalGroup[] = [];
  const chargeByEventId = new Map(charges.map(entry => [entry.eventId, entry]));
  const usageByExactEvent = bucketByCorrelation(
    usage.filter(event => known(event.attribution.chargeEventId)),
    event => event.attribution.chargeEventId,
  );
  const consumedChargeIds = new Set<string>();
  const consumedUsageIds = new Set<string>();

  for (const [eventId, exactUsage] of [...usageByExactEvent.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const charge = chargeByEventId.get(eventId);
    if (!charge) {
      groups.push(makeInternalGroup([], exactUsage));
      for (const event of exactUsage) consumedUsageIds.add(event.id);
      continue;
    }
    const scopeConflict = exactUsage.some(event => (
      chargeCorrelationKey(charge, tenantCompanionId) !== usageCorrelationKey(event)
      || !MODEL_BEARING_SURFACE_SET.has(charge.event.surface)
    ));
    groups.push(makeInternalGroup([charge], exactUsage, { exact: true, forceAmbiguous: scopeConflict }));
    consumedChargeIds.add(charge.eventId);
    for (const event of exactUsage) consumedUsageIds.add(event.id);
  }

  const remainingCharges = charges.filter(entry => !consumedChargeIds.has(entry.eventId));
  const nonModelCharges = remainingCharges.filter(entry => !MODEL_BEARING_SURFACE_SET.has(entry.event.surface));
  for (const bucket of bucketByCorrelation(
    nonModelCharges,
    entry => chargeCorrelationKey(entry, tenantCompanionId),
  ).values()) {
    groups.push(makeInternalGroup(bucket, []));
  }

  const modelCharges = remainingCharges.filter(entry => MODEL_BEARING_SURFACE_SET.has(entry.event.surface));
  const remainingUsage = usage.filter(event => !consumedUsageIds.has(event.id));
  const correlated = addMatchedCorrelationGroups(groups, modelCharges, remainingUsage, tenantCompanionId);
  for (const bucket of bucketByCorrelation(
    correlated.charges,
    entry => chargeCorrelationKey(entry, tenantCompanionId),
  ).values()) {
    groups.push(makeInternalGroup(bucket, []));
  }
  for (const bucket of bucketByCorrelation(correlated.usage, usageCorrelationKey).values()) {
    groups.push(makeInternalGroup([], bucket));
  }
  return groups;
}

function bucketMetrics(groups: readonly ChargeCostGroup[], disposition: ChargeCostDisposition): ChargeCostMetrics {
  const metrics = emptyChargeCostMetrics();
  for (const group of groups) {
    if (group.disposition === disposition) addChargeCostMetrics(metrics, group.metrics);
  }
  return finalizeChargeCostMetrics(metrics, disposition === 'attributable');
}

function coveragePercent(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 100;
}

function createLedgerReconciliation(
  sourceTotals: ChargeCostMetrics,
  buckets: readonly ChargeCostMetrics[],
): ChargeCostLedgerReconciliation {
  const classified = emptyChargeCostMetrics();
  for (const bucket of buckets) addChargeCostMetrics(classified, bucket);
  return {
    charge: {
      sourceUnits: sourceTotals.chargeUnits,
      classifiedUnits: classified.chargeUnits,
      sourceEvents: sourceTotals.chargeEvents,
      classifiedEvents: classified.chargeEvents,
      reconciled: sourceTotals.chargeUnits === classified.chargeUnits
        && sourceTotals.chargeEvents === classified.chargeEvents,
    },
    usage: {
      sourceCalls: sourceTotals.calls,
      classifiedCalls: classified.calls,
      sourceTotalTokens: sourceTotals.totalTokens,
      classifiedTotalTokens: classified.totalTokens,
      sourceProviderCostUsd: sourceTotals.providerCostUsd,
      classifiedProviderCostUsd: classified.providerCostUsd,
      sourceEstimatedCostUsd: sourceTotals.estimatedCostUsd,
      classifiedEstimatedCostUsd: classified.estimatedCostUsd,
      sourceEffectiveCostUsd: sourceTotals.effectiveCostUsd,
      classifiedEffectiveCostUsd: classified.effectiveCostUsd,
      reconciled: sourceTotals.calls === classified.calls
        && sourceTotals.totalTokens === classified.totalTokens
        && sourceTotals.providerCostUsd === classified.providerCostUsd
        && sourceTotals.estimatedCostUsd === classified.estimatedCostUsd
        && sourceTotals.effectiveCostUsd === classified.effectiveCostUsd,
    },
  };
}

export function reconcileChargeCosts(input: ReconcileChargeCostsInput): ChargeCostReconciliationData {
  const tenantCompanionId = input.tenantCompanionId.trim();
  if (!tenantCompanionId) throw new Error('tenantCompanionId must be non-empty');
  const query = normalizedQuery({ ...input, tenantCompanionId });
  const chargeEntries = input.chargeEntries.filter(entry => chargeMatchesQuery(entry, query));
  const usageEvents = input.usageEvents.filter(event => usageMatchesQuery(event, query));
  assertTenant(tenantCompanionId, chargeEntries, usageEvents);

  const internalGroups = buildInternalGroups(chargeEntries, usageEvents, tenantCompanionId);
  const groups = internalGroups
    .map(group => finalizeGroup(group, tenantCompanionId))
    .sort((left, right) => (
      left.rootRunId.localeCompare(right.rootRunId)
      || left.runId.localeCompare(right.runId)
      || left.surface.localeCompare(right.surface)
      || left.disposition.localeCompare(right.disposition)
      || (left.chargeEventIds[0] ?? '').localeCompare(right.chargeEventIds[0] ?? '')
      || (left.usageEventIds[0] ?? '').localeCompare(right.usageEventIds[0] ?? '')
    ));

  const sourceTotals = chargeCostMetricsFor(chargeEntries, usageEvents, false);
  const buckets = {
    attributable: bucketMetrics(groups, 'attributable'),
    chargedWithoutUsage: bucketMetrics(groups, 'charged_without_usage'),
    usageWithoutCharge: bucketMetrics(groups, 'usage_without_charge'),
    ambiguous: bucketMetrics(groups, 'ambiguous'),
    nonModelCharges: bucketMetrics(groups, 'non_model_charge'),
  };
  const ledgerReconciliation = createLedgerReconciliation(sourceTotals, Object.values(buckets));
  return {
    query,
    sourceTotals,
    buckets,
    coverage: {
      charge: {
        totalUnits: sourceTotals.chargeUnits,
        attributableUnits: buckets.attributable.chargeUnits,
        coveragePercent: coveragePercent(buckets.attributable.chargeUnits, sourceTotals.chargeUnits),
      },
      usage: {
        totalCalls: sourceTotals.calls,
        attributableCalls: buckets.attributable.calls,
        coveragePercent: coveragePercent(buckets.attributable.calls, sourceTotals.calls),
      },
    },
    ledgerReconciliation,
    breakdowns: createChargeCostBreakdowns(groups, new Map(usageEvents.map(event => [event.id, event]))),
    groups,
  };
}
