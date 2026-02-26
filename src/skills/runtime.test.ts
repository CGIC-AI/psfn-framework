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
      directories: ['purrsephone/skills', 'skills'],
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
});
