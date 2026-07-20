import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CapabilityRuntime } from './runtime.js';
import { CAPABILITY_TIER_FILE_NAME, CAPABILITY_TIER_SEED_FILE_NAME, saveCapabilityTierConfig } from '../config/capability-tier-config.js';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

describe('CapabilityRuntime', () => {
  it('fails closed when capability-tier.json is missing', () => {
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

      expect(() => new CapabilityRuntime({
        dataDir,
        seedDir,
      })).toThrow('Missing required JSON owner file');
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
      writeJson(join(dataDir, CAPABILITY_TIER_FILE_NAME), {
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

  it('snapshots tier, custom tokens, and granted tokens from one coherent owner read (mus2.1)', () => {
    const root = mkdtempSync(join(tmpdir(), 'cap-runtime-snapshot-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'seed');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });

    try {
      writeJson(join(seedDir, CAPABILITY_TIER_SEED_FILE_NAME), {
        tier: 'nursery',
        customTokens: [],
      });
      writeJson(join(dataDir, CAPABILITY_TIER_FILE_NAME), {
        tier: 'custom',
        customTokens: ['world.read', 'identity.read', 'shard.spawn'],
      });

      const runtime = new CapabilityRuntime({ dataDir, seedDir });
      const snapshot = runtime.snapshotOwnerGrant();

      // Coherence: tier, authoritative custom tokens, and effective grant all
      // come from the same parsed owner value (canonical order), so a custom
      // owner can never pair with tokens from another file version.
      expect(snapshot.tier).toBe('custom');
      expect(snapshot.customTokens).toEqual(['identity.read', 'shard.spawn', 'world.read']);
      expect(snapshot.grantedTokens).toEqual(snapshot.customTokens);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.customTokens)).toBe(true);
      expect(Object.isFrozen(snapshot.grantedTokens)).toBe(true);

      // Owner churn after the snapshot never rewrites the taken snapshot; a
      // NEW snapshot reflects the new content in full, not a mixture.
      saveCapabilityTierConfig(dataDir, {
        tier: 'apprentice',
        customTokens: [],
      });
      expect(snapshot.tier).toBe('custom');
      expect(snapshot.grantedTokens).toEqual(['identity.read', 'shard.spawn', 'world.read']);

      const next = runtime.snapshotOwnerGrant();
      expect(next.tier).toBe('apprentice');
      expect(next.customTokens).toEqual([]);
      expect(next.grantedTokens).toContain('shard.spawn');
      expect(next.grantedTokens).not.toContain('git.write');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('produces identical snapshots across independent runtimes reading equal owner content', () => {
    const root = mkdtempSync(join(tmpdir(), 'cap-runtime-snapshot-eq-'));
    const dirs = [join(root, 'a'), join(root, 'b')];
    const seedDir = join(root, 'seed');
    mkdirSync(seedDir, { recursive: true });
    writeJson(join(seedDir, CAPABILITY_TIER_SEED_FILE_NAME), {
      tier: 'nursery',
      customTokens: [],
    });

    try {
      for (const dir of dirs) {
        mkdirSync(dir, { recursive: true });
        writeJson(join(dir, CAPABILITY_TIER_FILE_NAME), {
          tier: 'custom',
          customTokens: ['shard.spawn', 'identity.read'],
        });
      }
      const [a, b] = dirs.map(dir => new CapabilityRuntime({ dataDir: dir, seedDir }).snapshotOwnerGrant());
      // Content-equal owners snapshot identically regardless of path/mtime —
      // the cross-process precondition for stable owner versions and digests.
      expect(a).toEqual(b);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
