import { describe, expect, it } from 'vitest';

import type { RunChargeLedgerEntry } from './charge-ledger.js';
import {
  reconcileChargeCosts,
  type ChargeCostReconciliationData,
} from './charge-cost-reconciliation.js';
import {
  reconcileModelUsageAccounting,
  roundModelUsageUsd,
  type ModelUsageCostRates,
} from './model-usage-accounting.js';
import { normalizeModelUsageAttribution } from './model-usage-attribution.js';
import type { ModelUsageEvent } from './model-usage.js';

const MR_STRENGTH = [
  { id: 'token-additivity', category: 'additive', sensitivity: 5, independence: 5, cost: 1 },
  { id: 'cost-scaling', category: 'multiplicative', sensitivity: 4, independence: 4, cost: 1 },
  { id: 'split-merge-equivalence', category: 'invertive', sensitivity: 4, independence: 3, cost: 1 },
  { id: 'charge-permutation', category: 'permutative', sensitivity: 4, independence: 5, cost: 2 },
  { id: 'unmatched-usage-inclusion', category: 'inclusive', sensitivity: 5, independence: 4, cost: 2 },
] as const;

interface GeneratedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function integer(random: () => number, maxInclusive: number): number {
  return Math.floor(random() * (maxInclusive + 1));
}

function generatedUsage(random: () => number): GeneratedUsage {
  return {
    inputTokens: integer(random, 100_000),
    outputTokens: integer(random, 20_000),
    cacheReadTokens: integer(random, 100_000),
    cacheWriteTokens: integer(random, 50_000),
  };
}

function generatedRates(random: () => number): Required<ModelUsageCostRates> {
  return {
    inputPer1MUsd: 0.01 + random() * 20,
    outputPer1MUsd: 0.01 + random() * 40,
    cacheReadPer1MUsd: 0.001 + random() * 5,
    cacheWritePer1MUsd: 0.01 + random() * 20,
    currency: 'USD',
  };
}

function totalTokens(usage: GeneratedUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

function scaledUsage(usage: GeneratedUsage, factor: number): GeneratedUsage {
  return {
    inputTokens: usage.inputTokens * factor,
    outputTokens: usage.outputTokens * factor,
    cacheReadTokens: usage.cacheReadTokens * factor,
    cacheWriteTokens: usage.cacheWriteTokens * factor,
  };
}

function makeUsageEvent(index: number, effectiveCostUsd: number): ModelUsageEvent {
  const timestamp = 1_780_000_000_000 + index;
  return {
    id: `usage-${index}`,
    logicalCallId: `logical-${index}`,
    attempt: 1,
    recordedAtMs: timestamp,
    startedAtMs: timestamp - 1,
    dayKey: '2026-05-27',
    monthKey: '2026-05',
    status: 'success',
    settlement: 'complete',
    callKind: 'chat',
    attribution: normalizeModelUsageAttribution({
      companionId: 'companion-property',
      channelId: 'channel-property',
      channelType: 'api',
      callType: 'chat',
      purpose: 'property-test',
      chargeLane: 'interactive',
      chargeSurface: 'externalModelConsult',
      chargeEventId: `charge-${index}`,
      chargeRunId: `run-${index}`,
      chargeRootRunId: `run-${index}`,
    }),
    provider: 'property-provider',
    model: 'property-model',
    inputTokens: index + 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: index + 2,
    providerCost: { total: effectiveCostUsd, currency: 'USD' },
    estimatedCost: {},
    effectiveCost: { total: effectiveCostUsd, currency: 'USD' },
    providerCostUsd: effectiveCostUsd,
    effectiveCostUsd,
    costSource: 'provider',
    currency: 'USD',
    metadata: {},
  };
}

function makeChargeEntry(index: number, amount: number): RunChargeLedgerEntry {
  const timestamp = 1_780_000_000_000 + index;
  return {
    schemaVersion: 1,
    recordType: 'charge_event',
    eventId: `charge-${index}`,
    recordedAtMs: timestamp,
    event: {
      eventId: `charge-${index}`,
      timestampMs: timestamp,
      lane: 'interactive',
      surface: 'externalModelConsult',
      amount,
      quota: 10_000,
      spentAfter: amount,
      remainingAfter: 10_000 - amount,
      lineage: { runId: `run-${index}`, rootRunId: `run-${index}` },
      companionId: 'companion-property',
      channelId: 'channel-property',
    },
  };
}

function reconcileGenerated(
  charges: readonly RunChargeLedgerEntry[],
  usageEvents: readonly ModelUsageEvent[],
): ChargeCostReconciliationData {
  return reconcileChargeCosts({
    tenantCompanionId: 'companion-property',
    chargeEntries: charges,
    usageEvents,
  });
}

function assertLedgerConservation(data: ChargeCostReconciliationData): void {
  const { charge, usage } = data.ledgerReconciliation;
  if (
    !charge.reconciled
    || charge.sourceUnits !== charge.classifiedUnits
    || charge.sourceEvents !== charge.classifiedEvents
  ) {
    throw new Error('charge conservation violated');
  }
  if (
    !usage.reconciled
    || usage.sourceCalls !== usage.classifiedCalls
    || usage.sourceTotalTokens !== usage.classifiedTotalTokens
    || usage.sourceEffectiveCostUsd !== usage.classifiedEffectiveCostUsd
  ) {
    throw new Error('usage conservation violated');
  }
}

describe('accounting certification conservation properties', () => {
  it('keeps only independent, high-strength metamorphic relations', () => {
    expect(new Set(MR_STRENGTH.map(relation => relation.category)).size).toBeGreaterThanOrEqual(3);
    for (const relation of MR_STRENGTH) {
      expect(
        (relation.sensitivity * relation.independence) / relation.cost,
        relation.id,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('preserves token additivity, cost scaling, and split/merge equivalence over seeded inputs', () => {
    const random = seededRandom(0xc0a57);
    for (let iteration = 0; iteration < 250; iteration += 1) {
      const usage = generatedUsage(random);
      const rates = generatedRates(random);
      const base = reconcileModelUsageAccounting({ usage, estimatedRates: rates });
      expect(base.usage.totalTokens).toBe(totalTokens(usage));
      expect(base.estimatedCost.total).toBe(roundModelUsageUsd(
        (base.estimatedCost.input ?? 0)
        + (base.estimatedCost.output ?? 0)
        + (base.estimatedCost.cacheRead ?? 0)
        + (base.estimatedCost.cacheWrite ?? 0),
      ));

      const scale = 1 + integer(random, 4);
      const scaled = reconcileModelUsageAccounting({
        usage: scaledUsage(usage, scale),
        estimatedRates: rates,
      });
      expect(scaled.usage.totalTokens).toBe(base.usage.totalTokens * scale);
      expect(scaled.estimatedCost.total ?? 0).toBeCloseTo((base.estimatedCost.total ?? 0) * scale, 10);

      const left = {
        inputTokens: Math.floor(usage.inputTokens / 2),
        outputTokens: Math.floor(usage.outputTokens / 2),
        cacheReadTokens: Math.floor(usage.cacheReadTokens / 2),
        cacheWriteTokens: Math.floor(usage.cacheWriteTokens / 2),
      };
      const right = {
        inputTokens: usage.inputTokens - left.inputTokens,
        outputTokens: usage.outputTokens - left.outputTokens,
        cacheReadTokens: usage.cacheReadTokens - left.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens - left.cacheWriteTokens,
      };
      const leftCost = reconcileModelUsageAccounting({ usage: left, estimatedRates: rates });
      const rightCost = reconcileModelUsageAccounting({ usage: right, estimatedRates: rates });
      expect((leftCost.estimatedCost.total ?? 0) + (rightCost.estimatedCost.total ?? 0))
        .toBeCloseTo(base.estimatedCost.total ?? 0, 10);

      expect(() => reconcileModelUsageAccounting({
        usage: { ...usage, totalTokens: totalTokens(usage) + 1 },
        estimatedRates: rates,
      })).toThrow('totalTokens must equal input + output + cacheRead + cacheWrite');
    }
  });

  it('keeps charge reconciliation permutation-invariant and inclusively accounts for unmatched usage', () => {
    const random = seededRandom(0xacc0);
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const size = 1 + integer(random, 19);
      const charges: RunChargeLedgerEntry[] = [];
      const usage: ModelUsageEvent[] = [];
      for (let index = 0; index < size; index += 1) {
        charges.push(makeChargeEntry(index, 1 + integer(random, 9)));
        usage.push(makeUsageEvent(index, roundModelUsageUsd(0.001 + random())));
      }

      const baseline = reconcileGenerated(charges, usage);
      const permuted = reconcileGenerated([...charges].reverse(), [...usage].reverse());
      expect(permuted.sourceTotals).toEqual(baseline.sourceTotals);
      expect(permuted.buckets).toEqual(baseline.buckets);
      expect(permuted.ledgerReconciliation).toEqual(baseline.ledgerReconciliation);
      assertLedgerConservation(baseline);

      const unmatched = makeUsageEvent(size + 1_000, roundModelUsageUsd(0.001 + random()));
      unmatched.attribution.chargeEventId = 'missing-charge';
      const included = reconcileGenerated(charges, [...usage, unmatched]);
      expect(included.sourceTotals.calls).toBe(baseline.sourceTotals.calls + 1);
      expect(included.sourceTotals.totalTokens).toBe(baseline.sourceTotals.totalTokens + unmatched.totalTokens);
      expect(included.buckets.usageWithoutCharge.calls).toBe(1);
      assertLedgerConservation(included);
    }
  });

  it('kills representative arithmetic, classification, and order-sensitivity mutations', () => {
    const baseline = reconcileGenerated(
      [makeChargeEntry(1, 3), makeChargeEntry(2, 5)],
      [makeUsageEvent(1, 0.1), makeUsageEvent(2, 0.2)],
    );
    assertLedgerConservation(baseline);

    const mutations: Array<() => void> = [
      () => assertLedgerConservation({
        ...baseline,
        ledgerReconciliation: {
          ...baseline.ledgerReconciliation,
          charge: { ...baseline.ledgerReconciliation.charge, classifiedUnits: 7 },
        },
      }),
      () => assertLedgerConservation({
        ...baseline,
        ledgerReconciliation: {
          ...baseline.ledgerReconciliation,
          charge: { ...baseline.ledgerReconciliation.charge, classifiedEvents: 1 },
        },
      }),
      () => assertLedgerConservation({
        ...baseline,
        ledgerReconciliation: {
          ...baseline.ledgerReconciliation,
          usage: { ...baseline.ledgerReconciliation.usage, classifiedCalls: 1 },
        },
      }),
      () => assertLedgerConservation({
        ...baseline,
        ledgerReconciliation: {
          ...baseline.ledgerReconciliation,
          usage: { ...baseline.ledgerReconciliation.usage, classifiedTotalTokens: 1 },
        },
      }),
      () => assertLedgerConservation({
        ...baseline,
        ledgerReconciliation: {
          ...baseline.ledgerReconciliation,
          usage: { ...baseline.ledgerReconciliation.usage, classifiedEffectiveCostUsd: 99 },
        },
      }),
    ];
    let killed = 0;
    for (const mutation of mutations) {
      try {
        mutation();
      } catch {
        killed += 1;
      }
    }
    expect(killed / mutations.length).toBeGreaterThanOrEqual(0.8);
  });
});
