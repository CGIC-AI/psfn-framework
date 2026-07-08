import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decryptEncryptedBackupPackage,
  encryptBackupDirectory,
  type BackupEncryptionRuntimeConfig,
} from './encryption.js';

const TEST_ENCRYPTION: BackupEncryptionRuntimeConfig = {
  mode: 'required',
  keyRef: {
    kind: 'env',
    envName: 'PSFN_BACKUP_TEST_KEY',
  },
  passphrase: 'test-backup-secret',
};

const WRONG_KEY_ENCRYPTION: BackupEncryptionRuntimeConfig = {
  ...TEST_ENCRYPTION,
  passphrase: 'not-the-backup-secret',
};

describe('decryptEncryptedBackupPackage cleanup', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  function makeRoot(): string {
    const root = join(tmpdir(), `psfn-backup-encryption-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    roots.push(root);
    return root;
  }

  async function makeEncryptedPackage(root: string): Promise<string> {
    const sourceDir = join(root, 'plaintext-snapshot');
    mkdirSync(join(sourceDir, 'database'), { recursive: true });
    writeFileSync(join(sourceDir, 'database', 'sample.dump'), 'dump-bytes', 'utf-8');
    const encryptedBackupDir = join(root, 'encrypted');
    await encryptBackupDirectory({
      sourceDir,
      outputDir: encryptedBackupDir,
      encryption: TEST_ENCRYPTION,
      now: () => Date.UTC(2026, 5, 28, 12, 0, 0),
    });
    return encryptedBackupDir;
  }

  it('round-trips a package into a fresh output directory', async () => {
    const root = makeRoot();
    const encryptedBackupDir = await makeEncryptedPackage(root);
    const outputDir = join(root, 'restored');

    await decryptEncryptedBackupPackage({
      encryptedBackupDir,
      outputDir,
      encryption: TEST_ENCRYPTION,
    });

    expect(readFileSync(join(outputDir, 'database', 'sample.dump'), 'utf-8')).toBe('dump-bytes');
  });

  it('preserves a pre-existing output directory when decryption fails', async () => {
    const root = makeRoot();
    const encryptedBackupDir = await makeEncryptedPackage(root);
    const outputDir = join(root, 'existing-data');
    mkdirSync(outputDir, { recursive: true });
    const sentinelPath = join(outputDir, 'unrelated.txt');
    writeFileSync(sentinelPath, 'must survive a failed restore\n', 'utf-8');

    await expect(decryptEncryptedBackupPackage({
      encryptedBackupDir,
      outputDir,
      encryption: WRONG_KEY_ENCRYPTION,
    })).rejects.toThrow();

    expect(existsSync(outputDir)).toBe(true);
    expect(readFileSync(sentinelPath, 'utf-8')).toBe('must survive a failed restore\n');
  });

  it('removes an output directory it created when decryption fails', async () => {
    const root = makeRoot();
    const encryptedBackupDir = await makeEncryptedPackage(root);
    const outputDir = join(root, 'created-by-decrypt');

    await expect(decryptEncryptedBackupPackage({
      encryptedBackupDir,
      outputDir,
      encryption: WRONG_KEY_ENCRYPTION,
    })).rejects.toThrow();

    expect(existsSync(outputDir)).toBe(false);
  });
});
