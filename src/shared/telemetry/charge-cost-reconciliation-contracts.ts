import type {
  ChargePolicyRuntimeLane,
  ChargePolicySurface,
} from '../contracts/charge-policy.js';
import type { RunChargeLedgerEntry } from './charge-ledger.js';
import type { ModelUsageEvent } from './model-usage.js';

export const MODEL_BEARING_CHARGE_SURFACES = [
  'localImageGeneration',
  'paidImageGeneration',
  'analysisWorkbenchExtensionBand',
  'externalModelConsult',
] as const satisfies readonly ChargePolicySurface[];

export type ChargeCostDisposition =
  | 'attributable'
  | 'charged_without_usage'
  | 'usage_without_charge'
  | 'ambiguous'
  | 'non_model_charge';

export type ChargeCostAllocationMethod =
  | 'exact_charge_event'
  | 'exact_charge_event_even_calls'
  | 'lineage_single_charge_single_call'
  | 'single_charge_even_calls'
  | 'combined_charges_single_call'
  | 'ambiguous_many_to_many'
  | 'ambiguous_scope_conflict'
  | 'charged_without_usage'
  | 'usage_without_charge'
  | 'non_model_charge';

export interface ChargeCostMetrics {
  chargeUnits: number;
  chargeEvents: number;
  calls: number;
  successfulCalls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  providerCostUsd: number;
  estimatedCostUsd: number;
  effectiveCostUsd: number;
  unknownCostCalls: number;
  dollarsPerChargeUnit: number | null;
}

export interface ChargeCostBreakdown extends ChargeCostMetrics {
  key: string;
}

export interface ChargeCostAllocation {
  usageEventId: string;
  logicalCallId: string;
  attempt: number;
  allocatedChargeUnits: number;
}

export interface ChargeCostGroup {
  disposition: ChargeCostDisposition;
  allocationMethod: ChargeCostAllocationMethod;
  confidence: 'exact' | 'lineage' | 'ambiguous' | 'unmatched' | 'not_applicable';
  lane: string;
  surface: string;
  runId: string;
  rootRunId: string;
  parentRunId: string;
  companionId: string;
  channelId: string;
  shardId: string;
  subagentId: string;
  chargeEventIds: string[];
  usageEventIds: string[];
  allocations: ChargeCostAllocation[];
  metrics: ChargeCostMetrics;
}

export interface ChargeCostReconciliationQuery {
  sinceMs?: number;
  untilMs?: number;
  companionId?: string;
  channelId?: string;
  lane?: ChargePolicyRuntimeLane;
  surface?: ChargePolicySurface;
  runId?: string;
  rootRunId?: string;
}

export interface ChargeCostLedgerReconciliation {
  charge: {
    sourceUnits: number;
    classifiedUnits: number;
    sourceEvents: number;
    classifiedEvents: number;
    reconciled: boolean;
  };
  usage: {
    sourceCalls: number;
    classifiedCalls: number;
    sourceTotalTokens: number;
    classifiedTotalTokens: number;
    sourceProviderCostUsd: number;
    classifiedProviderCostUsd: number;
    sourceEstimatedCostUsd: number;
    classifiedEstimatedCostUsd: number;
    sourceEffectiveCostUsd: number;
    classifiedEffectiveCostUsd: number;
    reconciled: boolean;
  };
}

export interface ChargeCostReconciliationData {
  query: ChargeCostReconciliationQuery;
  sourceTotals: ChargeCostMetrics;
  buckets: {
    attributable: ChargeCostMetrics;
    chargedWithoutUsage: ChargeCostMetrics;
    usageWithoutCharge: ChargeCostMetrics;
    ambiguous: ChargeCostMetrics;
    nonModelCharges: ChargeCostMetrics;
  };
  coverage: {
    charge: { totalUnits: number; attributableUnits: number; coveragePercent: number };
    usage: { totalCalls: number; attributableCalls: number; coveragePercent: number };
  };
  ledgerReconciliation: ChargeCostLedgerReconciliation;
  breakdowns: {
    byLane: ChargeCostBreakdown[];
    bySurface: ChargeCostBreakdown[];
    byRun: ChargeCostBreakdown[];
    byRootRun: ChargeCostBreakdown[];
    byCompanion: ChargeCostBreakdown[];
    byModel: ChargeCostBreakdown[];
    byChannel: ChargeCostBreakdown[];
    byDay: ChargeCostBreakdown[];
  };
  groups: ChargeCostGroup[];
}

export interface ReconcileChargeCostsInput {
  tenantCompanionId: string;
  chargeEntries: readonly RunChargeLedgerEntry[];
  usageEvents: readonly ModelUsageEvent[];
  query?: ChargeCostReconciliationQuery;
}
