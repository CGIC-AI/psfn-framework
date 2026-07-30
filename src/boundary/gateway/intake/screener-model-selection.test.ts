import { describe, expect, it } from 'vitest';
import type {
  CanonicalModelPurpose,
  ModelRegistryEntry,
} from '../../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { resolveIntakeScreenerModels } from './screener-model-selection.js';
import { createIntakeScreenerTestConfig } from './screener-test-config.js';

function entry(input: {
  id: string;
  model: string;
  purpose: CanonicalModelPurpose;
  primary?: boolean;
  supportsVision?: boolean;
}): ModelRegistryEntry {
  return {
    id: input.id,
    identity: {
      provider: 'openrouter',
      model: input.model,
      source: { type: 'openrouter' },
    },
    purposes: [{ purpose: input.purpose, primary: input.primary ?? true }],
    capabilities: {
      maxOutputTokens: 4096,
      contextWindow: 128_000,
      ...(input.supportsVision !== undefined
        ? { supportsVision: input.supportsVision }
        : {}),
    },
  };
}

function config(
  models: ModelRegistryEntry[],
  modelPurposeSelection?: SubstrateConfig['modelPurposeSelection'],
): SubstrateConfig {
  return createIntakeScreenerTestConfig({
    modelRegistry: { schemaVersion: 1, models },
    ...(modelPurposeSelection ? { modelPurposeSelection } : {}),
  });
}

describe('resolveIntakeScreenerModels', () => {
  it('uses canonical background, reasoning, and vision purpose selections', () => {
    const runtime = config([
      entry({ id: 'background-primary', model: 'vendor/background-primary', purpose: 'background' }),
      entry({ id: 'background-selected', model: 'vendor/background-selected', purpose: 'background', primary: false }),
      entry({ id: 'reasoning-primary', model: 'vendor/reasoning-primary', purpose: 'reasoning' }),
      entry({ id: 'reasoning-selected', model: 'vendor/reasoning-selected', purpose: 'reasoning', primary: false }),
      entry({
        id: 'vision-primary',
        model: 'vendor/vision-primary',
        purpose: 'vision',
        supportsVision: true,
      }),
      entry({
        id: 'vision-selected',
        model: 'vendor/vision-selected',
        purpose: 'vision',
        primary: false,
        supportsVision: true,
      }),
    ], {
      background: 'background-selected',
      reasoning: 'reasoning-selected',
      vision: 'vision-selected',
    });

    expect(resolveIntakeScreenerModels(runtime, {
      l3DualModel: true,
      visionEnabled: true,
    })).toEqual({
      l2: 'vendor/background-selected',
      l3: ['vendor/reasoning-selected', 'vendor/background-selected'],
      vision: 'vendor/vision-selected',
    });
  });

  it('does not promote one companion selection to a fleet-wide screener choice', () => {
    const runtime = {
      ...config([
        entry({
          id: 'background-primary',
          model: 'vendor/background-primary',
          purpose: 'background',
        }),
        entry({
          id: 'background-selected',
          model: 'vendor/background-selected',
          purpose: 'background',
          primary: false,
        }),
        entry({
          id: 'reasoning-primary',
          model: 'vendor/reasoning-primary',
          purpose: 'reasoning',
        }),
        entry({
          id: 'reasoning-selected',
          model: 'vendor/reasoning-selected',
          purpose: 'reasoning',
          primary: false,
        }),
      ], {
        background: 'background-selected',
        reasoning: 'reasoning-selected',
      }),
      multiCompanion: true,
    };

    expect(resolveIntakeScreenerModels(runtime, {
      l3DualModel: false,
      visionEnabled: false,
    })).toEqual({
      l2: 'vendor/background-primary',
      l3: ['vendor/reasoning-primary'],
    });
  });

  it('fails closed when a required purpose cannot resolve', () => {
    expect(() => resolveIntakeScreenerModels(config([]), {
      l3DualModel: false,
      visionEnabled: false,
    })).toThrow(/background.*no eligible model.*models\.json/is);

    expect(() => resolveIntakeScreenerModels(config([
      entry({ id: 'background', model: 'vendor/background', purpose: 'background' }),
    ]), {
      l3DualModel: false,
      visionEnabled: false,
    })).toThrow(/reasoning.*no eligible model.*models\.json/is);

    expect(() => resolveIntakeScreenerModels(config([
      entry({ id: 'background', model: 'vendor/background', purpose: 'background' }),
      entry({ id: 'reasoning', model: 'vendor/reasoning', purpose: 'reasoning' }),
    ]), {
      l3DualModel: false,
      visionEnabled: true,
    })).toThrow(/vision.*no eligible model.*models\.json/is);
  });

  it('fails closed when the vision purpose is not explicitly image-capable', () => {
    const runtime = config([
      entry({ id: 'background', model: 'vendor/background', purpose: 'background' }),
      entry({ id: 'reasoning', model: 'vendor/reasoning', purpose: 'reasoning' }),
      entry({ id: 'vision', model: 'vendor/text-only', purpose: 'vision' }),
    ]);

    expect(() => resolveIntakeScreenerModels(runtime, {
      l3DualModel: false,
      visionEnabled: true,
    })).toThrow(/vision.*vendor\/text-only.*supportsVision=true/is);
  });

  it('fails closed when dual L3 purposes resolve to the same model', () => {
    const runtime = config([
      entry({ id: 'background', model: 'vendor/shared', purpose: 'background' }),
      entry({ id: 'reasoning', model: 'vendor/shared', purpose: 'reasoning' }),
    ]);

    expect(() => resolveIntakeScreenerModels(runtime, {
      l3DualModel: true,
      visionEnabled: false,
    })).toThrow(/dual.*reasoning.*background.*different/is);
  });
});
