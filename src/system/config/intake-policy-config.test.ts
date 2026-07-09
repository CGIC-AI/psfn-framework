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
  l2EscalationThresholdForTier,
  l2FailClosedActionForTier,
  loadIntakePolicyConfig,
  saveIntakePolicyConfig,
  shouldEscalateToL2,
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

  // ── L2 API screener policy (htm9.6) ──

  it('validates the L2 screener seed and covers every tier', () => {
    const policy = seedPolicy();
    expect(policy.l2Screener.model.length).toBeGreaterThan(0);
    expect(Object.keys(policy.l2Screener.escalationThresholdsByTier).sort())
      .toEqual([...INTAKE_SOURCE_RISK_TIERS].sort());
    expect(Object.keys(policy.l2Screener.failClosedActionByTier).sort())
      .toEqual([...INTAKE_SOURCE_RISK_TIERS].sort());
    // High-risk tiers quarantine; trusted falls back to L1 labels only.
    expect(l2FailClosedActionForTier(policy, 'untrusted')).toBe('quarantine');
    expect(l2FailClosedActionForTier(policy, 'hostile')).toBe('quarantine');
    expect(l2FailClosedActionForTier(policy, 'trusted')).toBe('l1_labels_only');
    expect(policy.l2Screener.timeoutMs).toBeGreaterThanOrEqual(1);
    expect(policy.l2Screener.maxContentChars).toBeGreaterThanOrEqual(1);
  });

  it('gates L2 escalation on per-tier thresholds and mandatory tiers', () => {
    const policy = seedPolicy();
    const trustedThreshold = l2EscalationThresholdForTier(policy, 'trusted');
    // Below-threshold trusted item takes the fast path (no L2).
    expect(shouldEscalateToL2(policy, 'trusted', trustedThreshold - 0.01)).toBe(false);
    // At/above threshold escalates.
    expect(shouldEscalateToL2(policy, 'trusted', trustedThreshold)).toBe(true);
    // Hostile is mandatory: escalates even at zero prior score.
    expect(policy.l2Screener.mandatoryTiers).toContain('hostile');
    expect(shouldEscalateToL2(policy, 'hostile', 0)).toBe(true);
  });

  it('fails closed on an unmapped L2 tier and unknown L2 keys', () => {
    const policy = seedPolicy();
    const { trusted: _dropped, ...partialThresholds } = policy.l2Screener.escalationThresholdsByTier;
    expect(() => validateIntakePolicy(
      { ...policy, l2Screener: { ...policy.l2Screener, escalationThresholdsByTier: partialThresholds } },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/l2Screener\.escalationThresholdsByTier\.trusted is required/);

    expect(() => validateIntakePolicy(
      { ...policy, l2Screener: { ...policy.l2Screener, retries: 3 } },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/l2Screener has unsupported keys: retries/);

    expect(() => validateIntakePolicy(
      { ...policy, l2Screener: { ...policy.l2Screener, model: '' } },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/l2Screener\.model must be a non-empty string/);

    expect(() => validateIntakePolicy(
      {
        ...policy,
        l2Screener: {
          ...policy.l2Screener,
          failClosedActionByTier: { ...policy.l2Screener.failClosedActionByTier, untrusted: 'pass' },
        },
      },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/l2Screener\.failClosedActionByTier\.untrusted must be one of/);

    expect(() => validateIntakePolicy(
      { ...policy, l2Screener: { ...policy.l2Screener, mandatoryTiers: ['galaxy'] } },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/mandatoryTiers contains unsupported tier 'galaxy'/);
  });

  it('fails closed when the L2 screener block is missing entirely', () => {
    const policy = seedPolicy();
    const { l2Screener: _dropped, ...withoutL2 } = policy;
    expect(() => validateIntakePolicy(withoutL2, INTAKE_POLICY_FILE_NAME))
      .toThrow(/l2Screener must be an object/);
  });
});
