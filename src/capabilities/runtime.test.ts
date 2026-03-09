import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CapabilityRuntime } from './runtime.js';
import { CAPABILITY_TIER_SEED_FILE_NAME, saveCapabilityTierConfig } from '../config/capability-tier-config.js';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

describe('CapabilityRuntime', () => {
  it('uses capability-tier seed defaults on first boot', () => {
    const root = mkdtempSync(join(tmpdir(), 'cap-runtime-fallback-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'seed');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });

    try {
      writeJson(join(seedDir, CAPABILITY_TIER_SEED_FILE_NAME), {
        tier: 'nursery',
        customTokens: [],
      });

      const runtime = new CapabilityRuntime({
        dataDir,
        seedDir,
      });

      expect(runtime.getTier()).toBe('nursery');
      expect(runtime.has('git.read')).toBe(true);
      expect(runtime.has('git.write')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('hot-reloads capability-tier.json from disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cap-runtime-reload-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'seed');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });

    try {
      writeJson(join(seedDir, CAPABILITY_TIER_SEED_FILE_NAME), {
        tier: 'nursery',
        customTokens: [],
      });

      const runtime = new CapabilityRuntime({ dataDir, seedDir });
      expect(runtime.getTier()).toBe('nursery');
      expect(runtime.has('memory.write')).toBe(true);

      saveCapabilityTierConfig(dataDir, {
        tier: 'custom',
        customTokens: ['git.read'],
      });
      await new Promise(resolve => setTimeout(resolve, 5));

      expect(runtime.getTier()).toBe('custom');
      expect(runtime.has('git.read')).toBe(true);
      expect(runtime.has('memory.write')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
