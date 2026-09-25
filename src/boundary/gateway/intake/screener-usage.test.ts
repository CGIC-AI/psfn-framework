import { describe, expect, it, vi } from 'vitest';
import type { ModelUsageEventInput } from '../../../shared/telemetry/model-usage.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { RoutingCandidate } from '../../../primitives/llm/routing.js';
import { createIntakeScreenerUsageLedger } from './screener-usage.js';
import { evaluateL2 } from './l2-screener.js';
import type { ScreenerAttemptUsage } from './screener-transport.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateIntakePolicy } from '../../../system/config/intake-policy-config.js';

function registryConfig(cost?: Record<string, number>): SubstrateConfig {
  return {
    modelRegistry: {
      schemaVersion: 1,
      models: [{
        id: 'screen-slot',
        rank: 1,
        identity: { provider: 'plan-provider', model: 'screen-model', source: { type: 'plan-provider' } },
        purposes: [{ purpose: 'background', primary: true }],
        capabilities: { maxOutputTokens: 1024, contextWindow: 64_000 },
        ...(cost ? { cost: { ...cost, currency: 'USD' } } : {}),
      }],
    },
  } as unknown as SubstrateConfig;
}

const CANDIDATE: RoutingCandidate = {
  provider: 'plan-provider',
  model: 'screen-model',
  maxTokens: 1024,
  slotKey: 'screen-slot',
};

function attempt(overrides: Partial<ScreenerAttemptUsage> = {}): ScreenerAttemptUsage {
  return {
    status: 'success',
    startedAtMs: 1_000,
    completedAtMs: 1_400,
    inputTokens: 2_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

function ledgerFor(config: SubstrateConfig) {
  const rows: ModelUsageEventInput[] = [];
  const ledger = createIntakeScreenerUsageLedger({
    recorder: { recordUsageEvent: async (event) => { rows.push(event); } },
    config,
    companionId: 'companion-b',
  });
  return { ledger, rows };
}

describe('intake screener usage ledger (1fyyi)', () => {
  it('records a priced dispatch attributed to the screening companion', async () => {
    const { ledger, rows } = ledgerFor(registryConfig({ inputPer1MUsd: 0.5, outputPer1MUsd: 2 }));
    ledger('l2', CANDIDATE)?.(attempt());
    await vi.waitFor(() => expect(rows).toHaveLength(1));
    expect(rows[0]).toMatchObject({
      status: 'success',
      callKind: 'completion',
      provider: 'plan-provider',
      model: 'screen-model',
      slotKey: 'screen-slot',
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
      estimatedCostUsd: 3,
      costSource: 'estimate',
      attribution: { companionId: 'companion-b', purpose: 'background', originStage: 'intake:l2' },
    });
  });

  it('records a zero-rate subscription model at $0 and a timeout as a failure', async () => {
    const { ledger, rows } = ledgerFor(registryConfig({ inputPer1MUsd: 0, outputPer1MUsd: 0 }));
    const onAttempt = ledger('l3', CANDIDATE);
    onAttempt?.(attempt({
      status: 'failure', errorCode: 'timeout', inputTokens: 0, outputTokens: 0,
    }));
    onAttempt?.(attempt());
    await vi.waitFor(() => expect(rows).toHaveLength(2));
    expect(rows[0]).toMatchObject({ status: 'failure', errorCode: 'timeout', estimatedCostUsd: 0, attempt: 1 });
    expect(rows[1]).toMatchObject({ status: 'success', estimatedCostUsd: 0, attempt: 2 });
    expect(rows[0]?.logicalCallId).toBe(rows[1]?.logicalCallId);
  });

  it('never writes an unpriced row that would block budgeted dispatch', async () => {
    const { ledger, rows } = ledgerFor(registryConfig());
    ledger('l2', CANDIDATE)?.(attempt());
    ledger('l2', { ...CANDIDATE, slotKey: 'unknown-slot' })?.(attempt());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(rows).toEqual([]);
  });

  it('records the L2 screener dispatch through evaluateL2', async () => {
    const seed = JSON.parse(readFileSync(join(process.cwd(), 'config', 'intake-policy.seed.json'), 'utf8')) as unknown;
    const policy = validateIntakePolicy(seed, 'intake-policy.seed.json');
    const { ledger, rows } = ledgerFor(registryConfig({ inputPer1MUsd: 1, outputPer1MUsd: 1 }));
    const outcome = await evaluateL2({
      text: 'A note about watering tomato plants.',
      context: { sourceClass: 'web_fetch', sourceRiskTier: 'untrusted' },
      priorScore: 1,
      config: policy,
      model: CANDIDATE,
      backend: {},
      testCompletion: async () => JSON.stringify({ labels: [], injectionConfidence: 0.02, summary: 'Gardening tips.' }),
      usageLedger: ledger,
    });
    expect(outcome.kind).toBe('classified');
    await vi.waitFor(() => expect(rows).toHaveLength(1));
    expect(rows[0]).toMatchObject({
      status: 'success',
      slotKey: 'screen-slot',
      attribution: { companionId: 'companion-b', originStage: 'intake:l2' },
    });
  });
});
