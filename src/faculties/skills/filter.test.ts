import { describe, expect, it } from 'vitest';
import type { SkillsRuntimeConfig } from '../../system/config/skills-config.js';
import { evaluateSkillEligibility, filterEligibleSkills } from './filter.js';
import type { SkillEntry } from './types.js';

function makeConfig(overrides?: Partial<SkillsRuntimeConfig>): SkillsRuntimeConfig {
  return {
    enabled: true,
    directories: ['skills'],
    extraDirectories: [],
    maxLoadedSkills: 32,
    maxSkillChars: 24_000,
    disabledSkills: [],
    ...overrides,
  };
}

function makeEntry(overrides?: Partial<SkillEntry>): SkillEntry {
  return {
    id: 'git-ops@skills/git-ops/SKILL.md',
    name: 'git-ops',
    description: 'Git ops',
    always: false,
    requires: {
      binaries: ['git'],
      env: ['OPENROUTER_API_KEY'],
      config: ['enabled'],
    },
    content: '# Git Ops',
    absolutePath: '/repo/skills/git-ops/SKILL.md',
    relativePath: 'skills/git-ops/SKILL.md',
    source: 'bundled',
    precedence: 1,
    mtimeMs: 1,
    size: 1,
    ...overrides,
  };
}

describe('skills eligibility filter', () => {
  it('marks skills ineligible for missing binary/env/config flags', () => {
    const entry = makeEntry();
    const result = evaluateSkillEligibility(entry, {
      runtimeConfig: makeConfig({ enabled: false }),
      environment: {},
      isBinaryAvailable: () => false,
    });

    expect(result.eligible).toBe(false);
    expect(result.missingBinaries).toEqual(['git']);
    expect(result.missingEnv).toEqual(['OPENROUTER_API_KEY']);
    expect(result.missingConfig).toEqual(['enabled']);
    expect(result.reasons.join(' ')).toContain('skills runtime is disabled');
  });

  it('marks disabled skills as ineligible', () => {
    const entry = makeEntry({ name: 'conversation' });
    const filtered = filterEligibleSkills([entry], {
      runtimeConfig: makeConfig({ disabledSkills: ['conversation'] }),
      environment: { OPENROUTER_API_KEY: 'set' },
      isBinaryAvailable: () => true,
    });

    expect(filtered.eligible).toHaveLength(0);
    expect(filtered.skipped).toHaveLength(1);
    expect(filtered.skipped[0]?.reason).toContain('disabled');
  });

  it('keeps eligible skills when all checks pass', () => {
    const entry = makeEntry({
      requires: {
        binaries: ['git'],
        env: ['OPENROUTER_API_KEY'],
        config: ['enabled'],
      },
    });

    const filtered = filterEligibleSkills([entry], {
      runtimeConfig: makeConfig(),
      environment: { OPENROUTER_API_KEY: 'set' },
      isBinaryAvailable: (binaryName) => binaryName === 'git',
    });

    expect(filtered.eligible).toHaveLength(1);
    expect(filtered.skipped).toHaveLength(0);
  });
});
