import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSettings } from '../settings/io.js';
import { applySettings, getRuntimeSettingsSnapshot } from '../settings/runtime.js';
import { buildSettingsContractData } from './settings-contract.js';
import { backfillMissingRuntimeSettingsDefaults } from './settings-owner-backfill.js';
import { COMPANION_SETTINGS_OVERLAY_WHITELIST } from './settings-overlay.js';
import type { SubstrateConfig } from './runtime-config-contracts.js';
import {
  createDefaultReasoningEffortSettings,
  normalizeReasoningEffortSettings,
} from './reasoning-effort-config.js';

const SEED_DIR = resolve(import.meta.dirname, '../../../config');

describe('reasoningEffort settings', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function ownerDir(settings: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), 'psfn-settings-reasoning-effort-'));
    roots.push(root);
    writeFileSync(join(root, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
    return root;
  }

  it('defaults chat to low and every own-time lane to medium', () => {
    expect(createDefaultReasoningEffortSettings()).toEqual({
      chat: 'low',
      freeTime: 'medium',
      reflection: 'medium',
      selfDirected: 'medium',
    });
  });

  it('ships the contract default as the seed block', () => {
    const seed = JSON.parse(readFileSync(join(SEED_DIR, 'settings.seed.json'), 'utf-8')) as Record<string, unknown>;
    expect(seed.reasoningEffort).toEqual(createDefaultReasoningEffortSettings());
  });

  it('fills absent lanes from the default and keeps the owner\'s lanes', () => {
    expect(normalizeReasoningEffortSettings({ freeTime: 'xhigh', chat: ' Minimal ' })).toEqual({
      chat: 'minimal',
      freeTime: 'xhigh',
      reflection: 'medium',
      selfDirected: 'medium',
    });
  });

  it.each([
    ['an unknown lane', { dreams: 'high' }, /unknown keys: dreams/],
    ['an unknown level', { chat: 'max' }, /chat must be one of minimal, low, medium, high, xhigh/],
    ['off (the setting is a level, not a switch)', { freeTime: 'off' }, /freeTime must be one of/],
    ['a non-object', 'medium', /must be an object/],
  ])('rejects %s', (_label, value, message) => {
    expect(() => normalizeReasoningEffortSettings(value)).toThrow(message);
  });

  it('is a per-companion, Garden-exposed object field of settings.json', () => {
    expect(buildSettingsContractData().fields.reasoningEffort).toMatchObject({
      ownerFile: 'settings.json',
      type: 'object',
    });
    expect(COMPANION_SETTINGS_OVERLAY_WHITELIST).toContain('reasoningEffort');
  });

  it('keeps an existing owner file valid: the block is backfilled, nothing else changes', () => {
    const root = ownerDir({ retryMaxAttempts: 5 });
    const result = backfillMissingRuntimeSettingsDefaults({ dataDir: root, seedDir: SEED_DIR });
    expect(result.addedKeys).toContain('reasoningEffort');
    const written = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf-8')) as Record<string, unknown>;
    expect(written.retryMaxAttempts).toBe(5);
    expect(written.reasoningEffort).toEqual(createDefaultReasoningEffortSettings());
  });

  it('never overwrites an owner selection, even a partial one', () => {
    const root = ownerDir({ reasoningEffort: { freeTime: 'high' } });
    const result = backfillMissingRuntimeSettingsDefaults({ dataDir: root, seedDir: SEED_DIR });
    expect(result.addedKeys).not.toContain('reasoningEffort');
    const after = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf-8')) as Record<string, unknown>;
    // The owner's lane survives the rewrite; only the lanes it left out are filled.
    expect(after.reasoningEffort).toEqual({ ...createDefaultReasoningEffortSettings(), freeTime: 'high' });

    const config = {} as SubstrateConfig;
    applySettings(config, loadSettings(root));
    expect(config.reasoningEffort).toEqual({ ...createDefaultReasoningEffortSettings(), freeTime: 'high' });
    expect(getRuntimeSettingsSnapshot(config).reasoningEffort).toEqual(config.reasoningEffort);
  });

  it('refuses an invalid block on load', () => {
    const root = ownerDir({ reasoningEffort: { chat: 'turbo' } });
    expect(() => loadSettings(root)).toThrow(/reasoningEffort\.chat must be one of/);
  });
});
