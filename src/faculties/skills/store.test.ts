import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillStore } from './store.js';

describe('skill store', () => {
  it('creates and updates managed skills with YAML + Markdown format', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-store-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });

    let now = new Date('2026-02-26T10:00:00.000Z');
    const store = new SkillStore(dataDir, {
      repoRoot: root,
      now: () => now,
    });

    try {
      const created = store.create({
        name: 'deploy-checklist',
        category: 'ops',
        description: 'Repeatable deploy verification flow.',
        content: '# Deploy Checklist\n\n- Run tests\n- Build release',
      });

      expect(created.name).toBe('deploy-checklist');
      expect(created.category).toBe('ops');
      expect(created.version).toBe(1);
      expect(created.createdAt).toBe('2026-02-26T10:00:00.000Z');
      expect(created.updatedAt).toBe('2026-02-26T10:00:00.000Z');

      const documentPath = join(dataDir, 'skills', 'ops', 'deploy-checklist', 'SKILL.md');
      const rawDocument = readFileSync(documentPath, 'utf-8');
      expect(rawDocument).toContain('name: "deploy-checklist"');
      expect(rawDocument).toContain('category: "ops"');
      expect(rawDocument).toContain('version: 1');
      expect(rawDocument).toContain('- Run tests');

      now = new Date('2026-02-26T10:30:00.000Z');
      const updated = store.update({
        name: 'deploy-checklist',
        content: '# Deploy Checklist\n\n- Run tests\n- Build release\n- Verify canary',
      });

      expect(updated.version).toBe(2);
      expect(updated.createdAt).toBe('2026-02-26T10:00:00.000Z');
      expect(updated.updatedAt).toBe('2026-02-26T10:30:00.000Z');
      expect(updated.content).toContain('Verify canary');

      const listed = store.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]?.version).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unsafe names/categories and duplicate names', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-store-unsafe-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const store = new SkillStore(dataDir, { repoRoot: root });

    try {
      expect(() => store.create({
        name: '../escape',
        category: 'ops',
        content: 'body',
      })).toThrow(/invalid characters/i);

      expect(() => store.create({
        name: 'safe-name',
        category: '../ops',
        content: 'body',
      })).toThrow(/invalid characters/i);

      store.create({
        name: 'memory-playbook',
        category: 'memory',
        content: 'Remember to search historical context first.',
      });

      expect(() => store.create({
        name: 'memory-playbook',
        category: 'another',
        content: 'duplicate',
      })).toThrow(/already exists/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
