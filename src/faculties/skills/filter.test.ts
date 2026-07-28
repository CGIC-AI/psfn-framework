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
    absolutePath: '/repo/skills/git-ops/SKILL.md',
    relativePath: 'skills/git-ops/SKILL.md',
    source: 'bundled',
    precedence: 1,
    mtimeMs: 1,
    birthtimeMs: 1,
    size: 1,
    ...overrides,
  };
}

describe('skills eligibility filter', () => {
  it('marks skills ineligible for missing binary/env/config flags', async () => {
    const entry = makeEntry();
    const result = await evaluateSkillEligibility(entry, {
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

  it('marks disabled skills as ineligible', async () => {
    const entry = makeEntry({ name: 'conversation' });
    const filtered = await filterEligibleSkills([entry], {
      runtimeConfig: makeConfig({ disabledSkills: ['conversation'] }),
      environment: { OPENROUTER_API_KEY: 'set' },
      isBinaryAvailable: () => true,
    });

    expect(filtered.eligible).toHaveLength(0);
    expect(filtered.skipped).toHaveLength(1);
    expect(filtered.skipped[0]?.reason).toContain('disabled');
  });

  it('keeps eligible skills when all checks pass', async () => {
    const entry = makeEntry({
      requires: {
        binaries: ['git'],
        env: ['OPENROUTER_API_KEY'],
        config: ['enabled'],
      },
    });

    const filtered = await filterEligibleSkills([entry], {
      runtimeConfig: makeConfig(),
      environment: { OPENROUTER_API_KEY: 'set' },
      isBinaryAvailable: (binaryName) => binaryName === 'git',
    });

    expect(filtered.eligible).toHaveLength(1);
    expect(filtered.skipped).toHaveLength(0);
  });

  it('yields within one entry and fails closed above the binary requirement bound', async () => {
    const binaries = Array.from({ length: 128 }, (_, index) => `missing-${String(index)}`);
    let timerTicks = 0;
    const timer = setInterval(() => { timerTicks += 1; }, 0);
    const cooperative = await evaluateSkillEligibility(makeEntry({
      requires: { binaries: binaries.slice(0, 32), env: [], config: [] },
    }), {
      runtimeConfig: makeConfig(),
      maxBinaryRequirements: 32,
      isBinaryAvailable: async () => new Promise(resolve => setTimeout(() => resolve(false), 0)),
    }).finally(() => clearInterval(timer));
    let checks = 0;
    const bounded = await evaluateSkillEligibility(makeEntry({
      requires: { binaries: [...binaries, 'unverified'], env: [], config: [] },
    }), {
      runtimeConfig: makeConfig(),
      maxBinaryRequirements: 32,
      isBinaryAvailable: () => { checks += 1; return true; },
    });

    expect(timerTicks).toBeGreaterThan(2);
    expect(cooperative.missingBinaries).toEqual(binaries.slice(0, 32));
    expect(checks).toBe(0);
    expect(bounded.eligible).toBe(false);
    expect(bounded.reasons).toEqual([expect.stringMatching(/129 declared, maximum 32; none evaluated/)]);
  });
});
