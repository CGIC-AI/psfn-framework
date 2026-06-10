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
  captureCompanionTree,
  verifyCompanionTreeSnapshot,
  type CompanionTreeManifest,
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
});
