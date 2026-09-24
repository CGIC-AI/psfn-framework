import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAutomataPolicyConfig, loadAutomataPolicySeedDefaults } from '../../src/system/config/automata-policy-config.js';
import { loadModelsConfig } from '../../src/system/config/models-config.js';
import { resolveIntakeScreenerModels } from '../../src/boundary/gateway/intake/screener-model-selection.js';
import type { SubstrateConfig } from '../../src/system/config/runtime-config-contracts.js';
import {
  normalizeCanonicalModelRegistry,
  projectCanonicalModelRegistry,
} from '../../src/system/settings/schema-model-registry.js';
import type { OnboardingPlan } from './types.js';
import {
  buildModelsRegistry,
  buildProvidersRegistry,
  commitOwnerFiles,
  detectExistingOwnerFiles,
  stageAndValidate,
} from './config-generator.js';

const SEED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../config');

function makePlan(overrides: Partial<OnboardingPlan> = {}): OnboardingPlan {
  const plan = makeBasePlan(overrides);
  return {
    ...plan,
    fallbackChat: overrides.fallbackChat ?? { provider: plan.provider, modelSlug: 'moonshotai/kimi-k2.5' },
  };
}

function makeBasePlan(overrides: Partial<OnboardingPlan>): Omit<OnboardingPlan, 'fallbackChat'> {
  const root = overrides.roots?.systemDataDir ?? mkdtempSync(join(tmpdir(), 'onboard-cfg-'));
  return {
    mode: 'local',
    roots: { systemDataDir: root, companionDataDir: root, shared: true },
    seedDir: SEED_DIR,
    provider: {
      id: 'openrouter',
      type: 'openrouter',
      label: 'OpenRouter',
      apiBaseUrl: 'https://openrouter.ai/api/v1',
      modelsApiUrl: 'https://openrouter.ai/api/v1/models',
      apiKeyEnvName: 'OPENROUTER_API_KEY',
      apiKeyValue: 'sk-or-secret-value',
    },
    models: {
      primaryModelSlug: 'z-ai/glm-5',
      extractionModelSlug: 'deepseek/deepseek-v3.2',
      visionModelSlug: 'google/gemini-3.1-flash',
    },
    voice: { enabled: false, secrets: [] },
    companionId: '11111111-1111-4111-8111-111111111111',
    envEntries: [],
    updateExisting: false,
    ...overrides,
  };
}

const tmpRoots: string[] = [];
function freshRoot(shared: boolean): OnboardingPlan['roots'] {
  const base = mkdtempSync(join(tmpdir(), 'onboard-root-'));
  tmpRoots.push(base);
  if (shared) return { systemDataDir: base, companionDataDir: base, shared: true };
  return {
    systemDataDir: join(base, 'system-data'),
    companionDataDir: join(base, 'companion-data'),
    shared: false,
  };
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    rmSync(tmpRoots.pop() as string, { recursive: true, force: true });
  }
});

describe('config generation passes the real settings-contract guard', () => {
  it.each([true, false])('binds the generated reviewer to the configured background slot (shared=%s)', (shared) => {
    const plan = makePlan({ roots: freshRoot(shared), models: {
      primaryModelSlug: 'example/chat', extractionModelSlug: 'example/background', visionModelSlug: 'example/vision',
    } });
    commitOwnerFiles(plan);
    const policy = loadAutomataPolicyConfig(plan.roots.systemDataDir);
    const seed = loadAutomataPolicySeedDefaults({ seedDir: SEED_DIR });
    expect(policy).toEqual({ ...seed, bus: { ...seed.bus, reviewer: { ...seed.bus.reviewer, model: 'extraction' } } });
    const registry = loadModelsConfig(plan.roots.systemDataDir).modelRegistry;
    expect(registry.models.find(model => model.id === policy.bus.reviewer.model)).toMatchObject({
      id: 'extraction', identity: { provider: plan.provider.id, model: 'example/background' },
    });
  });

  it('validates a shared-root openrouter config', () => {
    const plan = makePlan({ roots: freshRoot(true) });
    expect(() => stageAndValidate(plan)).not.toThrow();
  });

  it('validates a split-root non-openrouter (openai) config', () => {
    const plan = makePlan({
      roots: freshRoot(false),
      provider: {
        id: 'openai',
        type: 'openai',
        label: 'OpenAI',
        apiBaseUrl: 'https://api.openai.com/v1',
        apiKeyEnvName: 'OPENAI_API_KEY',
        apiKeyValue: 'sk-openai-secret',
      },
      models: {
        primaryModelSlug: 'gpt-5.4',
        extractionModelSlug: 'gpt-5.4-mini',
        visionModelSlug: 'gpt-5.4-vision',
      },
    });
    expect(() => stageAndValidate(plan)).not.toThrow();
  });

  it('makes generic OpenAI-compatible models executable through chat completions', () => {
    const plan = makePlan({
      provider: {
        id: 'glm-code',
        type: 'generic_openai',
        label: 'GLM Code Plan',
        apiBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
        apiKeyEnvName: 'PSFN_PROVIDER_API_KEY',
        apiKeyValue: 'test-key',
      },
    });
    const registry = buildModelsRegistry(plan) as {
      models: Array<{ apiKind?: string }>;
    };
    expect(registry.models).not.toHaveLength(0);
    expect(registry.models.every(model => model.apiKind === 'openai-completions')).toBe(true);
  });

  it('re-points all selected models and preserves an explicit vision capability', () => {
    const plan = makePlan({
      provider: {
        id: 'anthropic',
        type: 'anthropic',
        label: 'Anthropic',
        apiBaseUrl: 'https://api.anthropic.com/v1',
        apiKeyEnvName: 'ANTHROPIC_API_KEY',
        apiKeyValue: 'sk-ant',
      },
      models: {
        primaryModelSlug: 'claude-x',
        extractionModelSlug: 'claude-y',
        visionModelSlug: 'claude-vision',
      },
    });
    const registry = buildModelsRegistry(plan) as {
      models: Array<{
        id: string;
        identity: { provider: string; model: string };
        purposes: Array<{ purpose: string; primary: boolean }>;
        capabilities?: { supportsVision?: boolean };
      }>;
    };
    expect(registry.models).toHaveLength(4);
    expect(registry.models.every((m) => m.identity.provider === 'anthropic')).toBe(true);
    expect(registry.models.map((m) => m.identity.model).sort()).toEqual([
      'claude-vision',
      'claude-x',
      'claude-y',
      'moonshotai/kimi-k2.5',
    ]);
    const vision = registry.models.find((m) => m.identity.model === 'claude-vision');
    expect(vision?.purposes).toContainEqual({
      purpose: 'vision',
      primary: true,
    });
    expect(vision?.capabilities?.supportsVision).toBe(true);
  });

  it('feeds generated OpenRouter roles through the startup screener resolver', () => {
    const registry = normalizeCanonicalModelRegistry(buildModelsRegistry(makePlan()));
    const runtime = projectCanonicalModelRegistry(registry) as SubstrateConfig;

    const models = resolveIntakeScreenerModels(runtime, {
      l3DualModel: false,
      visionEnabled: true,
    });

    expect({
      l2: `${models.l2.provider}:${models.l2.model}`,
      l3: models.l3.map((model) => `${model.provider}:${model.model}`),
      vision: models.vision
        ? `${models.vision.provider}:${models.vision.model}`
        : undefined,
    }).toEqual({
      l2: 'openrouter:deepseek/deepseek-v3.2',
      l3: ['openrouter:z-ai/glm-5', 'openrouter:deepseek/deepseek-v3.2'],
      vision: 'openrouter:google/gemini-3.1-flash',
    });
  });

  it('providers.json stores an env ref, never the secret value', () => {
    const plan = makePlan();
    const providers = JSON.stringify(buildProvidersRegistry(plan));
    expect(providers).toContain('"envName":"OPENROUTER_API_KEY"');
    expect(providers).not.toContain('sk-or-secret-value');
  });
});

describe('declared chat fallback (asd4w)', () => {
  const kimi = {
    id: 'kimi-code',
    type: 'generic_openai',
    label: 'Kimi Code',
    apiBaseUrl: 'https://kimi.example.test/coding/v1',
    apiKeyEnvName: 'KIMI_CODE_API_KEY',
    apiKeyValue: 'kimi-secret',
  };

  function chatCandidates(registry: unknown): string[] {
    const { models } = registry as {
      models: Array<{ identity: { provider: string; model: string }; purposes: Array<{ purpose: string }> }>;
    };
    return models
      .filter((m) => m.purposes.some((p) => p.purpose === 'chat'))
      .map((m) => `${m.identity.provider}:${m.identity.model}`);
  }

  it('writes a second chat provider and a chat-fallback entry that pass the real contract guard', () => {
    const plan = makePlan({
      roots: freshRoot(false),
      provider: {
        id: 'glm-code',
        type: 'generic_openai',
        label: 'GLM Code Plan',
        apiBaseUrl: 'https://glm.example.test/coding/paas/v4',
        apiKeyEnvName: 'GLM_CODE_API_KEY',
        apiKeyValue: 'glm-secret',
      },
      models: { primaryModelSlug: 'glm-5.3', extractionModelSlug: 'glm-5.3', visionModelSlug: 'glm-v' },
      fallbackChat: { provider: kimi, modelSlug: 'kimi-for-coding' },
    });
    expect(() => stageAndValidate(plan)).not.toThrow();
    const providers = buildProvidersRegistry(plan) as { providers: Array<{ id: string }> };
    expect(providers.providers.map((p) => p.id)).toEqual(['glm-code', 'kimi-code']);
    expect(JSON.stringify(providers)).not.toContain('kimi-secret');
    const registry = buildModelsRegistry(plan) as {
      models: Array<{ id: string; apiKind?: string; purposes: Array<{ purpose: string; primary: boolean }> }>;
    };
    const fallback = registry.models.find((m) => m.id === 'chat-fallback');
    expect(fallback?.purposes).toEqual([{ purpose: 'chat', primary: false }]);
    expect(fallback?.apiKind).toBe('openai-completions');
    expect(chatCandidates(registry)).toContain('kimi-code:kimi-for-coding');
    expect(new Set(chatCandidates(registry).map((c) => c.split(':')[0]))).toEqual(
      new Set(['glm-code', 'kimi-code']),
    );
  });

  it('always declares at least two distinct chat candidates on a single provider', () => {
    const registry = buildModelsRegistry(makePlan());
    const candidates = chatCandidates(registry);
    expect(new Set(candidates).size).toBeGreaterThanOrEqual(2);
    expect(candidates).toContain('openrouter:moonshotai/kimi-k2.5');
  });

  it('refuses a fallback identical to the primary chat model', () => {
    const plan = makePlan();
    expect(() => buildModelsRegistry({
      ...plan,
      fallbackChat: { provider: plan.provider, modelSlug: plan.models.primaryModelSlug },
    })).toThrow(/single chat candidate/);
  });
});

describe('commit is abort-safe', () => {
  it('leaves zero files when validation fails (empty model slug)', () => {
    const roots = freshRoot(true);
    const plan = makePlan({
      roots,
      models: { primaryModelSlug: '', extractionModelSlug: 'x', visionModelSlug: 'z' },
    });
    expect(() => commitOwnerFiles(plan)).toThrow();
    // Fresh mode + validation-before-write => nothing landed.
    const present = existsSync(roots.systemDataDir) ? readdirSync(roots.systemDataDir) : [];
    expect(present.filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });
});

describe('idempotent re-run', () => {
  it('detects existing config and refuses a silent overwrite', () => {
    const roots = freshRoot(true);
    const plan = makePlan({ roots });
    const result = commitOwnerFiles(plan);
    expect(result.writtenPaths.length).toBeGreaterThan(0);

    const existing = detectExistingOwnerFiles(plan);
    expect(existing.length).toBeGreaterThan(0);

    // Second run without update confirmation must throw.
    expect(() => commitOwnerFiles(makePlan({ roots }))).toThrow(/refusing to overwrite/i);

    // With update confirmed, it overwrites and re-validates.
    const updated = makePlan({
      roots,
      updateExisting: true,
      models: {
        primaryModelSlug: 'z-ai/glm-5.1',
        extractionModelSlug: 'deepseek/deepseek-v3.2',
        visionModelSlug: 'google/gemini-3.1-flash',
      },
    });
    expect(() => commitOwnerFiles(updated)).not.toThrow();
    const models = JSON.parse(readFileSync(join(roots.systemDataDir, 'models.json'), 'utf-8')) as {
      models: Array<{ id: string; identity: { model: string } }>;
    };
    const primary = models.models.find((m) => m.id === 'primary');
    expect(primary?.identity.model).toBe('z-ai/glm-5.1');
    // No backup residue on success.
    const residue = readdirSync(roots.systemDataDir).filter((f) => f.includes('onboard-bak'));
    expect(residue).toHaveLength(0);
  });
});
