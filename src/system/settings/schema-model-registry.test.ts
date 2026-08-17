import { describe, expect, it } from 'vitest';
import { CANONICAL_MODEL_PURPOSES } from '../../shared/contracts/runtime.js';
import { normalizeCanonicalModelRegistry } from './schema-model-registry.js';

function makeRegistry(apiKind: unknown = 'openai-responses'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    models: [{
      id: 'shared-router-model',
      rank: 1,
      apiKind,
      identity: {
        provider: 'shared-router',
        model: 'exacto/test-model',
        source: { type: 'configured' },
      },
      purposes: CANONICAL_MODEL_PURPOSES.map((purpose) => ({ purpose, primary: true })),
      capabilities: {
        maxOutputTokens: 8192,
        contextWindow: 128_000,
        supportsReasoning: true,
      },
      tuning: { thinkingEnabled: false },
      routing: { providerOrder: ['provider-a', 'provider-b'], zdrOnly: true },
      cost: { inputPer1MUsd: 1, outputPer1MUsd: 2 },
    }],
  };
}

describe('normalizeCanonicalModelRegistry endpoint metadata', () => {
  it('preserves reviewed API, routing, capability, tuning, and cost data', () => {
    const registry = normalizeCanonicalModelRegistry(makeRegistry());

    expect(registry.models[0]).toMatchObject({
      id: 'shared-router-model',
      apiKind: 'openai-responses',
      identity: { provider: 'shared-router', model: 'exacto/test-model' },
      capabilities: { supportsReasoning: true },
      tuning: { thinkingEnabled: false },
      routing: { providerOrder: ['provider-a', 'provider-b'], zdrOnly: true },
      cost: { inputPer1MUsd: 1, outputPer1MUsd: 2 },
    });
  });

  it('rejects an unknown API kind', () => {
    expect(() => normalizeCanonicalModelRegistry(makeRegistry('chat-completions')))
      .toThrow('apiKind: expected one of openai-completions, openai-responses');
  });

  it('rejects malformed capability and routing data', () => {
    const badCapability = makeRegistry();
    const capabilityModel = (badCapability.models as Array<Record<string, unknown>>)[0];
    capabilityModel.capabilities = {
      ...(capabilityModel.capabilities as Record<string, unknown>),
      supportsReasoning: 'sometimes',
    };
    expect(() => normalizeCanonicalModelRegistry(badCapability))
      .toThrow('capabilities.supportsReasoning: expected boolean');

    const badRouting = makeRegistry();
    (badRouting.models as Array<Record<string, unknown>>)[0].routing = {
      providerOrder: ['provider-a', 3],
    };
    expect(() => normalizeCanonicalModelRegistry(badRouting))
      .toThrow('routing.providerOrder: expected non-empty strings');
  });

  it('rejects a completion tuning override above the model capability', () => {
    const registry = makeRegistry();
    const model = (registry.models as Array<Record<string, unknown>>)[0];
    model.capabilities = {
      maxOutputTokens: 8192,
      contextWindow: 262_144,
    };
    model.tuning = {
      maxOutputTokens: 214_404,
    };

    expect(() => normalizeCanonicalModelRegistry(registry))
      .toThrow('tuning.maxOutputTokens must not exceed capabilities.maxOutputTokens');
  });

  it('requires complete USD rates for every enabled model when budget enforcement is enabled', () => {
    const incomplete = makeRegistry();
    incomplete.budgetPolicy = {
      enabled: true,
      dailyUsdLimit: 1,
      monthlyUsdLimit: 10,
      currency: 'USD',
    };
    expect(() => normalizeCanonicalModelRegistry(incomplete))
      .toThrow('budgetPolicy.enabled requires complete USD cost rates');

    const complete = makeRegistry();
    complete.budgetPolicy = incomplete.budgetPolicy;
    const model = (complete.models as Array<Record<string, unknown>>)[0];
    model.cost = {
      inputPer1MUsd: 1,
      outputPer1MUsd: 2,
      cacheReadPer1MUsd: 0.1,
      cacheWritePer1MUsd: 1.25,
      currency: 'USD',
    };
    expect(normalizeCanonicalModelRegistry(complete).models[0]?.cost).toEqual(model.cost);
  });

  it('preserves a reviewed budget accounting cutover and rejects invalid timestamps', () => {
    const valid = makeRegistry();
    valid.budgetPolicy = {
      enabled: false,
      dailyUsdLimit: 1,
      monthlyUsdLimit: 10,
      accountingStartMs: 1_786_634_545_850,
    };

    expect(normalizeCanonicalModelRegistry(valid).budgetPolicy).toMatchObject({
      accountingStartMs: 1_786_634_545_850,
    });

    for (const accountingStartMs of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = makeRegistry();
      invalid.budgetPolicy = {
        enabled: false,
        dailyUsdLimit: 1,
        monthlyUsdLimit: 10,
        accountingStartMs,
      };
      expect(() => normalizeCanonicalModelRegistry(invalid))
        .toThrow('budgetPolicy.accountingStartMs: expected non-negative safe integer');
    }
  });
});
