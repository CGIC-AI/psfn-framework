import { describe, expect, it } from 'vitest';
import {
  describeStartupOwnerFileChecks,
  OPTIONAL_WHEN_MISSING_OWNER_FILES,
} from '../src/system/config/startup-owner-files.js';
import {
  assertOwnerFileSeedParity,
  OWNER_FILE_SEEDS,
  verifyRepositoryOwnerFileSeeds,
} from './verify-startup-owner-files.js';

describe('verify-startup-owner-files parity', () => {
  it('OWNER_FILE_SEEDS is in parity with the guard checks', () => {
    expect(() => assertOwnerFileSeedParity()).not.toThrow();
  });

  it('stages every owner the guard requires when its file is missing', () => {
    const required = describeStartupOwnerFileChecks()
      .filter(check => !check.optionalWhenMissing)
      .map(check => check.ownerFileName)
      .sort();
    const staged = OWNER_FILE_SEEDS.map(([, owner]) => owner).sort();
    expect(staged).toEqual(required);
  });

  it('treats fleet-auth as the only optional-when-missing owner today, and never stages it', () => {
    expect([...OPTIONAL_WHEN_MISSING_OWNER_FILES]).toEqual(['fleet-auth.json']);
    expect(OWNER_FILE_SEEDS.map(([, owner]) => owner)).not.toContain('fleet-auth.json');
  });

  it('requires partner-affect-shadow and stages it (regression: psfn-framework-jxj0d)', () => {
    const partnerAffectShadow = describeStartupOwnerFileChecks().find(
      check => check.ownerFileName === 'partner-affect-shadow.json',
    );
    expect(partnerAffectShadow).toBeDefined();
    expect(partnerAffectShadow?.optionalWhenMissing).toBe(false);
    expect(OWNER_FILE_SEEDS.map(([, owner]) => owner)).toContain('partner-affect-shadow.json');
  });

  it('fails with a specific drift error when any required owner seed is dropped', () => {
    for (const dropped of OWNER_FILE_SEEDS) {
      const [, droppedOwner] = dropped;
      const reduced = OWNER_FILE_SEEDS.filter(pair => pair !== dropped);
      expect(() => assertOwnerFileSeedParity(reduced)).toThrowError(
        new RegExp(`drifted from verifyStartupOwnerFiles.*${droppedOwner.replace('.', '\\.')}`, 's'),
      );
    }
  });

  it('rejects a stale staged owner the guard never checks', () => {
    const withStale = [
      ...OWNER_FILE_SEEDS,
      ['ghost.seed.json', 'ghost.json'] as const,
    ];
    expect(() => assertOwnerFileSeedParity(withStale)).toThrowError(
      /runs no such owner check/,
    );
  });

  it('rejects a staged seed whose name disagrees with the guard', () => {
    const withMismatch = OWNER_FILE_SEEDS.map(pair =>
      pair[1] === 'settings.json'
        ? (['settings-wrong.seed.json', 'settings.json'] as const)
        : pair,
    );
    expect(() => assertOwnerFileSeedParity(withMismatch)).toThrowError(
      /expects seed settings\.seed\.json/,
    );
  });

  it('passes the full owner-file guard against the repository seeds', () => {
    const result = verifyRepositoryOwnerFileSeeds();
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
