import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectDestructiveSkillContentReplace,
  SkillStore,
  SkillVersionConflictError,
} from './store.js';

const AGENT = { updatedBy: 'agent' } as const;

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
      }, AGENT);

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
      }, AGENT);

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
      }, AGENT)).toThrow(/invalid characters/i);

      expect(() => store.create({
        name: 'safe-name',
        category: '../ops',
        content: 'body',
      }, AGENT)).toThrow(/invalid characters/i);

      store.create({
        name: 'memory-playbook',
        category: 'memory',
        content: 'Remember to search historical context first.',
      }, AGENT);

      expect(() => store.create({
        name: 'memory-playbook',
        category: 'another',
        content: 'duplicate',
      }, AGENT)).toThrow(/already exists/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires non-empty write provenance on every mutation', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-store-prov-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const store = new SkillStore(dataDir, { repoRoot: root });

    try {
      expect(() => store.create({
        name: 'no-provenance',
        category: 'ops',
        content: 'body text',
      }, { updatedBy: '   ' })).toThrow(/provenance/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('journals create/update history with provenance and restores byte-exact content on rollback', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-store-history-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });

    let now = new Date('2026-02-26T10:00:00.000Z');
    const store = new SkillStore(dataDir, {
      repoRoot: root,
      now: () => now,
    });

    try {
      const originalContent = '# Deploy Checklist\n\n- Run tests\n- Build release';
      store.create({
        name: 'deploy-checklist',
        category: 'ops',
        description: 'Repeatable deploy verification flow.',
        content: originalContent,
      }, { updatedBy: 'agent', reason: 'initial authoring' });

      now = new Date('2026-02-26T10:30:00.000Z');
      store.update({
        name: 'deploy-checklist',
        content: '# Deploy Checklist\n\n- Something else entirely',
      }, { updatedBy: 'agent', reason: 'rewrite' });

      const historyPath = join(
        dataDir, 'skills', 'ops', 'deploy-checklist', 'SKILL.history.jsonl',
      );
      expect(existsSync(historyPath)).toBe(true);

      const history = store.getHistory('deploy-checklist');
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({
        action: 'create',
        version: 1,
        updatedBy: 'agent',
        reason: 'initial authoring',
        previousVersion: null,
        previousChecksum: null,
        previousDocument: null,
      });
      expect(history[1]).toMatchObject({
        action: 'update',
        version: 2,
        updatedBy: 'agent',
        reason: 'rewrite',
        previousVersion: 1,
      });
      expect(history[1]?.previousDocument).toBe(history[0]?.newDocument);
      expect(history[1]?.previousChecksum).toBe(history[0]?.newChecksum);

      now = new Date('2026-02-26T11:00:00.000Z');
      const restored = store.rollback('deploy-checklist', 1, { updatedBy: 'agent:rollback' });
      expect(restored.version).toBe(3);
      // Byte-exact body restore of version 1.
      expect(restored.content).toBe(originalContent);
      expect(restored.description).toBe('Repeatable deploy verification flow.');

      // Rollback is itself journaled (append-only, reversible).
      const afterRollback = store.getHistory('deploy-checklist');
      expect(afterRollback).toHaveLength(3);
      expect(afterRollback[2]).toMatchObject({
        action: 'rollback',
        version: 3,
        updatedBy: 'agent:rollback',
        reason: 'Rollback to version 1',
        previousVersion: 2,
      });

      expect(() => store.rollback('deploy-checklist', 99, { updatedBy: 'agent:rollback' }))
        .toThrow(/no history entry/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a stale expectedVersion and leaves the document untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-store-cas-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const store = new SkillStore(dataDir, { repoRoot: root });

    try {
      store.create({
        name: 'contended-skill',
        category: 'ops',
        description: 'A contended skill.',
        content: 'Original body content.',
      }, AGENT);
      store.update({
        name: 'contended-skill',
        content: 'Second author body content.',
      }, AGENT);

      // A writer still holding the v1 snapshot must not overwrite v2.
      expect(() => store.update({
        name: 'contended-skill',
        content: 'First author body content.',
        expectedVersion: 1,
      }, AGENT)).toThrow(SkillVersionConflictError);

      const record = store.getByName('contended-skill');
      expect(record?.version).toBe(2);
      expect(record?.content).toBe('Second author body content.');
      expect(store.getHistory('contended-skill')).toHaveLength(2);

      // The current version still writes.
      const applied = store.update({
        name: 'contended-skill',
        content: 'Third body content.',
        expectedVersion: 2,
      }, AGENT);
      expect(applied.version).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('short-circuits no-op updates without burning a version or history entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-store-noop-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const store = new SkillStore(dataDir, { repoRoot: root });

    try {
      store.create({
        name: 'noop-skill',
        category: 'ops',
        description: 'A stable skill.',
        content: 'Stable body content.',
      }, AGENT);

      const unchanged = store.update({
        name: 'noop-skill',
        content: 'Stable body content.',
      }, AGENT);

      expect(unchanged.version).toBe(1);
      expect(store.getHistory('noop-skill')).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a deleted skill\'s history queryable behind a tombstone (ft69n)', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-store-delete-history-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    let now = new Date('2026-03-01T09:00:00.000Z');
    const store = new SkillStore(dataDir, { repoRoot: root, now: () => now });

    try {
      store.create({
        name: 'self-erasing-skill',
        category: 'ops',
        description: 'A skill that later deletes itself.',
        content: 'Original body content.',
      }, AGENT);
      now = new Date('2026-03-01T09:30:00.000Z');
      store.update({
        name: 'self-erasing-skill',
        content: 'Revised body content.',
      }, AGENT);
      expect(store.getHistory('self-erasing-skill')).toHaveLength(2);

      const skillDir = join(dataDir, 'skills', 'ops', 'self-erasing-skill');
      expect(existsSync(join(skillDir, 'SKILL.history.jsonl'))).toBe(true);

      now = new Date('2026-03-01T10:00:00.000Z');
      store.delete('self-erasing-skill', { updatedBy: 'operator:garden', reason: 'Removed after review' });

      // The skill itself is gone, journal directory and all.
      expect(store.getByName('self-erasing-skill')).toBeNull();
      expect(existsSync(skillDir)).toBe(false);

      // Its audit trail is not: create, update, and a closing tombstone.
      const history = store.getHistory('self-erasing-skill');
      expect(history.map(entry => entry.action)).toEqual(['create', 'update', 'delete']);
      const tombstone = history.at(-1)!;
      expect(tombstone).toMatchObject({
        action: 'delete',
        version: 3,
        previousVersion: 2,
        timestamp: '2026-03-01T10:00:00.000Z',
        updatedBy: 'operator:garden',
        reason: 'Removed after review',
        newChecksum: null,
        newDocument: null,
        deletedCategory: 'ops',
      });
      expect(tombstone.previousDocument).toContain('Revised body content.');

      // Unreadable journal lines survive too: the archive copies bytes.
      const archiveRootPath = store.getHistoryArchiveRootDir();
      expect(readFileSync(join(archiveRootPath, 'self-erasing-skill.jsonl'), 'utf-8'))
        .toContain('Revised body content.');

      // The archive lives outside the managed skills root the delete removes.
      const archiveRoot = store.getHistoryArchiveRootDir();
      expect(archiveRoot.startsWith(store.getManagedRootDir())).toBe(false);
      expect(existsSync(join(archiveRoot, 'self-erasing-skill.jsonl'))).toBe(true);

      // Re-creating the same name continues the chain rather than replacing it.
      now = new Date('2026-03-01T11:00:00.000Z');
      store.create({
        name: 'self-erasing-skill',
        category: 'ops',
        description: 'A second incarnation.',
        content: 'Fresh body content.',
      }, AGENT);
      expect(store.getHistory('self-erasing-skill').map(entry => entry.action))
        .toEqual(['create', 'update', 'delete', 'create']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to delete a skill whose history cannot be archived (fail closed)', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-store-archive-fail-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const store = new SkillStore(dataDir, { repoRoot: root });

    try {
      store.create({
        name: 'protected-skill',
        category: 'ops',
        description: 'A skill whose trail must survive.',
        content: 'Body content.',
      }, AGENT);

      // Block the archive root with a regular file so the append cannot land.
      writeFileSync(store.getHistoryArchiveRootDir(), 'not a directory', 'utf-8');

      expect(() => store.delete('protected-skill', { updatedBy: 'operator:garden' })).toThrow();
      // The skill is still there: no delete without a preserved audit trail.
      expect(store.getByName('protected-skill')?.version).toBe(1);
      expect(existsSync(join(dataDir, 'skills', 'ops', 'protected-skill', 'SKILL.md'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags heuristically destructive content replaces and passes appends', () => {
    const longBody = 'A detailed skill body line that matters.\n'.repeat(12); // ~480 chars
    expect(detectDestructiveSkillContentReplace(longBody, 'Short replacement.')).toMatchObject({
      previousLength: longBody.trim().length,
    });
    expect(detectDestructiveSkillContentReplace(longBody, `${longBody}\nOne appended line.`)).toBeNull();
    expect(detectDestructiveSkillContentReplace('short body', 'other short body')).toBeNull();
  });
});
