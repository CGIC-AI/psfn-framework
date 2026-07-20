import { describe, expect, it } from 'vitest';
import type { CanonicalModelPurpose, CanonicalModelRegistry, ModelRegistryEntry } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  normalizeModelHint,
  resolveCandidates,
  resolveModelSelectionSlotForPurpose,
  UnknownModelSelectionSlotError,
} from './model-hint-routing.js';

interface RegistryModelInput {
  id: string;
  enabled?: boolean;
  rank: number;
  provider: string;
  model: string;
  maxOutputTokens: number;
  contextWindow: number;
  purposes: Array<{ purpose: CanonicalModelPurpose; primary: boolean }>;
}

function makeRegistry(models: RegistryModelInput[]): CanonicalModelRegistry {
  return {
    schemaVersion: 1,
    models: models.map((model): ModelRegistryEntry => ({
      id: model.id,
      ...(model.enabled === false ? { enabled: false } : {}),
      rank: model.rank,
      identity: {
        provider: model.provider,
        model: model.model,
        source: { type: model.provider },
      },
      purposes: model.purposes,
      capabilities: {
        maxOutputTokens: model.maxOutputTokens,
        contextWindow: model.contextWindow,
      },
      tuning: {
        maxOutputTokens: model.maxOutputTokens,
        contextWindow: model.contextWindow,
      },
    })),
  };
}

function makeBaseRegistry(): CanonicalModelRegistry {
  return makeRegistry([
    {
      id: 'chat-primary',
      rank: 20,
      provider: 'openrouter',
      model: 'chat/model',
      maxOutputTokens: 8192,
      contextWindow: 128_000,
      purposes: [
        { purpose: 'chat', primary: true },
        { purpose: 'summary', primary: true },
        { purpose: 'reasoning', primary: true },
        { purpose: 'longContext', primary: true },
        { purpose: 'vision', primary: true },
        { purpose: 'moa', primary: true },
      ],
    },
    {
      id: 'vision-flash',
      rank: 25,
      provider: 'openrouter',
      model: 'vision/flash',
      maxOutputTokens: 4096,
      contextWindow: 96_000,
      purposes: [{ purpose: 'vision', primary: false }],
    },
    {
      id: 'background-primary',
      rank: 30,
      provider: 'openrouter',
      model: 'background/model',
      maxOutputTokens: 2048,
      contextWindow: 64_000,
      purposes: [
        { purpose: 'background', primary: true },
        { purpose: 'extraction', primary: true },
        { purpose: 'memory', primary: true },
        { purpose: 'import_processing', primary: true },
      ],
    },
  ]);
}

function makeConfig(overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  return {
    primaryModel: 'chat/model',
    primaryProvider: 'openrouter',
    extractionModel: 'background/model',
    extractionProvider: 'openrouter',
    primaryMaxTokens: 8192,
    extractionMaxTokens: 2048,
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir: './data',
    databasePath: './data/test.db',
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {},
    modelRegistry: makeBaseRegistry(),
    ...overrides,
  } as SubstrateConfig;
}

describe('normalizeModelHint slotKey', () => {
  it('carries a trimmed slot key and treats slotKey-only hints as non-empty', () => {
    expect(normalizeModelHint({ slotKey: ' vision-flash ' })).toEqual({ slotKey: 'vision-flash' });
  });

  it('still collapses fully empty hints', () => {
    expect(normalizeModelHint({ slotKey: '  ' })).toBeNull();
  });
});

describe('resolveModelSelectionSlotForPurpose', () => {
  it('returns direct purpose selections', () => {
    expect(resolveModelSelectionSlotForPurpose({ chat: 'a', vision: 'b' }, 'vision')).toBe('b');
    expect(resolveModelSelectionSlotForPurpose({ chat: 'a' }, 'background')).toBeUndefined();
    expect(resolveModelSelectionSlotForPurpose(undefined, 'chat')).toBeUndefined();
  });

  it('resolves the context lane through its longContext → background chain, never chat', () => {
    expect(resolveModelSelectionSlotForPurpose({ longContext: 'lc', background: 'bg' }, 'context')).toBe('lc');
    expect(resolveModelSelectionSlotForPurpose({ background: 'bg' }, 'context')).toBe('bg');
    expect(resolveModelSelectionSlotForPurpose({ chat: 'big-brain' }, 'context')).toBeUndefined();
  });
});

describe('resolveCandidates per-companion model selection (23pp)', () => {
  it('is byte-identical to purpose routing when no hint and no selection are set', () => {
    const config = makeConfig();
    const withoutHint = resolveCandidates(config, 'vision', undefined);
    expect(withoutHint[0]).toMatchObject({ model: 'chat/model', provider: 'openrouter' });
  });

  it('leads the lane with the config-level selection and keeps the fallback chain', () => {
    const config = makeConfig({ modelPurposeSelection: { vision: 'vision-flash' } });
    const candidates = resolveCandidates(config, 'vision', undefined);
    expect(candidates[0]).toMatchObject({ model: 'vision/flash', provider: 'openrouter' });
    // Registry-primary vision model remains as fallback — selection is not a pin.
    expect(candidates.some((candidate) => candidate.model === 'chat/model')).toBe(true);
  });

  it('resolves a hint-transported slot key (agent→gateway wire) to the registry model', () => {
    const config = makeConfig();
    const candidates = resolveCandidates(config, 'vision', { slotKey: 'vision-flash' });
    expect(candidates[0]).toMatchObject({ model: 'vision/flash', provider: 'openrouter' });
  });

  it('lets two companions diverge on the same gateway registry', () => {
    const config = makeConfig();
    // Companion A selected vision-flash; companion B has no selection.
    const companionA = resolveCandidates(config, 'vision', { slotKey: 'vision-flash' });
    const companionB = resolveCandidates(config, 'vision', undefined);
    expect(companionA[0]?.model).toBe('vision/flash');
    expect(companionB[0]?.model).toBe('chat/model');
    expect(companionA[0]?.model).not.toBe(companionB[0]?.model);
  });

  it('rejects unknown slot keys fail-closed with the valid slot ids', () => {
    const config = makeConfig();
    expect(() => resolveCandidates(config, 'chat', { slotKey: 'no-such-slot' }))
      .toThrow(UnknownModelSelectionSlotError);
    expect(() => resolveCandidates(config, 'chat', { slotKey: 'no-such-slot' }))
      .toThrow(/no-such-slot.*chat-primary, vision-flash, background-primary/s);
  });

  it('rejects config-level selections that reference disabled entries', () => {
    const registry = makeBaseRegistry();
    const disabledEntry = registry.models.find((entry) => entry.id === 'vision-flash');
    if (!disabledEntry) throw new Error('test registry missing vision-flash');
    (disabledEntry as { enabled?: boolean }).enabled = false;
    const config = makeConfig({
      modelRegistry: registry,
      modelPurposeSelection: { vision: 'vision-flash' },
    });
    expect(() => resolveCandidates(config, 'vision', undefined))
      .toThrow(UnknownModelSelectionSlotError);
  });

  it('gives explicit model hints precedence over the companion selection', () => {
    const config = makeConfig({ modelPurposeSelection: { chat: 'background-primary' } });
    const candidates = resolveCandidates(config, 'chat', {
      model: 'openrouter:explicit/override',
    });
    expect(candidates[0]).toMatchObject({ model: 'explicit/override', provider: 'openrouter' });
    expect(candidates[0]?.model).not.toBe('background/model');
  });

  it('applies the background selection to the background lane', () => {
    const config = makeConfig({ modelPurposeSelection: { background: 'chat-primary' } });
    const candidates = resolveCandidates(config, 'background', undefined);
    expect(candidates[0]).toMatchObject({ model: 'chat/model' });
    expect(candidates.some((candidate) => candidate.model === 'background/model')).toBe(true);
  });

  it('honors pin on a slot-key hint (selection candidate only)', () => {
    const config = makeConfig();
    const candidates = resolveCandidates(config, 'vision', { slotKey: 'vision-flash', pin: true });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ model: 'vision/flash' });
  });
});
