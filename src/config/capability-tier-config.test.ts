import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  loadCapabilityTierConfig,
  saveCapabilityTierConfig,
  CAPABILITY_TIER_FILE_NAME,
  CAPABILITY_TIER_SEED_FILE_NAME,
} from './capability-tier-config.js';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

describe('capability-tier config', () => {
  it('loads from seed and persists data file when missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'capability-tier-config-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'seed');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });

    try {
      writeJson(join(seedDir, CAPABILITY_TIER_SEED_FILE_NAME), {
        tier: 'apprentice',
        customTokens: ['identity.read'],
      });

      const loaded = loadCapabilityTierConfig(dataDir, { seedDir });
      expect(loaded).toEqual({
        tier: 'apprentice',
        customTokens: ['identity.read'],
      });

      const persistedRaw = readFileSync(join(dataDir, CAPABILITY_TIER_FILE_NAME), 'utf-8');
      const persisted = JSON.parse(persistedRaw);
      expect(persisted).toEqual(loaded);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates and saves custom tier token selections', () => {
    const root = mkdtempSync(join(tmpdir(), 'capability-tier-save-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });

    try {
      const saved = saveCapabilityTierConfig(dataDir, {
        tier: 'custom',
        customTokens: ['identity.read', 'git.read', 'identity.read'],
      });

      expect(saved).toEqual({
        tier: 'custom',
        customTokens: ['identity.read', 'git.read'],
      });

      const persisted = JSON.parse(readFileSync(join(dataDir, CAPABILITY_TIER_FILE_NAME), 'utf-8'));
      expect(persisted).toEqual(saved);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unknown capability tokens', () => {
    const root = mkdtempSync(join(tmpdir(), 'capability-tier-invalid-token-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });

    try {
      expect(() => saveCapabilityTierConfig(dataDir, {
        tier: 'custom',
        customTokens: ['identity.read', 'unknown.token'],
      })).toThrow('unknown token');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
