import type { RunChargeLedgerEntry } from './charge-ledger.js';
import type { ModelUsageEvent } from './model-usage.js';
import { roundModelUsageUsd } from './model-usage-accounting.js';
import type {
  ChargeCostAllocation,
  ChargeCostBreakdown,
  ChargeCostGroup,
  ChargeCostMetrics,
  ChargeCostReconciliationData,
} from './charge-cost-reconciliation-contracts.js';

export interface MutableChargeCostMetrics extends Omit<ChargeCostMetrics, 'dollarsPerChargeUnit'> {}

interface InternalAllocation extends ChargeCostAllocation {
  allocatedChargeEvents: number;
  usage: ModelUsageEvent;
  group: ChargeCostGroup;
}

export function emptyChargeCostMetrics(): MutableChargeCostMetrics {
  return {
    chargeUnits: 0,
    chargeEvents: 0,
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
    effectiveCostUsd: 0,
    unknownCostCalls: 0,
  };
}

export function roundChargeCost(value: number): number {
  return roundModelUsageUsd(value);
}

function addCharge(target: MutableChargeCostMetrics, entry: RunChargeLedgerEntry): void {
  target.chargeUnits = roundChargeCost(target.chargeUnits + entry.event.amount);
  target.chargeEvents += 1;
}

function eventCost(
  event: ModelUsageEvent,
  field: 'providerCostUsd' | 'estimatedCostUsd' | 'effectiveCostUsd',
): number {
  const value = event[field];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function addUsageToChargeCostMetrics(
  target: MutableChargeCostMetrics,
  event: ModelUsageEvent,
): void {
  target.calls += 1;
  if (event.status === 'success') target.successfulCalls += 1;
  else target.failedCalls += 1;
  target.inputTokens += event.inputTokens;
  target.outputTokens += event.outputTokens;
  target.cacheReadTokens += event.cacheReadTokens;
  target.cacheWriteTokens += event.cacheWriteTokens;
  target.totalTokens += event.totalTokens;
  target.providerCostUsd = roundChargeCost(target.providerCostUsd + eventCost(event, 'providerCostUsd'));
  target.estimatedCostUsd = roundChargeCost(target.estimatedCostUsd + eventCost(event, 'estimatedCostUsd'));
  target.effectiveCostUsd = roundChargeCost(target.effectiveCostUsd + eventCost(event, 'effectiveCostUsd'));
  if (event.costSource === 'none') target.unknownCostCalls += 1;
}

export function addChargeCostMetrics(
  target: MutableChargeCostMetrics,
  source: ChargeCostMetrics,
): void {
  target.chargeUnits = roundChargeCost(target.chargeUnits + source.chargeUnits);
  target.chargeEvents = roundChargeCost(target.chargeEvents + source.chargeEvents);
  target.calls += source.calls;
  target.successfulCalls += source.successfulCalls;
  target.failedCalls += source.failedCalls;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.totalTokens += source.totalTokens;
  target.providerCostUsd = roundChargeCost(target.providerCostUsd + source.providerCostUsd);
  target.estimatedCostUsd = roundChargeCost(target.estimatedCostUsd + source.estimatedCostUsd);
  target.effectiveCostUsd = roundChargeCost(target.effectiveCostUsd + source.effectiveCostUsd);
  target.unknownCostCalls += source.unknownCostCalls;
}

export function finalizeChargeCostMetrics(
  metrics: MutableChargeCostMetrics,
  attributable: boolean,
): ChargeCostMetrics {
  return {
    ...metrics,
    dollarsPerChargeUnit: attributable && metrics.calls > 0 && metrics.chargeUnits > 0
      ? roundChargeCost(metrics.effectiveCostUsd / metrics.chargeUnits)
      : null,
  };
}

export function chargeCostMetricsFor(
  chargeEntries: readonly RunChargeLedgerEntry[],
  usageEvents: readonly ModelUsageEvent[],
  attributable: boolean,
): ChargeCostMetrics {
  const metrics = emptyChargeCostMetrics();
  for (const entry of chargeEntries) addCharge(metrics, entry);
  for (const event of usageEvents) addUsageToChargeCostMetrics(metrics, event);
  return finalizeChargeCostMetrics(metrics, attributable);
}

export function createChargeCostBreakdowns(
  groups: readonly ChargeCostGroup[],
  usageById: ReadonlyMap<string, ModelUsageEvent>,
): ChargeCostReconciliationData['breakdowns'] {
  const allocations: InternalAllocation[] = [];
  for (const group of groups) {
    if (group.disposition !== 'attributable') continue;
    const allocatedChargeEvents = group.metrics.chargeEvents / Math.max(1, group.allocations.length);
    for (const allocation of group.allocations) {
      const usage = usageById.get(allocation.usageEventId);
      if (!usage) throw new Error(`Missing usage event ${allocation.usageEventId} while building reconciliation breakdowns`);
      allocations.push({ ...allocation, allocatedChargeEvents, usage, group });
    }
  }

  const breakdown = (keyFor: (allocation: InternalAllocation) => string): ChargeCostBreakdown[] => {
    const byKey = new Map<string, MutableChargeCostMetrics>();
    for (const allocation of allocations) {
      const key = keyFor(allocation);
      const metrics = byKey.get(key) ?? emptyChargeCostMetrics();
      metrics.chargeUnits = roundChargeCost(metrics.chargeUnits + allocation.allocatedChargeUnits);
      metrics.chargeEvents = roundChargeCost(metrics.chargeEvents + allocation.allocatedChargeEvents);
      addUsageToChargeCostMetrics(metrics, allocation.usage);
      byKey.set(key, metrics);
    }
    return [...byKey.entries()]
      .map(([key, metrics]) => ({ key, ...finalizeChargeCostMetrics(metrics, true) }))
      .sort((left, right) => (
        right.effectiveCostUsd - left.effectiveCostUsd
        || right.chargeUnits - left.chargeUnits
        || left.key.localeCompare(right.key)
      ));
  };

  return {
    byLane: breakdown(allocation => allocation.group.lane),
    bySurface: breakdown(allocation => allocation.group.surface),
    byRun: breakdown(allocation => allocation.group.runId),
    byRootRun: breakdown(allocation => allocation.group.rootRunId),
    byCompanion: breakdown(allocation => allocation.usage.attribution.companionId),
    byModel: breakdown(allocation => `${allocation.usage.provider}:${allocation.usage.model}`),
    byChannel: breakdown(allocation => allocation.usage.attribution.channelId),
    byDay: breakdown(allocation => new Date(allocation.usage.recordedAtMs).toISOString().slice(0, 10)),
  };
}
