import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INTAKE_SINKS,
  INTAKE_SOURCE_CLASSES,
  INTAKE_SOURCE_RISK_TIERS,
} from '../../shared/contracts/intake-envelope.js';
import {
  INTAKE_POLICY_FILE_NAME,
  INTAKE_POLICY_SEED_FILE_NAME,
  INTAKE_SOURCE_LIST_NAMES,
  applyIntakeSourceListMutation,
  injectionScoreThresholdForTier,
  normalizeIntakePersonPattern,
  normalizeIntakeSitePattern,
  isL3MandatoryTier,
  l2EscalationThresholdForTier,
  l2FailClosedActionForTier,
  l3EscalationConfidenceThresholdForTier,
  loadIntakePolicyConfig,
  saveIntakePolicyConfig,
  shouldEscalateToL2,
  sinkRuleForSink,
  trifectaEnforcementForTier,
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

  // ── Slow-poisoning drift detection (htm9.14) ──

  it('validates the driftDetection seed section', () => {
    const policy = seedPolicy();
    expect(policy.driftDetection.enabled).toBe(true);
    expect(policy.driftDetection.valenceVelocity.shortWindowPoints).toBeGreaterThanOrEqual(1);
    expect(policy.driftDetection.valenceVelocity.velocitySigmaThreshold).toBeGreaterThan(0);
    expect(policy.driftDetection.memoryWriteRate.burstMultiplier).toBeGreaterThan(0);
    expect(policy.driftDetection.labelFrequency.minCount).toBeGreaterThanOrEqual(1);
    expect(policy.driftDetection.retrievalShare.maxLowTrustShare).toBeLessThanOrEqual(1);
  });

  it('fails closed on missing, unknown-keyed, or malformed driftDetection config', () => {
    const policy = seedPolicy();
    const { driftDetection: _dropped, ...withoutDrift } = policy;
    expect(() => validateIntakePolicy(withoutDrift, INTAKE_POLICY_FILE_NAME))
      .toThrow(/driftDetection must be an object/);
    expect(() => validateIntakePolicy(
      { ...policy, driftDetection: { ...policy.driftDetection, autoRemediate: true } },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/driftDetection has unsupported keys: autoRemediate/);
    expect(() => validateIntakePolicy(
      {
        ...policy,
        driftDetection: {
          ...policy.driftDetection,
          valenceVelocity: { ...policy.driftDetection.valenceVelocity, velocitySigmaThreshold: 0 },
        },
      },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/velocitySigmaThreshold must be a finite number > 0/);
    expect(() => validateIntakePolicy(
      {
        ...policy,
        driftDetection: {
          ...policy.driftDetection,
          valenceVelocity: { ...policy.driftDetection.valenceVelocity, monotonicityMin: 1.5 },
        },
      },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/monotonicityMin must be a finite number in \[0, 1\]/);
    expect(() => validateIntakePolicy(
      { ...policy, driftDetection: { ...policy.driftDetection, enabled: 'yes' } },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/driftDetection\.enabled must be a boolean/);
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

  // ── Vision intake screener policy (htm9.8) ──

  it('validates the vision screener seed: enabled, multimodal model, call knobs', () => {
    const policy = seedPolicy();
    expect(policy.visionScreener.enabled).toBe(true);
    expect(policy.visionScreener.model.length).toBeGreaterThan(0);
    expect(policy.visionScreener.timeoutMs).toBeGreaterThanOrEqual(1);
    expect(policy.visionScreener.maxOutputTokens).toBeGreaterThanOrEqual(1);
  });

  it('fails closed when the vision screener block is missing entirely', () => {
    const policy = seedPolicy();
    const { visionScreener: _dropped, ...withoutVision } = policy;
    expect(() => validateIntakePolicy(withoutVision, INTAKE_POLICY_FILE_NAME))
      .toThrow(/visionScreener must be an object/);
  });

  it('rejects a vision screener block with unknown keys, missing enabled, or bad knobs', () => {
    const policy = seedPolicy();
    expect(() => validateIntakePolicy(
      { ...policy, visionScreener: { ...policy.visionScreener, ocrEngine: 'tesseract' } },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/visionScreener has unsupported keys: ocrEngine/);

    const { enabled: _enabled, ...withoutEnabled } = policy.visionScreener;
    expect(() => validateIntakePolicy(
      { ...policy, visionScreener: withoutEnabled },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/visionScreener\.enabled must be a boolean/);

    expect(() => validateIntakePolicy(
      { ...policy, visionScreener: { ...policy.visionScreener, model: '  ' } },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/visionScreener\.model must be a non-empty string/);

    expect(() => validateIntakePolicy(
      { ...policy, visionScreener: { ...policy.visionScreener, timeoutMs: 0 } },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/visionScreener\.timeoutMs must be an integer >= 1/);
  });

  it('fails closed when the L2 screener block is missing entirely', () => {
    const policy = seedPolicy();
    const { l2Screener: _dropped, ...withoutL2 } = policy;
    expect(() => validateIntakePolicy(withoutL2, INTAKE_POLICY_FILE_NAME))
      .toThrow(/l2Screener must be an object/);
  });

  // ── L3 heavy escalation screener policy (htm9.7) ──

  it('validates the L3 screener seed: single-verdict default, every tier covered, hostile mandatory', () => {
    const policy = seedPolicy();
    expect(policy.l3Screener.model.length).toBeGreaterThan(0);
    // Dual-vs-single knob defaults to single; measure before enabling dual.
    expect(policy.l3Screener.dualModel).toBe(false);
    expect(policy.l3Screener.secondaryModel).toBeNull();
    expect(Object.keys(policy.l3Screener.escalationConfidenceThresholdsByTier).sort())
      .toEqual([...INTAKE_SOURCE_RISK_TIERS].sort());
    // Riskier tiers must not escalate LESS eagerly than safer tiers.
    const thresholds = policy.l3Screener.escalationConfidenceThresholdsByTier;
    expect(thresholds.hostile).toBeLessThanOrEqual(thresholds.untrusted);
    expect(thresholds.untrusted).toBeLessThanOrEqual(thresholds.standard);
    expect(thresholds.standard).toBeLessThanOrEqual(thresholds.trusted);
    expect(policy.l3Screener.mandatoryTiers).toContain('hostile');
    expect(isL3MandatoryTier(policy, 'hostile')).toBe(true);
    expect(isL3MandatoryTier(policy, 'trusted')).toBe(false);
    expect(l3EscalationConfidenceThresholdForTier(policy, 'hostile')).toBe(thresholds.hostile);
    expect(policy.l3Screener.timeoutMs).toBeGreaterThanOrEqual(1);
    expect(policy.l3Screener.maxContentChars).toBeGreaterThanOrEqual(1);
    expect(policy.l3Screener.maxOutputTokens).toBeGreaterThanOrEqual(1);
  });

  it('accepts a valid dual-model L3 configuration', () => {
    const policy = seedPolicy();
    const dual = validateIntakePolicy(
      {
        ...policy,
        l3Screener: {
          ...policy.l3Screener,
          dualModel: true,
          secondaryModel: 'moonshotai/kimi-k2',
        },
      },
      INTAKE_POLICY_FILE_NAME,
    );
    expect(dual.l3Screener.dualModel).toBe(true);
    expect(dual.l3Screener.secondaryModel).toBe('moonshotai/kimi-k2');
  });

  it('fails closed on incoherent dual-model L3 configurations', () => {
    const policy = seedPolicy();
    // dualModel without a second model.
    expect(() => validateIntakePolicy(
      { ...policy, l3Screener: { ...policy.l3Screener, dualModel: true } },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/dualModel=true requires a non-null l3Screener\.secondaryModel/);
    // Two "independent" verdicts from the same model are not independent.
    expect(() => validateIntakePolicy(
      {
        ...policy,
        l3Screener: {
          ...policy.l3Screener,
          dualModel: true,
          secondaryModel: policy.l3Screener.model,
        },
      },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/must be a DIFFERENT model/);
    // The knob itself must be explicit.
    const { dualModel: _dropped, ...withoutKnob } = policy.l3Screener;
    expect(() => validateIntakePolicy(
      { ...policy, l3Screener: withoutKnob },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/dualModel must be a boolean/);
    const { secondaryModel: _dropped2, ...withoutSecondary } = policy.l3Screener;
    expect(() => validateIntakePolicy(
      { ...policy, l3Screener: withoutSecondary },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/secondaryModel is required/);
  });

  it('fails closed on unmapped L3 tiers, unknown keys, and a missing L3 block', () => {
    const policy = seedPolicy();
    const { trusted: _dropped, ...partial } = policy.l3Screener.escalationConfidenceThresholdsByTier;
    expect(() => validateIntakePolicy(
      {
        ...policy,
        l3Screener: { ...policy.l3Screener, escalationConfidenceThresholdsByTier: partial },
      },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/l3Screener\.escalationConfidenceThresholdsByTier\.trusted is required/);

    expect(() => validateIntakePolicy(
      { ...policy, l3Screener: { ...policy.l3Screener, retries: 2 } },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/l3Screener has unsupported keys: retries/);

    expect(() => validateIntakePolicy(
      { ...policy, l3Screener: { ...policy.l3Screener, mandatoryTiers: ['galaxy'] } },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/l3Screener\.mandatoryTiers contains unsupported tier 'galaxy'/);

    const { l3Screener: _droppedL3, ...withoutL3 } = policy;
    expect(() => validateIntakePolicy(withoutL3, INTAKE_POLICY_FILE_NAME))
      .toThrow(/l3Screener must be an object/);
  });

  it('validates the sink-gate seed: every sink mapped, explicit unscreened defaults, trifecta tiers (htm9.3)', () => {
    const policy = seedPolicy();
    expect(Object.keys(policy.sinkGates.sinks).sort()).toEqual([...INTAKE_SINKS].sort());
    for (const sink of INTAKE_SINKS) {
      const rule = sinkRuleForSink(policy, sink);
      expect(INTAKE_SOURCE_RISK_TIERS).toContain(rule.maxSourceRiskTier);
      expect(['allow', 'deny']).toContain(rule.unscreened);
    }
    // Inform-not-instruct: state-mutation sinks cap below the inform sinks.
    expect(policy.sinkGates.sinks.persona_mutation.maxSourceRiskTier).toBe('standard');
    expect(policy.sinkGates.sinks.trust_mutation.maxSourceRiskTier).toBe('standard');
    expect(policy.sinkGates.sinks.prompt_assembly.maxSourceRiskTier).toBe('hostile');
    // Trifecta: hard for public/untrusted sources, soft for trusted sources.
    expect(Object.keys(policy.sinkGates.trifecta.enforcementByTier).sort())
      .toEqual([...INTAKE_SOURCE_RISK_TIERS].sort());
    expect(trifectaEnforcementForTier(policy, 'untrusted')).toBe('hard');
    expect(trifectaEnforcementForTier(policy, 'hostile')).toBe('hard');
    expect(trifectaEnforcementForTier(policy, 'trusted')).toBe('soft');
  });

  it('fails closed on missing/unknown sink-gate config (htm9.3)', () => {
    const policy = seedPolicy();

    const { sinkGates: _dropped, ...withoutSinkGates } = policy;
    expect(() => validateIntakePolicy(withoutSinkGates, INTAKE_POLICY_FILE_NAME))
      .toThrow(/sinkGates must be an object/);

    const { memory_write: _sink, ...partialSinks } = policy.sinkGates.sinks;
    expect(() => validateIntakePolicy(
      { ...policy, sinkGates: { ...policy.sinkGates, sinks: partialSinks } },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/sinkGates\.sinks\.memory_write is required/);

    expect(() => validateIntakePolicy(
      {
        ...policy,
        sinkGates: {
          ...policy.sinkGates,
          sinks: { ...policy.sinkGates.sinks, side_channel: policy.sinkGates.sinks.memory_write },
        },
      },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/unsupported sinks: side_channel/);

    expect(() => validateIntakePolicy(
      {
        ...policy,
        sinkGates: {
          ...policy.sinkGates,
          sinks: {
            ...policy.sinkGates.sinks,
            memory_write: { ...policy.sinkGates.sinks.memory_write, denyRiskLabels: ['made/up_label'] },
          },
        },
      },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/unsupported risk label 'made\/up_label'/);

    expect(() => validateIntakePolicy(
      {
        ...policy,
        sinkGates: {
          ...policy.sinkGates,
          sinks: {
            ...policy.sinkGates.sinks,
            memory_write: { ...policy.sinkGates.sinks.memory_write, unscreened: 'maybe' },
          },
        },
      },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/unscreened must be one of: allow, deny/);

    const { untrusted: _tier, ...partialTrifecta } = policy.sinkGates.trifecta.enforcementByTier;
    expect(() => validateIntakePolicy(
      {
        ...policy,
        sinkGates: { ...policy.sinkGates, trifecta: { enforcementByTier: partialTrifecta } },
      },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/trifecta\.enforcementByTier\.untrusted is required/);
  });

  // ── htm9.13: sourceLists ──

  const listEntry = (pattern: string) => ({
    pattern,
    addedBy: 'operator',
    addedAt: 1_700_000_000_000,
  });

  function withLists(lists: Partial<IntakePolicyConfig['sourceLists']>): unknown {
    return {
      ...seedPolicy(),
      sourceLists: {
        trustedSites: [],
        deniedSites: [],
        trustedPeople: [],
        deniedPeople: [],
        ...lists,
      },
    };
  }

  it('validates the seed sourceLists (all four lists required, seeded empty)', () => {
    const policy = seedPolicy();
    for (const list of INTAKE_SOURCE_LIST_NAMES) {
      expect(policy.sourceLists[list]).toEqual([]);
    }

    const { trustedSites: _omitted, ...partial } = policy.sourceLists;
    expect(() => validateIntakePolicy(
      { ...policy, sourceLists: partial },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/sourceLists\.trustedSites is required/);
    expect(() => validateIntakePolicy(
      { ...seedPolicy(), sourceLists: undefined },
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/sourceLists must be an object/);
  });

  it('accepts exact hosts and *.suffix site patterns, normalized lowercase', () => {
    const policy = validateIntakePolicy(withLists({
      trustedSites: [listEntry('ArXiv.org'), listEntry('*.Example.Test')],
    }), INTAKE_POLICY_FILE_NAME);
    expect(policy.sourceLists.trustedSites.map((entry) => entry.pattern))
      .toEqual(['arxiv.org', '*.example.test']);
  });

  it('fails closed on malformed site patterns (no regex, schemes, ports, or paths)', () => {
    for (const bad of [
      'https://arxiv.org',
      'arxiv.org/path',
      'arxiv.org:443',
      'arxiv',
      '*.org.*',
      'a b.test',
      '.*\\.arxiv\\.org',
      '*.*.org',
      '',
    ]) {
      expect(
        () => validateIntakePolicy(withLists({ trustedSites: [listEntry(bad)] }), INTAKE_POLICY_FILE_NAME),
        `pattern ${JSON.stringify(bad)} must be rejected`,
      ).toThrow();
    }
  });

  it('fails closed on malformed person patterns and entry fields', () => {
    expect(() => validateIntakePolicy(
      withLists({ trustedPeople: [listEntry('contact id with spaces')] }),
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/whitespace or control characters/);
    expect(() => validateIntakePolicy(
      withLists({ trustedPeople: [{ pattern: 'contact:alice', addedBy: '', addedAt: 1 }] }),
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/addedBy/);
    expect(() => validateIntakePolicy(
      withLists({ trustedPeople: [{ pattern: 'contact:alice', addedBy: 'op', addedAt: -5 }] }),
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/addedAt/);
    expect(() => validateIntakePolicy(
      withLists({ trustedPeople: [{ pattern: 'contact:alice', addedBy: 'op', addedAt: 1, extra: true }] }),
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/unsupported keys/);
  });

  it('rejects duplicates within a list and trusted/denied contradictions', () => {
    expect(() => validateIntakePolicy(
      withLists({ trustedSites: [listEntry('arxiv.org'), listEntry('ARXIV.org')] }),
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/duplicate pattern/);
    expect(() => validateIntakePolicy(
      withLists({ trustedSites: [listEntry('arxiv.org')], deniedSites: [listEntry('arxiv.org')] }),
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/both trustedSites and deniedSites/);
    expect(() => validateIntakePolicy(
      withLists({ trustedPeople: [listEntry('contact:x')], deniedPeople: [listEntry('contact:x')] }),
      INTAKE_POLICY_FILE_NAME,
    )).toThrow(/both trustedPeople and deniedPeople/);
  });

  it('applyIntakeSourceListMutation adds, removes, and fails closed', () => {
    const base = seedPolicy();
    const added = applyIntakeSourceListMutation(base, {
      action: 'add',
      list: 'trustedSites',
      pattern: ' ArXiv.org ',
      note: 'preprint host',
      addedBy: 'operator',
      atMs: 1_720_000_000_000,
    });
    expect(added.sourceLists.trustedSites).toEqual([{
      pattern: 'arxiv.org',
      addedBy: 'operator',
      addedAt: 1_720_000_000_000,
      note: 'preprint host',
    }]);
    // The original config is untouched (pure).
    expect(base.sourceLists.trustedSites).toEqual([]);

    expect(() => applyIntakeSourceListMutation(added, {
      action: 'add', list: 'trustedSites', pattern: 'arxiv.org', addedBy: 'operator', atMs: 1,
    })).toThrow(/already contains/);
    expect(() => applyIntakeSourceListMutation(added, {
      action: 'add', list: 'deniedSites', pattern: 'arxiv.org', addedBy: 'operator', atMs: 1,
    })).toThrow(/both trustedSites and deniedSites/);
    expect(() => applyIntakeSourceListMutation(added, {
      action: 'add', list: 'trustedSites', pattern: 'not a host', addedBy: 'operator', atMs: 1,
    })).toThrow();
    expect(() => applyIntakeSourceListMutation(added, {
      action: 'remove', list: 'trustedSites', pattern: 'other.test', addedBy: 'operator', atMs: 1,
    })).toThrow(/does not contain/);

    const removed = applyIntakeSourceListMutation(added, {
      action: 'remove', list: 'trustedSites', pattern: 'arxiv.org', addedBy: 'operator', atMs: 1,
    });
    expect(removed.sourceLists.trustedSites).toEqual([]);
  });

  it('normalizers are exported for admin-route reuse and fail closed', () => {
    expect(normalizeIntakeSitePattern('*.Example.ORG')).toBe('*.example.org');
    expect(() => normalizeIntakeSitePattern('bad_host!.org')).toThrow();
    expect(normalizeIntakePersonPattern('contact:alice')).toBe('contact:alice');
    expect(() => normalizeIntakePersonPattern('a b')).toThrow();
  });
});
