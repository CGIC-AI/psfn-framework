import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INTAKE_SOURCE_CLASSES,
  INTAKE_SOURCE_RISK_TIERS,
} from '../../shared/contracts/intake-envelope.js';
import {
  INTAKE_POLICY_FILE_NAME,
  INTAKE_POLICY_SEED_FILE_NAME,
  injectionScoreThresholdForTier,
  loadIntakePolicyConfig,
  saveIntakePolicyConfig,
  validateIntakePolicy,
  type IntakePolicyConfig,
} from './intake-policy-config.js';

describe('intake policy owner file', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-intake-policy-'));
    tempDirs.push(dir);
    return dir;
  }

  function seedPolicy(): IntakePolicyConfig {
    return validateIntakePolicy(
      JSON.parse(readFileSync(join(process.cwd(), 'config', INTAKE_POLICY_SEED_FILE_NAME), 'utf-8')),
      INTAKE_POLICY_SEED_FILE_NAME,
    );
  }

  it('validates the distributed seed and covers every source class', () => {
    const policy = seedPolicy();
    expect(policy.schemaVersion).toBe(1);
    expect(policy.mode).toBe('shadow');
    expect(Object.keys(policy.sourceRiskTiers).sort()).toEqual([...INTAKE_SOURCE_CLASSES].sort());
    expect(policy.quarantine.itemTtlHours).toBeGreaterThanOrEqual(1);
    expect(policy.quarantine.maxHeldItems).toBeGreaterThanOrEqual(1);
  });

  it('validates injection classifier thresholds in the seed and covers every tier', () => {
    const policy = seedPolicy();
    expect(policy.injectionClassifier.labelThreshold).toBeGreaterThan(0);
    expect(policy.injectionClassifier.labelThreshold).toBeLessThanOrEqual(1);
    expect(Object.keys(policy.injectionClassifier.scoreThresholdsByTier).sort())
      .toEqual([...INTAKE_SOURCE_RISK_TIERS].sort());
    // Riskier tiers must not be screened LESS sensitively than safer tiers.
    const thresholds = policy.injectionClassifier.scoreThresholdsByTier;
    expect(thresholds.hostile).toBeLessThanOrEqual(thresholds.untrusted);
    expect(thresholds.untrusted).toBeLessThanOrEqual(thresholds.standard);
    expect(thresholds.standard).toBeLessThanOrEqual(thresholds.trusted);
    expect(injectionScoreThresholdForTier(policy, 'hostile')).toBe(thresholds.hostile);
  });

  it('fails closed on missing or invalid injection classifier config', () => {
    const policy = seedPolicy();
    const { injectionClassifier: _dropped, ...withoutClassifier } = policy;
    expect(() => validateIntakePolicy(withoutClassifier, INTAKE_POLICY_FILE_NAME))
      .toThrow(/injectionClassifier must be an object/);

    const { trusted: _tier, ...partialTiers } = policy.injectionClassifier.scoreThresholdsByTier;
    expect(() => validateIntakePolicy(
      {
        ...policy,
        injectionClassifier: { ...policy.injectionClassifier, scoreThresholdsByTier: partialTiers },
      },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/scoreThresholdsByTier\.trusted is required/);

    expect(() => validateIntakePolicy(
      { ...policy, injectionClassifier: { ...policy.injectionClassifier, labelThreshold: 1.5 } },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/labelThreshold must be a finite number in \[0, 1\]/);

    expect(() => validateIntakePolicy(
      {
        ...policy,
        injectionClassifier: {
          ...policy.injectionClassifier,
          scoreThresholdsByTier: {
            ...policy.injectionClassifier.scoreThresholdsByTier,
            medium: 0.5,
          },
        },
      },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/scoreThresholdsByTier has unsupported tiers: medium/);

    expect(() => validateIntakePolicy(
      { ...policy, injectionClassifier: { ...policy.injectionClassifier, hardBlock: true } },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/injectionClassifier has unsupported keys: hardBlock/);
  });

  it('round-trips through save and load', () => {
    const dataDir = makeDataDir();
    const saved = saveIntakePolicyConfig(dataDir, seedPolicy());
    expect(loadIntakePolicyConfig(dataDir)).toEqual(saved);
  });

  it('fails closed when the owner file is missing, with example guidance', () => {
    const dataDir = makeDataDir();
    expect(() => loadIntakePolicyConfig(dataDir, { seedDir: './config' }))
      .toThrow(/Missing required JSON owner file .*intake-policy\.json/);
    expect(() => loadIntakePolicyConfig(dataDir, { seedDir: './config' }))
      .toThrow(new RegExp(INTAKE_POLICY_SEED_FILE_NAME.replace(/\./g, '\\.')));
  });

  it('fails closed on unmapped source classes (no implicit tier defaults)', () => {
    const policy = seedPolicy();
    const { web_fetch: _dropped, ...partialTiers } = policy.sourceRiskTiers;
    expect(() => validateIntakePolicy(
      { ...policy, sourceRiskTiers: partialTiers },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/sourceRiskTiers\.web_fetch is required/);
  });

  it('fails closed on unknown source classes, tiers, modes, and top-level keys', () => {
    const policy = seedPolicy();
    expect(() => validateIntakePolicy(
      { ...policy, sourceRiskTiers: { ...policy.sourceRiskTiers, rss_feed: 'untrusted' } },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/unsupported source classes: rss_feed/);
    expect(() => validateIntakePolicy(
      { ...policy, sourceRiskTiers: { ...policy.sourceRiskTiers, web_fetch: 'medium' } },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/sourceRiskTiers\.web_fetch must be one of/);
    expect(() => validateIntakePolicy(
      { ...policy, mode: 'audit' },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/mode must be one of/);
    expect(() => validateIntakePolicy(
      { ...policy, classifiers: {} },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/unsupported keys: classifiers/);
  });

  it('fails closed on invalid quarantine limits and corrupt files', () => {
    const policy = seedPolicy();
    expect(() => validateIntakePolicy(
      { ...policy, quarantine: { itemTtlHours: 0, maxHeldItems: 10 } },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/itemTtlHours must be an integer >= 1/);

    const dataDir = makeDataDir();
    writeFileSync(join(dataDir, INTAKE_POLICY_FILE_NAME), '{ not json', 'utf-8');
    expect(() => loadIntakePolicyConfig(dataDir)).toThrow(/Invalid JSON owner file/);
  });

  it('rejects invalid config on save (never writes a broken owner file)', () => {
    const dataDir = makeDataDir();
    expect(() => saveIntakePolicyConfig(dataDir, { schemaVersion: 2 }))
      .toThrow(/schemaVersion must be 1/);
    expect(() => loadIntakePolicyConfig(dataDir)).toThrow(/Missing required JSON owner file/);
  });
});
