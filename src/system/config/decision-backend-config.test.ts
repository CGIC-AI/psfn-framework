import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSettings, saveSettings } from '../settings/io.js';
import { applySettings, getRuntimeSettingsSnapshot } from '../settings/runtime.js';
import { buildSettingsContractData } from './settings-contract.js';
import type { SubstrateConfig } from './runtime-config-contracts.js';
import {
  createDefaultDecisionBackendSettings,
  normalizeDecisionBackendSettings,
  resolveDecisionSiteMode,
} from './decision-backend-config.js';

function validSettings() {
  return {
    mode: 'shadow',
    localQuestionMode: 'per_question',
    jev: {
      model: 'typesafe/jev-1.13',
      expectedSnapshot: 'typesafe/jev-1.13-20260917',
      timeoutMs: 1_200,
      maxRequestChars: 80_000,
      pricing: { inputPer1MUsd: 0.04, outputPer1MUsd: 0.12, maxOutputTokens: 512 },
    },
    sites: {
      'participation.appraise': { mode: 'jev' },
      'memory.rerank': { enabled: true, topN: 50, latencyBudgetMs: 400, blendWeight: 0.5 },
    },
  };
}

describe('decisionBackend settings', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it('defaults every site to local', () => {
    const defaults = createDefaultDecisionBackendSettings();
    expect(defaults.mode).toBe('local');
    expect(resolveDecisionSiteMode(undefined, 'participation.appraise')).toBe('local');
    expect(resolveDecisionSiteMode(defaults, 'memory.rerank')).toBe('local');
  });

  it('lets a per-site mode override the global mode', () => {
    const settings = normalizeDecisionBackendSettings(validSettings());
    expect(resolveDecisionSiteMode(settings, 'participation.appraise')).toBe('jev');
    expect(resolveDecisionSiteMode(settings, 'room.ambiguity')).toBe('shadow');
  });

  it.each([
    ['a floating alias model', { jev: { ...validSettings().jev, model: '~typesafe/jev-latest' } }, /pinned Jev release/],
    ['a latest model', { jev: { ...validSettings().jev, model: 'typesafe/jev-latest' } }, /pinned Jev release/],
    ['a snapshot of another release', {
      jev: { ...validSettings().jev, expectedSnapshot: 'typesafe/jev-1.12-20260101' },
    }, /dated snapshot of typesafe\/jev-1.13/],
    ['an unknown site id', { sites: { 'cogsec.blind_review': { mode: 'jev' } } }, /expected one of/],
    ['an unknown mode', { mode: 'remote' }, /expected one of local, jev, shadow/],
    ['a negative Jev rate', {
      jev: { ...validSettings().jev, pricing: { ...validSettings().jev.pricing, inputPer1MUsd: -1 } },
    }, /inputPer1MUsd: expected a finite USD rate/],
    ['an unknown Jev pricing key', {
      jev: { ...validSettings().jev, pricing: { ...validSettings().jev.pricing, cachePer1MUsd: 1 } },
    }, /cachePer1MUsd/],
    ['a Jev output bound of zero', {
      jev: { ...validSettings().jev, pricing: { ...validSettings().jev.pricing, maxOutputTokens: 0 } },
    }, /maxOutputTokens/],
    ['an enabled site without its knobs', { sites: { 'room.ambiguity': { enabled: true } } }, /threshold: required/],
    ['an out-of-range threshold', { sites: { 'room.ambiguity': { enabled: true, threshold: 1.5 } } }, /0-1/],
    ['an unknown key', { extra: true }, /unknown keys: extra/],
  ])('rejects %s', (_label, patch, message) => {
    expect(() => normalizeDecisionBackendSettings({ ...validSettings(), ...patch })).toThrow(message);
  });

  it('is a structured object field of settings.json', () => {
    expect(buildSettingsContractData().fields.decisionBackend).toMatchObject({
      ownerFile: 'settings.json',
      type: 'object',
      scope: 'global',
    });
  });

  it('round-trips through settings.json, the runtime config and the snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-settings-decision-backend-'));
    roots.push(root);
    saveSettings(root, { decisionBackend: normalizeDecisionBackendSettings(validSettings()) });
    const loaded = loadSettings(root);
    expect(loaded.decisionBackend).toEqual(validSettings());

    const config = {} as SubstrateConfig;
    applySettings(config, loaded);
    expect(config.decisionBackend).toEqual(validSettings());
    expect(getRuntimeSettingsSnapshot(config).decisionBackend).toEqual(validSettings());
    expect(getRuntimeSettingsSnapshot({} as SubstrateConfig).decisionBackend)
      .toEqual(createDefaultDecisionBackendSettings());
  });

  it('refuses an invalid block on load', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-settings-decision-backend-invalid-'));
    roots.push(root);
    writeFileSync(join(root, 'settings.json'), JSON.stringify({
      decisionBackend: { ...validSettings(), jev: { ...validSettings().jev, model: '~typesafe/jev-latest' } },
    }), 'utf-8');
    expect(() => loadSettings(root)).toThrow(/pinned Jev release/);
  });
});
