import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  loadCapabilityTierConfig,
  loadCapabilityTierSeedDefaults,
  saveCapabilityTierConfig,
  CAPABILITY_TIER_FILE_NAME,
  CAPABILITY_TIER_SEED_FILE_NAME,
} from './capability-tier-config.js';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

describe('capability-tier config', () => {
  it('fails closed when the owner file is missing', () => {
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

      expect(() => loadCapabilityTierConfig(dataDir, { seedDir })).toThrow(
        'Missing required JSON owner file',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads an explicit owner file without copying the seed', () => {
    const root = mkdtempSync(join(tmpdir(), 'capability-tier-config-explicit-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'seed');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });

    try {
      writeJson(join(seedDir, CAPABILITY_TIER_SEED_FILE_NAME), {
        tier: 'apprentice',
        customTokens: ['identity.read'],
      });
      writeJson(join(dataDir, CAPABILITY_TIER_FILE_NAME), {
        tier: 'custom',
        customTokens: ['git.read'],
      });

      expect(loadCapabilityTierConfig(dataDir, { seedDir })).toEqual({
        tier: 'custom',
        customTokens: ['git.read'],
        disabledTools: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads seed defaults without requiring a data directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'capability-tier-seed-defaults-'));
    const seedDir = join(root, 'seed');
    mkdirSync(seedDir, { recursive: true });

    try {
      writeJson(join(seedDir, CAPABILITY_TIER_SEED_FILE_NAME), {
        tier: 'custom',
        customTokens: ['identity.read', 'git.read', 'identity.read'],
      });

      expect(loadCapabilityTierSeedDefaults({ seedDir })).toEqual({
        tier: 'custom',
        customTokens: ['identity.read', 'git.read'],
        disabledTools: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults the repository seed to full capability (autonomous) with empty disabledTools', () => {
    expect(loadCapabilityTierSeedDefaults({ seedDir: './config' })).toEqual({
      tier: 'autonomous',
      customTokens: [],
      disabledTools: [],
    });
  });

  it('validates and saves custom tier token selections and disabledTools overrides', () => {
    const root = mkdtempSync(join(tmpdir(), 'capability-tier-save-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });

    try {
      const saved = saveCapabilityTierConfig(dataDir, {
        tier: 'custom',
        customTokens: ['identity.read', 'git.read', 'identity.read'],
        disabledTools: ['shell', 'web', 'shell', 'group_chat'],
      });

      expect(saved).toEqual({
        tier: 'custom',
        customTokens: ['identity.read', 'git.read'],
        disabledTools: ['shell', 'web', 'group_chat'],
      });

      const persisted = JSON.parse(readFileSync(join(dataDir, CAPABILITY_TIER_FILE_NAME), 'utf-8'));
      expect(persisted).toEqual(saved);
      expect(statSync(join(dataDir, CAPABILITY_TIER_FILE_NAME)).mode & 0o777).toBe(0o640);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unknown capability tokens, invalid disabledTools, and unknown keys fail-closed', () => {
    const root = mkdtempSync(join(tmpdir(), 'capability-tier-invalid-token-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });

    try {
      expect(() => saveCapabilityTierConfig(dataDir, {
        tier: 'custom',
        customTokens: ['identity.read', 'unknown.token'],
      })).toThrow('unknown token');

      expect(() => saveCapabilityTierConfig(dataDir, {
        tier: 'autonomous',
        customTokens: [],
        disabledTools: 'shell',
      })).toThrow('disabledTools must be an array');

      expect(() => saveCapabilityTierConfig(dataDir, {
        tier: 'autonomous',
        customTokens: [],
        disabledTools: [' shell '],
      })).toThrow('invalid tool name');

      expect(() => saveCapabilityTierConfig(dataDir, {
        tier: 'autonomous',
        customTokens: [],
        disabledTools: [''],
      })).toThrow('invalid tool name');

      expect(() => saveCapabilityTierConfig(dataDir, {
        tier: 'autonomous',
        customTokens: [],
        disabled_tools: ['shell'],
      })).toThrow('unknown key "disabled_tools"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
