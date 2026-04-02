import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillsRuntime } from './runtime.js';

function writeSkill(path: string, description: string, body: string): void {
  writeFileSync(path, [
    '---',
    'name: memory-management',
    `description: ${description}`,
    'always: true',
    '---',
    body,
    '',
  ].join('\n'), 'utf-8');
}

describe('skills runtime', () => {
  it('uses explicit repoRoot even when process cwd drifts', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-runtime-root-'));
    const launchCwd = mkdtempSync(join(tmpdir(), 'skills-runtime-cwd-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'config');
    const skillDir = join(root, 'skills', 'memory-management');

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });
    mkdirSync(skillDir, { recursive: true });

    writeFileSync(join(seedDir, 'skills.seed.json'), JSON.stringify({
      enabled: true,
      directories: ['companion/skills', 'skills'],
      extraDirectories: [],
      maxLoadedSkills: 32,
      maxSkillChars: 100_000,
      disabledSkills: [],
    }, null, 2));
    writeSkill(join(skillDir, 'SKILL.md'), 'cwd proof', '# Memory cwd-proof');

    const previousCwd = process.cwd();
    try {
      process.chdir(launchCwd);
      const runtime = new SkillsRuntime({
        dataDir,
        seedDir,
        repoRoot: root,
        isBinaryAvailable: () => true,
      });

      const snapshot = runtime.getSnapshot();
      expect(snapshot.includedSkills[0]?.description).toBe('cwd proof');
      expect(snapshot.includedSkills[0]?.relativePath).toContain('skills/memory-management/SKILL.md');
    } finally {
      process.chdir(previousCwd);
      rmSync(launchCwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('caches snapshots and invalidates when skill files change', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-runtime-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'config');
    const skillDir = join(root, 'skills', 'memory-management');

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });
    mkdirSync(skillDir, { recursive: true });

    writeFileSync(join(seedDir, 'skills.seed.json'), JSON.stringify({
      enabled: true,
      directories: ['companion/skills', 'skills'],
      extraDirectories: [],
      maxLoadedSkills: 32,
      maxSkillChars: 100_000,
      disabledSkills: [],
    }, null, 2));

    const skillPath = join(skillDir, 'SKILL.md');
    writeSkill(skillPath, 'first description', '# Memory v1');

    try {
      const runtime = new SkillsRuntime({
        dataDir,
        seedDir,
        repoRoot: root,
        isBinaryAvailable: () => true,
      });

      const snapshotOne = runtime.getSnapshot();
      const snapshotTwo = runtime.getSnapshot();
      expect(snapshotTwo).toBe(snapshotOne);
      expect(snapshotOne.includedSkills[0]?.description).toBe('first description');

      writeSkill(skillPath, 'second description', '# Memory v2');

      const snapshotThree = runtime.getSnapshot();
      expect(snapshotThree).not.toBe(snapshotOne);
      expect(snapshotThree.signature).not.toBe(snapshotOne.signature);
      expect(snapshotThree.includedSkills[0]?.description).toBe('second description');
      expect(snapshotThree.promptXml).toContain('<skills_index>');
      expect(snapshotThree.promptXml).toContain('second description');
      expect(snapshotThree.promptXml).not.toContain('Memory v2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports managed skill ownership under the companion data root', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-runtime-managed-root-'));
    const companionDataDir = join(root, 'companion-data');
    const seedDir = join(root, 'config');

    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });

    writeFileSync(join(seedDir, 'skills.seed.json'), JSON.stringify({
      enabled: true,
      directories: ['companion/skills', 'skills'],
      extraDirectories: [],
      maxLoadedSkills: 32,
      maxSkillChars: 100_000,
      disabledSkills: [],
    }, null, 2));

    try {
      const runtime = new SkillsRuntime({
        dataDir: companionDataDir,
        seedDir,
        repoRoot: root,
        isBinaryAvailable: () => true,
      });

      expect(runtime.getManagedOwnership()).toEqual({
        owner: 'companion',
        managedRoot: 'companion-data/skills',
        configPath: 'companion-data/skills.json',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
