import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeStartupOwnerFileChecks } from '../../system/config/startup-owner-files.js';
import { restoreTreeSnapshotToEmptyDirectory } from './companion-tree.js';
import {
  captureSystemConfigSnapshot,
  SYSTEM_CONFIG_DIR_NAME,
  SYSTEM_CONFIG_MANIFEST_NAME,
  SYSTEM_CONFIG_OWNER_FILES,
  verifySystemConfigSnapshot,
} from './system-config-tree.js';

const COMPANIONS_BYTES = `${JSON.stringify({
  postgres: {
    sharedMigrationRole: 'shared_schema_migration',
    sharedMigrationDatabaseUrlRef: {
      kind: 'env',
      envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL',
    },
  },
  companions: [{
    companionId: '11111111-1111-4111-8111-111111111111',
    companionDataDir: 'companions/alpha',
    characterCardPath: 'companions/alpha/character-card.json',
    postgresSchema: 'companion_alpha',
    postgresRole: 'companion_alpha_runtime',
    postgresDatabaseUrlRef: {
      kind: 'env',
      envName: 'COMPANION_ALPHA_DATABASE_URL',
    },
  }],
}, null, 2)}\n`;

interface MutableSystemConfigManifest {
  fileCount: number;
  totalBytes: number;
  files: Array<{ path: string; sizeBytes: number; sha256: string }>;
}

describe('system config backup topology fidelity', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'psfn-system-config-tree-'));
    roots.push(root);
    return root;
  }

  function writeMandatorySystemOwners(systemDataDir: string, includeCompanions = true): void {
    mkdirSync(systemDataDir, { recursive: true });
    for (const descriptor of describeStartupOwnerFileChecks()) {
      if (descriptor.scope !== 'system' || descriptor.optionalWhenMissing) continue;
      if (descriptor.ownerFileName === 'companions.json') {
        if (includeCompanions) {
          writeFileSync(join(systemDataDir, descriptor.ownerFileName), COMPANIONS_BYTES);
        }
        continue;
      }
      writeFileSync(
        join(systemDataDir, descriptor.ownerFileName),
        readFileSync(join(process.cwd(), 'config', descriptor.seedFileName)),
      );
    }
  }

  function captureFixture(): { root: string; backupDir: string; systemDataDir: string } {
    const root = makeRoot();
    const backupDir = join(root, 'backup');
    const systemDataDir = join(root, 'system-data');
    writeMandatorySystemOwners(systemDataDir);
    captureSystemConfigSnapshot({ systemDataDir, backupDir, now: () => 0 });
    return { root, backupDir, systemDataDir };
  }

  it('covers mandatory cluster-global startup owners without duplicating per-companion owners', () => {
    const descriptors = describeStartupOwnerFileChecks();
    const mandatorySystemOwners = descriptors
      .filter(descriptor => descriptor.scope === 'system' && !descriptor.optionalWhenMissing)
      .map(descriptor => descriptor.ownerFileName);
    const companionOwners = descriptors
      .filter(descriptor => descriptor.scope === 'companion')
      .map(descriptor => descriptor.ownerFileName);

    expect(SYSTEM_CONFIG_OWNER_FILES).toEqual(expect.arrayContaining(mandatorySystemOwners));
    for (const companionOwner of companionOwners) {
      expect(SYSTEM_CONFIG_OWNER_FILES).not.toContain(companionOwner);
    }
  });

  it('captures, verifies, and restores exact companions.json bytes', () => {
    const { root, backupDir } = captureFixture();
    const manifest = JSON.parse(
      readFileSync(join(backupDir, SYSTEM_CONFIG_MANIFEST_NAME), 'utf8'),
    ) as MutableSystemConfigManifest;
    const entry = manifest.files.find(file => file.path === 'companions.json');

    expect(entry).toEqual({
      path: 'companions.json',
      sizeBytes: Buffer.byteLength(COMPANIONS_BYTES),
      sha256: createHash('sha256').update(COMPANIONS_BYTES).digest('hex'),
    });
    expect(verifySystemConfigSnapshot(backupDir).verifiedFileCount).toBe(manifest.fileCount);

    const restoreDir = join(root, 'restored-system-data');
    mkdirSync(restoreDir);
    restoreTreeSnapshotToEmptyDirectory({
      backupDir,
      treeDirName: SYSTEM_CONFIG_DIR_NAME,
      manifestName: SYSTEM_CONFIG_MANIFEST_NAME,
      label: 'System config',
      destinationDir: restoreDir,
    });
    expect(readFileSync(join(restoreDir, 'companions.json'), 'utf8')).toBe(COMPANIONS_BYTES);
  });

  it('fails capture when mandatory companions.json is missing or invalid', () => {
    const missingRoot = makeRoot();
    const missingSystemDataDir = join(missingRoot, 'system-data');
    writeMandatorySystemOwners(missingSystemDataDir, false);
    expect(() => captureSystemConfigSnapshot({
      systemDataDir: missingSystemDataDir,
      backupDir: join(missingRoot, 'backup'),
    })).toThrow(/mandatory system config owner file missing.*companions\.json/i);

    const invalidRoot = makeRoot();
    const invalidSystemDataDir = join(invalidRoot, 'system-data');
    writeMandatorySystemOwners(invalidSystemDataDir);
    writeFileSync(join(invalidSystemDataDir, 'companions.json'), '{}\n');
    expect(() => captureSystemConfigSnapshot({
      systemDataDir: invalidSystemDataDir,
      backupDir: join(invalidRoot, 'backup'),
    })).toThrow(/invalid companions config/i);
  });

  it('fails verification when companions.json is corrupted or hidden from the manifest', () => {
    const corrupted = captureFixture();
    writeFileSync(
      join(corrupted.backupDir, SYSTEM_CONFIG_DIR_NAME, 'companions.json'),
      COMPANIONS_BYTES.replace('companion_alpha', 'companion_bravo'),
    );
    expect(() => verifySystemConfigSnapshot(corrupted.backupDir)).toThrow(/hash mismatch.*companions\.json/i);

    const omitted = captureFixture();
    const manifestPath = join(omitted.backupDir, SYSTEM_CONFIG_MANIFEST_NAME);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MutableSystemConfigManifest;
    const entry = manifest.files.find(file => file.path === 'companions.json');
    expect(entry).toBeDefined();
    manifest.files = manifest.files.filter(file => file.path !== 'companions.json');
    manifest.fileCount -= 1;
    manifest.totalBytes -= entry!.sizeBytes;
    unlinkSync(join(omitted.backupDir, SYSTEM_CONFIG_DIR_NAME, 'companions.json'));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => verifySystemConfigSnapshot(omitted.backupDir))
      .toThrow(/mandatory system config owner missing from manifest.*companions\.json/i);
  });

  it('fails verification when companions.json manifest size coverage is corrupted', () => {
    const { backupDir } = captureFixture();
    const manifestPath = join(backupDir, SYSTEM_CONFIG_MANIFEST_NAME);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MutableSystemConfigManifest;
    const entry = manifest.files.find(file => file.path === 'companions.json');
    expect(entry).toBeDefined();
    entry!.sizeBytes += 1;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => verifySystemConfigSnapshot(backupDir))
      .toThrow(/size mismatch.*companions\.json/i);
  });
});
