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
  supportsVision?: boolean;
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
        ...(model.supportsVision !== undefined ? { supportsVision: model.supportsVision } : {}),
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
        { purpose: 'moa', primary: true },
      ],
    },
    {
      id: 'vision-primary',
      rank: 24,
      provider: 'openrouter',
      model: 'vision/primary',
      maxOutputTokens: 4096,
      contextWindow: 128_000,
      supportsVision: true,
      purposes: [{ purpose: 'vision', primary: true }],
    },
    {
      id: 'vision-flash',
      rank: 25,
      provider: 'openrouter',
      model: 'vision/flash',
      maxOutputTokens: 4096,
      contextWindow: 96_000,
      supportsVision: true,
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
    expect(withoutHint[0]).toMatchObject({ model: 'vision/primary', provider: 'openrouter' });
  });

  it('leads the lane with the config-level selection and keeps the fallback chain', () => {
    const config = makeConfig({ modelPurposeSelection: { vision: 'vision-flash' } });
    const candidates = resolveCandidates(config, 'vision', undefined);
    expect(candidates[0]).toMatchObject({ model: 'vision/flash', provider: 'openrouter' });
    // Registry-primary vision model remains as fallback — selection is not a pin.
    expect(candidates.some((candidate) => candidate.model === 'vision/primary')).toBe(true);
  });

  it('resolves a hint-transported slot key (agent→gateway wire) to the registry model', () => {
    const config = makeConfig();
    const candidates = resolveCandidates(config, 'vision', { slotKey: 'vision-flash' });
    expect(candidates[0]).toMatchObject({ model: 'vision/flash', provider: 'openrouter' });
  });

  it('preserves wire slot attribution when the agent also pins the resolved model identity', () => {
    const config = makeConfig({ multiCompanion: true });
    const candidates = resolveCandidates(config, 'vision', {
      slotKey: 'vision-flash',
      model: 'vision/flash',
      provider: 'openrouter',
      pin: true,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      slotKey: 'vision-flash',
      model: 'vision/flash',
      provider: 'openrouter',
    });
  });

  it('rejects a selected text-only slot for the vision lane before provider dispatch', () => {
    const config = makeConfig({ modelPurposeSelection: { vision: 'chat-primary' } });

    expect(() => resolveCandidates(config, 'vision', undefined))
      .toThrow(/vision_purpose_resolved_non_vision_model.*chat\/model/s);
  });

  it('rejects an explicit text-only model hint for the vision lane', () => {
    const config = makeConfig();

    expect(() => resolveCandidates(config, 'vision', {
      model: 'openrouter:chat/model',
    })).toThrow(/vision_purpose_resolved_non_vision_model.*chat\/model/s);
  });

  it('lets two companions diverge on the same gateway registry', () => {
    const config = makeConfig();
    // Companion A selected vision-flash; companion B uses the registry primary.
    const companionA = resolveCandidates(config, 'vision', { slotKey: 'vision-flash' });
    const companionB = resolveCandidates(config, 'vision', undefined);
    expect(companionA[0]?.model).toBe('vision/flash');
    expect(companionB[0]?.model).toBe('vision/primary');
    expect(companionA[0]?.model).not.toBe(companionB[0]?.model);
  });

  it('rejects unknown slot keys fail-closed with the valid slot ids', () => {
    const config = makeConfig();
    expect(() => resolveCandidates(config, 'chat', { slotKey: 'no-such-slot' }))
      .toThrow(UnknownModelSelectionSlotError);
    expect(() => resolveCandidates(config, 'chat', { slotKey: 'no-such-slot' }))
      .toThrow(/no-such-slot.*chat-primary, vision-primary, vision-flash, background-primary/s);
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

  it('never substitutes the shared config selection on a multi-companion gateway (isolation)', () => {
    // A multi-companion gateway hydrates ONE config whose modelPurposeSelection
    // belongs to whichever companion dir it rooted at. A sibling companion's
    // un-slotted call must get registry-primary routing — byte-identical to a
    // gateway with no selection at all — never the leaked shared value.
    const multiConfig = makeConfig({
      multiCompanion: true,
      modelPurposeSelection: { chat: 'background-primary', vision: 'vision-flash' },
    });
    const baseline = resolveCandidates(makeConfig(), 'chat', undefined);
    const unslotted = resolveCandidates(multiConfig, 'chat', undefined);
    expect(unslotted).toEqual(baseline);
    expect(unslotted[0]).toMatchObject({ model: 'chat/model' });
    expect(resolveCandidates(multiConfig, 'vision', undefined)[0]).toMatchObject({
      model: 'vision/primary',
    });
  });

  it('honors the wire slotKey as the only selection source on a multi-companion gateway', () => {
    const multiConfig = makeConfig({
      multiCompanion: true,
      modelPurposeSelection: { vision: 'chat-primary' },
    });
    // The calling companion's own selection arrives as the wire slotKey and
    // leads the lane; the gateway's config-level value stays inert.
    const candidates = resolveCandidates(multiConfig, 'vision', { slotKey: 'vision-flash' });
    expect(candidates[0]).toMatchObject({ model: 'vision/flash', provider: 'openrouter' });
  });

  it('keeps the config-level fallback for embedded single-companion processes', () => {
    const config = makeConfig({
      multiCompanion: false,
      modelPurposeSelection: { vision: 'vision-flash' },
    });
    expect(resolveCandidates(config, 'vision', undefined)[0]).toMatchObject({
      model: 'vision/flash',
    });
  });

  it('honors pin on a slot-key hint (selection candidate only)', () => {
    const config = makeConfig();
    const candidates = resolveCandidates(config, 'vision', { slotKey: 'vision-flash', pin: true });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ model: 'vision/flash' });
  });

  it('uses the exact selected slot when duplicate model identities carry distinct metadata', () => {
    const registry = makeBaseRegistry();
    registry.models.push({
      id: 'chat-duplicate-custom-route',
      rank: 99,
      identity: {
        provider: 'openrouter',
        model: 'chat/model',
        source: {
          type: 'openrouter',
          baseUrl: 'https://selected-slot.example.test/v1',
        },
      },
      purposes: [{ purpose: 'vision', primary: false }],
      capabilities: {
        maxOutputTokens: 1234,
        contextWindow: 32_000,
        supportsVision: true,
      },
      tuning: {
        maxOutputTokens: 1234,
        contextWindow: 32_000,
        temperature: 0.17,
      },
    });
    const config = makeConfig({
      modelRegistry: registry,
      openRouterApiBaseUrl: 'https://global-openrouter.example.test/v1',
    });

    expect(resolveCandidates(config, 'vision', {
      slotKey: 'chat-duplicate-custom-route',
    })[0]).toMatchObject({
      slotKey: 'chat-duplicate-custom-route',
      provider: 'openrouter',
      model: 'chat/model',
      maxTokens: 1234,
      contextWindow: 32_000,
      supportsVision: true,
      temperature: 0.17,
      requestBaseUrl: 'https://selected-slot.example.test/v1',
    });
  });

  it('validates but does not let a companion selection override the global local import route', () => {
    const config = makeConfig({
      importProcessingRouteMode: 'local_endpoint',
      importProcessingLocalEndpointUrl: 'http://127.0.0.1:9000/v1',
      importProcessingLocalModel: 'private-import-model',
      modelPurposeSelection: { import_processing: 'chat-primary' },
    });
    const baseline = resolveCandidates({
      ...config,
      modelPurposeSelection: undefined,
    }, 'import_processing', undefined);

    expect(resolveCandidates(config, 'import_processing', undefined)).toEqual(baseline);
    expect(resolveCandidates(config, 'import_processing', {
      slotKey: 'chat-primary',
    })).toEqual(baseline);
    expect(baseline).toEqual([
      expect.objectContaining({
        provider: 'local_endpoint',
        model: 'private-import-model',
        requestBaseUrl: 'http://127.0.0.1:9000/v1',
        importRouteMode: 'local_endpoint',
      }),
    ]);
    expect(() => resolveCandidates(config, 'import_processing', {
      slotKey: 'not-a-slot',
    })).toThrow(UnknownModelSelectionSlotError);
  });

  it('still applies an import selection to the remote background route', () => {
    const config = makeConfig({
      importProcessingRouteMode: 'background',
      modelPurposeSelection: { import_processing: 'chat-primary' },
    });

    expect(resolveCandidates(config, 'import_processing', undefined)[0]).toMatchObject({
      slotKey: 'chat-primary',
      provider: 'openrouter',
      model: 'chat/model',
      importRouteMode: 'background',
    });
  });
});
