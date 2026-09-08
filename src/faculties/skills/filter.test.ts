import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SKILL_ELIGIBILITY_CONFIG,
  DEFAULT_SKILL_REUSE_CONFIG,
  type SkillsRuntimeConfig,
} from '../../system/config/skills-config.js';
import {
  createBinaryAvailabilityProbe,
  createSkillBinaryCheckLedger,
  evaluateSkillEligibility,
  filterEligibleSkills,
} from './filter.js';
import type { SkillEntry } from './types.js';

function makeConfig(overrides?: Partial<SkillsRuntimeConfig>): SkillsRuntimeConfig {
  return {
    enabled: true,
    directories: ['skills'],
    extraDirectories: [],
    maxLoadedSkills: 32,
    maxSkillChars: 24_000,
    disabledSkills: [],
    reuse: { ...DEFAULT_SKILL_REUSE_CONFIG },
    eligibility: { ...DEFAULT_SKILL_ELIGIBILITY_CONFIG },
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

  it('bounds binary checks across the whole collection, not just per skill', async () => {
    // Twelve skills x eight binaries = 96 checks if nothing bounds the
    // collection; every skill is comfortably inside the per-skill bound, so
    // only an aggregate ledger can stop the fan-out.
    const entries = Array.from({ length: 12 }, (_, entryIndex) => makeEntry({
      id: `bulk-${String(entryIndex)}`,
      name: `bulk-${String(entryIndex)}`,
      requires: {
        binaries: Array.from({ length: 8 }, (_, index) => `bin-${String(entryIndex)}-${String(index)}`),
        env: [],
        config: [],
      },
    }));

    let checks = 0;
    const filtered = await filterEligibleSkills(entries, {
      runtimeConfig: makeConfig(),
      environment: {},
      maxBinaryRequirements: 32,
      maxTotalBinaryChecks: 40,
      isBinaryAvailable: () => { checks += 1; return true; },
    });

    expect(checks).toBe(40);
    expect(filtered.eligible).toHaveLength(5);
    expect(filtered.skipped).toHaveLength(7);
    for (const record of filtered.skipped) {
      expect(record.reason).toMatch(/aggregate binary check budget exhausted: 8 declared, 0 remaining; none evaluated/);
    }
  });

  it('shares one ledger across every chunk of a single snapshot build', async () => {
    const entries = Array.from({ length: 6 }, (_, entryIndex) => makeEntry({
      id: `chunked-${String(entryIndex)}`,
      name: `chunked-${String(entryIndex)}`,
      requires: {
        binaries: [`chunk-bin-${String(entryIndex)}`],
        env: [],
        config: [],
      },
    }));

    let checks = 0;
    const ledger = createSkillBinaryCheckLedger(4);
    const results = [];
    for (let offset = 0; offset < entries.length; offset += 2) {
      results.push(await filterEligibleSkills(entries.slice(offset, offset + 2), {
        runtimeConfig: makeConfig(),
        environment: {},
        binaryCheckLedger: ledger,
        isBinaryAvailable: () => { checks += 1; return true; },
      }));
    }

    expect(checks).toBe(4);
    expect(ledger.remaining).toBe(0);
    expect(results.flatMap(result => result.eligible)).toHaveLength(4);
    expect(results.flatMap(result => result.skipped)).toHaveLength(2);
  });

  it('memoizes the PATH scan so lookups do not rescan PATH directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-binary-probe-'));
    try {
      const firstDir = join(root, 'bin-a');
      const secondDir = join(root, 'bin-b');
      mkdirSync(firstDir, { recursive: true });
      mkdirSync(secondDir, { recursive: true });
      const executable = join(secondDir, 'present-tool');
      writeFileSync(executable, '#!/bin/sh\nexit 0\n');
      chmodSync(executable, 0o755);

      const probe = createBinaryAvailabilityProbe({
        PATH: [firstDir, secondDir].join(delimiter),
      });

      const absent = Array.from({ length: 256 }, (_, index) => `absent-tool-${String(index)}`);
      for (const name of absent) {
        expect(await probe.isAvailable(name)).toBe(false);
      }
      for (let repeat = 0; repeat < 8; repeat += 1) {
        expect(await probe.isAvailable('present-tool')).toBe(true);
      }
      expect(await probe.isAvailable('missing-everywhere')).toBe(false);

      // Two PATH directories, listed once each, regardless of 265 lookups.
      expect(probe.stats.lookups).toBe(265);
      expect(probe.stats.directoryScans).toBe(2);
      // Only the one name that actually exists in a listing costs a syscall,
      // and it is answered from the memo on every repeat.
      expect(probe.stats.accessChecks).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still resolves a declared binary that carries a path separator', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-binary-probe-nested-'));
    try {
      const nested = join(root, 'tools');
      mkdirSync(nested, { recursive: true });
      const executable = join(nested, 'nested-tool');
      writeFileSync(executable, '#!/bin/sh\nexit 0\n');
      chmodSync(executable, 0o755);

      const probe = createBinaryAvailabilityProbe({ PATH: root });
      // A flat directory listing cannot answer this name, so the probe must
      // fall through to the direct access check rather than reporting missing.
      expect(await probe.isAvailable('tools/nested-tool')).toBe(true);
      expect(await probe.isAvailable('tools/absent-tool')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the availability predicate when a PATH directory cannot be listed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-binary-probe-fallback-'));
    try {
      const probe = createBinaryAvailabilityProbe({
        PATH: join(root, 'does-not-exist'),
      });
      expect(await probe.isAvailable('anything')).toBe(false);
      expect(probe.stats.directoryScans).toBe(1);
      expect(probe.stats.accessChecks).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
