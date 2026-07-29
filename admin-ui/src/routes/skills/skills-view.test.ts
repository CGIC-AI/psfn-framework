import { describe, expect, it } from 'vitest';
import type { SkillRootScan } from '$lib/types';
import {
  buildSkillRootViews,
  findManagedSkillRecord,
  formatMissingSkillRoot,
} from './skills-view';

describe('managed skill content projection', () => {
  it('returns bounded managed content for an included skill name', () => {
    const managedSkill = {
      name: 'operator-notes',
      description: 'Operator-managed instructions',
      category: 'operator',
      version: 3,
      content: '# Exact managed body',
      createdAt: '2026-07-28T12:00:00.000Z',
      updatedAt: '2026-07-29T12:00:00.000Z',
    };

    expect(findManagedSkillRecord([managedSkill], 'OPERATOR-NOTES')?.content)
      .toBe('# Exact managed body');
  });
});

describe('skills missing-root degradation', () => {
  it('names the exact missing root while leaving each root independently reportable', () => {
    const root: SkillRootScan = {
      path: 'skills',
      absolutePath: '/app/skills',
      exists: false,
      skillCount: 0,
      source: 'bundled',
      precedence: 1,
    };

    expect(formatMissingSkillRoot(root))
      .toBe('Skills root is missing on disk and cannot contribute skills: /app/skills');
  });

  it('describes an absent managed root as an expected lazy-created directory', () => {
    const root: SkillRootScan = {
      path: '/runtime/workspaces/personal/companion-a/skills',
      absolutePath: '/runtime/workspaces/personal/companion-a/skills',
      exists: false,
      skillCount: 0,
      source: 'custom',
      precedence: 0,
    };

    expect(formatMissingSkillRoot(root))
      .toBe(
        'Managed skills directory will be created when needed: '
        + '/runtime/workspaces/personal/companion-a/skills',
      );
  });

  it('keeps available roots visible when another root is missing', () => {
    const roots: SkillRootScan[] = [
      {
        path: 'skills',
        absolutePath: '/app/skills',
        exists: false,
        skillCount: 0,
        source: 'bundled',
        precedence: 1,
      },
      {
        path: '/runtime/workspaces/personal/companion-a/skills',
        absolutePath: '/runtime/workspaces/personal/companion-a/skills',
        exists: true,
        skillCount: 1,
        source: 'custom',
        precedence: 0,
      },
    ];

    const views = buildSkillRootViews(roots);

    expect(views).toHaveLength(2);
    expect(views[0]?.degradationMessage).toContain('/app/skills');
    expect(views[1]).toEqual({ root: roots[1] });
  });
});
