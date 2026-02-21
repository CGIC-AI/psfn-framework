import { describe, expect, it } from 'vitest';
import { formatSkillsForPrompt } from './format.js';
import type { SkillEntry } from './types.js';

function makeEntry(
  name: string,
  overrides?: Partial<SkillEntry>,
): SkillEntry {
  return {
    id: `${name}@skills/${name}/SKILL.md`,
    name,
    description: `${name} description`,
    always: false,
    requires: {
      binaries: [],
      env: [],
      config: [],
    },
    content: `# ${name}\nDetailed instructions for ${name}.`,
    absolutePath: `/repo/skills/${name}/SKILL.md`,
    relativePath: `skills/${name}/SKILL.md`,
    source: 'bundled',
    precedence: 1,
    mtimeMs: 1,
    size: 1,
    ...overrides,
  };
}

describe('skills formatter', () => {
  it('formats XML with always skills prioritized and max count enforced', () => {
    const first = makeEntry('conversation', { always: true });
    const second = makeEntry('memory-management', { always: true });
    const third = makeEntry('git-ops');

    const formatted = formatSkillsForPrompt(
      [third, second, first],
      { maxSkills: 2, maxChars: 100_000 },
    );

    expect(formatted.included.map(skill => skill.name)).toEqual(['conversation', 'memory-management']);
    expect(formatted.excluded).toHaveLength(1);
    expect(formatted.excluded[0]?.reason).toContain('maxLoadedSkills');
    expect(formatted.xml).toContain('<skills>');
    expect(formatted.xml).toContain('conversation');
  });

  it('excludes skills when XML would exceed max char budget', () => {
    const formatted = formatSkillsForPrompt(
      [makeEntry('memory-management')],
      { maxSkills: 32, maxChars: 64 },
    );

    expect(formatted.included).toHaveLength(0);
    expect(formatted.excluded).toHaveLength(1);
    expect(formatted.excluded[0]?.reason).toContain('maxSkillChars');
    expect(formatted.xml).toBe('');
  });
});
