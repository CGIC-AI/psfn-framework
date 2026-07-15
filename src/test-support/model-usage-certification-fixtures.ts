import { readFileSync } from 'node:fs';
import type { RunChargeEvent } from '../shared/contracts/runtime.js';
import type { ModelUsageEventInput, ModelUsageQuery } from '../shared/telemetry/model-usage.js';
import { isRecord } from '../shared/utils/types.js';

export interface ModelUsageProviderFixture {
  id: string;
  route: string;
  rawUsage: Record<string, unknown>;
  fallbackInputTokens: number;
  fallbackOutputTokens: number;
  expected: Record<string, unknown>;
}

export interface InvalidModelUsageProviderFixture {
  id: string;
  rawUsage: Record<string, unknown>;
  expectedError?: string;
  expectedConflict?: { fields: string[] };
  expected?: Record<string, unknown>;
}

export interface ModelUsageCertificationFixture {
  schemaVersion: 1;
  provenance: {
    kind: 'synthetic-spec-derived';
    frozenAtCommit: string;
    createdAt: string;
    sources: string[];
    generation: string;
    reviewCommand: string;
  };
  requirements: Array<{
    id: string;
    level: 'MUST';
    mechanism: string;
  }>;
  providerCases: ModelUsageProviderFixture[];
  invalidProviderCases: InvalidModelUsageProviderFixture[];
  nowMs: number;
  query: ModelUsageQuery;
  events: ModelUsageEventInput[];
  charges: RunChargeEvent[];
  expected: {
    companionA: {
      calls: number;
      successfulCalls: number;
      failedCalls: number;
      inputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      outputTokens: number;
      totalTokens: number;
      providerCostUsd: number;
      estimatedCostUsd: number;
      totalCostUsd: number;
      costSourceCalls: Record<'provider' | 'estimate' | 'none', number>;
    };
    companionB: {
      calls: number;
      totalTokens: number;
      totalCostUsd: number;
    };
    charge: {
      chargeUnits: number;
      chargeEvents: number;
      calls: number;
      effectiveCostUsd: number;
      attributableChargeUnits: number;
      attributableCalls: number;
      attributableEffectiveCostUsd: number;
      ambiguousChargeUnits: number;
      ambiguousCalls: number;
      ambiguousEffectiveCostUsd: number;
      usageWithoutChargeCalls: number;
      usageWithoutChargeEffectiveCostUsd: number;
    };
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function assertFixture(value: unknown): asserts value is ModelUsageCertificationFixture {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Accounting certification fixture must use schemaVersion 1');
  }
  if (!isRecord(value.provenance) || value.provenance.kind !== 'synthetic-spec-derived') {
    throw new Error('Accounting certification fixture provenance is missing');
  }
  for (const field of ['requirements', 'providerCases', 'invalidProviderCases', 'events', 'charges'] as const) {
    if (!Array.isArray(value[field]) || value[field].length === 0) {
      throw new Error(`Accounting certification fixture ${field} must be a non-empty array`);
    }
  }
  if (!isRecord(value.query) || !isRecord(value.expected)) {
    throw new Error('Accounting certification fixture query/expected contract is missing');
  }
}

export function loadModelUsageCertificationFixture(): ModelUsageCertificationFixture {
  const path = new URL('./fixtures/model-usage-certification.json', import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assertFixture(parsed);
  return deepFreeze(parsed);
}
