import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    models: { primaryModelSlug: 'z-ai/glm-5', extractionModelSlug: 'deepseek/deepseek-v3.2' },
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
      models: { primaryModelSlug: 'gpt-5.4', extractionModelSlug: 'gpt-5.4-mini' },
    });
    expect(() => stageAndValidate(plan)).not.toThrow();
  });

  it('re-points both selected models and assigns vision to the chosen primary', () => {
    const plan = makePlan({
      provider: {
        id: 'anthropic',
        type: 'anthropic',
        label: 'Anthropic',
        apiBaseUrl: 'https://api.anthropic.com/v1',
        apiKeyEnvName: 'ANTHROPIC_API_KEY',
        apiKeyValue: 'sk-ant',
      },
      models: { primaryModelSlug: 'claude-x', extractionModelSlug: 'claude-y' },
    });
    const registry = buildModelsRegistry(plan) as {
      models: Array<{
        id: string;
        identity: { provider: string; model: string };
        purposes: Array<{ purpose: string; primary: boolean }>;
      }>;
    };
    expect(registry.models).toHaveLength(2);
    expect(registry.models.every((m) => m.identity.provider === 'anthropic')).toBe(true);
    expect(registry.models.map((m) => m.identity.model).sort()).toEqual(['claude-x', 'claude-y']);
    expect(registry.models.find((m) => m.id === 'primary')?.purposes).toContainEqual({
      purpose: 'vision',
      primary: true,
    });
  });

  it('providers.json stores an env ref, never the secret value', () => {
    const plan = makePlan();
    const providers = JSON.stringify(buildProvidersRegistry(plan));
    expect(providers).toContain('"envName":"OPENROUTER_API_KEY"');
    expect(providers).not.toContain('sk-or-secret-value');
  });
});

describe('commit is abort-safe', () => {
  it('leaves zero files when validation fails (empty model slug)', () => {
    const roots = freshRoot(true);
    const plan = makePlan({ roots, models: { primaryModelSlug: '', extractionModelSlug: 'x' } });
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
      models: { primaryModelSlug: 'z-ai/glm-5.1', extractionModelSlug: 'deepseek/deepseek-v3.2' },
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
