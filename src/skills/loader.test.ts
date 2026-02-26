import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SkillsRuntimeConfig } from '../config/skills-config.js';
import {
  applySkillPrecedence,
  loadSkillEntries,
  parseSkillDocument,
  resolveSkillDirectories,
  scanSkillFiles,
} from './loader.js';

function makeConfig(overrides?: Partial<SkillsRuntimeConfig>): SkillsRuntimeConfig {
  return {
    enabled: true,
    directories: ['purrsephone/skills', 'skills'],
    extraDirectories: [],
    maxLoadedSkills: 32,
    maxSkillChars: 24_000,
    disabledSkills: [],
    ...overrides,
  };
}

function writeSkill(root: string, relativeDir: string, document: string): void {
  const directory = join(root, relativeDir);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), `${document.trim()}\n`, 'utf-8');
}

describe('skills loader', () => {
  it('parses SKILL.md frontmatter with typed requires structure', () => {
    const parsed = parseSkillDocument([
      '---',
      'name: git-ops',
      'description: Git workflow helpers',
      'always: true',
      'requires:',
      '  binaries:',
      '    - git',
      '  env:',
      '    - OPENROUTER_API_KEY',
      '  config:',
      '    - enabled',
      '---',
      '# Git Ops',
      'Use git tools safely.',
    ].join('\n'), 'skills/git-ops/SKILL.md');

    expect(parsed.frontmatter.name).toBe('git-ops');
    expect(parsed.frontmatter.description).toBe('Git workflow helpers');
    expect(parsed.frontmatter.always).toBe(true);
    expect(parsed.frontmatter.requires.binaries).toEqual(['git']);
    expect(parsed.frontmatter.requires.env).toEqual(['OPENROUTER_API_KEY']);
    expect(parsed.frontmatter.requires.config).toEqual(['enabled']);
    expect(parsed.body).toContain('Use git tools safely.');
  });

  it('parses optional category/version/timestamps from frontmatter', () => {
    const parsed = parseSkillDocument([
      '---',
      'name: incident-runbook',
      'description: Incident triage flow',
      'category: ops',
      'version: 4',
      'created: "2026-02-25T10:00:00.000Z"',
      'updated: "2026-02-26T11:00:00.000Z"',
      '---',
      '# Incident',
      'Escalate quickly.',
    ].join('\n'), 'data/skills/ops/incident-runbook/SKILL.md');

    expect(parsed.frontmatter.category).toBe('ops');
    expect(parsed.frontmatter.version).toBe(4);
    expect(parsed.frontmatter.createdAt).toBe('2026-02-25T10:00:00.000Z');
    expect(parsed.frontmatter.updatedAt).toBe('2026-02-26T11:00:00.000Z');
  });

  it('resolves precedence directories with defaults first and extras appended', () => {
    const directories = resolveSkillDirectories(
      makeConfig({
        directories: ['skills'],
        extraDirectories: ['vendor/skills'],
      }),
      '/repo',
    );

    expect(directories[0]?.relativePath).toBe('purrsephone/skills');
    expect(directories[1]?.relativePath).toBe('skills');
    expect(directories.at(-1)?.relativePath).toBe('vendor/skills');
  });

  it('keeps higher-precedence skill definitions when names collide', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-loader-'));
    try {
      writeSkill(root, 'purrsephone/skills/conversation', `
---
name: conversation
description: purrsephone override
---
# Purrsephone
`);
      writeSkill(root, 'skills/conversation', `
---
name: conversation
description: bundled version
---
# Bundled
`);

      const directories = resolveSkillDirectories(makeConfig(), root);
      const files = scanSkillFiles(directories);
      const loaded = loadSkillEntries(files);
      const deduped = applySkillPrecedence(loaded.entries);

      expect(files.length).toBe(2);
      expect(deduped.entries).toHaveLength(1);
      expect(deduped.entries[0]?.description).toBe('purrsephone override');
      expect(deduped.entries[0]?.relativePath).toContain('purrsephone/skills/conversation/SKILL.md');
      expect(deduped.skipped).toHaveLength(1);
      expect(deduped.skipped[0]?.kind).toBe('shadowed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
