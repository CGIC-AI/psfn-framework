import { describe, expect, it } from 'vitest';
import type { RunChargeEvent } from '../contracts/runtime.js';
import type { RunChargeLedgerEntry } from './charge-ledger.js';
import type { ModelUsageEvent } from './model-usage.js';
import { normalizeModelUsageAttribution } from './model-usage-attribution.js';
import { reconcileChargeCosts } from './charge-cost-reconciliation.js';

const BASE_TIME_MS = Date.UTC(2026, 6, 14, 12, 0, 0);

function chargeEntry(overrides: Partial<RunChargeEvent> = {}): RunChargeLedgerEntry {
  const event: RunChargeEvent = {
    eventId: 'charge-1',
    timestampMs: BASE_TIME_MS,
    lane: 'interactive',
    surface: 'externalModelConsult',
    amount: 4,
    quota: 20,
    spentAfter: 4,
    remainingAfter: 16,
    lineage: { runId: 'run-1', rootRunId: 'root-1' },
    companionId: 'companion-a',
    channelId: 'channel-a',
    callType: 'chat',
    purpose: 'test',
    ...overrides,
  };
  return {
    schemaVersion: 1,
    recordType: 'charge_event',
    eventId: event.eventId,
    recordedAtMs: event.timestampMs,
    event,
  };
}

function usageEvent(overrides: {
  id?: string;
  logicalCallId?: string;
  attempt?: number;
  recordedAtMs?: number;
  status?: 'success' | 'failure';
  chargeEventId?: string;
  chargeRunId?: string;
  chargeRootRunId?: string;
  chargeParentRunId?: string;
  chargeLane?: 'interactive' | 'background' | 'maintenance' | 'subagent' | 'shard';
  chargeSurface?: 'externalModelConsult' | 'paidImageGeneration';
  companionId?: string;
  channelId?: string;
  shardId?: string;
  subagentId?: string;
  provider?: string;
  model?: string;
  providerCostUsd?: number;
  estimatedCostUsd?: number;
  effectiveCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
} = {}): ModelUsageEvent {
  const inputTokens = overrides.inputTokens ?? 10;
  const outputTokens = overrides.outputTokens ?? 5;
  const providerCostUsd = overrides.providerCostUsd;
  const estimatedCostUsd = overrides.estimatedCostUsd;
  const effectiveCostUsd = overrides.effectiveCostUsd;
  return {
    id: overrides.id ?? 'usage-1',
    logicalCallId: overrides.logicalCallId ?? 'logical-1',
    attempt: overrides.attempt ?? 1,
    recordedAtMs: overrides.recordedAtMs ?? BASE_TIME_MS + 100,
    startedAtMs: (overrides.recordedAtMs ?? BASE_TIME_MS + 100) - 50,
    dayKey: '2026-07-14',
    monthKey: '2026-07',
    status: overrides.status ?? 'success',
    settlement: 'complete',
    callKind: 'chat',
    attribution: normalizeModelUsageAttribution({
      companionId: overrides.companionId ?? 'companion-a',
      channelId: overrides.channelId ?? 'channel-a',
      callType: 'chat',
      purpose: 'test',
      chargeEventId: overrides.chargeEventId,
      chargeLane: overrides.chargeLane ?? 'interactive',
      chargeSurface: overrides.chargeSurface ?? 'externalModelConsult',
      chargeRunId: overrides.chargeRunId ?? 'run-1',
      chargeRootRunId: overrides.chargeRootRunId ?? 'root-1',
      chargeParentRunId: overrides.chargeParentRunId,
      shardId: overrides.shardId,
      subagentId: overrides.subagentId,
    }),
    provider: overrides.provider ?? 'provider-a',
    model: overrides.model ?? 'model-a',
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: inputTokens + outputTokens,
    ...(providerCostUsd !== undefined ? { providerCostUsd } : {}),
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
    ...(effectiveCostUsd !== undefined ? { effectiveCostUsd } : {}),
    providerCost: providerCostUsd === undefined ? {} : { total: providerCostUsd, currency: 'USD' },
    estimatedCost: estimatedCostUsd === undefined ? {} : { total: estimatedCostUsd, currency: 'USD' },
    effectiveCost: effectiveCostUsd === undefined ? {} : { total: effectiveCostUsd, currency: 'USD' },
    costSource: providerCostUsd !== undefined ? 'provider' : (estimatedCostUsd !== undefined ? 'estimate' : 'none'),
    metadata: {},
  };
}

describe('reconcileChargeCosts', () => {
  it('attributes one exact charge across physical retry attempts without duplicating units', () => {
    const data = reconcileChargeCosts({
      tenantCompanionId: 'companion-a',
      chargeEntries: [chargeEntry()],
      usageEvents: [
        usageEvent({
          id: 'usage-1', logicalCallId: 'logical-1', attempt: 1, status: 'failure',
          chargeEventId: 'charge-1', providerCostUsd: 0.1, estimatedCostUsd: 0.15,
          effectiveCostUsd: 0.1,
        }),
        usageEvent({
          id: 'usage-2', logicalCallId: 'logical-1', attempt: 2,
          chargeEventId: 'charge-1', providerCostUsd: 0.2, estimatedCostUsd: 0.25,
          effectiveCostUsd: 0.2,
        }),
      ],
    });

    expect(data.sourceTotals).toMatchObject({
      chargeUnits: 4,
      chargeEvents: 1,
      calls: 2,
      failedCalls: 1,
      providerCostUsd: 0.3,
      estimatedCostUsd: 0.4,
      effectiveCostUsd: 0.3,
    });
    expect(data.buckets.attributable).toMatchObject({
      chargeUnits: 4,
      chargeEvents: 1,
      calls: 2,
      dollarsPerChargeUnit: 0.075,
    });
    expect(data.groups).toHaveLength(1);
    expect(data.groups[0]).toMatchObject({
      disposition: 'attributable',
      allocationMethod: 'exact_charge_event_even_calls',
      confidence: 'exact',
    });
    expect(data.groups[0]?.allocations).toEqual([
      { usageEventId: 'usage-1', logicalCallId: 'logical-1', attempt: 1, allocatedChargeUnits: 2 },
      { usageEventId: 'usage-2', logicalCallId: 'logical-1', attempt: 2, allocatedChargeUnits: 2 },
    ]);
    expect(data.breakdowns.byLane[0]).toMatchObject({
      key: 'interactive', chargeUnits: 4, calls: 2, effectiveCostUsd: 0.3,
    });
    expect(data.breakdowns.byModel[0]).toMatchObject({
      key: 'provider-a:model-a', chargeUnits: 4, calls: 2, effectiveCostUsd: 0.3,
    });
  });

  it('conserves both source ledgers across non-model, unmatched, and ambiguous buckets', () => {
    const data = reconcileChargeCosts({
      tenantCompanionId: 'companion-a',
      chargeEntries: [
        chargeEntry({ eventId: 'non-model', surface: 'memoryRead', amount: 2 }),
        chargeEntry({ eventId: 'charged-only', amount: 3 }),
        chargeEntry({ eventId: 'ambiguous-a', amount: 4, lineage: { runId: 'run-many', rootRunId: 'root-many' } }),
        chargeEntry({ eventId: 'ambiguous-b', amount: 6, lineage: { runId: 'run-many', rootRunId: 'root-many' } }),
      ],
      usageEvents: [
        usageEvent({
          id: 'usage-only', chargeEventId: 'missing-charge', chargeRunId: 'run-missing',
          chargeRootRunId: 'root-missing', providerCostUsd: 1, effectiveCostUsd: 1,
        }),
        usageEvent({
          id: 'many-1', logicalCallId: 'many-1', chargeRunId: 'run-many', chargeRootRunId: 'root-many',
          providerCostUsd: 2, effectiveCostUsd: 2,
        }),
        usageEvent({
          id: 'many-2', logicalCallId: 'many-2', chargeRunId: 'run-many', chargeRootRunId: 'root-many',
          providerCostUsd: 3, effectiveCostUsd: 3,
        }),
      ],
    });

    expect(data.sourceTotals).toMatchObject({
      chargeUnits: 15,
      chargeEvents: 4,
      calls: 3,
      providerCostUsd: 6,
      effectiveCostUsd: 6,
    });
    expect(data.buckets.nonModelCharges).toMatchObject({ chargeUnits: 2, chargeEvents: 1, calls: 0 });
    expect(data.buckets.chargedWithoutUsage).toMatchObject({ chargeUnits: 3, chargeEvents: 1, calls: 0 });
    expect(data.buckets.usageWithoutCharge).toMatchObject({ chargeUnits: 0, chargeEvents: 0, calls: 1, effectiveCostUsd: 1 });
    expect(data.buckets.ambiguous).toMatchObject({ chargeUnits: 10, chargeEvents: 2, calls: 2, effectiveCostUsd: 5 });
    expect(data.buckets.attributable.dollarsPerChargeUnit).toBeNull();
    expect(data.buckets.ambiguous.dollarsPerChargeUnit).toBeNull();
    expect(data.coverage).toEqual({
      charge: { totalUnits: 15, attributableUnits: 0, coveragePercent: 0 },
      usage: { totalCalls: 3, attributableCalls: 0, coveragePercent: 0 },
    });

    const classifiedChargeUnits = Object.values(data.buckets)
      .reduce((sum, bucket) => sum + bucket.chargeUnits, 0);
    const classifiedCalls = Object.values(data.buckets)
      .reduce((sum, bucket) => sum + bucket.calls, 0);
    const classifiedEffectiveCost = Object.values(data.buckets)
      .reduce((sum, bucket) => sum + bucket.effectiveCostUsd, 0);
    expect(classifiedChargeUnits).toBe(data.sourceTotals.chargeUnits);
    expect(classifiedCalls).toBe(data.sourceTotals.calls);
    expect(classifiedEffectiveCost).toBe(data.sourceTotals.effectiveCostUsd);
    expect(data.ledgerReconciliation).toEqual({
      charge: {
        sourceUnits: 15,
        classifiedUnits: 15,
        sourceEvents: 4,
        classifiedEvents: 4,
        reconciled: true,
      },
      usage: {
        sourceCalls: 3,
        classifiedCalls: 3,
        sourceTotalTokens: 45,
        classifiedTotalTokens: 45,
        sourceProviderCostUsd: 6,
        classifiedProviderCostUsd: 6,
        sourceEstimatedCostUsd: 0,
        classifiedEstimatedCostUsd: 0,
        sourceEffectiveCostUsd: 6,
        classifiedEffectiveCostUsd: 6,
        reconciled: true,
      },
    });
  });

  it('uses model metadata to disambiguate lineage charges even when provider metadata is absent', () => {
    const modeledCharge = {
      ...chargeEntry({ eventId: 'modeled-charge' }),
      metadata: { model: 'model-a' },
    };
    const data = reconcileChargeCosts({
      tenantCompanionId: 'companion-a',
      chargeEntries: [modeledCharge],
      usageEvents: [usageEvent({ id: 'modeled-usage', providerCostUsd: 1, effectiveCostUsd: 1 })],
    });

    expect(data.buckets.attributable).toMatchObject({ chargeUnits: 4, calls: 1 });
    expect(data.buckets.chargedWithoutUsage.chargeUnits).toBe(0);
  });

  it('matches nested shard lineages independently and allocates fallback units deterministically', () => {
    const data = reconcileChargeCosts({
      tenantCompanionId: 'companion-a',
      chargeEntries: [
        chargeEntry({
          eventId: 'shard-a-charge', amount: 6, lane: 'shard',
          lineage: { runId: 'shard-run-a', rootRunId: 'root-shards', parentRunId: 'root-shards' },
          shardId: 'shard-a',
        }),
        chargeEntry({
          eventId: 'shard-b-charge', amount: 8, lane: 'shard',
          lineage: { runId: 'shard-run-b', rootRunId: 'root-shards', parentRunId: 'root-shards' },
          shardId: 'shard-b',
        }),
      ],
      usageEvents: [
        usageEvent({
          id: 'shard-a-1', logicalCallId: 'shard-a-1', chargeRunId: 'shard-run-a',
          chargeRootRunId: 'root-shards', chargeParentRunId: 'root-shards', chargeLane: 'shard',
          shardId: 'shard-a', providerCostUsd: 1, effectiveCostUsd: 1,
        }),
        usageEvent({
          id: 'shard-a-2', logicalCallId: 'shard-a-2', chargeRunId: 'shard-run-a',
          chargeRootRunId: 'root-shards', chargeParentRunId: 'root-shards', chargeLane: 'shard',
          shardId: 'shard-a', providerCostUsd: 2, effectiveCostUsd: 2,
        }),
      ],
    });

    expect(data.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        disposition: 'attributable',
        allocationMethod: 'single_charge_even_calls',
        chargeEventIds: ['shard-a-charge'],
        allocations: [
          { usageEventId: 'shard-a-1', logicalCallId: 'shard-a-1', attempt: 1, allocatedChargeUnits: 3 },
          { usageEventId: 'shard-a-2', logicalCallId: 'shard-a-2', attempt: 1, allocatedChargeUnits: 3 },
        ],
      }),
      expect.objectContaining({
        disposition: 'charged_without_usage',
        chargeEventIds: ['shard-b-charge'],
      }),
    ]));
    expect(data.buckets.attributable).toMatchObject({ chargeUnits: 6, calls: 2, effectiveCostUsd: 3 });
    expect(data.buckets.chargedWithoutUsage).toMatchObject({ chargeUnits: 8, calls: 0, effectiveCostUsd: 0 });
    expect(data.breakdowns.byRootRun[0]).toMatchObject({ key: 'root-shards', chargeUnits: 6, calls: 2 });
  });

  it('fails closed when a source event crosses the Garden tenant boundary', () => {
    expect(() => reconcileChargeCosts({
      tenantCompanionId: 'companion-a',
      chargeEntries: [chargeEntry({ companionId: 'companion-b' })],
      usageEvents: [],
    })).toThrow('outside the reconciliation tenant');

    expect(() => reconcileChargeCosts({
      tenantCompanionId: 'companion-a',
      chargeEntries: [],
      usageEvents: [usageEvent({ companionId: 'companion-b' })],
    })).toThrow('outside the reconciliation tenant');
  });
});
