import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { wireSkillsRuntime } from './runtime-wiring.js';

describe('skills runtime wiring', () => {
  it('attaches skills runtime and registers the unified skill tool', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-wire-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'config');

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(join(seedDir, 'skills.seed.json'), JSON.stringify({
      enabled: true,
      directories: ['skills'],
      extraDirectories: [],
      maxLoadedSkills: 32,
      maxSkillChars: 24_000,
      disabledSkills: [],
    }, null, 2));

    const registerTool = vi.fn();
    const target = {
      skillsRuntime: null,
      registerTool,
    };

    try {
      const runtime = wireSkillsRuntime(target, {
        dataDir,
        seedDir,
        repoRoot: root,
      });

      expect(runtime).toBe(target.skillsRuntime);
      expect(registerTool).toHaveBeenCalledTimes(1);
      expect(registerTool.mock.calls[0]?.[0]?.name).toBe('skill');
      expect(registerTool.mock.calls[0]?.[1]).toBe('core');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
