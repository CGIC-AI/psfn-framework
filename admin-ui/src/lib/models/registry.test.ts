import { describe, expect, it } from 'vitest';
import {
  CANONICAL_PURPOSES,
  PURPOSE_LABELS,
  parseModelRegistryJson,
  serializeBudgetPolicyForSave,
} from './registry';

describe('model registry helpers', () => {
  it('normalizes current canonical models.json owner-file payloads for the Garden roster', () => {
    const registry = parseModelRegistryJson(JSON.stringify({
      schemaVersion: 1,
      models: [
        {
          id: 'extraction',
          enabled: false,
          rank: 20,
          identity: {
            provider: 'openrouter',
            model: 'deepseek/deepseek-v3.2',
            source: { type: 'openrouter' },
          },
          purposes: [
            { purpose: 'background', primary: true },
            { purpose: 'memory', primary: true },
            { purpose: 'extraction', primary: true },
            { purpose: 'import_processing', primary: true },
          ],
          capabilities: { maxOutputTokens: 8192, contextWindow: 128000 },
          tuning: { maxOutputTokens: 8192 },
        },
        {
          id: 'primary',
          rank: 30,
          identity: {
            provider: 'openrouter',
            model: 'z-ai/glm-5',
            source: { type: 'openrouter' },
          },
          purposes: [
            { purpose: 'chat', primary: true },
            { purpose: 'summary', primary: true },
            { purpose: 'reasoning', primary: true },
            { purpose: 'longContext', primary: true },
            { purpose: 'vision', primary: true },
            { purpose: 'moa', primary: true },
          ],
          capabilities: { maxOutputTokens: 16384, contextWindow: 128000 },
          tuning: { maxOutputTokens: 16384 },
        },
      ],
    }));

    expect(registry.models.map(model => model.id)).toEqual(['primary', 'extraction']);
    expect(registry.models.find(model => model.id === 'extraction')?.enabled).toBe(false);
    expect(registry.models.find(model => model.id === 'primary')?.enabled).toBeUndefined();
    expect(registry.models[0]?.identity).toEqual(expect.objectContaining({
      provider: 'openrouter',
      model: 'z-ai/glm-5',
    }));
    expect(
      registry.models.flatMap(model => model.purposes)
        .filter(tag => tag.primary)
        .map(tag => tag.purpose)
        .sort(),
    ).toEqual([...CANONICAL_PURPOSES].sort());
  });

  it('accepts the backend ModelsRuntimeConfig wrapper as well as raw owner-file JSON', () => {
    const registry = parseModelRegistryJson(JSON.stringify({
      modelRegistry: {
        schemaVersion: 1,
        models: [
        {
          id: 'primary',
          enabled: true,
          rank: 10,
          identity: {
              provider: 'openrouter',
              model: 'z-ai/glm-5',
              source: { type: 'openrouter' },
            },
            purposes: [
              { purpose: 'chat', primary: true },
            ],
            capabilities: { maxOutputTokens: 16384 },
          },
        ],
      },
    }));

    expect(registry.models).toHaveLength(1);
    expect(registry.models[0]?.id).toBe('primary');
  });

  it('preserves the accounting cutover through Garden load and save', () => {
    const accountingStartMs = 1_786_634_545_850;
    const registry = parseModelRegistryJson(JSON.stringify({
      schemaVersion: 1,
      budgetPolicy: {
        enabled: false,
        dailyUsdLimit: 5,
        monthlyUsdLimit: 100,
        accountingStartMs,
      },
      models: [],
    }));

    expect(registry.budgetPolicy?.accountingStartMs).toBe(accountingStartMs);
    expect(serializeBudgetPolicyForSave(registry.budgetPolicy!)).toMatchObject({
      accountingStartMs,
    });
  });

  it('tolerantly drops legacy per-model routing metadata written by old admin builds', () => {
    const registry = parseModelRegistryJson(JSON.stringify({
      schemaVersion: 1,
      models: [
        {
          id: 'primary',
          rank: 10,
          identity: {
            provider: 'openrouter',
            model: 'z-ai/glm-5',
            source: { type: 'openrouter' },
          },
          purposes: [{ purpose: 'chat', primary: true }],
          capabilities: { maxOutputTokens: 16384 },
          routing: { providerOrder: ['a', 'b'] },
        },
      ],
    }));

    const entry = registry.models[0];
    // The legacy field is stripped entirely rather than throwing or surviving.
    expect(entry).toBeDefined();
    expect(entry && 'routing' in entry).toBe(false);
    // Sibling canonical fields still survive the normalization.
    expect(entry?.id).toBe('primary');
    expect(entry?.rank).toBe(10);
    expect(entry?.identity).toEqual(expect.objectContaining({
      provider: 'openrouter',
      model: 'z-ai/glm-5',
    }));
    expect(entry?.purposes).toEqual([{ purpose: 'chat', primary: true }]);
    expect(entry?.capabilities).toEqual({ maxOutputTokens: 16384 });
    // A round-trip through the save shape must not reintroduce `routing`.
    expect(JSON.stringify(registry)).not.toContain('routing');
  });

  it('labels the dedicated memory purpose for operator-facing model assignment', () => {
    expect(PURPOSE_LABELS.memory).toBe('memory recall');
  });
});
