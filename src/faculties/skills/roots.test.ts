import { describe, expect, it } from 'vitest';
import { resolvePersonalSkillsDir } from '../../persistence/layout.js';
import type { SkillsRuntimeConfig } from '../../system/config/skills-config.js';
import { resolveSkillDirectories } from './loader.js';

const SKILLS_CONFIG: SkillsRuntimeConfig = {
  enabled: true,
  directories: ['skills'],
  extraDirectories: [],
  maxLoadedSkills: 32,
  maxSkillChars: 24_000,
  disabledSkills: [],
};

describe('fleet skill roots', () => {
  it('keeps shipped global skills under the image and personal skills under the companion workspace', () => {
    const companionId = '11111111-1111-4111-8111-111111111111';
    const fleetWorkspace = `/runtime/workspaces/personal/${companionId}`;

    expect(resolveSkillDirectories(SKILLS_CONFIG, '/app')[0]).toMatchObject({
      absolutePath: '/app/skills',
      relativePath: 'skills',
      source: 'bundled',
    });
    expect(resolvePersonalSkillsDir(fleetWorkspace))
      .toBe(`${fleetWorkspace}/skills`);
  });
});
