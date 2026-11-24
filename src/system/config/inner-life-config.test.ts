import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonicalModelRegistry } from '../../shared/contracts/runtime.js';
import { loadInnerLifeConfig } from './inner-life-config.js';

const SEED_FILES = [
  ['scheduler.seed.json', 'scheduler.json'],
  ['capability-tier.seed.json', 'capability-tier.json'],
  ['trust-policy.seed.json', 'trust-policy.json'],
  ['subagent-roles.seed.json', 'subagent-roles.json'],
  ['automata-policy.seed.json', 'automata-policy.json'],
  ['settings.seed.json', 'settings.json'],
] as const;

const TEST_MODEL_REGISTRY: CanonicalModelRegistry = {
  schemaVersion: 1,
  models: [
    {
      id: 'gpt-5.4-nano',
      rank: 10,
      identity: { provider: 'openai', model: 'gpt-5.4-nano', source: { type: 'openai' } },
      purposes: [{ purpose: 'background', primary: true }],
      capabilities: { maxOutputTokens: 4096, contextWindow: 128_000 },
      tuning: { maxOutputTokens: 4096, contextWindow: 128_000 },
    },
  ],
};

describe('loadInnerLifeConfig', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('loads all shipped seed inner-life policy files without reading models.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-inner-life-config-'));
    dirs.push(dir);
    const seedDir = resolve(process.cwd(), 'config');
    for (const [seedName, targetName] of SEED_FILES) {
      cpSync(join(seedDir, seedName), join(dir, targetName));
    }

    const loaded = loadInnerLifeConfig({
      dataDir: dir,
      seedDir,
      modelRegistry: TEST_MODEL_REGISTRY,
    });
    expect(loaded.capabilityTier.tier).toBeTruthy();
    expect(loaded.scheduler.tickIntervalMs).toBeGreaterThan(0);
    expect(loaded.trustPolicy.trustCeiling.primary).toContain('confidential');
    expect(loaded.automataPolicy.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(loaded.settings.memoryRetrievalPolicy).toBeDefined();
    expect(loaded.settings.biographicalDepthPolicy).toBeDefined();
  });

  it('fails closed when the automata reviewer model slot is absent from modelRegistry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-inner-life-missing-slot-'));
    dirs.push(dir);
    const seedDir = resolve(process.cwd(), 'config');
    for (const [seedName, targetName] of SEED_FILES) {
      cpSync(join(seedDir, seedName), join(dir, targetName));
    }

    expect(() => loadInnerLifeConfig({ dataDir: dir, seedDir })).toThrow(
      /automata-policy\.json\.bus\.reviewer\.model/,
    );
  });

  it('fails closed when a required policy file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-inner-life-missing-'));
    dirs.push(dir);
    expect(() => loadInnerLifeConfig({
      dataDir: dir,
      seedDir: resolve(process.cwd(), 'config'),
      modelRegistry: TEST_MODEL_REGISTRY,
    })).toThrow();
  });
});
