import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PARTNER_AFFECT_SHADOW_FILE_NAME,
  loadPartnerAffectShadowConfig,
  savePartnerAffectShadowConfig,
  validatePartnerAffectShadowConfig,
} from './partner-affect-shadow-config.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-partner-affect-shadow-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: false,
    partnerContactId: null,
    staleAfterMs: 86_400_000,
    evidenceWindowMs: 259_200_000,
    minConfidence: 0.35,
    minIndependentFamilies: 2,
    conflictValueTolerance: 0.25,
    allowedSignalFamilies: ['self_report', 'conversation', 'sleep'],
    directions: { 'sleep.total_sleep_hours': 'lower_supports_need' },
    sources: [{
      sourceId: 'edge-sleep-1',
      families: ['sleep'],
      consentRef: 'consent-sleep-2026-01',
      sensitivity: 'relational_sensitive',
      revoked: false,
    }],
    maxRetainedObservations: 5_000,
    policyRevision: 'shadow-v1',
    ...overrides,
  };
}

describe('validatePartnerAffectShadowConfig', () => {
  it('accepts the seed defaults', () => {
    const seed = JSON.parse(
      readFileSync(join(process.cwd(), 'config', 'partner-affect-shadow.seed.json'), 'utf8'),
    ) as unknown;
    const policy = validatePartnerAffectShadowConfig(seed, 'seed');
    expect(policy.enabled).toBe(false);
    expect(policy.partnerContactId).toBeNull();
    expect(policy.sources).toEqual([]);
  });

  it('fails closed when enabled without a canonical partner binding', () => {
    expect(() => validatePartnerAffectShadowConfig(
      validConfig({ enabled: true, partnerContactId: null }),
      'test',
    )).toThrow(/enabled requires a non-null partnerContactId/);
  });

  it('accepts enabled with an exact partner binding', () => {
    const policy = validatePartnerAffectShadowConfig(
      validConfig({ enabled: true, partnerContactId: 'contact-partner-1' }),
      'test',
    );
    expect(policy.partnerContactId).toBe('contact-partner-1');
  });

  it.each([
    ['staleAfterMs', 0],
    ['evidenceWindowMs', -5],
    ['minIndependentFamilies', 0],
    ['maxRetainedObservations', 1.5],
    ['minConfidence', 1.2],
    ['conflictValueTolerance', -0.1],
    ['enabled', 'yes'],
    ['policyRevision', ''],
    ['allowedSignalFamilies', []],
    ['allowedSignalFamilies', ['astrology']],
    ['directions', { badkey: 'unknown' }],
    ['directions', { 'sleep.total_sleep_hours': 'sideways' }],
    ['sources', [{ sourceId: 's', families: [], consentRef: 'c', sensitivity: 'x', revoked: false }]],
    ['sources', [{ sourceId: 's', families: ['sleep'], consentRef: 'c', sensitivity: 'x' }]],
  ])('rejects invalid %s = %j', (field, value) => {
    expect(() => validatePartnerAffectShadowConfig(
      validConfig({ [field]: value }),
      'test',
    )).toThrow(/Invalid partner-affect-shadow config/);
  });

  it('rejects duplicate source registrations', () => {
    const source = {
      sourceId: 'edge-sleep-1',
      families: ['sleep'],
      consentRef: 'consent-a',
      sensitivity: 'relational_sensitive',
      revoked: false,
    };
    expect(() => validatePartnerAffectShadowConfig(
      validConfig({ sources: [source, source] }),
      'test',
    )).toThrow(/duplicate sourceId/);
  });
});

describe('load/save round trip', () => {
  it('fails closed when the owner file is missing and no seed exists', () => {
    const dataDir = tempDir();
    const emptySeedDir = tempDir();
    expect(() => loadPartnerAffectShadowConfig(dataDir, { seedDir: emptySeedDir }))
      .toThrow(/Missing required JSON owner file/);
  });

  it('saves validated config atomically and loads it back', () => {
    const dataDir = tempDir();
    const saved = savePartnerAffectShadowConfig(dataDir, validConfig());
    expect(saved.policyRevision).toBe('shadow-v1');
    const loaded = loadPartnerAffectShadowConfig(dataDir, { seedDir: tempDir() });
    expect(loaded).toEqual(saved);
  });

  it('rejects malformed owner-file content on save', () => {
    const dataDir = tempDir();
    expect(() => savePartnerAffectShadowConfig(dataDir, validConfig({ staleAfterMs: 'soon' })))
      .toThrow(/Invalid partner-affect-shadow config/);
  });

  it('rejects malformed persisted owner files on load', () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, PARTNER_AFFECT_SHADOW_FILE_NAME), '{"enabled": true}', 'utf8');
    expect(() => loadPartnerAffectShadowConfig(dataDir, { seedDir: tempDir() })).toThrow();
  });
});
