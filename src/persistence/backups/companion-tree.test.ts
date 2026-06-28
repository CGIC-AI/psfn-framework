import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPANION_TREE_MANIFEST_NAME,
  WORKSPACE_TREE_MANIFEST_NAME,
  captureCompanionTree,
  captureWorkspaceTree,
  verifyCompanionTreeSnapshot,
  verifyWorkspaceTreeSnapshot,
  type CompanionTreeManifest,
  type WorkspaceTreeManifest,
} from './companion-tree.js';

describe('companion tree capture', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  function makeRoot(prefix: string): string {
    const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    roots.push(root);
    return root;
  }

  function seedCompanionData(root: string): string {
    const companionDataDir = join(root, 'companion-data');
    mkdirSync(join(companionDataDir, 'state', 'notes', 'reflections'), { recursive: true });
    mkdirSync(join(companionDataDir, 'state', 'sessions'), { recursive: true });
    mkdirSync(join(companionDataDir, 'state', 'repair-backups'), { recursive: true });
    mkdirSync(join(companionDataDir, 'images', '2026-06-01'), { recursive: true });
    mkdirSync(join(companionDataDir, 'vault'), { recursive: true });
    mkdirSync(join(companionDataDir, 'backups'), { recursive: true });
    writeFileSync(join(companionDataDir, 'companion.json'), '{"name":"Companion"}\n', 'utf-8');
    writeFileSync(join(companionDataDir, 'state', 'character-card-history.jsonl'), '{"v":1}\n', 'utf-8');
    writeFileSync(join(companionDataDir, 'state', 'notes', 'memories.jsonl'), '{"id":"m1"}\n', 'utf-8');
    writeFileSync(join(companionDataDir, 'state', 'notes', 'reflections', 'r1.md'), 'reflection\n', 'utf-8');
    writeFileSync(join(companionDataDir, 'state', 'sessions', 'chan.jsonl'), '{"id":1}\n', 'utf-8');
    writeFileSync(join(companionDataDir, 'state', 'repair-backups', 'old.db'), 'repair', 'utf-8');
    writeFileSync(join(companionDataDir, 'images', '2026-06-01', 'selfie.png'), 'png-bytes', 'utf-8');
    writeFileSync(join(companionDataDir, 'vault', 'note.md'), 'vault note\n', 'utf-8');
    writeFileSync(join(companionDataDir, 'backups', 'stale.txt'), 'stale', 'utf-8');
    return companionDataDir;
  }

  it('captures the full tree with hashes, excluding sessions and backup targets', () => {
    const root = makeRoot('psfn-companion-tree');
    const companionDataDir = seedCompanionData(root);
    const backupDir = join(root, 'backup-snapshot');
    mkdirSync(backupDir, { recursive: true });

    const result = captureCompanionTree({
      companionDataDir,
      backupDir,
      excludePaths: [
        join(companionDataDir, 'state', 'sessions'),
        'backups',
        'state/repair-backups',
      ],
      now: () => Date.UTC(2026, 5, 10, 1, 2, 3),
    });

    expect(existsSync(join(result.treeDir, 'companion.json'))).toBe(true);
    expect(existsSync(join(result.treeDir, 'images', '2026-06-01', 'selfie.png'))).toBe(true);
    expect(existsSync(join(result.treeDir, 'vault', 'note.md'))).toBe(true);
    expect(existsSync(join(result.treeDir, 'state', 'notes', 'reflections', 'r1.md'))).toBe(true);
    expect(existsSync(join(result.treeDir, 'state', 'sessions'))).toBe(false);
    expect(existsSync(join(result.treeDir, 'backups'))).toBe(false);
    expect(existsSync(join(result.treeDir, 'state', 'repair-backups'))).toBe(false);

    const manifest = JSON.parse(
      readFileSync(join(backupDir, COMPANION_TREE_MANIFEST_NAME), 'utf-8'),
    ) as CompanionTreeManifest;
    expect(manifest.fileCount).toBe(6);
    expect(manifest.files.every(entry => /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(true);
    expect(manifest.excludedPaths).toContain('state/sessions');
    expect(manifest.excludedPaths).toContain('backups');
  });

  it('skips non-regular files and records them in the manifest', () => {
    const root = makeRoot('psfn-companion-tree-special');
    const companionDataDir = seedCompanionData(root);
    symlinkSync('/etc/hostname', join(companionDataDir, 'vault', 'escape-link'));
    const backupDir = join(root, 'backup-snapshot');
    mkdirSync(backupDir, { recursive: true });

    const result = captureCompanionTree({ companionDataDir, backupDir });

    expect(result.skippedSpecialPaths).toEqual(['vault/escape-link']);
    expect(existsSync(join(result.treeDir, 'vault', 'escape-link'))).toBe(false);
  });

  it('verifies a healthy capture and detects tampering', () => {
    const root = makeRoot('psfn-companion-tree-verify');
    const companionDataDir = seedCompanionData(root);
    const backupDir = join(root, 'backup-snapshot');
    mkdirSync(backupDir, { recursive: true });

    const capture = captureCompanionTree({
      companionDataDir,
      backupDir,
      excludePaths: ['state/sessions', 'backups', 'state/repair-backups'],
    });

    const healthy = verifyCompanionTreeSnapshot(backupDir);
    expect(healthy.verifiedFileCount).toBe(capture.fileCount);

    writeFileSync(join(capture.treeDir, 'vault', 'note.md'), 'tampered\n', 'utf-8');
    expect(() => verifyCompanionTreeSnapshot(backupDir))
      .toThrow('hash mismatch for vault/note.md');
  });

  it('fails when unmanifested files appear in the capture', () => {
    const root = makeRoot('psfn-companion-tree-unmanifested');
    const companionDataDir = seedCompanionData(root);
    const backupDir = join(root, 'backup-snapshot');
    mkdirSync(backupDir, { recursive: true });

    const capture = captureCompanionTree({ companionDataDir, backupDir });
    writeFileSync(join(capture.treeDir, 'sneaky.txt'), 'not in manifest', 'utf-8');

    expect(() => verifyCompanionTreeSnapshot(backupDir))
      .toThrow('Unmanifested file present in companion tree capture: sneaky.txt');
  });

  it('fails closed when the companion data directory is missing', () => {
    const root = makeRoot('psfn-companion-tree-missing');
    mkdirSync(root, { recursive: true });

    expect(() => captureCompanionTree({
      companionDataDir: join(root, 'nope'),
      backupDir: join(root, 'backup-snapshot'),
    })).toThrow('Companion data directory missing');
  });

  it('captures workspace wiki and personal files while excluding dependency, VCS, cache, and temp directories', () => {
    const root = makeRoot('psfn-workspace-tree');
    const workspacePath = join(root, 'workspace');
    const backupDir = join(root, 'backup-snapshot');
    mkdirSync(join(workspacePath, 'knowledge', 'wiki', 'documents'), { recursive: true });
    mkdirSync(join(workspacePath, 'docs'), { recursive: true });
    mkdirSync(join(workspacePath, 'downloads'), { recursive: true });
    mkdirSync(join(workspacePath, 'images'), { recursive: true });
    mkdirSync(join(workspacePath, 'journal'), { recursive: true });
    mkdirSync(join(workspacePath, 'scratchpad'), { recursive: true });
    mkdirSync(join(workspacePath, 'skills'), { recursive: true });
    mkdirSync(join(workspacePath, 'modules'), { recursive: true });
    mkdirSync(join(workspacePath, 'experiments'), { recursive: true });
    mkdirSync(join(workspacePath, '.git'), { recursive: true });
    mkdirSync(join(workspacePath, 'project', 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(workspacePath, '.cache'), { recursive: true });
    mkdirSync(join(workspacePath, 'tmp'), { recursive: true });
    mkdirSync(join(workspacePath, '.psfn', 'temp-artifacts'), { recursive: true });
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(workspacePath, 'knowledge', 'wiki', 'documents', 'internal.md'), 'wiki\n', 'utf-8');
    writeFileSync(join(workspacePath, 'docs', 'note.md'), 'doc\n', 'utf-8');
    writeFileSync(join(workspacePath, 'downloads', 'source.pdf'), 'pdf\n', 'utf-8');
    writeFileSync(join(workspacePath, 'images', 'saved.png'), 'png\n', 'utf-8');
    writeFileSync(join(workspacePath, 'journal', 'entry.md'), 'journal\n', 'utf-8');
    writeFileSync(join(workspacePath, 'scratchpad', 'scratch.md'), 'scratch\n', 'utf-8');
    writeFileSync(join(workspacePath, 'skills', 'personal.md'), 'skill\n', 'utf-8');
    writeFileSync(join(workspacePath, 'modules', 'module.ts'), 'module\n', 'utf-8');
    writeFileSync(join(workspacePath, 'experiments', 'exp.md'), 'experiment\n', 'utf-8');
    writeFileSync(join(workspacePath, '.git', 'config'), 'git\n', 'utf-8');
    writeFileSync(join(workspacePath, 'project', 'node_modules', 'pkg', 'index.js'), 'dependency\n', 'utf-8');
    writeFileSync(join(workspacePath, '.cache', 'cached'), 'cache\n', 'utf-8');
    writeFileSync(join(workspacePath, 'tmp', 'temp.txt'), 'temp\n', 'utf-8');
    writeFileSync(join(workspacePath, '.psfn', 'temp-artifacts', 'generated.tmp'), 'temp\n', 'utf-8');

    const result = captureWorkspaceTree({
      workspacePath,
      backupDir,
      now: () => Date.UTC(2026, 5, 28, 1, 2, 3),
    });

    expect(existsSync(join(result.treeDir, 'knowledge', 'wiki', 'documents', 'internal.md'))).toBe(true);
    expect(existsSync(join(result.treeDir, 'docs', 'note.md'))).toBe(true);
    expect(existsSync(join(result.treeDir, '.git'))).toBe(false);
    expect(existsSync(join(result.treeDir, 'project', 'node_modules'))).toBe(false);
    expect(existsSync(join(result.treeDir, '.cache'))).toBe(false);
    expect(existsSync(join(result.treeDir, 'tmp'))).toBe(false);
    expect(existsSync(join(result.treeDir, '.psfn', 'temp-artifacts'))).toBe(false);

    const manifest = JSON.parse(
      readFileSync(join(backupDir, WORKSPACE_TREE_MANIFEST_NAME), 'utf-8'),
    ) as WorkspaceTreeManifest;
    expect(manifest.files.map(entry => entry.path)).toEqual([
      'docs/note.md',
      'downloads/source.pdf',
      'experiments/exp.md',
      'images/saved.png',
      'journal/entry.md',
      'knowledge/wiki/documents/internal.md',
      'modules/module.ts',
      'scratchpad/scratch.md',
      'skills/personal.md',
    ]);
    expect(manifest.excludedPaths).toEqual([
      '.cache',
      '.git',
      '.psfn/temp-artifacts',
      'project/node_modules',
      'tmp',
    ]);
    expect(verifyWorkspaceTreeSnapshot(backupDir).verifiedFileCount).toBe(9);
  });
});
